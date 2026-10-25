import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  ActivityLogService,
  Cashbox_type,
  Operation_type,
  PaymentMethod,
} from '@app/common';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import {
  CardMovementType,
  CashboxCardMovement,
} from '../entities/cashbox-card-movement.entity';
import { Shift, ShiftStatus } from '../entities/shift.entity';
import {
  SHIFT_REQUIRED_MESSAGE,
  isShiftRequiredFor,
  shiftGateBlockedLogLine,
} from '../shift-gate';
import { FinanceRealtimeService } from '../realtime/finance-realtime.service';

/**
 * 3PE0B03q (UZOQ MUDDAT) — BeePost `cashbox_card` tizimining Elchi porti:
 * asosiy (MAIN) kassa ichidagi NOMLI kartalar, karta ledgeri, kartalararo
 * o'tkazma, karta↔naqd konvertatsiya va `Σ(kartalar) == balance_card`
 * moslik nazorati.
 *
 * "Asosiy karta" balansi HOSILA: `balance_card − Σ(nomli kartalar)` (entity
 * izohi). Hamma o'zgartiruvchi operatsiya avval MAIN kassa qatorini FOR
 * UPDATE bilan qulflaydi (kassaning boshqa pul harakatlari bilan bitta
 * navbat), keyin kartalarni id tartibida — deadlock yo'q.
 */
export const DEFAULT_CARD_NAME = 'Asosiy karta';
const MAIN_CASHBOX_USER_ID = '0';
const MAX_LEDGER_ROWS = 2000;

const round2 = (value: number) => Math.round(value * 100) / 100;

function conflict(message: string): never {
  throw new RpcException({ statusCode: 409, message });
}

function toRpcError(error: unknown): never {
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

function successRes(data: unknown, statusCode = 200, message = 'success') {
  return { statusCode, message, data };
}

/** Skalyar qiymat matni (obyekt / massiv — bo'sh satr: RMQ payload ishonchsiz). */
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
  if (!/^\d+$/.test(text)) {
    throw new BadRequestException(`${field} raqamli ID bo'lishi kerak`);
  }
  return text;
}

function assertAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestException("amount 0 dan katta bo'lishi kerak");
  }
  if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) {
    throw new BadRequestException("amount ko'pi bilan 2 xonali kasr");
  }
  return amount;
}

function normalizeName(value: unknown): string {
  const name = scalarText(value).replace(/\s+/g, ' ');
  if (!name) {
    throw new BadRequestException('Karta nomi majburiy');
  }
  if (name.length > 100) {
    throw new BadRequestException('Karta nomi 100 belgidan oshmasin');
  }
  return name;
}

function requireComment(value: unknown, what: string): string {
  const comment = scalarText(value);
  if (!comment) {
    throw new BadRequestException(`${what} uchun izoh (sabab) majburiy`);
  }
  return comment;
}

/** Kassaning nomli (Asosiy bo'lmagan) kartalari balansi yig'indisi. */
export async function sumNamedCardBalances(
  manager: EntityManager,
  cashboxId: string,
): Promise<number> {
  const raw = await manager
    .createQueryBuilder(CashboxCard, 'c')
    .select('COALESCE(SUM(c.balance), 0)', 'total')
    .where('c.cashbox_id = :cashboxId', { cashboxId: String(cashboxId) })
    .andWhere('c.is_default = false')
    .andWhere('c.is_deleted = false')
    .getRawOne<{ total: string | number | null }>();
  return round2(Number(raw?.total ?? 0));
}

/**
 * 3PE0B03q — MAIN kassadagi CLICK kirim/chiqimni tanlangan kartaga bog'lash.
 * Chaqiruvchi MAIN kassa qatorini ALLAQACHON qulflagan va `balance_card` ni
 * shu operatsiya bo'yicha O'ZGARTIRIB bo'lgan bo'lishi kerak (shu
 * tranzaksiyada).
 *
 *   • `card_id` yo'q — Asosiy karta (avvalgi xatti-harakat, `null`);
 *   • faqat MAIN kassa va `click` usuli (naqd / click_to_market — 400);
 *   • nomli karta: chiqimda kartada yetarli mablag' (aks holda 400), balans
 *     ± summa; Asosiy karta ANIQ tanlansa — chiqimdan keyingi hosila balans
 *     manfiy bo'lmasin.
 *
 * Qaytaradi: tarix qatoriga yoziladigan `card_id` (Asosiy karta — `null`).
 */
export async function applyMainCardSelection(
  manager: EntityManager,
  cashbox: Cashbox,
  input: {
    card_id?: string | null;
    operation: Operation_type;
    amount: number;
    payment_method: PaymentMethod;
  },
): Promise<string | null> {
  if (input.card_id === undefined || input.card_id === null) {
    return null;
  }
  const cardId = assertId(input.card_id, 'card_id');
  if (cashbox.cashbox_type !== Cashbox_type.MAIN) {
    throw new BadRequestException(
      'card_id faqat asosiy (MAIN) kassa operatsiyasida beriladi',
    );
  }
  if (input.payment_method !== PaymentMethod.CLICK) {
    throw new BadRequestException(
      "card_id faqat karta (click) to'lovida beriladi",
    );
  }
  const card = await manager.findOne(CashboxCard, {
    where: { id: cardId, cashbox_id: String(cashbox.id), isDeleted: false },
    lock: { mode: 'pessimistic_write' },
  });
  if (!card) {
    throw new NotFoundException('Karta topilmadi');
  }
  if (!card.is_active && !card.is_default) {
    throw new BadRequestException(
      `"${card.name}" kartasi arxivlangan — operatsiya uchun faol karta tanlang`,
    );
  }
  const amount = Number(input.amount);
  if (card.is_default) {
    if (input.operation === Operation_type.EXPENSE) {
      const named = await sumNamedCardBalances(manager, String(cashbox.id));
      const after = round2(Number(cashbox.balance_card) - named);
      if (after < 0) {
        throw new BadRequestException(
          `"${card.name}" kartasida yetarli mablag' yo'q! Mavjud: ${round2(
            after + amount,
          )} so'm, so'ralgan: ${amount} so'm`,
        );
      }
    }
    return null;
  }
  const sign = input.operation === Operation_type.INCOME ? 1 : -1;
  if (sign < 0 && Number(card.balance) < amount) {
    throw new BadRequestException(
      `"${card.name}" kartasida yetarli mablag' yo'q! Mavjud: ${Number(
        card.balance,
      )} so'm, so'ralgan: ${amount} so'm`,
    );
  }
  card.balance = round2(Number(card.balance) + sign * amount);
  await manager.save(CashboxCard, card);
  return String(card.id);
}

type CardView = {
  id: string;
  name: string;
  balance: number;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: Date;
};

type LedgerRow = {
  kind:
    | 'income'
    | 'expense'
    | 'transfer_in'
    | 'transfer_out'
    | 'cash_to_card'
    | 'card_to_cash';
  source: 'history' | 'movement';
  id: string;
  created_at: Date;
  amount: number;
  delta: number;
  balance_after: number;
  comment: string | null;
  created_by: string | null;
  counterparty_card_id: string | null;
  source_type?: string | null;
  payment_method?: string | null;
};

@Injectable()
export class CashboxCardService {
  private readonly logger = new Logger(CashboxCardService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly activityLog: ActivityLogService,
    // (rWdLuoP3) Karta o'zgarishi → realtime `finance.cashbox.card_changed`
    // (outbox, shu tranzaksiyada). Ixtiyoriy: eski spec'lar usiz quradi.
    @Optional() private readonly realtime?: FinanceRealtimeService,
  ) {}

  // ───────────────────────── yordamchilar ─────────────────────────

  private async lockMainCashbox(
    manager: EntityManager,
    mode: 'pessimistic_write' | 'pessimistic_read' = 'pessimistic_write',
  ): Promise<Cashbox> {
    const cashbox = await manager.findOne(Cashbox, {
      where: {
        user_id: MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
        isDeleted: false,
      },
      lock: { mode },
    });
    if (!cashbox) {
      throw new NotFoundException('Asosiy kassa topilmadi');
    }
    return cashbox;
  }

  /**
   * Asosiy karta qatori (bo'lmasa yaratiladi). MAIN kassa qulfi ostida
   * chaqiriladi; `ON CONFLICT DO NOTHING` — partial unique indeks bilan
   * ikkinchi himoya.
   */
  private async ensureDefaultCard(
    manager: EntityManager,
    cashboxId: string,
  ): Promise<CashboxCard> {
    const existing = await manager.findOne(CashboxCard, {
      where: { cashbox_id: cashboxId, is_default: true, isDeleted: false },
    });
    if (existing) {
      return existing;
    }
    await manager
      .createQueryBuilder()
      .insert()
      .into(CashboxCard)
      .values({
        cashbox_id: cashboxId,
        name: DEFAULT_CARD_NAME,
        balance: 0,
        is_default: true,
        is_active: true,
        sort_order: 0,
      })
      .orIgnore()
      .execute();
    const created = await manager.findOne(CashboxCard, {
      where: { cashbox_id: cashboxId, is_default: true, isDeleted: false },
    });
    if (!created) {
      throw new Error('Asosiy karta yaratilmadi');
    }
    return created;
  }

  private async defaultBalance(
    manager: EntityManager,
    cashbox: Cashbox,
  ): Promise<number> {
    const named = await sumNamedCardBalances(manager, String(cashbox.id));
    return round2(Number(cashbox.balance_card) - named);
  }

  private async lockCard(
    manager: EntityManager,
    cashboxId: string,
    cardId: string,
  ): Promise<CashboxCard> {
    const card = await manager.findOne(CashboxCard, {
      where: { id: cardId, cashbox_id: cashboxId, isDeleted: false },
      lock: { mode: 'pessimistic_write' },
    });
    if (!card) {
      throw new NotFoundException('Karta topilmadi');
    }
    return card;
  }

  private assertUsable(card: CashboxCard) {
    if (!card.is_active && !card.is_default) {
      throw new BadRequestException(
        `"${card.name}" kartasi arxivlangan — operatsiya uchun faol karta tanlang`,
      );
    }
  }

  private view(card: CashboxCard, balance?: number): CardView {
    return {
      id: String(card.id),
      name: card.name,
      balance: round2(balance ?? Number(card.balance)),
      is_default: card.is_default,
      is_active: card.is_active,
      sort_order: Number(card.sort_order ?? 0),
      created_at: card.createdAt,
    };
  }

  private async findDuplicateName(
    manager: EntityManager,
    cashboxId: string,
    name: string,
    exceptId?: string,
  ): Promise<boolean> {
    const qb = manager
      .createQueryBuilder(CashboxCard, 'c')
      .where('c.cashbox_id = :cashboxId', { cashboxId })
      .andWhere('c.is_deleted = false')
      .andWhere('lower(c.name) = lower(:name)', { name });
    if (exceptId) {
      qb.andWhere('c.id <> :exceptId', { exceptId });
    }
    return (await qb.getCount()) > 0;
  }

  /** Takroriy so'rov — shu kalit bilan yozilgan harakat (MAIN qulfi ostida). */
  private async findMovementByToken(
    manager: EntityManager,
    cashboxId: string,
    token: string,
  ): Promise<CashboxCardMovement | null> {
    if (!token) {
      return null;
    }
    return manager.findOne(CashboxCardMovement, {
      where: { cashbox_id: cashboxId, dedup_epoch: token },
    });
  }

  /**
   * (QTCUUgjA) BeePost'da kartalararo o'tkazma va konvertatsiya ham
   * `requireOpenShift()` ostida. Darvoza (`FINANCE_REQUIRE_OPEN_SHIFT`)
   * yoqilgan bo'lsa MAIN kassada ochiq smena shart; smena FOR SHARE —
   * `closeShift` jarayondagi harakatni kutadi.
   */
  private async requireMainShift(manager: EntityManager): Promise<void> {
    if (!isShiftRequiredFor(Cashbox_type.MAIN)) {
      return;
    }
    const shift = await manager.findOne(Shift, {
      where: {
        cashbox_user_id: MAIN_CASHBOX_USER_ID,
        status: ShiftStatus.OPEN,
        isDeleted: false,
      },
      lock: { mode: 'pessimistic_read' },
    });
    if (!shift) {
      // (32Sw3DfC) Kuzatuv — rad etilgan amallar soni (`shift_gate_blocked`).
      this.logger.warn(
        shiftGateBlockedLogLine('SHIFT_REQUIRED', {
          cashbox_type: Cashbox_type.MAIN,
          user_id: MAIN_CASHBOX_USER_ID,
        }),
      );
      throw new BadRequestException(SHIFT_REQUIRED_MESSAGE);
    }
  }

  private async withMainLock<T>(
    work: (manager: EntityManager, cashbox: Cashbox) => Promise<T>,
    mode: 'pessimistic_write' | 'pessimistic_read' = 'pessimistic_write',
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      const cashbox = await this.lockMainCashbox(manager, mode);
      return work(manager, cashbox);
    });
  }

  // ───────────────────────── o'qish ─────────────────────────

  /**
   * GET /finance/cashbox/cards — kartalar, har birining balansi, moslik
   * nazorati. `total_card` == `balance_card` (Asosiy karta hosila);
   * `in_sync = false` — nomli kartalar yig'indisi `balance_card` dan oshgan
   * (Asosiy karta manfiy: kartasiz CLICK chiqimi nomli kartadagi pulni
   * ishlatgan) — kartalararo o'tkazma bilan tuzatiladi.
   */
  async listCards(input?: { include_inactive?: boolean | string }) {
    try {
      const includeInactive =
        input?.include_inactive === true || input?.include_inactive === 'true';
      return await this.withMainLock(async (manager, cashbox) => {
        const def = await this.ensureDefaultCard(manager, String(cashbox.id));
        const cards = await manager.find(CashboxCard, {
          where: {
            cashbox_id: String(cashbox.id),
            isDeleted: false,
            ...(includeInactive ? {} : { is_active: true }),
          },
          order: { is_default: 'DESC', sort_order: 'ASC', id: 'ASC' },
        });
        const named = await sumNamedCardBalances(manager, String(cashbox.id));
        const defaultBalance = round2(Number(cashbox.balance_card) - named);
        const items = cards.map((card) =>
          card.is_default && String(card.id) === String(def.id)
            ? this.view(card, defaultBalance)
            : this.view(card),
        );
        return successRes(
          {
            cards: items,
            balance_card: round2(Number(cashbox.balance_card)),
            named_total: named,
            default_balance: defaultBalance,
            total_card: round2(named + defaultBalance),
            in_sync: defaultBalance >= 0,
          },
          200,
          'Cards',
        );
        // FOR SHARE: o'qish paytida balanslar o'zgarmaydi (izchil hosila),
        // lekin boshqa o'quvchilarni to'smaydi.
      }, 'pessimistic_read');
    } catch (error) {
      toRpcError(error);
    }
  }

  /** GET /finance/cashbox/cards/movements — ichki harakatlar (eng yangisi tepada). */
  async listMovements(input?: {
    card_id?: string;
    page?: number | string;
    limit?: number | string;
  }) {
    try {
      const page = Math.max(1, Math.floor(Number(input?.page) || 1));
      const limit = Math.min(
        100,
        Math.max(1, Math.floor(Number(input?.limit) || 20)),
      );
      const qb = this.dataSource.manager
        .createQueryBuilder(CashboxCardMovement, 'm')
        .where('m.is_deleted = false')
        .orderBy('m.createdAt', 'DESC')
        .addOrderBy('m.id', 'DESC')
        .skip((page - 1) * limit)
        .take(limit);
      if (input?.card_id) {
        const cardId = assertId(input.card_id, 'card_id');
        qb.andWhere('(m.from_card_id = :cardId OR m.to_card_id = :cardId)', {
          cardId,
        });
      }
      const [rows, total] = await qb.getManyAndCount();
      const cardIds = [
        ...new Set(
          rows
            .flatMap((r) => [r.from_card_id, r.to_card_id])
            .filter((id): id is string => !!id)
            .map(String),
        ),
      ];
      const cards = cardIds.length
        ? await this.dataSource.manager.find(CashboxCard, {
            where: { id: In(cardIds) },
          })
        : [];
      const nameOf = new Map(cards.map((c) => [String(c.id), c.name]));
      return successRes(
        {
          items: rows.map((r) => ({
            id: String(r.id),
            type: r.type,
            amount: Number(r.amount),
            from_card_id: r.from_card_id,
            from_card_name: r.from_card_id
              ? (nameOf.get(String(r.from_card_id)) ?? null)
              : null,
            to_card_id: r.to_card_id,
            to_card_name: r.to_card_id
              ? (nameOf.get(String(r.to_card_id)) ?? null)
              : null,
            balance_after_from: r.balance_after_from,
            balance_after_to: r.balance_after_to,
            comment: r.comment,
            created_by: r.created_by,
            created_at: r.createdAt,
          })),
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
        200,
        'Card movements',
      );
    } catch (error) {
      toRpcError(error);
    }
  }

  /**
   * GET /finance/cashbox/cards/:id/ledger — karta ko'chirmasi: CLICK
   * kirim/chiqimlar (`cashbox_history`) + ichki harakatlar
   * (`cashbox_card_movements`), har qatordan keyingi balans. Balans JORIY
   * qiymatdan ORQAGA hisoblanadi (Asosiy karta — hosila; migratsiyadan
   * oldingi kartasiz CLICK qatorlari ham Asosiy kartada).
   */
  async getLedger(input: {
    id: string;
    from_date?: string;
    to_date?: string;
    page?: number | string;
    limit?: number | string;
  }) {
    try {
      const cardId = assertId(input?.id, 'id');
      const from = input?.from_date ? new Date(input.from_date) : null;
      const to = input?.to_date ? new Date(input.to_date) : null;
      if (
        (from && Number.isNaN(from.getTime())) ||
        (to && Number.isNaN(to.getTime()))
      ) {
        throw new BadRequestException("from_date / to_date noto'g'ri");
      }
      const page = Math.max(1, Math.floor(Number(input?.page) || 1));
      const limit = Math.min(
        200,
        Math.max(1, Math.floor(Number(input?.limit) || 50)),
      );

      const manager = this.dataSource.manager;
      const cashbox = await manager.findOne(Cashbox, {
        where: {
          user_id: MAIN_CASHBOX_USER_ID,
          cashbox_type: Cashbox_type.MAIN,
          isDeleted: false,
        },
      });
      if (!cashbox) {
        throw new NotFoundException('Asosiy kassa topilmadi');
      }
      const card = await manager.findOne(CashboxCard, {
        where: { id: cardId, cashbox_id: String(cashbox.id), isDeleted: false },
      });
      if (!card) {
        throw new NotFoundException('Karta topilmadi');
      }
      const currentBalance = card.is_default
        ? await this.defaultBalance(manager, cashbox)
        : round2(Number(card.balance));

      const historyQb = manager
        .createQueryBuilder(CashboxHistory, 'h')
        .where('h.cashbox_id = :cashboxId', { cashboxId: String(cashbox.id) })
        .andWhere('h.is_deleted = false');
      if (card.is_default) {
        historyQb
          .andWhere('h.payment_method IN (:...methods)', {
            methods: [PaymentMethod.CLICK, PaymentMethod.CLICK_TO_MARKET],
          })
          .andWhere('(h.card_id IS NULL OR h.card_id = :cardId)', { cardId });
      } else {
        historyQb.andWhere('h.card_id = :cardId', { cardId });
      }
      const movementQb = manager
        .createQueryBuilder(CashboxCardMovement, 'm')
        .where('m.is_deleted = false')
        .andWhere('(m.from_card_id = :cardId OR m.to_card_id = :cardId)', {
          cardId,
        });
      if (from) {
        historyQb.andWhere('h.createdAt >= :from', { from });
        movementQb.andWhere('m.createdAt >= :from', { from });
      }
      const [histories, movements] = await Promise.all([
        historyQb
          .orderBy('h.createdAt', 'DESC')
          .take(MAX_LEDGER_ROWS + 1)
          .getMany(),
        movementQb
          .orderBy('m.createdAt', 'DESC')
          .take(MAX_LEDGER_ROWS + 1)
          .getMany(),
      ]);
      if (
        histories.length > MAX_LEDGER_ROWS ||
        movements.length > MAX_LEDGER_ROWS
      ) {
        throw new BadRequestException(
          `Oraliqda ${MAX_LEDGER_ROWS} dan ortiq yozuv — from_date bilan qisqartiring`,
        );
      }

      const rows: Omit<LedgerRow, 'balance_after'>[] = [];
      for (const h of histories) {
        const amount = Number(h.amount);
        const income = h.operation_type === Operation_type.INCOME;
        rows.push({
          kind: income ? 'income' : 'expense',
          source: 'history',
          id: String(h.id),
          created_at: h.createdAt,
          amount,
          delta: income ? amount : -amount,
          comment: h.comment ?? null,
          created_by: h.created_by ?? null,
          counterparty_card_id: null,
          source_type: h.source_type,
          payment_method: h.payment_method,
        });
      }
      for (const m of movements) {
        const amount = Number(m.amount);
        const outgoing = String(m.from_card_id ?? '') === cardId;
        let kind: LedgerRow['kind'];
        if (m.type === CardMovementType.CARD_TO_CARD) {
          kind = outgoing ? 'transfer_out' : 'transfer_in';
        } else if (m.type === CardMovementType.CARD_TO_CASH) {
          kind = 'card_to_cash';
        } else {
          kind = 'cash_to_card';
        }
        rows.push({
          kind,
          source: 'movement',
          id: String(m.id),
          created_at: m.createdAt,
          amount,
          delta: outgoing ? -amount : amount,
          comment: m.comment ?? null,
          created_by: m.created_by ?? null,
          counterparty_card_id: outgoing
            ? (m.to_card_id ?? null)
            : (m.from_card_id ?? null),
        });
      }
      rows.sort((a, b) => {
        const diff = b.created_at.getTime() - a.created_at.getTime();
        if (diff !== 0) return diff;
        return b.source === a.source
          ? Number(b.id) - Number(a.id)
          : a.source === 'movement'
            ? -1
            : 1;
      });

      // Joriy balansdan orqaga: eng yangi qatordan keyingi balans = joriy.
      let running = currentBalance;
      const withBalance: LedgerRow[] = rows.map((row) => {
        const after = round2(running);
        running = round2(running - row.delta);
        return { ...row, balance_after: after };
      });
      const inRange = to
        ? withBalance.filter((r) => r.created_at.getTime() <= to.getTime())
        : withBalance;
      const sum = (pred: (r: LedgerRow) => boolean) =>
        round2(inRange.filter(pred).reduce((s, r) => s + Math.abs(r.delta), 0));
      const closing = inRange.length ? inRange[0].balance_after : running;
      const opening = inRange.length
        ? round2(
            inRange[inRange.length - 1].balance_after -
              inRange[inRange.length - 1].delta,
          )
        : closing;

      return successRes(
        {
          card: this.view(card, currentBalance),
          items: inRange.slice((page - 1) * limit, page * limit),
          summary: {
            opening_balance: opening,
            closing_balance: closing,
            total_in: sum((r) => r.delta > 0),
            total_out: sum((r) => r.delta < 0),
            current_balance: currentBalance,
          },
          pagination: {
            total: inRange.length,
            page,
            limit,
            totalPages: Math.ceil(inRange.length / limit),
          },
        },
        200,
        'Card ledger',
      );
    } catch (error) {
      toRpcError(error);
    }
  }

  // ───────────────────────── o'zgartirish ─────────────────────────

  async createCard(input: {
    name: string;
    sort_order?: number;
    created_by?: string | null;
  }) {
    try {
      const name = normalizeName(input?.name);
      const sortOrder = Number.isInteger(Number(input?.sort_order))
        ? Number(input.sort_order)
        : 0;
      const card = await this.withMainLock(async (manager, cashbox) => {
        await this.ensureDefaultCard(manager, String(cashbox.id));
        if (await this.findDuplicateName(manager, String(cashbox.id), name)) {
          conflict(`"${name}" nomli karta allaqachon bor`);
        }
        const created = await manager.save(
          CashboxCard,
          manager.create(CashboxCard, {
            cashbox_id: String(cashbox.id),
            name,
            balance: 0,
            is_default: false,
            is_active: true,
            sort_order: sortOrder,
            created_by: input?.created_by ? String(input.created_by) : null,
          }),
        );
        await this.realtime?.cashboxCardChanged(
          { action: 'created', card_ids: [created.id] },
          manager,
        );
        return created;
      });
      await this.activityLog.log({
        entity_type: 'CashboxCard',
        entity_id: String(card.id),
        action: 'finance.card_created',
        new_value: { name: card.name },
        user_id: input?.created_by ? String(input.created_by) : null,
        description: `"${card.name}" kartasi yaratildi`,
      });
      return successRes({ card: this.view(card) }, 201, 'Karta yaratildi');
    } catch (error) {
      toRpcError(error);
    }
  }

  async renameCard(input: {
    id: string;
    name: string;
    updated_by?: string | null;
  }) {
    try {
      const cardId = assertId(input?.id, 'id');
      const name = normalizeName(input?.name);
      const outcome = await this.withMainLock(async (manager, cashbox) => {
        const card = await this.lockCard(manager, String(cashbox.id), cardId);
        if (card.is_default) {
          throw new BadRequestException(
            "Asosiy kartaning nomini o'zgartirib bo'lmaydi",
          );
        }
        if (
          await this.findDuplicateName(
            manager,
            String(cashbox.id),
            name,
            cardId,
          )
        ) {
          conflict(`"${name}" nomli karta allaqachon bor`);
        }
        const oldName = card.name;
        card.name = name;
        const renamed = await manager.save(CashboxCard, card);
        await this.realtime?.cashboxCardChanged(
          { action: 'renamed', card_ids: [cardId] },
          manager,
        );
        return { card: renamed, oldName };
      });
      await this.activityLog.log({
        entity_type: 'CashboxCard',
        entity_id: cardId,
        action: 'finance.card_renamed',
        old_value: { name: outcome.oldName },
        new_value: { name },
        user_id: input?.updated_by ? String(input.updated_by) : null,
        description: `Karta nomi: "${outcome.oldName}" → "${name}"`,
      });
      return successRes(
        { card: this.view(outcome.card) },
        200,
        "Karta nomi o'zgartirildi",
      );
    } catch (error) {
      toRpcError(error);
    }
  }

  async setCardActive(input: {
    id: string;
    is_active: boolean;
    updated_by?: string | null;
  }) {
    try {
      const cardId = assertId(input?.id, 'id');
      if (typeof input?.is_active !== 'boolean') {
        throw new BadRequestException("is_active true/false bo'lishi kerak");
      }
      const card = await this.withMainLock(async (manager, cashbox) => {
        const locked = await this.lockCard(manager, String(cashbox.id), cardId);
        if (locked.is_default) {
          throw new BadRequestException("Asosiy kartani arxivlab bo'lmaydi");
        }
        if (!input.is_active && round2(Number(locked.balance)) !== 0) {
          throw new BadRequestException(
            `Kartani arxivlashdan oldin balansini (${Number(
              locked.balance,
            )} so'm) boshqa kartaga yoki naqdga o'tkazing`,
          );
        }
        locked.is_active = input.is_active;
        const updated = await manager.save(CashboxCard, locked);
        await this.realtime?.cashboxCardChanged(
          {
            action: input.is_active ? 'activated' : 'archived',
            card_ids: [cardId],
          },
          manager,
        );
        return updated;
      });
      await this.activityLog.log({
        entity_type: 'CashboxCard',
        entity_id: cardId,
        action: input.is_active
          ? 'finance.card_activated'
          : 'finance.card_archived',
        new_value: { is_active: input.is_active },
        user_id: input?.updated_by ? String(input.updated_by) : null,
        description: `"${card.name}" kartasi ${
          input.is_active ? 'faollashtirildi' : 'arxivlandi'
        }`,
      });
      return successRes(
        { card: this.view(card) },
        200,
        input.is_active ? 'Karta faollashtirildi' : 'Karta arxivlandi',
      );
    } catch (error) {
      toRpcError(error);
    }
  }

  /**
   * POST /finance/cashbox/cards/transfer — kartadan kartaga. `balance_card`
   * va kassaning umumiy balansi O'ZGARMAYDI (faqat ajratma). Manba kartada
   * yetarli mablag' bo'lmasa 400. Idempotent (`dedup_epoch`).
   */
  async transfer(input: {
    from_card_id: string;
    to_card_id: string;
    amount: number;
    comment: string;
    created_by?: string | null;
    dedup_epoch?: string | null;
  }) {
    try {
      const fromId = assertId(input?.from_card_id, 'from_card_id');
      const toId = assertId(input?.to_card_id, 'to_card_id');
      if (fromId === toId) {
        throw new BadRequestException(
          "Manba va maqsad karta bir xil bo'lmasligi kerak",
        );
      }
      const amount = assertAmount(input?.amount);
      const comment = requireComment(input?.comment, "O'tkazma");
      const token = String(input?.dedup_epoch ?? '').trim();

      const outcome = await this.withMainLock(async (manager, cashbox) => {
        const cashboxId = String(cashbox.id);
        const replay = await this.findMovementByToken(
          manager,
          cashboxId,
          token,
        );
        if (replay) {
          return { movement: replay, idempotent: true, names: null };
        }
        await this.requireMainShift(manager);
        const [first, second] = [fromId, toId].sort(
          (a, b) => Number(a) - Number(b),
        );
        const lockedFirst = await this.lockCard(manager, cashboxId, first);
        const lockedSecond = await this.lockCard(manager, cashboxId, second);
        const from = first === fromId ? lockedFirst : lockedSecond;
        const to = first === fromId ? lockedSecond : lockedFirst;
        this.assertUsable(from);
        this.assertUsable(to);

        const defaultBefore = await this.defaultBalance(manager, cashbox);
        const fromBalance = from.is_default
          ? defaultBefore
          : round2(Number(from.balance));
        if (fromBalance < amount) {
          throw new BadRequestException(
            `"${from.name}" kartasida yetarli mablag' yo'q! Mavjud: ${fromBalance} so'm, so'ralgan: ${amount} so'm`,
          );
        }
        if (!from.is_default) {
          from.balance = round2(Number(from.balance) - amount);
          await manager.save(CashboxCard, from);
        }
        if (!to.is_default) {
          to.balance = round2(Number(to.balance) + amount);
          await manager.save(CashboxCard, to);
        }
        const defaultAfter = await this.defaultBalance(manager, cashbox);
        const movement = await manager.save(
          CashboxCardMovement,
          manager.create(CashboxCardMovement, {
            type: CardMovementType.CARD_TO_CARD,
            cashbox_id: cashboxId,
            from_card_id: fromId,
            to_card_id: toId,
            amount,
            balance_after_from: from.is_default
              ? defaultAfter
              : Number(from.balance),
            balance_after_to: to.is_default ? defaultAfter : Number(to.balance),
            comment,
            created_by: input?.created_by ? String(input.created_by) : null,
            dedup_epoch: token || null,
          }),
        );
        await this.realtime?.cashboxCardChanged(
          {
            action: 'transfer',
            card_ids: [fromId, toId],
            movement_id: movement.id,
          },
          manager,
        );
        return {
          movement,
          idempotent: false,
          names: { from: from.name, to: to.name },
        };
      });

      if (!outcome.idempotent && outcome.names) {
        await this.activityLog.log({
          entity_type: 'CashboxCard',
          entity_id: fromId,
          action: 'finance.card_transfer',
          new_value: { amount, from: fromId, to: toId },
          user_id: input?.created_by ? String(input.created_by) : null,
          description: `Kartalararo o'tkazma: "${outcome.names.from}" → "${outcome.names.to}" — ${amount} so'm`,
        });
      }
      return successRes(
        { movement: outcome.movement, idempotent: outcome.idempotent },
        outcome.idempotent ? 200 : 201,
        outcome.idempotent
          ? "O'tkazma allaqachon bajarilgan (takroriy so'rov)"
          : "Kartalararo o'tkazma bajarildi",
      );
    } catch (error) {
      toRpcError(error);
    }
  }

  /**
   * POST /finance/cashbox/cards/convert — karta↔naqd. Kassaning umumiy
   * `balance` i O'ZGARMAYDI; `balance_cash` / `balance_card` ajratmasi va
   * tanlangan karta balansi o'zgaradi. `cashbox_history` ga yozilmaydi
   * (kirim/chiqim emas); smena yopishda kutilgan qoldiqqa qo'shiladi.
   */
  async convert(input: {
    type: CardMovementType;
    card_id: string;
    amount: number;
    comment: string;
    created_by?: string | null;
    dedup_epoch?: string | null;
  }) {
    try {
      const type = input?.type;
      if (
        type !== CardMovementType.CARD_TO_CASH &&
        type !== CardMovementType.CASH_TO_CARD
      ) {
        throw new BadRequestException(
          "type faqat 'card_to_cash' yoki 'cash_to_card'",
        );
      }
      const cardId = assertId(input?.card_id, 'card_id');
      const amount = assertAmount(input?.amount);
      const comment = requireComment(input?.comment, 'Konvertatsiya');
      const token = String(input?.dedup_epoch ?? '').trim();
      const toCash = type === CardMovementType.CARD_TO_CASH;

      const outcome = await this.withMainLock(async (manager, cashbox) => {
        const cashboxId = String(cashbox.id);
        const replay = await this.findMovementByToken(
          manager,
          cashboxId,
          token,
        );
        if (replay) {
          return { movement: replay, idempotent: true, cardName: null };
        }
        await this.requireMainShift(manager);
        const card = await this.lockCard(manager, cashboxId, cardId);
        this.assertUsable(card);

        if (toCash) {
          const available = card.is_default
            ? await this.defaultBalance(manager, cashbox)
            : round2(Number(card.balance));
          if (available < amount) {
            throw new BadRequestException(
              `"${card.name}" kartasida yetarli mablag' yo'q! Mavjud: ${available} so'm, so'ralgan: ${amount} so'm`,
            );
          }
          cashbox.balance_card = round2(Number(cashbox.balance_card) - amount);
          cashbox.balance_cash = round2(Number(cashbox.balance_cash) + amount);
          if (!card.is_default) {
            card.balance = round2(Number(card.balance) - amount);
          }
        } else {
          if (round2(Number(cashbox.balance_cash)) < amount) {
            throw new BadRequestException(
              `Kassada naqd yetarli emas! Mavjud: ${Number(
                cashbox.balance_cash,
              )} so'm, so'ralgan: ${amount} so'm`,
            );
          }
          cashbox.balance_cash = round2(Number(cashbox.balance_cash) - amount);
          cashbox.balance_card = round2(Number(cashbox.balance_card) + amount);
          if (!card.is_default) {
            card.balance = round2(Number(card.balance) + amount);
          }
        }
        // Umumiy balans o'zgarmaydi — faqat ajratma.
        await manager.save(Cashbox, cashbox);
        if (!card.is_default) {
          await manager.save(CashboxCard, card);
        }
        const after = card.is_default
          ? await this.defaultBalance(manager, cashbox)
          : Number(card.balance);
        const movement = await manager.save(
          CashboxCardMovement,
          manager.create(CashboxCardMovement, {
            type,
            cashbox_id: cashboxId,
            from_card_id: toCash ? cardId : null,
            to_card_id: toCash ? null : cardId,
            amount,
            balance_after_from: toCash ? after : null,
            balance_after_to: toCash ? null : after,
            comment,
            created_by: input?.created_by ? String(input.created_by) : null,
            dedup_epoch: token || null,
          }),
        );
        await this.realtime?.cashboxCardChanged(
          {
            action: toCash ? 'card_to_cash' : 'cash_to_card',
            card_ids: [cardId],
            movement_id: movement.id,
          },
          manager,
        );
        return { movement, idempotent: false, cardName: card.name };
      });

      if (!outcome.idempotent && outcome.cardName) {
        await this.activityLog.log({
          entity_type: 'CashboxCard',
          entity_id: cardId,
          action: 'finance.card_convert',
          new_value: { type, amount },
          user_id: input?.created_by ? String(input.created_by) : null,
          description: toCash
            ? `"${outcome.cardName}" kartasidan naqdga: ${amount} so'm`
            : `Naqddan "${outcome.cardName}" kartasiga: ${amount} so'm`,
        });
      }
      return successRes(
        { movement: outcome.movement, idempotent: outcome.idempotent },
        outcome.idempotent ? 200 : 201,
        outcome.idempotent
          ? "Konvertatsiya allaqachon bajarilgan (takroriy so'rov)"
          : 'Konvertatsiya bajarildi',
      );
    } catch (error) {
      toRpcError(error);
    }
  }
}
