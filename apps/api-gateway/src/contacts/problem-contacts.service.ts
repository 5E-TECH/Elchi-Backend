import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { CONTACT_PATTERNS } from '@app/common';
import type { ProblemContact } from '@app/common';

/**
 * T7 (QPq2C1co, B2) — buyurtma javoblariga `problem_contacts` («Muammo
 * bo'lsa»): buyurtma viloyati (`region_id`; yo'q — tuman viloyati) logisti,
 * u yo'q/nofaol — zaxira raqamlar (identity `identity.contacts.problem`).
 *
 *  - N+1 YO'Q: javobdagi barcha buyurtmalarning viloyat/tuman id lari
 *    yig'ilib, keshda yo'qlari BITTA RPC bilan so'raladi.
 *  - Kesh 60 s (viloyat/tuman kaliti bo'yicha): logist almashsa ≤ 60 s da
 *    yangi raqam. Xato javob keshlanmaydi.
 *  - identity javob bermasa — `problem_contacts` QO'SHILMAYDI (FE uni
 *    «raqam yo'q» deb ko'rsatadi; market/operator raqamiga qaytmaydi),
 *    buyurtma javobining o'zi buzilmaydi.
 *  - Har rolga qo'shiladi (market ham yorliq chop etadi);
 *    `projectOrderPayloadForRoles` dan OLDIN chaqiriladi.
 */

export const PROBLEM_CONTACTS_CACHE_TTL_MS = 60_000;
const PROBLEM_CONTACTS_RPC_TIMEOUT_MS = 5000;
const CACHE_MAX_ENTRIES = 5000;
const MAX_DEPTH = 32;
const ID_PATTERN = /^\d{1,19}$/;

export interface ProblemContactsRef {
  region_id?: unknown;
  district_id?: unknown;
}

const asId = (value: unknown): string | null => {
  const text =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  return ID_PATTERN.test(text) ? String(BigInt(text)) : null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Buyurtma qatori: `market_id` VA `customer_id` kalitlari bor obyekt
 * (market/mijoz foydalanuvchi yozuvida `customer_id` yo'q).
 */
const isOrderRow = (row: Record<string, unknown>): boolean =>
  ('market_id' in row || 'marketId' in row) &&
  ('customer_id' in row || 'customerId' in row);

const nestedId = (value: unknown): unknown =>
  isPlainObject(value) ? value.id : undefined;

/** Qatorning kesh kaliti: `r:<viloyat>` → `d:<tuman>` → `-` (aniqlanmagan). */
export function problemContactsKey(
  row: ProblemContactsRef & Record<string, unknown>,
): string {
  const regionId =
    asId(row.region_id) ?? asId(row.regionId) ?? asId(nestedId(row.region));
  if (regionId) {
    return `r:${regionId}`;
  }
  const districtId =
    asId(row.district_id) ??
    asId(row.districtId) ??
    asId(nestedId(row.district));
  return districtId ? `d:${districtId}` : '-';
}

function collectOrderRows(
  value: unknown,
  rows: Array<Record<string, unknown>>,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectOrderRows(item, rows, depth + 1));
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  if (isOrderRow(value)) {
    rows.push(value);
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') {
      collectOrderRows(nested, rows, depth + 1);
    }
  }
}

interface CacheEntry {
  contacts: ProblemContact[];
  expiresAt: number;
}

interface ProblemContactsReply {
  regions?: Record<string, ProblemContact[]>;
  districts?: Record<string, ProblemContact[]>;
  fallback?: ProblemContact[];
}

@Injectable()
export class ProblemContactsService {
  private readonly logger = new Logger(ProblemContactsService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /** Spec'lar uchun soat. */
  now: () => number = () => Date.now();

  constructor(
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private cached(key: string): ProblemContact[] | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.contacts;
  }

  private remember(key: string, contacts: ProblemContact[]): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      this.cache.clear();
    }
    this.cache.set(key, {
      contacts,
      expiresAt: this.now() + PROBLEM_CONTACTS_CACHE_TTL_MS,
    });
  }

  /**
   * Kalitlar (`r:<id>`, `d:<id>`, `-`) → aloqalar. Keshda yo'qlari BITTA RPC
   * bilan. identity xatosi — `null` (chaqiruvchi maydon qo'shmaydi).
   */
  async resolveKeys(
    keys: string[],
  ): Promise<Map<string, ProblemContact[]> | null> {
    const unique = [...new Set(keys)];
    const result = new Map<string, ProblemContact[]>();
    const missing: string[] = [];
    for (const key of unique) {
      const hit = this.cached(key);
      if (hit) {
        result.set(key, hit);
      } else {
        missing.push(key);
      }
    }
    if (!missing.length) {
      return result;
    }

    const regionIds = missing
      .filter((key) => key.startsWith('r:'))
      .map((key) => key.slice(2));
    const districtIds = missing
      .filter((key) => key.startsWith('d:'))
      .map((key) => key.slice(2));
    let reply: ProblemContactsReply | undefined;
    try {
      const response = await firstValueFrom(
        this.identityClient
          .send<{ data?: ProblemContactsReply }>(
            { cmd: CONTACT_PATTERNS.PROBLEM_CONTACTS },
            { region_ids: regionIds, district_ids: districtIds },
          )
          .pipe(timeout(PROBLEM_CONTACTS_RPC_TIMEOUT_MS)),
      );
      reply = response?.data;
    } catch (error) {
      this.logger.warn(
        `identity.contacts.problem failed (${missing.length} keys): ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
    if (!reply || typeof reply !== 'object') {
      return null;
    }

    const fallback = Array.isArray(reply.fallback) ? reply.fallback : [];
    for (const key of missing) {
      const id = key.slice(2);
      const list = key.startsWith('r:')
        ? reply.regions?.[id]
        : key.startsWith('d:')
          ? reply.districts?.[id]
          : fallback;
      const contacts = Array.isArray(list) ? list : fallback;
      this.remember(key, contacts);
      result.set(key, contacts);
    }
    return result;
  }

  /** Bir nechta buyurtma (printer qatorlari) uchun — tartib saqlanadi. */
  async resolveMany(
    refs: ProblemContactsRef[],
  ): Promise<Array<ProblemContact[]> | null> {
    const keys = refs.map((ref) =>
      problemContactsKey(ref as ProblemContactsRef & Record<string, unknown>),
    );
    const resolved = await this.resolveKeys(keys);
    return resolved ? keys.map((key) => resolved.get(key) ?? []) : null;
  }

  /**
   * Javob daraxtidagi HAR buyurtma qatoriga `problem_contacts` qo'shadi
   * (konvert shakli muhim emas: `data`, `data.data`, `items`,
   * `allOrdersByPostId`...). Joyida (in place) — RMQ javobi yangi obyekt.
   */
  async attach<T>(payload: T): Promise<T> {
    const rows: Array<Record<string, unknown>> = [];
    collectOrderRows(payload, rows, 0);
    if (!rows.length) {
      return payload;
    }
    const keys = rows.map((row) => problemContactsKey(row));
    const resolved = await this.resolveKeys(keys);
    if (!resolved) {
      return payload;
    }
    rows.forEach((row, index) => {
      row.problem_contacts = (resolved.get(keys[index]) ?? []).map(
        (contact) => ({ ...contact }),
      );
    });
    return payload;
  }
}

/** Ixtiyoriy servis bilan (spec'lar controller'ni usiz quradi). */
export function attachProblemContacts<T>(
  service: ProblemContactsService | undefined | null,
  payload: T,
): Promise<T> {
  return service ? service.attach(payload) : Promise.resolve(payload);
}
