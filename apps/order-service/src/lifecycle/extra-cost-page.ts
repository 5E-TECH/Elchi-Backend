import { RpcException } from '@nestjs/microservices';
import {
  resolveExtraCostAutoApproveMinutes,
  resolveExtraCostAutoApproveReminderMinutes,
  Roles,
} from '@app/common';
import type { OrderExtraCostApproval } from '../entities/order-extra-cost-approval.entity';

/**
 * (GykuOz8f) «Qo'shimcha xarajatli buyurtmalar» sahifasi — kuryer, filial
 * menejeri, market va market operatori. Tablar:
 *  - `all` — hammasi (tasdiqsiz yozilgan `immediate` va `reversed` ham);
 *  - `pending` — market hali qaror qilmagan;
 *  - `approved` — market tasdiqlagan, avtomatik tasdiqlangan va tasdiqsiz
 *    yozilgan (`immediate`);
 *  - `cancelled` — rad etilgan (`rejected`) va o'zi yopilgan (`void`).
 */
export const EXTRA_COST_TABS = [
  'all',
  'pending',
  'approved',
  'cancelled',
] as const;
export type ExtraCostTab = (typeof EXTRA_COST_TABS)[number];

/** Tab → `status` qiymatlari (`all` — cheklovsiz). */
export const EXTRA_COST_TAB_STATUSES: Readonly<
  Record<ExtraCostTab, readonly string[] | null>
> = Object.freeze({
  all: null,
  pending: ['pending'],
  approved: ['approved'],
  cancelled: ['rejected', 'void'],
});

export type ExtraCostCounts = Record<ExtraCostTab, number>;

/** Bo'sh / berilmagan — `all`; noma'lum qiymat — `null` (chaqiruvchi 400). */
export function parseExtraCostTab(value: unknown): ExtraCostTab | null {
  if (value === undefined || value === null || value === '') return 'all';
  const tab = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (EXTRA_COST_TABS as readonly string[]).includes(tab)
    ? (tab as ExtraCostTab)
    : null;
}

/**
 * Ko'rish doirasi — FAQAT token (gateway) ma'lumotidan; so'rovdagi kuryer /
 * market / filial id'siga ishonilmaydi:
 *  - kuryer — o'zi yozganlari;
 *  - menejer — filial kuryerlarining so'rovlari (so'rov paytidagi filial,
 *    `requester_branch_id` = JWT filiali) va o'zi yozganlari; filiali yo'q
 *    menejer — faqat o'zinikilari. Boshqa menejerlarning so'rovi ko'rinmaydi;
 *  - market — o'z marketi; market operatori — gateway identity'dan qo'ygan
 *    market (faqat o'qish), biriktirilmagan — 403;
 *  - admin / superadmin va boshqa rollar — 403 (sahifa ularga yo'q).
 */
export type ExtraCostScope =
  | { kind: 'market'; marketId: string; readOnly: boolean }
  | { kind: 'manager'; userId: string; branchId: string | null }
  | { kind: 'courier'; userId: string };

export type ExtraCostPageRequester = {
  id: string;
  roles?: string[];
  branch_id?: string | null;
  market_id?: string | null;
};

const forbidden = (message: string): never => {
  throw new RpcException({ statusCode: 403, message });
};

const idText = (value: unknown): string => {
  const raw =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  return /^\d+$/.test(raw) ? raw : '';
};

export function resolveExtraCostScope(
  requester: ExtraCostPageRequester | null | undefined,
): ExtraCostScope {
  const roles = new Set(
    (requester?.roles ?? []).map((role) => String(role).trim().toLowerCase()),
  );
  const userId = idText(requester?.id);
  const denied = "Qo'shimcha xarajatli buyurtmalarni ko'rish mumkin emas";
  if (!userId || roles.has(Roles.SUPERADMIN) || roles.has(Roles.ADMIN)) {
    return forbidden(denied);
  }
  if (roles.has(Roles.MARKET)) {
    return { kind: 'market', marketId: userId, readOnly: false };
  }
  if (roles.has(Roles.MARKET_OPERATOR)) {
    const marketId = idText(requester?.market_id);
    if (!marketId) {
      return forbidden('Operator hech qaysi marketga biriktirilmagan');
    }
    return { kind: 'market', marketId, readOnly: true };
  }
  if (roles.has(Roles.MANAGER)) {
    return {
      kind: 'manager',
      userId,
      branchId: idText(requester?.branch_id) || null,
    };
  }
  if (roles.has(Roles.COURIER)) {
    return { kind: 'courier', userId };
  }
  return forbidden(denied);
}

/** Doira sharti (`alias` — so'rovlar jadvali taxallusi) va parametrlari. */
export function extraCostScopeWhere(
  scope: ExtraCostScope,
  alias = 'a',
): { sql: string; params: Record<string, string> } {
  if (scope.kind === 'market') {
    return {
      sql: `${alias}.market_id = :scopeMarketId`,
      params: { scopeMarketId: scope.marketId },
    };
  }
  if (scope.kind === 'manager' && scope.branchId) {
    return {
      sql:
        `((${alias}.requester_branch_id = :scopeBranchId AND ${alias}.requested_by_role = :scopeCourierRole)` +
        ` OR ${alias}.requested_by_user_id = :scopeUserId)`,
      params: {
        scopeBranchId: scope.branchId,
        scopeCourierRole: Roles.COURIER,
        scopeUserId: scope.userId,
      },
    };
  }
  return {
    sql: `${alias}.requested_by_user_id = :scopeUserId`,
    params: { scopeUserId: scope.userId },
  };
}

/** `GROUP BY status` natijasi → tablar soni. */
export function buildExtraCostCounts(
  rows: ReadonlyArray<{ status: unknown; count: unknown }>,
): ExtraCostCounts {
  const counts: ExtraCostCounts = {
    all: 0,
    pending: 0,
    approved: 0,
    cancelled: 0,
  };
  for (const row of rows ?? []) {
    const count = Number(row?.count ?? 0);
    if (!Number.isFinite(count) || count <= 0) continue;
    const status = typeof row?.status === 'string' ? row.status : '';
    counts.all += count;
    for (const tab of ['pending', 'approved', 'cancelled'] as const) {
      if (EXTRA_COST_TAB_STATUSES[tab]?.includes(status)) counts[tab] += count;
    }
  }
  return counts;
}

/**
 * (AFZaUUi5) Avtomatik tasdiq vaqti: muddat boshi + `EXTRA_COST_AUTO_APPROVE_MINUTES`
 * (ExtraCostAutoApproveScheduler bilan bitta qoida: bo'sh — 1440). Muddat
 * boshi — `auto_approve_from`; skaner hali belgilamagan bo'lsa (NULL) —
 * u qanday belgilasa shunday: muddatdan eski so'rov — hozir (yoqilgan
 * payt), qolgani — `createdAt`. Skaner tasdiqni eslatmadan kamida
 * `EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES` keyin qiladi: eslatma kech
 * ketgan (yoki hali ketmagan, muddat esa o'tgan) bo'lsa — eslatma + shu
 * daqiqalar (bir tikdan kam farq ko'rsatilmaydi — oddiy holatda muddat
 * so'rov vaqti + 24 soat bo'lib qoladi). Infratuzilma xatosidan keyin
 * urinish kechiktirilgan bo'lsa — keyingi urinish vaqti.
 *
 * (GykuOz8f) Buyurtma javobidagi `pending_extra_cost_approval` ham shu
 * funksiyadan (order-service.service) — so'rov ro'yxati bilan bir qiymat.
 */
export function computeExtraCostAutoApproveAt(
  approval: Pick<
    OrderExtraCostApproval,
    | 'status'
    | 'createdAt'
    | 'auto_approve_from'
    | 'auto_retry_at'
    | 'reminder_sent_at'
  >,
  now = Date.now(),
): string | null {
  if (approval.status !== 'pending') return null;
  const minutes = resolveExtraCostAutoApproveMinutes(
    process.env.EXTRA_COST_AUTO_APPROVE_MINUTES,
  );
  const reminderMinutes = resolveExtraCostAutoApproveReminderMinutes(
    process.env.EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES,
  );
  let from = new Date(approval.auto_approve_from ?? NaN).getTime();
  if (!Number.isFinite(from)) {
    const createdAt = new Date(approval.createdAt ?? NaN).getTime();
    if (!Number.isFinite(createdAt)) return null;
    from = createdAt <= now - minutes * 60_000 ? now : createdAt;
  }
  let due = from + minutes * 60_000;
  if (reminderMinutes < minutes) {
    const reminded = new Date(approval.reminder_sent_at ?? NaN).getTime();
    const afterReminder =
      (Number.isFinite(reminded) ? reminded : now) + reminderMinutes * 60_000;
    if (afterReminder > due + 60_000) due = afterReminder;
  }
  const retry = approval.auto_retry_at
    ? new Date(approval.auto_retry_at).getTime()
    : NaN;
  return new Date(
    Number.isFinite(retry) ? Math.max(due, retry) : due,
  ).toISOString();
}

/** Buyurtma javobidagi kutilayotgan so'rov belgisi (`pending_extra_cost_approval`). */
export type PendingExtraCostApprovalView = {
  id: string;
  action: string;
  amount: number;
  created_at: string | null;
  auto_approve_at: string | null;
};

/**
 * (GykuOz8f) `pending_extra_cost_approval` — faqat buyurtma «kutilmoqda»
 * (`waiting`) va o'chirilmagan ochiq so'rov bo'lsa; aks holda yo'q (null).
 * Partial unique indeks bitta buyurtmada bittadan ortiq ochiq so'rovga yo'l
 * qo'ymaydi.
 */
export function pendingExtraCostApprovalView(
  approval: Pick<
    OrderExtraCostApproval,
    | 'id'
    | 'action'
    | 'amount'
    | 'status'
    | 'createdAt'
    | 'auto_approve_from'
    | 'auto_retry_at'
    | 'reminder_sent_at'
  >,
): PendingExtraCostApprovalView {
  const createdAt = approval.createdAt ? new Date(approval.createdAt) : null;
  return {
    id: String(approval.id),
    action: String(approval.action),
    amount: Number(approval.amount ?? 0),
    created_at:
      createdAt && Number.isFinite(createdAt.getTime())
        ? createdAt.toISOString()
        : null,
    auto_approve_at: computeExtraCostAutoApproveAt(approval),
  };
}
