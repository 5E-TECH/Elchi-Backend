import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { projectOrderPayloadForRoles } from './order-role-projection';

/**
 * 4BftLLnc — LOGIST DOIRASI (gateway'dagi yagona yordamchi).
 *
 * Ega qarori 2026-10-19: LG-S1 — logist buyurtmalar, tracking, pochta,
 * paketlar va kuryerlarni FAQAT KO'RADI, moliyaga aralashmaydi (pul maydonlari
 * yo'q); LG-S3 — faqat o'ziga biriktirilgan viloyatlar (`regions.logist_id`).
 *
 * Manba — logistics `logistics.region.find_by_logist` (qisqa kesh). Viloyat
 * biriktirilmagan logist — bo'sh to'plam: ro'yxatlar bo'sh (403 emas), bitta
 * obyekt — 403. Logistics javob bermasa — 503 (FAIL-CLOSED: hech qachon
 * "doirasiz" ro'yxat qaytmaydi).
 *
 * Doira serverda (gateway + servis) qo'llanadi: logist so'rovdagi
 * `region_id` bilan doirani kengaytira olmaydi — to'plamdan tashqari viloyat
 * so'ralsa 400.
 */

/** Kesh muddati: admin viloyatni qayta biriktirsa ko'pi bilan shuncha kechikadi. */
export const LOGIST_REGION_CACHE_TTL_MS = 30_000;
const LOGIST_REGION_CACHE_MAX = 500;
const LOGIST_REGION_RPC_TIMEOUT_MS = 5000;
const BIGINT_ID_RE = /^[0-9]{1,19}$/;

export const LOGIST_REGIONS_UNAVAILABLE_MESSAGE =
  "Logist viloyatlarini aniqlab bo'lmadi — birozdan so'ng qayta urinib ko'ring";
export const LOGIST_REGION_FILTER_MESSAGE = 'Bu viloyat sizga biriktirilmagan';

/**
 * Logist roli boshqa doirali rol bilan birga kelsa (JWT'da amalda bitta rol)
 * o'sha rolning mavjud qoidasi ustun — logist tarmog'i faqat "sof" logistga.
 */
const ROLES_WITH_OWN_SCOPE: readonly string[] = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.MANAGER,
  RoleEnum.BRANCH,
  RoleEnum.REGISTRATOR,
  RoleEnum.COURIER,
  RoleEnum.MARKET,
  RoleEnum.MARKET_OPERATOR,
  RoleEnum.CUSTOMER,
];

const normalizeRoles = (roles?: readonly unknown[] | null): string[] =>
  (roles ?? [])
    .map((role) => (typeof role === 'string' ? role.trim().toLowerCase() : ''))
    .filter(Boolean);

/** So'rovchi logist doirasida ishlaydimi (boshqa doirali rolsiz LOGIST). */
export function isLogistRequester(roles?: readonly unknown[] | null): boolean {
  const normalized = normalizeRoles(roles);
  return (
    normalized.includes(RoleEnum.LOGIST) &&
    !normalized.some((role) => ROLES_WITH_OWN_SCOPE.includes(role))
  );
}

/**
 * Logist javobidan pul maydonlarini olib tashlaydi (auth/order-role-projection
 * LOGIST proyeksiyasi — narx, summa, tarif, ulush, maosh, balans, tushum).
 * Logist bo'lmagan so'rovchi uchun javob O'ZGARMAYDI (asl havola).
 */
export function projectLogistPayload<T>(
  roles: readonly unknown[] | null | undefined,
  payload: T,
): T {
  if (!isLogistRequester(roles)) {
    return payload;
  }
  return projectOrderPayloadForRoles(normalizeRoles(roles), payload);
}

/** Viloyat id'si (bigint satr) yoki '' — taqqoslash uchun kanonik ko'rinish. */
export function canonicalRegionId(value: unknown): string {
  const raw =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  if (!BIGINT_ID_RE.test(raw)) {
    return '';
  }
  const canonical = BigInt(raw).toString();
  return canonical === '0' ? '' : canonical;
}

/**
 * So'rovdagi viloyat filtri logist to'plami ichidami. Bo'sh filtr — `null`
 * (butun to'plam). To'plamdan tashqari / buzuq id — 400.
 */
export function resolveLogistRegionFilter(
  requested: unknown,
  regionIds: readonly string[],
): string | null {
  const raw =
    typeof requested === 'string' || typeof requested === 'number'
      ? String(requested).trim()
      : '';
  if (!raw) {
    return null;
  }
  const canonical = canonicalRegionId(raw);
  if (!canonical || !regionIds.includes(canonical)) {
    throw new BadRequestException(LOGIST_REGION_FILTER_MESSAGE);
  }
  return canonical;
}

/** Qatorning `key` viloyati logist to'plamidami (himoya qatlami). */
export function isRowInLogistRegions(
  row: unknown,
  regionIds: readonly string[],
  key = 'region_id',
): boolean {
  if (!row || typeof row !== 'object') {
    return false;
  }
  const record = row as Record<string, unknown>;
  const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const regionId = canonicalRegionId(record[key] ?? record[camel]);
  return Boolean(regionId) && regionIds.includes(regionId);
}

@Injectable()
export class LogistRegionScopeService {
  private readonly logger = new Logger(LogistRegionScopeService.name);
  private readonly cache = new Map<string, { ids: string[]; at: number }>();

  constructor(
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
  ) {}

  /**
   * Logistning viloyat id'lari (kanonik, takrorsiz). Biriktirilmagan — `[]`.
   * Logistics xato/timeout yoki buzuq javob — 503 (fail-closed, keshlanmaydi).
   */
  async regionIds(logistId: unknown): Promise<string[]> {
    const id = canonicalRegionId(logistId);
    if (!id) {
      return [];
    }
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < LOGIST_REGION_CACHE_TTL_MS) {
      return hit.ids;
    }

    let response: unknown;
    try {
      response = await firstValueFrom(
        this.logisticsClient
          .send({ cmd: 'logistics.region.find_by_logist' }, { logist_id: id })
          .pipe(timeout(LOGIST_REGION_RPC_TIMEOUT_MS)),
      );
    } catch (error) {
      this.logger.warn(
        `logistics.region.find_by_logist (${id}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException(LOGIST_REGIONS_UNAVAILABLE_MESSAGE);
    }

    const raw = (response as { data?: { region_ids?: unknown } } | null)?.data
      ?.region_ids;
    if (!Array.isArray(raw)) {
      throw new ServiceUnavailableException(LOGIST_REGIONS_UNAVAILABLE_MESSAGE);
    }
    const ids = Array.from(
      new Set(raw.map((value) => canonicalRegionId(value)).filter(Boolean)),
    );

    if (this.cache.size >= LOGIST_REGION_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(id, { ids, at: Date.now() });
    return ids;
  }
}
