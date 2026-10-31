export enum Roles {
  SUPERADMIN = 'superadmin',
  ADMIN = 'admin',
  COURIER = 'courier',
  REGISTRATOR = 'registrator',
  MARKET = 'market',
  CUSTOMER = 'customer',
  OPERATOR = 'operator',
  MARKET_OPERATOR = 'market_operator',
  MANAGER = 'manager',
  BRANCH = 'branch',
  INVESTOR = 'investor',
  // (dzyVftBx) Viloyatlar ustidan nazorat qiluvchi xodim: viloyatlarga
  // biriktiriladi (regions.logist_id) va hudud statistikasini ko'radi.
  // DB'dagi `identity_schema.admins_role_enum` ga 1716000000060 migratsiyasi
  // qo'shadi.
  LOGIST = 'logist',
}

export enum Status {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export enum BranchType {
  HQ = 'HQ',
  PICKUP = 'PICKUP',
  REGIONAL = 'REGIONAL',
  HYBRID = 'HYBRID',
}

/**
 * Ownership of a branch — determines how COD settles up to HQ.
 *   OWNED   → HQ's own branch: it remits the full collected amount to HQ and HQ
 *             pays the branch's staff salaries. branchShare = 0.
 *   PARTNER → partner-run branch: it keeps its per-order share (Branch.per_order_share)
 *             and pays its own staff; only HQ's portion is remitted upward.
 */
export enum BranchOwnership {
  OWNED = 'owned',
  PARTNER = 'partner',
}

/**
 * How a courier is compensated per order. Drives courierShare — the amount the
 * courier keeps from the COD they collect (the rest is owed up the chain).
 *   SALARY_ONLY          → keeps nothing per order (courierShare = 0); paid only
 *                          a monthly salary. Owes the full `total` upward.
 *   PER_ORDER            → keeps the per-order tariff (tariff_home/center); no salary.
 *   SALARY_PLUS_PER_ORDER→ keeps the tariff AND draws a monthly salary.
 */
export enum CourierCompensationMode {
  SALARY_ONLY = 'salary_only',
  PER_ORDER = 'per_order',
  SALARY_PLUS_PER_ORDER = 'salary_plus_per_order',
}

/**
 * Per-order settlement progress along the COD chain courier → branch → HQ →
 * market. Each leg is advanced (FIFO) as lump-sum payments are recorded.
 */
export enum SettlementStatus {
  PENDING = 'pending',
  COURIER_SETTLED = 'courier_settled',
  BRANCH_SETTLED = 'branch_settled',
  MARKET_SETTLED = 'market_settled',
}

export enum PaymentMethod {
  CASH = 'cash',
  CLICK = 'click',
  CLICK_TO_MARKET = 'click_to_market',
}

export enum Operation_type {
  INCOME = 'income',
  EXPENSE = 'expense',
}

export enum Commission_type {
  // Operator earns a percentage of the order's total_price.
  PERCENT = 'percent',
  // Operator earns a flat amount per sold order, regardless of price.
  FIXED = 'fixed',
}

export enum Source_type {
  COURIER_PAYMENT = 'courier_payment',
  BRANCH_TO_MAIN = 'branch_to_main',
  MARKET_PAYMENT = 'market_payment',
  MANUAL_EXPENSE = 'manual_expense',
  MANUAL_INCOME = 'manual_income',
  CORRECTION = 'correction',
  SALARY = 'salary',
  SELL = 'sell',
  CANCEL = 'cancel',
  EXTRA_COST = 'extra_cost',
  BILLS = 'bills',
  /**
   * T6 — superadmin to'lovni (kuryerdan qabul / marketga to'lov) qaytargan
   * yoki summasini tuzatgan: asl oyoqning TESKARI qatori
   * (`cashbox_history.reverses_history_id`). Asl qatorlar o'zgarmaydi.
   */
  PAYMENT_REVERSAL = 'payment_reversal',
}

/**
 * Source of a financial_balance_history ledger entry — the company-wide
 * profit/position ledger, distinct from per-cashbox Source_type movements.
 */
export enum FinancialSource_type {
  SELL_PROFIT = 'sell_profit', // Net profit from a sold order (market tariff - courier tariff)
  SELL_EXTRA_COST = 'sell_extra_cost', // Extra cost withheld when an order is sold
  CANCEL_EXTRA_COST = 'cancel_extra_cost', // Extra cost withheld when an order is cancelled
  MANUAL_INCOME = 'manual_income', // Manually recorded income
  MANUAL_EXPENSE = 'manual_expense', // Manually recorded expense
  SALARY = 'salary', // Salary paid out
  CORRECTION = 'correction', // Adjustment / rollback
  BILLS = 'bills', // Invoices / utility bills
}

/**
 * ljVOuNz4 — xarajat kategoriyasi: pul NIMAGA ketgani (`FinancialSource_type`
 * esa pul QAYERDAN yozilganini aytadi). YOPIQ ro'yxat, BeePost bilan bir xil
 * 14 ta + Elchi'ga xos 3 ta, "Boshqa" HAR DOIM oxirgi. Daftar ustuni va
 * manba qoidalari — `libs/common/src/finance/expense-category.ts`.
 */
export enum ExpenseCategory {
  FOOD = 'food',
  TRANSPORT = 'transport',
  FUEL = 'fuel',
  RENT = 'rent',
  UTILITIES = 'utilities',
  COMMUNICATION = 'communication',
  STATIONERY = 'stationery',
  REPAIR = 'repair',
  MARKETING = 'marketing',
  TAX = 'tax',
  BANK_FEE = 'bank_fee',
  GIFT = 'gift',
  CLEANING = 'cleaning',
  PACKAGING = 'packaging',
  SALARY = 'salary',
  COURIER_FEE = 'courier_fee',
  VEHICLE_REPAIR = 'vehicle_repair',
  OTHER = 'other',
}

/**
 * Situations in which a market may require a courier to attach file proof
 * (image/video) for an order operation. A market stores a SET of enabled
 * conditions (admins.expense_proof_conditions). When a sell/cancel operation
 * matches ANY enabled condition, proof becomes mandatory — otherwise the whole
 * operation is rejected. Empty/none = proof never required for that market.
 *
 * The catalog is intentionally extensible: add a new condition here and teach
 * the order-service evaluator (matchExpenseProofConditions) when it applies.
 */
export enum ExpenseProofCondition {
  SELL_ANY = 'sell_any', // har qanday sotuvda
  SELL_EXTRA_COST = 'sell_extra_cost', // sotishda qo'shimcha xarajat yozilganda
  SELL_ZERO_TOTAL = 'sell_zero_total', // 0 summali buyurtma sotilganda
  CANCEL_ANY = 'cancel_any', // har qanday bekor qilishda
  CANCEL_EXTRA_COST = 'cancel_extra_cost', // bekor qilishda qo'shimcha xarajat yozilganda
  CANCEL_ZERO_TOTAL = 'cancel_zero_total', // 0 summali buyurtma bekor qilinganda
}

export enum Order_status {
  CREATED = 'created',
  NEW = 'new',
  RECEIVED = 'received',
  ON_THE_ROAD = 'on the road',
  WAITING = 'waiting',
  WAITING_CUSTOMER = 'waiting_customer',
  SOLD = 'sold',
  CANCELLED = 'cancelled',
  RETURNED_TO_MARKET = 'returned_to_market',
  PAID = 'paid',
  PARTLY_PAID = 'partly_paid',
  CANCELLED_SENT = 'cancelled (sent)',
  CLOSED = 'closed',
}

/**
 * T8 (0OUcHZ7R) — buyurtmaning MAXSUS BELGILARI (ehtiyot bo'lish kerak bo'lgan
 * yuk turi). Bir buyurtmada bir nechtasi bo'lishi mumkin; DB'da
 * `order_schema.orders.special_categories varchar(32)[]` (CHECK aynan shu
 * kodlar bilan — 1716000000187). Belgi pulga ham, holatga ham TA'SIR QILMAYDI.
 */
export enum OrderSpecialCategory {
  FRAGILE = 'fragile',
  RELIGIOUS_BOOK = 'religious_book',
  LIQUID = 'liquid',
  PERISHABLE = 'perishable',
  BATTERY = 'battery',
  HEAVY = 'heavy',
  DOCUMENTS = 'documents',
}

/** Kanonik tartib: API har doim shu tartibda qaytaradi. */
export const ORDER_SPECIAL_CATEGORIES: readonly OrderSpecialCategory[] =
  Object.freeze([
    OrderSpecialCategory.FRAGILE,
    OrderSpecialCategory.RELIGIOUS_BOOK,
    OrderSpecialCategory.LIQUID,
    OrderSpecialCategory.PERISHABLE,
    OrderSpecialCategory.BATTERY,
    OrderSpecialCategory.HEAVY,
    OrderSpecialCategory.DOCUMENTS,
  ]);

/**
 * Xato xabaridagi qiymat — `String(raw)` CHAQIRILMAYDI: `{ toString: null }`
 * kabi obyekt TypeError (500) berardi. Satr 64 belgigacha kesiladi.
 */
function describeSpecialCategoryInput(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;
  }
  if (
    typeof raw === 'number' ||
    typeof raw === 'boolean' ||
    typeof raw === 'bigint'
  ) {
    return String(raw);
  }
  return raw === null ? 'null' : typeof raw;
}

export type NormalizeSpecialCategoriesResult =
  { ok: true; value: OrderSpecialCategory[] } | { ok: false; message: string };

/**
 * Kirgan ro'yxatni tekshiradi va kanonik tartibga keltiradi.
 * `undefined` / `null` → `[]`. Massiv emas, noma'lum kod yoki takror kod →
 * `ok:false` (chaqiruvchi 400 qaytaradi). DTO'ni chetlab o'tadigan yo'llar
 * (bot, hamkor API, AI tasdiqlash) ham shu funksiyadan o'tadi.
 */
export function normalizeSpecialCategories(
  input: unknown,
): NormalizeSpecialCategoriesResult {
  if (input === undefined || input === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(input)) {
    return {
      ok: false,
      message: "special_categories massiv bo'lishi kerak",
    };
  }
  const seen = new Set<string>();
  for (const raw of input) {
    if (
      typeof raw !== 'string' ||
      !ORDER_SPECIAL_CATEGORIES.includes(raw as OrderSpecialCategory)
    ) {
      return {
        ok: false,
        message: `Noma'lum maxsus belgi: ${describeSpecialCategoryInput(raw)}`,
      };
    }
    if (seen.has(raw)) {
      return { ok: false, message: `Maxsus belgi takrorlangan: ${raw}` };
    }
    seen.add(raw);
  }
  return {
    ok: true,
    value: ORDER_SPECIAL_CATEGORIES.filter((code) => seen.has(code)),
  };
}

/**
 * Bekor qilish sababi — YOPIQ ro'yxat (Andijon E2E, PUvKXWVw).
 *
 * Ilgari sabab erkin, ixtiyoriy matn edi va bekor qilishlarni tahlil qilib
 * bo'lmasdi. Kod `orders.return_reason` ga yoziladi; `OTHER` da erkin matn
 * (`comment`) majburiy.
 */
/**
 * (DuST9k8j #3) Qo'shimcha xarajatni rad etish sabablari — YOPIQ ro'yxat
 * (bot va panel bir xil; erkin matn sabab sifatida qabul qilinmaydi — 400).
 */
export enum ExtraCostRejectReason {
  TOO_EXPENSIVE = 'TOO_EXPENSIVE',
  NOT_AGREED = 'NOT_AGREED',
  NO_PROOF = 'NO_PROOF',
  DUPLICATE = 'DUPLICATE',
}

export const EXTRA_COST_REJECT_REASON_LABELS: Readonly<
  Record<ExtraCostRejectReason, string>
> = Object.freeze({
  [ExtraCostRejectReason.TOO_EXPENSIVE]: 'Summa juda katta',
  [ExtraCostRejectReason.NOT_AGREED]: 'Xarajat kelishilmagan',
  [ExtraCostRejectReason.NO_PROOF]: 'Isbot yetarli emas',
  [ExtraCostRejectReason.DUPLICATE]: "Takroriy so'rov",
});

export enum CancelReason {
  CUSTOMER_NO_ANSWER = 'CUSTOMER_NO_ANSWER',
  CUSTOMER_REFUSED = 'CUSTOMER_REFUSED',
  WRONG_ADDRESS = 'WRONG_ADDRESS',
  DEFECTIVE_PRODUCT = 'DEFECTIVE_PRODUCT',
  PRICE_DISPUTE = 'PRICE_DISPUTE',
  OTHER = 'OTHER',
}

export enum Cashbox_type {
  MAIN = 'main',
  FOR_COURIER = 'couriers',
  FOR_MARKET = 'markets',
  BRANCH = 'branch',
}

export enum Where_deliver {
  CENTER = 'center',
  ADDRESS = 'address',
}

export enum Post_status {
  NEW = 'new',
  SENT = 'sent',
  RECEIVED = 'received',
  CANCELED = 'canceled',
  CANCELED_RECEIVED = 'canceled_received',
}

export enum Manual_payment_methods {
  CASH = 'cash',
  CARD = 'card',
}

export enum Group_type {
  CANCEL = 'cancel',
  CREATE = 'create',
}

export enum BranchUserRole {
  MANAGER = 'MANAGER',
  REGISTRATOR = 'REGISTRATOR',
  COURIER = 'COURIER',
}

export enum BranchTransferDirection {
  FORWARD = 'FORWARD',
  RETURN = 'RETURN',
}

export enum BranchTransferBatchStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}

export enum BranchTransferBatchAction {
  CREATED = 'CREATED',
  SENT = 'SENT',
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}

/**
 * Delivery channels a notification can fan out to. A single dispatch may request
 * several. `IN_APP` is the persisted inbox row; the others are side-effects.
 */
export enum NotificationChannel {
  IN_APP = 'in_app',
  REALTIME = 'realtime',
  TELEGRAM = 'telegram',
  EMAIL = 'email',
  SMS = 'sms',
  // Web Push (brauzer/telefon). DB migratsiya kerak emas — `channels` ustuni JSONB.
  PUSH = 'push',
}

/** Severity / surfacing hint for the frontend (badge colour, sound, etc). */
export enum NotificationPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  CRITICAL = 'critical',
}

/**
 * Stable, coarse grouping for inbox filtering/tabs. The fine-grained event is
 * carried by the free-form `type` string (e.g. `order.sold`, `finance.paid`).
 */
export enum NotificationCategory {
  ORDER = 'order',
  FINANCE = 'finance',
  BRANCH = 'branch',
  LOGISTICS = 'logistics',
  ACCOUNT = 'account',
  SYSTEM = 'system',
  MARKETING = 'marketing',
}

/**
 * Per-channel delivery outcome recorded on the notification row
 * (`notifications.delivery` JSONB — yangi qiymat uchun migratsiya KERAK EMAS).
 *
 * (uFmUS86e) `delivery.realtime` uchun `SENT` ishlatilmaydi: gateway ack
 * qaytarmaydi, navbatda iste'molchi bo'lmasa xabar jimgina yo'qoladi. Shuning
 * uchun muvaffaqiyatli emit = `EMITTED` (brokerga topshirildi), `SENT` —
 * faqat haqiqiy tasdiq (Telegram API `ok`) bo'lganda.
 */
export enum NotificationDeliveryStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  /** Navbatga qo'yildi (push/SMS outbox) — yetkazish keyin, asinxron. */
  QUEUED = 'queued',
  /** Realtime: brokerga emit qilindi (ack yo'q — `sent` EMAS). */
  EMITTED = 'emitted',
  /** Kanal so'raldi, lekin provayder ulanmagan (email, SMS akkaunti yo'q). */
  NO_PROVIDER = 'no_provider',
  /** Kanal so'raldi, lekin nishon yo'q (masalan marketda Telegram guruhi yo'q). */
  NOT_ELIGIBLE = 'not_eligible',
  /**
   * (Jht84wGp TC3) Push so'raldi, lekin foydalanuvchida faol push obunasi
   * yo'q — `not_eligible` ning push uchun aniq ko'rinishi.
   */
  NO_SUBSCRIPTION = 'no_subscription',
}
