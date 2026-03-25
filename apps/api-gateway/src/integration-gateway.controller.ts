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
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  ValidateIf,
} from 'class-validator';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

class CreateIntegrationRequestDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  slug!: string;

  @IsString()
  @IsUrl()
  api_url!: string;

  @IsOptional()
  @IsString()
  auth_type?: 'api_key' | 'login';

  @IsOptional()
  @IsString()
  api_key?: string;

  @IsOptional()
  @IsString()
  api_secret?: string;

  @IsOptional()
  @IsString()
  auth_url?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  market_id?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsObject()
  field_mapping?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  status_mapping?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  status_sync_config?: Record<string, unknown>;
}

class UpdateIntegrationRequestDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  @IsUrl()
  api_url?: string;

  @IsOptional()
  @IsString()
  auth_type?: 'api_key' | 'login';

  @IsOptional()
  @IsString()
  api_key?: string;

  @IsOptional()
  @IsString()
  api_secret?: string;

  @IsOptional()
  @IsString()
  auth_url?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  market_id?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsObject()
  field_mapping?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  status_mapping?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  status_sync_config?: Record<string, unknown>;
}

class QrSearchRequestDto {
  @IsString()
  @IsNotEmpty()
  qr_code!: string;

  @IsOptional()
  @IsString()
  endpoint?: string;

  @IsOptional()
  @IsEnum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  method?: HttpMethod;

  @IsOptional()
  @IsString()
  qr_field?: string;

  @IsOptional()
  @IsString()
  response_path?: string;
}

class ExternalRequestDto {
  @IsOptional()
  @IsString()
  endpoint?: string;

  @IsOptional()
  @IsEnum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  method?: HttpMethod;

  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;

  @IsOptional()
  body?: unknown;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  use_auth?: boolean;

  @IsOptional()
  @IsString()
  response_path?: string;

  @ValidateIf((dto: ExternalRequestDto) => !dto.endpoint)
  @IsOptional()
  @IsString()
  note?: string;
}

@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IntegrationGatewayController {
  constructor(@Inject('INTEGRATION') private readonly integrationClient: ClientProxy) {}

  @Get()
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List integrations' })
  @ApiQuery({ name: 'is_active', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'inactive'] })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({ name: 'from_date', required: false, type: String, example: '2026-03-01' })
  @ApiQuery({ name: 'to_date', required: false, type: String, example: '2026-03-31' })
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
          market_id,
          from_date,
          to_date,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
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
