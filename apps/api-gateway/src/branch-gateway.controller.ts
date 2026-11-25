import { Throttle } from '@nestjs/throttler';
import { SCAN_THROTTLE } from './auth/scan-throttle';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Roles as RoleEnum } from '@app/common';
import {
  Observable,
  catchError,
  defer,
  firstValueFrom,
  map,
  of,
  switchMap,
  throwError,
  timeout,
} from 'rxjs';
import { projectOrderPayloadForRoles } from './auth/order-role-projection';
import {
  ProblemContactsService,
  attachProblemContacts,
} from './contacts/problem-contacts.service';
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
  isTransferBatchInLogistRegions,
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
  SetBranchDistrictsRequestDto,
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

// Tuman qamrovi (ega qarori 2026-11-02): filial tumanlarini yozish —
// logistics'da filial tekshiruvi (branch RPC, 5 s), tranzaksiya va har o'zgargan
// tuman uchun activity log (500 tagacha). 8 s chegarasi katta ro'yxatda yetmay
// qolishi mumkin (mijoz 504 oladi, yozuv orqada baribir yakunlanadi). Filial
// almashsa (#619) logistics tumanlarning ochiq buyurtmalarini o'qirdi — 30 s.
// anKpzwxk: xizmat filiali viloyatni o'zgartirmaydi, o'qish endi yo'q; chegara
// katta ro'yxat uchun o'zgarmay qoldi.
const DISTRICT_COVERAGE_WRITE_RPC_TIMEOUT_MS = 30_000;
const LOGISTICS_UNAVAILABLE_MESSAGE =
  "Logistika xizmati mavjud emas — birozdan so'ng qayta urinib ko'ring";

// Pochta → HQ kuryeri (ega qarori 2026-11-15). Ro'yxat: logistics
// (ruxsat + branch + identity) — 15 s; carrier belgisi integration'dan —
// 3 s, yiqilsa ro'yxat baribir qaytadi (`carrier_lookup_failed: true`).
const POST_COURIER_DESTINATIONS_RPC_TIMEOUT_MS = 15_000;
const CARRIER_LINK_LOOKUP_TIMEOUT_MS = 3_000;
/** integration `find_by_courier_ids` bir so'rovda shuncha id qabul qiladi. */
const CARRIER_LINK_LOOKUP_CHUNK = 500;
/** Pochta → HQ kuryeri: bir so'rovdagi buyurtmalar chegarasi (logistics bilan bir xil). */
const POST_DISPATCH_TO_COURIER_MAX_ORDERS = 1000;
const ORDER_IDS_REQUIRED_MESSAGE =
  'order_ids majburiy — kamida bitta buyurtma tanlang';
// logistics `POST_COURIER_MESSAGES.ORDER_IDS_TOO_MANY` bilan bir xil: frontend
// tanlovni cheklamaydi — 1000 dan ortiq tanlangan pochtaga «kamida bitta
// tanlang» emas, aniq sabab chiqsin.
const ORDER_IDS_TOO_MANY_MESSAGE =
  'order_ids 1000 tadan oshmasin — pochtani qismlab bering';
const POST_COURIER_ID_INVALID_MESSAGE =
  "courier_id noto'g'ri — ro'yxatdan kuryerni tanlang";
const CARRIER_LINK_UNAVAILABLE_MESSAGE =
  "Kuryerning tashqi yetkazuvchiga bog'lanishini tekshirib bo'lmadi (integratsiya xizmati javob bermadi) — birozdan so'ng qayta urinib ko'ring";
const HQ_LOOKUP_UNAVAILABLE_MESSAGE =
  "HQ filialini aniqlab bo'lmadi (filial xizmati javob bermadi) — birozdan so'ng qayta urinib ko'ring";
const courierCarrierLinkedMessage = (carrierName: string): string =>
  `Kuryer «${carrierName}» tashqi yetkazuvchisiga bog'langan — u faqat HQ'da bo'ladi`;

/** Postgres BIGINT chegarasi. */
const BIGINT_MAX = 9223372036854775807n;

/** Satr ko'rinishidagi musbat bigint id → kanonik satr; boshqasi — `null`. */
const bigintIdText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{1,19}$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed > 0n && parsed <= BIGINT_MAX ? parsed.toString() : null;
};

type CarrierLink = { name: string; is_active: boolean };

/** integration `find_by_courier_ids` javobi → `courier_user_id` → link. */
const carrierLinksOf = (response: unknown): Map<string, CarrierLink> => {
  const record = asRecord(response);
  const rows: unknown[] = Array.isArray(record?.data)
    ? (record.data as unknown[])
    : Array.isArray(response)
      ? (response as unknown[])
      : [];
  const links = new Map<string, CarrierLink>();
  for (const row of rows) {
    const item = asRecord(row);
    const courierId = text(item?.courier_user_id);
    const name = text(item?.name);
    if (courierId && name) {
      links.set(courierId, { name, is_active: item?.is_active === true });
    }
  }
  return links;
};

const SYSTEM_PRIVILEGED_ROLES: readonly string[] = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
];

/** So'rovchi superadmin yoki admin (katta-kichik harfga qaramay). */
const isSystemPrivilegedRoles = (roles?: readonly unknown[] | null): boolean =>
  (roles ?? []).some((role) =>
    SYSTEM_PRIVILEGED_ROLES.includes(text(role).toLowerCase()),
  );

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
    // T7 (CqBD8V4p): paket buyurtmalariga `problem_contacts`. Yo'q (eski
    // spec'lar) — maydon qo'shilmaydi.
    @Optional() private readonly problemContacts?: ProblemContactsService,
    // Tuman qamrovi (`branches/:id/districts`): tumanlar logistics'da. Oxirida
    // va @Optional — mavjud pozitsion konstruktor chaqiruvlari buzilmasin;
    // yo'q bo'lsa shu marshrutlar 503 (fail-closed).
    @Optional()
    @Inject('LOGISTICS')
    private readonly logisticsClient?: ClientProxy,
    // Pochta → HQ kuryeri ro'yxatidagi «Tashqi: …» belgisi va carrier
    // kuryerini HQ'dan chiqarish to'sig'i (2026-11-15). Oxirida va @Optional —
    // eski pozitsion konstruktor chaqiruvlari buzilmasin.
    @Optional()
    @Inject('INTEGRATION')
    private readonly integrationClient?: ClientProxy,
  ) {}

  /**
   * Kuryer id'lari → bog'langan carrier (`integration.carrier.find_by_courier_ids`).
   * Yumshoq: mijoz yo'q / xato / timeout — `failed: true` (ro'yxat baribir
   * qaytadi, belgisiz).
   */
  private async lookupCarrierLinks(
    courierIds: string[],
  ): Promise<{ links: Map<string, CarrierLink>; failed: boolean }> {
    const links = new Map<string, CarrierLink>();
    if (!courierIds.length) {
      return { links, failed: false };
    }
    if (!this.integrationClient) {
      return { links, failed: true };
    }
    try {
      for (
        let start = 0;
        start < courierIds.length;
        start += CARRIER_LINK_LOOKUP_CHUNK
      ) {
        const response: unknown = await firstValueFrom(
          this.integrationClient
            .send(
              { cmd: 'integration.carrier.find_by_courier_ids' },
              {
                courier_ids: courierIds.slice(
                  start,
                  start + CARRIER_LINK_LOOKUP_CHUNK,
                ),
              },
            )
            .pipe(timeout(CARRIER_LINK_LOOKUP_TIMEOUT_MS)),
        );
        // Noto'g'ri javob (`data` massiv emas) — «bog'lanmagan» deb
        // hisoblanmaydi (B6 bilan bir xil): belgisiz, `failed: true`.
        if (!Array.isArray(asRecord(response)?.data)) {
          return { links: new Map(), failed: true };
        }
        for (const [id, link] of carrierLinksOf(response)) {
          links.set(id, link);
        }
      }
      return { links, failed: false };
    } catch {
      return { links: new Map(), failed: true };
    }
  }

  /**
   * B6 (ega qarori 2026-11-15): tashqi yetkazuvchiga bog'langan kuryer FAQAT
   * HQ'da bo'ladi — uni boshqa filialga o'tkazish 409
   * `courier_carrier_linked`. integration yoki `branch.find_hq` javob
   * bermasa — 503 (yopiq). Bog'lanmagan kuryer — to'siq yo'q.
   */
  private assertCarrierCourierStaysInHq(
    courierId: string,
    targetBranchId: unknown,
  ): Observable<void> {
    const unavailable = (message: string) => () =>
      throwError(() => new ServiceUnavailableException(message));
    // integration faqat kanonik BIGINT id qabul qiladi, branch-service esa
    // URL id'sini o'zi kanonik qiladi ('077' → 77-kuryer). Kanonik qilinmasa
    // shunday so'rov har doim «integratsiya javob bermadi» (503) olardi.
    const lookupId = bigintIdText(courierId);
    if (!lookupId) {
      return throwError(() => new BadRequestException("Kuryer id noto'g'ri"));
    }
    return defer(() => {
      if (!this.integrationClient) {
        return throwError(
          () =>
            new ServiceUnavailableException(CARRIER_LINK_UNAVAILABLE_MESSAGE),
        );
      }
      return this.integrationClient
        .send(
          { cmd: 'integration.carrier.find_by_courier_ids' },
          { courier_ids: [lookupId] },
        )
        .pipe(
          timeout(CARRIER_LINK_LOOKUP_TIMEOUT_MS),
          catchError(unavailable(CARRIER_LINK_UNAVAILABLE_MESSAGE)),
        );
    }).pipe(
      switchMap((response: unknown) => {
        // Noto'g'ri javob (`data` massiv emas) — «bog'lanmagan» deb
        // hisoblanmaydi: yopiq, 503.
        if (!Array.isArray(asRecord(response)?.data)) {
          return throwError(
            () =>
              new ServiceUnavailableException(CARRIER_LINK_UNAVAILABLE_MESSAGE),
          );
        }
        const link = carrierLinksOf(response).get(lookupId);
        if (!link) {
          return of(undefined);
        }
        return this.branchClient.send({ cmd: 'branch.find_hq' }, {}).pipe(
          timeout(8000),
          catchError(unavailable(HQ_LOOKUP_UNAVAILABLE_MESSAGE)),
          map((hqResponse: unknown) => {
            const hqId = bigintIdText(text(unwrapData(hqResponse)?.id));
            if (!hqId) {
              throw new ServiceUnavailableException(
                HQ_LOOKUP_UNAVAILABLE_MESSAGE,
              );
            }
            if (bigintIdText(text(targetBranchId)) !== hqId) {
              throw new ConflictException({
                message: courierCarrierLinkedMessage(link.name),
                data: {
                  reason: 'courier_carrier_linked',
                  details: { courier_id: lookupId },
                },
              });
            }
            return undefined;
          }),
        );
      }),
    );
  }

  /** Tuman qamrovi: logistics'ga RPC (mijoz yo'q — 503). */
  private async sendDistrictCoverage(
    cmd: string,
    payload: object,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.logisticsClient) {
      throw new ServiceUnavailableException(LOGISTICS_UNAVAILABLE_MESSAGE);
    }
    return firstValueFrom(
      this.logisticsClient.send({ cmd }, payload).pipe(timeout(timeoutMs)),
    );
  }

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
      .pipe(timeout(8000));
  }

  /**
   * Filialga biriktirilgan tumanlar (`districts.serving_branch_id = :id`).
   * anKpzwxk: bu biriktiruv endi QAMROVGA TA'SIR QILMAYDI — qamrov viloyat
   * qoidasi (`@app/common` `isOrderServedByBranch`: buyurtmaning xizmat
   * viloyati `assigned_region ?? region_id` filial viloyatiga teng). Ustun
   * keyingi tozalashgacha saqlanadi.
   *
   * Doira: SA/ADMIN — istalgan filial; MANAGER/REGISTRATOR — avval
   * `branch.find_by_id` o'z requester'i bilan (branch-service
   * `assertCanReadBranch`: o'z filiali, menejerga quyi filiallari ham;
   * boshqasi 403 va tumanlar so'ralmaydi). LOGIST — yo'q (ega LG-S1: logist
   * faqat buyurtma/tracking/pochta/paket/kuryerlarni ko'radi).
   */
  @Get('branches/:id/districts')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiOperation({
    summary:
      "Filialga biriktirilgan tumanlar (eskirgan — qamrovga ta'sir qilmaydi)",
    description:
      "Javob `{ statusCode, message, data: District[] }` — `serving_branch_id = :id` bo'lgan tumanlar, nom bo'yicha (A→Z), `region` va `assignedToRegion` bilan. " +
      "anKpzwxk: bu biriktiruv endi QAMROVNI BELGILAMAYDI. Qamrov — viloyat qoidasi: tumanning xizmat viloyati `assigned_region ?? region_id` filial viloyatiga (`branches.region_id`) teng bo'lsa, o'sha viloyatning ISTALGAN filiali xizmat qiladi; HQ cheklanmagan; viloyatsiz filial hech narsaga xizmat qilmaydi. " +
      "SUPERADMIN/ADMIN — istalgan filial. MANAGER/REGISTRATOR — faqat o'zi ko'ra oladigan filial (o'z filiali; menejerga quyi filiallari ham), boshqasi 403. " +
      "Boshqa rollar (LOGIST ham) — 403. Faqat o'qish.",
  })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  async findBranchDistricts(
    @Param('id', ParseBigintIdPipe) id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    if (!isSystemPrivilegedRoles(req?.user?.roles)) {
      // Filial xodimi: o'qish huquqi branch-service'da tekshiriladi (403
      // xatosi shu yerdan qaytadi, tumanlar so'ralmaydi).
      await firstValueFrom(
        this.branchClient
          .send(
            { cmd: 'branch.find_by_id' },
            { id, requester: this.toRequester(req) },
          )
          .pipe(timeout(8000)),
      );
    }
    return this.sendDistrictCoverage(
      'logistics.district.find_by_branch',
      { branch_id: id },
      8000,
    );
  }

  /**
   * Filialga tumanlarni biriktirish (ALMASHTIRISH) — ESKIRGAN (anKpzwxk):
   * `serving_branch_id` endi qamrovga ta'sir qilmaydi (viloyat qoidasi),
   * marshrut faqat moslik uchun qoldi. Tekshiruv logistics'da
   * (`logistics.district.set_serving_branch`): rol, filial (mavjud, faol,
   * HQ emas), tumanlar mavjudligi va viloyati.
   */
  @Put('branches/:id/districts')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      "Filialga tumanlarni biriktirish (eskirgan — qamrovga ta'sir qilmaydi)",
    deprecated: true,
    description:
      "ESKIRGAN (anKpzwxk): qaysi filial qaysi buyurtmaga xizmat qilishini endi VILOYAT belgilaydi — tumanning xizmat viloyati `assigned_region ?? region_id` filial viloyatiga teng bo'lsa, o'sha viloyatning istalgan filiali buyurtmani qabul qiladi va istalgan kuryeriga beradi. Bu marshrut faqat `serving_branch_id` ustunini yozadi (moslik uchun) va qamrovni O'ZGARTIRMAYDI; tumanni boshqa viloyatga o'tkazish — `PATCH /district/:id` (`assigned_region`). " +
      "ALMASHTIRISH: `district_ids` dagi tumanlar shu filialga biriktiriladi; ilgari shu filialga biriktirilgan, lekin ro'yxatda yo'q tumanlar bo'shatiladi (filialsiz — viloyat qoidasi). `district_ids: []` — filialning barcha tumanlari bo'shatiladi. " +
      "Filial mavjud, FAOL va HQ EMAS bo'lishi shart (HQ hamma tumanga xizmat qiladi — 400 `data.reason = branch_is_hq`; nofaol — 400 `branch_inactive`; yo'q — 404). " +
      'Faqat kuryerli filial turi (REGIONAL yoki HYBRID) — PICKUP va boshqalar 400 `data.reason = branch_type_not_serving`. ' +
      "Har bir tuman mavjud bo'lishi shart (yo'q — 404 `district_not_found`, `data.details.district_ids`). Filialning viloyati bo'lsa, tumanning xizmat viloyati (`assigned_region ?? region_id`) unga teng bo'lishi shart — aks holda 400 `data.reason = district_region_mismatch`, `data.details.district_ids`. " +
      "Boshqa filialga biriktirilgan tuman shu filialga KO'CHADI (ruxsat etiladi) va javobdagi `moved[]` da qaytadi. " +
      'Javob `data`: `{ branch_id, district_ids, added[], removed[], moved: [{ district_id, from_branch_id }], coverage_exemptions?: { created, by_branch: [{ branch_id, count }] } }`. ' +
      "`coverage_exemptions` doim `{ created: 0, by_branch: [] }` — xizmat filiali almashishi viloyatni o'zgartirmaydi, shuning uchun imtiyoz yozilmaydi va tuman buyurtmalari o'qilmaydi (order-service ishlamasa ham 503 bo'lmaydi). «Eski filialda tugasin» imtiyozlari faqat tuman VILOYATI o'zgarganda (`PATCH /district/:id`, tumanlarni birlashtirish) yoziladi. Faqat SUPERADMIN/ADMIN.",
  })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiBody({ type: SetBranchDistrictsRequestDto })
  setBranchDistricts(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: SetBranchDistrictsRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.sendDistrictCoverage(
      'logistics.district.set_serving_branch',
      {
        branch_id: id,
        district_ids: dto.district_ids,
        requester: this.toRequester(req),
      },
      DISTRICT_COVERAGE_WRITE_RPC_TIMEOUT_MS,
    );
  }

  @Post('branches/transfer-batches')
  // Skan auditi 2026-11-23: har skan shu route'ga — global 60/daq emas, skaner limiti.
  @Throttle(SCAN_THROTTLE)
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
      "Filial paketi (FORWARD, 2026-11-14 dan) — bitta yo'nalishga bitta umumiy paket, barcha viloyatlar birga: " +
      '`target_region_id: null`, viloyatlari — `region_ids` / `regions` (`region` faqat bitta viloyatli paketda). ' +
      "Z3pUOxou — LOGIST: faqat o'z viloyatlari buyurtmasi bor paketlar (`region_ids` yoki eski `target_region_id` " +
      "o'z viloyatlarida; `target_region_id` filtri — faqat o'z viloyati, boshqasi 400; biriktirilmagan — bo'sh), " +
      "`total_price` va `items[].snapshot_price` yo'q.",
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
                isTransferBatchInLogistRegions(batch, regionIds),
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
      "Z3pUOxou — LOGIST: paketda o'z viloyati buyurtmasi bo'lsa (`region_ids` / eski `target_region_id`), aks holda 403; umumiy paketda `items` — faqat o'z viloyatlariniki; `total_price`, `items[].snapshot_price` va `items[].order` dagi pul maydonlari yo'q. " +
      "T7 (CqBD8V4p): `items[].order.problem_contacts: [{name, phone, source: 'logist'|'support'}]` — chop etish uchun.",
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
        // T7 (CqBD8V4p): `problem_contacts` proyeksiyadan OLDIN, bitta RPC.
        switchMap((response: unknown) =>
          attachProblemContacts(this.problemContacts, response),
        ),
        // T7 (B3): `items[].order` — menejer/filialga market va operator
        // telefonlarisiz; D5NxxpJW: market tarifisiz.
        map((response: unknown) =>
          projectOrderPayloadForRoles(req?.user?.roles, response),
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
    return projectLogistPayload(
      req?.user?.roles,
      await attachProblemContacts(this.problemContacts, response),
    );
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
    description:
      "T7 (CqBD8V4p): `items[].order.problem_contacts: [{name, phone, source: 'logist'|'support'}]` — chop etish uchun.",
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
        // T7 (CqBD8V4p): `problem_contacts` proyeksiyadan OLDIN, bitta RPC.
        switchMap((response: unknown) =>
          attachProblemContacts(this.problemContacts, response),
        ),
        // T7 (B3): menejer/filialga market va operator telefonlarisiz;
        // D5NxxpJW: market tarifisiz.
        map((response: unknown) =>
          projectOrderPayloadForRoles(req?.user?.roles, response),
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
  // Skan auditi 2026-11-23: har skan shu route'ga — global 60/daq emas, skaner limiti.
  @Throttle(SCAN_THROTTLE)
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
  @ApiOperation({
    summary: 'Cancel transfer batch and unassign its orders',
    description:
      "oP02jE2P — faqat hali jo'natilmagan (`PENDING`) paket bekor qilinadi. Ruxsat: superadmin, admin va paketni yig'gan (manba) filialning registratori yoki menejeri (yoki menejer daraxti); boshqasi — 403. " +
      "409 `data.reason = batch_in_transit` — paket jo'natilgan (`SENT`, yo'lda yoki qisman qabul qilingan): hech kimga, superadmin va adminga ham bekor qilinmaydi (`details: { batch_id, status }`). " +
      '400 `batch_received` — qabul qilingan paket, 400 `batch_already_cancelled` — allaqachon bekor qilingan, 400 `batch_not_cancellable` — boshqa holat. ' +
      '400 — sabab (`reason`) 10 belgidan qisqa. Muvaffaqiyatda FORWARD paket buyurtmalari paketdan yechilib `new` holatiga qaytadi.',
  })
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
  @ApiOperation({
    summary: 'Dispatch HQ post to destination branch',
    description:
      "anKpzwxk — viloyat qoidasi: pochta viloyatidagi ISTALGAN faol REGIONAL/HYBRID filialga (menejeri bor) jo'natiladi; tuman ↔ filial biriktiruvi (`serving_branch_id`) hisobga olinmaydi. " +
      '400 `data.reason = region_mismatch` — pochta viloyati manzil filial viloyatiga teng emas (`details: { post_id, destination_branch_id, post_region_id, destination_region_id }`); ' +
      '400 `branch_region_missing` — manzil filial yoki pochta viloyatsiz (`details.missing`); ' +
      "409 `district_not_served_by_branch` — buyurtma xizmat viloyati (`assigned_region ?? region_id`) manzil filialniki emas (`details.{order_ids, district_ids}`). Hech narsa jo'natilmaydi.",
  })
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

  /**
   * 1.1 — Pochta → HQ kuryeri (ega qarori 2026-11-15): HQ pochtasi
   * viloyatiga xizmat qiladigan FAOL HQ kuryerlari. Ruxsat — «Yangi
   * pochtalar» bilan bir xil (SA/ADMIN yoki HQ registratori; logistics
   * tekshiradi). Har kuryerga tashqi yetkazuvchi belgisi (`carrier_name`,
   * `carrier_active`) integration'dan qo'shiladi — u javob bermasa ro'yxat
   * baribir qaytadi, `carrier_lookup_failed: true`.
   */
  @Get('branches/posts/:postId/courier-destinations')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiOperation({
    summary: 'HQ couriers for post region (Pochta → HQ kuryeri)',
    description:
      "Faqat faol HQ kuryerlari (HQ `branch_users`, rol COURIER), nom bo'yicha. Pochta viloyati = HQ viloyati — HAR BIR HQ kuryeri (`region_match: hq_region`); aks holda faqat o'z viloyati (`home`), «Xizmat viloyatlari»da (`courier_regions`, `listed`) yoki `serves_all_regions` (`all_regions`) bo'lgan HQ kuryeri. " +
      "Javob `data: { post_id, region_id, is_hq_region, couriers: [{ courier_user_id, name, phone, region_match, carrier_name, carrier_active }], carrier_lookup_failed }` — `carrier_*` bog'lanmagan kuryerda yoki tekshirib bo'lmaganda `null`. " +
      "403 `new_posts_hq_only`; 404 «Pochta topilmadi»; 400 `post_not_sendable` (`details: { post_id, post_status, post_courier_id }`) — faqat yangi ('new'), kuryersiz pochta; 400 `branch_region_missing` (`details: { post_id, missing: 'post' }`); 503 — filial yoki foydalanuvchilar xizmati javob bermadi.",
  })
  @ApiParam({ name: 'postId', description: 'Logistics post ID (NEW HQ post)' })
  async findPostCourierDestinations(
    @Param('postId', ParseBigintIdPipe) postId: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    if (!this.logisticsClient) {
      throw new ServiceUnavailableException(LOGISTICS_UNAVAILABLE_MESSAGE);
    }
    const response: unknown = await firstValueFrom(
      this.logisticsClient
        .send(
          { cmd: 'logistics.post.courier_destinations' },
          { post_id: postId, requester: this.toRequester(req) },
        )
        .pipe(timeout(POST_COURIER_DESTINATIONS_RPC_TIMEOUT_MS)),
    );
    const envelope = asRecord(response);
    const data = asRecord(envelope?.data);
    const couriers = Array.isArray(data?.couriers)
      ? (data.couriers as unknown[])
      : null;
    if (!envelope || !data || !couriers) {
      return response;
    }
    const courierIds = Array.from(
      new Set(
        couriers
          .map((courier) => text(asRecord(courier)?.courier_user_id))
          .filter(Boolean),
      ),
    );
    const { links, failed } = await this.lookupCarrierLinks(courierIds);
    return {
      ...envelope,
      data: {
        ...data,
        couriers: couriers.map((courier) => {
          const row = asRecord(courier) ?? {};
          const link = links.get(text(row.courier_user_id));
          return {
            ...row,
            carrier_name: link ? link.name : null,
            carrier_active: link ? link.is_active : null,
          };
        }),
        carrier_lookup_failed: failed,
      },
    };
  }

  /**
   * 1.2 — Pochta → HQ kuryeri: tanlangan buyurtmalar filialga emas,
   * to'g'ridan-to'g'ri HQ kuryeriga (uning bugungi pochtasiga, «Yo'lda»).
   * Barcha tekshiruvlar logistics'da, yozuvdan OLDIN — biror shart buzilsa
   * hech narsa berilmaydi.
   */
  @Post('branches/posts/:postId/dispatch-to-courier')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiOperation({
    summary: 'Give HQ post orders directly to an HQ courier',
    description:
      "Ega qarori 2026-11-15. Kuryer — `GET /branches/posts/:postId/courier-destinations` ro'yxatidagi HQ kuryeri. Javob `data: { post_id, courier_id, courier_post_id, courier_post_created, moved_order_ids, moved_orders_count, skipped_order_ids, post_deleted }` (bekor / yopilgan buyurtmalar jimgina `skipped_order_ids` ga). " +
      'Xatolar (tekshiruv tartibida, hammasi `data.reason`): 403 `new_posts_hq_only`; 404 «Pochta topilmadi»; 400 `post_not_sendable` (`details: { post_id, post_status, post_courier_id }`); 400 `branch_region_missing` (`details: { post_id, missing }`); ' +
      '400 `courier_not_hq` (`details.courier_id`); 400 `courier_inactive` (`details.courier_id`); 403 `courier_region_not_served` (`details: { courier_id, post_region_id }`) — «Xizmat viloyatlari»da belgilanmagan; ' +
      '409 `order_not_in_post` (`details.order_ids`) — sahifani yangilab qayta tanlang; 400 `no_dispatchable_orders`; 400 `order_not_dispatchable` (`details.order_ids`) — faqat HQ qabul qilgan (received), kuryersiz buyurtma; ' +
      "409 `order_in_outgoing_batch` (`details.order_ids`); 409 `order_region_mismatch` (`details.order_ids`); 403 `hq_courier_region_only` (`details.order_ids`) — faqat pochta viloyati = HQ viloyati bo'lganda; 503 — xizmat javob bermadi.",
  })
  @ApiParam({ name: 'postId', description: 'Logistics post ID (NEW HQ post)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['courier_id', 'order_ids'],
      properties: {
        courier_id: {
          type: 'string',
          example: '77',
          description: 'HQ kuryeri user ID (bigint satr)',
        },
        order_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: POST_DISPATCH_TO_COURIER_MAX_ORDERS,
          example: ['101', '102'],
          description:
            "Majburiy (1–1000): pochtadan beriladigan buyurtmalar. Birortasi shu pochtada bo'lmasa — 409 `order_not_in_post`, hech narsa berilmaydi",
        },
      },
    },
  })
  dispatchPostToCourier(
    @Param('postId', ParseBigintIdPipe) postId: string,
    @Body('courier_id') courierId: unknown,
    @Body('order_ids') orderIds: unknown,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    const normalizedCourierId = bigintIdText(courierId);
    if (!normalizedCourierId) {
      throw new BadRequestException(POST_COURIER_ID_INVALID_MESSAGE);
    }
    const rawOrderIds: unknown[] = Array.isArray(orderIds) ? orderIds : [];
    if (rawOrderIds.length > POST_DISPATCH_TO_COURIER_MAX_ORDERS) {
      throw new BadRequestException(ORDER_IDS_TOO_MANY_MESSAGE);
    }
    const normalizedOrderIds = rawOrderIds.map((id) => bigintIdText(id));
    if (
      !normalizedOrderIds.length ||
      normalizedOrderIds.some((id) => id === null)
    ) {
      throw new BadRequestException(ORDER_IDS_REQUIRED_MESSAGE);
    }
    if (!this.logisticsClient) {
      throw new ServiceUnavailableException(LOGISTICS_UNAVAILABLE_MESSAGE);
    }
    return this.logisticsClient
      .send(
        { cmd: 'logistics.post.dispatch_to_courier' },
        {
          post_id: postId,
          courier_id: normalizedCourierId,
          order_ids: normalizedOrderIds as string[],
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(BATCH_RPC_TIMEOUT_MS));
  }

  @Post('branches/posts/:postId/reassign')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'Move a sent, not yet received branch post to another branch',
    description:
      "Eski pochtalar → «Filialga o'tkazish». The post (same id) and all its on-the-road orders move to the destination branch. Rules: post status 'sent' without courier; destination is an active REGIONAL/HYBRID branch of the post's region with a manager and serves every order's service region; every order is still on the road (not received). " +
      'The 409s for post not sent / partly received / empty post / concurrent change (and 503 reassign failure, 400 post has courier / same branch) carry NO machine code in the response — show `message`. ' +
      'Machine codes come only as `data.reason`: 409 `district_not_served_by_branch` (`details.{order_ids, district_ids}`), 400 `region_mismatch`, 400 `branch_region_missing`. ' +
      "anKpzwxk: coverage is the region rule (any branch of the order's service region); 400 `data.reason = region_mismatch` (post region ≠ destination region) or `branch_region_missing` (post or destination has no region, `details.missing`) — nothing moves.",
  })
  @ApiParam({ name: 'postId', description: 'Logistics post ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['destination_branch_id'],
      properties: {
        destination_branch_id: {
          type: 'string',
          example: '12',
          description: 'Destination branch ID',
        },
      },
    },
  })
  reassignPostToBranch(
    @Param('postId') postId: string,
    @Body('destination_branch_id') destinationBranchId: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient
      .send(
        { cmd: 'branch.post.reassign_branch' },
        {
          post_id: postId,
          destination_branch_id: destinationBranchId,
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
    description:
      "Tashqi yetkazuvchiga (carrier) bog'langan kuryer faqat HQ'da bo'ladi: boshqa filialga o'tkazish — 409 `data.reason = courier_carrier_linked` (`details.courier_id`); bog'lanishni tekshirib bo'lmasa (integratsiya / filial xizmati javob bermadi) — 503.",
  })
  @ApiParam({ name: 'id', description: 'Courier user ID (bigint string)' })
  @ApiBody({ type: TransferCourierBranchRequestDto })
  transferCourierBranch(
    @Param('id') id: string,
    @Body() dto: TransferCourierBranchRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    const courierId = this.parseCourierIdParam(id);
    // B6: tashqi yetkazuvchi kuryeri HQ'dan chiqmaydi (o'tkazishdan OLDIN).
    return this.assertCarrierCourierStaysInHq(courierId, dto.branch_id).pipe(
      switchMap(() =>
        this.branchClient
          .send(
            { cmd: 'branch.user.transfer_courier' },
            {
              user_id: courierId,
              branch_id: dto.branch_id,
              requester: this.toRequester(req),
            },
          )
          .pipe(timeout(COURIER_TRANSFER_RPC_TIMEOUT_MS)),
      ),
    );
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
