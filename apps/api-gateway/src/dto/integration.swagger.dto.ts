import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  ValidateIf,
} from 'class-validator';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class CreateIntegrationRequestDto {
  @ApiProperty({ example: 'Ozar' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'ozar' })
  @IsString()
  @IsNotEmpty()
  slug!: string;

  @ApiProperty({ example: 'https://api.ozar.uz' })
  @IsString()
  @IsUrl()
  api_url!: string;

  @ApiPropertyOptional({ example: 'api_key', enum: ['api_key', 'login'] })
  @IsOptional()
  @IsString()
  auth_type?: 'api_key' | 'login';

  @ApiPropertyOptional({ example: 'token_here' })
  @IsOptional()
  @IsString()
  api_key?: string;

  @ApiPropertyOptional({ example: 'secret_here' })
  @IsOptional()
  @IsString()
  api_secret?: string;

  @ApiPropertyOptional({ example: 'https://api.example.uz/auth/token' })
  @IsOptional()
  @IsString()
  auth_url?: string;

  @ApiPropertyOptional({ example: 'CourierLogin' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ example: 'StrongPassword123' })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  market_id?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  field_mapping?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  status_mapping?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  status_sync_config?: Record<string, unknown>;
}

export class UpdateIntegrationRequestDto {
  @ApiPropertyOptional({ example: 'Ozar Updated' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'ozar' })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({ example: 'https://api.ozar.uz' })
  @IsOptional()
  @IsString()
  @IsUrl()
  api_url?: string;

  @ApiPropertyOptional({ example: 'api_key', enum: ['api_key', 'login'] })
  @IsOptional()
  @IsString()
  auth_type?: 'api_key' | 'login';

  @ApiPropertyOptional({ example: 'token_here' })
  @IsOptional()
  @IsString()
  api_key?: string;

  @ApiPropertyOptional({ example: 'secret_here' })
  @IsOptional()
  @IsString()
  api_secret?: string;

  @ApiPropertyOptional({ example: 'https://api.example.uz/auth/token' })
  @IsOptional()
  @IsString()
  auth_url?: string;

  @ApiPropertyOptional({ example: 'CourierLogin' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ example: 'StrongPassword123' })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  market_id?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  field_mapping?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  status_mapping?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  status_sync_config?: Record<string, unknown>;
}

export class QrSearchRequestDto {
  @ApiProperty({ example: '1773976715517105' })
  @IsString()
  @IsNotEmpty()
  qr_code!: string;

  @ApiPropertyOptional({ example: '/qrorder/find' })
  @IsOptional()
  @IsString()
  endpoint?: string;

  @ApiPropertyOptional({ example: 'POST', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] })
  @IsOptional()
  @IsEnum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  method?: HttpMethod;

  @ApiPropertyOptional({ example: 'qr_code' })
  @IsOptional()
  @IsString()
  qr_field?: string;

  @ApiPropertyOptional({ example: 'value.data' })
  @IsOptional()
  @IsString()
  response_path?: string;
}

export class ExternalRequestDto {
  @ApiPropertyOptional({ example: '/qrorder/find' })
  @IsOptional()
  @IsString()
  endpoint?: string;

  @ApiPropertyOptional({ example: 'POST', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] })
  @IsOptional()
  @IsEnum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  method?: HttpMethod;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  body?: unknown;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  use_auth?: boolean;

  @ApiPropertyOptional({ example: 'value.data' })
  @IsOptional()
  @IsString()
  response_path?: string;

  @ValidateIf((dto: ExternalRequestDto) => !dto.endpoint)
  @IsOptional()
  @IsString()
  note?: string;
}

export class IntegrationHealthcheckRequestDto {
  @ApiPropertyOptional({ example: '/' })
  @IsOptional()
  @IsString()
  endpoint?: string;

  @ApiPropertyOptional({ example: 'GET', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] })
  @IsOptional()
  @IsEnum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  method?: HttpMethod;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  use_auth?: boolean;

  @ApiPropertyOptional({ example: 8000 })
  @IsOptional()
  @IsInt()
  @Min(500)
  timeout_ms?: number;
}

export class CreateSyncQueueRequestDto {
  @ApiProperty({ example: '2' })
  @IsString()
  @IsNotEmpty()
  integration_id!: string;

  @ApiProperty({ example: 'order' })
  @IsString()
  @IsNotEmpty()
  entity_type!: string;

  @ApiProperty({ example: '123' })
  @IsString()
  @IsNotEmpty()
  entity_id!: string;

  @ApiProperty({ example: 'create', enum: ['create', 'update', 'delete'] })
  @IsEnum(['create', 'update', 'delete'])
  action!: 'create' | 'update' | 'delete';

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  order_id?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

export class FilterSyncHistoryQueryDto {
  @ApiPropertyOptional({ example: '2' })
  @IsOptional()
  @IsString()
  integration_id?: string;

  @ApiPropertyOptional({ example: 'success', enum: ['pending', 'processing', 'success', 'failed'] })
  @IsOptional()
  @IsEnum(['pending', 'processing', 'success', 'failed'])
  status?: 'pending' | 'processing' | 'success' | 'failed';

  @ApiPropertyOptional({ example: '2026-03-01' })
  @IsOptional()
  @IsString()
  from_date?: string;

  @ApiPropertyOptional({ example: '2026-03-31' })
  @IsOptional()
  @IsString()
  to_date?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

export class StartSyncRequestDto {
  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

export class RetrySyncRequestDto {
  @ApiPropertyOptional({ example: '123' })
  @IsOptional()
  @IsString()
  queue_id?: string;
}
