import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Brackets, DataSource, QueryFailedError } from 'typeorm';
import {
  ActivityDescribeUz,
  ActivityLogService,
  TASHKENT_OFFSET_MINUTES,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { OperatorEarning } from '../entities/operator-earning.entity';
import { OperatorPayment } from '../entities/operator-payment.entity';

/** `finance.operator.market_payment.record` kirishi (gateway'dan, ishonchsiz). */
export interface OperatorPaymentRecordInput {
  /** Market — FAQAT gateway JWT'dan (`sub`), tanadan emas. */
  market_id?: unknown;
  operator_id?: unknown;
  amount?: unknown;
  /** `YYYY-MM-DD` (Toshkent kuni). Berilmasa — bugun. */
  paid_at?: unknown;
  note?: unknown;
  recorded_by_id?: unknown;
  recorded_by_role?: unknown;
  idempotency_key?: unknown;
}

export interface OperatorPaymentCancelInput {
  market_id?: unknown;
  payment_id?: unknown;
  reason?: unknown;
  cancelled_by_id?: unknown;
  cancelled_by_role?: unknown;
}

export interface OperatorPaymentListInput {
  market_id?: unknown;
  /** Marketning (o'chirilmagan) operatorlari — gateway identity'dan oladi. */
  operator_ids?: unknown;
  operator_id?: unknown;
  page?: unknown;
  limit?: unknown;
}

export interface OperatorBalancesInput {
  operator_ids?: unknown;
}

const ID_RE = /^[1-9]\d{0,18}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `numeric(14,2)` chegarasi. */
export const OPERATOR_PAYMENT_AMOUNT_MAX = 999_999_999_999.99;
export const OPERATOR_PAYMENT_NOTE_MAX = 500;
export const OPERATOR_PAYMENT_REASON_MIN = 3;
export const OPERATOR_PAYMENT_REASON_MAX = 500;
/** Juda eski sana — xato kiritish (yil adashgan); tizim 2026 da ishga tushgan. */
const PAID_AT_MIN = '2020-01-01';
const ROLE_MAX = 32;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_OPERATOR_IDS = 1000;

const reject = (statusCode: number, message: string): never => {
  throw new RpcException({ statusCode, message });
};

const toCents = (value: number) => Math.round(value * 100);
const fromCents = (cents: number) => cents / 100;

/** Toshkent bugungi sanasi `YYYY-MM-DD` (server TZ'iga bog'liq emas). */
export const tashkentToday = (now: Date = new Date()): string =>
  new Date(now.getTime() + TASHKENT_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 10);

/**
 * F2qp6FtE (ega qarori 2026-11-16) — market o'z operatoriga O'ZI, istagan
 * vaqtida to'laydi. Elchi Asosiy kassasi bunga TEGMAYDI: tizim faqat ma'lumot
 * saqlaydi — operator qancha ishlab topgani va qanchasi to'lab berilgani.
 *
 * ⚠️ Bu servis kassa, kassa tarixi, P&L daftari, xarajat yoki smenaga hech
 * narsa yozmaydi (importi ham yo'q). Yozuv `source = 'market'`,
 * `affects_cashbox = false` — DB CHECK buni kafolatlaydi.
 *
 * Ko'lam gateway'da: market — JWT `sub`, operator — o'sha marketning
 * operatori (identity `market_operator.find_by_market`). Bu yerda yana
 * tekshiriladi: bekor qilish faqat o'z marketi yozgan qatorda.
 */
@Injectable()
export class OperatorPaymentService {
  private readonly logger = new Logger(OperatorPaymentService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly activityLog: ActivityLogService,
  ) {}

  // ---------------------------------------------------------------- parsers

  private parseId(value: unknown, field: string): string {
    const id = typeof value === 'number' ? String(value) : value;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      reject(400, `${field} noto'g'ri`);
    }
    return id as string;
  }

  private parseIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const ids = Array.from(
      new Set(
        value
          .map((id) => (typeof id === 'number' ? String(id) : id))
          .filter(
            (id): id is string => typeof id === 'string' && ID_RE.test(id),
          ),
      ),
    );
    if (ids.length > MAX_OPERATOR_IDS) {
      reject(400, `operator_ids ${MAX_OPERATOR_IDS} tadan oshmasligi kerak`);
    }
    return ids;
  }

  private parseAmount(value: unknown): number {
    const amount = typeof value === 'string' ? Number(value) : value;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      reject(400, "Summa 0 dan katta bo'lishi kerak");
    }
    const num = amount as number;
    // `num * 100` ning float xatosi ~1e9 dan yuqorida to'g'ri 2 kasrli summani ham rad etardi (review):
    // 2 kasrgacha yaxlitlangan qiymat aynan o'zi bo'lsa — kasr ko'pi bilan 2 ta.
    if (Number(num.toFixed(2)) !== num) {
      reject(400, "Summada ko'pi bilan 2 ta kasr xona bo'lishi mumkin");
    }
    if (num > OPERATOR_PAYMENT_AMOUNT_MAX) {
      reject(400, 'Summa juda katta');
    }
    return fromCents(toCents(num));
  }

  /** `YYYY-MM-DD`, haqiqiy sana, kelajakda emas (Toshkent kuni). */
  private parsePaidAt(value: unknown): { paidAt: string; explicit: boolean } {
    const today = tashkentToday();
    if (value === undefined || value === null || value === '') {
      return { paidAt: today, explicit: false };
    }
    const match = typeof value === 'string' ? DATE_RE.exec(value.trim()) : null;
    if (!match) {
      reject(400, "To'lov sanasi YYYY-MM-DD shaklida bo'lishi kerak");
    }
    const [, y, m, d] = match as RegExpExecArray;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    const iso = `${y}-${m}-${d}`;
    if (date.toISOString().slice(0, 10) !== iso) {
      reject(400, "To'lov sanasi noto'g'ri");
    }
    if (iso > today) {
      reject(400, "To'lov sanasi kelajakda bo'lishi mumkin emas");
    }
    if (iso < PAID_AT_MIN) {
      reject(400, "To'lov sanasi juda eski");
    }
    return { paidAt: iso, explicit: true };
  }

  private parseText(
    value: unknown,
    field: string,
    { min = 0, max }: { min?: number; max: number },
  ): string | null {
    if (value === undefined || value === null) {
      if (min > 0) reject(400, `${field} majburiy`);
      return null;
    }
    if (typeof value !== 'string') {
      reject(400, `${field} matn bo'lishi kerak`);
    }
    const text = (value as string).trim();
    if (text.length < min) {
      reject(
        400,
        min > 0 && text.length === 0
          ? `${field} majburiy`
          : `${field} kamida ${min} belgi bo'lishi kerak`,
      );
    }
    if (text.length > max) {
      reject(400, `${field} ${max} belgidan oshmasligi kerak`);
    }
    return text.length ? text : null;
  }

  private parseKey(value: unknown): string {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!key || key.length > 255) {
      reject(400, "Idempotency-Key 1-255 belgi bo'lishi kerak");
    }
    return key;
  }

  private parseRole(value: unknown): string {
    const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return role ? role.slice(0, ROLE_MAX) : 'market';
  }

  // ------------------------------------------------------------------ views

  /**
   * Market va operatorga ko'rinish. `idempotency_key`, yozgan va bekor qilgan
   * xodimning id'si qaytmaydi (eski yozuvda — Elchi xodimi).
   */
  view(row: OperatorPayment, marketId?: string | null) {
    const cancelled = Boolean(row.cancelled_at);
    const source = row.source ?? 'elchi';
    return {
      id: String(row.id),
      operator_id: String(row.operator_id),
      market_id: row.market_id == null ? null : String(row.market_id),
      amount: Number(row.amount),
      paid_at: row.paid_at,
      note: row.note ?? null,
      source,
      affects_cashbox: Boolean(row.affects_cashbox),
      recorded_by_role: row.recorded_by_role ?? null,
      created_at: row.createdAt,
      status: cancelled ? ('cancelled' as const) : ('active' as const),
      cancelled_at: row.cancelled_at ?? null,
      cancelled_by_role: row.cancelled_by_role ?? null,
      cancel_reason: row.cancel_reason ?? null,
      can_cancel:
        marketId != null &&
        source === 'market' &&
        !cancelled &&
        String(row.market_id) === String(marketId),
    };
  }

  // ----------------------------------------------------------------- record

  /**
   * Market o'z operatoriga to'lovni yozadi. Ayni `Idempotency-Key` bilan
   * takror (timeout'dan keyin qayta yuborish, RMQ qayta yetkazishi) — o'sha
   * yozuv (`idempotent: true`, 200); ayni kalit boshqa to'lov bilan — 409.
   * Qoldiqdan oshsa ham yoziladi (avans) — «Qoldiq» manfiy bo'ladi.
   */
  async record(input: OperatorPaymentRecordInput) {
    const marketId = this.parseId(input?.market_id, 'market_id');
    const operatorId = this.parseId(input?.operator_id, 'operator_id');
    const recordedBy = this.parseId(input?.recorded_by_id, 'recorded_by_id');
    const role = this.parseRole(input?.recorded_by_role);
    const amount = this.parseAmount(input?.amount);
    const { paidAt, explicit } = this.parsePaidAt(input?.paid_at);
    const note = this.parseText(input?.note, 'Izoh', {
      max: OPERATOR_PAYMENT_NOTE_MAX,
    });
    const key = this.parseKey(input?.idempotency_key);
    const repo = this.dataSource.getRepository(OperatorPayment);

    const replay = (existing: OperatorPayment) => {
      if (
        String(existing.operator_id) !== operatorId ||
        toCents(Number(existing.amount)) !== toCents(amount) ||
        (explicit && existing.paid_at !== paidAt)
      ) {
        reject(
          409,
          "Idempotency-Key boshqa to'lov uchun allaqachon ishlatilgan",
        );
      }
      return successRes(
        { ...this.view(existing, marketId), idempotent: true },
        200,
        "To'lov allaqachon yozilgan (takroriy so'rov)",
      );
    };

    try {
      const existing = await repo.findOne({
        where: { market_id: marketId, idempotency_key: key },
      });
      if (existing) return replay(existing);

      let saved: OperatorPayment;
      try {
        saved = await repo.save(
          repo.create({
            operator_id: operatorId,
            market_id: marketId,
            paid_by_id: recordedBy,
            recorded_by_role: role,
            amount,
            paid_at: paidAt,
            note,
            source: 'market',
            affects_cashbox: false,
            idempotency_key: key,
          }),
        );
      } catch (error) {
        // Ayni kalitli parallel so'rov oldin yozib bo'ldi — UNIQUE ushladi.
        if (this.isUniqueViolation(error)) {
          const winner = await repo.findOne({
            where: { market_id: marketId, idempotency_key: key },
          });
          if (winner) return replay(winner);
        }
        throw error;
      }

      await this.activityLog
        .log({
          entity_type: 'OperatorPayment',
          entity_id: String(saved.id),
          action: 'finance.operator_payment_recorded',
          new_value: {
            operator_id: operatorId,
            market_id: marketId,
            amount,
            paid_at: paidAt,
            affects_cashbox: false,
          },
          user_id: recordedBy,
          user_role: role,
          metadata: { source: 'market' },
          description: ActivityDescribeUz.operatorPaymentRecorded(
            operatorId,
            amount,
          ),
        })
        .catch((error: unknown) =>
          this.logger.warn(
            `operator payment audit: ${(error as Error)?.message ?? error}`,
          ),
        );

      return successRes(
        { ...this.view(saved, marketId), idempotent: false },
        201,
        "To'lov yozildi",
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  // ----------------------------------------------------------------- cancel

  /**
   * Xato yozuvni bekor qilish (sabab majburiy). Qator qoladi, «To'landi» ga
   * kirmaydi. Faqat o'z marketi yozgan (`source = 'market'`) qator; begona yoki
   * yo'q — 404, eski Elchi yozuvi — 409. Takroriy bekor — 200
   * (`idempotent: true`), jurnalga ikkinchi marta yozilmaydi.
   */
  async cancel(input: OperatorPaymentCancelInput) {
    const marketId = this.parseId(input?.market_id, 'market_id');
    const paymentId = this.parseId(input?.payment_id, 'payment_id');
    const cancelledBy = this.parseId(input?.cancelled_by_id, 'cancelled_by_id');
    const role = this.parseRole(input?.cancelled_by_role);
    const reason = this.parseText(input?.reason, 'Sabab', {
      min: OPERATOR_PAYMENT_REASON_MIN,
      max: OPERATOR_PAYMENT_REASON_MAX,
    }) as string;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    let row!: OperatorPayment;
    try {
      const tx = queryRunner.manager;
      const found = await tx.findOne(OperatorPayment, {
        where: { id: paymentId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!found || String(found.market_id) !== marketId) {
        reject(404, "To'lov topilmadi");
      }
      row = found as OperatorPayment;
      if (row.source !== 'market') {
        reject(
          409,
          "Bu to'lov Elchi tomonidan (Asosiy kassadan) yozilgan — uni bekor qilib bo'lmaydi",
        );
      }
      if (row.cancelled_at) {
        await queryRunner.commitTransaction();
        return successRes(
          { ...this.view(row, marketId), idempotent: true },
          200,
          "To'lov allaqachon bekor qilingan",
        );
      }
      row.cancelled_at = new Date();
      row.cancelled_by_id = cancelledBy;
      row.cancelled_by_role = role;
      row.cancel_reason = reason;
      row = await tx.save(row);
      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      this.rethrow(error);
    } finally {
      await queryRunner.release();
    }

    await this.activityLog
      .log({
        entity_type: 'OperatorPayment',
        entity_id: String(row.id),
        action: 'finance.operator_payment_cancelled',
        old_value: { status: 'active' },
        new_value: {
          status: 'cancelled',
          operator_id: String(row.operator_id),
          amount: Number(row.amount),
          paid_at: row.paid_at,
        },
        user_id: cancelledBy,
        user_role: role,
        metadata: { reason },
        description: ActivityDescribeUz.operatorPaymentCancelled(
          row.operator_id,
          row.amount,
        ),
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `operator payment cancel audit: ${(error as Error)?.message ?? error}`,
        ),
      );

    return successRes(
      { ...this.view(row, marketId), idempotent: false },
      200,
      "To'lov bekor qilindi",
    );
  }

  // ------------------------------------------------------------------- list

  /**
   * Marketning to'lovlar tarixi (yangisi tepada — to'lov sanasi, keyin id).
   * Ko'lam: shu market yozganlari + marketning operatorlariga Elchi eski
   * yo'lda (market_id siz) yozganlari. Bekor qilinganlar ham chiqadi
   * (`status: 'cancelled'`).
   */
  async list(input: OperatorPaymentListInput) {
    try {
      const marketId = this.parseId(input?.market_id, 'market_id');
      const operatorIds = this.parseIds(input?.operator_ids);
      const operatorId =
        input?.operator_id != null && input.operator_id !== ''
          ? this.parseId(input.operator_id, 'operator_id')
          : null;
      const page = Math.max(Math.floor(Number(input?.page)) || 1, 1);
      const limit = Math.min(
        Math.max(Math.floor(Number(input?.limit)) || DEFAULT_LIMIT, 1),
        MAX_LIMIT,
      );

      const qb = this.dataSource
        .getRepository(OperatorPayment)
        .createQueryBuilder('p')
        .where('p.is_deleted = false')
        .andWhere(
          new Brackets((scope) => {
            scope.where('p.market_id = :marketId', { marketId });
            if (operatorIds.length) {
              scope.orWhere(
                'p.market_id IS NULL AND p.operator_id IN (:...operatorIds)',
                { operatorIds },
              );
            }
          }),
        );
      if (operatorId) {
        qb.andWhere('p.operator_id = :operatorId', { operatorId });
      }
      const [rows, total] = await qb
        .orderBy('p.paid_at', 'DESC')
        .addOrderBy('p.id', 'DESC')
        .skip((page - 1) * limit)
        .take(limit)
        .getManyAndCount();

      return successRes(
        {
          items: rows.map((row) => this.view(row, marketId)),
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.max(1, Math.ceil(total / limit)),
          },
        },
        200,
        "Operatorlarga to'lovlar",
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  // --------------------------------------------------------------- balances

  /**
   * Har operator uchun «Ishlab topdi» (o'chirilmagan daromadlar — `/me/balance`
   * bilan AYNI qoida), «To'landi» (o'chirilmagan va bekor qilinmagan to'lovlar,
   * eski Elchi to'lovlari ham) va «Qoldiq» = ishlab topdi − to'landi (manfiy
   * bo'lishi mumkin — ortiqcha to'langan). So'ralgan har id qaytadi (yozuvsiz —
   * 0).
   */
  async balances(input: OperatorBalancesInput) {
    try {
      const operatorIds = this.parseIds(input?.operator_ids);
      if (!operatorIds.length) {
        return successRes(
          { items: [], totals: { earned: 0, paid: 0, balance: 0 } },
          200,
          'Operatorlar hisobi',
        );
      }
      const [earnedRows, paidRows] = await Promise.all([
        this.dataSource
          .getRepository(OperatorEarning)
          .createQueryBuilder('e')
          .select('e.operator_id::text', 'operator_id')
          .addSelect('COALESCE(SUM(e.amount), 0)', 'total')
          .where('e.is_deleted = false')
          .andWhere('e.operator_id IN (:...operatorIds)', { operatorIds })
          .groupBy('e.operator_id')
          .getRawMany<{ operator_id: string; total: string }>(),
        this.dataSource
          .getRepository(OperatorPayment)
          .createQueryBuilder('p')
          .select('p.operator_id::text', 'operator_id')
          .addSelect('COALESCE(SUM(p.amount), 0)', 'total')
          .addSelect('COUNT(*)', 'count')
          .addSelect("to_char(MAX(p.paid_at), 'YYYY-MM-DD')", 'last_paid_at')
          .where('p.is_deleted = false')
          .andWhere('p.cancelled_at IS NULL')
          .andWhere('p.operator_id IN (:...operatorIds)', { operatorIds })
          .groupBy('p.operator_id')
          .getRawMany<{
            operator_id: string;
            total: string;
            count: string;
            last_paid_at: string | null;
          }>(),
      ]);

      const earnedBy = new Map(
        earnedRows.map((row) => [row.operator_id, toCents(Number(row.total))]),
      );
      const paidBy = new Map(paidRows.map((row) => [row.operator_id, row]));
      let earnedTotal = 0;
      let paidTotal = 0;
      const items = operatorIds.map((id) => {
        const earned = earnedBy.get(id) ?? 0;
        const paidRow = paidBy.get(id);
        const paid = paidRow ? toCents(Number(paidRow.total)) : 0;
        earnedTotal += earned;
        paidTotal += paid;
        return {
          operator_id: id,
          earned: fromCents(earned),
          paid: fromCents(paid),
          balance: fromCents(earned - paid),
          payments_count: paidRow ? Number(paidRow.count) : 0,
          last_paid_at: paidRow?.last_paid_at ?? null,
        };
      });
      return successRes(
        {
          items,
          totals: {
            earned: fromCents(earnedTotal),
            paid: fromCents(paidTotal),
            balance: fromCents(earnedTotal - paidTotal),
          },
        },
        200,
        'Operatorlar hisobi',
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  // ------------------------------------------------------------------ utils

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      ((error.driverError as { code?: string } | undefined)?.code === '23505' ||
        (error as QueryFailedError & { code?: string }).code === '23505')
    );
  }

  private rethrow(error: unknown): never {
    if (error instanceof RpcException) {
      throw error;
    }
    if (this.isUniqueViolation(error)) {
      throw new RpcException({
        statusCode: 409,
        message: "Idempotency-Key boshqa to'lov uchun allaqachon ishlatilgan",
      });
    }
    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
