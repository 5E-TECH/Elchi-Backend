import {
  DEFAULT_CABINET_URL as CABINET_DEFAULT_URL,
  WEB_ROUTES,
  cabinetLinks,
  escapeTelegramHtml,
} from '@app/common';
import {
  autoClosedLabel,
  tashkentDateTime,
} from '../shift-auto-close/shift-schedule.rules';

/**
 * gWI4gYkw — smena hisoboti XABARLARI (sof funksiyalar). Har qabul qiluvchi
 * uchun matn FAQAT o'sha qabul qiluvchining bo'lagidan quriladi:
 *  - kuryer — faqat o'zi topshirgan to'lovlar (summa, soni, qolgan qarzi);
 *  - market — faqat o'ziga qilingan to'lovlar (summa, usul, karta) va qoldiq;
 *  - superadmin — to'liq xulosa (+ PDF/XLSX ilova).
 * Boshqa kuryer / market ma'lumoti builder'ga UMUMAN berilmaydi (IDOR).
 */

/** Panel manzili sukuti — yagona manba `libs/common` `cabinet-links` (PIJN1lGp). */
export const DEFAULT_CABINET_URL = CABINET_DEFAULT_URL;

const cabinetLink = (base: string): string =>
  `\n\n🌐 <a href="${cabinetLinks(base).selfCashbox()}">Kabinetda ochish</a>`;
/**
 * Market GURUHI xabari havolasi — bosh sahifa. `/cash-box` guruhdagi
 * operator / kuryerga 403 (FE `hasSelfCashboxAccess`: courier/market/manager);
 * kassa havolasi faqat egasining shaxsiy xabarida.
 */
const cabinetHomeLink = (base: string): string =>
  `\n\n🌐 <a href="${cabinetLinks(base).home()}">Kabinetni ochish</a>`;

export const SHIFT_REPORT_LINK = (shiftId: string) =>
  WEB_ROUTES.shiftReport.replace(':id', encodeURIComponent(shiftId));
/** Kuryer / market o'z kassasi sahifasi. */
export const SELF_CASHBOX_LINK = WEB_ROUTES.cashbox;

export interface ShiftMoneyBlock {
  opening_balance: number | null;
  total_income: number | null;
  total_expense: number | null;
  expected_balance: number | null;
  closing_balance: number | null;
  discrepancy: number | null;
}

export interface ShiftAccountLine {
  card_id: string;
  name: string;
  last4: string | null;
  expected_balance: number | null;
  entered_balance: number | null;
  difference: number | null;
  ai_status: string;
}

export interface CourierSlice {
  courier_id: string;
  name: string | null;
  count: number;
  /** Smenadagi SOF qabul: topshirilgan − (T6) shu smenada qaytarilgani. */
  total: number;
  /** (T6) Shu smenada qaytarilgan / tuzatilgan to'lovlar summasi (bo'lsa). */
  reversed?: number;
  /** (T6) Qaytarish bo'lsa — smenadagi yalpi topshirilgan summa. */
  received?: number;
  /** Kuryer kassasidagi joriy qoldiq (qarz) — hisobot paytida. */
  remaining_debt: number | null;
}

export interface MarketPaymentLine {
  history_id: string;
  amount: number;
  payment_method: string;
  card_name: string | null;
  at: Date | string;
  /** (T6) Teskari qator — to'lov qaytarilgan (summa manfiy). */
  reversed?: boolean;
}

export interface MarketSlice {
  market_id: string;
  name: string | null;
  payments: MarketPaymentLine[];
  total: number;
  /** Market kassasidagi joriy qoldiq (HQ ning marketga qarzi). */
  balance: number | null;
}

export interface ShiftReportSnapshot {
  shift_id: string;
  round: number;
  cashbox_type: 'main' | 'branch';
  cashbox_user_id: string;
  opened_at: Date | string;
  closed_at: Date | string | null;
  opened_by: string | null;
  opened_by_name: string | null;
  closed_by: string | null;
  closed_by_name: string | null;
  close_reason: 'manual' | 'auto';
  cash: ShiftMoneyBlock;
  card: ShiftMoneyBlock;
  accounts: ShiftAccountLine[];
  couriers: CourierSlice[];
  markets: MarketSlice[];
  /**
   * Oldingi smena yopilgandan shu smena ochilguncha (SMENASIZ) shu kassadagi
   * harakat — hech qaysi smena kirim/chiqimiga kirmagan, faqat ochilish
   * qoldig'ida. Yo'q — `null` / berilmagan.
   */
  between_shifts?: {
    from: Date | string;
    to: Date | string;
    income: number;
    expense: number;
    count: number;
  } | null;
}

/** «Smenalar orasida» qatori (harakat bo'lmasa — `null`). */
export function betweenShiftsLine(
  snapshot: Pick<ShiftReportSnapshot, 'between_shifts'>,
): string | null {
  const gap = snapshot.between_shifts;
  if (!gap || !gap.count) return null;
  return `⚠️ Smenalar orasida (smenasiz, ${tashkentDateTime(gap.from)} → ${tashkentDateTime(gap.to)}): kirim ${formatSom(gap.income)}, chiqim ${formatSom(gap.expense)} (${gap.count} ta) — ochilish qoldig'ida`;
}

export const formatSom = (value: unknown): string => {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return '—';
  const sign = amount < 0 ? '−' : '';
  return `${sign}${Math.round(Math.abs(amount))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm`;
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'naqd',
  click: 'karta',
  click_to_market: "kartaga o'tkazma",
};

export const AI_STATUS_LABELS: Record<string, string> = {
  match: 'mos',
  mismatch: 'mos emas',
  unreadable: "o'qilmadi",
  error: 'AI xatosi',
  pending: 'tekshirilmoqda',
  disabled: "AI o'chiq",
  not_required: 'tasdiqlanmagan',
};

const methodLabel = (method: string) => PAYMENT_METHOD_LABELS[method] ?? method;

const cashboxLabel = (snapshot: ShiftReportSnapshot) =>
  snapshot.cashbox_type === 'main'
    ? 'Asosiy kassa'
    : `Filial kassasi #${snapshot.cashbox_user_id}`;

const discrepancyText = (value: number | null) =>
  value == null ? 'sanalmadi' : formatSom(value);

export interface ShiftReportMessage {
  title: string;
  body: string;
  data: Record<string, unknown>;
  link: string;
}

const baseData = (snapshot: ShiftReportSnapshot) => ({
  shift_id: snapshot.shift_id,
  round: String(snapshot.round),
  close_reason: snapshot.close_reason,
  auto_closed: snapshot.close_reason === 'auto',
  closed_at: snapshot.closed_at
    ? new Date(snapshot.closed_at).toISOString()
    : null,
});

/**
 * Superadmin — to'liq xulosa. Telegram ilova izohi (caption) 1024 belgigacha
 * — shuning uchun matn qisqa, to'liq jadval ilovada.
 */
export function buildSuperadminMessage(
  snapshot: ShiftReportSnapshot,
  fileKey: string | null,
): ShiftReportMessage {
  const auto = snapshot.close_reason === 'auto';
  const isBranch = snapshot.cashbox_type === 'branch';
  const statusCounts = new Map<string, number>();
  for (const line of snapshot.accounts) {
    statusCounts.set(
      line.ai_status,
      (statusCounts.get(line.ai_status) ?? 0) + 1,
    );
  }
  const accountsText = snapshot.accounts.length
    ? `Kartalar: ${snapshot.accounts.length} ta — ${[...statusCounts.entries()]
        .map(([status, n]) => `${AI_STATUS_LABELS[status] ?? status} ${n}`)
        .join(', ')}`
    : null;
  const courierTotal = snapshot.couriers.reduce((s, c) => s + c.total, 0);
  const marketTotal = snapshot.markets.reduce((s, m) => s + m.total, 0);
  const lines = [
    `${cashboxLabel(snapshot)} · ${tashkentDateTime(snapshot.opened_at)} → ${tashkentDateTime(snapshot.closed_at)}`,
    ...(auto ? [`⏰ ${autoClosedLabel(snapshot.closed_at)}`] : []),
    `${isBranch ? 'Jami' : 'Naqd'}: ${formatSom(snapshot.cash.opening_balance)} → kutilgan ${formatSom(snapshot.cash.expected_balance)} (kirim ${formatSom(snapshot.cash.total_income)}, chiqim ${formatSom(snapshot.cash.total_expense)}); farq: ${discrepancyText(snapshot.cash.discrepancy)}`,
    // 63HO6cBU — filial smenasi bitta jami: karta qatori yo'q.
    ...(isBranch
      ? []
      : [
          `Karta: ${formatSom(snapshot.card.opening_balance)} → kutilgan ${formatSom(snapshot.card.expected_balance)} (kirim ${formatSom(snapshot.card.total_income)}, chiqim ${formatSom(snapshot.card.total_expense)}); farq: ${discrepancyText(snapshot.card.discrepancy)}`,
        ]),
    ...(accountsText && !isBranch ? [accountsText] : []),
    ...(betweenShiftsLine(snapshot) ? [betweenShiftsLine(snapshot)!] : []),
    `Kuryerlar: ${snapshot.couriers.length} ta, ${formatSom(courierTotal)} · Marketlar: ${snapshot.markets.length} ta, ${formatSom(marketTotal)}`,
    ...(fileKey ? ["📎 To'liq hisobot ilovada."] : []),
  ];
  return {
    title: auto
      ? `⏰ Smena #${snapshot.shift_id} avtomatik yopildi`
      : `🧾 Smena #${snapshot.shift_id} yopildi`,
    body: lines.join('\n').slice(0, 900),
    data: {
      ...baseData(snapshot),
      kind: 'superadmin',
      cashbox_type: snapshot.cashbox_type,
      cashbox_user_id: snapshot.cashbox_user_id,
      cash_discrepancy: snapshot.cash.discrepancy,
      card_discrepancy: isBranch ? null : snapshot.card.discrepancy,
      couriers_count: snapshot.couriers.length,
      markets_count: snapshot.markets.length,
      ...(fileKey
        ? { telegram_media: [fileKey], report_file_key: fileKey }
        : {}),
      telegram_cabinet_link: true,
    },
    link: SHIFT_REPORT_LINK(snapshot.shift_id),
  };
}

/** Kuryer — FAQAT o'z bo'lagi (`slice`). */
export function buildCourierMessage(
  snapshot: Pick<
    ShiftReportSnapshot,
    'shift_id' | 'round' | 'close_reason' | 'closed_at'
  >,
  slice: CourierSlice,
): ShiftReportMessage {
  const lines = [
    `Smena #${snapshot.shift_id} (${tashkentDateTime(snapshot.closed_at)}) yakuni:`,
    slice.reversed
      ? `Topshirgan: ${formatSom(slice.received ?? slice.total + slice.reversed)} (${slice.count} ta) · Qaytarilgan: ${formatSom(slice.reversed)} · Sof: ${formatSom(slice.total)}`
      : `Siz topshirgan: ${formatSom(slice.total)} (${slice.count} ta to'lov)`,
    ...(slice.remaining_debt != null
      ? [`Qolgan qarzingiz: ${formatSom(slice.remaining_debt)}`]
      : []),
  ];
  return {
    title: 'Smena yakuni — topshirgan pulingiz',
    body: lines.join('\n'),
    data: {
      ...baseData(snapshot as ShiftReportSnapshot),
      kind: 'courier',
      courier_id: slice.courier_id,
      total: slice.total,
      count: slice.count,
      ...(slice.reversed
        ? { reversed: slice.reversed, received: slice.received ?? null }
        : {}),
      remaining_debt: slice.remaining_debt,
      telegram_cabinet_link: true,
    },
    link: SELF_CASHBOX_LINK,
  };
}

/** (BOT-2 #3) Market guruhiga ketadigan summasiz xabar sarlavhasi. */
export const MARKET_GROUP_NOTICE_TITLE = 'Smena yakunlandi — kabinetda ko‘ring';

/** Market — FAQAT o'z to'lovlari (`slice`). */
export function buildMarketMessage(
  snapshot: Pick<
    ShiftReportSnapshot,
    'shift_id' | 'round' | 'close_reason' | 'closed_at'
  >,
  slice: MarketSlice,
  cabinetUrl = DEFAULT_CABINET_URL,
): ShiftReportMessage & { group_text: string } {
  const paymentLines = slice.payments
    .slice(0, 20)
    .map(
      (line) =>
        `• ${formatSom(line.amount)} — ${methodLabel(line.payment_method)}${
          line.card_name ? ` (${line.card_name})` : ''
        }${line.reversed ? ' — qaytarildi' : ''}`,
    );
  if (slice.payments.length > 20) {
    paymentLines.push(`… yana ${slice.payments.length - 20} ta`);
  }
  const lines = [
    `Smena #${snapshot.shift_id} (${tashkentDateTime(snapshot.closed_at)}) yakuni — sizga to'lovlar:`,
    ...paymentLines,
    `Jami: ${formatSom(slice.total)}`,
    ...(slice.balance != null
      ? [`Hisobingizdagi qoldiq: ${formatSom(slice.balance)}`]
      : []),
  ];
  const title = "Smena yakuni — sizga to'lovlar";
  const body = lines.join('\n');
  return {
    title,
    body,
    data: {
      ...baseData(snapshot as ShiftReportSnapshot),
      kind: 'market',
      market_id: slice.market_id,
      total: slice.total,
      count: slice.payments.length,
      balance: slice.balance,
      payments: slice.payments.slice(0, 20).map((line) => ({
        amount: line.amount,
        payment_method: line.payment_method,
        card_name: line.card_name,
        ...(line.reversed ? { reversed: true } : {}),
      })),
    },
    link: SELF_CASHBOX_LINK,
    /**
     * (BOT-2 #3) Market GURUHI uchun — SUMMASIZ. Pul (summa, to'lov usuli,
     * karta, qoldiq) faqat egasining SHAXSIY chatiga ketadi; guruhga
     * (operatorlar, kuryerlar ham a'zo) faqat «yakunlandi — kabinetda
     * ko'ring». Faqat egasi Telegram'ga ulanmagan bo'lsa ishlatiladi.
     */
    group_text: `<b>${escapeTelegramHtml(MARKET_GROUP_NOTICE_TITLE)}</b>\n\n${escapeTelegramHtml(
      `Smena #${snapshot.shift_id} yakunlandi — to'lovlarni kabinetda ko'ring.`,
    )}${cabinetHomeLink(cabinetUrl)}`,
  };
}

/** Ro'yxatda ko'rsatiladigan kuryer / market qatorlari soni (qolgani «… yana N ta»). */
const BRANCH_LIST_LIMIT = 10;

const branchLabel = (
  snapshot: Pick<ShiftReportSnapshot, 'cashbox_type' | 'cashbox_user_id'>,
  branchName: string | null | undefined,
): string => {
  const name = String(branchName ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (snapshot.cashbox_type === 'main') {
    return name ? `Asosiy kassa (${name})` : 'Asosiy kassa';
  }
  return name
    ? `«${name}» filiali`
    : `Filial kassasi #${snapshot.cashbox_user_id}`;
};

const moneyLine = (label: string, block: ShiftMoneyBlock): string =>
  `${label}: ${formatSom(block.opening_balance)} → kutilgan ${formatSom(block.expected_balance)} (kirim ${formatSom(block.total_income)}, chiqim ${formatSom(block.total_expense)})` +
  (block.closing_balance != null
    ? `\n   Sanalgan: ${formatSom(block.closing_balance)} · farq: ${discrepancyText(block.discrepancy)}`
    : `\n   Farq: ${discrepancyText(block.discrepancy)}`);

/**
 * Filial kassasi hisoboti — filial GURUHIGA yoki (filial `private`)
 * menejerlarning SHAXSIY chatiga. To'liq kassa xulosasi: qoldiq, kirim /
 * chiqim, sanalgan va farq, kuryerlardan qabul va marketlarga to'lovlar
 * (ism + summa, birinchi 10 tasi). Filial kassasi bitta jami chelak
 * (63HO6cBU) — karta qatori faqat asosiy kassada.
 *
 * `telegram_text` — guruh uchun tayyor HTML (escape qilingan).
 */
export function buildBranchMessage(
  snapshot: ShiftReportSnapshot,
  branchName: string | null | undefined,
  cabinetUrl = DEFAULT_CABINET_URL,
): ShiftReportMessage & { telegram_text: string } {
  const auto = snapshot.close_reason === 'auto';
  const label = branchLabel(snapshot, branchName);
  const isMain = snapshot.cashbox_type === 'main';
  const courierTotal = snapshot.couriers.reduce((sum, c) => sum + c.total, 0);
  const marketTotal = snapshot.markets.reduce((sum, m) => sum + m.total, 0);
  const courierLines = [...snapshot.couriers]
    .sort((a, b) => b.total - a.total)
    .slice(0, BRANCH_LIST_LIMIT)
    .map(
      (c) =>
        `   • ${c.name ?? `Kuryer #${c.courier_id}`} — ${formatSom(c.total)} (${c.count} ta)`,
    );
  if (snapshot.couriers.length > BRANCH_LIST_LIMIT) {
    courierLines.push(
      `   … yana ${snapshot.couriers.length - BRANCH_LIST_LIMIT} ta`,
    );
  }
  const marketLines = [...snapshot.markets]
    .sort((a, b) => b.total - a.total)
    .slice(0, BRANCH_LIST_LIMIT)
    .map(
      (m) =>
        `   • ${m.name ?? `Market #${m.market_id}`} — ${formatSom(m.total)}`,
    );
  if (snapshot.markets.length > BRANCH_LIST_LIMIT) {
    marketLines.push(
      `   … yana ${snapshot.markets.length - BRANCH_LIST_LIMIT} ta`,
    );
  }
  const lines = [
    `Smena #${snapshot.shift_id} · ${tashkentDateTime(snapshot.opened_at)} → ${tashkentDateTime(snapshot.closed_at)}`,
    auto
      ? `⏰ ${autoClosedLabel(snapshot.closed_at)}`
      : `👤 Yopdi: ${snapshot.closed_by_name ?? (snapshot.closed_by ? `#${snapshot.closed_by}` : '—')}`,
    '',
    ...(isMain
      ? [
          moneyLine('💵 Naqd', snapshot.cash),
          moneyLine('💳 Karta', snapshot.card),
        ]
      : [moneyLine('💰 Kassa', snapshot.cash)]),
    ...(betweenShiftsLine(snapshot) ? [betweenShiftsLine(snapshot)!] : []),
    '',
    `⬇️ Kuryerlardan qabul: ${formatSom(courierTotal)} (${snapshot.couriers.length} ta kuryer)`,
    ...courierLines,
    `⬆️ Marketlarga to'lov: ${formatSom(marketTotal)} (${snapshot.markets.length} ta market)`,
    ...marketLines,
  ];
  const title = auto
    ? `⏰ ${label} — kassa avtomatik yopildi`
    : `🧾 ${label} — kassa yopildi`;
  const body = lines.join('\n').slice(0, 3000);
  return {
    title,
    body,
    data: {
      ...baseData(snapshot),
      kind: 'branch',
      cashbox_type: snapshot.cashbox_type,
      cashbox_user_id: snapshot.cashbox_user_id,
      expected_balance: snapshot.cash.expected_balance,
      closing_balance: snapshot.cash.closing_balance,
      discrepancy: snapshot.cash.discrepancy,
      couriers_count: snapshot.couriers.length,
      couriers_total: Math.round(courierTotal * 100) / 100,
      markets_count: snapshot.markets.length,
      markets_total: Math.round(marketTotal * 100) / 100,
      telegram_cabinet_link: true,
    },
    link: SHIFT_REPORT_LINK(snapshot.shift_id),
    telegram_text: `<b>${escapeTelegramHtml(title)}</b>\n\n${escapeTelegramHtml(body)}\n\n🌐 <a href="${cabinetLinks(cabinetUrl).shiftReport(snapshot.shift_id)}">Kabinetda ochish</a>`,
  };
}

/** Telegram `delivery` sababi → «Hisobot kimlarga yuborildi» blokidagi matn. */
export function deliveryReasonText(reason: string | null | undefined): string {
  const value = String(reason ?? '').trim();
  if (!value) return 'yuborilmadi';
  if (value === 'no_telegram_id' || value === 'telegram_not_linked') {
    return 'Telegram ulanmagan';
  }
  if (value === 'bot_blocked' || value.startsWith('blocked_by_user')) {
    return 'Botni bloklagan';
  }
  if (value === 'not_private_chat') return 'Shaxsiy chat emas';
  if (value === 'no_telegram_group' || value === 'telegram_target_missing') {
    return 'Telegram guruhi ulanmagan';
  }
  if (value === 'no_provider') return 'Telegram bot sozlanmagan';
  if (value === 'branch_group_inactive') {
    return 'Filial guruhi nofaol (bot chiqarilgan yoki huquqi olingan)';
  }
  if (value === 'disabled_by_settings') return "Sozlamada o'chirilgan";
  return value.slice(0, 200);
}
