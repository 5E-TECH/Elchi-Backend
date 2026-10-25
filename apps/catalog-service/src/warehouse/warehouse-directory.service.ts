import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { BranchType, BranchUserRole, Status } from '@app/common';

/** Boshqa servislar bilan ishlaganda "tizim" so'rovchisi (o'qish uchun). */
const SYSTEM_REQUESTER = { id: 'system', roles: ['superadmin'] };
const RPC_TIMEOUT_MS = 5000;
/** Filial ma'lumoti keshi — har buyurtmada branch-service'ga bormaslik uchun. */
const BRANCH_CACHE_TTL_MS = 30_000;
/**
 * Pa1KaXmj: HQ filial id topilmasa (404, bo'sh javob) yoki branch-service
 * javob bermasa — shu muddat qayta so'ralmaydi (`null`). Aks holda servis
 * sekin bo'lganda har o'qish chaqiruvi RPC timeout'ini kutardi. Topilgan id
 * esa MUDDATSIZ saqlanadi — `getHqBranchId` izohi.
 */
const HQ_RETRY_BACKOFF_MS = 30_000;
/**
 * Pa1KaXmj: o'qish yo'li (ro'yxat, tafsilot, market qoldig'i, `find_by_ids`)
 * HQ id'ni ko'pi bilan shuncha kutadi. U yerda `kind` — faqat zaxira (filial
 * ma'lumoti bo'lmasa); order-service boyitishi (`loadWarehouseRefs`, 3 s)
 * branch-service'ga bog'lanib qolmasin. Kutish tugasa so'rov fonda davom etadi
 * va keshni to'ldiradi.
 */
export const HQ_ID_READ_WAIT_MS = 500;

/** `promise` yoki `ms` o'tgach `fallback` — qaysi biri oldin bo'lsa. */
const withDeadline = <T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

export interface WarehouseBranchInfo {
  id: string;
  name: string;
  type: string | null;
  status: string | null;
  address: string | null;
  region_id: string | null;
  region: { id: string; name: string } | null;
  /** Pa1KaXmj: HQ filiali (turi `HQ`; holatidan qat'i nazar). */
  is_hq: boolean;
  /**
   * Pa1KaXmj: bu filialda ombor ochish mumkin — faol, o'chirilmagan
   * REGIONAL, HYBRID yoki HQ (Markaziy ombor). PICKUP — hech qachon.
   */
  can_host_warehouse: boolean;
  /**
   * Viloyat filiali (REGIONAL/HYBRID), faol va o'chirilmagan — buyurtma
   * manbasi nomzodi (`resolve_source`/`availability`). HQ — HECH QACHON
   * (uning `region_id` si bo'lsa ham).
   */
  regional: boolean;
}

export interface WarehouseUserInfo {
  id: string;
  name: string | null;
  phone_number: string | null;
  role: string | null;
}

export interface WarehouseMarketInfo {
  id: string;
  name: string;
  status: string | null;
  can_order_from_warehouse: boolean;
}

const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** `{ data: X }` yoki X — ikkalasidan X. */
const unwrap = (value: unknown): unknown => {
  const record = asRecord(value);
  return record && 'data' in record ? record.data : value;
};

/** Pa1KaXmj: ombor ochish mumkin bo'lgan filial turlari. */
const HOST_BRANCH_TYPES = new Set<string>([
  BranchType.REGIONAL,
  BranchType.HYBRID,
  BranchType.HQ,
]);
/** Viloyat ombori (buyurtma manbasi nomzodi) turlari — HQ'siz. */
const REGIONAL_BRANCH_TYPES = new Set<string>([
  BranchType.REGIONAL,
  BranchType.HYBRID,
]);

/**
 * hY7uacJu: ombor moduli uchun boshqa servislardan ma'lumot (filial, viloyat,
 * xodim, market). Hamma chaqiruv `firstValueFrom + timeout` — `rmqSend`
 * EMAS: u masofaviy 4xx xatoni ham qayta yuboradi (o'qish uchun foydasiz).
 * O'qish (boyitish) xatosi — `null`; yozishdagi tekshiruv xatosi — 503.
 */
@Injectable()
export class WarehouseDirectoryService implements OnModuleInit {
  private readonly logger = new Logger(WarehouseDirectoryService.name);
  private readonly branchCache = new Map<
    string,
    { at: number; value: WarehouseBranchInfo | null }
  >();
  /** Pa1KaXmj: topilgan HQ id (muddatsiz). */
  private hqBranchId: string | null = null;
  /** Pa1KaXmj: topilmasa / xatoda — shu vaqtgacha qayta so'ralmaydi. */
  private hqRetryAt = 0;
  /** Pa1KaXmj: davom etayotgan `branch.find_hq` — parallel chaqiruvlar ulashadi. */
  private hqPending: Promise<string | null> | null = null;

  constructor(
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private send<T = unknown>(
    client: ClientProxy,
    cmd: string,
    payload: unknown,
  ): Promise<T> {
    return firstValueFrom(
      client.send<T>({ cmd }, payload).pipe(timeout(RPC_TIMEOUT_MS)),
    );
  }

  private unavailable(service: string): never {
    throw new RpcException({
      statusCode: 503,
      message: `${service} javob bermadi — keyinroq qayta urinib ko'ring`,
    });
  }

  private toBranch(raw: unknown): WarehouseBranchInfo | null {
    const row = asRecord(raw);
    const id = str(row?.id);
    if (!row || !id) return null;
    const region = asRecord(row.region);
    const regionId = str(row.region_id) || str(region?.id) || null;
    const type = str(row.type) || null;
    const status = str(row.status) || null;
    const deleted = row.isDeleted === true || row.is_deleted === true;
    const active = !deleted && status === Status.ACTIVE && type !== null;
    return {
      id,
      name: str(row.name),
      type,
      status,
      address: str(row.address) || null,
      region_id: regionId,
      region:
        region && str(region.id)
          ? { id: str(region.id), name: str(region.name) }
          : null,
      is_hq: type === BranchType.HQ,
      can_host_warehouse: active && HOST_BRANCH_TYPES.has(type),
      regional: active && REGIONAL_BRANCH_TYPES.has(type),
    };
  }

  /**
   * Pa1KaXmj: HQ id keshini oldindan isitish (order-service
   * `OrderLookupService.onModuleInit` naqshi). Ishga tushishni TO'SMAYDI:
   * branch-service hali tayyor bo'lmasa — birinchi o'qish chaqiruvi qayta
   * urinadi.
   */
  onModuleInit(): void {
    void this.getHqBranchId();
  }

  /**
   * Pa1KaXmj: HQ filial id (`branch.find_hq`). Ombor turini (`kind`) filial
   * ma'lumotisiz aniqlash uchun; o'qish yo'li — xato tashlamaydi.
   *
   * - Topilgan id MUDDATSIZ saqlanadi: HQ turi qulflangan (branch-service —
   *   «HQ filial turini o'zgartirib bo'lmaydi») va tizimda bitta HQ
   *   (order-service `OrderLookupService.getHqBranchId` naqshi).
   * - Topilmasa (404) yoki servis javob bermasa — `null` va
   *   `HQ_RETRY_BACKOFF_MS` davomida qayta so'ralmaydi.
   * - Parallel chaqiruvlar bitta davom etayotgan so'rovni ulashadi.
   * - `maxWaitMs` — ko'pi bilan shuncha kutiladi (so'ng `null`), so'rov esa
   *   fonda tugab keshni to'ldiradi. O'qish yo'llari `HQ_ID_READ_WAIT_MS`
   *   beradi.
   */
  async getHqBranchId(
    options: { maxWaitMs?: number } = {},
  ): Promise<string | null> {
    if (this.hqBranchId) return this.hqBranchId;
    if (Date.now() < this.hqRetryAt) return null;
    this.hqPending ??= this.fetchHqBranchId().finally(() => {
      this.hqPending = null;
    });
    return options.maxWaitMs === undefined
      ? this.hqPending
      : withDeadline(this.hqPending, options.maxWaitMs, null);
  }

  /** `branch.find_hq` — hech qachon xato tashlamaydi (`null` + backoff). */
  private async fetchHqBranchId(): Promise<string | null> {
    try {
      const response = await this.send(this.branchClient, 'branch.find_hq', {});
      const value = str(asRecord(unwrap(response))?.id) || null;
      if (value) {
        this.hqBranchId = value;
        return value;
      }
    } catch (error) {
      if (asRecord(error)?.statusCode !== 404) {
        this.logger.warn(
          `branch.find_hq olinmadi: ${(error as Error)?.message ?? String(error)}`,
        );
      }
    }
    this.hqRetryAt = Date.now() + HQ_RETRY_BACKOFF_MS;
    return null;
  }

  /**
   * Filial (keshlangan). `strict` — topilmasa `null`, servis javob bermasa
   * 503 (yozish yo'li); aks holda xatoda ham `null` (o'qish yo'li).
   */
  async getBranch(
    id: string,
    options: { strict?: boolean; fresh?: boolean } = {},
  ): Promise<WarehouseBranchInfo | null> {
    const key = str(id);
    if (!key) return null;
    const cached = this.branchCache.get(key);
    if (
      !options.fresh &&
      cached &&
      Date.now() - cached.at < BRANCH_CACHE_TTL_MS
    ) {
      return cached.value;
    }
    try {
      const response = await this.send(this.branchClient, 'branch.find_by_id', {
        id: key,
        requester: SYSTEM_REQUESTER,
      });
      const value = this.toBranch(unwrap(response));
      this.branchCache.set(key, { at: Date.now(), value });
      return value;
    } catch (error) {
      const statusCode = asRecord(error)?.statusCode;
      if (statusCode === 404) {
        this.branchCache.set(key, { at: Date.now(), value: null });
        return null;
      }
      if (options.strict) {
        this.unavailable('Filial servisi');
      }
      this.logger.warn(
        `branch.find_by_id(${key}) olinmadi: ${(error as Error)?.message ?? String(error)}`,
      );
      return cached?.value ?? null;
    }
  }

  async getBranches(
    ids: string[],
  ): Promise<Map<string, WarehouseBranchInfo | null>> {
    const unique = Array.from(new Set(ids.map(str).filter(Boolean)));
    const entries = await Promise.all(
      unique.map(async (id) => [id, await this.getBranch(id)] as const),
    );
    return new Map(entries);
  }

  /**
   * Filial menejerlari (branch_users, rol MANAGER) — `active`: identity'dagi
   * foydalanuvchi FAOL (`status = active`; o'chirilgan/topilmagan — yo'q).
   * Servis javob bermasa 503.
   */
  private async getBranchManagers(
    branchId: string,
  ): Promise<Array<{ user_id: string; active: boolean }>> {
    let response: unknown;
    try {
      response = await this.send(
        this.branchClient,
        'branch.user.find_by_branch',
        { branch_id: branchId, requester: SYSTEM_REQUESTER },
      );
    } catch {
      this.unavailable('Filial servisi');
    }
    const rows = unwrap(response);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => asRecord(row))
      .filter(
        (row): row is Record<string, unknown> =>
          !!row && str(row.role).toUpperCase() === BranchUserRole.MANAGER,
      )
      .map((row) => ({
        user_id: str(row.user_id),
        active: str(asRecord(row.user)?.status).toLowerCase() === Status.ACTIVE,
      }))
      .filter((row) => /^\d+$/.test(row.user_id));
  }

  /** Mas'ul xodim tanlovini tekshirish uchun — filialning hamma menejerlari. */
  async getBranchManagerIds(branchId: string): Promise<string[]> {
    return (await this.getBranchManagers(branchId)).map((row) => row.user_id);
  }

  /**
   * XtcEyQjb: mas'ul xodim tanlanmasa — filialning birinchi FAOL menejeri
   * (foydalanuvchi id'si bo'yicha eng kichigi); yo'q bo'lsa `null`.
   */
  async getFirstActiveBranchManagerId(
    branchId: string,
  ): Promise<string | null> {
    const ids = (await this.getBranchManagers(branchId))
      .filter((row) => row.active)
      .map((row) => row.user_id)
      .sort((a, b) =>
        a.length !== b.length
          ? a.length - b.length
          : a < b
            ? -1
            : a > b
              ? 1
              : 0,
      );
    return ids[0] ?? null;
  }

  /**
   * Tuman → logistika hududi: avval `assigned_region` (HQ qabuli ham pochtani
   * shu bo'yicha tanlaydi), bo'lmasa tumanning o'z viloyati — order-service
   * `resolveRegionIdForDistrict` bilan AYNI tartib.
   */
  async regionForDistrict(districtId: string): Promise<string | null> {
    const id = str(districtId);
    if (!/^\d+$/.test(id)) return null;
    let response: unknown;
    try {
      response = await this.send(
        this.logisticsClient,
        'logistics.district.find_by_id',
        { id },
      );
    } catch {
      return null;
    }
    const district = asRecord(unwrap(response));
    const candidates = [
      district?.assigned_region,
      asRecord(district?.assignedToRegion)?.id,
      district?.region_id,
      asRecord(district?.region)?.id,
    ];
    for (const candidate of candidates) {
      const value = str(candidate);
      if (/^\d+$/.test(value)) return value;
    }
    return null;
  }

  /** Xodimlar (ism + telefon) — mas'ul xodim ko'rsatish uchun. */
  async getUsers(ids: string[]): Promise<Map<string, WarehouseUserInfo>> {
    const unique = Array.from(new Set(ids.map(str).filter(Boolean)));
    const map = new Map<string, WarehouseUserInfo>();
    if (!unique.length) return map;
    try {
      const response = await this.send(
        this.identityClient,
        'identity.user.find_by_ids',
        { ids: unique },
      );
      const rows = unwrap(response);
      for (const raw of Array.isArray(rows) ? rows : []) {
        const row = asRecord(raw);
        const id = str(row?.id);
        if (!row || !id) continue;
        map.set(id, {
          id,
          name: str(row.name) || null,
          phone_number: str(row.phone_number) || null,
          role: str(row.role) || null,
        });
      }
    } catch {
      // boyitish — xatoda bo'sh
    }
    return map;
  }

  /**
   * Harakat aktyorlari — faqat `{ id, name, role }` (telefon yo'q;
   * o'chirilgan xodim ham ismli qaytadi).
   */
  async getUserSummaries(
    ids: string[],
  ): Promise<Map<string, WarehouseUserInfo>> {
    const unique = Array.from(new Set(ids.map(str).filter(Boolean)));
    const map = new Map<string, WarehouseUserInfo>();
    if (!unique.length) return map;
    try {
      const response = await this.send(
        this.identityClient,
        'identity.user.summary_by_ids',
        { ids: unique },
      );
      const rows = unwrap(response);
      for (const raw of Array.isArray(rows) ? rows : []) {
        const row = asRecord(raw);
        const id = str(row?.id);
        if (!row || !id) continue;
        map.set(id, {
          id,
          name: str(row.name) || null,
          phone_number: null,
          role: str(row.role) || null,
        });
      }
    } catch {
      // boyitish — xatoda bo'sh
    }
    return map;
  }

  private toMarket(raw: unknown): WarehouseMarketInfo | null {
    const row = asRecord(raw);
    const id = str(row?.id);
    if (!row || !id) return null;
    return {
      id,
      name: str(row.name),
      status: str(row.status) || null,
      can_order_from_warehouse: row.can_order_from_warehouse === true,
    };
  }

  /** Marketlar nomi (oq ro'yxat: id, name, status, kalit). */
  async getMarkets(ids: string[]): Promise<Map<string, WarehouseMarketInfo>> {
    const unique = Array.from(new Set(ids.map(str).filter(Boolean)));
    const map = new Map<string, WarehouseMarketInfo>();
    if (!unique.length) return map;
    try {
      const response = await this.send(
        this.identityClient,
        'identity.market.find_by_ids',
        { ids: unique },
      );
      const rows = unwrap(response);
      for (const raw of Array.isArray(rows) ? rows : []) {
        const market = this.toMarket(raw);
        if (market) map.set(market.id, market);
      }
    } catch {
      // boyitish — xatoda bo'sh
    }
    return map;
  }

  /**
   * Bitta market — `can_order_from_warehouse` kaliti uchun. Servis javob
   * bermasa yoki market topilmasa `null` (chaqiruvchi HQ'ga tushadi —
   * fail-closed: ruxsat isbotlanmasa ombordan buyurtma yo'q).
   */
  async getMarket(id: string): Promise<WarehouseMarketInfo | null> {
    const key = str(id);
    if (!key) return null;
    try {
      const response = await this.send(
        this.identityClient,
        'identity.market.find_by_id',
        { id: key },
      );
      return this.toMarket(unwrap(response));
    } catch {
      return null;
    }
  }
}
