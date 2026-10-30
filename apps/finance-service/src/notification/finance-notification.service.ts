import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  Cashbox_type,
  Operation_type,
  OutboxService,
  Source_type,
  deterministicUuid,
  findNotificationType,
  renderNotificationGroupKey,
} from '@app/common';

/**
 * HODISA → BILDIRISHNOMA (ePpLHPX2) — finance-service.
 *
 * Naqsh order-service pilotidan (OA16fdSq, `order-notification.service.ts`)
 * va `libs/common/src/outbox/README.md` yo'riqnomasidan:
 *
 *   • `finance.payment_received` — to'lov o'tdi. Nishon — puli kelgan/ketgan
 *     tomon: HQ marketga to'laganda (`paymentsToMarket`) va kuryer pulini
 *     marketga o'tkazganda (click_to_market) — MARKET; kuryer kassaga pul
 *     topshirganda (`paymentsFromCourier`) — KURYER (topshirgani qabul
 *     qilinganining tasdig'i).
 *   • `finance.balance_topup` — balans qo'lda to'ldirildi (BeePost
 *     `notifyBalanceTopup` analogi: admin market balansini to'ldiradi).
 *     Elchi'da bu — market/kuryer kassasiga qo'lda KIRIM (MANUAL_INCOME,
 *     `updateBalance`). Nishon — kassa egasi.
 *
 * ⚠️ FAQAT OUTBOX. To'g'ridan-to'g'ri rmqSend / client.send TAQIQ: pul
 * tranzaksiyasi rollback bo'lsa ham xabar ketib qolardi ("to'lov o'tdi" —
 * aslida o'tmagan). Outbox qatori pul yozuvlari bilan BITTA tranzaksiyada.
 *
 * ⚠️ FAIL-OPEN. notification-service ishlamasa pul amali baribir o'tadi:
 * tranzaksiyada faqat `outbox_events` ga INSERT, yetkazishni OutboxPublisher
 * keyin qiladi (`fireAndForgetPatterns` — javob kutilmaydi). Payload
 * qurishdagi kutilmagan xato ham pul amalini yiqitmaydi (faqat WARN).
 * Tranzaksiya ichidagi DB xatosi esa qayta otiladi — Postgres tranzaksiyasi
 * baribir buzilgan, chaqiruvchi rollback qilsin (order-service naqshi).
 *
 * PII: in_app `body` — faqat raqam + summa (telefon/manzil/izoh YO'Q;
 * to'lov izohi erkin matn, unga hech qachon kirmaydi).
 */

export const NOTIFICATION_OUTBOX_TARGET = 'NOTIFICATION';
export const NOTIFICATION_DISPATCH_PATTERN = 'notification.dispatch';

/** Shu servis yuboradigan turlar — kalitlar `NOTIFICATION_TYPES` katalogida. */
export const FINANCE_NOTIFICATION_TYPES = [
  'finance.payment_received',
  'finance.balance_topup',
  'finance.payment_disputed',
  'finance.cash_reminder',
  // (gWI4gYkw / y8Tqm9Ap) smena hisoboti va avtomatik yopish ogohlantirishi.
  'finance.shift_closed',
  'finance.shift_auto_closed',
  'finance.shift_auto_close_warning',
  // (T6-BE-4) superadmin to'lovni qaytardi / summasini tuzatdi.
  'finance.payment_corrected',
] as const;

/** (2crjWf7v) Kvitansiya tugmalari — notification-service bot handler nomlari. */
export const COURIER_PAYMENT_ACK_ACTIONS = {
  confirm: 'fp.ok',
  dispute: 'fp.no',
} as const;

export type FinanceNotificationType =
  (typeof FINANCE_NOTIFICATION_TYPES)[number];

/** Market / kuryerning o'z kassasi sahifasi (frontend `MyCashboxPage`). */
export const FINANCE_SELF_CASHBOX_LINK = '/cash-box';

/**
 * `market_payment` — marketga pul o'tkazildi (HQ to'lovi yoki kuryerning
 * marketga o'tkazmasi); `courier_payment` — kuryer topshirgan pul kassaga
 * qabul qilindi.
 */
export type FinancePaymentKind = 'market_payment' | 'courier_payment';

export interface FinanceNotificationPayload {
  type: FinanceNotificationType;
  category: string;
  priority: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  link: string;
  recipient_ids: string[];
  group_key?: string;
  channels: string[];
  /** Barqaror dispatch ID (UUID) — takror yuborilmaydi (kuniga bir eslatma). */
  client_request_id?: string;
  /**
   * (gWI4gYkw #4) Market Telegram GURUHI relay'i (matn + havola). Berilsa
   * notification-service shaxsiy DM emas, guruhga yuboradi.
   */
  telegram?: {
    market_id: string;
    group_type?: 'create' | 'cancel';
    text: string;
  };
}

export interface ShiftAutoCloseWarningInput {
  shift_id: string | number;
  /** Smenani ochgan xodim. */
  recipient_id: string | number | null | undefined;
  /** `YYYY-MM-DDTHH:MM` (Toshkent). */
  slot: string;
  /** `HH:MM` (Toshkent). */
  time: string;
  minutes_left: number;
}

/** (y8Tqm9Ap #4) «Smena HH:MM da avtomatik yopiladi» — slot uchun bir marta. */
export function buildShiftAutoCloseWarningPayload(
  input: ShiftAutoCloseWarningInput,
): FinanceNotificationPayload | null {
  const type: FinanceNotificationType = 'finance.shift_auto_close_warning';
  const entry = findNotificationType(type);
  if (!entry || !isId(input.recipient_id) || !isId(input.shift_id)) {
    return null;
  }
  const shiftId = String(input.shift_id);
  const data: Record<string, unknown> = {
    shift_id: shiftId,
    slot: input.slot,
    auto_close_at: input.time,
    minutes_left: Math.max(0, Math.round(input.minutes_left)),
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);
  const minutes = Math.max(1, Math.round(input.minutes_left));
  return {
    type,
    category: entry.category,
    priority: entry.priority,
    title: '⏰ Smena tez orada avtomatik yopiladi',
    body: `Smena #${shiftId} soat ${input.time} da (${minutes} daqiqadan keyin) avtomatik yopiladi. Sanab, o'zingiz yopishga ulguring — avtomatik yopilsa hisobotda «kassir yopmagan» deb yoziladi.`,
    data,
    link: '/payments/main-cashbox',
    recipient_ids: [String(input.recipient_id)],
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: [...entry.default_channels],
    client_request_id: deterministicUuid(`shift-warn:${shiftId}:${input.slot}`),
  };
}

export interface PaymentReceivedInput {
  kind: FinancePaymentKind;
  /** Puli kelgan/ketgan tomon (market yoki kuryer user id si). */
  recipient_id: string | number | null | undefined;
  /** Qabul qiluvchi kassasidagi tarix qatori id si (to'lov raqami). */
  payment_id: string | number | null | undefined;
  amount: number | string | null | undefined;
  payment_method?: string | null;
  /**
   * (VICfJuoi #3 / 2crjWf7v #3) Qabul qiluvchi kassasining to'lovdan KEYINGI
   * qoldig'i (market: HQ qarzi; kuryer: qo'lidagi naqd). PG numeric satr
   * bo'lib kelishi mumkin — Number() bilan.
   */
  balance_after?: number | string | null;
  /** To'lov sanasi (kiritilgan `payment_date`, bo'lmasa amal vaqti). */
  payment_date?: Date | string | null;
  /** (2crjWf7v) "Qabul qildi: <xodim>" — bo'lmasa umumiy so'z. */
  accepted_by_name?: string | null;
}

export interface BalanceTopupInput {
  cashbox_type: Cashbox_type | string | null | undefined;
  operation_type: Operation_type | string | null | undefined;
  source_type: Source_type | string | null | undefined;
  /** Kassa egasi (FOR_MARKET / FOR_COURIER kassasining `user_id` si). */
  recipient_id: string | number | null | undefined;
  history_id: string | number | null | undefined;
  amount: number | string | null | undefined;
  balance_after?: number | string | null;
}

const isId = (value: unknown): value is string | number =>
  (typeof value === 'string' || typeof value === 'number') &&
  /^\d+$/.test(String(value)) &&
  !/^0+$/.test(String(value));

const formatMoney = (value: unknown) => {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount)
    ? `${Math.round(amount)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm`
    : '';
};

const positiveAmount = (value: unknown): number | null => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

const finiteOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** `DD.MM.YYYY` (Asia/Tashkent) — yaroqsiz sana → amal vaqti. */
const formatDay = (value: Date | string | null | undefined): string => {
  const parsed = value ? new Date(value) : new Date();
  const date = Number.isFinite(parsed.getTime()) ? parsed : new Date();
  const local = new Date(date.getTime() + 5 * 3_600_000).toISOString();
  return `${local.slice(8, 10)}.${local.slice(5, 7)}.${local.slice(0, 4)}`;
};

const cleanName = (value: unknown): string => {
  const name =
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return name.slice(0, 80);
};

/**
 * `finance.payment_received` payload'i. Qabul qiluvchi yoki summa yaroqsiz
 * bo'lsa — `null` (bildirishnoma yo'q, pul amaliga ta'sir yo'q).
 *
 * Matnni ISHLAB CHIQARUVCHI (finance) yasaydi — bot faqat transport
 * (rzGKtE9N #5). Telegram DM = title + body:
 *  - market (VICfJuoi #3): summa, sana, hisob qoldig'i oldin → keyin,
 *    "🌐 Kabinetda ochish" (`telegram_cabinet_link`); tafsilot brauzerda;
 *  - kuryer (2crjWf7v #3): "✅ N so'm qabul qilindi. Qabul qildi: <xodim>.
 *    Qoldiq: M so'm" + "👍 Tasdiqlayman" / "❗️ Noto'g'ri" (faqat audit
 *    yozuvi — kassaga ta'sir YO'Q). Guruh nishoni (`telegram.market_id`)
 *    HECH QACHON berilmaydi — faqat shaxsiy chat.
 */
export function buildPaymentReceivedPayload(
  input: PaymentReceivedInput,
): FinanceNotificationPayload | null {
  const type: FinanceNotificationType = 'finance.payment_received';
  const entry = findNotificationType(type);
  const amount = positiveAmount(input.amount);
  if (!entry || !isId(input.recipient_id) || amount === null) return null;

  const paymentId = isId(input.payment_id) ? String(input.payment_id) : null;
  const balanceAfter = finiteOrNull(input.balance_after);
  const day = formatDay(input.payment_date);
  const data: Record<string, unknown> = {
    kind: input.kind,
    amount,
    ...(paymentId ? { payment_id: paymentId } : {}),
    ...(input.payment_method ? { payment_method: input.payment_method } : {}),
    payment_day: day,
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);
  const ref = paymentId ? ` (to'lov #${paymentId})` : '';
  const money = formatMoney(amount);

  let title: string;
  let body: string;
  if (input.kind === 'market_payment') {
    title = "💰 To'lov qabul qilindi";
    const lines = [`Sizga ${money} to'landi${ref}.`, `Sana: ${day}`];
    if (balanceAfter !== null) {
      // FOR_MARKET qoldig'i — HQ ning marketga qarzi: to'lov uni kamaytiradi.
      const balanceBefore = balanceAfter + amount;
      data.balance_before = balanceBefore;
      data.balance_after = balanceAfter;
      lines.push(
        `Hisob qoldig'i: ${formatMoney(balanceBefore)} → ${formatMoney(balanceAfter)}`,
      );
    }
    body = lines.join('\n');
    data.telegram_cabinet_link = true;
  } else {
    title = 'Pul qabul qilindi';
    const accepted = cleanName(input.accepted_by_name) || 'kassa xodimi';
    data.accepted_by_name = accepted;
    if (balanceAfter !== null) data.balance_after = balanceAfter;
    body = [
      `✅ ${money} qabul qilindi${ref}.`,
      `Qabul qildi: ${accepted}.`,
      ...(balanceAfter !== null
        ? [`Qoldiq: ${formatMoney(balanceAfter)}.`]
        : []),
      `Sana: ${day}`,
    ].join('\n');
    if (paymentId) {
      data.telegram_buttons = [
        [
          {
            text: '👍 Tasdiqlayman',
            action: COURIER_PAYMENT_ACK_ACTIONS.confirm,
            payload: { payment_id: paymentId },
            one_shot: false,
          },
          {
            text: "❗️ Noto'g'ri",
            action: COURIER_PAYMENT_ACK_ACTIONS.dispute,
            payload: { payment_id: paymentId },
            one_shot: false,
          },
        ],
      ];
    }
  }

  return {
    type,
    category: entry.category,
    priority: entry.priority,
    title,
    // in_app: raqam + summa + qoldiq (mijoz PII si YO'Q).
    body,
    data,
    link: FINANCE_SELF_CASHBOX_LINK,
    recipient_ids: [String(input.recipient_id)],
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: [...entry.default_channels],
  };
}

export interface PaymentDisputedInput {
  payment_id: string | number;
  courier_id: string | number;
  courier_name?: string | null;
  amount: number | string | null | undefined;
  /** Qabul qilgan xodim + filial boshlig'i (kuryerning o'zi chiqariladi). */
  recipient_ids: Array<string | number | null | undefined>;
}

/** (2crjWf7v #4) "❗️ Noto'g'ri" — qabul qilgan xodim va filial boshlig'iga. */
export function buildPaymentDisputedPayload(
  input: PaymentDisputedInput,
): FinanceNotificationPayload | null {
  const type: FinanceNotificationType = 'finance.payment_disputed';
  const entry = findNotificationType(type);
  if (!entry || !isId(input.payment_id) || !isId(input.courier_id)) return null;
  const courierId = String(input.courier_id);
  const recipients = [
    ...new Set(
      input.recipient_ids
        .filter(isId)
        .map(String)
        .filter((id) => id !== courierId),
    ),
  ];
  if (!recipients.length) return null;
  const paymentId = String(input.payment_id);
  const amount = positiveAmount(input.amount);
  const data: Record<string, unknown> = {
    payment_id: paymentId,
    courier_id: courierId,
    ...(amount !== null ? { amount } : {}),
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);
  const courier = cleanName(input.courier_name) || `#${courierId}`;
  return {
    type,
    category: entry.category,
    priority: entry.priority,
    title: "❗️ Kuryer kvitansiyaga e'tiroz bildirdi",
    body: `Kuryer ${courier} ${amount !== null ? `${formatMoney(amount)} ` : ''}to'lov kvitansiyasini (#${paymentId}) noto'g'ri deb belgiladi. Kassa o'zgarmadi — tekshiring.`,
    data,
    link: FINANCE_SELF_CASHBOX_LINK,
    recipient_ids: recipients,
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: [...entry.default_channels],
  };
}

export interface CashReminderInput {
  courier_id: string | number;
  balance: number | string | null | undefined;
  /** Asia/Tashkent kuni (`YYYY-MM-DD`) — kuniga bitta eslatma kaliti. */
  day: string;
}

/** (2crjWf7v #2) "💰 Kassangizda X so'm — filialga topshiring" (kuniga bir marta). */
export function buildCashReminderPayload(
  input: CashReminderInput,
): FinanceNotificationPayload | null {
  const type: FinanceNotificationType = 'finance.cash_reminder';
  const entry = findNotificationType(type);
  const balance = positiveAmount(input.balance);
  if (!entry || !isId(input.courier_id) || balance === null) return null;
  const courierId = String(input.courier_id);
  const data: Record<string, unknown> = {
    courier_id: courierId,
    balance,
    day: input.day,
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);
  return {
    type,
    category: entry.category,
    priority: entry.priority,
    title: 'Kassadagi pulni topshiring',
    body: `💰 Kassangizda ${formatMoney(balance)} — filialga topshiring.`,
    data,
    link: FINANCE_SELF_CASHBOX_LINK,
    recipient_ids: [courierId],
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: [...entry.default_channels],
    client_request_id: deterministicUuid(
      `cash-reminder:${courierId}:${input.day}`,
    ),
  };
}

export type PaymentCorrectedLanguage = 'uz' | 'ru' | 'en';

export interface PaymentCorrectedInput {
  correction_id: string | number;
  action: 'reverse' | 'edit';
  recipient_id: string | number | null | undefined;
  /** Oluvchining tili (`identity.audience.resolve`); noma'lum — uz. */
  language?: string | null;
  /** Oluvchi kassasidagi asl to'lov qatori (raqam matnda). */
  payment_id: string | number | null | undefined;
  /** Asl to'lov summasi. */
  amount: number | string | null | undefined;
  /** Tahrirda — yangi summa. */
  new_amount?: number | string | null;
  /** Asl to'lov sanasi (`payment_date`, bo'lmasa yozilgan vaqt). */
  payment_date?: Date | string | null;
  /** Oluvchi kassasining qoldig'i (qaytarishda: oldin → keyin). */
  balance_before?: number | string | null;
  balance_after?: number | string | null;
}

export function normalizeCorrectionLanguage(
  value: unknown,
): PaymentCorrectedLanguage {
  const lang = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (lang.startsWith('ru')) return 'ru';
  if (lang.startsWith('en')) return 'en';
  return 'uz';
}

const CORRECTION_CURRENCY: Record<PaymentCorrectedLanguage, string> = {
  uz: "so'm",
  ru: 'сум',
  en: 'UZS',
};

const formatMoneyIn = (value: unknown, lang: PaymentCorrectedLanguage) => {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return '';
  const digits = Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${digits} ${CORRECTION_CURRENCY[lang]}`;
};

/**
 * (T6-BE-4) `finance.payment_corrected` — oluvchi tilida, SABABSIZ (sabab
 * faqat ilovadagi tafsilotda). Qaytarish: sana, summa, to'lov raqami,
 * qoldiq oldin → keyin; tahrir: eski → yangi summa. Oluvchi / summa
 * yaroqsiz — `null`.
 */
export function buildPaymentCorrectedPayload(
  input: PaymentCorrectedInput,
): FinanceNotificationPayload | null {
  const type: FinanceNotificationType = 'finance.payment_corrected';
  const entry = findNotificationType(type);
  const amount = positiveAmount(input.amount);
  if (
    !entry ||
    !isId(input.recipient_id) ||
    !isId(input.correction_id) ||
    amount === null
  ) {
    return null;
  }
  const lang = normalizeCorrectionLanguage(input.language);
  const correctionId = String(input.correction_id);
  const recipientId = String(input.recipient_id);
  const ref = isId(input.payment_id) ? String(input.payment_id) : correctionId;
  const money = (value: unknown) => formatMoneyIn(value, lang);
  const day = formatDay(input.payment_date);
  const before = finiteOrNull(input.balance_before);
  const after = finiteOrNull(input.balance_after);
  const newAmount = positiveAmount(input.new_amount);
  const data: Record<string, unknown> = {
    correction_id: correctionId,
    action: input.action,
    payment_id: ref,
    amount,
    language: lang,
    ...(newAmount !== null ? { new_amount: newAmount } : {}),
    ...(before !== null ? { balance_before: before } : {}),
    ...(after !== null ? { balance_after: after } : {}),
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);

  let title: string;
  let body: string;
  if (input.action === 'edit' && newAmount !== null) {
    const texts: Record<PaymentCorrectedLanguage, [string, string]> = {
      uz: [
        "To'lov summasi tuzatildi",
        `To'lov #${ref}: ${money(amount)} → ${money(newAmount)}.`,
      ],
      ru: [
        'Сумма платежа исправлена',
        `Платёж #${ref}: ${money(amount)} → ${money(newAmount)}.`,
      ],
      en: [
        'Payment amount corrected',
        `Payment #${ref}: ${money(amount)} → ${money(newAmount)}.`,
      ],
    };
    [title, body] = texts[lang];
  } else {
    const balance =
      before !== null && after !== null
        ? {
            uz: ` Qoldiq: ${money(before)} → ${money(after)}.`,
            ru: ` Остаток: ${money(before)} → ${money(after)}.`,
            en: ` Balance: ${money(before)} → ${money(after)}.`,
          }[lang]
        : '';
    const texts: Record<PaymentCorrectedLanguage, [string, string]> = {
      uz: [
        "To'lov qaytarildi",
        `${day} dagi ${money(amount)} to'lov (#${ref}) qaytarildi.${balance}`,
      ],
      ru: [
        'Платёж отменён',
        `Платёж #${ref} от ${day} на ${money(amount)} отменён.${balance}`,
      ],
      en: [
        'Payment reversed',
        `Payment #${ref} of ${money(amount)} on ${day} was reversed.${balance}`,
      ],
    };
    [title, body] = texts[lang];
  }

  return {
    type,
    category: entry.category,
    priority: entry.priority,
    title,
    body,
    data,
    link: FINANCE_SELF_CASHBOX_LINK,
    recipient_ids: [recipientId],
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: [...entry.default_channels],
    client_request_id: deterministicUuid(
      `payment-corrected:${correctionId}:${recipientId}`,
    ),
  };
}

/**
 * Qo'lda balans to'ldirishmi: market/kuryer kassasiga MANUAL_INCOME kirimi.
 * Tizim oyoqlari (sotuv, bekor qilish, tuzatish) va MAIN/BRANCH kassasini
 * to'ldirish (`fillTheCashbox`) — bu hodisa EMAS.
 */
export function isBalanceTopup(input: BalanceTopupInput): boolean {
  return (
    input.operation_type === Operation_type.INCOME &&
    input.source_type === Source_type.MANUAL_INCOME &&
    (input.cashbox_type === Cashbox_type.FOR_MARKET ||
      input.cashbox_type === Cashbox_type.FOR_COURIER)
  );
}

/** `finance.balance_topup` payload'i (BeePost notifyBalanceTopup matni asosida). */
export function buildBalanceTopupPayload(
  input: BalanceTopupInput,
): FinanceNotificationPayload | null {
  const type: FinanceNotificationType = 'finance.balance_topup';
  const entry = findNotificationType(type);
  const amount = positiveAmount(input.amount);
  if (
    !entry ||
    !isBalanceTopup(input) ||
    !isId(input.recipient_id) ||
    amount === null
  ) {
    return null;
  }

  const historyId = isId(input.history_id) ? String(input.history_id) : null;
  const balance = Number(input.balance_after);
  const hasBalance =
    input.balance_after !== null &&
    input.balance_after !== undefined &&
    Number.isFinite(balance);
  const data: Record<string, unknown> = {
    amount,
    cashbox_type: input.cashbox_type,
    ...(historyId ? { history_id: historyId } : {}),
    ...(hasBalance ? { balance_after: balance } : {}),
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);

  return {
    type,
    category: entry.category,
    priority: entry.priority,
    title: "Balans to'ldirildi",
    // in_app: summa + joriy balans (holat) — izoh/PII yo'q.
    body: `Balansingiz ${formatMoney(amount)} ga to'ldirildi.${
      hasBalance ? ` Joriy balans: ${formatMoney(balance)}.` : ''
    }`,
    data,
    link: FINANCE_SELF_CASHBOX_LINK,
    recipient_ids: [String(input.recipient_id)],
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: [...entry.default_channels],
  };
}

@Injectable()
export class FinanceNotificationService {
  private readonly logger = new Logger(FinanceNotificationService.name);

  constructor(private readonly outbox: OutboxService) {}

  /**
   * To'lov o'tdi. `manager` — pul yozuvlari turgan tranzaksiya: outbox qatori
   * ham AYNAN shunda (rollback bo'lsa bildirishnoma ham yo'q).
   */
  async paymentReceived(
    input: PaymentReceivedInput,
    manager?: EntityManager,
  ): Promise<void> {
    await this.enqueueSafely(
      'finance.payment_received',
      () => buildPaymentReceivedPayload(input),
      manager,
    );
  }

  /** (2crjWf7v #4) Kuryer e'tirozi — ack yozuvi bilan BITTA tranzaksiyada. */
  async paymentDisputed(
    input: PaymentDisputedInput,
    manager?: EntityManager,
  ): Promise<void> {
    await this.enqueueSafely(
      'finance.payment_disputed',
      () => buildPaymentDisputedPayload(input),
      manager,
    );
  }

  /** (2crjWf7v #2) Kassa chegarasi eslatmasi (tranzaksiyasiz, kuniga bir marta). */
  async cashReminder(input: CashReminderInput): Promise<boolean> {
    let payload: FinanceNotificationPayload | null = null;
    try {
      payload = buildCashReminderPayload(input);
    } catch {
      payload = null;
    }
    if (!payload) return false;
    await this.enqueueSafely('finance.cash_reminder', () => payload, undefined);
    return true;
  }

  /** (y8Tqm9Ap #4) Avtomatik yopish ogohlantirishi — slot kaliti bilan BITTA tranzaksiyada. */
  async shiftAutoCloseWarning(
    input: ShiftAutoCloseWarningInput,
    manager?: EntityManager,
  ): Promise<boolean> {
    let built: FinanceNotificationPayload | null = null;
    try {
      built = buildShiftAutoCloseWarningPayload(input);
    } catch {
      built = null;
    }
    if (!built) return false;
    const payload = built;
    await this.enqueueSafely(
      'finance.shift_auto_close_warning',
      () => payload,
      manager,
    );
    return true;
  }

  /**
   * (gWI4gYkw) Smena hisoboti — tayyor payload (har qabul qiluvchiga alohida,
   * deterministik `client_request_id`). `shift_report_deliveries` qatorlari
   * bilan BITTA tranzaksiyada.
   */
  async shiftReport(
    payload: FinanceNotificationPayload,
    manager?: EntityManager,
  ): Promise<void> {
    await this.enqueueSafely(payload.type, () => payload, manager);
  }

  /**
   * (T6-BE-4) To'lov qaytarildi / summasi tuzatildi — HAR oluvchiga alohida
   * (o'z tili, o'z qoldig'i). Pul yozuvlari bilan BITTA tranzaksiyada.
   */
  async paymentCorrected(
    input: PaymentCorrectedInput,
    manager?: EntityManager,
  ): Promise<void> {
    await this.enqueueSafely(
      'finance.payment_corrected',
      () => buildPaymentCorrectedPayload(input),
      manager,
    );
  }

  /** Balans qo'lda to'ldirildi (faqat market/kuryer kassasiga MANUAL_INCOME). */
  async balanceTopup(
    input: BalanceTopupInput,
    manager?: EntityManager,
  ): Promise<void> {
    await this.enqueueSafely(
      'finance.balance_topup',
      // `buildBalanceTopupPayload` o'zi `isBalanceTopup` ni tekshiradi —
      // boshqa oyoqlar uchun `null` (bildirishnoma yo'q).
      () => buildBalanceTopupPayload(input),
      manager,
    );
  }

  /**
   * Kirish ma'lumotiga HAR qanday murojaat (`build`) try ichida — payload
   * qurishdagi kutilmagan xato pul amalini YIQITMAYDI (fail-open).
   */
  private async enqueueSafely(
    type: FinanceNotificationType,
    build: () => FinanceNotificationPayload | null,
    manager: EntityManager | undefined,
  ): Promise<void> {
    const inTransaction = Boolean(manager?.queryRunner?.isTransactionActive);

    let payload: FinanceNotificationPayload | null = null;
    try {
      payload = build();
    } catch (err) {
      this.logger.warn(
        `finance notification payload (${type}) qurilmadi: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      return;
    }
    if (!payload) return;
    const ref = `recipient=${payload.recipient_ids.join(',')}`;

    try {
      await this.outbox.enqueue(
        NOTIFICATION_OUTBOX_TARGET,
        NOTIFICATION_DISPATCH_PATTERN,
        payload,
        manager ? { manager } : {},
      );
    } catch (err) {
      // Tranzaksiya ichida DB xatosi — Postgres tranzaksiyasi baribir
      // buzilgan, chaqiruvchi rollback qilsin. Tranzaksiyasiz yo'lda esa
      // bildirishnoma pul amalini yiqitmaydi (fail-open).
      if (inTransaction) throw err;
      this.logger.warn(
        `finance notification (${type}, ${ref}) outbox'ga yozilmadi: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }
}
