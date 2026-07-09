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

/** Per-channel delivery outcome recorded on the notification row. */
export enum NotificationDeliveryStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}
