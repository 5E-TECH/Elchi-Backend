import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, FindOptionsWhere, In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { lastValueFrom, timeout } from 'rxjs';
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
import { PushDeliveryService } from './push/push-delivery.service';
import {
  SmsChannelResult,
  SmsDispatchService,
} from './sms/sms-dispatch.service';
import { SmsBlockedError } from './sms/sms-gate.service';

/** Upper bound on role/broadcast fan-out, so one dispatch can't insert millions
 * of rows. If a target resolves to more recipients than this we truncate and
 * log it (never silently). */
const MAX_FANOUT = 5000;
const IDENTITY_PAGE_SIZE = 100;
/** Bitta INSERT dagi qatorlar — Postgres 65 535 parametr chegarasidan uzoq. */
const INSERT_CHUNK = 500;
/** Qayta o'qishdagi `IN (...)` hajmi. */
const READ_CHUNK = 1000;

interface ResolvedRecipient {
  id: string;
  role: string | null;
}

/** "Faqat muhim" filtri va sanog'i (n1sNvGLn). */
const IMPORTANT_PRIORITIES = [
  NotificationPriority.CRITICAL,
  NotificationPriority.HIGH,
] as const;
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
    private readonly pushDelivery: PushDeliveryService,
    private readonly smsDispatch: SmsDispatchService,
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
      if (!dto.title?.trim())
        throw new BadRequestException('title is required');

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

      // SMS: fan-out chegarasi OLDINDAN — oshsa XATO, jimgina kesilmaydi
      // (MAX_FANOUT=5000 SMS'ga qo'llanmaydi: SMS_MAX_FANOUT).
      const wantsSms = channels.includes(NotificationChannel.SMS);
      if (wantsSms) {
        try {
          this.smsDispatch.assertFanout(recipients.length);
        } catch (error) {
          if (error instanceof SmsBlockedError) {
            throw new BadRequestException(error.message);
          }
          throw error;
        }
      }
      let smsResult: SmsChannelResult | null = null;

      // 1) Persist one inbox row per recipient (the in_app channel & system of record).
      //    Push is only QUEUED here (outbox) — in the same transaction as the rows,
      //    so a rolled-back dispatch never sends a push. Delivery is async.
      const wantsPush = channels.includes(NotificationChannel.PUSH);
      const rows = await this.repo.manager.transaction(async (manager) => {
        const persisted = await this.persistRows(
          manager,
          dto,
          recipients,
          channels,
        );
        if (wantsPush && persisted.length) {
          await this.pushDelivery.enqueue(
            manager,
            persisted.map((row) => row.id),
          );
        }
        // SMS: navbatga ham shu tranzaksiyada; holat har qatorning delivery.sms ida.
        if (wantsSms && persisted.length) {
          smsResult = await this.smsDispatch.queueForNotifications(
            persisted,
            manager,
          );
        }
        return persisted;
      });

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

      // 4) Email — not wired yet.
      if (channels.includes(NotificationChannel.EMAIL)) {
        this.logger.warn(
          `Channel "email" requested but no provider configured — skipped (${rows.length} recipients).`,
        );
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
          // Kanal kesimidagi holat — quruq 201 emas (3fRbyadQ #7).
          delivery: {
            in_app: rows.length,
            ...(smsResult ?? {}),
          },
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

  /**
   * Bitta dispatch — o'zgarmas sondagi so'rov (qabul qiluvchilar soniga
   * bog'liq emas): group_key bo'yicha bitta qidiruv, rol bo'yicha UPDATE,
   * 500 tadan bulk INSERT va bitta qayta o'qish. Avval har qabul qiluvchi
   * uchun alohida `findOne` + `save` edi (40 ta = 80 so'rov).
   */
  private async persistRows(
    manager: EntityManager,
    dto: DispatchNotificationDto,
    recipients: ResolvedRecipient[],
    channels: NotificationChannel[],
  ): Promise<Notification[]> {
    const repo = manager.getRepository(Notification);
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
      // Push so'ralgan bo'lsa yetkazish holati darhol "navbatda" ko'rinadi.
      ...(channels.includes(NotificationChannel.PUSH)
        ? { delivery: { push: 'queued' } }
        : {}),
    };

    const rowIdByRecipient = new Map<string, string>();
    let toInsert = recipients;

    // Dedupe by group_key: refresh the existing row instead of stacking dupes.
    if (dto.group_key) {
      const existing = await repo.find({
        where: {
          recipient_id: In(recipients.map((r) => r.id)),
          group_key: dto.group_key,
          isDeleted: false,
        },
      });
      for (const row of existing) {
        const key = String(row.recipient_id);
        if (!rowIdByRecipient.has(key)) rowIdByRecipient.set(key, row.id);
      }

      const idsByRole = new Map<string | null, string[]>();
      for (const recipient of recipients) {
        const rowId = rowIdByRecipient.get(recipient.id);
        if (!rowId) continue;
        idsByRole.set(recipient.role, [
          ...(idsByRole.get(recipient.role) ?? []),
          rowId,
        ]);
      }
      for (const [role, ids] of idsByRole) {
        // jsonb ustunlari (`data`, `delivery`) TypeORM deep-partial turiga sig'maydi.
        await repo.update({ id: In(ids) }, {
          ...base,
          recipient_role: role,
          is_read: false,
          read_at: null,
        } as QueryDeepPartialEntity<Notification>);
      }
      toInsert = recipients.filter((r) => !rowIdByRecipient.has(r.id));
    }

    for (let start = 0; start < toInsert.length; start += INSERT_CHUNK) {
      const batch = toInsert.slice(start, start + INSERT_CHUNK);
      const result = await repo.insert(
        batch.map((recipient) =>
          repo.create({
            ...base,
            recipient_id: recipient.id,
            recipient_role: recipient.role,
            is_read: false,
            read_at: null,
          }),
        ) as QueryDeepPartialEntity<Notification>[],
      );
      result.identifiers.forEach((identifier, index) => {
        rowIdByRecipient.set(batch[index].id, String(identifier.id));
      });
    }

    const ids = recipients
      .map((r) => rowIdByRecipient.get(r.id))
      .filter((id): id is string => Boolean(id));
    const rows: Notification[] = [];
    for (let start = 0; start < ids.length; start += READ_CHUNK) {
      rows.push(
        ...(await repo.find({
          where: { id: In(ids.slice(start, start + READ_CHUNK)) },
        })),
      );
    }
    const order = new Map(ids.map((id, index) => [id, index]));
    return rows.sort(
      (a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0),
    );
  }

  private async pushRealtime(rows: Notification[]) {
    for (const row of rows) {
      try {
        await lastValueFrom(
          this.gatewayClient
            .emit(
              { cmd: 'realtime.notify' },
              {
                event: 'notification:new',
                user_id: row.recipient_id,
                payload: this.toPublic(row),
              },
            )
            // Best-effort realtime push, fanned out per recipient (up to
            // MAX_FANOUT). Bound each emit so a slow/unresponsive broker can't
            // stall the whole dispatch loop — on timeout we just warn and move on.
            .pipe(timeout(2_000)),
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
      const limit =
        Number(dto.limit) > 0 ? Math.min(Number(dto.limit), 100) : 20;

      const where: FindOptionsWhere<Notification> = {
        recipient_id: dto.recipient_id,
        isDeleted: false,
      };
      if (dto.is_read !== undefined) where.is_read = dto.is_read;
      if (dto.type) where.type = dto.type;
      if (dto.category) where.category = dto.category;
      if (dto.important) where.priority = In([...IMPORTANT_PRIORITIES]);
      else if (dto.priority) where.priority = dto.priority;

      const [items, total] = await this.repo.findAndCount({
        where,
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });

      const unread = await this.repo.count({
        where: {
          recipient_id: dto.recipient_id,
          isDeleted: false,
          is_read: false,
        },
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

  /**
   * INBOX SANOQLARI (n1sNvGLn) — kategoriya chiplari uchun. BITTA
   * `GROUP BY` so'rov: har kategoriyada jami va o'qilmaganlar, hamda muhim
   * (critical/high) o'qilmaganlar. Sanoq hech qachon joriy sahifadagi 20
   * qatordan hisoblanmaydi — chip butun inbox bo'yicha raqam ko'rsatadi.
   */
  async counts(recipientId: string) {
    try {
      this.assertId(recipientId, 'recipient_id');
      const rows = await this.repo
        .createQueryBuilder('n')
        .select('n.category', 'category')
        .addSelect('COUNT(*)', 'total')
        .addSelect('COUNT(*) FILTER (WHERE n.is_read = false)', 'unread')
        .addSelect(
          'COUNT(*) FILTER (WHERE n.is_read = false AND n.priority IN (:...important))',
          'important_unread',
        )
        .where('n.recipient_id = :rid', { rid: recipientId })
        .andWhere('n.isDeleted = false')
        .setParameter('important', [...IMPORTANT_PRIORITIES])
        .groupBy('n.category')
        .getRawMany<{
          category: string;
          total: string;
          unread: string;
          important_unread: string;
        }>();

      const categories: Record<string, { total: number; unread: number }> = {};
      for (const category of Object.values(NotificationCategory)) {
        categories[category] = { total: 0, unread: 0 };
      }
      let unread = 0;
      let importantUnread = 0;
      for (const row of rows) {
        categories[row.category] = {
          total: Number(row.total ?? 0),
          unread: Number(row.unread ?? 0),
        };
        unread += Number(row.unread ?? 0);
        importantUnread += Number(row.important_unread ?? 0);
      }

      return successRes(
        { categories, unread, important_unread: importantUnread },
        200,
        'Inbox counts',
      );
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
      return successRes(
        this.toPublic(saved),
        200,
        read ? 'Marked read' : 'Marked unread',
      );
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
      return successRes(
        { updated: result.affected ?? 0 },
        200,
        'All marked read',
      );
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
      throw new BadRequestException(
        `${field} must be a bigint-like numeric string`,
      );
    }
  }

  private async requireOwned(
    recipientId: string,
    id: string,
  ): Promise<Notification> {
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
