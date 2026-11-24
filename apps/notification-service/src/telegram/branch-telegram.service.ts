import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  ActivityLogService,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
} from '@app/common';
import { TelegramChat } from '../entities/telegram-chat.entity';
import { TelegramMarket } from '../entities/telegram-market.entity';
import {
  BRANCH_REPORT_TARGETS,
  TelegramBranchSetting,
  type BranchReportTarget,
} from '../entities/telegram-branch-setting.entity';
import type { TelegramLinkToken } from '../entities/telegram-link-token.entity';
import { TelegramLinkService } from '../bot/telegram-link.service';
import { NotificationInboxService } from '../notification-inbox.service';

/** Filial guruhining `telegram_chats.scope` qiymati (kassa hisobotlari). */
export const BRANCH_CHAT_SCOPE = 'cashbox';

export const BRANCH_GROUP_PRIVATE_CHAT_MESSAGE =
  "Bu havola guruh uchun. Telegram'da filial guruhini tanlab botni qo'shing.";
export const BRANCH_GROUP_MARKET_CHAT_MESSAGE =
  'Bu guruh market guruhi sifatida ulangan. Filial kassasi uchun alohida guruh oching — market guruhida operator va kuryerlar ham bor.';
export const BRANCH_GROUP_OTHER_BRANCH_MESSAGE =
  'Bu guruh boshqa filial kassasiga ulangan. Har filial uchun alohida guruh oching.';

const GROUP_CHAT_ID_RE = /^-\d{1,20}$/;
const ID_RE = /^\d{1,19}$/;

const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const clean = (value: unknown, max: number): string | null => {
  const text = str(value).replace(/\s+/g, ' ').trim().slice(0, max);
  return text || null;
};

function rowsOf<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  return (Array.isArray(result[0]) ? result[0] : result) as T[];
}

export interface BranchTelegramRequester {
  id?: unknown;
  roles?: unknown;
}

export interface BranchTelegramGroupView {
  chat_id: string;
  title: string | null;
  is_active: boolean;
  inactive_reason: string | null;
  inactive_at: Date | null;
  linked_at: Date;
  linked_by: string | null;
}

export interface BranchTelegramStatus {
  branch_id: string;
  report_target: BranchReportTarget;
  group: BranchTelegramGroupView | null;
}

type InactiveReason = 'kicked' | 'left' | 'blocked_on_send' | 'chat_not_found';

/**
 * Filial (kassa) Telegram guruhi: smena (kassa) yopilganda hisobot shu
 * guruhga — yoki filial `report_target = 'private'` bo'lsa menejerlarning
 * SHAXSIY chatiga — boradi (marshrutni finance-service `route` orqali
 * so'raydi).
 *
 * Ulash — market guruhidagi kabi BIR MARTALIK kod (`branch_group`,
 * `t.me/<bot>?startgroup=<kod>`, 10 daqiqa). Filialga kirish huquqini
 * gateway tekshiradi (menejer — faqat o'z filiali); bu yerga faqat
 * `notification.telegram.branch_*` RMQ buyruqlari keladi.
 *
 * Ma'lumot: `telegram_chats` (owner_type='branch', scope='cashbox') —
 * filialga BITTA qator (`UQ_TELEGRAM_CHATS_BRANCH`); qayta ulash `chat_id`
 * ni almashtiradi. Market guruhi filial guruhi bo'la olmaydi (u yerda
 * operator / kuryerlar bor, kassa summalari ko'rinmasin).
 */
@Injectable()
export class BranchTelegramService {
  private readonly logger = new Logger(BranchTelegramService.name);

  constructor(
    @InjectRepository(TelegramChat)
    private readonly chats: Repository<TelegramChat>,
    @InjectRepository(TelegramBranchSetting)
    private readonly settings: Repository<TelegramBranchSetting>,
    @InjectRepository(TelegramMarket)
    private readonly markets: Repository<TelegramMarket>,
    private readonly links: TelegramLinkService,
    private readonly activityLog: ActivityLogService,
    private readonly config: ConfigService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  // ───────────────────────── ulash kodi ─────────────────────────

  async issueLinkCode(input: {
    branch_id?: unknown;
    branch_name?: unknown;
    requester?: BranchTelegramRequester;
    ip?: unknown;
  }) {
    const userId = this.requesterId(input?.requester);
    this.assertStaff(input?.requester);
    const branchId = this.branchId(input?.branch_id);
    if (!this.botToken) {
      throw new RpcException({
        statusCode: 503,
        message: 'Telegram bot sozlanmagan (TELEGRAM_BOT_TOKEN)',
      });
    }
    const { token, expires_at } = await this.links.issue({
      purpose: 'branch_group',
      owner_type: 'branch',
      owner_id: branchId,
      owner_label: clean(input?.branch_name, 120),
      created_by: userId,
      created_ip: clean(input?.ip, 64),
    });
    const username = this.botUsername;
    return {
      statusCode: 200,
      message: 'Telegram link',
      data: {
        token,
        purpose: 'branch_group',
        branch_id: branchId,
        expires_at,
        deep_link: username
          ? `https://t.me/${username}?startgroup=${token}`
          : null,
        command: `/start ${token}`,
      },
    };
  }

  // ───────────────────────── guruhni bog'lash ─────────────────────────

  /**
   * Bot (guruhda `/start <kod>`) yoki `connect-by-token`: kod ALLAQACHON
   * atomik band qilingan (`claim`). Xato — `BadRequestException` (matni
   * guruhga yuboriladi; HTTP yo'lida 400).
   */
  async bindGroup(
    token: Pick<TelegramLinkToken, 'owner_id' | 'owner_label' | 'created_by'>,
    chatId: string,
    title?: string | null,
  ) {
    const branchId = str(token.owner_id).trim();
    if (!ID_RE.test(branchId) || /^0+$/.test(branchId)) {
      throw new BadRequestException(
        'Kod yaroqsiz — kabinetdan yangi havola oling',
      );
    }
    if (!GROUP_CHAT_ID_RE.test(chatId)) {
      throw new BadRequestException(BRANCH_GROUP_PRIVATE_CHAT_MESSAGE);
    }
    const marketGroup = await this.markets.findOne({
      select: { id: true },
      where: { group_id: chatId, is_active: true, isDeleted: false },
    });
    if (marketGroup) {
      throw new BadRequestException(BRANCH_GROUP_MARKET_CHAT_MESSAGE);
    }

    const otherBranch: unknown = await this.chats.query(
      `SELECT "owner_id" FROM "notification_schema"."telegram_chats"
        WHERE "chat_id" = $1 AND "owner_type" = 'branch'
          AND "is_active" = true AND "owner_id" <> $2
        LIMIT 1`,
      [chatId, branchId],
    );
    if (rowsOf(otherBranch).length) {
      throw new BadRequestException(BRANCH_GROUP_OTHER_BRANCH_MESSAGE);
    }

    const linkedBy = token.created_by ? String(token.created_by) : null;
    const chatTitle = clean(title, 255);
    const previous = await this.chats.findOne({
      where: {
        owner_type: 'branch',
        owner_id: branchId,
        scope: BRANCH_CHAT_SCOPE,
      },
    });
    await this.chats.query(
      `INSERT INTO "notification_schema"."telegram_chats"
              ("chat_id", "chat_type", "owner_type", "owner_id", "scope",
               "is_active", "linked_at", "linked_by", "chat_title")
       VALUES ($1, 'group', 'branch', $2, $3, true, now(), $4, $5)
       ON CONFLICT ("owner_id", "scope") WHERE "owner_type" = 'branch'
       DO UPDATE SET "chat_id" = EXCLUDED."chat_id",
                     "chat_type" = 'group',
                     "is_active" = true,
                     "inactive_reason" = NULL,
                     "inactive_at" = NULL,
                     "linked_at" = now(),
                     "linked_by" = EXCLUDED."linked_by",
                     "chat_title" = EXCLUDED."chat_title",
                     "updated_at" = now()`,
      [chatId, branchId, BRANCH_CHAT_SCOPE, linkedBy, chatTitle],
    );
    const replaced =
      previous?.is_active && previous.chat_id !== chatId
        ? previous.chat_id
        : null;
    await this.activityLog
      .log({
        entity_type: 'TelegramChat',
        entity_id: chatId,
        action: 'notification.tg_branch_group_linked',
        new_value: { branch_id: branchId, chat_id: chatId },
        ...(previous
          ? {
              old_value: {
                chat_id: previous.chat_id,
                is_active: previous.is_active,
              },
            }
          : {}),
        metadata: { replaced_chat_id: replaced },
        user_id: linkedBy,
      })
      .catch(() => undefined);

    const label = clean(token.owner_label, 120);
    const where = label ? `«${label}» filiali kassasiga` : 'filial kassasiga';
    return {
      statusCode: 200,
      message: `✅ Guruh ${where} ulandi. Kassa (smena) yopilganda hisobot shu guruhga keladi.\n\n⚠️ Guruhda kassa summalari ko'rinadi — begonalarni qo'shmang. Hisobotni shaxsiy chatga o'tkazish yoki guruhni uzish — Elchi kabinetidagi filial sahifasida.`,
      data: {
        branch_id: branchId,
        chat_id: chatId,
        replaced_chat_id: replaced,
      },
    };
  }

  // ───────────────────────── panel ─────────────────────────

  async status(input: { branch_id?: unknown }): Promise<{
    statusCode: number;
    message: string;
    data: BranchTelegramStatus;
  }> {
    const branchId = this.branchId(input?.branch_id);
    return {
      statusCode: 200,
      message: 'Branch Telegram',
      data: await this.readStatus(branchId),
    };
  }

  async setReportTarget(input: {
    branch_id?: unknown;
    report_target?: unknown;
    requester?: BranchTelegramRequester;
  }) {
    const userId = this.requesterId(input?.requester);
    this.assertStaff(input?.requester);
    const branchId = this.branchId(input?.branch_id);
    const target = str(input?.report_target) as BranchReportTarget;
    if (!BRANCH_REPORT_TARGETS.includes(target)) {
      throw this.badRequest("report_target — 'group' yoki 'private'");
    }
    const before = await this.readTarget(branchId);
    await this.settings.query(
      `INSERT INTO "notification_schema"."telegram_branch_settings"
              ("branch_id", "report_target", "updated_by", "updated_at")
       VALUES ($1, $2, $3, now())
       ON CONFLICT ("branch_id") DO UPDATE
          SET "report_target" = EXCLUDED."report_target",
              "updated_by" = EXCLUDED."updated_by",
              "updated_at" = now()`,
      [branchId, target, userId],
    );
    if (before !== target) {
      await this.activityLog
        .log({
          entity_type: 'TelegramBranchSetting',
          entity_id: branchId,
          action: 'notification.tg_branch_report_target',
          old_value: { report_target: before },
          new_value: { report_target: target },
          user_id: userId,
        })
        .catch(() => undefined);
    }
    return {
      statusCode: 200,
      message: 'Branch Telegram',
      data: await this.readStatus(branchId),
    };
  }

  /** Panelda «Guruhni uzish» — qator nofaol (`unlinked`), hisobot guruhga bormaydi. */
  async unlink(input: {
    branch_id?: unknown;
    requester?: BranchTelegramRequester;
  }) {
    const userId = this.requesterId(input?.requester);
    this.assertStaff(input?.requester);
    const branchId = this.branchId(input?.branch_id);
    const changed = rowsOf<{ id: string; chat_id: string }>(
      await this.chats.query(
        `UPDATE "notification_schema"."telegram_chats"
            SET "is_active" = false, "inactive_reason" = 'unlinked',
                "inactive_at" = now(), "updated_at" = now()
          WHERE "owner_type" = 'branch' AND "owner_id" = $1
            AND "scope" = $2 AND "is_active" = true
        RETURNING "id", "chat_id"`,
        [branchId, BRANCH_CHAT_SCOPE],
      ),
    );
    for (const row of changed) {
      await this.activityLog
        .log({
          entity_type: 'TelegramChat',
          entity_id: String(row.chat_id),
          action: 'notification.tg_branch_group_unlinked',
          new_value: { branch_id: branchId, chat_id: String(row.chat_id) },
          user_id: userId,
        })
        .catch(() => undefined);
    }
    return {
      statusCode: 200,
      message: changed.length ? 'Guruh uzildi' : 'Ulangan guruh yo‘q',
      data: {
        unlinked: changed.length > 0,
        ...(await this.readStatus(branchId)),
      },
    };
  }

  // ───────────────────────── finance → marshrut ─────────────────────────

  /**
   * finance-service smena hisoboti: filial kassasi hisoboti qayerga.
   * `group.active = false` — guruh bor, lekin nofaol (sababi bilan).
   */
  async route(input: { branch_id?: unknown }) {
    const branchId = this.branchId(input?.branch_id);
    const status = await this.readStatus(branchId);
    return {
      statusCode: 200,
      message: 'Branch Telegram route',
      data: {
        branch_id: branchId,
        report_target: status.report_target,
        group: status.group
          ? {
              active: status.group.is_active,
              inactive_reason: status.group.inactive_reason,
            }
          : null,
      },
    };
  }

  /**
   * Hisobot manzili SOZLANGAN hamma filiallar (asosiy kassa smenasi
   * yopilganda har filialga o'z bo'lagi): guruh ulangan (nofaoli sababi bilan)
   * yoki filial `private` tanlagan. Panelda uzilgan / hech qachon ulanmagan
   * filial — ro'yxatda yo'q.
   */
  async routes() {
    const [rows, privates] = await Promise.all([
      this.chats.find({
        where: { owner_type: 'branch', scope: BRANCH_CHAT_SCOPE },
      }),
      this.settings.find({ where: { report_target: 'private' } }),
    ]);
    const privateIds = new Set(privates.map((row) => String(row.branch_id)));
    const groups = new Map(
      rows
        .filter((row) => row.is_active || row.inactive_reason !== 'unlinked')
        .map((row) => [
          String(row.owner_id),
          {
            active: row.is_active,
            inactive_reason: row.inactive_reason ?? null,
          },
        ]),
    );
    return {
      statusCode: 200,
      message: 'Branch Telegram routes',
      data: [...new Set([...groups.keys(), ...privateIds])].map((branchId) => ({
        branch_id: branchId,
        report_target: privateIds.has(branchId) ? 'private' : 'group',
        group: groups.get(branchId) ?? null,
      })),
    };
  }

  /** Relay: filialning FAOL guruh chat'lari (dispatch tranzaksiyasi ichida). */
  async activeGroupChats(
    manager: EntityManager,
    branchId: string,
  ): Promise<string[]> {
    if (!ID_RE.test(branchId)) return [];
    const rows = await manager.getRepository(TelegramChat).find({
      select: { id: true, chat_id: true },
      where: {
        owner_type: 'branch',
        owner_id: branchId,
        scope: BRANCH_CHAT_SCOPE,
        is_active: true,
      },
    });
    return [...new Set(rows.map((row) => String(row.chat_id)))];
  }

  // ───────────────────────── bot hodisalari ─────────────────────────

  /** Bot guruhdan chiqarildi / bloklandi — filial guruhi nofaol + ulagan xodimga xabar. */
  async markInactive(chatId: string, reason: InactiveReason): Promise<number> {
    if (!GROUP_CHAT_ID_RE.test(chatId)) return 0;
    const changed = rowsOf<{
      id: string;
      owner_id: string;
      linked_by: string | null;
      chat_title: string | null;
    }>(
      await this.chats.query(
        `UPDATE "notification_schema"."telegram_chats"
            SET "is_active" = false, "inactive_reason" = $2,
                "inactive_at" = now(), "updated_at" = now()
          WHERE "chat_id" = $1 AND "owner_type" = 'branch'
            AND ("is_active" = true
                 OR ($2 IN ('kicked', 'left')
                     AND "inactive_reason" = 'blocked_on_send'))
        RETURNING "id", "owner_id", "linked_by", "chat_title"`,
        [chatId, reason],
      ),
    );
    for (const row of changed) {
      await this.activityLog
        .log({
          entity_type: 'TelegramChat',
          entity_id: chatId,
          action: 'notification.tg_channel_inactive',
          metadata: {
            reason,
            chat_type: 'group',
            owner_type: 'branch',
            branch_id: String(row.owner_id),
          },
        })
        .catch(() => undefined);
      await this.notifyLinker(row.linked_by, {
        type: 'telegram.branch_channel_inactive',
        title: 'Filial kassa guruhi nofaol',
        body: `Bot «${row.chat_title ?? 'Telegram'}» guruhidan chiqarildi yoki yozish huquqi olindi (${reason}). Kassa hisoboti guruhga bormaydi — botni qayta qo'shib, filial sahifasidan guruhni qayta ulang yoki hisobotni shaxsiy chatga o'tkazing.`,
        data: { chat_id: chatId, branch_id: String(row.owner_id), reason },
      });
    }
    if (changed.length) {
      this.logger.warn(
        `Filial guruhi ${chatId}: bot ${reason} — ${changed.length} ta ulanish nofaol`,
      );
    }
    return changed.length;
  }

  /** Bot huquqi qaytdi — faqat `blocked_on_send` sababli nofaol bo'lgani qayta faol. */
  async reactivate(chatId: string): Promise<number> {
    if (!GROUP_CHAT_ID_RE.test(chatId)) return 0;
    const changed = rowsOf<{ id: string; owner_id: string }>(
      await this.chats.query(
        `UPDATE "notification_schema"."telegram_chats"
            SET "is_active" = true, "inactive_reason" = NULL,
                "inactive_at" = NULL, "updated_at" = now()
          WHERE "chat_id" = $1 AND "owner_type" = 'branch'
            AND "is_active" = false AND "inactive_reason" = 'blocked_on_send'
        RETURNING "id", "owner_id"`,
        [chatId],
      ),
    );
    for (const row of changed) {
      await this.activityLog
        .log({
          entity_type: 'TelegramChat',
          entity_id: chatId,
          action: 'notification.tg_channel_active',
          metadata: { owner_type: 'branch', branch_id: String(row.owner_id) },
        })
        .catch(() => undefined);
    }
    return changed.length;
  }

  /** Guruh supergroup'ga aylandi — filial qatori yangi chat id'ga ko'chadi. */
  async migrate(oldChatId: string, newChatId: string): Promise<number> {
    if (!oldChatId || !newChatId || oldChatId === newChatId) return 0;
    const changed = rowsOf<{ id: string; owner_id: string }>(
      await this.chats.query(
        `UPDATE "notification_schema"."telegram_chats"
            SET "chat_id" = $2, "updated_at" = now()
          WHERE "chat_id" = $1 AND "owner_type" = 'branch'
        RETURNING "id", "owner_id"`,
        [oldChatId, newChatId],
      ),
    );
    for (const row of changed) {
      await this.activityLog
        .log({
          entity_type: 'TelegramChat',
          entity_id: newChatId,
          action: 'notification.tg_group_migrated',
          metadata: {
            from_group_id: oldChatId,
            to_group_id: newChatId,
            owner_type: 'branch',
            branch_id: String(row.owner_id),
          },
        })
        .catch(() => undefined);
    }
    return changed.length;
  }

  /**
   * Filial guruhiga yangi a'zo (odam) — guruhda kassa summalari ko'rinadi:
   * guruhni ulagan xodim biladi. Guruhga hech narsa yozilmaydi.
   */
  async warnNewMembers(
    chatId: string,
    title: string | null,
    members: Array<{
      id?: number | string;
      first_name?: string;
      username?: string;
    }>,
  ): Promise<number> {
    if (!GROUP_CHAT_ID_RE.test(chatId) || !members.length) return 0;
    const rows = await this.chats.find({
      select: { id: true, owner_id: true, linked_by: true },
      where: { chat_id: chatId, owner_type: 'branch', is_active: true },
    });
    if (!rows.length) return 0;
    const names = members
      .slice(0, 5)
      .map((member) =>
        String(
          member.first_name ||
            (member.username ? `@${member.username}` : 'Foydalanuvchi'),
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 64),
      )
      .join(', ');
    const group = clean(title, 80) ?? 'Telegram';
    for (const row of rows) {
      await this.activityLog
        .log({
          entity_type: 'TelegramChat',
          entity_id: chatId,
          action: 'notification.tg_group_member_joined',
          metadata: {
            owner_type: 'branch',
            branch_id: String(row.owner_id),
            members: members.slice(0, 20).map((m) => String(m.id ?? '')),
          },
        })
        .catch(() => undefined);
      await this.notifyLinker(row.linked_by, {
        type: 'telegram.branch_group_member_joined',
        title: "👥 Filial kassa guruhiga yangi a'zo qo'shildi",
        body: `«${group}» guruhiga qo'shildi: ${names}${members.length > 5 ? ` va yana ${members.length - 5} kishi` : ''}. Guruhda kassa summalari ko'rinadi — tanimasangiz, guruhdan chiqaring.`,
        data: {
          chat_id: chatId,
          branch_id: String(row.owner_id),
          members: members.length,
        },
      });
    }
    return rows.length;
  }

  // ───────────────────────── ichki ─────────────────────────

  private async readTarget(branchId: string): Promise<BranchReportTarget> {
    const row = await this.settings.findOne({ where: { branch_id: branchId } });
    return row?.report_target === 'private' ? 'private' : 'group';
  }

  private async readStatus(branchId: string): Promise<BranchTelegramStatus> {
    const [target, row] = await Promise.all([
      this.readTarget(branchId),
      this.chats.findOne({
        where: {
          owner_type: 'branch',
          owner_id: branchId,
          scope: BRANCH_CHAT_SCOPE,
        },
      }),
    ]);
    // Panelda uzilgan guruh — «ulanmagan» (tarix activity-log'da).
    const group =
      row && !(row.is_active === false && row.inactive_reason === 'unlinked')
        ? {
            chat_id: String(row.chat_id),
            title: row.chat_title ?? null,
            is_active: row.is_active,
            inactive_reason: row.inactive_reason ?? null,
            inactive_at: row.inactive_at ?? null,
            linked_at: row.linked_at,
            linked_by: row.linked_by ? String(row.linked_by) : null,
          }
        : null;
    return { branch_id: branchId, report_target: target, group };
  }

  private async notifyLinker(
    userId: string | null | undefined,
    message: {
      type: string;
      title: string;
      body: string;
      data: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!userId || !ID_RE.test(String(userId)) || !this.moduleRef) return;
    try {
      // NotificationInboxService → … → shu servis: DI halqasi bo'lmasligi
      // uchun chaqiruv paytida olinadi.
      const inbox = this.moduleRef.get(NotificationInboxService, {
        strict: false,
      });
      await inbox.dispatch({
        type: message.type,
        category: NotificationCategory.SYSTEM,
        priority: NotificationPriority.HIGH,
        title: message.title,
        body: message.body,
        recipient_ids: [String(userId)],
        channels: [
          NotificationChannel.IN_APP,
          NotificationChannel.REALTIME,
          NotificationChannel.TELEGRAM,
        ],
        data: message.data,
      });
    } catch (error) {
      this.logger.warn(
        `${message.type} xabari yuborilmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private requesterId(requester?: BranchTelegramRequester): string {
    const id = str(requester?.id).trim();
    if (!ID_RE.test(id)) {
      throw new RpcException({ statusCode: 401, message: 'Unauthorized' });
    }
    return id;
  }

  /** Gateway filial huquqini tekshirgan; bu — ikkinchi qatlam (rol). */
  private assertStaff(requester?: BranchTelegramRequester): void {
    const roles = (Array.isArray(requester?.roles) ? requester.roles : []).map(
      (role) => str(role).toLowerCase(),
    );
    if (
      !roles.some((role) => ['superadmin', 'admin', 'manager'].includes(role))
    ) {
      throw new RpcException({
        statusCode: 403,
        message: 'Filial Telegram guruhini faqat menejer yoki admin boshqaradi',
      });
    }
  }

  private branchId(value: unknown): string {
    const id = str(value).trim();
    if (!ID_RE.test(id) || /^0+$/.test(id)) {
      throw this.badRequest("branch_id noto'g'ri");
    }
    return id;
  }

  private badRequest(message: string): RpcException {
    return new RpcException({ statusCode: 400, message });
  }

  private get botToken(): string {
    return (this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '').trim();
  }

  private get botUsername(): string {
    return (this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? '')
      .trim()
      .replace(/^@/, '');
  }
}
