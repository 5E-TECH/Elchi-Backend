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
