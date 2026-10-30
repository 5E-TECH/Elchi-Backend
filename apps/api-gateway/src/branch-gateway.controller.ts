import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Roles as RoleEnum } from '@app/common';
import { firstValueFrom, map, timeout } from 'rxjs';
import { projectOrderContactsForRoles } from './auth/order-contact-projection';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { ParseBigintIdPipe } from './pipes/parse-bigint-id.pipe';
import {
  LOGIST_REGIONS_UNAVAILABLE_MESSAGE,
  LogistRegionScopeService,
  isLogistRequester,
  isRowInLogistRegions,
  projectLogistPayload,
  resolveLogistRegionFilter,
} from './auth/logist-scope';
import {
  AssignBranchUserRequestDto,
  CancelTransferBatchRequestDto,
  CreateBranchTransferBatchesRequestDto,
  CreateReturnBatchesRequestDto,
  CreateBranchRequestDto,
  HqBranchResponseDto,
  ReceiveTransferBatchOrdersRequestDto,
  SendTransferBatchRequestDto,
  SetBranchConfigRequestDto,
  TransferBatchDetailDto,
  TransferBatchHistoryResponseDto,
  TransferCourierBranchRequestDto,
  UpdateBranchConfigRequestDto,
  UpdateBranchRequestDto,
} from './dto/branch.swagger.dto';

// Batch RPC ceiling: transfer-batch / return-batch / post-dispatch operations
// fan out to a SEQUENTIAL, unbounded per-order loop downstream (branch-service
// awaits order.update once per order, each with its own 15s budget). An 8s
// gateway cap sits below even one iteration, so it would premature-fail a large
// batch mid-flight — the handler keeps running (partial commit) while the client
// retries a non-idempotent op → duplicate order reassignments. This generous
// ceiling still bounds a true infinite hang. (Proper fix: parallelise + make the
// downstream loop atomic — tracked separately.)
const BATCH_RPC_TIMEOUT_MS = 120_000;

// Kuryerni filialdan filialga o'tkazish (R3) byudjeti. branch-service: uch
// tekshiruv manbasi parallel (5 s; sof-nol PENDING holatida C8 yopish 3 s +
// qayta yuklash 5 s qo'shiladi), tranzaksiya, 1,5 s kutish, qayta tekshiruv
// (5 s), identity hududi (5 s) va xatoda qaytarish + hudud tiklash (3 s) —
// eng yomon holat ~32,5 s, odatda ~2 s. Gateway undan uzun bo'lishi SHART:
// aks holda mijoz 504 olib, o'tkazish orqada baribir yakunlanadi. FE bu
// so'rovni 120 s kutadi (LONG_REQUEST_TIMEOUT_MS).
const COURIER_TRANSFER_RPC_TIMEOUT_MS = 40_000;

// Filialdan xodimni chiqarish: kuryer qatori uchun (R3) finance, order va
// logistics parallel tekshiriladi (5 s); sof-nol PENDING holatida (C8) yopish
// (3 s) va qayta tekshiruv (5 s) — eng yomon holat ~13 s.
const BRANCH_USER_REMOVE_RPC_TIMEOUT_MS = 20_000;

/** Satr yoki son → kesilgan satr; boshqa tur — ''. */
const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** `{ data: X }` yoki X — ikkalasidan X (branch-service o'rami). */
const unwrapData = (value: unknown): Record<string, unknown> | null => {
  const record = asRecord(value);
  return record && 'data' in record ? asRecord(record.data) : record;
};

@ApiTags('Branch')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class BranchGatewayController {
  constructor(
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    // Z3pUOxou — logist viloyatlari. Yo'q bo'lsa logist so'rovi 503
    // (fail-closed); boshqa rollar unga bog'liq emas.
    @Optional() private readonly logistScope?: LogistRegionScopeService,
  ) {}

  /** Z3pUOxou: logistning viloyatlari (xizmat yo'q/xato — 503). */
  private async logistRegionIds(req: {
    user?: { sub?: string; roles?: string[] };
  }): Promise<string[]> {
    if (!this.logistScope) {
      throw new ServiceUnavailableException(LOGIST_REGIONS_UNAVAILABLE_MESSAGE);
    }
    return this.logistScope.regionIds(req?.user?.sub);
  }

  private toRequester(req: { user?: { sub?: string; roles?: string[] } }) {
    return {
      id: String(req?.user?.sub ?? ''),
      roles: req?.user?.roles ?? [],
    };
  }

  /** Kuryer id (URL) — faqat raqamlar, aks holda 400. */
  private parseCourierIdParam(id: string): string {
    const normalized = String(id ?? '').trim();
    if (!/^\d+$/.test(normalized)) {
      throw new BadRequestException("Kuryer id noto'g'ri");
    }
    return normalized;
  }

  private async resolveSourceBranchIdForDispatch(req: {
    user?: { sub?: string; roles?: string[] };
  }): Promise<string> {
    const requester = this.toRequester(req);
    const requesterRoles = (requester.roles ?? []).map((role) =>
      String(role ?? '').toLowerCase(),
    );
    const isSystemPrivileged =
      requesterRoles.includes(RoleEnum.SUPERADMIN) ||
      requesterRoles.includes(RoleEnum.ADMIN);

    if (isSystemPrivileged) {
      const hqResponse = await firstValueFrom(
        this.branchClient
          .send({ cmd: 'branch.find_by_code' }, { code: 'HQ-TSHKNT' })
          .pipe(timeout(8000)),
      );
      const hqBranchId = String(hqResponse?.data?.id ?? '').trim();
      if (!hqBranchId) {
        throw new BadRequestException('HQ filial topilmadi (code=HQ-TSHKNT)');
      }
      return hqBranchId;
    }

    const assignmentResponse = await firstValueFrom(
      this.branchClient
        .send(
          { cmd: 'branch.user.find_by_user' },
          { user_id: requester.id, requester },
        )
        .pipe(timeout(8000)),
    );
    const assignedBranchId = String(
      assignmentResponse?.data?.branch_id ?? '',
    ).trim();
    if (!assignedBranchId) {
      throw new BadRequestException(
        'Foydalanuvchi hech qaysi filialga biriktirilmagan',
      );
    }

    return assignedBranchId;
  }

  @Post('branches')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create branch' })
  @ApiBody({ type: CreateBranchRequestDto })
  createBranch(
    @Body() dto: CreateBranchRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send({ cmd: 'branch.create' }, { dto, requester: this.toRequester(req) })
      .pipe(timeout(8000));
  }

  @Get('branches')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List branches (pagination + search + status)' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'inactive'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAllBranches(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.find_all' },
        {
          requester: this.toRequester(req ?? {}),
          query: {
            search,
            status,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Get('branches/tree')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get full branch tree (nested)' })
  findBranchTree() {
    return this.branchClient
      .send({ cmd: 'branch.tree' }, {})
      .pipe(timeout(8000));
  }

  @Get('branches/with-sent-batches')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({ summary: 'List branches that have SENT transfer batches' })
  @ApiQuery({ name: 'direction', required: false, enum: ['FORWARD', 'RETURN'] })
  @ApiQuery({ name: 'side', required: false, enum: ['source', 'destination'] })
  findBranchesWithSentBatches(
    @Query('direction') direction: string | undefined,
    @Query('side') side: 'source' | 'destination' | undefined,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.transfer_batches.sent_branches' },
        {
          requester: this.toRequester(req),
          query: { direction, side },
        },
      )
      .pipe(timeout(BATCH_RPC_TIMEOUT_MS));
  }

  /**
   * Pochta jo'natish oynasi uchun manzil filiallar: faol REGIONAL/HYBRID,
   * menejer ma'lumoti bilan, PUL MAYDONLARISIZ. Kirish tekshiruvi
   * branch-service'da (superadmin/admin yoki HQ registratori, qolganlar 403).
   *
   * ⚠️ `branches/:id` dan OLDIN e'lon qilinishi SHART — aks holda `:id`
   * marshruti so'rovni `id='dispatch-destinations'` bilan tutib oladi va
   * registrator 403 oladi (branch-gateway.route-order.spec.ts tekshiradi).
   */
  @Get('branches/dispatch-destinations')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiOperation({
    summary:
      "Pochta jo'natish uchun manzil filiallar (faol REGIONAL/HYBRID, pul maydonlarisiz)",
  })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  findDispatchDestinations(
    @Query('region_id') regionId: string | undefined,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.dispatch_destinations' },
        {
          requester: this.toRequester(req),
          query: { region_id: regionId },
        },
      )
      .pipe(timeout(8000));
  }

  /**
   * Pa1KaXmj: HQ filiali — «Markaziy ombor» ochish oynasi uchun (SUPERADMIN,
   * ADMIN). Mavjud `branch.find_hq` ustida; javob — OQ RO'YXAT (pul/maosh
   * maydonlarisiz: `ownership`, `per_order_share`, `manager_id` chiqmaydi).
   * Hudud nomi — `branch.find_by_id` dan, best-effort (olinmasa `region:
   * null`, javob baribir 200). HQ topilmasa — 404.
   *
   * `dispatch-destinations` o'zgarmaydi: u pochta manzillari uchun (HQ'siz).
   * ⚠️ `branches/:id` dan OLDIN — aks holda `ParseBigintIdPipe` 400 qaytaradi.
   */
  @Get('branches/hq')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'HQ filiali (Markaziy ombor ochish uchun, pul maydonlarisiz)',
    description:
      'Javob `{ statusCode, message, data: { id, name, code, type, status, address, region_id, region: { id, name } | null } }`. «Ombor ochish» oynasida HQ shu yerdan olinadi (Markaziy ombor), viloyat filiallari — `GET /branches/dispatch-destinations`. HQ topilmasa — 404.',
  })
  @ApiOkResponse({ type: HqBranchResponseDto })
  async findHqBranch(
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    const response: unknown = await firstValueFrom(
      this.branchClient.send({ cmd: 'branch.find_hq' }, {}).pipe(timeout(8000)),
    );
    const row = unwrapData(response);
    const id = text(row?.id);
    if (!row || !id) {
      throw new NotFoundException('HQ filial topilmadi');
    }
    const regionId = text(row.region_id) || null;
    let region: { id: string; name: string } | null = null;
    if (regionId) {
      try {
        const detail: unknown = await firstValueFrom(
          this.branchClient
            .send(
              { cmd: 'branch.find_by_id' },
              { id, requester: this.toRequester(req) },
            )
            .pipe(timeout(8000)),
        );
        const raw = asRecord(unwrapData(detail)?.region);
        if (raw && text(raw.id)) {
          region = { id: text(raw.id), name: text(raw.name) };
        }
      } catch {
        // Hudud nomi — bezak: olinmasa `null`, HQ baribir qaytadi.
      }
    }
    return {
      statusCode: 200,
      message: 'HQ branch',
      data: {
        id,
        name: text(row.name),
        code: text(row.code) || null,
        type: text(row.type),
        status: text(row.status),
        address: text(row.address) || null,
        region_id: regionId,
        region,
      },
    };
  }

  // ⚠️ `branches/:id` dan OLDIN turishi SHART — aks holda `:id` marshruti
  // so'rovni `id='new-orders'` bilan tutib oladi (branch-gateway.route-order.spec.ts).
  @Get('branches/new-orders')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({ summary: 'Branches that currently have NEW orders' })
  findBranchesWithNewOrders(
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.new_orders.branches' },
        { requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Get('branches/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Find branch by id' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  findBranchById(
    @Param('id', ParseBigintIdPipe) id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.find_by_id' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Get('branches/:id/descendants')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get all descendants of a branch (flat list)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  findBranchDescendants(@Param('id', ParseBigintIdPipe) id: string) {
    return this.branchClient
      .send({ cmd: 'branch.descendants' }, { id })
      .pipe(timeout(8000));
  }

  @Get('branches/:id/analytics/markets')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({
    summary: 'Branch market analytics (orders, delivered, total price)',
  })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  findBranchMarketsAnalytics(
    @Param('id', ParseBigintIdPipe) id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.analytics.markets' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(
        timeout(8000),
        // T7 (B3): menejer/filialga market telefonlarisiz.
        map((response: unknown) =>
          projectOrderContactsForRoles(req?.user?.roles, response),
        ),
      );
  }

  @Post('branches/transfer-batches')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({
    summary: "Create transfer batches from requester's branch by order_ids",
  })
  @ApiBody({ type: CreateBranchTransferBatchesRequestDto })
  createTransferBatches(
    @Body() dto: CreateBranchTransferBatchesRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.transfer_batches.create' },
        { dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(BATCH_RPC_TIMEOUT_MS));
  }

  @Post('branches/:id/return-batches')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({
    summary:
      'Create return batches grouped by original branch (direction=RETURN, QR=BTR-*)',
  })
  @ApiParam({
    name: 'id',
    description: 'Source branch ID (HQ / current branch)',
  })
  @ApiBody({ type: CreateReturnBatchesRequestDto })
  createReturnBatches(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: CreateReturnBatchesRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.return_batches.create' },
        { id, dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(BATCH_RPC_TIMEOUT_MS));
  }

  @Patch('transfer-batches/:id/send')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({ summary: 'Mark transfer batch as sent with vehicle info' })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  @ApiBody({ type: SendTransferBatchRequestDto })
  sendTransferBatchPatch(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: SendTransferBatchRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.transfer_batches.send' },
        { id, dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(BATCH_RPC_TIMEOUT_MS));
  }

  @Get('transfer-batches')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    // Z3pUOxou (ega LG-S1/LG-S3): logist — faqat ko'rish, o'z viloyatlari.
    RoleEnum.LOGIST,
  )
  @ApiOperation({
    summary: 'List transfer batches',
    description:
      "(15N7AHkp) Statussiz yoki `status=PENDING` da bir yo'nalishdagi (manba, manzil, yo'nalish, hudud) PENDING " +
      "partiyalardan faqat eng yangisi qaytadi — yig'ish SQL'da, shuning uchun `meta.total`/`totalPages` HAQIQIY jami " +
      '(ilgari sahifadagi qatorlar soni edi). Tartib: createdAt DESC, id DESC. ' +
      "Z3pUOxou — LOGIST: faqat o'z viloyatlariga boruvchi paketlar (`target_region_id IN` o'z viloyatlari; " +
      "`target_region_id` filtri — faqat o'z viloyati, boshqasi 400; biriktirilmagan — bo'sh), `total_price` va " +
      "`items[].snapshot_price` yo'q.",
  })
  @ApiQuery({ name: 'source_branch_id', required: false, type: String })
  @ApiQuery({ name: 'destination_branch_id', required: false, type: String })
  @ApiQuery({
    name: 'target_region_id',
    required: false,
    type: String,
    description:
      "Z3pUOxou (N17): maqsad viloyat filtri (toraytiradi). Logist uchun — faqat o'z viloyatlaridan biri.",
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'SENT', 'RECEIVED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'direction', required: false, enum: ['FORWARD', 'RETURN'] })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['today', 'week', 'month'],
  })
  @ApiQuery({
    name: 'date',
    required: false,
    type: String,
    description: 'YYYY-MM-DD or ISO datetime',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findTransferBatches(
    @Query('source_branch_id') sourceBranchId: string | undefined,
    @Query('destination_branch_id') destinationBranchId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('direction') direction: string | undefined,
    @Query('period') period: string | undefined,
    @Query('date') date: string | undefined,
    @Query('page') page: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
    @Query('target_region_id') targetRegionId?: string,
  ) {
    const query = {
      source_branch_id: sourceBranchId,
      destination_branch_id: destinationBranchId,
      status,
      direction,
      period,
      date,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      target_region_id: targetRegionId
        ? String(targetRegionId).trim()
        : undefined,
    };
    if (isLogistRequester(req?.user?.roles)) {
      return this.findTransferBatchesForLogist(query, req);
    }
    return this.branchClient
      .send(
        { cmd: 'branch.transfer_batches.find_all' },
        { requester: this.toRequester(req), query },
      )
      .pipe(timeout(BATCH_RPC_TIMEOUT_MS));
  }

  /**
   * Z3pUOxou — logist paketlari: viloyatlar gateway'da aniqlanadi va
   * branch-service'ga `requester.region_ids` sifatida uzatiladi. Javob qatori
   * yana tekshiriladi (himoya) va pul maydonlari olib tashlanadi.
   */
  private async findTransferBatchesForLogist(
    query: Record<string, unknown> & { target_region_id?: string },
    req: { user?: { sub?: string; roles?: string[] } },
  ) {
    const regionIds = await this.logistRegionIds(req);
    const targetRegionId = resolveLogistRegionFilter(
      query.target_region_id,
      regionIds,
    );
    const response: unknown = await firstValueFrom(
      this.branchClient
        .send(
          { cmd: 'branch.transfer_batches.find_all' },
          {
            requester: { ...this.toRequester(req), region_ids: regionIds },
            query: { ...query, target_region_id: targetRegionId ?? undefined },
          },
        )
        .pipe(timeout(BATCH_RPC_TIMEOUT_MS)),
    );
    const data = (response as { data?: { items?: unknown } } | null)?.data;
    const scoped =
      data && Array.isArray(data.items)
        ? {
            ...(response as object),
            data: {
              ...data,
              items: (data.items as unknown[]).filter((batch) =>
                isRowInLogistRegions(batch, regionIds, 'target_region_id'),
              ),
            },
          }
        : response;
    return projectLogistPayload(req?.user?.roles, scoped);
  }

  @Get('transfer-batches/:id')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    // Z3pUOxou: logist — o'z viloyatiga boruvchi paket (boshqasi 403), pulsiz.
    RoleEnum.LOGIST,
  )
  @ApiOperation({
    summary: 'Get transfer batch by id',
    description:
      "3HKvAyhm: javobda `source_branch` / `destination_branch` `{ id, name }` — menejer ham filial nomini ko'radi (`GET branches/:id` faqat SA/admin). " +
      "Z3pUOxou — LOGIST: paket o'z viloyatiga (`target_region_id`) boruvchi bo'lsa, aks holda 403; `total_price`, `items[].snapshot_price` va `items[].order` dagi pul maydonlari yo'q.",
  })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  @ApiOkResponse({ type: TransferBatchDetailDto })
  findTransferBatchById(
    @Param('id', ParseBigintIdPipe) id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    if (isLogistRequester(req?.user?.roles)) {
      return this.findTransferBatchByIdForLogist(id, req);
    }
    return this.branchClient
      .send(
        { cmd: 'branch.transfer_batches.find_by_id' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(
        timeout(BATCH_RPC_TIMEOUT_MS),
        // T7 (B3): `items[].order` — menejer/filialga market va operator
        // telefonlarisiz.
        map((response: unknown) =>
          projectOrderContactsForRoles(req?.user?.roles, response),
        ),
      );
  }

  /** Z3pUOxou — logist paket tafsiloti: doira branch-service'da, pulsiz. */
  private async findTransferBatchByIdForLogist(
    id: string,
    req: { user?: { sub?: string; roles?: string[] } },
  ) {
    const regionIds = await this.logistRegionIds(req);
    const response: unknown = await firstValueFrom(
      this.branchClient
        .send(
          { cmd: 'branch.transfer_batches.find_by_id' },
          {
            id,
            requester: { ...this.toRequester(req), region_ids: regionIds },
          },
        )
        .pipe(timeout(BATCH_RPC_TIMEOUT_MS)),
    );
    return projectLogistPayload(req?.user?.roles, response);
  }

  @Get('transfer-batches/:id/history')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({
    summary: 'Transfer batch history (3HKvAyhm)',
    description:
      "Paket tarixi xronologik (eng eskisi birinchi): yaratildi / jo'natildi / qabul qilindi / bekor qilindi. Kirish — `GET /transfer-batches/:id` bilan bir xil (jo'natuvchi yoki qabul qiluvchi filial).",
  })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  @ApiOkResponse({ type: TransferBatchHistoryResponseDto })
  findTransferBatchHistory(
    @Param('id', ParseBigintIdPipe) id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.transfer_batches.history' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(timeout(BATCH_RPC_TIMEOUT_MS));
  }

  @Get('transfer-batches/:id/remaining')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({
    summary: 'Get remaining (not sent) items of transfer batch by id',
  })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  findRemainingTransferBatchById(
    @Param('id', ParseBigintIdPipe) id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.transfer_batches.find_remaining' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(
        timeout(BATCH_RPC_TIMEOUT_MS),
        // T7 (B3): menejer/filialga market va operator telefonlarisiz.
        map((response: unknown) =>
          projectOrderContactsForRoles(req?.user?.roles, response),
        ),
      );
  }

  @Post('transfer-batches/:id/receive')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({
    summary: 'Receive transfer batch by destination branch staff',
  })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  receiveTransferBatch(
    @Param('id', ParseBigintIdPipe) id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.transfer_batches.receive' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(timeout(BATCH_RPC_TIMEOUT_MS));
  }

  @Post('transfer-batches/:id/receive-orders')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({
    summary:
      'Receive selected orders from transfer batch by destination branch staff',
  })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  @ApiBody({ type: ReceiveTransferBatchOrdersRequestDto })
  receiveTransferBatchOrders(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: ReceiveTransferBatchOrdersRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.transfer_batches.receive_orders' },
        { id, dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(BATCH_RPC_TIMEOUT_MS));
  }

  @Post('transfer-batches/:id/cancel')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({ summary: 'Cancel transfer batch and unassign its orders' })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  @ApiBody({ type: CancelTransferBatchRequestDto })
  cancelTransferBatch(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: CancelTransferBatchRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.transfer_batches.cancel' },
        { id, dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(BATCH_RPC_TIMEOUT_MS));
  }

  @Post('branches/posts/:postId/dispatch')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({ summary: 'Dispatch HQ post to destination branch' })
  @ApiParam({ name: 'postId', description: 'Logistics post ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['destination_branch_id', 'order_ids'],
      properties: {
        destination_branch_id: {
          type: 'string',
          example: '12',
          description: 'Destination branch ID',
        },
        order_ids: {
          type: 'array',
          items: { type: 'string' },
          example: ['101', '102'],
          description:
            "Majburiy: pochtadan jo'natiladigan buyurtmalar. Birortasi shu pochtada bo'lmasa — 409 (id'lar xabarda), hech narsa jo'natilmaydi",
        },
      },
    },
  })
  async dispatchPostToBranch(
    @Param('postId') postId: string,
    @Body('destination_branch_id') destinationBranchId: string,
    @Body('order_ids') orderIds: string[] | undefined,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    const normalizedOrderIds = Array.isArray(orderIds)
      ? orderIds.map((id) => String(id ?? '').trim()).filter(Boolean)
      : [];
    if (!normalizedOrderIds.length) {
      throw new BadRequestException(
        'order_ids majburiy — kamida bitta buyurtma tanlang',
      );
    }

    const sourceBranchId = await this.resolveSourceBranchIdForDispatch(req);
    return this.branchClient
      .send(
        { cmd: 'branch.post.dispatch' },
        {
          source_branch_id: sourceBranchId,
          post_id: postId,
          destination_branch_id: destinationBranchId,
          order_ids: normalizedOrderIds,
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(BATCH_RPC_TIMEOUT_MS));
  }

  @Patch('branches/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiBody({ type: UpdateBranchRequestDto })
  updateBranch(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: UpdateBranchRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.update' },
        { id, dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Delete('branches/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete branch (soft delete)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  deleteBranch(
    @Param('id', ParseBigintIdPipe) id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send({ cmd: 'branch.delete' }, { id, requester: this.toRequester(req) })
      .pipe(timeout(8000));
  }

  @Post('branches/:id/users')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Assign user to branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiBody({ type: AssignBranchUserRequestDto })
  assignUserToBranch(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: AssignBranchUserRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    // 15 s: yetim kuryerni boshqa filialga biriktirishda (R3) branch-service
    // identity (5 s) va uch parallel tekshiruv manbasini (5 s) kutadi.
    return this.branchClient
      .send(
        { cmd: 'branch.user.assign' },
        { requester: this.toRequester(req), dto: { branch_id: id, ...dto } },
      )
      .pipe(timeout(15000));
  }

  @Delete('branches/:id/users/:userId')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Remove user from branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiParam({ name: 'userId', description: 'User ID (bigint string)' })
  removeUserFromBranch(
    @Param('id', ParseBigintIdPipe) id: string,
    @Param('userId', ParseBigintIdPipe) userId: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.user.remove' },
        { branch_id: id, user_id: userId, requester: this.toRequester(req) },
      )
      .pipe(timeout(BRANCH_USER_REMOVE_RPC_TIMEOUT_MS));
  }

  @Get('couriers/:id/transfer-check')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      'Courier branch-transfer check: cashbox, orders in hand, unreceived cancelled posts (read-only)',
  })
  @ApiParam({ name: 'id', description: 'Courier user ID (bigint string)' })
  courierTransferCheck(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    const courierId = this.parseCourierIdParam(id);
    return this.branchClient
      .send(
        { cmd: 'branch.user.courier_transfer_check' },
        { user_id: courierId, requester: this.toRequester(req) },
      )
      .pipe(timeout(15000));
  }

  @Patch('couriers/:id/branch')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      'Move courier to another branch (only when the courier holds no money and no orders)',
  })
  @ApiParam({ name: 'id', description: 'Courier user ID (bigint string)' })
  @ApiBody({ type: TransferCourierBranchRequestDto })
  transferCourierBranch(
    @Param('id') id: string,
    @Body() dto: TransferCourierBranchRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    const courierId = this.parseCourierIdParam(id);
    return this.branchClient
      .send(
        { cmd: 'branch.user.transfer_courier' },
        {
          user_id: courierId,
          branch_id: dto.branch_id,
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(COURIER_TRANSFER_RPC_TIMEOUT_MS));
  }

  @Get('branches/:id/users')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get users assigned to branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  getBranchUsers(
    @Param('id', ParseBigintIdPipe) id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.user.find_by_branch' },
        { branch_id: id, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Get('branches/:id/config')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get branch config list' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  getBranchConfig(
    @Param('id', ParseBigintIdPipe) id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.config.get' },
        { branch_id: id, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Post('branches/:id/config')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Set branch config' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiBody({ type: SetBranchConfigRequestDto })
  setBranchConfig(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: SetBranchConfigRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.config.set' },
        { requester: this.toRequester(req), dto: { branch_id: id, ...dto } },
      )
      .pipe(timeout(8000));
  }

  @Get('branches/:id/config/:key')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get single branch config by key' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiParam({ name: 'key', description: 'Config key' })
  getBranchConfigByKey(
    @Param('id', ParseBigintIdPipe) id: string,
    @Param('key') key: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.config.find_one' },
        { branch_id: id, config_key: key, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Patch('branches/:id/config/:key')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update branch config by key' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiParam({ name: 'key', description: 'Config key' })
  @ApiBody({ type: UpdateBranchConfigRequestDto })
  updateBranchConfigByKey(
    @Param('id', ParseBigintIdPipe) id: string,
    @Param('key') key: string,
    @Body() dto: UpdateBranchConfigRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.config.update' },
        {
          requester: this.toRequester(req),
          dto: { branch_id: id, config_key: key, ...dto },
        },
      )
      .pipe(timeout(8000));
  }

  @Delete('branches/:id/config/:key')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete branch config by key (soft delete)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiParam({ name: 'key', description: 'Config key' })
  deleteBranchConfigByKey(
    @Param('id', ParseBigintIdPipe) id: string,
    @Param('key') key: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.config.delete' },
        { branch_id: id, config_key: key, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }
}
