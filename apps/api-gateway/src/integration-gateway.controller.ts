import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
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
import {
  CreateSyncQueueRequestDto,
  CreateIntegrationRequestDto,
  CreateRemittanceRequestDto,
  DispatchShipmentRequestDto,
  ExternalRequestDto,
  FilterSyncHistoryQueryDto,
  IntegrationHealthcheckRequestDto,
  QrSearchRequestDto,
  RetrySyncRequestDto,
  StartSyncRequestDto,
  UpdateIntegrationRequestDto,
} from './dto/integration.swagger.dto';


// RPC ceiling: this downstream can legitimately run long (base64/provider
// fetch up to ~60s); an 8s ceiling would premature-fail a working call. See
// integration-service AbortSignal.timeout / file base64 transfer.
const PROVIDER_RPC_TIMEOUT_MS = 65_000;

@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IntegrationGatewayController {
  constructor(
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
  ) {}

  /** The authenticated user as an audit actor for write operations. */
  private auditActor(req: { user?: { sub?: string; roles?: string[] } }) {
    return { id: req.user?.sub ?? null, roles: req.user?.roles ?? [] };
  }

  @Get()
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List integrations' })
  @ApiQuery({ name: 'is_active', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'inactive'] })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: ['carrier', 'source', 'payment', 'mirror'],
    description: 'Rol bo‘yicha filtr — UI ulanishlarni rol guruhlariga ajratadi',
  })
  @ApiQuery({
    name: 'category',
    required: false,
    enum: ['marketplace', 'crm', 'cargo', 'payment', 'spreadsheet', 'other'],
  })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({
    name: 'from_date',
    required: false,
    type: String,
    example: '2026-03-01',
  })
  @ApiQuery({
    name: 'to_date',
    required: false,
    type: String,
    example: '2026-03-31',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  findAll(
    @Query('is_active') is_active?: string,
    @Query('status') status?: string,
    @Query('role') role?: string,
    @Query('category') category?: string,
    @Query('market_id') market_id?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const normalizedStatus =
      typeof status === 'string' ? status.toLowerCase() : undefined;
    const statusToIsActive =
      normalizedStatus === 'active'
        ? true
        : normalizedStatus === 'inactive'
          ? false
          : undefined;

    return this.integrationClient.send(
      { cmd: 'integration.find_all' },
      {
        query: {
          is_active:
            typeof is_active === 'string'
              ? ['true', '1', 'yes'].includes(is_active.toLowerCase())
              : statusToIsActive,
          status: normalizedStatus,
          role,
          category,
          market_id,
          from_date,
          to_date,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    ).pipe(timeout(8000));
  }

  /**
   * INTEGRATSIYA METRIKASI — panel uchun jonli raqamlar.
   *
   * ⚠️ `:id` marshrutlaridan OLDIN e'lon qilingan bo'lishi kerak, aks holda
   * "metrics" integratsiya id'si deb o'qilardi (bu tuzoqqa `partners/webhooks`
   * bilan bir marta tushilgan).
   */
  @Get('metrics')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      'Integratsiya paneli metrikasi — hodisa, yetmagan, navbat, javob vaqti',
  })
  @ApiQuery({
    name: 'hours',
    required: false,
    type: Number,
    description: 'Oyna (soat). Standart 24, maksimum 168',
  })
  @ApiOkResponse({
    description:
      '{ statusCode, message, data: { window_hours, totals, connections[] } }',
  })
  integrationMetrics(@Query('hours') hours?: string) {
    return this.integrationClient
      .send(
        { cmd: 'integration.metrics' },
        { hours: hours ? Number(hours) : undefined },
      )
      .pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  /**
   * KIRUVCHI WEBHOOK JURNALI (adversarial topilma, HIGH).
   *
   * ⚠️ `:id` marshrutlaridan OLDIN — aks holda "webhook-logs" integratsiya
   * id'si deb o'qilardi (bu tuzoqqa `partners/webhooks` bilan bir marta
   * tushilgan).
   *
   * ⚠️ TANA QAYTARILMAYDI: `raw_body` ichida mijozning telefoni va manzili
   * turadi, ro'yxatda esa savol "nima bo'ldi", "mijoz kim" emas.
   */
  /**
   * ONLAYN TO'LOVLAR (7-bosqich).
   *
   * ⚠️ `:id` marshrutlaridan OLDIN — aks holda "payments" integratsiya
   * id'si deb o'qilardi.
   *
   * `unapplied_only=true` — buyurtmaga qo'llanmagan to'lovlar. Operatorning
   * birinchi savoli aynan shu: qaysi pul kelib, hech qayerga yozilmadi?
   */
  @Get('payments')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      "Onlayn to'lov tranzaksiyalari — summa, holat, buyurtmaga qo'llanish natijasi",
  })
  @ApiQuery({ name: 'integration_id', required: false, type: String })
  @ApiQuery({
    name: 'unapplied_only',
    required: false,
    type: Boolean,
    description: "Faqat buyurtmaga qo'llanmagan to'lovlar",
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  paymentTransactions(
    @Query('integration_id') integrationId?: string,
    @Query('unapplied_only') unappliedOnly?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.integrationClient
      .send(
        { cmd: 'integration.payment.list' },
        {
          integration_id: integrationId,
          unapplied_only: unappliedOnly === 'true' || unappliedOnly === '1',
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      )
      .pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  @Get('webhook-logs')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      "Kiruvchi webhook jurnali — imzo, natija, xato sababi (tana qaytarilmaydi)",
  })
  @ApiQuery({ name: 'integration_id', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: 'rejected | verified | processed',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  webhookLogs(
    @Query('integration_id') integrationId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.integrationClient
      .send(
        { cmd: 'integration.webhook.logs' },
        {
          integration_id: integrationId,
          status,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      )
      .pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  @Get('sync/history')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'Sync history list (pagination/filter/success rate)',
  })
  syncHistory(@Query() query: FilterSyncHistoryQueryDto) {
    return this.integrationClient.send(
      { cmd: 'integration.sync.history' },
      { query },
    ).pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  @Post()
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create integration' })
  @ApiBody({ type: CreateIntegrationRequestDto })
  create(
    @Body() dto: CreateIntegrationRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.integrationClient.send(
      { cmd: 'integration.create' },
      { dto: { ...dto, requester: this.auditActor(req) } },
    ).pipe(timeout(8000));
  }

  @Get(':id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get integration by id' })
  findById(@Param('id') id: string) {
    return this.integrationClient.send(
      { cmd: 'integration.find_by_id' },
      { id },
    ).pipe(timeout(8000));
  }

  @Patch(':id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update integration' })
  @ApiBody({ type: UpdateIntegrationRequestDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIntegrationRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.integrationClient.send(
      { cmd: 'integration.update' },
      { id, dto: { ...dto, requester: this.auditActor(req) } },
    ).pipe(timeout(8000));
  }

  @Delete(':id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete integration' })
  remove(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.integrationClient.send(
      { cmd: 'integration.delete' },
      { id, requester: this.auditActor(req) },
    ).pipe(timeout(8000));
  }

  @Post(':id/healthcheck')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Integration connection test (ping/healthcheck)' })
  @ApiBody({ type: IntegrationHealthcheckRequestDto, required: false })
  healthcheck(
    @Param('id') id: string,
    @Body() dto: IntegrationHealthcheckRequestDto = {},
  ) {
    return this.integrationClient.send(
      { cmd: 'integration.healthcheck' },
      {
        id,
        ...dto,
      },
    ).pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  @Post(':id/test')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Integration connection test alias endpoint' })
  @ApiBody({ type: IntegrationHealthcheckRequestDto, required: false })
  testConnection(
    @Param('id') id: string,
    @Body() dto: IntegrationHealthcheckRequestDto = {},
  ) {
    return this.integrationClient.send(
      { cmd: 'integration.healthcheck' },
      {
        id,
        ...dto,
      },
    ).pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  @Get(':id/sync-history')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Sync history by integration id' })
  syncHistoryByIntegration(
    @Param('id') id: string,
    @Query() query: FilterSyncHistoryQueryDto,
  ) {
    return this.integrationClient.send(
      { cmd: 'integration.sync.history' },
      { query: { ...query, integration_id: id } },
    ).pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  @Post(':id/sync')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Start sync processing for integration' })
  @ApiBody({ type: StartSyncRequestDto, required: false })
  startSync(@Param('id') id: string, @Body() dto: StartSyncRequestDto = {}) {
    return this.integrationClient.send(
      { cmd: 'integration.sync.process' },
      { integration_id: id, limit: dto.limit ?? 20 },
    ).pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  @Post(':id/sync/queue')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create sync queue item' })
  @ApiBody({ type: CreateSyncQueueRequestDto })
  createSyncQueue(
    @Param('id') id: string,
    @Body() dto: CreateSyncQueueRequestDto,
  ) {
    return this.integrationClient.send(
      { cmd: 'integration.sync.queue' },
      { ...dto, integration_id: id },
    ).pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  @Post(':id/retry')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Retry failed sync jobs for integration' })
  @ApiBody({ type: RetrySyncRequestDto, required: false })
  retrySync(@Param('id') id: string, @Body() dto: RetrySyncRequestDto = {}) {
    return this.integrationClient.send(
      { cmd: 'integration.sync.retry' },
      { integration_id: id, queue_id: dto.queue_id },
    ).pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  /**
   * SKANERLAB QABUL QILISH — kichik saytlar uchun oddiy yo'l (audit EI-01).
   *
   * Operator posilkadagi QR'ni skanerlaydi, Elchi saytning API'sidan
   * buyurtmani so'rab oladi va tizimga yozadi. `search-by-qr` dan farqi:
   * u FAQAT ma'lumot qaytaradi, bu esa buyurtma YARATADI.
   *
   * ⚠️ MANAGER ham kiradi: posilkalarni HQ menejeri qabul qiladi.
   */
  @Post(':slug/scan-intake')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiOperation({
    summary: 'Scan a parcel QR and import the order from the site',
  })
  @ApiParam({ name: 'slug' })
  @ApiBody({ type: QrSearchRequestDto })
  scanIntake(
    @Param('slug') slug: string,
    @Body() dto: QrSearchRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.integrationClient
      .send(
        { cmd: 'integration.scan_intake' },
        {
          slug,
          qr_code: dto.qr_code,
          requester: { id: req.user?.sub, roles: req.user?.roles ?? [] },
        },
      )
      .pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  @Post(':slug/search-by-qr')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'Universal QR search via integration config' })
  @ApiBody({ type: QrSearchRequestDto })
  searchByQr(@Param('slug') slug: string, @Body() dto: QrSearchRequestDto) {
    return this.integrationClient.send(
      { cmd: 'integration.external.search_by_qr' },
      {
        slug,
        ...dto,
      },
    ).pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  @Post(':slug/request')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'Universal external request (any endpoint/method)' })
  @ApiBody({ type: ExternalRequestDto })
  externalRequest(
    @Param('slug') slug: string,
    @Body() dto: ExternalRequestDto,
  ) {
    return this.integrationClient.send(
      { cmd: 'integration.external.request' },
      {
        slug,
        ...dto,
      },
    ).pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  @Post(':slug/dispatch')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiOperation({
    summary: 'Dispatch an order to this provider (create a shipment)',
  })
  @ApiBody({ type: DispatchShipmentRequestDto })
  dispatchShipment(
    @Param('slug') slug: string,
    @Body() dto: DispatchShipmentRequestDto,
  ) {
    return this.integrationClient.send(
      { cmd: 'integration.shipment.dispatch' },
      { slug, order_id: dto.order_id, context: dto.context },
    ).pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  /**
   * Bitta ulanishning jo'natmalari.
   *
   * ⚠️ `@Get('shipments/:order_id')` bilan TO'QNASHMAYDI: u yerda ikkinchi
   * segment ixtiyoriy qiymat, bu yerda esa literal `shipments`. Ya'ni
   * `/integrations/5/shipments` faqat shu marshrutga, `/integrations/shipments/5`
   * faqat unisiga tushadi.
   */
  @Get(':id/shipments')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List provider shipments for an integration' })
  @ApiParam({ name: 'id', description: 'Integration id' })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'failed_only', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  listProviderShipments(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('failed_only') failedOnly?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.integrationClient
      .send(
        { cmd: 'integration.shipment.list' },
        {
          integration_id: id,
          status,
          // Query satr bo'lib keladi — `'false'` ham rost bo'lib qolmasin.
          failed_only: failedOnly === 'true' || failedOnly === '1',
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      )
      .pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  @Get('shipments/:order_id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'Get the provider shipment for an order' })
  getShipment(@Param('order_id') orderId: string) {
    return this.integrationClient.send(
      { cmd: 'integration.shipment.get' },
      { order_id: orderId },
    ).pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }

  // ===== Provider COD reconciliation =====

  @Get('receivables')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List provider COD receivables' })
  @ApiQuery({ name: 'integration_id', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'settled', 'cancelled'],
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  listReceivables(
    @Query('integration_id') integration_id?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.integrationClient.send(
      { cmd: 'integration.receivable.list' },
      {
        integration_id,
        status,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      },
    ).pipe(timeout(8000));
  }

  @Get(':id/receivable-balance')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: "Provider's outstanding COD balance" })
  @ApiParam({ name: 'id', description: 'Integration id' })
  getReceivableBalance(@Param('id') id: string) {
    return this.integrationClient.send(
      { cmd: 'integration.receivable.balance' },
      { integration_id: id },
    ).pipe(timeout(8000));
  }

  @Post(':id/remittances')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'Record a provider remittance and settle receivables',
  })
  @ApiParam({ name: 'id', description: 'Integration id' })
  @ApiBody({ type: CreateRemittanceRequestDto })
  createRemittance(
    @Param('id') id: string,
    @Body() dto: CreateRemittanceRequestDto,
    @Req() req: { user?: { sub?: string } },
  ) {
    return this.integrationClient.send(
      { cmd: 'integration.remittance.create' },
      {
        integration_id: id,
        amount: dto.amount,
        reference: dto.reference ?? null,
        note: dto.note ?? null,
        order_ids: dto.order_ids ?? undefined,
        created_by: req.user?.sub ?? null,
      },
    ).pipe(timeout(PROVIDER_RPC_TIMEOUT_MS));
  }
}
