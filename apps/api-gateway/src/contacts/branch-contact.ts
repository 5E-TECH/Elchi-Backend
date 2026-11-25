import { Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';

/**
 * 0Rn5U6AD (P0, ega 2026-11-20 / 2026-11-25) — `GET /orders/:id` javobidagi
 * `branch` ga filial telefoni va menejeri: buyurtma kuryerga biriktirilmagan
 * bo'lsa ham xodim kimga qo'ng'iroq qilishni bilsin.
 *
 *  - Filial — buyurtma filiali (`branch_id`), posilka hozir turgan joy emas.
 *  - Kimga: SUPERADMIN, ADMIN, REGISTRATOR; MANAGER/BRANCH — faqat o'z filiali.
 *    Market, kuryer, logist va boshqalarga qo'shilmaydi.
 *  - Bitta RPC (`branch.contact`), kesh 60 s: menejer almashsa ≤ 60 s.
 *  - branch-service javob bermasa yoki eski bo'lsa — maydonlar qo'shilmaydi,
 *    buyurtma javobi buzilmaydi. Xato javob keshlanmaydi.
 */
export const BRANCH_CONTACT_CACHE_TTL_MS = 60_000;
const BRANCH_CONTACT_RPC_TIMEOUT_MS = 3000;
const CACHE_MAX_ENTRIES = 1000;
const ID_PATTERN = /^\d{1,19}$/;

export interface BranchContact {
  id: string;
  name: string | null;
  phone_number: string | null;
  manager: {
    id: string;
    name: string | null;
    phone_number: string | null;
  } | null;
}

const asId = (value: unknown): string | null => {
  const text =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  return ID_PATTERN.test(text) ? text : null;
};

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Filial kontaktini har filial uchun ko'radigan rollar. */
const ANY_BRANCH_ROLES: readonly string[] = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.REGISTRATOR,
];

/** Faqat o'z filiali kontaktini ko'radigan rollar. */
const OWN_BRANCH_ROLES: readonly string[] = [RoleEnum.MANAGER, RoleEnum.BRANCH];

/** `any` — istalgan filial, `own` — faqat o'ziniki, `none` — ko'rmaydi. */
export function branchContactScope(
  roles: string[] | undefined,
): 'any' | 'own' | 'none' {
  const normalized = (roles ?? []).map((role) =>
    String(role ?? '')
      .trim()
      .toLowerCase(),
  );
  if (normalized.some((role) => ANY_BRANCH_ROLES.includes(role))) {
    return 'any';
  }
  return normalized.some((role) => OWN_BRANCH_ROLES.includes(role))
    ? 'own'
    : 'none';
}

function parseContact(payload: unknown): BranchContact | null {
  const data = isRecord(payload) ? payload.data : null;
  const id = isRecord(data) ? asId(data.id) : null;
  if (!isRecord(data) || !id) {
    return null;
  }
  const manager = isRecord(data.manager) ? data.manager : null;
  const managerId = manager ? asId(manager.id) : null;
  return {
    id,
    name: asText(data.name),
    phone_number: asText(data.phone_number),
    manager:
      manager && managerId
        ? {
            id: managerId,
            name: asText(manager.name),
            phone_number: asText(manager.phone_number),
          }
        : null,
  };
}

export class BranchContactLoader {
  private readonly logger = new Logger(BranchContactLoader.name);
  private readonly cache = new Map<
    string,
    { contact: BranchContact; expiresAt: number }
  >();
  /** Spec'lar uchun soat. */
  now: () => number = () => Date.now();

  constructor(private readonly branchClient: ClientProxy) {}

  async find(branchId: unknown): Promise<BranchContact | null> {
    const id = asId(branchId);
    if (!id) {
      return null;
    }
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt > this.now()) {
      return cached.contact;
    }
    try {
      const contact = parseContact(
        await firstValueFrom(
          this.branchClient
            .send<unknown>({ cmd: 'branch.contact' }, { id })
            .pipe(timeout(BRANCH_CONTACT_RPC_TIMEOUT_MS)),
        ),
      );
      if (!contact) {
        return null;
      }
      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        this.cache.clear();
      }
      this.cache.set(id, {
        contact,
        expiresAt: this.now() + BRANCH_CONTACT_CACHE_TTL_MS,
      });
      return contact;
    } catch (error) {
      this.logger.warn(
        `branch.contact (id=${id}) javob bermadi: ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
  }
}

/** Buyurtma qatori (o'ramli yoki o'ramsiz) `branch` iga kontaktni qo'shadi. */
export function withBranchContact<T>(
  payload: T,
  contact: BranchContact | null,
): T {
  if (!contact || !isRecord(payload)) {
    return payload;
  }
  const merge = (row: Record<string, unknown>) => ({
    ...row,
    branch: {
      ...(isRecord(row.branch)
        ? row.branch
        : { id: contact.id, name: contact.name }),
      phone_number: contact.phone_number,
      manager: contact.manager,
    },
  });
  return (
    isRecord(payload.data)
      ? { ...payload, data: merge(payload.data) }
      : merge(payload)
  ) as T;
}
