import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

/**
 * (pe71yf8L) «Oxirgi kirish» va «Online / Offline» qaysi qatorlarda:
 * market akkaunti va market operatori (har biri O'Z akkaunti — operator
 * market qatoriga qo'shilmaydi). Xodimlar qatorlarida maydon yo'q.
 */
export const USER_ACTIVITY_ROLES: ReadonlySet<string> = new Set([
  'market',
  'market_operator',
]);

const ACTIVITY_TIMEOUT_MS = 3_000;

interface ActivityItem {
  user_id?: unknown;
  last_login_at?: unknown;
  last_seen_at?: unknown;
}

export interface UserActivityDeps {
  identity: ClientProxy;
  /** `RealtimeGateway.isPresent` — kamida bitta socket (yoki 45 s kutish). */
  isPresent: (userId: string) => boolean;
  onError?: (error: unknown) => void;
}

const isoOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;

/** Qator / javob id'si kalit sifatida (faqat matn yoki son). */
const idKey = (value: unknown): string | null =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint'
    ? String(value)
    : null;

const roleOf = (row: Record<string, unknown>): string =>
  typeof row.role === 'string' ? row.role.toLowerCase() : '';

/**
 * `GET /users` / `GET /users/:id` qatorlariga (joyida) qo'shadi:
 * `is_online` (gateway xotirasi), `last_login_at`, `last_seen_at`
 * (identity `user_activity`; hech kirmagan — `null`). Identity javob
 * bermasa — `last_*` qo'shilmaydi (FE «—»), `is_online` baribir bor;
 * ro'yxat / tafsilot xatoga aylanmaydi.
 *
 * Ruxsat CHAQIRUVCHIDA: faqat SA / admin / menejer (mavjud `GET /users`
 * ko'lami). Boshqa endpointlar (`GET /markets` va h.k.) buni chaqirmaydi.
 */
export async function attachUserActivity(
  rows: readonly unknown[],
  deps: UserActivityDeps,
): Promise<void> {
  const targets: Array<{ row: Record<string, unknown>; id: string }> = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const id = idKey(record.id);
    if (id && USER_ACTIVITY_ROLES.has(roleOf(record)))
      targets.push({ row: record, id });
  }
  if (!targets.length) return;

  for (const { row, id } of targets) {
    row.is_online = deps.isPresent(id);
  }

  let items: ActivityItem[];
  try {
    const response = (await firstValueFrom(
      deps.identity
        .send(
          { cmd: 'identity.user.activity.find_by_ids' },
          { user_ids: targets.map((target) => target.id) },
        )
        .pipe(timeout(ACTIVITY_TIMEOUT_MS)),
    )) as { items?: unknown } | undefined;
    items = Array.isArray(response?.items)
      ? (response.items as ActivityItem[])
      : [];
  } catch (error) {
    deps.onError?.(error);
    return;
  }

  const byId = new Map<string, ActivityItem>();
  for (const item of items) {
    const key = item ? idKey(item.user_id) : null;
    if (key) byId.set(key, item);
  }
  for (const { row, id } of targets) {
    const item = byId.get(id);
    row.last_login_at = isoOrNull(item?.last_login_at);
    row.last_seen_at = isoOrNull(item?.last_seen_at);
  }
}
