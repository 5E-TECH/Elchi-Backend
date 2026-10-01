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
import { ConfigService } from '@nestjs/config';
import {
  ActivityAction,
  ActivityLogQuery,
  ActivityLogService,
  Group_type,
  rmqSend,
} from '@app/common';
import { TelegramMarket } from './entities/telegram-market.entity';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { SendNotificationDto } from './dto/send-notification.dto';

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
const GROUP_BIND_UNEXPECTED_ERROR_MESSAGE =
  "Guruhni ulashda xatolik yuz berdi — birozdan so'ng qayta urinib ko'ring";

/** Market tokeni (group_token-…) — Telegram BOT tokeni emas. */
function isGroupBindToken(value?: string | null): boolean {
  return /^group_token-/i.test(String(value ?? '').trim());
}

@Injectable()
export class NotificationServiceService {
  private readonly logger = new Logger(NotificationServiceService.name);

  constructor(
    @InjectRepository(TelegramMarket)
    private readonly tgMarketRepo: Repository<TelegramMarket>,
    private readonly configService: ConfigService,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    private readonly activityLog: ActivityLogService,
  ) {}

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

  private resolveBotToken(
    tokenFromPayload?: string | null,
    tokenFromDb?: string | null,
  ) {
    const envToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    // CODE-02: bot orqali ulangan eski qatorlarda `token` ustunida guruhni
    // ulagan MARKET tokeni (group_token-…) yotibdi — u bot tokeni emas, uni
    // Telegram API'ga yuborish har doim xato berardi. Bunday qiymat
    // e'tiborsiz qoldiriladi: guruhga ulashda ishlatilgan bot (env) yuboradi.
    const dbToken = isGroupBindToken(tokenFromDb) ? null : tokenFromDb;
    const token = tokenFromPayload || dbToken || envToken;

    if (!token) {
      throw new BadRequestException(
        'Telegram bot token is required (payload token, db token, or TELEGRAM_BOT_TOKEN env)',
      );
    }

    return token;
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

  async connectGroupByTokenText(text: string, groupId: string) {
    try {
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

      // CODE-02: maxfiy token matni bazada SAQLANMAYDI (u bot tokeni emas) —
      // yuborishda env bot ishlatiladi. fix3b: token ALMASHTIRILMAYDI.
      const created = this.tgMarketRepo.create({
        market_id: parsed.market_id,
        group_id: groupId,
        group_type: parsed.group_type,
        token: null,
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
        saved,
        201,
        `${market.name ?? 'Market'} uchun Telegram guruhi ulandi`,
      );
    } catch (error) {
      // O'zimizning 400/404 xabarlarimiz (o'zbekcha) guruhga boradi; kutilmagan
      // xato (masalan baza) matni esa faqat logga — guruhga umumiy xabar.
      const isOwnMessage =
        error instanceof BadRequestException ||
        error instanceof NotFoundException;
      const detail =
        error instanceof Error ? error.message : 'Noma’lum xatolik yuz berdi';
      if (isOwnMessage) {
        this.logger.warn(`connectGroupByTokenText failed: ${detail}`);
        return { message: detail };
      }
      this.logger.error(`connectGroupByTokenText failed: ${detail}`);
      return { message: GROUP_BIND_UNEXPECTED_ERROR_MESSAGE };
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

      const entity = this.tgMarketRepo.create({
        market_id: dto.market_id,
        group_id: dto.group_id,
        group_type: dto.group_type,
        token: dto.token ?? null,
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

      return this.successRes(saved, 201, 'Telegram market created');
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
        where,
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });

      return this.successRes(
        {
          items,
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
        where: { id, isDeleted: false },
      });

      if (!item) {
        throw new NotFoundException('Telegram market not found');
      }

      return this.successRes(item, 200, 'Telegram market');
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

      // Snapshot BEFORE mutating — token is excluded from the diff (secret).
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

      if (dto.token !== undefined) {
        target.token = dto.token || null;
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

      // Audit: only changed fields are persisted. token is never snapshotted;
      // we only note whether it was rotated as part of this update.
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
        metadata: {
          market_id: saved.market_id,
          token_changed: dto.token !== undefined,
        },
      });

      return this.successRes(saved, 200, 'Telegram market updated');
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

  private async sendTelegramMessage(data: {
    token: string;
    group_id: string;
    message: string;
    parse_mode?: string;
    disable_web_page_preview?: boolean;
  }) {
    let response: Response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${data.token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: data.group_id,
            text: data.message,
            parse_mode: data.parse_mode,
            disable_web_page_preview: data.disable_web_page_preview,
          }),
          // Bound the outbound call: this runs inside an RMQ handler, and Node's
          // fetch has no default timeout — a stalled Telegram API would leave the
          // message unacked and, with prefetch, wedge the consumer.
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (error) {
      this.logger.error(
        `Telegram HTTP request failed for chat_id=${data.group_id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw new BadRequestException('Telegram request failed');
    }

    const body = await response.json().catch(() => null);

    if (!response.ok || (body && body.ok === false)) {
      const description =
        body?.description || `Telegram API error (${response.status})`;
      this.logger.error(
        `Telegram API sendMessage error for chat_id=${data.group_id}: ${description}`,
      );
      throw new BadRequestException(description);
    }

    return body?.result ?? null;
  }

  async sendDirectToGroup(data: {
    group_id: string;
    message: string;
    token?: string | null;
    parse_mode?: string;
    disable_web_page_preview?: boolean;
  }) {
    const resolvedToken = this.resolveBotToken(data.token);
    await this.sendTelegramMessage({
      token: resolvedToken,
      group_id: data.group_id,
      message: data.message,
      parse_mode: data.parse_mode,
      disable_web_page_preview: data.disable_web_page_preview,
    });
    return { success: true };
  }

  async sendNotification(dto: SendNotificationDto) {
    try {
      if (!dto.message?.trim()) {
        throw new BadRequestException('message is required');
      }

      type Target = {
        id?: string;
        market_id?: string;
        group_type?: Group_type;
        group_id: string;
        token?: string | null;
      };

      let targets: Target[] = [];

      if (dto.group_id) {
        targets = [{ group_id: dto.group_id, token: dto.token ?? null }];
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

        const rows = await this.tgMarketRepo.find({ where });

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
          token: row.token,
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
        error?: string;
      }> = [];

      for (const target of targets) {
        try {
          const resolvedToken = this.resolveBotToken(dto.token, target.token);

          await this.sendTelegramMessage({
            token: resolvedToken,
            group_id: target.group_id,
            message: dto.message,
            parse_mode: dto.parse_mode,
            disable_web_page_preview: dto.disable_web_page_preview,
          });

          results.push({
            id: target.id,
            market_id: target.market_id,
            group_type: target.group_type,
            group_id: target.group_id,
            ok: true,
          });
        } catch (err) {
          results.push({
            id: target.id,
            market_id: target.market_id,
            group_type: target.group_type,
            group_id: target.group_id,
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to send',
          });
        }
      }

      const success = results.filter((item) => item.ok).length;
      const failed = results.length - success;

      return this.successRes(
        {
          total: results.length,
          success,
          failed,
          results,
        },
        200,
        'Notification send result',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }
}
