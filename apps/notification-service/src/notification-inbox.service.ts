import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { lastValueFrom } from 'rxjs';
import {
  ActivityLogService,
  NotificationCategory,
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationPriority,
  rmqSend,
} from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';
import { Notification } from './entities/notification.entity';
import { DispatchNotificationDto } from './dto/dispatch-notification.dto';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { NotificationServiceService } from './notification-service.service';

/** Upper bound on role/broadcast fan-out, so one dispatch can't insert millions
 * of rows. If a target resolves to more recipients than this we truncate and
 * log it (never silently). */
const MAX_FANOUT = 5000;
const IDENTITY_PAGE_SIZE = 100;

interface ResolvedRecipient {
  id: string;
  role: string | null;
}

@Injectable()
export class NotificationInboxService {
  private readonly logger = new Logger(NotificationInboxService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('GATEWAY') private readonly gatewayClient: ClientProxy,
    private readonly telegramService: NotificationServiceService,
    private readonly activityLog: ActivityLogService,
  ) {}

  private toRpcError(error: unknown): never {
    if (error instanceof RpcException) throw error;
    if (error instanceof NotFoundException) {
      throw new RpcException({ statusCode: 404, message: error.message });
    }
    if (error instanceof BadRequestException) {
      throw new RpcException({ statusCode: 400, message: error.message });
    }
    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }

  // ==================== DISPATCH (the generic entry point) ====================

  async dispatch(dto: DispatchNotificationDto) {
    try {
      if (!dto.type?.trim()) throw new BadRequestException('type is required');
      if (!dto.title?.trim()) throw new BadRequestException('title is required');

      const channels =
        dto.channels && dto.channels.length
          ? dto.channels
          : [NotificationChannel.IN_APP, NotificationChannel.REALTIME];

      const recipients = await this.resolveRecipients(dto);
      if (!recipients.length) {
        throw new BadRequestException(
          'No recipients resolved. Provide recipient_id, recipient_ids, roles, or broadcast=true.',
        );
      }

      // 1) Persist one inbox row per recipient (the in_app channel & system of record).
      const rows = await this.persistRows(dto, recipients, channels);

      // 2) Realtime push (best-effort) — one event per recipient's socket room.
      if (channels.includes(NotificationChannel.REALTIME)) {
        await this.pushRealtime(rows);
      }

      // 3) Telegram relay (optional, best-effort).
      let telegram: unknown = null;
      if (
        channels.includes(NotificationChannel.TELEGRAM) &&
        (dto.telegram?.market_id || dto.telegram?.group_id)
      ) {
        telegram = await this.relayTelegram(dto);
      }

      // 4) Email / SMS — not wired yet; recorded as skipped so it's visible.
      for (const ch of [NotificationChannel.EMAIL, NotificationChannel.SMS]) {
        if (channels.includes(ch)) {
          this.logger.warn(
            `Channel "${ch}" requested but no provider configured — skipped (${rows.length} recipients).`,
          );
        }
      }

      // Audit: ONE row per dispatch operation (never one per recipient).
      const actor = (dto as { requester?: { id?: string; roles?: string[] } })
        .requester;
      await this.activityLog.log({
        entity_type: 'Notification',
        entity_id: 'dispatch',
        action: 'notification.dispatched',
        user_id: actor?.id ? String(actor.id) : null,
        user_role: actor?.roles?.length ? actor.roles.join(',') : null,
        metadata: {
          type: dto.type.trim(),
          category: dto.category ?? NotificationCategory.SYSTEM,
          dispatched_count: rows.length,
          channels,
        },
      });

      return successRes(
        {
          dispatched: rows.length,
          recipient_ids: rows.map((r) => r.recipient_id),
          channels,
          telegram,
        },
        201,
        'Notification dispatched',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  private async resolveRecipients(
    dto: DispatchNotificationDto,
  ): Promise<ResolvedRecipient[]> {
    const map = new Map<string, ResolvedRecipient>();

    if (dto.recipient_id) {
      map.set(dto.recipient_id, { id: dto.recipient_id, role: null });
    }

    for (const id of dto.recipient_ids ?? []) {
      const clean = String(id ?? '').trim();
      if (clean) map.set(clean, { id: clean, role: null });
    }

    if (dto.broadcast) {
      await this.collectFromIdentity(undefined, map);
    } else if (dto.roles?.length) {
      for (const role of dto.roles) {
        if (map.size >= MAX_FANOUT) break;
        await this.collectFromIdentity(String(role).trim().toLowerCase(), map);
      }
    }

    if (map.size > MAX_FANOUT) {
      this.logger.warn(
        `Recipient fan-out ${map.size} exceeds cap ${MAX_FANOUT} — truncating.`,
      );
      return Array.from(map.values()).slice(0, MAX_FANOUT);
    }
    return Array.from(map.values());
  }

  /**
   * Page through identity users (optionally filtered by role) into `map`.
   * NOTE: `identity.user.find_all` excludes superadmin and customer roles, so
   * those are not reachable by role/broadcast — target them by explicit
   * recipient_id instead.
   */
  private async collectFromIdentity(
    role: string | undefined,
    map: Map<string, ResolvedRecipient>,
  ) {
    let page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (map.size >= MAX_FANOUT) return;
      const res = await rmqSend<any>(
        this.identityClient,
        { cmd: 'identity.user.find_all' },
        { query: { role, page, limit: IDENTITY_PAGE_SIZE } },
      ).catch((err) => {
        this.logger.warn(
          `identity.user.find_all failed (role=${role ?? 'all'}, page=${page}): ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        );
        return null;
      });

      const data = res?.data ?? res ?? {};
      const items: Array<{ id: string | number; role?: string }> =
        data.items ?? data.data ?? (Array.isArray(data) ? data : []);

      if (!items.length) return;

      for (const u of items) {
        const id = String(u?.id ?? '').trim();
        if (id) {
          map.set(id, { id, role: u?.role ?? role ?? null });
          if (map.size >= MAX_FANOUT) return;
        }
      }

      const total: number | undefined = data?.meta?.total;
      if (total !== undefined && page * IDENTITY_PAGE_SIZE >= total) return;
      if (items.length < IDENTITY_PAGE_SIZE) return;
      page += 1;
    }
  }

  private async persistRows(
    dto: DispatchNotificationDto,
    recipients: ResolvedRecipient[],
    channels: NotificationChannel[],
  ): Promise<Notification[]> {
    const base = {
      type: dto.type.trim(),
      category: dto.category ?? NotificationCategory.SYSTEM,
      priority: dto.priority ?? NotificationPriority.NORMAL,
      title: dto.title.trim(),
      body: dto.body ?? null,
      data: dto.data ?? null,
      link: dto.link ?? null,
      channels,
      group_key: dto.group_key ?? null,
    };

    const saved: Notification[] = [];
    for (const recipient of recipients) {
      // Dedupe by group_key: refresh the existing row instead of stacking dupes.
      if (dto.group_key) {
        const existing = await this.repo.findOne({
          where: {
            recipient_id: recipient.id,
            group_key: dto.group_key,
            isDeleted: false,
          },
        });
        if (existing) {
          Object.assign(existing, base, {
            recipient_role: recipient.role,
            is_read: false,
            read_at: null,
          });
          saved.push(await this.repo.save(existing));
          continue;
        }
      }

      const entity = this.repo.create({
        ...base,
        recipient_id: recipient.id,
        recipient_role: recipient.role,
        is_read: false,
        read_at: null,
      });
      saved.push(await this.repo.save(entity));
    }
    return saved;
  }

  private async pushRealtime(rows: Notification[]) {
    for (const row of rows) {
      try {
        await lastValueFrom(
          this.gatewayClient.emit(
            { cmd: 'realtime.notify' },
            {
              event: 'notification:new',
              user_id: row.recipient_id,
              payload: this.toPublic(row),
            },
          ),
          { defaultValue: null },
        );
      } catch (err) {
        this.logger.warn(
          `realtime push failed for recipient=${row.recipient_id}: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        );
      }
    }
  }

  private async relayTelegram(dto: DispatchNotificationDto) {
    try {
      const message = dto.body ? `${dto.title}\n\n${dto.body}` : dto.title;
      return await this.telegramService.sendNotification({
        market_id: dto.telegram?.market_id,
        group_id: dto.telegram?.group_id,
        group_type: dto.telegram?.group_type,
        token: dto.telegram?.token,
        message: message.slice(0, 4096),
        parse_mode: 'HTML',
      } as any);
    } catch (err) {
      this.logger.warn(
        `telegram relay failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      return { ok: false, status: NotificationDeliveryStatus.FAILED };
    }
  }

  // ==================== INBOX READS (per recipient) ====================

  async list(dto: ListNotificationsDto) {
    try {
      this.assertId(dto.recipient_id, 'recipient_id');
      const page = Number(dto.page) > 0 ? Number(dto.page) : 1;
      const limit = Number(dto.limit) > 0 ? Math.min(Number(dto.limit), 100) : 20;

      const where: FindOptionsWhere<Notification> = {
        recipient_id: dto.recipient_id,
        isDeleted: false,
      };
      if (dto.is_read !== undefined) where.is_read = dto.is_read;
      if (dto.type) where.type = dto.type;
      if (dto.category) where.category = dto.category;
      if (dto.priority) where.priority = dto.priority;

      const [items, total] = await this.repo.findAndCount({
        where,
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });

      const unread = await this.repo.count({
        where: { recipient_id: dto.recipient_id, isDeleted: false, is_read: false },
      });

      return successRes(
        {
          items: items.map((row) => this.toPublic(row)),
          unread,
          meta: {
            page,
            limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
          },
        },
        200,
        'Notifications',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findOne(recipientId: string, id: string) {
    try {
      this.assertId(recipientId, 'recipient_id');
      this.assertId(id, 'id');
      const row = await this.requireOwned(recipientId, id);
      return successRes(this.toPublic(row), 200, 'Notification');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async unreadCount(recipientId: string) {
    try {
      this.assertId(recipientId, 'recipient_id');
      const unread = await this.repo.count({
        where: { recipient_id: recipientId, isDeleted: false, is_read: false },
      });
      return successRes({ unread }, 200, 'Unread count');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async markRead(recipientId: string, id: string, read = true) {
    try {
      this.assertId(recipientId, 'recipient_id');
      this.assertId(id, 'id');
      const row = await this.requireOwned(recipientId, id);
      row.is_read = read;
      row.read_at = read ? new Date() : null;
      const saved = await this.repo.save(row);
      return successRes(this.toPublic(saved), 200, read ? 'Marked read' : 'Marked unread');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async markAllRead(recipientId: string) {
    try {
      this.assertId(recipientId, 'recipient_id');
      const result = await this.repo.update(
        { recipient_id: recipientId, isDeleted: false, is_read: false },
        { is_read: true, read_at: new Date() },
      );
      return successRes({ updated: result.affected ?? 0 }, 200, 'All marked read');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async remove(recipientId: string, id: string) {
    try {
      this.assertId(recipientId, 'recipient_id');
      this.assertId(id, 'id');
      const row = await this.requireOwned(recipientId, id);
      row.isDeleted = true;
      await this.repo.save(row);
      return successRes({ id }, 200, 'Notification deleted');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  // ==================== helpers ====================

  private assertId(value: string | undefined, field: string) {
    if (!value || !/^\d+$/.test(String(value))) {
      throw new BadRequestException(`${field} must be a bigint-like numeric string`);
    }
  }

  private async requireOwned(recipientId: string, id: string): Promise<Notification> {
    const row = await this.repo.findOne({
      where: { id, recipient_id: recipientId, isDeleted: false },
    });
    if (!row) throw new NotFoundException('Notification not found');
    return row;
  }

  private toPublic(row: Notification) {
    return {
      id: row.id,
      recipient_id: row.recipient_id,
      recipient_role: row.recipient_role,
      type: row.type,
      category: row.category,
      priority: row.priority,
      title: row.title,
      body: row.body,
      data: row.data,
      link: row.link,
      is_read: row.is_read,
      read_at: row.read_at,
      created_at: row.createdAt,
    };
  }
}
