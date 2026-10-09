import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FinanceSettlementUnapplied } from '../entities/finance-settlement-unapplied.entity';
import { errorRes, successRes } from '../../../../libs/common/helpers/response';

/**
 * znD3KaZL — order-service FIFO tranzaksiyasi ichida outbox orqali
 * yuboradigan hodisa (`order-settlement.service.ts` dagi
 * `SETTLEMENT_UNAPPLIED_RECORDED_PATTERN` bilan AYNAN bir xil).
 */
export const SETTLEMENT_UNAPPLIED_RECORDED_PATTERN =
  'finance.settlement.unapplied_recorded';

const SETTLEMENT_LEVELS = [
  'courier_to_branch',
  'branch_to_hq',
  'hq_to_market',
] as const;
type SettlementLevel = (typeof SETTLEMENT_LEVELS)[number];

/** Hodisa / tezkor yo'l kirishi — maydonlar ishonchsiz (RMQ payload). */
export interface SettlementUnappliedInput {
  level?: unknown;
  actor_id?: unknown;
  amount?: unknown;
  dedup_epoch?: unknown;
  /** Faqat tashxis (order-service yuboradi) — jadvalga yozilmaydi. */
  allocated?: unknown;
  lump_sum?: unknown;
  carry_persisted?: unknown;
}

/** Qayerdan keldi — faqat log uchun. */
export type SettlementUnappliedSource = 'advance_reply' | 'outbox';

export interface SettlementUnappliedResult {
  /** Yangi qator yozildi. */
  recorded: boolean;
  /** Ayni `(level, actor_id, dedup_epoch)` allaqachon bor edi. */
  duplicate: boolean;
  /** Yozilmagan sabab: noto'g'ri kirish yoki qoldiq yo'q. */
  skipped_reason: 'invalid_payload' | 'no_leftover' | null;
}

/** Skalyar qiymat matni (obyekt / massiv — bo'sh satr: payload ishonchsiz). */
function scalarText(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return String(value).trim();
  }
  return '';
}

/**
 * znD3KaZL — `finance_settlement_unapplied` ga IDEMPOTENT yozish.
 *
 * ⚠️ NEGA IKKI YO'L. Finance advance javobini faqat tezkor yo'lda
 * (`tryPublishAdvanceNow`) ko'radi; u timeout bo'lsa yoki finance commit'dan
 * keyin yiqilsa, advance finance outbox relay orqali o'tadi va relay javobni
 * tashlab yuboradi — yozuv hech qachon paydo bo'lmasdi. Shuning uchun
 * order-service qoldiqni hisoblagan tranzaksiyaning O'ZIDA outbox orqali
 * hodisa yuboradi (sekin, lekin kafolatlangan yo'l), tezkor yo'l esa xuddi
 * shu yozuvni darhol yozadi. Ikkalasi bitta kalit bilan: `ON CONFLICT DO
 * NOTHING` — qaysi biri birinchi kelsa o'sha yozadi, ikkinchisi dublikat.
 *
 * Bu faqat ko'rsatkich/audit: kassa harakatlari va qoldiq mexanizmi
 * (`order_settlement_carry`) bu yerga bog'liq emas.
 */
@Injectable()
export class SettlementUnappliedService {
  private readonly logger = new Logger(SettlementUnappliedService.name);

  constructor(
    @InjectRepository(FinanceSettlementUnapplied)
    private readonly repo: Repository<FinanceSettlementUnapplied>,
  ) {}

  /**
   * Kirishni tekshiradi va yozadi. Noto'g'ri kirish / qoldiq 0 — xato EMAS,
   * `skipped_reason` bilan qaytadi. Baza xatosi YUTILMAYDI (chaqiruvchi
   * hal qiladi: tezkor yo'l yutadi, outbox handleri qayta urinishga beradi).
   */
  async record(
    input: SettlementUnappliedInput | null | undefined,
  ): Promise<SettlementUnappliedResult> {
    const normalized = this.normalize(input);
    if ('skip' in normalized) {
      return {
        recorded: false,
        duplicate: false,
        skipped_reason: normalized.skip,
      };
    }

    const result = await this.repo
      .createQueryBuilder()
      .insert()
      .values({
        level: normalized.level,
        actor_id: normalized.actorId,
        amount: normalized.amount,
        dedup_epoch: normalized.dedupEpoch,
      })
      .orIgnore()
      .updateEntity(false)
      .returning(['id'])
      .execute();
    const recorded = Array.isArray(result?.raw) && result.raw.length > 0;
    return { recorded, duplicate: !recorded, skipped_reason: null };
  }

  /**
   * Sekin yo'l — `finance.settlement.unapplied_recorded` outbox hodisasi.
   *
   * `finance.*` — doimiy (pul) pattern: xato bo'lsa order-service outbox'i
   * hodisani CHEKSIZ qayta uradi. Shuning uchun:
   *   • noto'g'ri payload — WARN va muvaffaqiyatli javob (qayta urish
   *     baribir tuzatmaydi, aks holda abadiy "STUCK" bo'lardi);
   *   • baza xatosi (masalan migratsiya 1716000000066 hali ishlamagan) —
   *     RpcException 500: hodisa keyinroq qayta yetkaziladi va yozuv
   *     YO'QOLMAYDI.
   */
  async handleRecordedEvent(data: SettlementUnappliedInput | null | undefined) {
    let result: SettlementUnappliedResult;
    try {
      result = await this.record(data);
    } catch (error) {
      this.logger.warn(
        `finance_settlement_unapplied ga yozib bo'lmadi (znD3KaZL, outbox) — hodisa qayta uriniladi: ${this.describe(data)}: ${(error as Error)?.message ?? error}`,
      );
      throw new RpcException(
        errorRes(
          "Taqsimlanmagan qoldiq yozuvini saqlab bo'lmadi — keyinroq qayta uriniladi",
          500,
        ),
      );
    }

    if (result.recorded) {
      this.logger.warn(
        `Settlement advance FIFO qoldig'i (znD3KaZL, outbox): ${this.describe(data)} — finance_settlement_unapplied ga yozildi`,
      );
    } else if (result.skipped_reason === 'invalid_payload') {
      this.logger.warn(
        `finance.settlement.unapplied_recorded: noto'g'ri hodisa e'tiborsiz qoldirildi (znD3KaZL): ${this.describe(data)}`,
      );
    }
    return successRes(
      result,
      200,
      result.recorded
        ? 'Settlement unapplied leftover recorded'
        : 'Settlement unapplied leftover not recorded',
    );
  }

  private normalize(input: SettlementUnappliedInput | null | undefined):
    | {
        level: SettlementLevel;
        actorId: string;
        amount: number;
        dedupEpoch: string;
      }
    | { skip: 'invalid_payload' | 'no_leftover' } {
    const level = scalarText(input?.level) as SettlementLevel;
    const actorId = scalarText(input?.actor_id);
    const dedupEpoch = scalarText(input?.dedup_epoch);
    if (
      !SETTLEMENT_LEVELS.includes(level) ||
      !/^\d+$/.test(actorId) ||
      !dedupEpoch
    ) {
      return { skip: 'invalid_payload' };
    }
    const raw = Number(input?.amount ?? 0);
    // numeric(14,2) — tiyingacha yaxlitlanadi (ikki yo'l bir xil qiymat yozsin).
    const amount = Number.isFinite(raw) ? Math.round(raw * 100) / 100 : 0;
    if (!(amount > 0)) {
      return { skip: 'no_leftover' };
    }
    return { level, actorId, amount, dedupEpoch };
  }

  private describe(data: SettlementUnappliedInput | null | undefined): string {
    const field = (name: string, value: unknown) =>
      value === undefined ? '' : ` ${name}=${scalarText(value) || '?'}`;
    return (
      `level=${scalarText(data?.level) || '?'} ` +
      `match=${scalarText(data?.actor_id) || '?'} ` +
      `leftover=${scalarText(data?.amount) || '?'} ` +
      `dedup_epoch=${scalarText(data?.dedup_epoch) || '?'}` +
      field('allocated', data?.allocated) +
      field('lump_sum', data?.lump_sum) +
      field('carry_persisted', data?.carry_persisted)
    );
  }
}
