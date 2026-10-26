import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { ActivityLogService, Cashbox_type } from '@app/common';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { FinanceSetting } from '../entities/finance-setting.entity';
import {
  ShiftAccountAiStatus,
  ShiftAccountCheck,
} from '../entities/shift-account-check.entity';
import { Shift, ShiftStatus } from '../entities/shift.entity';
import { FinanceRealtimeService } from '../realtime/finance-realtime.service';
import {
  ACCOUNT_COMMENT_REQUIRED_MESSAGE,
  ACCOUNT_PHOTO_REQUIRED_MESSAGE,
  SHIFT_CHECK_DEFAULTS,
  SHIFT_SETTING_KEYS,
  deriveAiStatus,
  deriveEnteredOk,
  isAiEnabled,
  isCommentRequired,
  isPhotoRequired,
  round2,
  summarizeStatuses,
  type AiCheckResult,
  type ShiftCheckSettings,
} from './shift-account-check.rules';

const MAIN_CASHBOX_USER_ID = '0';
/** Yopishda AI `pending` ni kutish (ega: 30 s gacha). */
const DEFAULT_CLOSE_WAIT_MS = 30_000;
const CLOSE_WAIT_POLL_MS = 1_000;
/** Shundan eski `pending` (masalan gateway qayta ishga tushgan) kutilmaydi. */
const PENDING_STALE_MS = 3 * 60_000;

/** Yopish DTO'sidagi bitta karta qatori. */
export interface CloseShiftAccountInput {
  card_id?: unknown;
  entered_balance?: unknown;
  photo_file_key?: unknown;
  comment?: unknown;
}

function forbidden(message: string): never {
  throw new RpcException({ statusCode: 403, message });
}

function toRpcError(error: unknown): never {
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

function successRes(data: unknown, statusCode = 200, message = 'success') {
  return { statusCode, message, data };
}

function scalarText(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  ) {
    return String(value).trim();
  }
  return '';
}

function assertId(value: unknown, field: string): string {
  const text = scalarText(value);
  if (!/^\d+$/.test(text) || /^0+$/.test(text)) {
    throw new BadRequestException(`${field} noto'g'ri`);
  }
  return text;
}

function parseBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new BadRequestException(`${field} boolean bo'lishi kerak`);
}

function parseMoney(value: unknown, field: string): number {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(num) || num < 0) {
    throw new BadRequestException(
      `${field} manfiy bo'lmagan son bo'lishi kerak`,
    );
  }
  return round2(num);
}

const shiftCashboxUserId = (shift: Pick<Shift, 'cashbox_user_id'>): string =>
  String(shift.cashbox_user_id ?? MAIN_CASHBOX_USER_ID);

const cashboxTypeFor = (cashboxUserId: string): Cashbox_type =>
  cashboxUserId === MAIN_CASHBOX_USER_ID
    ? Cashbox_type.MAIN
    : Cashbox_type.BRANCH;

/**
 * kiZgTybn — smena yopilishida har karta / hisob raqam qoldig'ini
 * tasdiqlash: qoralama (rasm yuklanganda), AI natijasi (asinxron), yopishda
 * yakuniy snapshot, hisobot va superadmin sozlamalari.
 *
 * ⚠️ PUL INVARIANTI: bu servis kassa / karta balanslarini HECH QACHON
 * o'zgartirmaydi — faqat o'qiydi (snapshot) va `shift_account_checks` /
 * `finance_settings` ga yozadi.
 */
@Injectable()
export class ShiftAccountCheckService {
  private readonly logger = new Logger(ShiftAccountCheckService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly activityLog: ActivityLogService,
    @Optional() private readonly realtime?: FinanceRealtimeService,
  ) {}

  // ───────────────────────── sozlamalar ─────────────────────────

  async loadSettings(manager?: EntityManager): Promise<ShiftCheckSettings> {
    const repo = (manager ?? this.dataSource.manager).getRepository(
      FinanceSetting,
    );
    const rows = await repo.find({
      where: {
        key: In(Object.values(SHIFT_SETTING_KEYS)),
        isDeleted: false,
      },
    });
    const map = new Map(rows.map((row) => [row.key, row.value]));
    const pick = (key: string, fallback: boolean): boolean => {
      const value = map.get(key);
      return typeof value === 'boolean' ? value : fallback;
    };
    return {
      account_check_enabled: pick(
        SHIFT_SETTING_KEYS.accountCheckEnabled,
        SHIFT_CHECK_DEFAULTS.account_check_enabled,
      ),
      photo_required: pick(
        SHIFT_SETTING_KEYS.photoRequired,
        SHIFT_CHECK_DEFAULTS.photo_required,
      ),
      ai_check_enabled: pick(
        SHIFT_SETTING_KEYS.aiCheckEnabled,
        SHIFT_CHECK_DEFAULTS.ai_check_enabled,
      ),
    };
  }

  /** Kassa (MAIN yoki filial) va uning faol kartalari. */
  private async findCashbox(
    manager: EntityManager,
    cashboxUserId: string,
  ): Promise<Cashbox | null> {
    return manager.findOne(Cashbox, {
      where: {
        user_id: cashboxUserId,
        cashbox_type: cashboxTypeFor(cashboxUserId),
        isDeleted: false,
      },
    });
  }

  private async activeCards(
    manager: EntityManager,
    cashboxId: string,
  ): Promise<CashboxCard[]> {
    return manager.find(CashboxCard, {
      where: { cashbox_id: cashboxId, isDeleted: false, is_active: true },
      order: { is_default: 'DESC', sort_order: 'ASC', id: 'ASC' },
    });
  }

  /**
   * Har kartaning TIZIM qoldig'i: nomli karta — `balance`, Asosiy karta —
   * hosila `balance_card − Σ(nomli kartalar)` (entity izohi).
   */
  private async systemBalances(
    manager: EntityManager,
    cashbox: Cashbox,
  ): Promise<Map<string, number>> {
    const cards = await manager.find(CashboxCard, {
      where: { cashbox_id: String(cashbox.id), isDeleted: false },
    });
    const named = round2(
      cards
        .filter((card) => !card.is_default)
        .reduce((sum, card) => sum + Number(card.balance ?? 0), 0),
    );
    const result = new Map<string, number>();
    for (const card of cards) {
      result.set(
        String(card.id),
        card.is_default
          ? round2(Number(cashbox.balance_card ?? 0) - named)
          : round2(Number(card.balance ?? 0)),
      );
    }
    return result;
  }

  async getSettings(input?: { cashbox_user_id?: unknown }) {
    try {
      const cashboxUserId =
        scalarText(input?.cashbox_user_id) || MAIN_CASHBOX_USER_ID;
      if (!/^\d+$/.test(cashboxUserId)) {
        throw new BadRequestException("cashbox_user_id noto'g'ri");
      }
      const manager = this.dataSource.manager;
      const settings = await this.loadSettings(manager);
      const cashbox = await this.findCashbox(manager, cashboxUserId);
      const cards = cashbox
        ? await this.activeCards(manager, String(cashbox.id))
        : [];
      return successRes(
        {
          ...settings,
          cashbox_user_id: cashboxUserId,
          cashbox_type:
            cashboxUserId === MAIN_CASHBOX_USER_ID ? 'main' : 'branch',
          cards: cards.map((card) => ({
            card_id: String(card.id),
            name: card.name,
            kind: card.kind ?? null,
            bank_name: card.bank_name ?? null,
            last4: card.last4 ?? null,
            is_default: card.is_default,
            require_photo_on_shift_close: Boolean(
              card.require_photo_on_shift_close,
            ),
            ai_check_enabled: Boolean(card.ai_check_enabled),
            photo_required: isPhotoRequired(settings, card),
            ai_enabled: isAiEnabled(settings, card),
          })),
        },
        200,
        'Shift check settings',
      );
    } catch (error) {
      toRpcError(error);
    }
  }

  /** Faqat SUPERADMIN (gateway `@Roles` + bu yerda `requester_roles`). */
  async updateSettings(input: {
    requester_id?: unknown;
    requester_roles?: unknown;
    account_check_enabled?: unknown;
    photo_required?: unknown;
    ai_check_enabled?: unknown;
    cards?: unknown;
  }) {
    try {
      const roles = Array.isArray(input?.requester_roles)
        ? input.requester_roles.map((role) => String(role).toLowerCase())
        : [];
      if (!roles.includes('superadmin')) {
        forbidden("Smena sozlamalarini faqat superadmin o'zgartiradi");
      }
      const requesterId = scalarText(input?.requester_id) || null;
      const globals: Array<[string, boolean]> = [];
      const accountCheck = parseBool(
        input?.account_check_enabled,
        'account_check_enabled',
      );
      const photo = parseBool(input?.photo_required, 'photo_required');
      const ai = parseBool(input?.ai_check_enabled, 'ai_check_enabled');
      if (accountCheck !== undefined) {
        globals.push([SHIFT_SETTING_KEYS.accountCheckEnabled, accountCheck]);
      }
      if (photo !== undefined) {
        globals.push([SHIFT_SETTING_KEYS.photoRequired, photo]);
      }
      if (ai !== undefined) {
        globals.push([SHIFT_SETTING_KEYS.aiCheckEnabled, ai]);
      }

      const rawCards: unknown[] = Array.isArray(input?.cards)
        ? input.cards
        : [];
      if (rawCards.length > 200) {
        throw new BadRequestException("cards ro'yxati juda uzun");
      }
      const cardPatches = rawCards.map((raw, index) => {
        const item = (raw ?? {}) as Record<string, unknown>;
        return {
          card_id: assertId(item.card_id, `cards[${index}].card_id`),
          require_photo_on_shift_close: parseBool(
            item.require_photo_on_shift_close,
            `cards[${index}].require_photo_on_shift_close`,
          ),
          ai_check_enabled: parseBool(
            item.ai_check_enabled,
            `cards[${index}].ai_check_enabled`,
          ),
        };
      });
      if (!globals.length && !cardPatches.length) {
        throw new BadRequestException("O'zgartiriladigan sozlama berilmadi");
      }

      const before = await this.loadSettings();
      const changedCards: Array<Record<string, unknown>> = [];
      await this.dataSource.transaction(async (manager) => {
        for (const [key, value] of globals) {
          await manager
            .createQueryBuilder()
            .insert()
            .into(FinanceSetting)
            .values({ key, value: value as never, updated_by: requesterId })
            .orUpdate(['value', 'updated_by', 'updatedAt'], ['key'])
            .execute();
        }
        for (const patch of cardPatches) {
          const card = await manager.findOne(CashboxCard, {
            where: { id: patch.card_id, isDeleted: false },
            lock: { mode: 'pessimistic_write' },
          });
          if (!card) throw new NotFoundException('Karta topilmadi');
          const nextPhoto =
            patch.require_photo_on_shift_close ??
            card.require_photo_on_shift_close;
          // Rasm o'chirilsa AI ham o'chadi (migratsiya 161 CHECK).
          const nextAi =
            patch.ai_check_enabled ??
            (nextPhoto ? card.ai_check_enabled : false);
          if (nextAi && !nextPhoto) {
            throw new BadRequestException(
              'AI tekshiruvi faqat smena yopishda qoldiq rasmi talab qilinganda yoqiladi',
            );
          }
          changedCards.push({
            card_id: String(card.id),
            old: {
              require_photo_on_shift_close: card.require_photo_on_shift_close,
              ai_check_enabled: card.ai_check_enabled,
            },
            new: {
              require_photo_on_shift_close: nextPhoto,
              ai_check_enabled: nextAi,
            },
          });
          await manager.update(
            CashboxCard,
            { id: String(card.id) },
            {
              require_photo_on_shift_close: nextPhoto,
              ai_check_enabled: nextAi,
            },
          );
        }
      });
      const after = await this.loadSettings();
      await this.activityLog.log({
        entity_type: 'FinanceSetting',
        entity_id: 'shift',
        action: 'finance.shift_settings_updated',
        old_value: before as unknown as Record<string, unknown>,
        new_value: {
          ...after,
          cards: changedCards.map((item) => item.new),
        } as unknown as Record<string, unknown>,
        metadata: { cards: changedCards },
        user_id: requesterId,
      });
      return successRes(
        { ...after, cards: changedCards },
        200,
        'Shift check settings updated',
      );
    } catch (error) {
      toRpcError(error);
    }
  }

  // ───────────────────────── rasm (qoralama) ─────────────────────────

  /**
   * Rasm yuklandi (gateway file-service'ga yozgan) → qoralama qatori.
   * Faqat OCHIQ smena; karta shu smena kassasiniki; menejer — o'z filiali.
   * AI yoqilgan bo'lsa `pending` + yangi `ai_request_id` (gateway AI'ni
   * fonda chaqiradi va natijani `applyAiResult` ga yuboradi).
   */
  async attachPhoto(input: {
    shift_id?: unknown;
    card_id?: unknown;
    photo_file_key?: unknown;
    entered_balance?: unknown;
    comment?: unknown;
    requester_id?: unknown;
    cashbox_user_id?: unknown;
  }) {
    try {
      const cardId = assertId(input?.card_id, 'card_id');
      const photoKey = scalarText(input?.photo_file_key);
      if (!photoKey || photoKey.length > 500) {
        throw new BadRequestException("photo_file_key noto'g'ri");
      }
      const requesterId = assertId(input?.requester_id, 'requester_id');
      const scope = scalarText(input?.cashbox_user_id) || null;
      const entered =
        input?.entered_balance === undefined ||
        input?.entered_balance === null ||
        input?.entered_balance === ''
          ? null
          : parseMoney(input.entered_balance, 'entered_balance');
      const comment = scalarText(input?.comment).slice(0, 1000) || null;

      const outcome = await this.dataSource.transaction(async (manager) => {
        const card = await manager.findOne(CashboxCard, {
          where: { id: cardId, isDeleted: false },
        });
        if (!card || !card.is_active) {
          throw new NotFoundException('Karta topilmadi');
        }
        const cashbox = await manager.findOne(Cashbox, {
          where: { id: String(card.cashbox_id), isDeleted: false },
        });
        if (
          !cashbox ||
          (cashbox.cashbox_type !== Cashbox_type.MAIN &&
            cashbox.cashbox_type !== Cashbox_type.BRANCH)
        ) {
          throw new NotFoundException('Karta kassasi topilmadi');
        }
        const cashboxUserId =
          cashbox.cashbox_type === Cashbox_type.MAIN
            ? MAIN_CASHBOX_USER_ID
            : String(cashbox.user_id);
        if (scope && scope !== cashboxUserId) {
          forbidden('Bu karta sizning kassangizga tegishli emas');
        }

        let shift: Shift | null;
        if (input?.shift_id !== undefined && input?.shift_id !== null) {
          const shiftId = assertId(input.shift_id, 'shift_id');
          shift = await manager.findOne(Shift, {
            where: { id: shiftId, isDeleted: false },
            lock: { mode: 'pessimistic_read' },
          });
        } else {
          const found = await manager.find(Shift, {
            where: {
              status: ShiftStatus.OPEN,
              isDeleted: false,
              cashbox_user_id: cashboxUserId,
            },
            order: { opened_at: 'DESC' },
            take: 1,
          });
          shift = found[0] ?? null;
          if (shift) {
            shift = await manager.findOne(Shift, {
              where: { id: String(shift.id) },
              lock: { mode: 'pessimistic_read' },
            });
          }
        }
        if (!shift || shiftCashboxUserId(shift) !== cashboxUserId) {
          throw new NotFoundException('Ochiq smena topilmadi');
        }
        if (shift.status !== ShiftStatus.OPEN) {
          throw new BadRequestException('Smena allaqachon yopilgan');
        }

        const settings = await this.loadSettings(manager);
        const aiEnabled = isAiEnabled(settings, card);
        const balances = await this.systemBalances(manager, cashbox);
        const expected = balances.get(String(card.id)) ?? null;

        await manager
          .createQueryBuilder()
          .insert()
          .into(ShiftAccountCheck)
          .values({ shift_id: String(shift.id), cashbox_card_id: cardId })
          .orIgnore()
          .execute();
        const row = await manager.findOne(ShiftAccountCheck, {
          where: { shift_id: String(shift.id), cashbox_card_id: cardId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!row) throw new Error('shift_account_checks qatori yaratilmadi');

        const previousKey = row.photo_file_key;
        const now = new Date();
        row.isDeleted = false;
        row.photo_file_key = photoKey;
        row.photo_uploaded_at = now;
        row.photo_uploaded_by = requesterId;
        row.expected_balance = expected;
        if (entered != null) row.entered_balance = entered;
        if (comment) row.comment = comment;
        row.difference =
          row.entered_balance != null && expected != null
            ? round2(Number(row.entered_balance) - expected)
            : null;
        row.photo_required_snap = isPhotoRequired(settings, card);
        row.ai_enabled_snap = aiEnabled;
        row.ai_read_balance = null;
        row.ai_last4_detected = null;
        row.ai_date_detected = null;
        row.ai_confidence = null;
        row.ai_entered_ok = null;
        row.ai_model = null;
        row.ai_checked_at = null;
        row.ai_raw = null;
        row.ai_request_id = aiEnabled ? randomUUID() : null;
        row.ai_status = aiEnabled
          ? ShiftAccountAiStatus.PENDING
          : ShiftAccountAiStatus.DISABLED;
        const saved = await manager.save(row);
        return { saved, shift, card, previousKey, aiEnabled };
      });

      await this.activityLog.log({
        entity_type: 'ShiftAccountCheck',
        entity_id: String(outcome.saved.id),
        action: 'finance.shift_account_photo_uploaded',
        new_value: {
          shift_id: String(outcome.shift.id),
          card_id: cardId,
          ai_status: outcome.saved.ai_status,
          entered_balance: outcome.saved.entered_balance,
          expected_balance: outcome.saved.expected_balance,
        },
        user_id: requesterId,
      });

      return successRes(
        {
          check: this.view(outcome.saved, outcome.card),
          shift_id: String(outcome.shift.id),
          ai_enabled: outcome.aiEnabled,
          ai_request_id: outcome.saved.ai_request_id,
          previous_photo_file_key:
            outcome.previousKey &&
            outcome.previousKey !== outcome.saved.photo_file_key
              ? outcome.previousKey
              : null,
        },
        201,
        'Shift account photo attached',
      );
    } catch (error) {
      toRpcError(error);
    }
  }

  // ───────────────────────── AI natijasi ─────────────────────────

  /**
   * AI natijasi (gateway fon vazifasidan). `ai_request_id` mos kelmasa (rasm
   * almashtirilgan) — e'tiborsiz. Smena yopilgan bo'lsa ham yoziladi
   * (natija hisobotga keyin tushadi). Realtime `finance.shift.account_checked`
   * shu tranzaksiyada (outbox).
   */
  async applyAiResult(input: {
    shift_id?: unknown;
    card_id?: unknown;
    ai_request_id?: unknown;
    result?: unknown;
  }) {
    try {
      const shiftId = assertId(input?.shift_id, 'shift_id');
      const cardId = assertId(input?.card_id, 'card_id');
      const requestId = scalarText(input?.ai_request_id);
      if (!requestId) throw new BadRequestException('ai_request_id majburiy');
      const result = (input?.result ?? { ok: false }) as AiCheckResult;

      const outcome = await this.dataSource.transaction(async (manager) => {
        const row = await manager.findOne(ShiftAccountCheck, {
          where: {
            shift_id: shiftId,
            cashbox_card_id: cardId,
            isDeleted: false,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!row || row.ai_request_id !== requestId) {
          return null;
        }
        const card = await manager.findOne(CashboxCard, {
          where: { id: cardId },
        });
        const shift = await manager.findOne(Shift, { where: { id: shiftId } });
        if (!shift) return null;

        const ok = result?.ok === true;
        const okResult = ok ? result : null;
        const readBalance =
          okResult &&
          Number.isFinite(Number(okResult.balance)) &&
          okResult.balance != null
            ? round2(Number(okResult.balance))
            : null;
        const last4 =
          okResult && /^\d{4}$/.test(String(okResult.last4 ?? ''))
            ? String(okResult.last4)
            : null;
        const confidence =
          okResult &&
          Number.isFinite(Number(okResult.confidence)) &&
          okResult.confidence != null
            ? Math.min(1, Math.max(0, Number(okResult.confidence)))
            : null;
        const date = okResult
          ? scalarText(okResult.date)
              .replace(/\d{9,}/g, '***')
              .slice(0, 40) || null
          : null;
        const reason = ok
          ? null
          : scalarText((result as { reason?: unknown })?.reason).slice(0, 40) ||
            'error';

        row.ai_read_balance = readBalance;
        row.ai_last4_detected = last4;
        row.ai_date_detected = date;
        row.ai_confidence = confidence;
        row.ai_model = okResult
          ? scalarText(okResult.model).slice(0, 80) || null
          : null;
        row.ai_checked_at = new Date();
        // ⚠️ PII'siz: faqat o'qilgan qiymatlar (to'liq karta raqami yo'q).
        row.ai_raw = ok
          ? { balance: readBalance, last4, date, confidence }
          : { reason };
        row.ai_status = deriveAiStatus({
          ok,
          reason,
          read_balance: readBalance,
          last4_detected: last4,
          confidence,
          expected_balance:
            row.expected_balance == null ? null : Number(row.expected_balance),
          card_last4: card?.last4 ?? null,
        });
        row.ai_entered_ok = deriveEnteredOk(row.entered_balance, readBalance);
        const saved = await manager.save(row);
        await this.realtime?.shiftAccountChecked(
          {
            shift,
            card_id: cardId,
            ai_status: saved.ai_status,
            checked_at: saved.ai_checked_at,
          },
          manager,
        );
        return { saved, card };
      });

      if (!outcome) {
        return successRes({ applied: false }, 200, 'Stale AI result ignored');
      }
      await this.activityLog.log({
        entity_type: 'ShiftAccountCheck',
        entity_id: String(outcome.saved.id),
        action: 'finance.shift_account_ai_checked',
        new_value: {
          shift_id: shiftId,
          card_id: cardId,
          ai_status: outcome.saved.ai_status,
          ai_entered_ok: outcome.saved.ai_entered_ok,
          ai_read_balance: outcome.saved.ai_read_balance,
          expected_balance: outcome.saved.expected_balance,
        },
        user_id: null,
      });
      return successRes(
        {
          applied: true,
          check: this.view(outcome.saved, outcome.card ?? undefined),
        },
        200,
        'AI result applied',
      );
    } catch (error) {
      toRpcError(error);
    }
  }

  // ───────────────────────── yopish ─────────────────────────

  /**
   * Yopishdan OLDIN (tranzaksiyasiz, smena qulfidan tashqarida): yaqinda
   * yuklangan rasmlarning AI natijasi `pending` bo'lsa — `maxMs` gacha
   * kutiladi. AI sekin / ishlamasa kassir bloklanmaydi.
   */
  async waitForPending(shiftId: string, maxMs?: number): Promise<number> {
    const rawWait = String(process.env.SHIFT_CLOSE_AI_WAIT_MS ?? '').trim();
    const envWait = rawWait === '' ? Number.NaN : Number(rawWait);
    const limit =
      maxMs ??
      (Number.isFinite(envWait) && envWait >= 0
        ? envWait
        : DEFAULT_CLOSE_WAIT_MS);
    const deadline = Date.now() + limit;
    for (;;) {
      const pending = await this.dataSource.manager
        .createQueryBuilder(ShiftAccountCheck, 'c')
        .where('c.shift_id = :shiftId', { shiftId })
        .andWhere('c.ai_status = :pending', {
          pending: ShiftAccountAiStatus.PENDING,
        })
        .andWhere('c.is_deleted = false')
        .andWhere('c.photo_uploaded_at > :fresh', {
          fresh: new Date(Date.now() - PENDING_STALE_MS),
        })
        .getCount();
      if (!pending || Date.now() >= deadline) return pending;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(CLOSE_WAIT_POLL_MS, deadline - Date.now()),
        ),
      );
    }
  }

  /**
   * `closeShift` tranzaksiyasi ICHIDA (smena qatori qulflangan): kartalar
   * qoldig'i snapshot'i, validatsiya (majburiy rasm → 400, farq / AI mos
   * emas → izoh majburiy) va qatorlarni yakunlash. Pul harakati YO'Q.
   */
  async confirmAtClose(
    manager: EntityManager,
    shift: Shift,
    rawAccounts: unknown,
    closedBy: string,
  ): Promise<Record<string, unknown> | null> {
    const settings = await this.loadSettings(manager);
    const accounts: CloseShiftAccountInput[] = Array.isArray(rawAccounts)
      ? (rawAccounts as CloseShiftAccountInput[])
      : [];
    if (rawAccounts != null && !Array.isArray(rawAccounts)) {
      throw new BadRequestException("accounts massiv bo'lishi kerak");
    }
    if (!settings.account_check_enabled && accounts.length === 0) {
      return null;
    }
    const cashbox = await this.findCashbox(manager, shiftCashboxUserId(shift));
    if (!cashbox) {
      if (accounts.length) {
        throw new BadRequestException('Smena kassasi topilmadi');
      }
      return null;
    }
    const cards = await this.activeCards(manager, String(cashbox.id));
    const cardsById = new Map(cards.map((card) => [String(card.id), card]));

    const entries = new Map<string, CloseShiftAccountInput>();
    accounts.forEach((account, index) => {
      const cardId = assertId(account?.card_id, `accounts[${index}].card_id`);
      if (!cardsById.has(cardId)) {
        throw new BadRequestException(
          `accounts[${index}]: karta bu smena kassasiga tegishli emas`,
        );
      }
      if (entries.has(cardId)) {
        throw new BadRequestException(`accounts[${index}]: karta takrorlangan`);
      }
      entries.set(cardId, account);
    });

    if (settings.account_check_enabled) {
      const missing = cards.filter((card) => !entries.has(String(card.id)));
      if (missing.length) {
        throw new BadRequestException(
          `Har karta qoldig'ini tasdiqlang: ${missing
            .map((card) => card.name)
            .join(', ')}`,
        );
      }
    }
    if (!entries.size) return null;

    const balances = await this.systemBalances(manager, cashbox);
    const existing = await manager.find(ShiftAccountCheck, {
      where: {
        shift_id: String(shift.id),
        cashbox_card_id: In([...entries.keys()]),
      },
      lock: { mode: 'pessimistic_write' },
    });
    const rowsByCard = new Map(
      existing.map((row) => [String(row.cashbox_card_id), row]),
    );
    const now = new Date();
    const results: ShiftAccountCheck[] = [];

    for (const [cardId, account] of entries) {
      const card = cardsById.get(cardId) as CashboxCard;
      const label = `«${card.name}»`;
      const entered = parseMoney(
        account.entered_balance,
        `${label} entered_balance`,
      );
      const row =
        rowsByCard.get(cardId) ??
        manager.create(ShiftAccountCheck, {
          shift_id: String(shift.id),
          cashbox_card_id: cardId,
          ai_status: ShiftAccountAiStatus.NOT_REQUIRED,
        });
      const givenKey = scalarText(account.photo_file_key);
      if (givenKey && givenKey !== (row.photo_file_key ?? '')) {
        throw new BadRequestException(
          `${label}: rasm /finance/shift/account-photo orqali yuklanadi`,
        );
      }
      const photoRequired = isPhotoRequired(settings, card);
      const hasPhoto = Boolean(row.photo_file_key);
      if (photoRequired && !hasPhoto) {
        throw new BadRequestException(
          `${label}: ${ACCOUNT_PHOTO_REQUIRED_MESSAGE}`,
        );
      }
      const expected = balances.get(cardId) ?? 0;
      row.isDeleted = false;
      row.expected_balance = expected;
      row.entered_balance = entered;
      row.difference = round2(entered - expected);
      const comment = scalarText(account.comment).slice(0, 1000);
      if (comment) row.comment = comment;
      row.photo_required_snap = photoRequired;
      row.ai_enabled_snap = isAiEnabled(settings, card) && hasPhoto;
      if (!hasPhoto) {
        row.ai_status = ShiftAccountAiStatus.NOT_REQUIRED;
      } else if (
        row.ai_status === ShiftAccountAiStatus.MATCH ||
        row.ai_status === ShiftAccountAiStatus.MISMATCH
      ) {
        // Yopish paytidagi YANGI snapshot bilan qayta solishtiriladi.
        row.ai_status = deriveAiStatus({
          ok: true,
          read_balance:
            row.ai_read_balance == null ? null : Number(row.ai_read_balance),
          last4_detected: row.ai_last4_detected,
          confidence:
            row.ai_confidence == null ? null : Number(row.ai_confidence),
          expected_balance: expected,
          card_last4: card.last4 ?? null,
        });
      }
      row.ai_entered_ok = deriveEnteredOk(entered, row.ai_read_balance);
      if (
        isCommentRequired({
          difference: row.difference,
          ai_status: row.ai_status,
          ai_entered_ok: row.ai_entered_ok,
        }) &&
        !scalarText(row.comment)
      ) {
        throw new BadRequestException(
          `${label}: ${ACCOUNT_COMMENT_REQUIRED_MESSAGE}`,
        );
      }
      row.confirmed_at = now;
      row.confirmed_by = closedBy;
      results.push(await manager.save(row));
    }

    return {
      ...summarizeStatuses(results),
      accounts: results.map((row) => ({
        card_id: String(row.cashbox_card_id),
        expected_balance: row.expected_balance,
        entered_balance: row.entered_balance,
        difference: row.difference,
        ai_status: row.ai_status,
        ai_entered_ok: row.ai_entered_ok,
      })),
    };
  }

  // ───────────────────────── hisobot ─────────────────────────

  /** Smena kartalari natijalari (hisobot uchun; kartaning tafsilotlari bilan). */
  async listForShift(shiftId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.dataSource.manager.find(ShiftAccountCheck, {
      where: { shift_id: shiftId, isDeleted: false },
      order: { cashbox_card_id: 'ASC' },
    });
    if (!rows.length) return [];
    const cards = await this.dataSource.manager.find(CashboxCard, {
      where: { id: In(rows.map((row) => String(row.cashbox_card_id))) },
    });
    const byId = new Map(cards.map((card) => [String(card.id), card]));
    return rows.map((row) =>
      this.view(row, byId.get(String(row.cashbox_card_id))),
    );
  }

  view(row: ShiftAccountCheck, card?: CashboxCard): Record<string, unknown> {
    return {
      id: String(row.id),
      shift_id: String(row.shift_id),
      card_id: String(row.cashbox_card_id),
      card: card
        ? {
            id: String(card.id),
            name: card.name,
            kind: card.kind ?? null,
            bank_name: card.bank_name ?? null,
            card_network: card.card_network ?? null,
            last4: card.last4 ?? null,
            is_default: card.is_default,
          }
        : null,
      expected_balance: row.expected_balance,
      entered_balance: row.entered_balance,
      difference: row.difference,
      photo_file_key: row.photo_file_key,
      photo_uploaded_at: row.photo_uploaded_at,
      ai_status: row.ai_status,
      ai_read_balance: row.ai_read_balance,
      ai_last4_detected: row.ai_last4_detected,
      ai_date_detected: row.ai_date_detected,
      ai_confidence: row.ai_confidence,
      ai_entered_ok: row.ai_entered_ok,
      ai_model: row.ai_model,
      ai_checked_at: row.ai_checked_at,
      ai_raw: row.ai_raw,
      comment: row.comment,
      comment_required: isCommentRequired({
        difference: row.difference,
        ai_status: row.ai_status,
        ai_entered_ok: row.ai_entered_ok,
      }),
      photo_required_snap: row.photo_required_snap,
      ai_enabled_snap: row.ai_enabled_snap,
      confirmed_at: row.confirmed_at,
      confirmed_by: row.confirmed_by == null ? null : String(row.confirmed_by),
    };
  }

  summarize(rows: Array<Record<string, unknown>>): Record<string, number> {
    return summarizeStatuses(
      rows.map((row) => ({
        ai_status: String(row.ai_status),
        ai_entered_ok:
          typeof row.ai_entered_ok === 'boolean' ? row.ai_entered_ok : null,
      })),
    );
  }
}
