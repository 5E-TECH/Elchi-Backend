import {
  ORDER_ROLLBACK_ERROR_CODES,
  ORDER_ROLLBACK_MESSAGES,
  type OrderRollbackEligibility,
} from '@app/common';

/**
 * (2026-11-19, D1–D4) Buyurtma ro'yxati / tafsilotiga
 * `rollback: { allowed, code, message }` maydoni — joriy foydalanuvchi uchun.
 *
 * Qaror order-service'da (`order.rollback_eligibility` — rollback endpointi
 * bilan AYNI funksiya), sahifaga BITTA so'rov (N+1 yo'q). FE tugmani
 * `rollback.allowed` dan, sababni `rollback.message` dan oladi.
 *
 *  • rollback qila olmaydigan rol (superadmin / menejer / kuryer emas) —
 *    so'rovsiz `NOT_ALLOWED_ROLE` (faqat shu maydonda; endpointning o'zi
 *    bunday rolga RolesGuard'ning umumiy 403 ini qaytaradi, kodsiz);
 *  • order-service javob bermasa — `rollback: null` (noma'lum; ro'yxat
 *    yiqilmaydi, FE tugmani ko'rsatmaydi yoki bosilganda server qaror qiladi).
 */
type Send = (
  pattern: { cmd: string },
  data: Record<string, unknown>,
) => Promise<unknown>;

/** Faqat satr / son id (obyekt `[object Object]` bo'lib ketmasin). */
const idOf = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const ROLLBACK_ROLES = new Set(['superadmin', 'manager', 'courier']);
const MAX_IDS = 200;

interface RowRef {
  row: Record<string, unknown>;
  id: string;
}

function collectRows(payload: unknown): {
  refs: RowRef[];
  rebuild: (
    rows: Map<Record<string, unknown>, Record<string, unknown>>,
  ) => unknown;
} {
  const isRow = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    /^\d{1,18}$/.test(idOf((value as Record<string, unknown>).id));
  const refsOf = (rows: unknown[]): RowRef[] =>
    rows.filter(isRow).map((row) => ({ row, id: idOf(row.id) }));
  const replace = (
    rows: unknown[],
    map: Map<Record<string, unknown>, Record<string, unknown>>,
  ) => rows.map((row) => (isRow(row) ? (map.get(row) ?? row) : row));

  if (Array.isArray(payload)) {
    return {
      refs: refsOf(payload),
      rebuild: (map) => replace(payload, map),
    };
  }
  if (payload && typeof payload === 'object') {
    const body = payload as Record<string, unknown>;
    if (Array.isArray(body.data)) {
      const rows = body.data as unknown[];
      return {
        refs: refsOf(rows),
        rebuild: (map) => ({ ...body, data: replace(rows, map) }),
      };
    }
    // `successRes({ data: [...], total })` — `{ data: { data: [...] } }`.
    const inner = body.data as Record<string, unknown> | null | undefined;
    if (inner && typeof inner === 'object' && Array.isArray(inner.data)) {
      const rows = inner.data as unknown[];
      return {
        refs: refsOf(rows),
        rebuild: (map) => ({
          ...body,
          data: { ...inner, data: replace(rows, map) },
        }),
      };
    }
    if (isRow(body.data)) {
      const row = body.data;
      return {
        refs: [{ row, id: idOf(row.id) }],
        rebuild: (map) => ({ ...body, data: map.get(row) ?? row }),
      };
    }
    if (isRow(body)) {
      return {
        refs: [{ row: body, id: idOf(body.id) }],
        rebuild: (map) => map.get(body) ?? body,
      };
    }
  }
  return { refs: [], rebuild: () => payload };
}

export async function attachRollbackEligibility<T>(
  payload: T,
  user:
    { sub?: string | number; roles?: unknown; branch_id?: unknown } | undefined,
  send: Send,
): Promise<T> {
  const { refs, rebuild } = collectRows(payload);
  if (!refs.length || !user?.sub) return payload;
  const roles = (Array.isArray(user.roles) ? user.roles : [])
    .map((role) => String(role).toLowerCase())
    .filter(Boolean);

  const decisions = new Map<string, OrderRollbackEligibility | null>();
  if (!roles.some((role) => ROLLBACK_ROLES.has(role))) {
    const denied: OrderRollbackEligibility = {
      allowed: false,
      code: ORDER_ROLLBACK_ERROR_CODES.NOT_ALLOWED_ROLE,
      message: ORDER_ROLLBACK_MESSAGES.NOT_ALLOWED_ROLE,
    };
    for (const ref of refs) decisions.set(ref.id, denied);
  } else {
    // C4 — 200 talik bo'laklar (RPC chegarasi), parallel; bo'lak xatosi
    // faqat o'z qatorlarini `rollback: null` qiladi.
    const ids = [...new Set(refs.map((ref) => ref.id))];
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += MAX_IDS) {
      chunks.push(ids.slice(i, i + MAX_IDS));
    }
    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const response = (await send(
            { cmd: 'order.rollback_eligibility' },
            {
              order_ids: chunk,
              requester: {
                id: String(user.sub),
                roles,
                branch_id: idOf(user.branch_id) || null,
              },
            },
          )) as {
            data?: {
              items?: Array<{
                order_id?: unknown;
                allowed?: unknown;
                code?: unknown;
                message?: unknown;
              }>;
            };
          } | null;
          for (const item of response?.data?.items ?? []) {
            decisions.set(String(item.order_id), {
              allowed: item.allowed === true,
              code:
                typeof item.code === 'string'
                  ? (item.code as OrderRollbackEligibility['code'])
                  : null,
              message: typeof item.message === 'string' ? item.message : null,
            });
          }
        } catch {
          // Noma'lum — `rollback: null`.
        }
      }),
    );
  }

  const replaced = new Map<Record<string, unknown>, Record<string, unknown>>();
  for (const ref of refs) {
    replaced.set(ref.row, {
      ...ref.row,
      rollback: decisions.get(ref.id) ?? null,
    });
  }
  return rebuild(replaced) as T;
}
