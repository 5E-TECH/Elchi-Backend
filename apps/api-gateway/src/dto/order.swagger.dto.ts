import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsEnum,
  IsISO8601,
  MaxLength,
  MinLength,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { CancelReason, Order_status, Where_deliver } from '@app/common';

enum OrderSourceDto {
  INTERNAL = 'internal',
  EXTERNAL = 'external',
  BRANCH = 'branch',
}

enum CancelledManualOverrideReasonDto {
  TORN = 'QR yirtilgan',
  UNREADABLE = "QR o'qilmayapti",
  MISSING = "Label yo'qolgan",
  WET = 'QR namlangan yoki xiralashgan',
}

const parseFormattedNumber = (value: unknown): unknown => {
  if (value === undefined || value === null || value === '') {
    return value;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.-]/g, '');
    return cleaned ? Number(cleaned) : value;
  }
  return value;
};

const parseStringArray = (value: unknown): unknown => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Plain comma-separated form-data values are still accepted.
  }
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const parseJsonArray = (value: unknown): unknown => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
};

export class OrderItemDto {
  @ApiPropertyOptional({
    example: '1',
    nullable: true,
    description: 'Internal product ID; external item uchun null',
  })
  @IsOptional()
  @IsString()
  product_id?: string | null;

  @ApiPropertyOptional({
    example: 'Marketplace mahsuloti',
    nullable: true,
    description: 'External item nomi',
  })
  @IsOptional()
  @IsString()
  product_name?: string | null;

  /**
   * IDG1z5y9: ilgari chegara yo'q edi — `quantity: -5` bilan buyurtma
   * yozilib, mahsulot statistikasi va hisob-kitobni buzardi.
   */
  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @IsOptional()
  @IsInt({ message: 'quantity butun son bo‘lishi kerak' })
  @Min(1, { message: 'quantity kamida 1 bo‘lishi kerak' })
  quantity?: number;
}

export class CreateOrderCustomerDto {
  @ApiProperty({ example: 'Ali Valiyev' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: '+998901112233' })
  @IsNotEmpty()
  @IsString()
  phone_number!: string;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  market_id?: string;

  @ApiProperty({ example: '12' })
  @IsNotEmpty()
  @IsString()
  district_id!: string;

  @ApiPropertyOptional({ example: '90-111-22-33' })
  @IsOptional()
  @IsString()
  extra_number?: string;

  @ApiPropertyOptional({ example: 'Yunusobod, 12-kvartal' })
  @IsOptional()
  @IsString()
  address?: string;
}

export class CreateOrderRequestDto {
  @ApiPropertyOptional({
    example: '1',
    description:
      'Market ID (admin/superadmin/reg uchun majburiy, market rolida token’dan olinadi)',
  })
  @IsOptional()
  @IsString()
  market_id?: string;

  @ApiPropertyOptional({
    example: '1',
    description:
      'Customer ID (as string/bigint) — faqat superadmin/admin uchun. Boshqa rollarda mijoz `customer` obyektidan aniqlanadi (fix3 RBAC-01).',
  })
  @IsOptional()
  @IsString()
  customer_id?: string;

  @ApiPropertyOptional({ type: CreateOrderCustomerDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateOrderCustomerDto)
  customer?: CreateOrderCustomerDto;

  @ApiPropertyOptional({ enum: Where_deliver, default: Where_deliver.CENTER })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsOptional()
  @IsEnum(Where_deliver)
  where_deliver?: Where_deliver;

  /**
   * IDG1z5y9: ilgari ixtiyoriy va chegarasiz edi — `-1000` bilan buyurtma
   * 201 bilan yozilib, market hisob-kitobi (to_be_paid = total_price −
   * tarif), daromad analitikasi va kuryer inkassatsiyasiga kirardi. 0 —
   * bepul buyurtma, ruxsat etiladi.
   */
  @ApiProperty({ example: 0, minimum: 0 })
  @IsNotEmpty({ message: 'total_price majburiy' })
  @IsNumber()
  @Min(0, { message: "total_price 0 dan kichik bo'lmasligi kerak" })
  total_price!: number;

  /**
   * ⚠️ fix3 C6 (RBAC-05, LC-07): `status`, `post_id`, `current_batch_id`,
   * `courier_id`, `assigned_at`, `return_reason` (va filial xodimi bo'lmasa
   * `branch_id`, `source`) faqat SUPERADMIN/ADMIN dan qabul qilinadi —
   * boshqa rollarda gateway ularni JIMGINA olib tashlaydi.
   */
  @ApiPropertyOptional({
    enum: Order_status,
    default: Order_status.NEW,
    description:
      'Faqat superadmin/admin; boshqa rollarda e’tiborsiz (buyurtma doim NEW)',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsOptional()
  @IsEnum(Order_status)
  status?: Order_status;

  @ApiPropertyOptional({ example: 'Izoh' })
  @IsOptional()
  @IsString()
  comment?: string | null;

  @ApiPropertyOptional({ example: 'Operator' })
  @IsOptional()
  @IsString()
  operator?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '1',
    description: 'Faqat superadmin/admin; boshqa rollarda e’tiborsiz',
  })
  @IsOptional()
  @IsString()
  post_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  district_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  region_id?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '12',
    description:
      'Branch ID (as string/bigint) — superadmin/admin; filial xodimida o‘z filiali majburan, boshqalarda e’tiborsiz',
  })
  @IsOptional()
  @IsString()
  branch_id?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '1001',
    description:
      'Current batch ID (as string/bigint) — faqat superadmin/admin; boshqa rollarda e’tiborsiz',
  })
  @IsOptional()
  @IsString()
  current_batch_id?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '77',
    description:
      'Courier ID (as string/bigint) — faqat superadmin/admin; boshqa rollarda e’tiborsiz',
  })
  @IsOptional()
  @IsString()
  courier_id?: string | null;

  @ApiPropertyOptional({
    example: '2026-04-25T14:30:00+05:00',
    description: 'Faqat superadmin/admin; boshqa rollarda e’tiborsiz',
  })
  @IsOptional()
  @IsISO8601()
  assigned_at?: string | null;

  @ApiPropertyOptional({
    example: 'Mijoz uyda yo‘q edi',
    description: 'Faqat superadmin/admin; boshqa rollarda e’tiborsiz',
  })
  @IsOptional()
  @IsString()
  return_reason?: string | null;

  @ApiPropertyOptional({ example: 'Toshkent, Chilonzor' })
  @IsOptional()
  @IsString()
  address?: string | null;

  @ApiPropertyOptional({
    enum: OrderSourceDto,
    default: OrderSourceDto.INTERNAL,
    description:
      'Superadmin/admin; filial xodimida majburan `branch`, boshqalarda e’tiborsiz',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsOptional()
  @IsEnum(OrderSourceDto)
  source?: OrderSourceDto;

  // IDG1z5y9: bo'sh `items: []` — mahsulotsiz buyurtma; rad etiladi.
  @ApiPropertyOptional({ type: [OrderItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: "items bo'sh bo'lmasligi kerak" })
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];
}

export class UpdateOrderRequestDto {
  @ApiPropertyOptional({ enum: Where_deliver })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsOptional()
  @IsEnum(Where_deliver)
  where_deliver?: Where_deliver;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  total_price?: number;

  @ApiPropertyOptional({ enum: Order_status })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsOptional()
  @IsEnum(Order_status)
  status?: Order_status;

  @ApiPropertyOptional({ example: 'Izoh' })
  @IsOptional()
  @IsString()
  comment?: string | null;

  @ApiPropertyOptional({ example: 'Operator' })
  @IsOptional()
  @IsString()
  operator?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  post_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  district_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  region_id?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '12',
    description: 'Branch ID (as string/bigint)',
  })
  @IsOptional()
  @IsString()
  branch_id?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '1001',
    description: 'Current batch ID (as string/bigint)',
  })
  @IsOptional()
  @IsString()
  current_batch_id?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '77',
    description: 'Courier ID (as string/bigint)',
  })
  @IsOptional()
  @IsString()
  courier_id?: string | null;

  @ApiPropertyOptional({ example: '2026-04-25T14:30:00+05:00' })
  @IsOptional()
  @IsISO8601()
  assigned_at?: string | null;

  @ApiPropertyOptional({ example: 'Mijoz uyda yo‘q edi' })
  @IsOptional()
  @IsString()
  return_reason?: string | null;

  @ApiPropertyOptional({ example: 'Toshkent, Chilonzor' })
  @IsOptional()
  @IsString()
  address?: string | null;

  @ApiPropertyOptional({ type: [OrderItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];
}

export class UpdateOrderByIdRequestDto {
  @ApiPropertyOptional({ enum: Where_deliver })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsOptional()
  @IsEnum(Where_deliver)
  where_deliver?: Where_deliver;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  total_price?: number;

  /**
   * ⚠️ fix3 C6 (M11): `status`, `market_id`, `to_be_paid`, `paid_amount`
   * DTO'da ATAYLAB qoldirilgan — gateway ularni tushunarli o'zbekcha 400
   * bilan rad etadi (`PATCH_FORBIDDEN_FIELDS`). DTO'dan olib tashlansa
   * ValidationPipe inglizcha "should not exist" qaytarardi.
   */
  @ApiPropertyOptional({
    enum: Order_status,
    deprecated: true,
    description:
      "PATCH orqali o'zgartirib bo'lmaydi (400) — holat sotish/bekor qilish/qaytarish amallari orqali o'zgaradi",
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsOptional()
  @IsEnum(Order_status)
  status?: Order_status;

  @ApiPropertyOptional({ example: 'Izoh' })
  @IsOptional()
  @IsString()
  comment?: string | null;

  @ApiPropertyOptional({ example: 'Operator' })
  @IsOptional()
  @IsString()
  operator?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '1',
    description: "Faqat superadmin o'zgartira oladi (aks holda 403)",
  })
  @IsOptional()
  @IsString()
  post_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  district_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  region_id?: string | null;

  @ApiPropertyOptional({ example: 'Toshkent, Chilonzor' })
  @IsOptional()
  @IsString()
  address?: string | null;

  @ApiPropertyOptional({ type: [OrderItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];

  @ApiPropertyOptional({
    example: '1',
    deprecated: true,
    description: "Market ID — PATCH orqali o'zgartirib bo'lmaydi (400)",
  })
  @IsOptional()
  @IsString()
  market_id?: string;

  @ApiPropertyOptional({
    example: '1',
    description:
      "Customer ID (as string/bigint) — faqat superadmin o'zgartira oladi (aks holda 403)",
  })
  @IsOptional()
  @IsString()
  customer_id?: string;

  @ApiPropertyOptional({
    example: 0,
    deprecated: true,
    description: "PATCH orqali o'zgartirib bo'lmaydi (400)",
  })
  @IsOptional()
  @IsNumber()
  to_be_paid?: number;

  @ApiPropertyOptional({
    example: 0,
    deprecated: true,
    description: "PATCH orqali o'zgartirib bo'lmaydi (400)",
  })
  @IsOptional()
  @IsNumber()
  paid_amount?: number;

  @ApiPropertyOptional({
    example: 'qr_token',
    description: "Faqat superadmin o'zgartira oladi (aks holda 403)",
  })
  @IsOptional()
  @IsString()
  qr_code_token?: string | null;

  @ApiPropertyOptional({
    enum: OrderSourceDto,
    default: OrderSourceDto.INTERNAL,
    description: "Faqat superadmin o'zgartira oladi (aks holda 403)",
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsOptional()
  @IsEnum(OrderSourceDto)
  source?: OrderSourceDto;
}

export class OrdersArrayDto {
  @ApiProperty({
    type: [String],
    example: [
      '6b1f3f2a-8c1d-4e2b-9f4a-1234567890ab',
      '7c2e4d3b-9d2e-5f3c-0a5b-abcdefabcdef',
    ],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  order_ids!: string[];
}

/**
 * Skanerlangan yorliq tokenlari.
 *
 * ⚠️ `order_ids` EMAS va bu ataylab: server skanerlash DALILINI o'zi
 * tekshirishi kerak. Frontend id yuborsa, skanerlash bo'lgan-bo'lmaganini
 * server bilmaydi va darvoza faqat UI'da qoladi (audit K2).
 */
export class ReceiveByScanDto {
  @ApiProperty({
    type: [String],
    description: 'Posilka yorliqlaridan skanerlangan QR qiymatlari',
    example: ['a1b2c3d4e5f6a1b2c3d4e5f6', 'f6e5d4c3b2a1f6e5d4c3b2a1'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  tokens!: string[];
}

export class CancelledManualOverrideDto {
  @ApiProperty({ example: '101' })
  @IsNotEmpty()
  @IsString()
  order_id!: string;

  @ApiProperty({
    example: CancelledManualOverrideReasonDto.TORN,
    enum: CancelledManualOverrideReasonDto,
  })
  @IsNotEmpty()
  @IsString()
  @IsEnum(CancelledManualOverrideReasonDto)
  @MaxLength(80)
  reason!: string;
}

export class HandoverCancelledOrdersToMarketRequestDto extends OrdersArrayDto {
  @ApiProperty({
    example: 'MHA-secure-one-time-token',
    description:
      'QR scan orqali olingan 5 daqiqalik authorization token. Marketda QR talab o‘chirilgan bo‘lsa yuborilmasligi mumkin.',
    required: false,
  })
  @IsOptional()
  @IsString()
  authorization_token?: string;

  @ApiPropertyOptional({
    description:
      'QR buzilgani sabab qo‘lda tasdiqlangan orderlar ro‘yxati. Faqat HQ xodimlari uchun audit metadata.',
    example: [{ order_id: '101', reason: 'QR yirtilgan' }],
    type: () => [CancelledManualOverrideDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CancelledManualOverrideDto)
  manual_overrides?: CancelledManualOverrideDto[];
}

export class SellOrderRequestDto {
  @ApiPropertyOptional({ example: 'Customer accepted with discount' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiPropertyOptional({ example: 5000, minimum: 0 })
  @IsOptional()
  @Transform(({ value }) => parseFormattedNumber(value))
  @IsNumber()
  extraCost?: number;

  /**
   * `paidAmount` sotuvda ISHLATILMAYDI (ZsPLevZZ): u buyurtmani "to'landi"
   * qilib qo'yardi, lekin hech qanday kassa oyog'i yozilmasdi — ikki daftar
   * ajralardi. Marketga to'lov: `/finance/cashbox/payment/market`.
   * Maydon butunlay olib tashlansa `forbidNonWhitelisted` `paidAmount: 0`
   * yuboradigan eski klientlarni ham 400 bilan yiqitardi — shuning uchun
   * faqat 0 qabul qilinadi (CancelOrderRequestDto bilan bir xil).
   */
  @ApiPropertyOptional({
    example: 0,
    deprecated: true,
    description:
      "ESKIRGAN — sotuvda to'lov qabul qilinmaydi. Faqat 0 qabul qilinadi (eski klientlar uchun); boshqa qiymat 400 (ZsPLevZZ).",
  })
  @IsOptional()
  @Transform(({ value }) => parseFormattedNumber(value))
  @IsNumber()
  @Min(0)
  @Max(0, {
    message:
      "paidAmount sotuvda qabul qilinmaydi — marketga to'lov /finance/cashbox/payment/market orqali",
  })
  paidAmount?: number;

  @ApiPropertyOptional({
    type: [String],
    description:
      "Xarajat isboti uchun yuklangan fayl kalitlari (rasm/video). Market isbot talab qilsa va extraCost > 0 bo'lsa majburiy.",
    example: ['proof-1700000000000-uuid-video.mp4'],
  })
  @IsOptional()
  @Transform(({ value }) => parseStringArray(value))
  @IsArray()
  @IsString({ each: true })
  proofFileKeys?: string[];
}

export class CancelOrderRequestDto {
  @ApiPropertyOptional({
    enum: CancelReason,
    example: CancelReason.CUSTOMER_REFUSED,
    description:
      "Bekor qilish sababi (yopiq ro'yxat). OTHER bo'lsa comment majburiy. " +
      'Berilmasa comment majburiy va sabab OTHER deb yoziladi (eski klientlar).',
  })
  @IsOptional()
  @IsEnum(CancelReason)
  reason?: CancelReason;

  @ApiPropertyOptional({ example: 'Mijoz telefonni ko‘tarmadi' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiPropertyOptional({ example: 5000, minimum: 0 })
  @IsOptional()
  @Transform(({ value }) => parseFormattedNumber(value))
  @IsNumber()
  extraCost?: number;

  @ApiPropertyOptional({
    example: 0,
    deprecated: true,
    description:
      "ESKIRGAN — bekor qilishda to'lov bo'lmaydi. Faqat 0 qabul qilinadi (eski UI uchun); boshqa qiymat 400 (T0UGh8bL).",
  })
  @IsOptional()
  @Transform(({ value }) => parseFormattedNumber(value))
  @IsNumber()
  @Min(0)
  @Max(0, {
    message:
      "paidAmount bekor qilishda qabul qilinmaydi — faqat 0 bo'lishi mumkin",
  })
  paidAmount?: number;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Xarajat isboti uchun yuklangan fayl kalitlari (rasm/video). Market isbot talab qilsa majburiy.',
    example: ['proof-1700000000000-uuid-video.mp4'],
  })
  @IsOptional()
  @Transform(({ value }) => parseStringArray(value))
  @IsArray()
  @IsString({ each: true })
  proofFileKeys?: string[];
}

export class ExtraCostApprovalDecisionDto {
  @ApiPropertyOptional({ example: 'Tasdiqlandi' })
  @IsOptional()
  @IsString()
  comment?: string;
}

export class CouldNotDeliverOrderRequestDto {
  @ApiProperty({
    example: "Mijoz uyda yo'q edi, ertaga qayta urinish so'radi",
    description: 'Yetkazib berolmaslik sababi (kamida 10 ta belgi)',
  })
  @IsString()
  @MinLength(10)
  reason!: string;
}

export class PartlySoldItemDto {
  @ApiPropertyOptional({
    example: '5501',
    description:
      "Buyurtma qatorining id'si (GET /orders/:id → items[].id). Katalogsiz " +
      '(hamkor) qatorlarda product_id null — ular faqat shu id bilan topiladi. ' +
      'Berilsa qator avval shu bo‘yicha moslanadi.',
  })
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  order_item_id?: string;

  @ApiPropertyOptional({
    // `string | null` tipini Swagger o'zi `object` deb o'qiydi.
    type: String,
    example: '1',
    nullable: true,
    description:
      'Katalog mahsuloti id. order_item_id berilmasa majburiy (eski usul).',
  })
  @ValidateIf((item: PartlySoldItemDto) => !item.order_item_id)
  @IsNotEmpty()
  @IsString()
  product_id?: string | null;

  @ApiProperty({ example: 1, minimum: 0 })
  @IsNumber()
  quantity!: number;
}

export class PartlySellOrderRequestDto {
  @ApiProperty({ type: [PartlySoldItemDto] })
  @Transform(({ value }) => parseJsonArray(value))
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PartlySoldItemDto)
  order_item_info!: PartlySoldItemDto[];

  @ApiProperty({ example: 15000, minimum: 0 })
  @Transform(({ value }) => parseFormattedNumber(value))
  @IsNumber()
  totalPrice!: number;

  @ApiPropertyOptional({ example: 2000, minimum: 0 })
  @IsOptional()
  @Transform(({ value }) => parseFormattedNumber(value))
  @IsNumber()
  extraCost?: number;

  @ApiPropertyOptional({ example: 'Customer bought only 1 unit' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      "Xarajat isboti uchun yuklangan fayl kalitlari (rasm/video). Market sotishda isbot talab qilsa va extraCost > 0 bo'lsa majburiy.",
    example: ['proof-1700000000000-uuid-photo.jpg'],
  })
  @IsOptional()
  @Transform(({ value }) => parseStringArray(value))
  @IsArray()
  @IsString({ each: true })
  proofFileKeys?: string[];
}

export class CreateExternalOrderRequestDto extends CreateOrderRequestDto {
  @ApiPropertyOptional({ example: 'EXT-ORDER-1001' })
  @IsOptional()
  @IsString()
  external_id?: string | null;
}

export class ScanAssignOrderRequestDto {
  @ApiProperty({ example: 'ORD-abc123' })
  @IsNotEmpty()
  @IsString()
  qr_token!: string;
}

export class AssignOrdersToCourierRequestDto {
  @ApiProperty({
    type: [String],
    example: ['101', '102', '103'],
    description: 'Biriktiriladigan order IDlar',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  order_ids!: string[];

  @ApiProperty({ example: '44', description: 'Courier user ID' })
  @IsNotEmpty()
  @IsString()
  courier_id!: string;
}

export class InitiateOrderReturnRequestDto {
  @ApiProperty({ example: 'Mijoz qabul qilmayapti, qaytarish kerak' })
  @IsNotEmpty()
  @IsString()
  reason!: string;
}

export enum RollbackOrderTargetStatusDto {
  WAITING = 'waiting',
  CANCELLED = 'cancelled',
  CANCELLED_SENT = 'cancelled_sent',
}

export class RollbackOrderRequestDto {
  @ApiPropertyOptional({
    enum: RollbackOrderTargetStatusDto,
    example: RollbackOrderTargetStatusDto.WAITING,
    description: "Rollback target status. Default: 'waiting'",
  })
  @IsOptional()
  @IsEnum(RollbackOrderTargetStatusDto)
  target_status?: RollbackOrderTargetStatusDto;
}

export class CreateOrderByTelegramBotRequestDto {
  @ApiProperty({ example: 'Ali Valiyev' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: '+998901112233' })
  @IsNotEmpty()
  @IsString()
  phone_number!: string;

  @ApiProperty({ example: '12' })
  @IsNotEmpty()
  @IsString()
  district_id!: string;

  @ApiPropertyOptional({ example: '90-111-22-33' })
  @IsOptional()
  @IsString()
  extra_number?: string;

  @ApiPropertyOptional({ example: 'Yunusobod, 12-kvartal' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ type: [OrderItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  order_item_info!: OrderItemDto[];

  @ApiProperty({ example: 120000 })
  @Transform(({ value }) => parseFormattedNumber(value))
  @IsNumber()
  // (IDG1z5y9) telegram bot yo'li ham manfiy summani qabul qilmaydi.
  @Min(0)
  total_price!: number;

  @ApiPropertyOptional({ enum: Where_deliver, default: Where_deliver.CENTER })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsOptional()
  @IsEnum(Where_deliver)
  where_deliver?: Where_deliver;

  @ApiPropertyOptional({ example: 'Izoh' })
  @IsOptional()
  @IsString()
  comment?: string | null;

  @ApiPropertyOptional({ example: 'Operator' })
  @IsOptional()
  @IsString()
  operator?: string | null;
}

/**
 * Settlement amount validation (Audit money/API-design P1: the settlement routes
 * accepted an inline-typed { *_id, amount } body, so a negative or NaN amount
 * reached order.settlement.* unvalidated). A shared amount field enforces a
 * non-negative, 2-dp money value.
 */
class SettlementAmountDto {
  @ApiProperty({ description: 'Amount to settle in som (>= 0, 2 dp)' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;
}

export class SettlementCourierToBranchDto extends SettlementAmountDto {
  @ApiProperty({ description: 'Courier user id' })
  @IsNotEmpty()
  @IsString()
  courier_id!: string;
}

export class SettlementBranchToHqDto extends SettlementAmountDto {
  @ApiProperty({ description: 'Branch id' })
  @IsNotEmpty()
  @IsString()
  branch_id!: string;
}

export class SettlementHqToMarketDto extends SettlementAmountDto {
  @ApiProperty({ description: 'Market id' })
  @IsNotEmpty()
  @IsString()
  market_id!: string;
}
