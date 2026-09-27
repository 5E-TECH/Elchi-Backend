import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ActivityLogService,
  NotificationPriority,
  type AiRequester,
  type AiStatusResponse,
  type ClaudeBudgetDecision,
  type ClaudeBudgetGuard,
  type ClaudeUsageRecord,
} from '@app/common';
import { computeCostUsd, roundMoney2, roundUsd } from '../usage/ai-pricing';
import { AiSpendCounterService } from '../usage/ai-spend-counter.service';
import { nextTashkentMidnight, tashkentDay } from '../usage/tashkent-day';
import { AiBudgetNotifier } from './ai-budget.notifier';

/** `ai.status` dagi `cap` bo'limi (C2 `AiStatusResponse.cap`). */
export type AiCapStatus = AiStatusResponse['cap'];

/** `ai.cap.raise` javobi (C7). */
export interface AiCapRaiseResult {
  period_key: string;
  override_usd: number;
  effective_cap_usd: number;
}

const DEFAULT_DAILY_USD_CAP = 50;
const DEFAULT_WARN_RATIO = 0.8;
const DEFAULT_RAISE_MAX_USD = 50;
const DEFAULT_USD_UZS_RATE = 12800;
const REASON_MAX_CHARS = 255;

function readPositive(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const n = Number(config.get<unknown>(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'non-error throw';
}

/**
 * GLOBAL KUNLIK AVARIYA TO'XTATGICHI (`ClaudeBudgetGuard`, wFSMEIIy).
 *
 * - `check()` — HAR Anthropic urinishidan OLDIN: bugungi (Toshkent) qator
 *   bitta PK lookup bilan o'qiladi; `spent >= AI_DAILY_USD_CAP + override`
 *   bo'lsa `cap_exceeded` (+ `reset_at` = keyingi Toshkent yarim tuni).
 *   ⚠️ FAIL-CLOSED: o'qish xatosi YUTILMAYDI — ClaudeService uni 'disabled'
 *   ga aylantiradi (hisoblagich o'qilmasa AI O'CHIQ, bu pul darvozasi).
 * - `onSpend()` — HAR javobdan keyin atomik UPSERT; 80% va 100% chegaralari
 *   kuniga BIR martadan bildirishnoma beradi (`warned_at`/`exceeded_at`
 *   `IS NULL` sharti g'olibni tanlaydi).
 *
 * ⚠️ Bu KVOTA EMAS (ega qarori 2026-09-19): market yoki foydalanuvchi
 * kesimida hech qanday hisob/tekshiruv yo'q — birorta metod market yoki
 * foydalanuvchi identifikatorini qabul qilmaydi (`no-quota.guard.spec.ts`).
 * Shift urilganda faqat AI o'chadi — qo'lda buyurtma yaratish ishlayveradi.
 *
 * ⚠️ Shift — tekshiruv, rezervatsiya emas: bir vaqtda ochiq chaqiruvlar
 * (prefetch 8) tufayli shiftdan bir necha chaqiruv narxicha oshib ketishi
 * mumkin (PLAN §10).
 */
@Injectable()
export class AiBudgetService implements ClaudeBudgetGuard {
  private readonly logger = new Logger(AiBudgetService.name);
  private readonly capUsd: number;
  private readonly warnRatio: number;
  private readonly raiseMaxUsd: number;
  private readonly usdUzsRate: number;

  constructor(
    private readonly counter: AiSpendCounterService,
    private readonly notifier: AiBudgetNotifier,
    private readonly activityLog: ActivityLogService,
    config: ConfigService,
  ) {
    this.capUsd = readPositive(
      config,
      'AI_DAILY_USD_CAP',
      DEFAULT_DAILY_USD_CAP,
    );
    const ratio = readPositive(config, 'AI_CAP_WARN_RATIO', DEFAULT_WARN_RATIO);
    this.warnRatio = ratio < 1 ? ratio : DEFAULT_WARN_RATIO;
    this.raiseMaxUsd = readPositive(
      config,
      'AI_CAP_RAISE_MAX_USD',
      DEFAULT_RAISE_MAX_USD,
    );
    this.usdUzsRate = readPositive(
      config,
      'AI_USD_UZS_RATE',
      DEFAULT_USD_UZS_RATE,
    );
  }

  /**
   * Anthropic chaqiruvidan OLDIN. Qator yo'q → bugun hali xarajat yo'q.
   * ⚠️ `counter.read` xatosi ATAYLAB yuqoriga chiqadi (fail-closed).
   */
  async check(now: Date = new Date()): Promise<ClaudeBudgetDecision> {
    const periodKey = tashkentDay(now);
    const row = await this.counter.read(periodKey);
    const spent = row?.cost_usd ?? 0;
    const effectiveCap = this.capUsd + (row?.override_usd ?? 0);
    if (spent < effectiveCap) return { ok: true };

    // Shift pasaytirilgan (env) yoki onSpend'da belgilash yiqilgan bo'lsa —
    // bildirishnoma shu yerda BIR marta ketadi.
    if (row && row.exceeded_at === null) {
      await this.announceExceeded(periodKey, spent, effectiveCap);
    }
    return {
      ok: false,
      reason: 'cap_exceeded',
      scope: 'global',
      reset_at: nextTashkentMidnight(now),
    };
  }

  /**
   * Har Anthropic javobidan keyin (ClaudeService await qiladi, xatosini
   * WARN bilan yutadi). Token 0 bo'lsa hisoblagichga tegilmaydi.
   */
  async onSpend(r: ClaudeUsageRecord): Promise<void> {
    const usd = roundUsd(computeCostUsd(r));
    if (!(usd > 0)) return;

    const periodKey = tashkentDay(new Date());
    const totals = await this.counter.add(
      periodKey,
      usd,
      roundMoney2(usd * this.usdUzsRate),
    );
    const effectiveCap = this.capUsd + totals.override_usd;
    const ratio = totals.cost_usd / effectiveCap;

    if (ratio >= this.warnRatio && totals.warned_at === null) {
      await this.announceWarning(periodKey, totals.cost_usd, effectiveCap);
    }
    if (ratio >= 1 && totals.exceeded_at === null) {
      await this.announceExceeded(periodKey, totals.cost_usd, effectiveCap);
    }
  }

  /** `ai.status` uchun bugungi shift holati. O'qish xatosi yuqoriga chiqadi. */
  async status(now: Date = new Date()): Promise<AiCapStatus> {
    const periodKey = tashkentDay(now);
    const row = await this.counter.read(periodKey);
    const spent = roundUsd(row?.cost_usd ?? 0);
    const override = roundMoney2(row?.override_usd ?? 0);
    // Nisbat check() dagi bilan AYNAN bir xil chegaradan (yaxlitlanmagan).
    const effectiveCap = this.capUsd + override;
    const ratio = effectiveCap > 0 ? spent / effectiveCap : 1;
    return {
      period_key: periodKey,
      spent_usd: spent,
      cap_usd: this.capUsd,
      override_usd: override,
      effective_cap_usd: roundUsd(effectiveCap),
      ratio: Math.round(ratio * 10_000) / 10_000,
      state: ratio >= 1 ? 'exceeded' : ratio >= this.warnRatio ? 'warn' : 'ok',
      reset_at: nextTashkentMidnight(now),
    };
  }

  /**
   * SUPERADMIN'ning BIR KUNLIK "shiftni ko'tarish" amali (wFSMEIIy #10):
   * bugungi `override_usd` ga qo'shiladi (bitta chaqiruvda ko'pi bilan
   * AI_CAP_RAISE_MAX_USD), ertaga o'z-o'zidan tushadi (yangi period_key).
   * Amal `ai_schema.activity_logs` ga audit sifatida yoziladi.
   */
  async raise(
    extraUsd: number,
    reason: string,
    requester: AiRequester,
    now: Date = new Date(),
  ): Promise<AiCapRaiseResult> {
    const requested = Number(extraUsd);
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new Error("extra_usd musbat son bo'lishi kerak");
    }
    const reasonText =
      typeof reason === 'string'
        ? reason.trim().slice(0, REASON_MAX_CHARS)
        : '';
    if (!reasonText) {
      throw new Error('reason majburiy');
    }
    const actor =
      requester && typeof requester.id === 'string' ? requester.id.trim() : '';
    if (!actor) {
      throw new Error('requester majburiy');
    }
    const applied = roundMoney2(Math.min(requested, this.raiseMaxUsd));
    if (applied <= 0) {
      throw new Error('extra_usd juda kichik (0.01 USD dan kam)');
    }

    const periodKey = tashkentDay(now);
    const totals = await this.counter.addOverride(periodKey, applied);
    const overrideUsd = roundMoney2(totals.override_usd);
    const previousOverride = roundMoney2(overrideUsd - applied);
    const effectiveCap = roundMoney2(this.capUsd + overrideUsd);

    const roles = Array.isArray(requester.roles) ? requester.roles : [];
    await this.activityLog.log({
      entity_type: 'ai_daily_cap',
      entity_id: periodKey,
      action: 'ai.cap.raise',
      old_value: {
        override_usd: previousOverride,
        effective_cap_usd: roundMoney2(this.capUsd + previousOverride),
      },
      new_value: { override_usd: overrideUsd, effective_cap_usd: effectiveCap },
      // Audit AKTYORI (kim ko'tardi) — kvota kaliti emas.
      user_id: actor,
      user_role: roles.join(',').slice(0, 32) || null,
      metadata: {
        reason: reasonText,
        extra_usd: applied,
        requested_usd: requested,
        spent_usd: roundUsd(totals.cost_usd),
      },
    });
    this.logger.warn(
      `ai_cap_raised period=${periodKey} extra_usd=${applied} ` +
        `override_usd=${overrideUsd} effective_cap_usd=${effectiveCap}`,
    );

    return {
      period_key: periodKey,
      override_usd: overrideUsd,
      effective_cap_usd: effectiveCap,
    };
  }

  /** 80% — kuniga BIR marta (markWarned g'olibi), oqim davom etadi. */
  private async announceWarning(
    periodKey: string,
    spentUsd: number,
    capUsd: number,
  ): Promise<void> {
    try {
      if (!(await this.counter.markWarned(periodKey))) return;
    } catch (err) {
      this.logger.warn(
        `ai_cap_mark_failed kind=warning period=${periodKey}: ${describeError(err)}`,
      );
      return;
    }
    const percent = Math.round((spentUsd / capUsd) * 100);
    this.logger.warn(
      `ai_cap_warning period=${periodKey} spent_usd=${roundUsd(spentUsd)} ` +
        `cap_usd=${roundMoney2(capUsd)} (${percent}%)`,
    );
    void this.notifier.notify({
      type: 'ai.cap_warning',
      priority: NotificationPriority.HIGH,
      title: `AI kunlik xarajati ${percent}% ga yetdi`,
      body:
        `Bugungi AI xarajati $${roundUsd(spentUsd)} — kunlik shift ` +
        `$${roundMoney2(capUsd)}. Shiftga yetganda AI buyurtma o'chadi ` +
        `(qo'lda kiritish ishlayveradi).`,
      periodKey,
      spentUsd: roundUsd(spentUsd),
      capUsd: roundMoney2(capUsd),
    });
  }

  /** 100% — kuniga BIR marta (markExceeded g'olibi). */
  private async announceExceeded(
    periodKey: string,
    spentUsd: number,
    capUsd: number,
  ): Promise<void> {
    try {
      if (!(await this.counter.markExceeded(periodKey))) return;
    } catch (err) {
      this.logger.warn(
        `ai_cap_mark_failed kind=exceeded period=${periodKey}: ${describeError(err)}`,
      );
      return;
    }
    this.logger.error(
      `ai_cap_exceeded period=${periodKey} spent_usd=${roundUsd(spentUsd)} ` +
        `cap_usd=${roundMoney2(capUsd)} — AI ertaga (Toshkent yarim tuni) yoki ` +
        `shift ko'tarilguncha o'chiq`,
    );
    void this.notifier.notify({
      type: 'ai.cap_exceeded',
      priority: NotificationPriority.CRITICAL,
      title: "AI kunlik shifti urildi — AI buyurtma o'chdi",
      body:
        `Bugungi AI xarajati $${roundUsd(spentUsd)} kunlik shiftga ` +
        `($${roundMoney2(capUsd)}) yetdi. Buyurtmalar qo'lda kiritiladi. ` +
        `Kerak bo'lsa SUPERADMIN shiftni bugun uchun ko'tarishi mumkin.`,
      periodKey,
      spentUsd: roundUsd(spentUsd),
      capUsd: roundMoney2(capUsd),
    });
  }
}
