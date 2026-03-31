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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreateIntegrationRequestDto,
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
  constructor(@Inject('INTEGRATION') private readonly integrationClient: ClientProxy) {}

  @Get()
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MARKET)
  @ApiOperation({ summary: 'List integrations' })
  @ApiQuery({ name: 'is_active', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'inactive'] })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({ name: 'from_date', required: false, type: String, example: '2026-03-01' })
  @ApiQuery({ name: 'to_date', required: false, type: String, example: '2026-03-31' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  findAll(
    @Req() req: { user: { sub: string; roles?: string[] } },
    @Query('is_active') is_active?: string,
    @Query('status') status?: string,
    @Query('market_id') market_id?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const roles = req.user.roles ?? [];
    const isMarket = roles.includes(RoleEnum.MARKET);
    const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : undefined;
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
          market_id: isMarket ? req.user.sub : market_id,
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
  @ApiOperation({ summary: 'Sync history list (pagination/filter/success rate)' })
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
    return this.integrationClient.send({ cmd: 'integration.find_by_id' }, { id });
  }

  @Patch(':id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update integration' })
  @ApiBody({ type: UpdateIntegrationRequestDto })
  update(@Param('id') id: string, @Body() dto: UpdateIntegrationRequestDto) {
    return this.integrationClient.send({ cmd: 'integration.update' }, { id, dto });
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
  startSync(
    @Param('id') id: string,
    @Body() dto: StartSyncRequestDto = {},
  ) {
    return this.integrationClient.send(
      { cmd: 'integration.sync.process' },
      { integration_id: id, limit: dto.limit ?? 20 },
    );
  }

  @Post(':id/retry')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Retry failed sync jobs for integration' })
  @ApiBody({ type: RetrySyncRequestDto, required: false })
  retrySync(
    @Param('id') id: string,
    @Body() dto: RetrySyncRequestDto = {},
  ) {
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
  externalRequest(@Param('slug') slug: string, @Body() dto: ExternalRequestDto) {
    return this.integrationClient.send(
      { cmd: 'integration.external.request' },
      {
        slug,
        ...dto,
      },
    );
  }

}
