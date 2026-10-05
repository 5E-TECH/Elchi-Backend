import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import {
  BranchOwnership,
  Cashbox_type,
  ExpenseProofCondition,
  rmqSend,
} from '@app/common';

/**
 * Masofaviy RPC xatosining holat kodi: mikroservisdagi `RpcException({
 * statusCode })` mijozga oddiy `{ statusCode, message }` obyekti bo'lib
 * keladi; mahalliy `RpcException` ham hisobga olinadi. Aniqlanmasa — null
 * (timeout va boshqalar).
 */
function rpcErrorStatusOf(error: unknown): number | null {
  const payload =
    error instanceof RpcException ? (error.getError() as unknown) : error;
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const obj = payload as { statusCode?: unknown; status?: unknown };
  for (const candidate of [obj.statusCode, obj.status]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return null;
}

function rpcErrorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

/**
 * Shared, side-effect-free lookups used across the order service: HQ-branch
 * resolution (with a warmed cache), market/courier/user/cashbox/integration/
 * district resolvers — all pure RMQ reads to other services. Extracted from the
 * OrderServiceService god object so the query, lifecycle and settlement paths
 * inject ONE owner of these resolvers (and ONE warmed hqBranchIdCache) instead
 * of duplicating them. onModuleInit warms the HQ cache up-front.
 */
@Injectable()
export class OrderLookupService implements OnModuleInit {
  private readonly logger = new Logger(OrderLookupService.name);
  private hqBranchIdCache: string | null = null;

  constructor(
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
  ) {}

  private notFound(message: string): never {
    throw new RpcException({ statusCode: 404, message });
  }

  async onModuleInit(): Promise<void> {
    // Warm the HQ branch cache up-front. branch-service seeds HQ on its own
    // init, so this should succeed on a healthy stack. If RMQ isn't ready yet
    // (cold-start race) we just log; the first order create will retry.
    try {
      await this.getHqBranchId();
    } catch (err) {
      this.logger.warn(
        `HQ branch warm-up failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  async getHqBranchId(): Promise<string | null> {
    if (this.hqBranchIdCache) {
      return this.hqBranchIdCache;
    }

    try {
      const response = await rmqSend<{ data?: { id?: string } }>(
        this.branchClient,
        { cmd: 'branch.find_hq' },
        {},
        { attachRequestId: false, retries: 1 },
      );
      const hqId = response?.data?.id;
      if (hqId) {
        this.hqBranchIdCache = String(hqId);
      }
    } catch {
      return null;
    }

    return this.hqBranchIdCache;
  }

  async getMarketsByIds(ids: string[]) {
    if (!ids.length) return [];
    const response = await rmqSend<{
      data?: Array<{
        id: string;
        name?: string;
        tariff_home?: number;
        tariff_center?: number;
        expense_proof_conditions?: ExpenseProofCondition[] | null;
        cancelled_handover_qr_required?: boolean | null;
      }>;
    }>(
      this.identityClient,
      { cmd: 'identity.market.find_by_ids' },
      { ids },
    ).catch(() => ({ data: [] }));
    return response?.data ?? [];
  }

  async getCouriersByIds(ids: string[]) {
    if (!ids.length) return [];
    const response = await rmqSend<{
      data?: Array<{
        id: string;
        name?: string;
        tariff_home?: number;
        tariff_center?: number;
        role?: string | null;
        compensation_mode?: string | null;
        can_add_extra_cost?: boolean | null;
        // Faqat tiplar birligi uchun (menejer sell/cancel guard'i union qabul
        // qiladi); kuryerlar uchun hech qachon o'rnatilmaydi, guard ham no-op.
        can_sell_cancel?: boolean | null;
      }>;
    }>(
      this.identityClient,
      { cmd: 'identity.courier.find_by_ids' },
      { ids },
    ).catch(() => ({ data: [] }));
    return response?.data ?? [];
  }

  async getUserById(id: string) {
    const response = await rmqSend<{
      data?: {
        id: string;
        name?: string;
        tariff_home?: number;
        tariff_center?: number;
        role?: string | null;
        compensation_mode?: string | null;
        can_add_extra_cost?: boolean | null;
        can_sell_cancel?: boolean | null;
      };
    }>(
      this.identityClient,
      { cmd: 'identity.user.find_by_id' },
      { id: String(id) },
    ).catch(() => ({ data: undefined }));

    return response?.data;
  }

  async getBranchAssignmentByUser(userId: string) {
    const response = await rmqSend<{
      data?: {
        branch_id?: string | null;
        role?: string | null;
      } | null;
    }>(
      this.branchClient,
      { cmd: 'branch.user.find_by_user' },
      {
        user_id: String(userId),
        requester: { id: 'system', roles: ['superadmin'] },
      },
      { attachRequestId: false, retries: 1 },
    ).catch(() => ({ data: null }));

    return response?.data ?? null;
  }

  /**
   * `getBranchAssignmentByUser` bilan AYNI so'rov, lekin xato YUTILMAYDI
   * (fix3b). U yerda transport xatosi ham `null` bo'lib qaytadi — ya'ni
   * "filialga biriktirilmagan" va "branch-service javob bermadi" ajralmaydi.
   * Filial tanlovi xatoga bog'liq bo'lmasligi kerak bo'lgan joyda
   * (`createExternalOrder`) shu metod ishlatiladi: `null` — biriktirilmagan,
   * xato — chaqiruvchiga uzatiladi.
   */
  async getBranchAssignmentByUserStrict(userId: string) {
    const response = await rmqSend<{
      data?: {
        branch_id?: string | null;
        role?: string | null;
      } | null;
    }>(
      this.branchClient,
      { cmd: 'branch.user.find_by_user' },
      {
        user_id: String(userId),
        requester: { id: 'system', roles: ['superadmin'] },
      },
      { attachRequestId: false, retries: 1 },
    );

    return response?.data ?? null;
  }

  /**
   * LC-13 (fix3b) — tumandan viloyatni (`order.region_id`) aniqlash.
   *
   * `logistics.district.find_by_id`: avval `assigned_region` (tuman
   * biriktirilgan logistika hududi — HQ qabuli ham pochtani shu bo'yicha
   * tanlaydi), bo'lmasa tumanning o'z `region_id` si. Faqat raqamli id
   * qabul qilinadi (`region_id` — bigint). Aniqlanmasa — `null` (tuman
   * topilmadi yoki logistika javob bermadi); qaror chaqiruvchida.
   */
  async resolveRegionIdForDistrict(
    districtId: string | null | undefined,
  ): Promise<string | null> {
    const id = String(districtId ?? '').trim();
    if (!/^\d+$/.test(id)) {
      return null;
    }
    const response = await rmqSend<{
      data?: {
        assigned_region?: string | number | null;
        assignedToRegion?: { id?: string | number | null } | null;
        region_id?: string | number | null;
        region?: { id?: string | number | null } | null;
      } | null;
    }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_by_id' },
      { id },
    ).catch(() => null);
    const district = response?.data;
    const candidates = [
      district?.assigned_region,
      district?.assignedToRegion?.id,
      district?.region_id,
      district?.region?.id,
    ];
    for (const candidate of candidates) {
      const value = String(candidate ?? '').trim();
      if (/^\d+$/.test(value)) {
        return value;
      }
    }
    return null;
  }

  async getBranchUsers(branchId: string) {
    const response = await rmqSend<{
      data?: Array<{
        user_id?: string | null;
        role?: string | null;
        user?: {
          id?: string;
          role?: string | null;
          can_add_extra_cost?: boolean | null;
        } | null;
      }>;
    }>(
      this.branchClient,
      { cmd: 'branch.user.find_by_branch' },
      {
        branch_id: String(branchId),
        requester: { id: 'system', roles: ['superadmin'] },
      },
      { attachRequestId: false, retries: 1 },
    ).catch(() => ({ data: [] }));

    return response?.data ?? [];
  }

  async getCashboxByUser(userId: string, cashboxType: Cashbox_type) {
    const response = await rmqSend<{ data?: { id: string; balance?: number } }>(
      this.financeClient,
      { cmd: 'finance.cashbox.find_by_user' },
      { user_id: userId, cashbox_type: cashboxType },
    ).catch(() => ({ data: undefined }));

    return response?.data;
  }

  /**
   * Resolve the non-HQ branch a sale should settle through, or null for HQ /
   * unknown. Branches are separate cash owners: COD collected by a branch's
   * courier rolls courier → branch → HQ. The branch a sale belongs to is where
   * custody currently sits (holder branch, falling back to the order branch).
   */
  async resolveSettlementBranchId(order: {
    holder_branch_id?: string | null;
    branch_id?: string | null;
  }): Promise<string | null> {
    const branchId = String(
      order.holder_branch_id ?? order.branch_id ?? '',
    ).trim();
    if (!branchId) {
      return null;
    }
    const hqId = String((await this.getHqBranchId()) ?? '').trim();
    return branchId === hqId ? null : branchId;
  }

  /**
   * Ensure a branch's BRANCH-type cashbox exists before we post to it (the
   * finance balance update throws if the cashbox is missing). Idempotent — a
   * pre-existing cashbox returns an "already exists" error we deliberately
   * swallow.
   */
  async ensureBranchCashbox(branchId: string): Promise<void> {
    await rmqSend(
      this.financeClient,
      { cmd: 'finance.cashbox.create' },
      { user_id: String(branchId), cashbox_type: Cashbox_type.BRANCH },
    ).catch(() => undefined);
  }

  /**
   * The per-order amount a branch KEEPS for a sold order: its configured
   * per_order_share when the branch is PARTNER-owned, otherwise 0 (OWNED
   * branches remit everything to HQ). Returns 0 for HQ / unknown branch.
   *
   * ⚠️ CODE-05 — TIZIM REQUESTER'I UZATILADI. Ilgari so'rov requester'siz
   * ketardi: branch-service `branch.find_by_id` ni 403 'Requester aniqlanmadi'
   * bilan rad etar, `.catch` esa uni 0 ga aylantirardi — ya'ni HAMKOR
   * (PARTNER) filialning ulushi HECH QACHON yozilmas, HQ foydasi esa oshib
   * ko'rinardi. Endi boshqa ichki o'qishlar kabi `{ id: 'system', roles:
   * ['superadmin'] }` yuboriladi.
   *
   * Xatoda (sotuv tranzaksiyasidan OLDIN chaqiriladi, hech qanday pul hali
   * ko'chmagan):
   *   • 404 (filial topilmadi / o'chirilgan) — 0, avvalgidek "noma'lum filial";
   *   • boshqa xato (timeout, 5xx) — fix3b (CODE-05, ishga tushirish
   *     xavfsizligi): BALAND OVOZDA log (`logger.error`, filial va xato
   *     matni bilan) va 0. 503 EMAS: aks holda har bir filial sotuvi
   *     branch-service'ga bog'lanib qolardi, holbuki hozir HAMKOR (PARTNER)
   *     filial yo'q va ownership/per_order_share ni o'rnatib ham bo'lmaydi —
   *     ya'ni barcha filiallar uchun to'g'ri javob baribir 0. PARTNER filial
   *     ishga tushirilishidan OLDIN bu yo'l qayta ko'rib chiqilishi shart.
   */
  async resolveBranchShare(branchId: string | null): Promise<number> {
    if (!branchId) {
      return 0;
    }
    let res: {
      data?: { ownership?: string; per_order_share?: number | string };
    };
    try {
      res = await rmqSend<{
        data?: { ownership?: string; per_order_share?: number | string };
      }>(
        this.branchClient,
        { cmd: 'branch.find_by_id' },
        {
          id: String(branchId),
          requester: { id: 'system', roles: ['superadmin'] },
        },
        { attachRequestId: false, retries: 1 },
      );
    } catch (error) {
      const status = rpcErrorStatusOf(error);
      if (status === 404) {
        return 0;
      }
      this.logger.error(
        `CODE-05: branch.find_by_id (filial ulushi) xato — branch=${branchId} ` +
          `status=${status ?? "yo'q"}: ${rpcErrorMessageOf(error)}. ` +
          `Filial ulushi 0 deb olindi (hozir PARTNER filial yo'q); ` +
          `PARTNER filial bo'lsa bu sotuvning bo'linishini tekshiring.`,
      );
      return 0;
    }
    const branch = res?.data;
    if (!branch || branch.ownership !== BranchOwnership.PARTNER) {
      return 0;
    }
    const share = Number(branch.per_order_share ?? 0);
    return Number.isFinite(share) && share > 0 ? share : 0;
  }

  async getIntegrationById(
    integrationId: string,
  ): Promise<Record<string, any>> {
    const response = await rmqSend<{ data?: Record<string, any> }>(
      this.integrationClient,
      { cmd: 'integration.find_by_id' },
      { id: integrationId },
    ).catch(() => ({ data: undefined }));

    const integration = response?.data;
    if (!integration) {
      this.notFound('Integration not found');
    }
    return integration;
  }

  async getDefaultDistrictId(): Promise<string> {
    const response = await rmqSend<{
      data?: { items?: Array<{ id: string }> } | Array<{ id: string }>;
    }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_all' },
      { query: { page: 1, limit: 1 } },
    ).catch(() => ({ data: [] }));

    const rows = Array.isArray(response?.data)
      ? response.data
      : ((response?.data as any)?.items ?? []);

    const districtId = rows?.[0]?.id ? String(rows[0].id) : '';
    if (!districtId) {
      this.notFound('No district found for external order import');
    }
    return districtId;
  }

  /**
   * Tumanni aniqlash — MOS KELMASA `null`.
   *
   * ⚠️ NEGA ALOHIDA METOD KERAK BO'LDI (adversarial tekshiruv). Chaqiruvchi
   * "aniqlandimi yoki zaxira ishlatildimi" degan savolga javob olishi
   * kerak edi. `resolveDistrictId` ikkisini AJRATMAYDI — u zaxira qiymatni
   * qaytaradi va chaqiruvchi buni haqiqiy moslik deb qabul qiladi.
   *
   * Zaxira esa `getDefaultDistrictId()` — u JADVALDAGI BIRINCHI tuman
   * (`limit: 1`). Tuman viloyat va pochta marshrutini, tarifni ham
   * belgilaydi; ya'ni mos kelmagan buyurtma JIMGINA boshqa viloyatga
   * ketardi.
   *
   * ⚠️ Moslik faqat SOATO kodi yoki ichki ID bo'yicha izlanadi — NOM
   * bo'yicha EMAS. Ya'ni "Chilonzor" deb yuborgan tizim hech qachon mos
   * kelmaydi.
   */
  async resolveDistrictIdOrNull(
    externalDistrictValue: unknown,
  ): Promise<string | null> {
    const raw =
      typeof externalDistrictValue === 'string' ||
      typeof externalDistrictValue === 'number' ||
      typeof externalDistrictValue === 'bigint' ||
      typeof externalDistrictValue === 'boolean'
        ? String(externalDistrictValue).trim()
        : '';
    if (!raw) return null;

    const bySato = await rmqSend<{ data?: { id?: string } }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_by_sato' },
      { satoCode: raw },
    ).catch(() => ({ data: undefined }));
    if (bySato?.data?.id) {
      return String(bySato.data.id);
    }

    const byId = await rmqSend<{ data?: { id?: string } }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_by_id' },
      { id: raw },
    ).catch(() => ({ data: undefined }));
    if (byId?.data?.id) {
      return String(byId.data.id);
    }

    return null;
  }

  /** Eski xatti-harakat: mos kelmasa zaxira tuman. */
  async resolveDistrictId(
    externalDistrictValue: unknown,
    fallbackDistrictId: string,
  ): Promise<string> {
    return (
      (await this.resolveDistrictIdOrNull(externalDistrictValue)) ??
      fallbackDistrictId
    );
  }
}
