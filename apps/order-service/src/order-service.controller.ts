import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import {
  RmqService,
  executeAndAck,
  IdempotencyService,
  executeIdempotent,
  ActivityLogQuery,
} from '@app/common';
import { Order_status, Where_deliver } from '@app/common';
import {
  OrderServiceService,
  type GeoReassignInput,
} from './order-service.service';
import { OrderAnalyticsService } from './analytics/order-analytics.service';
import { BranchTransferBatchService } from './transfer-batch/branch-transfer-batch.service';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import type { PartlySellRequestItem } from './lifecycle/partly-sell-items';
import { OrderHolderType, Order_source } from './entities/order.entity';
import { AiPreviewService } from './ai/ai-preview.service';
import type { AiResolvePreviewRequest } from './ai/ai-preview.types';

/**
 * ai-confirm (gateway) har buyurtma uchun DETERMINISTIK `request_id` yuboradi:
 * `'ai-dedupe:' + sha256(market|telefon|tuman|narx|yetkazish|mahsulotlar)`.
 * Faqat shu prefiksli kalitlar uchun idempotency 10 daqiqalik TTL bilan
 * ishlaydi (wgqxS0Cp #13: bir xil partiya qayta yuborilsa dublikat yaratilmaydi).
 *
 * ⚠️ Oddiy POST /orders (tasodifiy UUID `request_id`) uchun opsiyalar QO'SHILMAYDI:
 * `markReplay` uning takroriy javobiga `idempotent_replay` qo'shardi,
 * `reclaimFailed` esa yiqilgan create'ni qayta ishga tushirardi — ya'ni
 * mavjud xatti-harakat baytma-bayt o'zgarmaydi.
 */
const AI_DEDUPE_REQUEST_PREFIX = 'ai-dedupe:';
const AI_DEDUPE_CREATE_OPTIONS = {
  completedTtlMs: 600_000,
  reclaimFailed: true,
  markReplay: true,
} as const;

@Controller()
export class OrderServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly orderService: OrderServiceService,
    private readonly orderAnalyticsService: OrderAnalyticsService,
    private readonly transferBatchService: BranchTransferBatchService,
    private readonly settlementService: OrderSettlementService,
    private readonly lifecycleService: OrderLifecycleService,
    private readonly idempotencyService: IdempotencyService,
    private readonly aiPreview: AiPreviewService,
  ) {}

  private executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeAndAck(this.rmqService, context, handler);
  }

  /**
   * `extra` — faqat aniq kerak bo'lgan handlerlar uchun (masalan
   * `order.settlement.advance` ning `reclaimFailed`i). Berilmasa opsiyalar
   * AYNAN `{ requestId, pattern }` — mavjud handlerlar xatti-harakati
   * o'zgarmaydi.
   */
  private runIdempotent<T>(
    context: RmqContext,
    pattern: string,
    requestId: string | undefined,
    handler: () => Promise<T> | T,
    extra: { reclaimFailed?: boolean } = {},
  ): Promise<T> {
    return executeIdempotent(
      this.rmqService,
      this.idempotencyService,
      context,
      { requestId, pattern, ...extra },
      handler,
    );
  }

  @MessagePattern({ cmd: 'salom_ber_order' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      message: 'Salom! Men Order Service man.',
      status: 'Hammasi chotki ishlayapti!',
      timestamp: new Date().toISOString(),
    }));
  }

  @MessagePattern({ cmd: 'order.create' })
  create(
    @Payload()
    data: {
      dto: {
        market_id: string;
        customer_id: string;
        where_deliver?: Where_deliver;
        total_price?: number;
        to_be_paid?: number;
        paid_amount?: number;
        /**
         * fix3b: hamkor prepaid qismi (`createPartnerShipment`:
         * `subtotal − cod_amount`). Faqat SA/ADMIN/hamkor va ichki
         * chaqiruvlardan qabul qilinadi, 0 ≤ qiymat ≤ total_price.
         */
        paid_online_amount?: number | null;
        status?: Order_status;
        comment?: string | null;
        operator?: string | null;
        operator_id?: string | null;
        post_id?: string | null;
        branch_id?: string | null;
        current_batch_id?: string | null;
        courier_id?: string | null;
        assigned_at?: string | Date | null;
        return_reason?: string | null;
        district_id?: string | null;
        region_id?: string | null;
        address?: string | null;
        qr_code_token?: string | null;
        parent_order_id?: string | null;
        external_id?: string | null;
        source?: Order_source;
        items?: Array<{
          product_id?: string | null;
          product_name?: string | null;
          quantity?: number;
        }>;
      };
      requester?: { id: string; roles?: string[] };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    const requestId = data.request_id;
    return executeIdempotent(
      this.rmqService,
      this.idempotencyService,
      context,
      {
        requestId,
        pattern: 'order.create',
        ...(typeof requestId === 'string' &&
        requestId.startsWith(AI_DEDUPE_REQUEST_PREFIX)
          ? AI_DEDUPE_CREATE_OPTIONS
          : {}),
      },
      () => this.lifecycleService.create(data.dto, data.requester),
    );
  }

  /**
   * AI buyurtma preview'i (fPre2MRr): xom ekstraksiya → yassi preview.
   * Gateway har chaqiruvda yangi `request_id` (randomUUID) beradi —
   * RMQ qayta yetkazsa bitta natija qaytadi. Kesh qatorlari (PII) 1 soatdan
   * keyin `AiPreviewService` ichida tozalanadi.
   */
  @MessagePattern({ cmd: 'order.ai_resolve_preview' })
  aiResolvePreview(
    @Payload() data: AiResolvePreviewRequest,
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.ai_resolve_preview',
      data?.request_id,
      () => this.aiPreview.resolve(data),
    );
  }

  @MessagePattern({ cmd: 'order.find_all' })
  findAll(
    @Payload()
    data: {
      query: {
        market_id?: string;
        customer_id?: string;
        post_id?: string;
        post_ids?: string[];
        exclude_statuses?: Order_status[];
        canceled_post_id?: string;
        canceled_post_unassigned?: boolean;
        holder_type?: OrderHolderType;
        qr_code_token?: string;
        status?: Order_status | Order_status[] | string | string[];
        where_deliver?: Where_deliver;
        return_requested?: boolean;
        start_day?: string;
        end_day?: string;
        courier?: string;
        courier_ids?: string[];
        region_id?: string;
        district_id?: string;
        branch_id?: string;
        source?: Order_source | 'internal' | 'external' | 'branch';
        fetch_all?: boolean | string;
        fetchAll?: boolean | string;
        page?: number;
        limit?: number;
      };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findAll(data.query),
    );
  }

  @MessagePattern({ cmd: 'order.find_by_id' })
  findById(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.orderService.findById(data.id),
    );
  }

  /** Buyurtma xulosalari id ro'yxati bo'yicha (integratsiya posilkalari, tokhPLMP). */
  @MessagePattern({ cmd: 'order.summary_by_ids' })
  findSummariesByIds(
    @Payload() data: { ids?: unknown },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findSummariesByIds(data?.ids),
    );
  }

  /** Dalil faylining egasi — fayl kirish nazorati uchun (audit S5). */
  @MessagePattern({ cmd: 'order.find_owner_by_proof_file' })
  findOwnerByProofFile(
    @Payload() data: { key?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findOwnerByProofFile(data?.key ?? ''),
    );
  }

  // oNAE3LW9: hudud o'chirish himoyasi va tumanlarni birlashtirish.
  @MessagePattern({ cmd: 'order.geo.usage' })
  geoUsage(
    @Payload() data: { district_id?: string; region_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.countGeoUsage(data ?? {}),
    );
  }

  // Ko'chgan ID'larni qaytaradi; `ids` + `restore_regions` — kompensatsiya.
  @MessagePattern({ cmd: 'order.geo.reassign_district' })
  geoReassignDistrict(
    @Payload() data: GeoReassignInput,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.reassignDistrict(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.branch_can_delete' })
  branchCanDelete(
    @Payload() data: { branch_id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.branchCanDelete(data?.branch_id),
    );
  }

  @MessagePattern({ cmd: 'order.find_by_qr' })
  findByQr(@Payload() data: { token: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.orderService.findByQrCode(data.token),
    );
  }

  @MessagePattern({ cmd: 'order.find_by_qr_enriched' })
  findByQrEnriched(
    @Payload() data: { token: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findByQrCodeEnriched(data.token),
    );
  }

  // CyCV4XHR — QOP (external_batch_token) bo'yicha a'zo posilkalar. Skaner
  // order topa olmaganda (prefiksiz qop yorlig'i) gateway shu yo'lga tushadi.
  @MessagePattern({ cmd: 'order.find_batch_by_external_token' })
  findBatchByExternalToken(
    @Payload() data: { token: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findBatchByExternalToken(data.token),
    );
  }

  @MessagePattern({ cmd: 'order.tracking' })
  tracking(
    @Payload() data: { id: string; page?: number; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getTrackingByOrderId(data.id, data.page, data.limit),
    );
  }

  @MessagePattern({ cmd: 'order.custody_history' })
  custodyHistory(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.orderService.getCustodyHistoryByOrderId(data.id),
    );
  }

  @MessagePattern({ cmd: 'order.find_new_markets' })
  findNewMarkets(
    @Payload()
    data: { branch_id?: string; exclude_branch_source?: boolean } | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findNewMarkets(
        data?.branch_id,
        Boolean(data?.exclude_branch_source),
      ),
    );
  }

  @MessagePattern({ cmd: 'order.find_new_by_market' })
  findNewByMarket(
    @Payload()
    data: {
      market_id: string;
      branch_id?: string;
      exclude_branch_source?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findNewOrdersByMarket(
        data.market_id,
        data.branch_id,
        Boolean(data?.exclude_branch_source),
      ),
    );
  }

  /**
   * Tashqi posilkani SKANERLAB qabul qilish. Token serverda buyurtmaga
   * moslanadi — ya'ni skanerlash dalili serverda bo'ladi (audit K2).
   *
   * ⚠️ `order.receive` bu yo'lni CHETLAB O'TA OLMAYDI: u tashqi manbali
   * buyurtmani rad etadi va ichki `scanVerified` bayrog'ini message
   * payload'idan qabul qilmaydi.
   */
  @MessagePattern({ cmd: 'order.receive_by_scan' })
  receiveByScan(
    @Payload()
    data: { tokens: string[]; requester?: { id?: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.receiveExternalByScan({
        tokens: data?.tokens ?? [],
        requester: data?.requester,
      }),
    );
  }

  @MessagePattern({ cmd: 'order.receive' })
  receive(
    @Payload()
    data: {
      order_ids: string[];
      search?: string;
      /** Filial doirasini aniqlash uchun — menejer/registrator cheklanadi. */
      requester?: { id?: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.receiveNewOrders(
        data.order_ids,
        data.search,
        data.requester,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.sell' })
  sell(
    @Payload()
    data: {
      id: string;
      dto: {
        comment?: string;
        extraCost?: number;
        paidAmount?: number;
        proofFileKeys?: string[];
        proofFileKeysVerified?: boolean;
        extraCostApproved?: boolean;
      };
      requester: { id: string; roles?: string[]; branch_id?: string | null };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(context, 'order.sell', data.request_id, () =>
      this.lifecycleService.sellOrder(
        data.requester,
        data.id,
        data.dto ?? {},
        data.request_id,
      ),
    );
  }

  /**
   * Yetkazishdan OLDIN bekor qilish — hamkor posilkasi hali `NEW` da
   * turganda. `order.cancel` `WAITING` + pochta talab qiladi, ya'ni bu
   * holatda ishlamaydi (audit F4).
   */
  @MessagePattern({ cmd: 'order.cancel_pre_delivery' })
  cancelPreDelivery(
    @Payload()
    data: { order_id: string; reason?: string | null; actor?: string | null },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.cancelPreDeliveryOrder(data),
    );
  }

  @MessagePattern({ cmd: 'order.cancel' })
  cancel(
    @Payload()
    data: {
      id: string;
      dto: {
        comment?: string;
        reason?: string;
        paidAmount?: number;
        extraCost?: number;
        proofFileKeys?: string[];
        proofFileKeysVerified?: boolean;
        extraCostApproved?: boolean;
      };
      requester: { id: string; roles?: string[]; branch_id?: string | null };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(context, 'order.cancel', data.request_id, () =>
      this.lifecycleService.cancelOrder(
        data.requester,
        data.id,
        data.dto ?? {},
        data.request_id,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.could_not_deliver' })
  couldNotDeliver(
    @Payload()
    data: {
      id: string;
      dto: { reason?: string };
      requester: { id: string; roles?: string[] };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.could_not_deliver',
      data.request_id,
      () =>
        this.lifecycleService.couldNotDeliverOrder(
          data.requester,
          data.id,
          data.dto ?? {},
        ),
    );
  }

  @MessagePattern({ cmd: 'order.partly_sell' })
  partlySell(
    @Payload()
    data: {
      id: string;
      dto: {
        order_item_info: PartlySellRequestItem[];
        totalPrice: number;
        extraCost?: number;
        comment?: string;
        proofFileKeys?: string[];
        proofFileKeysVerified?: boolean;
        extraCostApproved?: boolean;
      };
      requester: { id: string; roles?: string[]; branch_id?: string | null };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.partly_sell',
      data.request_id,
      () =>
        this.lifecycleService.partlySellOrder(
          data.requester,
          data.id,
          data.dto,
          data.request_id,
        ),
    );
  }

  @MessagePattern({ cmd: 'order.extra_cost_approval.list' })
  listExtraCostApprovals(
    @Payload()
    data: {
      requester: { id: string; roles?: string[] };
      status?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.listExtraCostApprovals(data.requester, {
        status: data.status,
      }),
    );
  }

  @MessagePattern({ cmd: 'order.extra_cost_approval.approve' })
  approveExtraCostApproval(
    @Payload()
    data: {
      id: string;
      dto?: { comment?: string };
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.approveExtraCostApproval(
        data.requester,
        data.id,
        data.dto,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.extra_cost_approval.reject' })
  rejectExtraCostApproval(
    @Payload()
    data: {
      id: string;
      dto?: { comment?: string };
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.rejectExtraCostApproval(
        data.requester,
        data.id,
        data.dto,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.rollback_waiting' })
  rollbackToWaiting(
    @Payload()
    data: {
      id: string;
      requester: { id: string; roles?: string[] };
      dto?: { target_status?: 'waiting' | 'cancelled' | 'cancelled_sent' };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.rollback_waiting',
      data.request_id,
      () =>
        this.lifecycleService.rollbackOrderToWaiting(
          data.requester,
          data.id,
          data.dto,
          data.request_id,
        ),
    );
  }

  @MessagePattern({ cmd: 'order.settlement.courier_to_branch' })
  settlementCourierToBranch(
    @Payload()
    data: {
      dto: { courier_id: string; amount: number };
      requester: { id: string; roles?: string[] };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.settlement.courier_to_branch',
      data.request_id,
      () => this.settlementService.settleCourierToBranch(),
    );
  }

  @MessagePattern({ cmd: 'order.settlement.branch_to_hq' })
  settlementBranchToHq(
    @Payload()
    data: {
      dto: { branch_id: string; amount: number };
      requester: { id: string; roles?: string[] };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.settlement.branch_to_hq',
      data.request_id,
      () => this.settlementService.settleBranchToHq(),
    );
  }

  @MessagePattern({ cmd: 'order.settlement.hq_to_market' })
  settlementHqToMarket(
    @Payload()
    data: {
      dto: { market_id: string; amount: number };
      requester: { id: string; roles?: string[] };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.settlement.hq_to_market',
      data.request_id,
      () => this.settlementService.settleHqToMarket(),
    );
  }

  // State-only FIFO advance, called by the gateway right after a production
  // finance.cashbox.payment_* succeeds, so order_settlement tracks which orders'
  // COD reached which level (keeps the rollback guard accurate). (Audit I1/I2.)
  /**
   * ⚠️ `reclaimFailed: true` (audit M8). Bu hodisa finance outbox'idan keladi
   * va HAR qayta urinish AYNAN shu `request_id` ni olib keladi. Ilgari bitta
   * tranzient xato (postgres qayta ishga tushishi, pool to'lishi, lock
   * timeout) kalitni `failed` qilib keshlab qo'yardi: keyingi har urinish o'sha
   * keshlangan xatoni olardi va 10 urinishdan keyin hodisa abadiy yo'qolardi —
   * kassa ko'chgan, daftar esa hech qachon yetib olmasdi.
   *
   * Qayta urinish xavfsiz: `advanceSettlement` faqat FIFO commit'idan OLDIN
   * xato otadi, commit esa token'ning "applied" belgisi bilan atomik — ya'ni
   * qayta ishga tushgan handler (bu yoki lease qayta egallanishi orqali)
   * allaqachon qo'llangan to'lovni ikkinchi marta qo'llamaydi.
   */
  @MessagePattern({ cmd: 'order.settlement.advance' })
  settlementAdvance(
    @Payload()
    data: {
      level: 'courier_to_branch' | 'branch_to_hq' | 'hq_to_market';
      match_value: string;
      amount: number;
      requester_id?: string;
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.settlement.advance',
      data.request_id,
      () => this.settlementService.advanceSettlement(data),
      { reclaimFailed: true },
    );
  }

  /**
   * C8 (CODE-06) — kuryerning SOF-NOL PENDING savdo qatorlarini yopish.
   * branch-service kuryerni o'tkazish / filialdan chiqarishdan oldin
   * (best-effort) chaqiradi: qatorlar yig'indisi AYNAN 0 tiyin va qoldiq 0
   * bo'lsagina, nol lump-sum FIFO bilan bitta tranzaksiyada yopiladi. Pul
   * ko'chmaydi; shartlar bajarilmasa hech narsa o'zgarmaydi
   * (`closed_count: 0`). Xatolar har doim RpcException.
   */
  @MessagePattern({ cmd: 'order.settlement.close_zero_courier_rows' })
  settlementCloseZeroCourierRows(
    @Payload()
    data: {
      courier_id?: string | null;
      requester?: { id?: string | null; roles?: string[] } | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.settlementService.closeZeroCourierRows(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.settlement.find_by_order' })
  settlementFindByOrder(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.settlementService.getSettlementByOrderId(data.id),
    );
  }

  @MessagePattern({ cmd: 'order.settlement.financial_balance_summary' })
  settlementFinancialBalanceSummary(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.settlementService.getFinancialBalanceSettlementSummary(),
    );
  }

  /**
   * Bitta filial kesimidagi hisob-kitob yig'indisi (audit C1). Manager paneli
   * ilgari buni 5 000 tagacha buyurtmani tortib olib JS'da hisoblardi.
   */
  @MessagePattern({ cmd: 'order.settlement.branch_summary' })
  settlementBranchSummary(
    @Payload() data: { branch_id?: string | null; courier_ids?: string[] },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.settlementService.getBranchSettlementSummary(data ?? {}),
    );
  }

  /**
   * Bitta kuryerning PENDING savdo qatorlari HQ / filial kesimida (B4). Faqat
   * o'qiydi — gateway superadmin/admin kuryerdan pul olishidan oldin
   * filialga tegishli topshirilmagan savdo yo'qligini shu bilan tekshiradi.
   */
  @MessagePattern({ cmd: 'order.settlement.courier_scope' })
  settlementCourierScope(
    @Payload() data: { courier_id?: string | null },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.settlementService.getCourierSettlementScope(data ?? {}),
    );
  }

  /**
   * R3 — kuryerni filialdan filialga o'tkazish tekshiruvining order qismi:
   * PENDING savdo, qat'iy o'qilgan qoldiq, qo'lidagi buyurtmalar va ko'rib
   * chiqilmagan qo'shimcha xarajat so'rovlari. Faqat o'qiydi — branch-service
   * chaqiradi (`branch.user.courier_transfer_check`).
   */
  @MessagePattern({ cmd: 'order.courier_transfer_check' })
  courierTransferCheck(
    @Payload() data: { courier_id?: string | null },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.settlementService.getCourierTransferCheck(data ?? {}),
    );
  }

  /**
   * Kargo hisob-kitob qilgan buyurtmalarni HQ'ga yetgan deb belgilash
   * (audit M5).
   */
  @MessagePattern({ cmd: 'order.settlement.provider_settled' })
  settlementProviderSettled(
    @Payload() data: { order_ids?: string[]; requester_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.settlementService.markProviderSettledToHq(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.initiate_return' })
  initiateReturn(
    @Payload()
    data: {
      id: string;
      dto: { reason?: string };
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.initiateReturn(
        data.requester,
        data.id,
        data.dto ?? {},
      ),
    );
  }

  @MessagePattern({ cmd: 'order.mark_returned_to_market' })
  markReturnedToMarket(
    @Payload()
    data: {
      id: string;
      requester: { id: string; roles?: string[] };
      authorization_token?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.markReturnedToMarket(
        data.requester,
        data.id,
        data.authorization_token,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.update' })
  update(
    @Payload()
    data: {
      id: string;
      dto: {
        market_id?: string;
        customer_id?: string;
        where_deliver?: Where_deliver;
        total_price?: number;
        to_be_paid?: number;
        paid_amount?: number;
        status?: Order_status;
        return_requested?: boolean;
        comment?: string | null;
        operator?: string | null;
        post_id?: string | null;
        canceled_post_id?: string | null;
        branch_id?: string | null;
        current_batch_id?: string | null;
        courier_id?: string | null;
        assigned_at?: string | Date | null;
        return_reason?: string | null;
        district_id?: string | null;
        region_id?: string | null;
        address?: string | null;
        qr_code_token?: string | null;
        external_id?: string | null;
        source?: Order_source;
        items?: Array<{ product_id: string; quantity?: number }>;
      };
      requester?: { id?: string; roles?: string[]; note?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    // Backward compatibility: old pattern now supports full update payload too.
    return this.executeAndAck(context, () =>
      this.lifecycleService.updateFull(data.id, data.dto, data.requester),
    );
  }

  @MessagePattern({ cmd: 'order.update_full' })
  updateFull(
    @Payload()
    data: {
      id: string;
      dto: {
        market_id?: string;
        customer_id?: string;
        where_deliver?: Where_deliver;
        total_price?: number;
        to_be_paid?: number;
        /** Faqat hamkor posilkasini yangilash (Fnu6PRya). */
        paid_online_amount?: number;
        paid_amount?: number;
        status?: Order_status;
        return_requested?: boolean;
        comment?: string | null;
        operator?: string | null;
        post_id?: string | null;
        canceled_post_id?: string | null;
        branch_id?: string | null;
        current_batch_id?: string | null;
        courier_id?: string | null;
        assigned_at?: string | Date | null;
        return_reason?: string | null;
        district_id?: string | null;
        region_id?: string | null;
        address?: string | null;
        qr_code_token?: string | null;
        external_id?: string | null;
        source?: Order_source;
        items?: Array<{ product_id: string; quantity?: number }>;
      };
      requester?: { id?: string; roles?: string[]; note?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.updateFull(data.id, data.dto, data.requester),
    );
  }

  /**
   * ONLAYN TO'LOVNI QAYD ETISH (7-bosqich).
   *
   * ⚠️ Pulni kassaga KO'CHIRMAYDI — faqat buyurtmadagi to'lov maydonlarini
   * yangilaydi. Dublikatning qat'iy to'sig'i chaqiruvchida
   * (`payment_transactions` UNIQUE), shu bois bu handler idempotentlikni
   * o'zi ta'minlamaydi.
   */
  @MessagePattern({ cmd: 'order.payment.record' })
  recordOnlinePayment(@Payload() data: any, @Ctx() context: RmqContext) {
    /**
     * ⚠️ `runIdempotent`, `executeAndAck` EMAS (adversarial topilma, kritik).
     *
     * RMQ `at-least-once` yetkazadi: ack yo'lda yo'qolsa xabar QAYTA
     * keladi. `recordOnlinePayment` esa KUMULATIV
     * (`paid_online_amount += amount`) — ya'ni qayta yetkazish summani
     * ikki marta qo'shardi va buyurtma "ortiqcha to'langan" bo'lib qolardi.
     *
     * Chaqiruvchi tomonidagi `payment_transactions` UNIQUE bu holatdan
     * QUTQARMAYDI: u integration-service ichida, bu esa order-service'ga
     * kelgan xabarning qayta yetkazilishi.
     *
     * Kalit tranzaksiya va holatdan yasaladi — ayni to'lov hodisasi bir
     * marta qo'llanadi, `pending`/`succeeded`/`refunded` esa alohida.
     */
    const requestId =
      data?.request_id ??
      [
        'payment',
        String(data?.integration_slug ?? ''),
        String(data?.provider_transaction_id ?? ''),
        String(data?.status ?? ''),
      ].join(':');

    return this.runIdempotent(context, 'order.payment.record', requestId, () =>
      this.lifecycleService.recordOnlinePayment(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.receive_external' })
  receiveExternalOrders(
    @Payload() data: { integration_id: string; orders: any[] },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.receiveExternalOrders(data),
    );
  }

  @MessagePattern({ cmd: 'order.external.find_all' })
  findAllExternal(
    @Payload()
    data: {
      query: {
        market_id?: string;
        status?: Order_status | Order_status[] | string | string[];
        start_day?: string;
        end_day?: string;
        fetch_all?: boolean | string;
        page?: number;
        limit?: number;
      };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findAllExternal(data.query ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.external.create' })
  createExternal(
    @Payload()
    data: {
      dto: {
        market_id: string;
        customer_id: string;
        where_deliver?: Where_deliver;
        total_price?: number;
        to_be_paid?: number;
        paid_amount?: number;
        status?: Order_status;
        comment?: string | null;
        operator?: string | null;
        post_id?: string | null;
        district_id?: string | null;
        region_id?: string | null;
        address?: string | null;
        qr_code_token?: string | null;
        external_id?: string | null;
        items?: Array<{ product_id: string; quantity?: number }>;
      };
      /**
       * fix3b: gateway (POST /orders/external) so'rovchini DOIM uzatadi.
       * Ilgari bu handler uni tashlab yuborardi — `createExternalOrder`
       * har kimni imtiyozsiz deb hisoblardi (SA/ADMIN maydonlari ham
       * olib tashlanardi) va filial xodimi buyurtmasi HQ ga tushardi.
       */
      requester?: {
        id?: string;
        roles?: string[];
        branch_id?: string | null;
      } | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.createExternalOrder(data.dto, data.requester),
    );
  }

  @MessagePattern({ cmd: 'order.delete' })
  remove(
    @Payload()
    data: { id: string; requester?: { id?: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.remove(data.id, data.requester),
    );
  }

  // ==================== Enriched Endpoints ====================

  @MessagePattern({ cmd: 'order.find_all_enriched' })
  findAllEnriched(
    @Payload() data: { query: Record<string, unknown> },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findAllEnriched(data.query as any),
    );
  }

  @MessagePattern({ cmd: 'order.find_by_id_enriched' })
  findByIdEnriched(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findByIdEnriched(data.id),
    );
  }

  /**
   * Kiruvchi posilkalarning manbalari — "Kiruvchi posilkalar" ekrani avval
   * manba so'raydi, keyin o'sha manbaning posilkalarini skanerlaydi.
   */
  @MessagePattern({ cmd: 'order.find_external_sources' })
  findExternalSources(
    @Payload() data: { branch_id?: string } | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findExternalSourcesEnriched(data?.branch_id),
    );
  }

  @MessagePattern({ cmd: 'order.find_new_markets_enriched' })
  findNewMarketsEnriched(
    @Payload()
    data: { branch_id?: string; exclude_branch_source?: boolean } | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findNewMarketsEnriched(
        data?.branch_id,
        Boolean(data?.exclude_branch_source),
      ),
    );
  }

  @MessagePattern({ cmd: 'order.find_new_by_market_enriched' })
  findNewByMarketEnriched(
    @Payload()
    data: {
      market_id: string;
      branch_id?: string;
      exclude_branch_source?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findNewByMarketEnriched(
        data.market_id,
        data.branch_id,
        Boolean(data?.exclude_branch_source),
      ),
    );
  }

  @MessagePattern({ cmd: 'order.find_cancelled_markets_enriched' })
  findCancelledMarketsEnriched(
    @Payload()
    data: {
      market_id?: string;
      branch_id?: string;
      holder_type?: OrderHolderType;
      exclude_branch_source?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findCancelledMarketsEnriched({
        market_id: data?.market_id,
        branch_id: data?.branch_id,
        holder_type: data.holder_type,
        exclude_branch_source: Boolean(data?.exclude_branch_source),
      }),
    );
  }

  @MessagePattern({ cmd: 'order.find_cancelled_by_market_enriched' })
  findCancelledByMarketEnriched(
    @Payload()
    data: {
      market_id: string;
      branch_id?: string;
      holder_type?: OrderHolderType;
      exclude_branch_source?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findCancelledByMarketEnriched(data.market_id, {
        branch_id: data?.branch_id,
        holder_type: data.holder_type,
        exclude_branch_source: Boolean(data?.exclude_branch_source),
      }),
    );
  }

  @MessagePattern({ cmd: 'order.market_cancelled_handover.create_qr' })
  createMarketCancelledHandoverQr(
    @Payload()
    data: {
      market_id: string;
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.createMarketCancelledHandoverQr(data),
    );
  }

  @MessagePattern({ cmd: 'order.market_cancelled_handover.scan_qr' })
  scanMarketCancelledHandoverQr(
    @Payload()
    data: {
      qr_token: string;
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.scanMarketCancelledHandoverQr(data),
    );
  }

  @MessagePattern({ cmd: 'order.market_cancelled_handover.complete' })
  completeMarketCancelledHandover(
    @Payload()
    data: {
      market_id: string;
      order_ids: string[];
      authorization_token?: string;
      manual_overrides?: Array<{ order_id: string; reason: string }>;
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.completeMarketCancelledHandover(data),
    );
  }

  @MessagePattern({ cmd: 'order.update_normalized' })
  updateNormalized(
    @Payload()
    data: {
      id: string;
      dto: Record<string, any>;
      requester?: { id?: string; roles?: string[]; note?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => {
      const normalized = this.orderService.normalizeUpdatePayload(data.dto);
      return this.lifecycleService.updateFull(
        data.id,
        normalized as any,
        data.requester,
      );
    });
  }

  /**
   * PATCH /orders/:id va /:id/full — FAQAT gateway'ning HTTP tahrir yo'li
   * (fix3b; M11/CODE-03).
   *
   * Taqiqlangan maydon / rol / filial doirasi qoidalari (`updateFromApi`)
   * FAQAT shu yerda qo'llanadi. `order.update`, `order.update_full` va
   * `order.update_normalized` avvalgidek to'g'ridan-to'g'ri `updateFull` ga
   * boradi — ularni ichki oqimlar ishlatadi va status/custody maydonlarini
   * qonuniy yozadi: filial dispatch (registrator/menejer so'rovchisi bilan
   * `status: 'on the road'`, `post_id`, `branch_id`), logistika (pochta
   * yuborish/qabul, qaytarish), finance `writeOrderPayment` (so'rovchisiz
   * `paid`/`partly_paid` + `paid_amount`). Qoidalar o'sha naqshlarga
   * qo'yilsa bu oqimlar 400/403 bilan to'xtardi.
   *
   * DTO `order.update_normalized` dagi kabi normallashtiriladi (gateway xom
   * PATCH tanasini yuboradi).
   */
  @MessagePattern({ cmd: 'order.update_from_api' })
  updateFromApi(
    @Payload()
    data: {
      id: string;
      dto: Record<string, any>;
      requester?: { id?: string; roles?: string[]; note?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => {
      const normalized = this.orderService.normalizeUpdatePayload(
        data?.dto ?? {},
      );
      return this.lifecycleService.updateFromApi(
        data?.id,
        normalized,
        data?.requester,
      );
    });
  }

  /**
   * Filial paneli uchun barcha raqamlar — bazada hisoblanadi (Scale
   * 1-bosqich). Ilgari branch-service buyurtmalarni 5 000 talab tortib
   * olib JS'da sanardi.
   */
  @MessagePattern({ cmd: 'order.analytics.branch_dashboard' })
  branchDashboardStats(
    @Payload()
    data: {
      branch_ids?: string[];
      courier_ids?: string[];
      start?: string | null;
      end?: string | null;
      today_start: string;
      week_start: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.getBranchDashboardStats(data),
    );
  }

  /** Filiallar kesimidagi buyurtma soni — bitta so'rovda (Scale 1-bosqich). */
  @MessagePattern({ cmd: 'order.analytics.count_by_branch' })
  countOrdersByBranch(
    @Payload() data: { branch_ids?: string[]; status?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.countOrdersByBranch(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.cancel_reasons' })
  analyticsCancelReasons(
    @Payload()
    data: {
      startDate?: string;
      endDate?: string;
      market_id?: string;
      branch_id?: string;
      group_by?: 'market' | 'region' | 'courier';
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.getCancelReasonStats(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.overview' })
  analyticsOverview(
    @Payload()
    data: {
      startDate?: string;
      endDate?: string;
      branch_id?: string;
      all?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.getOverviewStats(
        data.startDate,
        data.endDate,
        data.branch_id,
        data.all,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.market_stats' })
  analyticsMarketStats(
    @Payload()
    data: { startDate?: string; endDate?: string; branch_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.getMarketStats(
        data.startDate,
        data.endDate,
        data.branch_id,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.courier_stats' })
  analyticsCourierStats(
    @Payload()
    data: { startDate?: string; endDate?: string; branch_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.getCourierStats(
        data.startDate,
        data.endDate,
        data.branch_id,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.top_markets' })
  analyticsTopMarkets(
    @Payload()
    data: {
      limit?: number;
      branch_id?: string;
      startDate?: string;
      endDate?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.getTopMarkets(
        data.limit,
        data.branch_id,
        data.startDate,
        data.endDate,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.top_couriers' })
  analyticsTopCouriers(
    @Payload() data: { limit?: number; branch_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.getTopCouriers(data.limit, data.branch_id),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.top_branches' })
  analyticsTopBranches(
    @Payload()
    data: {
      limit?: number;
      branch_id?: string;
      startDate?: string;
      endDate?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.getTopBranches(
        data.limit,
        data.branch_id,
        data.startDate,
        data.endDate,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.top_operators_by_market' })
  analyticsTopOperatorsByMarket(
    @Payload() data: { requester: { id: string }; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.getTopOperatorsByMarket(
        data.requester.id,
        data.limit,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.courier_stat' })
  analyticsCourierStat(
    @Payload()
    data: {
      requester: { id: string };
      startDate?: string;
      endDate?: string;
      all?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.getCourierStat(
        data.requester.id,
        data.startDate,
        data.endDate,
        data.all,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.market_stat' })
  analyticsMarketStat(
    @Payload()
    data: { requester: { id: string }; startDate?: string; endDate?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.getMarketStat(
        data.requester.id,
        data.startDate,
        data.endDate,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.revenue' })
  analyticsRevenue(
    @Payload() data: { startDate?: string; endDate?: string; period?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderAnalyticsService.getRevenueStats(
        data.startDate,
        data.endDate,
        data.period,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.create' })
  createTransferBatch(
    @Payload()
    data: {
      source_branch_id: string;
      destination_branch_id: string;
      order_ids?: string[];
      direction?: 'FORWARD' | 'RETURN';
      request_key: string;
      requester_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.createBranchTransferBatches(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.create_return' })
  createReturnTransferBatch(
    @Payload()
    data: {
      source_branch_id: string;
      order_ids: string[];
      request_key: string;
      requester_id?: string;
      notes?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.createBranchReturnBatches(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.cancel_many' })
  cancelTransferBatches(
    @Payload()
    data: {
      batch_ids: string[];
      remove_order_bindings?: boolean;
      requester_id?: string;
      notes?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.cancelBranchTransferBatches(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.history.add' })
  addTransferBatchHistory(
    @Payload()
    data: {
      batch_id?: string;
      user_id?: string;
      action?: 'CREATED' | 'SENT' | 'RECEIVED' | 'CANCELLED';
      notes?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.addBranchTransferBatchHistory(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.find_by_id' })
  findTransferBatchById(
    @Payload() data: { id?: string; batch_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.findBranchTransferBatchById(
        data?.id ?? data?.batch_id ?? '',
      ),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.find_all' })
  findTransferBatches(
    @Payload()
    data: {
      source_branch_id?: string;
      destination_branch_id?: string;
      status?: string;
      direction?: string;
      period?: string;
      date?: string;
      page?: number;
      limit?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.findBranchTransferBatches(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.find_branches_with_sent' })
  findBranchesWithSentTransferBatches(
    @Payload()
    data: {
      direction?: string;
      side?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.findBranchesWithSentTransferBatches(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.send' })
  sendTransferBatch(
    @Payload()
    data: {
      batch_id?: string;
      order_ids?: string[];
      orderIds?: string[];
      vehicle_plate?: string;
      driver_name?: string;
      driver_phone?: string;
      requester_id?: string;
      requester_name?: string;
      requester_roles?: string[];
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.sendBranchTransferBatch(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.find_remaining' })
  findRemainingTransferBatchItems(
    @Payload() data: { id?: string; batch_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.findRemainingBranchTransferBatchItems(
        data?.id ?? data?.batch_id ?? '',
      ),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.receive' })
  receiveTransferBatch(
    @Payload()
    data: {
      batch_id?: string;
      requester_id?: string;
      requester_name?: string;
      requester_roles?: string[];
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.receiveBranchTransferBatch(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.receive_orders' })
  receiveTransferBatchOrders(
    @Payload()
    data: {
      batch_id?: string;
      order_ids?: string[];
      requester_id?: string;
      requester_name?: string;
      requester_roles?: string[];
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.receiveBranchTransferBatchOrders(data),
    );
  }

  /**
   * P1b — kuryer skani orqali BITTA buyurtmani filialga qabul qilish.
   * `receive_orders`dan farqi: paket YOPILMAYDI va qolgan buyurtmalar
   * tegilmaydi (inkremental). Faqat logistics `scanAssignOrder` chaqiradi.
   */
  @MessagePattern({ cmd: 'order.transfer_batch.receive_one_by_scan' })
  receiveTransferBatchOneByScan(
    @Payload()
    data: {
      order_id?: string;
      courier_branch_id?: string;
      requester_id?: string;
      requester_name?: string;
      requester_roles?: string[];
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.receiveOneOrderByScan(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.cancel' })
  cancelTransferBatchSingle(
    @Payload()
    data: {
      batch_id?: string;
      reason?: string;
      requester_id?: string;
      requester_name?: string;
      requester_roles?: string[];
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.cancelBranchTransferBatch(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.find_by_qr' })
  findTransferBatchByQr(
    @Payload() data: { token?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.findBranchTransferBatchByQrToken(
        String(data?.token ?? '').trim(),
      ),
    );
  }

  @MessagePattern({ cmd: 'order.bulk_assign_batch' })
  bulkAssignBatch(
    @Payload()
    data: {
      batch_id?: string;
      order_ids?: string[];
      message_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.bulkAssignBatch(data),
    );
  }

  @MessagePattern({ cmd: 'order.bulk_remove_from_batch' })
  bulkRemoveFromBatch(
    @Payload()
    data: {
      batch_id?: string;
      message_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.transferBatchService.bulkRemoveFromBatch(data),
    );
  }

  // Status-only terminal transition reported by an external delivery provider
  // (no cashbox movement — see OrderServiceService.markByProvider).
  @MessagePattern({ cmd: 'order.provider.mark' })
  markByProvider(
    @Payload()
    data: {
      order_id: string;
      action: 'sell' | 'cancel' | 'return';
      provider_slug?: string | null;
      external_ref?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.lifecycleService.markByProvider(data),
    );
  }

  // Enriched, render-ready rows for label / receipt printing (gateway renders
  // the PDF/HTML). Cross-service batch resolution lives in the service layer.
  @MessagePattern({ cmd: 'order.print.find' })
  findOrdersForPrint(
    @Payload() data: { order_ids: string[] },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findOrdersForPrint(data?.order_ids ?? []),
    );
  }

  @MessagePattern({ cmd: 'order.activity_log.find_all' })
  activityLogFindAll(
    @Payload() data: { query?: ActivityLogQuery },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.auditLogQuery(data?.query ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.activity_log.find_by_entity' })
  activityLogFindByEntity(
    @Payload()
    data: { entity_type: string; entity_id: string; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.auditLogByEntity(
        data.entity_type,
        data.entity_id,
        data.limit,
      ),
    );
  }
}
