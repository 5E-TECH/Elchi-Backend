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
  MaxLength,
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

  /**
   * ROL — integratsiya bizning oqimimizda NIMA QILADI.
   *
   * `type` (api/webhook/ftp) TRANSPORT, ya'ni "qanday gaplashamiz". Rol esa
   * boshqa savol va ilgari hech qayerda yozilmasdi: yetkazuvchi (bizdan
   * posilka oladi) va manba (bizga buyurtma beradi) bir xil ko'rinardi.
   *
   *   carrier — bizdan posilka oladi, yetkazadi, COD qarzdor (LDG, BeePost)
   *   source  — bizga buyurtma beradi (marketplace, do'kon, CRM)
   *   payment — pul tasdiqlaydi (Payme, Click, bank)
   *   mirror  — faqat o'qish uchun ko'zgu (Sheets, BI)
   */
  @ApiPropertyOptional({
    example: 'carrier',
    enum: ['carrier', 'source', 'payment', 'mirror'],
    description: 'Berilmasa `carrier` (mavjud ulanishlarning naqshi)',
  })
  @IsOptional()
  @IsIn(['carrier', 'source', 'payment', 'mirror'])
  role?: string;

  /**
   * TIZIM TURI — UI guruhlash va onboarding shabloni uchun.
   *
   * `role` bilan takrorlanmaydi: marketplace ham, CRM ham `source` roli,
   * lekin boshqacha ulanadi. Rol XULQNI, kategoriya QANDAY SOZLASHNI
   * belgilaydi.
   */
  @ApiPropertyOptional({
    example: 'cargo',
    enum: ['marketplace', 'crm', 'cargo', 'payment', 'spreadsheet', 'other'],
  })
  @IsOptional()
  @IsIn(['marketplace', 'crm', 'cargo', 'payment', 'spreadsheet', 'other'])
  category?: string;

  /**
   * ULANISH REJIMI.
   *   spec    — biz kontrakt e'lon qilamiz, ular bajaradi (kod yozilmaydi)
   *   adapter — biz ularga config-profil bilan moslashamiz
   */
  @ApiPropertyOptional({ example: 'adapter', enum: ['spec', 'adapter'] })
  @IsOptional()
  @IsIn(['spec', 'adapter'])
  integration_mode?: string;

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

  /* ═══════════════════════════════════════════════════════════════════════
     KIRUVCHI WEBHOOK VA JO'NATISH SOZLAMALARI

     ⚠️ BU MAYDONLAR ILGARI DTO'DA YO'Q EDI va bu jimgina o'lik funksiyaga
     olib kelgan: entity'da ustun bor, servis ularni O'QIYDI, lekin yozish
     yo'li yo'q edi. `main.ts` da `ValidationPipe({ whitelist: true,
     forbidNonWhitelisted: true })` turgani uchun:
       • UI'dan yuborilsa  → jimgina TASHLANADI
       • curl bilan        → 400 "property should not exist"

     Natijada uchta funksiya butunlay ishlamasdi: kiruvchi webhook
     (`webhook_secret` yo'q → 401 not_configured), posilka jo'natish
     (`dispatch_config` yo'q → 400), tashqi status xaritasi.

     ⚠️ `webhook_secret_previous` ATAYLAB YO'Q. U rotatsiya oynasi uchun va
     qo'lda to'ldirilmasligi kerak: yangi sekret qo'yilganda servis eskisini
     o'zi shu maydonga ko'chiradi. Uni ochish "eski sekretni qo'lda
     kiritish" imkonini berardi va bu himoyani zaiflashtiradi.

     ⚠️ Javobda bu sirlar QAYTMAYDI: `sanitizeIntegrationRow` ularni
     o'chiradi va faqat `has_webhook_secret` bayrog'ini beradi.
     ═══════════════════════════════════════════════════════════════════════ */

  @ApiPropertyOptional({
    description:
      "Kiruvchi webhook HMAC sekreti. Javobda QAYTMAYDI. Bo'sh satr — tozalash.",
  })
  @IsOptional()
  @IsString()
  webhook_secret?: string;

  @ApiPropertyOptional({
    example: 'x-signature',
    description: 'Imzo qaysi sarlavhada keladi (sukut: x-signature)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  webhook_signature_header?: string;

  @ApiPropertyOptional({
    example: 'sha256=',
    description: 'Imzo qiymati oldidagi prefiks (masalan `sha256=`)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  webhook_signature_prefix?: string;

  @ApiPropertyOptional({
    example: 'sha256',
    enum: ['sha256', 'sha512'],
    description: 'HMAC algoritmi',
  })
  @IsOptional()
  @IsIn(['sha256', 'sha512'])
  webhook_algorithm?: string;

  @ApiPropertyOptional({
    example: 'x-delivery-id',
    description:
      'Takroriy yetkazishni aniqlash uchun hodisa id sarlavhasi (replay guard)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  webhook_id_header?: string;

  @ApiPropertyOptional({
    type: Object,
    example: { delivered: 'sold', canceled: 'cancelled' },
    description: 'Ularning statusi → bizning statusimiz',
  })
  @IsOptional()
  @IsObject()
  inbound_status_mapping?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: Object,
    example: { order_id: 'data.order.id', status: 'data.order.state' },
    description:
      "Kiruvchi webhook payload'ida posilkani va statusni qaysi yo'l bo'yicha topish",
  })
  @IsOptional()
  @IsObject()
  webhook_payload_paths?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: Object,
    example: {
      enabled: true,
      deal_path: 'data.lead',
      funnel_path: 'pipeline_id',
      funnel_id: '7482913',
      stage_path: 'status_id',
      create_on_stages: ['142'],
    },
    description:
      'CRM voronkasidan buyurtma yaratish: qaysi voronka va BOSQICHDA ' +
      'bitim buyurtmaga aylanadi. Kamida bitta darvoza shart ' +
      '(`create_on_stages` yoki `create_on_events`) — darvozasiz CRM ' +
      '"bitim yaratildi" hodisasini manzil to\'lmasdan oldin yuboradi va ' +
      "chala buyurtma tug'ilardi.",
  })
  @IsOptional()
  @IsObject()
  inbound_order_config?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: Object,
    example: {
      enabled: true,
      transaction_id_path: 'data.transaction.id',
      amount_path: 'data.amount',
      status_path: 'data.state',
      order_ref_path: 'data.account.order_id',
      order_ref_field: 'id',
      status_map: { succeeded: ['paid', '2'], failed: ['cancelled'] },
      amount_in_tiyin: true,
    },
    description:
      "Onlayn to'lov sozlamasi: tranzaksiya id, summa, holat va buyurtma " +
      "havolasi payload'da qayerda. `status_map` SHART — provayderlarning " +
      "holat qiymatlari boshqacha va taxmin qilib bo'lmaydi. " +
      '`amount_in_tiyin` — summa tiyinda kelsa (Payme/Click shunday).',
  })
  @IsOptional()
  @IsObject()
  payment_config?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: Object,
    example: {
      endpoint: '/v1/orders',
      method: 'POST',
      body_template: { receiver: '{{customer_name}}', cod: '{{cod_amount}}' },
      response_paths: { external_ref: 'data.id', tracking: 'data.tracking' },
    },
    description:
      "Posilka jo'natish shabloni: endpoint, method, body_template, response_paths",
  })
  @IsOptional()
  @IsObject()
  dispatch_config?: Record<string, unknown>;
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

  /**
   * ROL — integratsiya bizning oqimimizda NIMA QILADI.
   *
   * `type` (api/webhook/ftp) TRANSPORT, ya'ni "qanday gaplashamiz". Rol esa
   * boshqa savol va ilgari hech qayerda yozilmasdi: yetkazuvchi (bizdan
   * posilka oladi) va manba (bizga buyurtma beradi) bir xil ko'rinardi.
   *
   *   carrier — bizdan posilka oladi, yetkazadi, COD qarzdor (LDG, BeePost)
   *   source  — bizga buyurtma beradi (marketplace, do'kon, CRM)
   *   payment — pul tasdiqlaydi (Payme, Click, bank)
   *   mirror  — faqat o'qish uchun ko'zgu (Sheets, BI)
   */
  @ApiPropertyOptional({
    example: 'carrier',
    enum: ['carrier', 'source', 'payment', 'mirror'],
    description: 'Berilmasa `carrier` (mavjud ulanishlarning naqshi)',
  })
  @IsOptional()
  @IsIn(['carrier', 'source', 'payment', 'mirror'])
  role?: string;

  /**
   * TIZIM TURI — UI guruhlash va onboarding shabloni uchun.
   *
   * `role` bilan takrorlanmaydi: marketplace ham, CRM ham `source` roli,
   * lekin boshqacha ulanadi. Rol XULQNI, kategoriya QANDAY SOZLASHNI
   * belgilaydi.
   */
  @ApiPropertyOptional({
    example: 'cargo',
    enum: ['marketplace', 'crm', 'cargo', 'payment', 'spreadsheet', 'other'],
  })
  @IsOptional()
  @IsIn(['marketplace', 'crm', 'cargo', 'payment', 'spreadsheet', 'other'])
  category?: string;

  /**
   * ULANISH REJIMI.
   *   spec    — biz kontrakt e'lon qilamiz, ular bajaradi (kod yozilmaydi)
   *   adapter — biz ularga config-profil bilan moslashamiz
   */
  @ApiPropertyOptional({ example: 'adapter', enum: ['spec', 'adapter'] })
  @IsOptional()
  @IsIn(['spec', 'adapter'])
  integration_mode?: string;

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

  /* ═══════════════════════════════════════════════════════════════════════
     KIRUVCHI WEBHOOK VA JO'NATISH SOZLAMALARI

     ⚠️ BU MAYDONLAR ILGARI DTO'DA YO'Q EDI va bu jimgina o'lik funksiyaga
     olib kelgan: entity'da ustun bor, servis ularni O'QIYDI, lekin yozish
     yo'li yo'q edi. `main.ts` da `ValidationPipe({ whitelist: true,
     forbidNonWhitelisted: true })` turgani uchun:
       • UI'dan yuborilsa  → jimgina TASHLANADI
       • curl bilan        → 400 "property should not exist"

     Natijada uchta funksiya butunlay ishlamasdi: kiruvchi webhook
     (`webhook_secret` yo'q → 401 not_configured), posilka jo'natish
     (`dispatch_config` yo'q → 400), tashqi status xaritasi.

     ⚠️ `webhook_secret_previous` ATAYLAB YO'Q. U rotatsiya oynasi uchun va
     qo'lda to'ldirilmasligi kerak: yangi sekret qo'yilganda servis eskisini
     o'zi shu maydonga ko'chiradi. Uni ochish "eski sekretni qo'lda
     kiritish" imkonini berardi va bu himoyani zaiflashtiradi.

     ⚠️ Javobda bu sirlar QAYTMAYDI: `sanitizeIntegrationRow` ularni
     o'chiradi va faqat `has_webhook_secret` bayrog'ini beradi.
     ═══════════════════════════════════════════════════════════════════════ */

  @ApiPropertyOptional({
    description:
      "Kiruvchi webhook HMAC sekreti. Javobda QAYTMAYDI. Bo'sh satr — tozalash.",
  })
  @IsOptional()
  @IsString()
  webhook_secret?: string;

  @ApiPropertyOptional({
    example: 'x-signature',
    description: 'Imzo qaysi sarlavhada keladi (sukut: x-signature)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  webhook_signature_header?: string;

  @ApiPropertyOptional({
    example: 'sha256=',
    description: 'Imzo qiymati oldidagi prefiks (masalan `sha256=`)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  webhook_signature_prefix?: string;

  @ApiPropertyOptional({
    example: 'sha256',
    enum: ['sha256', 'sha512'],
    description: 'HMAC algoritmi',
  })
  @IsOptional()
  @IsIn(['sha256', 'sha512'])
  webhook_algorithm?: string;

  @ApiPropertyOptional({
    example: 'x-delivery-id',
    description:
      'Takroriy yetkazishni aniqlash uchun hodisa id sarlavhasi (replay guard)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  webhook_id_header?: string;

  @ApiPropertyOptional({
    type: Object,
    example: { delivered: 'sold', canceled: 'cancelled' },
    description: 'Ularning statusi → bizning statusimiz',
  })
  @IsOptional()
  @IsObject()
  inbound_status_mapping?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: Object,
    example: { order_id: 'data.order.id', status: 'data.order.state' },
    description:
      "Kiruvchi webhook payload'ida posilkani va statusni qaysi yo'l bo'yicha topish",
  })
  @IsOptional()
  @IsObject()
  webhook_payload_paths?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: Object,
    example: {
      enabled: true,
      deal_path: 'data.lead',
      funnel_path: 'pipeline_id',
      funnel_id: '7482913',
      stage_path: 'status_id',
      create_on_stages: ['142'],
    },
    description:
      'CRM voronkasidan buyurtma yaratish: qaysi voronka va BOSQICHDA ' +
      'bitim buyurtmaga aylanadi. Kamida bitta darvoza shart ' +
      '(`create_on_stages` yoki `create_on_events`) — darvozasiz CRM ' +
      '"bitim yaratildi" hodisasini manzil to\'lmasdan oldin yuboradi va ' +
      "chala buyurtma tug'ilardi.",
  })
  @IsOptional()
  @IsObject()
  inbound_order_config?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: Object,
    example: {
      enabled: true,
      transaction_id_path: 'data.transaction.id',
      amount_path: 'data.amount',
      status_path: 'data.state',
      order_ref_path: 'data.account.order_id',
      order_ref_field: 'id',
      status_map: { succeeded: ['paid', '2'], failed: ['cancelled'] },
      amount_in_tiyin: true,
    },
    description:
      "Onlayn to'lov sozlamasi: tranzaksiya id, summa, holat va buyurtma " +
      "havolasi payload'da qayerda. `status_map` SHART — provayderlarning " +
      "holat qiymatlari boshqacha va taxmin qilib bo'lmaydi. " +
      '`amount_in_tiyin` — summa tiyinda kelsa (Payme/Click shunday).',
  })
  @IsOptional()
  @IsObject()
  payment_config?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: Object,
    example: {
      endpoint: '/v1/orders',
      method: 'POST',
      body_template: { receiver: '{{customer_name}}', cod: '{{cod_amount}}' },
      response_paths: { external_ref: 'data.id', tracking: 'data.tracking' },
    },
    description:
      "Posilka jo'natish shabloni: endpoint, method, body_template, response_paths",
  })
  @IsOptional()
  @IsObject()
  dispatch_config?: Record<string, unknown>;
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
