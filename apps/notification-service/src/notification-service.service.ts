import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  FindOptionsSelect,
  FindOptionsWhere,
  Repository,
} from 'typeorm';
import {
  ActivityAction,
  ActivityLogQuery,
  ActivityLogService,
  Group_type,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  Roles,
  rmqSend,
} from '@app/common';
import { TelegramMarket } from './entities/telegram-market.entity';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { SendNotificationDto } from './dto/send-notification.dto';
import { BotOutboxService } from './bot/bot-outbox.service';
import { TelegramLinkService } from './bot/telegram-link.service';
import { NotificationInboxService } from './notification-inbox.service';
import type {
  InlineKeyboardMarkup,
  TelegramParseMode,
} from './bot/telegram.types';

/**
 * (6jXw0DDr / 4TfLyTrL) Guruhni ulash FAQAT paneldan olingan BIR MARTALIK
 * kod bilan (`t.me/<bot>?startgroup=<kod>` → guruhda `/start <kod>`, yoki
 * admin `POST /notifications/connect-by-token { text: <kod>, group_id }`).
 * Matnli `group_token-<raqam>` (market id = "sir") va uzoq yashovchi,
 * aylanmaydigan market tokeni bilan ulash BUTUNLAY olib tashlandi: guruhda
 * ko'ringan token bilan istalgan a'zo marketning buyurtma oqimini o'ziga
 * oqizardi. fix3b qoidalari saqlanadi: mavjud (market, tur) ulanishi va
 * boshqa marketga ulangan guruh HECH QACHON jimgina ustidan yozilmaydi —
 * almashtirish faqat admin PATCH/DELETE /notifications/:id.
 */
const GROUP_BIND_FORMAT_MESSAGE =
  "Ulash kodi noto'g'ri. Kabinetdagi «Telegram guruhini ulash» havolasini oching (kod 10 daqiqa amal qiladi).";

const GROUP_BIND_CODE_USED_MESSAGE =
  'Ulash havolasi eskirgan yoki allaqachon ishlatilgan — kabinetdan yangisini oling';

const GROUP_BIND_WRONG_SCOPE_MESSAGE =
  'Bu havola shaxsiy chat uchun — guruh ulash havolasini oling';

const GROUP_BIND_MARKET_NOT_FOUND_MESSAGE = 'Market topilmadi';

/** Shu guruh shu xabar turi uchun allaqachon ulangan (istalgan marketga). */
const GROUP_ALREADY_CONNECTED_MESSAGE =
  'Bu guruh shu xabar turi uchun allaqachon ulangan';

/** Market uchun shu turdagi guruh bor — bot uni almashtirmaydi (fix3b). */
const MARKET_GROUP_ALREADY_CONNECTED_MESSAGE =
  "Bu market uchun bu turdagi guruh allaqachon ulangan — admin orqali o'zgartiring";

/** Kutilmagan (masalan baza) xato — guruhga ichki xato matni yuborilmaydi. */
const NOMALUM_ERROR_MESSAGE = 'Noma’lum xatolik yuz berdi';

const GROUP_BIND_UNEXPECTED_ERROR_MESSAGE =
  "Guruhni ulashda xatolik yuz berdi — birozdan so'ng qayta urinib ko'ring";

/** (qXlFQp8Q) PATCH faqat is_active — guruhni qo'lda almashtirish yopiq. */
const MANUAL_GROUP_EDIT_FORBIDDEN_MESSAGE =
  "Faqat is_active o'zgartiriladi. Guruhni almashtirish uchun ulanishni o'chirib, bir martalik bot havolasi orqali qayta ulang.";

/**
 * (bOMYoOtV) Telegram ulanishining o'qiladigan ustunlari. Bot TOKENI bazada
 * UMUMAN yo'q (faqat env); `connect_token_hash` — `select: false`, bu yerda
 * tanlanmaydi.
 */
const TG_MARKET_SELECT: FindOptionsSelect<TelegramMarket> = {
  id: true,
  createdAt: true,
  updatedAt: true,
  market_id: true,
  group_id: true,
  group_type: true,
  bot_slug: true,
  is_active: true,
  // (G085w5Qr) nofaol sababi jadvalda ko'rinadi.
  inactive_reason: true,
  inactive_at: true,
  // (BOT-2 #5) kim ulagan.
  linked_by: true,
};

/**
 * Telegram ulanish konfiguratsiyasining OMMAVIY ko'rinishi (`isDeleted`
 * yo'q). GET/POST/PATCH /notifications va connect-by-token javoblari shu
 * orqali. (bOMYoOtV) `has_token` olib tashlandi — har bir guruh env'dagi
 * yagona bot bilan yuboriladi; `bot_slug` — qaysi bot (sir emas).
 */
export function toPublicTelegramMarket(row: TelegramMarket) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    market_id: row.market_id,
    group_id: row.group_id,
    group_type: row.group_type,
    bot_slug: row.bot_slug ?? null,
    is_active: row.is_active,
    // (G085w5Qr) 'kicked' | 'left' | 'blocked_on_send' | 'chat_not_found' |
    // 'manual' | null (faol yoki sabab noma'lum — eski qator).
    inactive_reason: row.inactive_reason ?? null,
    inactive_at: row.inactive_at ?? null,
    // (BOT-2 #5) guruhni ulagan xodim id'si; eski / noma'lum — null.
    linked_by: row.linked_by ?? null,
  };
}

/** `requester` (gateway JwtAuthGuard'dan) — ichki RMQ chaqiruvchilarida yo'q. */
type SendRequester = { id?: string | null; roles?: string[] } | undefined;

/** /notifications/send ni cheklovsiz ishlata oladigan rollar. */
const SEND_UNRESTRICTED_ROLES: readonly string[] = [
  Roles.SUPERADMIN,
  Roles.ADMIN,
];

@Injectable()
export class NotificationServiceService {
  private readonly logger = new Logger(NotificationServiceService.name);

  constructor(
    @InjectRepository(TelegramMarket)
    private readonly tgMarketRepo: Repository<TelegramMarket>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    private readonly activityLog: ActivityLogService,
    private readonly botOutbox: BotOutboxService,
    private readonly links: TelegramLinkService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  private toPublic(row: TelegramMarket) {
    return toPublicTelegramMarket(row);
  }

  /**
   * Normalise the RMQ `requester` payload into the actor fields the
   * activity-log expects. `user_name` is not carried in `requester`, so it is
   * left null; the user_id + role pair is enough to attribute every action.
   */
  private auditActor(requester?: { id?: string; roles?: string[] } | null): {
    user_id: string | null;
    user_role: string | null;
  } {
    const roles = requester?.roles ?? [];
    return {
      user_id: requester?.id ? String(requester.id) : null,
      user_role: roles.length ? roles.join(',') : null,
    };
  }

  async auditLogQuery(q: ActivityLogQuery) {
    return this.activityLog.query(q ?? {});
  }

  async auditLogByEntity(
    entity_type: string,
    entity_id: string,
    limit?: number,
  ) {
    return this.activityLog.findByEntity(entity_type, entity_id, limit ?? 50);
  }

  private successRes(data: unknown, code = 200, message = 'success') {
    return {
      statusCode: code,
      message,
      data,
    };
  }

  private toRpcError(error: unknown): never {
    if (error instanceof RpcException) {
      throw error;
    }

    if (error instanceof NotFoundException) {
      throw new RpcException({ statusCode: 404, message: error.message });
    }

    if (error instanceof BadRequestException) {
      throw new RpcException({ statusCode: 400, message: error.message });
    }

    if (error instanceof ForbiddenException) {
      throw new RpcException({ statusCode: 403, message: error.message });
    }

    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }

  private assertBigIntId(value: string | undefined, fieldName: string) {
    if (!value || !/^\d+$/.test(String(value))) {
      throw new BadRequestException(
        `${fieldName} noto'g'ri — faqat raqam (bigint) bo'lishi kerak`,
      );
    }
  }

  private async resolveTelegramMarketTarget(data: {
    id?: string;
    market_id?: string;
    group_type?: Group_type;
  }) {
    if (data.id) {
      this.assertBigIntId(data.id, 'id');
      const byId = await this.tgMarketRepo.findOne({
        select: TG_MARKET_SELECT,
        where: { id: data.id, isDeleted: false },
      });
      if (!byId) {
        throw new NotFoundException('Telegram market not found');
      }
      return byId;
    }

    if (!data.market_id || !data.group_type) {
      throw new BadRequestException(
        'id OR (market_id + group_type) is required',
      );
    }

    this.assertBigIntId(data.market_id, 'market_id');

    const byMarketType = await this.tgMarketRepo.findOne({
      select: TG_MARKET_SELECT,
      where: {
        market_id: data.market_id,
        group_type: data.group_type,
        isDeleted: false,
      },
    });

    if (!byMarketType) {
      throw new NotFoundException('Telegram market not found');
    }

    return byMarketType;
  }

  /**
   * (3SeRYFqx #1) HTTP yo'li (POST /notifications/connect-by-token, RMQ
   * notification.telegram.connect_by_token): `text` — paneldan olingan BIR
   * MARTALIK guruh ulash kodi (`market_group`). Xato — RpcException
   * (400/404, standart konvert); kutilmagan (DB) xato matni mijozga
   * chiqmaydi — umumiy 500 xabari, to'liq sabab logda.
   */
  async connectGroupByToken(text: string, groupId: string) {
    try {
      const group = typeof groupId === 'string' ? groupId.trim() : '';
      if (!/^-?[0-9]+$/.test(group) || group.length > 21) {
        throw new BadRequestException(
          "group_id noto'g'ri — Telegram guruh ID si (masalan -1001234567890) bo'lishi kerak",
        );
      }
      return await this.bindGroupByCode(text, group, 'connect_by_token');
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'rpc';
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException ||
        error instanceof RpcException
      ) {
        this.logger.warn('connectGroupByToken rad etildi: ' + detail);
        this.toRpcError(error);
      }
      this.logger.error('connectGroupByToken failed: ' + detail);
      throw new RpcException({
        statusCode: 500,
        message: GROUP_BIND_UNEXPECTED_ERROR_MESSAGE,
      });
    }
  }

  /**
   * Bot yo'li (guruhda `/start <kod>`): natija ham, xato ham guruhga
   * yuboriladigan { message } — bot uni javob matni sifatida ishlatadi.
   */
  async connectGroupByCodeText(code: string, groupId: string) {
    try {
      return await this.bindGroupByCode(code, groupId, 'bot_start');
    } catch (error) {
      // O'zimizning 400/404 xabarlarimiz (o'zbekcha) guruhga boradi; kutilmagan
      // xato (masalan baza) matni esa faqat logga — guruhga umumiy xabar.
      const isOwnMessage =
        error instanceof BadRequestException ||
        error instanceof NotFoundException;
      const detail =
        error instanceof Error ? error.message : NOMALUM_ERROR_MESSAGE;
      if (isOwnMessage) {
        this.logger.warn('connectGroupByCodeText failed: ' + detail);
        return { message: detail };
      }
      this.logger.error('connectGroupByCodeText failed: ' + detail);
      return { message: GROUP_BIND_UNEXPECTED_ERROR_MESSAGE };
    }
  }

  /** Kod → ATOMIK band qilish → (market, guruh turi) ulash. Xato — throw. */
  private async bindGroupByCode(
    code: string,
    groupId: string,
    via: 'connect_by_token' | 'bot_start',
  ) {
    const claim = await this.links.claim(code, 'group', groupId);
    if (claim.status === 'invalid') {
      throw new BadRequestException(GROUP_BIND_FORMAT_MESSAGE);
    }
    if (claim.status === 'wrong_scope') {
      throw new BadRequestException(GROUP_BIND_WRONG_SCOPE_MESSAGE);
    }
    if (claim.status !== 'ok') {
      throw new BadRequestException(GROUP_BIND_CODE_USED_MESSAGE);
    }
    const groupType =
      String(claim.token.group_type ?? '').toLowerCase() === Group_type.CANCEL
        ? Group_type.CANCEL
        : Group_type.CREATE;
    return this.bindGroupToMarket({
      market_id: String(claim.token.owner_id),
      group_type: groupType,
      group_id: groupId,
      created_by: claim.token.created_by
        ? String(claim.token.created_by)
        : null,
      via,
    });
  }

  /** (market, guruh turi) ← guruh. Mavjud ulanish HECH QACHON ustidan yozilmaydi. */
  private async bindGroupToMarket(input: {
    market_id: string;
    group_type: Group_type;
    group_id: string;
    created_by: string | null;
    via: string;
  }) {
    const groupId = input.group_id;
    this.assertBigIntId(input.market_id, 'market_id');

    const marketResponse = await rmqSend<any>(
      this.identityClient,
      { cmd: 'identity.market.find_by_id' },
      { id: input.market_id },
    ).catch(() => null);

    const market = marketResponse?.data ?? marketResponse ?? null;
    if (!market || !market.id) {
      throw new NotFoundException(GROUP_BIND_MARKET_NOT_FOUND_MESSAGE);
    }

    const existsByGroup = await this.tgMarketRepo.findOne({
      where: {
        group_id: groupId,
        group_type: input.group_type,
        isDeleted: false,
      },
    });

    if (existsByGroup) {
      throw new BadRequestException(GROUP_ALREADY_CONNECTED_MESSAGE);
    }

    const existsByMarketType = await this.tgMarketRepo.findOne({
      where: {
        market_id: input.market_id,
        group_type: input.group_type,
        isDeleted: false,
      },
    });

    // fix3b / 6jXw0DDr #6: mavjud (market, guruh turi) ulanishi kod bilan
    // ham ALMASHTIRILMAYDI (faol yoki nofaol bo'lsin) — boshqa guruh marketni
    // "tortib ololmaydi"; qayta ulash faqat admin PATCH/DELETE
    // /notifications/:id orqali.
    if (existsByMarketType) {
      throw new BadRequestException(MARKET_GROUP_ALREADY_CONNECTED_MESSAGE);
    }

    // bOMYoOtV: bot tokeni bazada yo'q (yuborishda env bot); ulash kodi
    // faqat hash bo'lib telegram_link_tokens da va allaqachon band qilingan.
    const created = this.tgMarketRepo.create({
      market_id: input.market_id,
      group_id: groupId,
      group_type: input.group_type,
      is_active: true,
      // (BOT-2 #5) kim ulagani saqlanadi (trigger telegram_chats ga ham).
      linked_by: input.created_by,
    });

    const saved = await this.tgMarketRepo.save(created);

    // Audit: group connection (kod matni hech qachon loglanmaydi).
    await this.activityLog.log({
      entity_type: 'TelegramMarket',
      entity_id: saved.id,
      action: 'notification.tg_group_connected',
      metadata: {
        group_id: groupId,
        market_id: input.market_id,
        via: input.via,
        ...(input.created_by ? { linked_by: input.created_by } : {}),
      },
    });

    // (4TfLyTrL #8) market kabinetiga "guruhingiz ulandi".
    await this.notifyMarketGroupConnected(
      input.market_id,
      input.group_type,
      groupId,
    );

    return this.successRes(
      this.toPublic(saved),
      201,
      `${market.name ?? 'Market'} uchun Telegram guruhi ulandi`,
    );
  }

  /**
   * (ysBqD9Nx DIQQAT) Market guruhiga yangi a'zo qo'shildi — guruh egasi
   * market(lar)ga in-app + Telegram DM ogohlantirish: guruhda buyurtma
   * kartalari (ega qarori bo'yicha mijoz ma'lumoti bilan) ko'rinadi. Audit
   * izi ham. Guruh hech bir marketga ulanmagan bo'lsa — jim.
   */
  async warnGroupNewMembers(
    groupId: string,
    title: string | null,
    members: Array<{
      id?: number | string;
      first_name?: string;
      username?: string;
    }>,
  ): Promise<{ markets: number }> {
    const rows = await this.tgMarketRepo.find({
      where: { group_id: String(groupId), is_active: true, isDeleted: false },
    });
    const markets = [...new Set(rows.map((row) => String(row.market_id)))];
    if (!markets.length || !members.length) return { markets: 0 };
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
    const group =
      (title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Telegram';
    await this.activityLog
      .log({
        entity_type: 'TelegramChat',
        entity_id: String(groupId),
        action: 'notification.tg_group_member_joined',
        metadata: {
          market_ids: markets,
          members: members
            .slice(0, 20)
            .map((member) => String(member.id ?? '')),
        },
      })
      .catch(() => undefined);
    if (!this.moduleRef) return { markets: markets.length };
    try {
      const inbox = this.moduleRef.get(NotificationInboxService, {
        strict: false,
      });
      await inbox.dispatch({
        type: 'telegram.group_member_joined',
        category: NotificationCategory.SYSTEM,
        priority: NotificationPriority.HIGH,
        title: "👥 Telegram guruhingizga yangi a'zo qo'shildi",
        body: `«${group}» guruhiga qo'shildi: ${names}${members.length > 5 ? ` va yana ${members.length - 5} kishi` : ''}. Guruhda buyurtma kartalari (mijoz ma'lumotlari bilan) ko'rinadi — tanimasangiz, guruhdan chiqaring. Ishdan ketgan xodimni ham guruhdan chiqarishni unutmang.`,
        recipient_ids: markets,
        channels: [
          NotificationChannel.IN_APP,
          NotificationChannel.REALTIME,
          NotificationChannel.TELEGRAM,
        ],
        data: { chat_id: String(groupId), members: members.length },
      } as never);
    } catch (error) {
      this.logger.warn(
        `telegram.group_member_joined xabari yuborilmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { markets: markets.length };
  }

  private async notifyMarketGroupConnected(
    marketId: string,
    groupType: Group_type,
    groupId: string,
  ): Promise<void> {
    if (!this.moduleRef) return;
    try {
      // NotificationInboxService shu servisga bog'liq — DI halqasi bo'lmasligi
      // uchun chaqiruv paytida olinadi.
      const inbox = this.moduleRef.get(NotificationInboxService, {
        strict: false,
      });
      await inbox.dispatch({
        type: 'telegram.group_connected',
        category: NotificationCategory.SYSTEM,
        priority: NotificationPriority.NORMAL,
        title: 'Telegram guruhingiz ulandi',
        body:
          groupType === Group_type.CANCEL
            ? 'Bekor qilingan buyurtmalar xabarlari endi shu guruhga keladi.'
            : 'Yangi buyurtmalar xabarlari endi shu guruhga keladi.',
        recipient_id: marketId,
        channels: [NotificationChannel.IN_APP, NotificationChannel.REALTIME],
        group_key: `telegram:group_connected:${marketId}`,
        data: { market_id: marketId, group_type: groupType, group_id: groupId },
      } as never);
    } catch (error) {
      this.logger.warn(
        `telegram.group_connected xabari yuborilmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async createTelegramMarket(dto: CreateNotificationDto) {
    try {
      this.assertBigIntId(dto.market_id, 'market_id');

      const existing = await this.tgMarketRepo.findOne({
        where: {
          market_id: dto.market_id,
          group_type: dto.group_type,
          isDeleted: false,
        },
      });

      if (existing) {
        throw new BadRequestException(
          'Telegram market for this market_id and group_type already exists',
        );
      }

      const rawRequesterId = (dto as { requester?: { id?: unknown } }).requester
        ?.id;
      const requesterId =
        typeof rawRequesterId === 'string' || typeof rawRequesterId === 'number'
          ? String(rawRequesterId)
          : '';
      const entity = this.tgMarketRepo.create({
        market_id: dto.market_id,
        group_id: dto.group_id,
        group_type: dto.group_type,
        is_active: dto.is_active ?? true,
        // (BOT-2 #5) admin qo'lda yaratgan ulanish — kim yaratgan; egasi
        // emas → `linked_by_owner: false`.
        linked_by: /^\d{1,19}$/.test(requesterId) ? requesterId : null,
        // (G085w5Qr) nofaol yaratilsa — qo'lda.
        ...(dto.is_active === false
          ? { inactive_reason: 'manual' as const, inactive_at: new Date() }
          : {}),
      });

      const saved = await this.tgMarketRepo.save(entity);

      // Audit: config change. NEVER log the bot token value.
      await this.activityLog.log({
        entity_type: 'TelegramMarket',
        entity_id: saved.id,
        action: ActivityAction.CREATED,
        ...this.auditActor(
          (dto as { requester?: { id?: string; roles?: string[] } }).requester,
        ),
        metadata: {
          market_id: saved.market_id,
          group_type: saved.group_type,
        },
      });

      return this.successRes(
        this.toPublic(saved),
        201,
        'Telegram market created',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findAllTelegramMarkets(query?: {
    market_id?: string;
    group_type?: Group_type;
    is_active?: boolean;
    page?: number;
    limit?: number;
  }) {
    try {
      const page = query?.page && query.page > 0 ? query.page : 1;
      const limit = query?.limit && query.limit > 0 ? query.limit : 20;

      const where: FindOptionsWhere<TelegramMarket> = { isDeleted: false };

      if (query?.market_id) {
        this.assertBigIntId(query.market_id, 'market_id');
        where.market_id = query.market_id;
      }

      if (query?.group_type) {
        where.group_type = query.group_type;
      }

      if (query?.is_active !== undefined) {
        where.is_active = query.is_active;
      }

      const [items, total] = await this.tgMarketRepo.findAndCount({
        select: TG_MARKET_SELECT,
        where,
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });

      return this.successRes(
        {
          items: items.map((item) => this.toPublic(item)),
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
        200,
        'Telegram markets',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * (KJNHAlGW) Market (yoki uning operatori) O'Z Telegram guruhlari holati —
   * har doim ikkala tur (create, cancel). market_id FAQAT tokendan: MARKET —
   * `sub`, MARKET_OPERATOR — identity `user.market_id`; klient yuborgan
   * market_id e'tiborga olinmaydi. group_id va bot_slug qaytarilmaydi.
   * Ulash oynasi har 3-5 soniyada so'raydi — (market_id, group_type)
   * indeksi (IDX_TG_MARKET_GROUP) bo'yicha bitta so'rov.
   */
  async findMyTelegramGroups(data: {
    requester?: { id?: unknown; roles?: unknown };
  }) {
    try {
      const marketId = await this.resolveOwnMarketId(data?.requester);
      const rows = await this.tgMarketRepo.find({
        select: {
          id: true,
          createdAt: true,
          group_type: true,
          is_active: true,
          inactive_reason: true,
          linked_by: true,
        },
        where: { market_id: marketId, isDeleted: false },
        order: { createdAt: 'DESC' },
      });
      const items = [Group_type.CREATE, Group_type.CANCEL].map((groupType) => {
        const row = rows.find((item) => item.group_type === groupType);
        return {
          group_type: groupType,
          linked: Boolean(row),
          is_active: row ? row.is_active : null,
          linked_at: row ? row.createdAt : null,
          // (G085w5Qr) nofaol sababi; faol yoki ulanmagan — null.
          inactive_reason: row ? (row.inactive_reason ?? null) : null,
          /**
           * (BOT-2 #5, ega qarori Q2 = A) Guruhni endi faqat market egasi
           * yoki admin ulaydi. Avval operator ulagan eski guruhlar egaga
           * ko'rsatiladi: `linked_by_owner: false` — boshqa xodim (operator /
           * admin) ulagan, `null` — noma'lum (eski, audit izi yo'q).
           */
          linked_by: row ? (row.linked_by ?? null) : null,
          linked_by_owner:
            row && row.linked_by ? String(row.linked_by) === marketId : null,
        };
      });
      return this.successRes(items, 200, 'Telegram guruhlari holati');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /** (KJNHAlGW) "O'z marketi" — tokendan; topilmasa 403 (fail-closed). */
  private async resolveOwnMarketId(requester?: {
    id?: unknown;
    roles?: unknown;
  }): Promise<string> {
    const userId =
      typeof requester?.id === 'string' || typeof requester?.id === 'number'
        ? String(requester.id).trim()
        : '';
    const roles = (
      Array.isArray(requester?.roles) ? (requester.roles as unknown[]) : []
    ).map((role) => (typeof role === 'string' ? role.toLowerCase() : ''));
    let own = '';
    if (roles.includes(Roles.MARKET) && /^\d{1,19}$/.test(userId)) {
      own = userId;
    } else if (
      roles.includes(Roles.MARKET_OPERATOR) &&
      /^\d{1,19}$/.test(userId)
    ) {
      const profile = await rmqSend<{ data?: { market_id?: unknown } }>(
        this.identityClient,
        { cmd: 'identity.user.find_by_id' },
        { id: userId },
      ).catch(() => null);
      const raw = profile?.data?.market_id;
      own =
        typeof raw === 'string' || typeof raw === 'number'
          ? String(raw).trim()
          : '';
    }
    if (!/^\d{1,19}$/.test(own)) {
      throw new ForbiddenException(
        roles.includes(Roles.MARKET_OPERATOR)
          ? 'Operator hech qaysi marketga biriktirilmagan'
          : "Telegram guruhlari holatini faqat market yoki uning operatori ko'radi",
      );
    }
    return own;
  }

  async findTelegramMarketById(id?: string) {
    try {
      this.assertBigIntId(id, 'id');

      const item = await this.tgMarketRepo.findOne({
        select: TG_MARKET_SELECT,
        where: { id, isDeleted: false },
      });

      if (!item) {
        throw new NotFoundException('Telegram market not found');
      }

      return this.successRes(this.toPublic(item), 200, 'Telegram market');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async updateTelegramMarket(dto: UpdateNotificationDto) {
    try {
      // (qXlFQp8Q) Faqat is_active o'zgaradi: guruh ID / market / tur qo'lda
      // almashtirilmaydi (bot tekshiruvisiz begona guruhni bog'lash yo'li).
      // Gateway DTO ham bularni 400 bilan rad etadi; bu — ichki RMQ himoyasi.
      if (
        dto.group_id !== undefined ||
        dto.market_id !== undefined ||
        dto.group_type !== undefined
      ) {
        throw new BadRequestException(MANUAL_GROUP_EDIT_FORBIDDEN_MESSAGE);
      }
      const target = await this.resolveTelegramMarketTarget({ id: dto.id });

      // Snapshot BEFORE mutating.
      const beforeSnapshot = {
        market_id: target.market_id,
        group_id: target.group_id,
        group_type: target.group_type,
        is_active: target.is_active,
        inactive_reason: target.inactive_reason ?? null,
      };

      if (dto.is_active !== undefined) {
        // (G085w5Qr) Qo'lda o'chirish — 'manual'; faollashtirish — sabab
        // tozalanadi. Holat o'zgarmasa sabab ham saqlanib qoladi.
        if (dto.is_active !== target.is_active) {
          target.inactive_reason = dto.is_active ? null : 'manual';
          target.inactive_at = dto.is_active ? null : new Date();
        }
        target.is_active = dto.is_active;
      }

      // (qXlFQp8Q) market_id / group_type o'zgarmaydi — takror tekshiruvi
      // endi kerak emas.
      const saved = await this.tgMarketRepo.save(target);

      // Audit: only changed fields are persisted.
      await this.activityLog.logChange({
        entity_type: 'TelegramMarket',
        entity_id: saved.id,
        action: ActivityAction.UPDATED,
        old_value: beforeSnapshot,
        new_value: {
          market_id: saved.market_id,
          group_id: saved.group_id,
          group_type: saved.group_type,
          is_active: saved.is_active,
          inactive_reason: saved.inactive_reason ?? null,
        },
        ...this.auditActor(
          (dto as { requester?: { id?: string; roles?: string[] } }).requester,
        ),
        metadata: { market_id: saved.market_id },
      });

      return this.successRes(
        this.toPublic(saved),
        200,
        'Telegram market updated',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async deleteTelegramMarket(data: {
    id?: string;
    market_id?: string;
    group_type?: Group_type;
  }) {
    try {
      const target = await this.resolveTelegramMarketTarget(data);
      const marketId = target.market_id;
      target.isDeleted = true;
      await this.tgMarketRepo.save(target);

      // Audit: config removal.
      await this.activityLog.log({
        entity_type: 'TelegramMarket',
        entity_id: target.id,
        action: ActivityAction.DELETED,
        ...this.auditActor(
          (data as { requester?: { id?: string; roles?: string[] } }).requester,
        ),
        metadata: { market_id: marketId },
      });

      return this.successRes({ id: target.id }, 200, 'Telegram market deleted');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * Bitta chatga xabar (shaxsiy DM outbox'i va boshqa ichki chaqiruvchilar).
   * (bOMYoOtV / 9HIaV80X) Token FAQAT env'dan — chaqiruvchi bermaydi; xabar
   * avval `telegram_outbox` ga yoziladi. `sent`/`queued` — muvaffaqiyat
   * (queued: 429/5xx, outbox o'zi qayta yuboradi), `dead` (403/400) — xato.
   */
  async sendDirectToGroup(data: {
    group_id: string;
    message: string;
    parse_mode?: string;
    disable_web_page_preview?: boolean;
    reply_markup?: InlineKeyboardMarkup;
    source?: string;
    /** (BOT-3c) `queued` bo'lsa yakuniy holatni outbox shu qatorlarga yozadi. */
    notification_ids?: string[];
  }) {
    const result = await this.botOutbox.send({
      chatId: data.group_id,
      text: data.message,
      parse_mode: parseModeOf(data.parse_mode),
      disable_web_page_preview: data.disable_web_page_preview,
      reply_markup: data.reply_markup,
      source: data.source ?? 'notification.direct',
      notificationIds: data.notification_ids,
    });
    if (result.status === 'dead') {
      throw new BadRequestException(result.error ?? 'Telegram send failed');
    }
    return {
      success: true,
      status: result.status,
      result: result.result ?? null,
    };
  }

  /**
   * (BOT-3c) Inbox dispatch'ining guruh relay'i (bekor / market guruhi
   * xabari) — dispatch TRANZAKSIYASI ichida: nishon guruhlar shu
   * tranzaksiyada o'qiladi, har biriga `telegram_outbox` qatori (`pending`,
   * yakuniy natija `notificationIds` ga). Rollback → xabar yo'q; commit'dan
   * keyin servis yiqilsa ham worker yuboradi. Guruh yo'q — `null`.
   * Commit'dan keyin `flushGroupRelay` bilan darhol yuboriladi.
   */
  async enqueueGroupRelay(
    manager: EntityManager,
    target: { market_id?: string; group_id?: string; group_type?: Group_type },
    message: string,
    notificationIds: string[],
  ): Promise<string[] | null> {
    let chats: string[];
    if (target.group_id) {
      chats = [target.group_id];
    } else if (target.market_id) {
      this.assertBigIntId(target.market_id, 'market_id');
      const where: FindOptionsWhere<TelegramMarket> = {
        market_id: target.market_id,
        isDeleted: false,
        is_active: true,
      };
      if (target.group_type) where.group_type = target.group_type;
      const rows = await manager
        .getRepository(TelegramMarket)
        .find({ select: { id: true, group_id: true }, where });
      // Bir guruh ikki turga ulangan bo'lsa — bir marta.
      chats = [...new Set(rows.map((row) => String(row.group_id)))];
    } else {
      return null;
    }
    if (!chats.length) return null;
    const ids: string[] = [];
    for (const chatId of chats) {
      ids.push(
        await this.botOutbox.enqueue(manager, {
          chatId,
          text: message,
          parse_mode: 'HTML',
          source: 'notification.relay',
          notificationIds,
        }),
      );
    }
    return ids;
  }

  /**
   * (BOT-3c) `enqueueGroupRelay` qatorlarini commit'dan keyin darhol yuborish.
   * Javob — `sendNotification` ning `data` ko'rinishi (relay natijasi uchun).
   */
  async flushGroupRelay(ids: string[]) {
    const results = await this.botOutbox.sendNow(ids);
    const success = results.filter((item) => item.status === 'sent').length;
    const queued = results.filter((item) => item.status === 'queued').length;
    return {
      data: {
        total: results.length,
        success,
        failed: results.length - success - queued,
        queued,
        results: results.map((item) => ({
          ok: item.status === 'sent',
          ...(item.status === 'queued' ? { queued: true } : {}),
          ...(item.error ? { error: item.error } : {}),
        })),
      },
    };
  }

  async sendNotification(dto: SendNotificationDto) {
    try {
      if (!dto.message?.trim()) {
        throw new BadRequestException('message is required');
      }
      // (n0kLbx3d) Gateway `requester` ni qo'shadi. SUPERADMIN/ADMIN —
      // cheklovsiz; boshqa rol (REGISTRATOR) — faqat Elchi'da ulangan
      // (telegram_markets) guruhlarga. Ichki RMQ chaqiruvchilarida
      // (integration-service admin ogohlantirishi) requester yo'q.
      const requester = (dto as { requester?: SendRequester }).requester;
      const restricted =
        Boolean(requester) &&
        !(requester?.roles ?? []).some((role) =>
          SEND_UNRESTRICTED_ROLES.includes(String(role).toLowerCase()),
        );

      type Target = {
        id?: string;
        market_id?: string;
        group_type?: Group_type;
        group_id: string;
      };

      let targets: Target[] = [];

      if (dto.group_id && restricted) {
        // Ixtiyoriy chat EMAS: guruh biror marketga faol ulangan bo'lishi
        // shart, aks holda 403 (platforma boti begona chatga ishlatilmasin).
        const registered = await this.tgMarketRepo.find({
          select: TG_MARKET_SELECT,
          where: { group_id: dto.group_id, isDeleted: false, is_active: true },
        });
        if (!registered.length) {
          throw new ForbiddenException(
            'Bu Telegram guruhi Elchi marketiga ulanmagan — faqat ulangan market guruhlariga (market_id orqali) yuborish mumkin',
          );
        }
        // Bir guruh ikki turga (create/cancel) ulangan bo'lsa — bir marta.
        targets = [registered[0]].map((row) => ({
          id: row.id,
          market_id: row.market_id,
          group_type: row.group_type,
          group_id: row.group_id,
        }));
      } else if (dto.group_id) {
        targets = [{ group_id: dto.group_id }];
      } else if (dto.market_id) {
        this.assertBigIntId(dto.market_id, 'market_id');

        const where: FindOptionsWhere<TelegramMarket> = {
          market_id: dto.market_id,
          isDeleted: false,
          is_active: true,
        };

        if (dto.group_type) {
          where.group_type = dto.group_type;
        }

        const rows = await this.tgMarketRepo.find({
          select: TG_MARKET_SELECT,
          where,
        });

        if (!rows.length) {
          throw new NotFoundException(
            'Telegram target group not found for market',
          );
        }

        targets = rows.map((row) => ({
          id: row.id,
          market_id: row.market_id,
          group_type: row.group_type,
          group_id: row.group_id,
        }));
      } else {
        throw new BadRequestException('group_id or market_id is required');
      }

      const results: Array<{
        id?: string;
        market_id?: string;
        group_type?: Group_type;
        group_id: string;
        ok: boolean;
        queued?: boolean;
        error?: string;
      }> = [];

      for (const target of targets) {
        // (bOMYoOtV) Bot tokeni FAQAT env'dan; DB/payload tokeni yo'q.
        // (9HIaV80X) Avval outbox'ga, keyin yuborish: 429/5xx — navbatda
        // (queued, worker qayta uradi), 403/400 — dead (qayta urinilmaydi).
        const sent = await this.botOutbox.send({
          chatId: target.group_id,
          text: dto.message,
          parse_mode: parseModeOf(dto.parse_mode),
          disable_web_page_preview: dto.disable_web_page_preview,
          source: 'notification.send',
        });
        results.push({
          id: target.id,
          market_id: target.market_id,
          group_type: target.group_type,
          group_id: target.group_id,
          ok: sent.status === 'sent',
          ...(sent.status === 'queued' ? { queued: true } : {}),
          ...(sent.error ? { error: sent.error } : {}),
        });
      }

      const success = results.filter((item) => item.ok).length;
      const queued = results.filter((item) => item.queued).length;
      const failed = results.length - success - queued;

      // (3SeRYFqx #2 / 9HIaV80X #4) Natija tana statusCode ida (gateway
      // BodyStatusCodeInterceptor uni HTTP holatiga ko'chiradi): hammasi
      // ketdi — 200; hech biri ketmadi va qayta urinilmaydi — 502; qolgani
      // navbatda (429/5xx, outbox qayta yuboradi) — 202; aralash — 207.
      // `failed` — faqat qaytmas xatolar (dead); `queued` — qayta urinishda.
      const statusCode =
        failed === results.length
          ? 502
          : success === results.length
            ? 200
            : failed === 0 && success === 0
              ? 202
              : 207;
      return this.successRes(
        {
          total: results.length,
          success,
          failed,
          queued,
          results,
        },
        statusCode,
        statusCode === 200
          ? 'Notification send result'
          : statusCode === 502
            ? 'Notification not sent: all ' + failed + ' target(s) failed'
            : statusCode === 202
              ? 'Queued for retry: ' + queued + '/' + results.length
              : 'Partially sent: ' +
                success +
                '/' +
                results.length +
                ' sent, ' +
                queued +
                ' queued, ' +
                failed +
                ' failed',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }
}

/** DTO'dagi parse_mode → Bot API qiymati (noma'lum — oddiy matn). */
function parseModeOf(value?: string): TelegramParseMode | undefined {
  return value === 'HTML' || value === 'MarkdownV2' || value === 'Markdown'
    ? value
    : undefined;
}
