import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { BranchType, BranchUserRole, Status } from '@app/common';

/** Boshqa servislar bilan ishlaganda "tizim" so'rovchisi (o'qish uchun). */
const SYSTEM_REQUESTER = { id: 'system', roles: ['superadmin'] };
const RPC_TIMEOUT_MS = 5000;
/** Filial ma'lumoti keshi — har buyurtmada branch-service'ga bormaslik uchun. */
const BRANCH_CACHE_TTL_MS = 30_000;
/** AQ9lkgVB: narx sozlamasidagi hajm chegarasi keshi («Hisob vazni» ko'rinishi). */
const VOLUMETRIC_FROM_CACHE_TTL_MS = 30_000;

export interface WarehouseBranchInfo {
  id: string;
  name: string;
  type: string | null;
  status: string | null;
  address: string | null;
  region_id: string | null;
  region: { id: string; name: string } | null;
  /** Viloyat filiali (REGIONAL/HYBRID), faol va o'chirilmagan. */
  eligible: boolean;
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

const ELIGIBLE_BRANCH_TYPES = new Set<string>([
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
export class WarehouseDirectoryService {
  private readonly logger = new Logger(WarehouseDirectoryService.name);
  private readonly branchCache = new Map<
    string,
    { at: number; value: WarehouseBranchInfo | null }
  >();
  private volumetricFromCache: { at: number; value: number } | null = null;

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
      eligible:
        !deleted &&
        status === Status.ACTIVE &&
        type !== null &&
        ELIGIBLE_BRANCH_TYPES.has(type),
    };
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

  /**
   * AQ9lkgVB: hajm qaysi kg dan hisobga olinadi (`logistics.delivery.settings.get`
   * → `volumetric_from_kg`) — ombordagi «Hisob vazni» narx dvigateli bilan bir
   * xil qoidada chiqishi uchun. Keshlangan (30 s); logistics javob bermasa —
   * oxirgi ma'lum qiymat, u ham yo'q bo'lsa 0 (faqat ko'rsatish — narx
   * hisoblanmaydi, ro'yxat yiqilmaydi).
   */
  async volumetricFromKg(): Promise<number> {
    const cached = this.volumetricFromCache;
    if (cached && Date.now() - cached.at < VOLUMETRIC_FROM_CACHE_TTL_MS) {
      return cached.value;
    }
    try {
      const response = await this.send(
        this.logisticsClient,
        'logistics.delivery.settings.get',
        {},
      );
      const raw = Number(asRecord(unwrap(response))?.volumetric_from_kg);
      const value = Number.isFinite(raw) && raw > 0 ? raw : 0;
      this.volumetricFromCache = { at: Date.now(), value };
      return value;
    } catch (error) {
      this.logger.warn(
        `logistics.delivery.settings.get olinmadi: ${(error as Error)?.message ?? String(error)}`,
      );
      return cached?.value ?? 0;
    }
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
