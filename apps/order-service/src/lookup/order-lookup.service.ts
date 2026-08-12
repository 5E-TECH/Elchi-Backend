import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import {
  BranchOwnership,
  Cashbox_type,
  ExpenseProofCondition,
  rmqSend,
} from '@app/common';

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
        compensation_mode?: string | null;
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
        compensation_mode?: string | null;
      };
    }>(
      this.identityClient,
      { cmd: 'identity.user.find_by_id' },
      { id: String(id) },
    ).catch(() => ({ data: undefined }));

    return response?.data;
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
   */
  async resolveBranchShare(branchId: string | null): Promise<number> {
    if (!branchId) {
      return 0;
    }
    const res = await rmqSend<{
      data?: { ownership?: string; per_order_share?: number | string };
    }>(
      this.branchClient,
      { cmd: 'branch.find_by_id' },
      { id: String(branchId) },
    ).catch(() => ({ data: undefined }));
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

  async resolveDistrictId(
    externalDistrictValue: unknown,
    fallbackDistrictId: string,
  ): Promise<string> {
    const raw =
      externalDistrictValue == null ? '' : String(externalDistrictValue).trim();
    if (!raw) return fallbackDistrictId;

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

    return fallbackDistrictId;
  }
}
