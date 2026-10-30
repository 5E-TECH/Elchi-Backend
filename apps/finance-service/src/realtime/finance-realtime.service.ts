import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { OutboxService } from '@app/common';

/**
 * (rWdLuoP3, 2026-10-25) SMENA VA KASSA KARTASI JONLI HODISALARI.
 *
 * Ochiq kassa sahifalari (asosiy kassa, filial kassasi, To'lovlar) smena
 * yopilganda / kassa kartasi o'zgarganda sahifani yangilamasdan qayta o'qisin
 * (frontend `RealtimeSync` → `realtimeFinance.ts`, `FINANCE_SHIFT_EVENTS`).
 *
 * Yo'l: finance tranzaksiyasi ICHIDA outbox qatori (`GATEWAY` /
 * `realtime.notify`, fire-and-forget) → OutboxPublisher (~1 s) → gateway
 * navbati → `RealtimeController.notify` (`targets`) → socket.io xonalari.
 * Tranzaksiya rollback bo'lsa hodisa ham yo'q (smena yopilmagan bo'lsa
 * "yopildi" kelmaydi). Gateway navbati (`RABBITMQ_GATEWAY_QUEUE`)
 * sozlanmagan bo'lsa — hech narsa yozilmaydi.
 *
 * NISHONLAR — `GET finance/shift/current` kassa doirasi bilan AYNI
 * (gateway `resolveShiftCashboxScope`), boshqa filial ma'lumoti chiqmaydi:
 *  - MAIN kassa smenasi (`cashbox_user_id = '0'`) — `superadmin`, `admin`,
 *    `registrator` rollari (ular MAIN smenani ochadi/yopadi/ko'radi);
 *  - filial (BRANCH) kassasi smenasi (`cashbox_user_id` = filial ID) — FAQAT
 *    shu filial menejerlari (`branch:<id>:role:manager`). Superadmin/admin
 *    olmaydi: ularning «Smena» holati MAIN kassaniki, filial smenasi avtomatik
 *    yopilganda ularga «Smena avtomatik yopildi» xabari chiqmasin;
 *  - har ikkalasida smenani ochgan va yopgan xodimning o'zi (`user:<id>`) —
 *    JWT'da `branch_id` bo'lmasa ham kassir hodisani oladi.
 *  - Kassa kartalari (faqat MAIN kassada, endpointlar superadmin/admin) —
 *    `superadmin`, `admin`.
 *
 * Payload'da pul summasi YO'Q — faqat identifikatorlar va vaqt; frontend
 * qiymatlarni REST'dan qayta o'qiydi.
 */

export const GATEWAY_OUTBOX_TARGET = 'GATEWAY';
export const REALTIME_NOTIFY_PATTERN = 'realtime.notify';

/** Frontend `FINANCE_SHIFT_EVENTS` bilan kelishilgan nomlar. */
export const FINANCE_REALTIME_EVENTS = {
  /** Smena qo'lda yopildi (`POST finance/shift/close`). */
  shiftClosed: 'finance.shift.closed',
  /** Smena jadval bo'yicha avtomatik yopildi (y8Tqm9Ap). */
  shiftAutoClosed: 'finance.shift.auto_closed',
  /** Karta qoldig'ining AI tekshiruvi tugadi (kiZgTybn). */
  shiftAccountChecked: 'finance.shift.account_checked',
  /**
   * Kassa kartasi o'zgardi (yaratish, nom / tafsilot, holat, asosiy qilish,
   * o'tkazma, konvertatsiya). Zv3MLn0a: filial kassasi kartasi — menejerga ham.
   */
  cashboxCardChanged: 'finance.cashbox.card_changed',
  /**
   * (T6) Superadmin to'lovni qaytardi / summasini tuzatdi — kassa
   * sahifalari (MAIN yoki filial, kuryer / market o'z kassasi) qayta o'qisin.
   */
  paymentCorrected: 'finance.payment.corrected',
  /**
   * (T3) Kassa chekining AI tahlili tugadi — tarix / tafsilot qayta o'qilsin.
   * Pul summasi YO'Q.
   */
  receiptChecked: 'finance.receipt.checked',
} as const;

export type FinanceRealtimeEvent =
  (typeof FINANCE_REALTIME_EVENTS)[keyof typeof FINANCE_REALTIME_EVENTS];

/** Gateway `RealtimeNotifyTarget` bilan bir xil shakl. */
export interface FinanceRealtimeTarget {
  user_id?: string;
  role?: string;
  branch_id?: string;
}

/** `Roles` enum qiymatlari (gateway JWT rollarini kichik harfda xonaga qo'yadi). */
export const MAIN_SHIFT_ROLES = ['superadmin', 'admin', 'registrator'] as const;
export const BRANCH_SHIFT_ROLE = 'manager';
export const CASHBOX_CARD_ROLES = ['superadmin', 'admin'] as const;

const MAIN_CASHBOX_USER_ID = '0';

export type ShiftCloseReason = 'manual' | 'auto';

/** Smena qatorining hodisa uchun kerakli maydonlari. */
export interface ShiftRealtimeSource {
  id: string | number;
  cashbox_user_id?: string | number | null;
  opened_by?: string | number | null;
  closed_by?: string | number | null;
  closed_at?: Date | string | null;
}

export type CashboxCardAction =
  | 'created'
  | 'renamed'
  | 'updated'
  | 'made_default'
  | 'activated'
  | 'archived'
  | 'transfer'
  | 'card_to_cash'
  | 'cash_to_card';

export interface RealtimeNotifyMessage {
  event: FinanceRealtimeEvent;
  payload: Record<string, unknown>;
  targets: FinanceRealtimeTarget[];
}

const isUserId = (value: unknown): boolean =>
  (typeof value === 'string' || typeof value === 'number') &&
  /^\d+$/.test(String(value)) &&
  !/^0+$/.test(String(value));

const toIso = (value: Date | string | null | undefined): string => {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date().toISOString();
};

/** Smena kassasi doirasi: MAIN yoki filial (filial kassasining `user_id` si = filial ID). */
export function shiftScope(
  shift: Pick<ShiftRealtimeSource, 'cashbox_user_id'>,
): {
  cashbox_user_id: string;
  cashbox_type: 'main' | 'branch';
  branch_id: string | null;
} {
  const cashboxUserId = String(shift.cashbox_user_id ?? MAIN_CASHBOX_USER_ID);
  const isMain = cashboxUserId === MAIN_CASHBOX_USER_ID;
  return {
    cashbox_user_id: cashboxUserId,
    cashbox_type: isMain ? 'main' : 'branch',
    branch_id: isMain ? null : cashboxUserId,
  };
}

/** Smena hodisasi nishonlari (yuqoridagi izoh). */
export function shiftTargets(
  shift: Pick<
    ShiftRealtimeSource,
    'cashbox_user_id' | 'opened_by' | 'closed_by'
  >,
): FinanceRealtimeTarget[] {
  const scope = shiftScope(shift);
  const targets: FinanceRealtimeTarget[] =
    scope.cashbox_type === 'main'
      ? MAIN_SHIFT_ROLES.map((role) => ({ role }))
      : [{ role: BRANCH_SHIFT_ROLE, branch_id: scope.branch_id as string }];
  const users = new Set<string>();
  for (const id of [shift.opened_by, shift.closed_by]) {
    if (isUserId(id)) users.add(String(id));
  }
  for (const id of users) targets.push({ user_id: id });
  return targets;
}

export function buildShiftClosedMessage(
  shift: ShiftRealtimeSource,
  reason: ShiftCloseReason,
): RealtimeNotifyMessage {
  return {
    event:
      reason === 'auto'
        ? FINANCE_REALTIME_EVENTS.shiftAutoClosed
        : FINANCE_REALTIME_EVENTS.shiftClosed,
    payload: {
      shift_id: String(shift.id),
      ...shiftScope(shift),
      status: 'closed',
      close_reason: reason,
      closed_at: toIso(shift.closed_at),
      closed_by: isUserId(shift.closed_by) ? String(shift.closed_by) : null,
      opened_by: isUserId(shift.opened_by) ? String(shift.opened_by) : null,
    },
    targets: shiftTargets(shift),
  };
}

export function buildShiftAccountCheckedMessage(input: {
  shift: ShiftRealtimeSource;
  card_id: string | number;
  ai_status: string;
  checked_at?: Date | string | null;
}): RealtimeNotifyMessage {
  return {
    event: FINANCE_REALTIME_EVENTS.shiftAccountChecked,
    payload: {
      shift_id: String(input.shift.id),
      ...shiftScope(input.shift),
      card_id: String(input.card_id),
      ai_status: String(input.ai_status),
      checked_at: toIso(input.checked_at),
    },
    targets: shiftTargets(input.shift),
  };
}

export function buildCashboxCardChangedMessage(input: {
  action: CashboxCardAction;
  card_ids: Array<string | number>;
  movement_id?: string | number | null;
  at?: Date | string | null;
  /** Zv3MLn0a — filial kassasi kartasi (sukut: MAIN, avvalgi shakl). */
  cashbox_type?: 'main' | 'branch';
  branch_id?: string | number | null;
}): RealtimeNotifyMessage {
  const branchId =
    input.cashbox_type === 'branch' && isUserId(input.branch_id)
      ? String(input.branch_id)
      : null;
  const targets: FinanceRealtimeTarget[] = CASHBOX_CARD_ROLES.map((role) => ({
    role,
  }));
  if (branchId) {
    targets.push({ role: BRANCH_SHIFT_ROLE, branch_id: branchId });
  }
  return {
    event: FINANCE_REALTIME_EVENTS.cashboxCardChanged,
    payload: {
      action: input.action,
      cashbox_type: branchId ? 'branch' : 'main',
      ...(branchId ? { branch_id: branchId } : {}),
      card_ids: [...new Set(input.card_ids.map((id) => String(id)))],
      movement_id: input.movement_id == null ? null : String(input.movement_id),
      at: toIso(input.at),
    },
    targets,
  };
}

/**
 * (T6) `finance.payment.corrected` — SUMMASIZ. Nishon: qabul qiluvchi MAIN
 * kassa — superadmin/admin/registrator; BRANCH — o'sha filial menejerlari;
 * kontragentlar (kuryer / market) — `user:<id>`.
 */
export function buildPaymentCorrectedMessage(input: {
  correction_id: string | number;
  action: 'reverse' | 'edit';
  payment_kind: 'courier_payment' | 'market_payment';
  receiver_cashbox_type: 'main' | 'branch';
  branch_id?: string | number | null;
  user_ids: Array<string | number | null | undefined>;
  cashbox_ids: Array<string | number>;
  at?: Date | string | null;
}): RealtimeNotifyMessage {
  const branchId =
    input.receiver_cashbox_type === 'branch' && isUserId(input.branch_id)
      ? String(input.branch_id)
      : null;
  const targets: FinanceRealtimeTarget[] = branchId
    ? [{ role: BRANCH_SHIFT_ROLE, branch_id: branchId }]
    : MAIN_SHIFT_ROLES.map((role) => ({ role }));
  for (const id of new Set(input.user_ids.filter(isUserId).map(String))) {
    targets.push({ user_id: id });
  }
  return {
    event: FINANCE_REALTIME_EVENTS.paymentCorrected,
    payload: {
      correction_id: String(input.correction_id),
      action: input.action,
      payment_kind: input.payment_kind,
      cashbox_type: branchId ? 'branch' : 'main',
      ...(branchId ? { branch_id: branchId } : {}),
      cashbox_ids: [...new Set(input.cashbox_ids.map((id) => String(id)))],
      at: toIso(input.at),
    },
    targets,
  };
}

/** (T3) Chek AI tahlili natijasi nishonlari. */
export const RECEIPT_CHECKED_ROLES = ['superadmin', 'admin'] as const;

/**
 * (T3) `finance.receipt.checked` — SUMMASIZ. Nishon: superadmin/admin,
 * chek filiali menejerlari (`branch_id` bo'lsa), chekni yuklagan xodim.
 */
export function buildReceiptCheckedMessage(input: {
  receipt_id: string | number;
  history_id: string | number | null;
  kind: string;
  ai_status: string;
  branch_id?: string | number | null;
  uploaded_by?: string | number | null;
  at?: Date | string | null;
}): RealtimeNotifyMessage {
  const targets: FinanceRealtimeTarget[] = RECEIPT_CHECKED_ROLES.map(
    (role) => ({ role }),
  );
  if (isUserId(input.branch_id)) {
    targets.push({
      role: BRANCH_SHIFT_ROLE,
      branch_id: String(input.branch_id),
    });
  }
  if (isUserId(input.uploaded_by)) {
    targets.push({ user_id: String(input.uploaded_by) });
  }
  return {
    event: FINANCE_REALTIME_EVENTS.receiptChecked,
    payload: {
      receipt_id: String(input.receipt_id),
      history_id: input.history_id == null ? null : String(input.history_id),
      kind: input.kind,
      ai_status: input.ai_status,
      at: toIso(input.at),
    },
    targets,
  };
}

@Injectable()
export class FinanceRealtimeService {
  private readonly logger = new Logger(FinanceRealtimeService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly outbox: OutboxService,
    @Optional() config?: ConfigService,
  ) {
    const queue = config
      ? config.get<string>('RABBITMQ_GATEWAY_QUEUE')
      : process.env.RABBITMQ_GATEWAY_QUEUE;
    this.enabled = Boolean(String(queue ?? '').trim());
  }

  /** Smena yopildi: `manual` → `finance.shift.closed`, `auto` → `finance.shift.auto_closed`. */
  shiftClosed(
    shift: ShiftRealtimeSource,
    reason: ShiftCloseReason,
    manager?: EntityManager,
  ): Promise<void> {
    return this.enqueue(() => buildShiftClosedMessage(shift, reason), manager);
  }

  /** (kiZgTybn) Karta qoldig'ining AI tekshiruvi natijasi smena yopish oynasiga. */
  shiftAccountChecked(
    input: Parameters<typeof buildShiftAccountCheckedMessage>[0],
    manager?: EntityManager,
  ): Promise<void> {
    return this.enqueue(() => buildShiftAccountCheckedMessage(input), manager);
  }

  /** Asosiy kassa kartasi o'zgardi — kartalar va kassa qoldiqlari qayta o'qilsin. */
  cashboxCardChanged(
    input: Parameters<typeof buildCashboxCardChangedMessage>[0],
    manager?: EntityManager,
  ): Promise<void> {
    return this.enqueue(() => buildCashboxCardChangedMessage(input), manager);
  }

  /** (T3) Chek AI tahlili tugadi — natija yozilgan tranzaksiya ichida. */
  receiptChecked(
    input: Parameters<typeof buildReceiptCheckedMessage>[0],
    manager?: EntityManager,
  ): Promise<void> {
    return this.enqueue(() => buildReceiptCheckedMessage(input), manager);
  }

  /** (T6) To'lov qaytarildi / tuzatildi — pul tranzaksiyasi ichida. */
  paymentCorrected(
    input: Parameters<typeof buildPaymentCorrectedMessage>[0],
    manager?: EntityManager,
  ): Promise<void> {
    return this.enqueue(() => buildPaymentCorrectedMessage(input), manager);
  }

  /**
   * FAIL-OPEN (`FinanceNotificationService.enqueueSafely` naqshi): payload
   * qurishdagi xato — faqat WARN. Tranzaksiya ichidagi DB xatosi qayta
   * otiladi (Postgres tranzaksiyasi baribir buzilgan — chaqiruvchi rollback
   * qiladi); tranzaksiyasiz — WARN.
   */
  private async enqueue(
    build: () => RealtimeNotifyMessage,
    manager?: EntityManager,
  ): Promise<void> {
    if (!this.enabled) return;
    let message: RealtimeNotifyMessage;
    try {
      message = build();
    } catch (error) {
      this.logger.warn(
        `realtime hodisasi qurilmadi: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (!message.targets.length) return;
    const inTransaction = Boolean(manager?.queryRunner?.isTransactionActive);
    try {
      await this.outbox.enqueue(
        GATEWAY_OUTBOX_TARGET,
        REALTIME_NOTIFY_PATTERN,
        message,
        manager ? { manager } : {},
      );
    } catch (error) {
      if (inTransaction) throw error;
      this.logger.warn(
        `realtime hodisasi (${message.event}) outbox'ga yozilmadi: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
