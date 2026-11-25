import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { asText } from './report-labels';

/**
 * Hisobotlardagi ismlar — BULK va FAIL-OPEN: xato yoki kechikish bo'lsa fayl
 * baribir chiqadi (`#id` / «Filial #id» ko'rinadi).
 */
const NAMES_TIMEOUT_MS = 5000;
/** identity `find_by_ids` bitta chaqiruvda 500 tagacha qabul qiladi. */
const USER_CHUNK = 500;
/** branch `find_all` sahifani 100 bilan cheklaydi. */
const BRANCH_PAGE = 100;
const BRANCH_MAX_PAGES = 10;

const nameMap = (rows: unknown): Map<string, string> => {
  const names = new Map<string, string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const item = row as { id?: unknown; name?: unknown } | null;
    const id = asText(item?.id).trim();
    const name = asText(item?.name).trim();
    if (id && name) names.set(id, name);
  }
  return names;
};

const ask = (client: ClientProxy, cmd: string, payload: unknown) =>
  firstValueFrom(
    client.send<unknown>({ cmd }, payload).pipe(timeout(NAMES_TIMEOUT_MS)),
  );

const dataOf = (response: unknown): unknown =>
  (response as { data?: unknown } | null | undefined)?.data;

/** Xodim ismlari (`identity.user.find_by_ids`). */
export async function fetchUserNames(
  client: ClientProxy | undefined,
  ids: readonly unknown[],
): Promise<Map<string, string>> {
  const unique = [
    ...new Set(
      ids.map((id) => asText(id).trim()).filter((id) => /^\d+$/.test(id)),
    ),
  ];
  const names = new Map<string, string>();
  if (!client || !unique.length) return names;
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += USER_CHUNK) {
    chunks.push(unique.slice(i, i + USER_CHUNK));
  }
  const parts = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        return nameMap(
          dataOf(
            await ask(client, 'identity.user.find_by_ids', { ids: chunk }),
          ),
        );
      } catch {
        return new Map<string, string>();
      }
    }),
  );
  for (const part of parts) {
    for (const [id, name] of part) names.set(id, name);
  }
  return names;
}

/** Filial nomlari (`branch.find_all`) — faqat kerak bo'lganda chaqiriladi. */
export async function fetchBranchNames(
  client: ClientProxy | undefined,
  requester: { id: string; roles: string[] },
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!client) return names;
  const deadline = Date.now() + NAMES_TIMEOUT_MS;
  try {
    for (let page = 1; page <= BRANCH_MAX_PAGES; page += 1) {
      const data = dataOf(
        await ask(client, 'branch.find_all', {
          query: { page, limit: BRANCH_PAGE },
          requester,
        }),
      ) as { items?: unknown } | null | undefined;
      const items = Array.isArray(data?.items) ? data.items : [];
      for (const [id, name] of nameMap(items)) names.set(id, name);
      if (items.length < BRANCH_PAGE || Date.now() > deadline) break;
    }
  } catch {
    // fail-open: olingan nomlar bilan davom etamiz.
  }
  return names;
}

/** Bitta filial nomi (`branch.find_by_id`) — menejer o'z filiali. */
export async function fetchBranchName(
  client: ClientProxy | undefined,
  branchId: string,
  requester: { id: string; roles: string[] },
): Promise<string | null> {
  if (!client) return null;
  try {
    const data = dataOf(
      await ask(client, 'branch.find_by_id', { id: branchId, requester }),
    ) as { name?: unknown } | null | undefined;
    return asText(data?.name).trim() || null;
  } catch {
    return null;
  }
}

/** Kassa kartalari nomi (`finance.cashbox.cards.list`, nofaollari ham). */
export async function fetchCardNames(
  client: ClientProxy | undefined,
  branchId: string | null,
): Promise<Map<string, string>> {
  if (!client) return new Map();
  try {
    const data = dataOf(
      await ask(client, 'finance.cashbox.cards.list', {
        include_inactive: true,
        ...(branchId ? { branch_id: branchId } : {}),
      }),
    ) as { cards?: unknown } | null | undefined;
    return nameMap(data?.cards);
  } catch {
    return new Map();
  }
}
