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
import { Roles as RoleEnum } from '@app/common';
import {
  ApiBearerAuth,
  ApiBody,
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

@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IntegrationGatewayController {
  constructor(
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
  ) {}

  @Get()
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List integrations' })
  @ApiQuery({ name: 'is_active', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'inactive'] })
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
          market_id,
          from_date,
          to_date,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
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
    );
  }

  @Post()
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create integration' })
  @ApiBody({ type: CreateIntegrationRequestDto })
  create(@Body() dto: CreateIntegrationRequestDto) {
    return this.integrationClient.send({ cmd: 'integration.create' }, { dto });
  }

  @Get(':id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get integration by id' })
  findById(@Param('id') id: string) {
    return this.integrationClient.send(
      { cmd: 'integration.find_by_id' },
      { id },
    );
  }

  @Patch(':id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update integration' })
  @ApiBody({ type: UpdateIntegrationRequestDto })
  update(@Param('id') id: string, @Body() dto: UpdateIntegrationRequestDto) {
    return this.integrationClient.send(
      { cmd: 'integration.update' },
      { id, dto },
    );
  }

  @Delete(':id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete integration' })
  remove(@Param('id') id: string) {
    return this.integrationClient.send({ cmd: 'integration.delete' }, { id });
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
    );
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
    );
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
    );
  }

  @Post(':id/sync')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Start sync processing for integration' })
  @ApiBody({ type: StartSyncRequestDto, required: false })
  startSync(@Param('id') id: string, @Body() dto: StartSyncRequestDto = {}) {
    return this.integrationClient.send(
      { cmd: 'integration.sync.process' },
      { integration_id: id, limit: dto.limit ?? 20 },
    );
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
    );
  }

  @Post(':id/retry')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Retry failed sync jobs for integration' })
  @ApiBody({ type: RetrySyncRequestDto, required: false })
  retrySync(@Param('id') id: string, @Body() dto: RetrySyncRequestDto = {}) {
    return this.integrationClient.send(
      { cmd: 'integration.sync.retry' },
      { integration_id: id, queue_id: dto.queue_id },
    );
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
    );
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
    );
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
    );
  }

  @Get('shipments/:order_id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'Get the provider shipment for an order' })
  getShipment(@Param('order_id') orderId: string) {
    return this.integrationClient.send(
      { cmd: 'integration.shipment.get' },
      { order_id: orderId },
    );
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
    );
  }

  @Get(':id/receivable-balance')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: "Provider's outstanding COD balance" })
  @ApiParam({ name: 'id', description: 'Integration id' })
  getReceivableBalance(@Param('id') id: string) {
    return this.integrationClient.send(
      { cmd: 'integration.receivable.balance' },
      { integration_id: id },
    );
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
    );
  }
}
