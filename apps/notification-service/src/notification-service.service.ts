import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsSelect, FindOptionsWhere, Repository } from 'typeorm';
import {
  ActivityAction,
  ActivityLogQuery,
  ActivityLogService,
  Group_type,
  Roles,
  rmqSend,
} from '@app/common';
import { TelegramMarket } from './entities/telegram-market.entity';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { SendNotificationDto } from './dto/send-notification.dto';
import { BotOutboxService } from './bot/bot-outbox.service';
import type { TelegramParseMode } from './bot/telegram.types';

/**
 * CODE-02: guruhni ulash FAQAT marketning maxfiy market_tg_token'i bilan
 * (identity uni `group_token-<32 hex>` ko'rinishida yaratadi). Ixtiyoriy
 * `-create` / `-cancel` qo'shimchasi guruh turini tanlaydi.
 *
 * Ilgari `group_token-<marketId>` (va `-create|cancel`) hech qanday sirsiz
 * qabul qilinardi: istalgan Telegram foydalanuvchisi botni o'z guruhiga
 * qo'shib `group_token-5` yuborsa, 5-marketning guruhi o'sha guruhga
 * ko'chirilar va marketning tokeni almashtirilardi (order-bot WebApp havolasi
 * ishlamay qolardi). Bundan tashqari telegram_markets'da saqlangan eski
 * (allaqachon almashtirilgan) token ham abadiy qabul qilinardi.
 *
 * fix3b (hujjatlar, B varianti):
 *  - ulangandan keyin token ALMASHTIRILMAYDI — u marketning order-bot
 *    kaliti bo'lib qoladi (operator restartdan keyin uni qayta yuboradi,
 *    WebApp ham shu token bilan kiradi);
 *  - mavjud (market, guruh turi) ulanishi bot/token orqali HECH QACHON
 *    almashtirilmaydi — token bilan ham. Qayta ulash faqat admin
 *    PATCH/DELETE /notifications/:id orqali. Shuning uchun guruhda qolgan
 *    token allaqachon ulangan guruhni "o'g'irlay" olmaydi.
 */
const GROUP_BIND_TEXT_RE =
  /^(group_token-[a-z0-9]{14,64})(?:-(create|cancel))?$/i;

const GROUP_BIND_FORMAT_MESSAGE =
  "Token formati noto'g'ri. Admin bergan maxfiy market tokenini (group_token-…) yuboring; bekor qilingan buyurtmalar guruhi uchun token oxiriga -cancel qo'shing.";

const GROUP_BIND_TOKEN_NOT_FOUND_MESSAGE = 'Token topilmadi yoki yaroqsiz';

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
   * CODE-02: matn → (market, guruh turi). Market FAQAT identity'dagi joriy
   * market_tg_token orqali aniqlanadi: id bo'yicha yorliq yo'q, saqlangan
   * eski token bo'yicha zaxira yo'q. Token ulangandan keyin almashtirilmaydi
   * (fix3b) — mavjud ulanishni esa u baribir almashtira olmaydi.
   */
  private async parseGroupTokenText(
    text: string,
  ): Promise<{ market_id: string; group_type: Group_type }> {
    const value = String(text ?? '').trim();
    const match = GROUP_BIND_TEXT_RE.exec(value);
    if (!match) {
      throw new BadRequestException(GROUP_BIND_FORMAT_MESSAGE);
    }
    const [, token, groupTypeRaw] = match;
    const groupType =
      String(groupTypeRaw ?? '').toLowerCase() === Group_type.CANCEL
        ? Group_type.CANCEL
        : Group_type.CREATE;

    const marketByTokenResponse = await rmqSend<any>(
      this.identityClient,
      { cmd: 'identity.market.find_by_tg_token' },
      { market_tg_token: token },
    ).catch(() => null);

    const marketByToken = marketByTokenResponse?.data ?? null;
    if (!marketByToken?.id) {
      throw new BadRequestException(GROUP_BIND_TOKEN_NOT_FOUND_MESSAGE);
    }

    return {
      market_id: String(marketByToken.id),
      group_type: groupType,
    };
  }

  /**
   * (3SeRYFqx #1) HTTP yo'li (POST /notifications/connect-by-token, RMQ
   * notification.telegram.connect_by_token): xato — boshqa metodlar kabi
   * RpcException (400/404, standart konvert statusCode + message). Avval
   * har qanday xato HTTP 201 va konvertsiz { message } bo'lib qaytardi —
   * mijoz muvaffaqiyatsizlikni farqlay olmasdi. Kutilmagan (DB) xato matni
   * mijozga chiqmaydi — umumiy 500 xabari, to'liq sabab logda.
   */
  async connectGroupByToken(text: string, groupId: string) {
    try {
      const group = typeof groupId === 'string' ? groupId.trim() : '';
      if (!/^-?[0-9]+$/.test(group) || group.length > 21) {
        throw new BadRequestException(
          "group_id noto'g'ri — Telegram guruh ID si (masalan -1001234567890) bo'lishi kerak",
        );
      }
      return await this.bindGroupByToken(text, group);
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
   * Bot yo'li (guruh chatidagi token matni): natija ham, xato ham guruhga
   * yuboriladigan { message } — bot uni javob matni sifatida ishlatadi.
   */
  async connectGroupByTokenText(text: string, groupId: string) {
    try {
      return await this.bindGroupByToken(text, groupId);
    } catch (error) {
      // O'zimizning 400/404 xabarlarimiz (o'zbekcha) guruhga boradi; kutilmagan
      // xato (masalan baza) matni esa faqat logga — guruhga umumiy xabar.
      const isOwnMessage =
        error instanceof BadRequestException ||
        error instanceof NotFoundException;
      const detail =
        error instanceof Error ? error.message : NOMALUM_ERROR_MESSAGE;
      if (isOwnMessage) {
        this.logger.warn('connectGroupByTokenText failed: ' + detail);
        return { message: detail };
      }
      this.logger.error('connectGroupByTokenText failed: ' + detail);
      return { message: GROUP_BIND_UNEXPECTED_ERROR_MESSAGE };
    }
  }

  /** Token matni -> (market, guruh turi) ulash. Xato — throw (o'ralmagan). */
  private async bindGroupByToken(text: string, groupId: string) {
    const parsed = await this.parseGroupTokenText(text);
    this.assertBigIntId(parsed.market_id, 'market_id');

    const marketResponse = await rmqSend<any>(
      this.identityClient,
      { cmd: 'identity.market.find_by_id' },
      { id: parsed.market_id },
    ).catch(() => null);

    const market = marketResponse?.data ?? marketResponse ?? null;
    if (!market || !market.id) {
      throw new NotFoundException(GROUP_BIND_MARKET_NOT_FOUND_MESSAGE);
    }

    const existsByGroup = await this.tgMarketRepo.findOne({
      where: {
        group_id: groupId,
        group_type: parsed.group_type,
        isDeleted: false,
      },
    });

    if (existsByGroup) {
      throw new BadRequestException(GROUP_ALREADY_CONNECTED_MESSAGE);
    }

    const existsByMarketType = await this.tgMarketRepo.findOne({
      where: {
        market_id: parsed.market_id,
        group_type: parsed.group_type,
        isDeleted: false,
      },
    });

    // fix3b: mavjud (market, guruh turi) ulanishi token bilan ham
    // ALMASHTIRILMAYDI (faol yoki nofaol bo'lsin) — qayta ulash faqat admin
    // PATCH/DELETE /notifications/:id orqali. Aks holda guruh chatida
    // ko'ringan token bilan istalgan a'zo market guruhini o'ziga ko'chirardi.
    if (existsByMarketType) {
      throw new BadRequestException(MARKET_GROUP_ALREADY_CONNECTED_MESSAGE);
    }

    // CODE-02 / bOMYoOtV: maxfiy token matni bazada SAQLANMAYDI (u bot
    // tokeni emas) — yuborishda env bot ishlatiladi. fix3b: token
    // ALMASHTIRILMAYDI.
    const created = this.tgMarketRepo.create({
      market_id: parsed.market_id,
      group_id: groupId,
      group_type: parsed.group_type,
      is_active: true,
    });

    const saved = await this.tgMarketRepo.save(created);

    // Audit: group connection (token text itself is never logged).
    await this.activityLog.log({
      entity_type: 'TelegramMarket',
      entity_id: saved.id,
      action: 'notification.tg_group_connected',
      metadata: { group_id: groupId, market_id: parsed.market_id },
    });

    return this.successRes(
      this.toPublic(saved),
      201,
      `${market.name ?? 'Market'} uchun Telegram guruhi ulandi`,
    );
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

      const entity = this.tgMarketRepo.create({
        market_id: dto.market_id,
        group_id: dto.group_id,
        group_type: dto.group_type,
        is_active: dto.is_active ?? true,
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
      const target = await this.resolveTelegramMarketTarget({
        id: dto.id,
        market_id: dto.market_id,
        group_type: dto.group_type,
      });

      // Snapshot BEFORE mutating.
      const beforeSnapshot = {
        market_id: target.market_id,
        group_id: target.group_id,
        group_type: target.group_type,
        is_active: target.is_active,
      };

      if (dto.market_id !== undefined) {
        this.assertBigIntId(dto.market_id, 'market_id');
        target.market_id = dto.market_id;
      }

      if (dto.group_id !== undefined) {
        target.group_id = dto.group_id;
      }

      if (dto.group_type !== undefined) {
        target.group_type = dto.group_type;
      }

      if (dto.is_active !== undefined) {
        target.is_active = dto.is_active;
      }

      const duplicate = await this.tgMarketRepo.findOne({
        where: {
          market_id: target.market_id,
          group_type: target.group_type,
          isDeleted: false,
        },
      });

      if (duplicate && duplicate.id !== target.id) {
        throw new BadRequestException(
          'Telegram market for this market_id and group_type already exists',
        );
      }

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
  }) {
    const result = await this.botOutbox.send({
      chatId: data.group_id,
      text: data.message,
      parse_mode: parseModeOf(data.parse_mode),
      disable_web_page_preview: data.disable_web_page_preview,
      source: 'notification.direct',
    });
    if (result.status === 'dead') {
      throw new BadRequestException(result.error ?? 'Telegram send failed');
    }
    return { success: true, status: result.status };
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
