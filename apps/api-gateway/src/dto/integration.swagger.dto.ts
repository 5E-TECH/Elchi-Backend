import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  ValidateIf,
} from 'class-validator';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type IntegrationType = 'api' | 'webhook' | 'ftp';
type IntegrationStatus = 'active' | 'inactive';

export class CreateIntegrationRequestDto {
  @ApiProperty({ example: 'Ozar' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ example: 'ozar' })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiProperty({ example: 'api', enum: ['api', 'webhook', 'ftp'] })
  @IsIn(['api', 'webhook', 'ftp'])
  type!: IntegrationType;

  @ApiProperty({ example: 'https://api.ozar.uz' })
  @IsString()
  @IsUrl()
  base_url!: string;

  @ApiProperty({
    type: Object,
    example: { api_key: 'token_here', auth_type: 'api_key' },
  })
  @IsObject()
  credentials!: Record<string, unknown>;

  @ApiProperty({ example: 'active', enum: ['active', 'inactive'] })
  @IsIn(['active', 'inactive'])
  status!: IntegrationStatus;

  // legacy compatibility fields (can be omitted)
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

  @ApiPropertyOptional({ example: 'https://api.ozar.uz' })
  @IsOptional()
  @IsString()
  @IsUrl()
  api_url?: string;
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

  @ApiPropertyOptional({ example: 'api', enum: ['api', 'webhook', 'ftp'] })
  @IsOptional()
  @IsIn(['api', 'webhook', 'ftp'])
  type?: IntegrationType;

  @ApiPropertyOptional({ example: 'https://api.ozar.uz' })
  @IsOptional()
  @IsString()
  @IsUrl()
  base_url?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  credentials?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'active', enum: ['active', 'inactive'] })
  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: IntegrationStatus;

  // legacy compatibility fields (can be omitted)
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

  @ApiPropertyOptional({
    example: 'POST',
    enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })
  @IsOptional()
  @IsIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
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

  @ApiPropertyOptional({
    example: 'POST',
    enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })
  @IsOptional()
  @IsIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
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

  @ApiPropertyOptional({
    example: 'GET',
    enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })
  @IsOptional()
  @IsIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
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
  @IsIn(['create', 'update', 'delete'])
  action!: 'create' | 'update' | 'delete';

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

  @ApiPropertyOptional({
    example: 'success',
    enum: ['pending', 'processing', 'success', 'failed'],
  })
  @IsOptional()
  @IsIn(['pending', 'processing', 'success', 'failed'])
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

export class DispatchShipmentRequestDto {
  @ApiProperty({
    example: '1001',
    description: 'Internal order id to dispatch',
  })
  @IsString()
  @IsNotEmpty()
  order_id!: string;

  @ApiPropertyOptional({
    description:
      'Flat context interpolated into the provider dispatch body_template ({{field}}). e.g. { customer_phone, total_price, idempotency_key }',
    example: { customer_phone: '+998901234567', total_price: '150000' },
  })
  @IsOptional()
  @IsObject()
  context?: Record<string, string>;
}

export class CreateRemittanceRequestDto {
  @ApiProperty({
    example: 1500000,
    description: 'Total amount the provider remitted',
  })
  @IsNumber()
  @Min(1)
  amount!: number;

  @ApiPropertyOptional({ example: 'PAY-2026-06-04-001' })
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiPropertyOptional({ example: 'Iyun oyi COD hisob-kitobi' })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Specific order ids to settle. Omit to settle pending receivables oldest-first up to amount.',
    example: ['1001', '1002'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  order_ids?: string[];
}
