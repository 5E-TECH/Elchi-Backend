import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  FULFILLMENT_SOURCES,
  STOCK_MOVEMENT_REF_TYPES,
  STOCK_MOVEMENT_TYPES,
  WAREHOUSE_ADDRESS_MAX,
  WAREHOUSE_LOW_STOCK_MAX,
  WAREHOUSE_MAX_LINES,
  WAREHOUSE_MAX_QTY,
  WAREHOUSE_NAME_MAX,
  WAREHOUSE_NOTE_MAX,
  WAREHOUSE_REASON_MIN,
  WAREHOUSE_SOURCE_REASONS,
  WAREHOUSE_STATUSES,
  WAREHOUSE_STOCK_LEVELS,
} from '@app/common';

/**
 * hY7uacJu — vaqtinchalik ombor moduli: so'rov DTO'lari (global
 * ValidationPipe `whitelist + forbidNonWhitelisted`) va Swagger javob
 * shakllari. Qoidalar catalog-service'da ham qayta tekshiriladi (RMQ'da
 * ValidationPipe yo'q).
 */

const ID_PATTERN = /^[1-9]\d{0,18}$/;
const ID_MESSAGE = "musbat butun son (raqamli satr) bo'lishi kerak";

// ---------------------------------------------------------------------
// So'rovlar
// ---------------------------------------------------------------------

export class CreateWarehouseRequestDto {
  @ApiProperty({
    example: '11',
    description:
      'Viloyat filiali (REGIONAL yoki HYBRID, faol). Bitta filial — bitta ombor (takror — 409).',
  })
  @IsString()
  @Matches(ID_PATTERN, { message: `branch_id ${ID_MESSAGE}` })
  branch_id!: string;

  @ApiPropertyOptional({
    example: 'Samarqand filiali ombori',
    maxLength: WAREHOUSE_NAME_MAX,
    description: 'Berilmasa — «<filial nomi> ombori».',
  })
  @IsOptional()
  @IsString()
  @MaxLength(WAREHOUSE_NAME_MAX)
  name?: string;

  @ApiPropertyOptional({
    example: '31',
    nullable: true,
    description:
      "Mas'ul xodim — shu filialning menejeri (branch_users, rol MANAGER), aks holda 400. Berilmasa yoki `null` — filialning birinchi faol menejeri (foydalanuvchi id bo'yicha), menejer yo'q bo'lsa `null` (XtcEyQjb). Faqat ko'rsatish uchun: o'qish ruxsati filialdan.",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(ID_PATTERN, { message: `manager_user_id ${ID_MESSAGE}` })
  manager_user_id?: string | null;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    maxLength: WAREHOUSE_ADDRESS_MAX,
    description: "Bo'sh — filial manzili ko'rsatiladi (`effective_address`).",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(WAREHOUSE_ADDRESS_MAX)
  address?: string | null;

  @ApiPropertyOptional({
    example: 5,
    minimum: 0,
    maximum: WAREHOUSE_LOW_STOCK_MAX,
    description:
      "«Kam qoldiq» chegarasi sukuti (dona). Sukut 5; mahsulotda alohida o'zgartiriladi.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(WAREHOUSE_LOW_STOCK_MAX)
  low_stock_default?: number;

  @ApiPropertyOptional({ nullable: true, maxLength: WAREHOUSE_NOTE_MAX })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(WAREHOUSE_NOTE_MAX)
  note?: string | null;
}

export class UpdateWarehouseRequestDto {
  @ApiPropertyOptional({ maxLength: WAREHOUSE_NAME_MAX })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(WAREHOUSE_NAME_MAX)
  name?: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "Shu filial menejeri; `null` — filialning birinchi faol menejeri avtomatik (menejer yo'q bo'lsa `null`, XtcEyQjb).",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(ID_PATTERN, { message: `manager_user_id ${ID_MESSAGE}` })
  manager_user_id?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: WAREHOUSE_ADDRESS_MAX })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(WAREHOUSE_ADDRESS_MAX)
  address?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: WAREHOUSE_LOW_STOCK_MAX })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(WAREHOUSE_LOW_STOCK_MAX)
  low_stock_default?: number;

  @ApiPropertyOptional({ nullable: true, maxLength: WAREHOUSE_NOTE_MAX })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(WAREHOUSE_NOTE_MAX)
  note?: string | null;
}

export class WarehouseStatusRequestDto {
  @ApiPropertyOptional({
    example: 'Mavsum tugadi',
    maxLength: WAREHOUSE_NOTE_MAX,
    description: 'Ixtiyoriy izoh (faoliyat jurnaliga).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(WAREHOUSE_NOTE_MAX)
  note?: string;
}

export class WarehouseStockInLineDto {
  @ApiPropertyOptional({
    example: '142',
    description: 'Mahsulot id — yoki `code` (bittasi majburiy).',
  })
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN, { message: `product_id ${ID_MESSAGE}` })
  product_id?: string;

  @ApiPropertyOptional({
    example: 'ELC-P-000142',
    maxLength: 512,
    description:
      'Skaner qiymati: `ELC-P-…` (Elchi kodi) yoki zavod shtrix kodi (EAN-13/8, UPC, GTIN-14, QR). Bir nechta marketda bor kod — `market_id` bilan.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  code?: string;

  @ApiProperty({ example: 40, minimum: 1, maximum: WAREHOUSE_MAX_QTY })
  @IsInt()
  @Min(1)
  @Max(WAREHOUSE_MAX_QTY)
  qty!: number;
}

export class WarehouseStockInRequestDto {
  @ApiProperty({
    type: [WarehouseStockInLineDto],
    minItems: 1,
    maxItems: WAREHOUSE_MAX_LINES,
    description:
      "Qatorlar (bir mahsulot qatorlari qo'shiladi). Biror qator hal qilinmasa (topilmadi / bir nechta marketda / o'chirilgan / boshqa market) — 400, HECH NARSA yozilmaydi.",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WAREHOUSE_MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => WarehouseStockInLineDto)
  lines!: WarehouseStockInLineDto[];

  @ApiPropertyOptional({
    example: '121',
    description:
      'Ixtiyoriy: kod qidiruvi shu market mahsulotlari bilan; boshqa market mahsuloti — 400.',
  })
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN, { message: `market_id ${ID_MESSAGE}` })
  market_id?: string;

  @ApiPropertyOptional({ maxLength: WAREHOUSE_NOTE_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(WAREHOUSE_NOTE_MAX)
  note?: string;
}

export class WarehouseInventoryLineDto {
  @ApiPropertyOptional({ example: '131' })
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN, { message: `product_id ${ID_MESSAGE}` })
  product_id?: string;

  @ApiPropertyOptional({ example: 'ELC-P-000131', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  code?: string;

  @ApiProperty({
    example: 6,
    minimum: 0,
    maximum: WAREHOUSE_MAX_QTY,
    description:
      "Sanalgan HAQIQIY dona (mutlaq). Band qilingandan kam bo'lsa — 409.",
  })
  @IsInt()
  @Min(0)
  @Max(WAREHOUSE_MAX_QTY)
  counted!: number;
}

export class WarehouseInventoryRequestDto {
  @ApiProperty({
    type: [WarehouseInventoryLineDto],
    minItems: 1,
    maxItems: WAREHOUSE_MAX_LINES,
    description: 'Bir mahsulot ikki marta kiritilsa — 400.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WAREHOUSE_MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => WarehouseInventoryLineDto)
  lines!: WarehouseInventoryLineDto[];

  @ApiProperty({
    example: 'Oylik inventarizatsiya',
    minLength: WAREHOUSE_REASON_MIN,
    maxLength: WAREHOUSE_NOTE_MAX,
    description: 'Tuzatish sababi — MAJBURIY (harakat izohiga yoziladi).',
  })
  @IsString()
  @MinLength(WAREHOUSE_REASON_MIN)
  @MaxLength(WAREHOUSE_NOTE_MAX)
  reason!: string;

  @ApiPropertyOptional({ example: '121' })
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN, { message: `market_id ${ID_MESSAGE}` })
  market_id?: string;
}

export class WarehouseThresholdRequestDto {
  @ApiProperty({
    example: 10,
    nullable: true,
    minimum: 0,
    maximum: WAREHOUSE_LOW_STOCK_MAX,
    description: 'Shu mahsulot chegarasi (dona); `null` — ombor sukuti.',
  })
  @IsDefined()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(WAREHOUSE_LOW_STOCK_MAX)
  low_stock_threshold!: number | null;
}

export class WarehouseOrderItemDto {
  @ApiProperty({ example: '142' })
  @IsString()
  @Matches(ID_PATTERN, { message: `product_id ${ID_MESSAGE}` })
  product_id!: string;

  @ApiProperty({ example: 1, minimum: 1, maximum: WAREHOUSE_MAX_QTY })
  @IsInt()
  @Min(1)
  @Max(WAREHOUSE_MAX_QTY)
  quantity!: number;
}

export class WarehouseResolveSourceRequestDto {
  @ApiPropertyOptional({
    example: '45',
    description:
      'Buyurtma tumani — hudud `assigned_region ?? region_id` bo‘yicha (HQ qabuli bilan bir xil). `region_id` berilsa — u ustun.',
  })
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN, { message: `district_id ${ID_MESSAGE}` })
  district_id?: string;

  @ApiPropertyOptional({ example: '7' })
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN, { message: `region_id ${ID_MESSAGE}` })
  region_id?: string;

  @ApiPropertyOptional({
    example: '121',
    description:
      "Buyurtma marketi. MARKET — e'tiborsiz (tokendagi o'zi), MARKET_OPERATOR — biriktirilgan marketi; xodim — mahsulotlar shu marketniki bo'lishi tekshiriladi.",
  })
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN, { message: `market_id ${ID_MESSAGE}` })
  market_id?: string;

  @ApiProperty({ type: [WarehouseOrderItemDto], maxItems: WAREHOUSE_MAX_LINES })
  @IsArray()
  @ArrayMaxSize(WAREHOUSE_MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => WarehouseOrderItemDto)
  items!: WarehouseOrderItemDto[];
}

export class UpdateMarketWarehouseOrderRequestDto {
  @ApiProperty({
    example: true,
    description:
      "«Ombordan buyurtma yaratish»: TRUE — market yaratgan buyurtma tuman filialidagi faol ombordan ketishi mumkin (mahsulot yetarli bo'lsa). Sukut FALSE.",
  })
  @IsBoolean()
  can_order_from_warehouse!: boolean;
}

// ---------------------------------------------------------------------
// Javoblar (Swagger)
// ---------------------------------------------------------------------

export class WarehouseRefDto {
  @ApiProperty({ example: '11' })
  id!: string;

  @ApiProperty({ example: 'Samarqand filiali' })
  name!: string;
}

export class WarehouseBranchDto extends WarehouseRefDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: 'REGIONAL' })
  type!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'active' })
  status!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  address!: string | null;
}

export class WarehouseManagerDto {
  @ApiProperty({ example: '31' })
  id!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Dilshod Usmonov',
  })
  name!: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '+998915071244',
  })
  phone_number!: string | null;
}

export class WarehouseSummaryDto {
  @ApiProperty({
    example: 12,
    description: 'Pozitsiyalar (mahsulot turlari) soni',
  })
  positions!: number;

  @ApiProperty({ example: 5, description: 'Mahsulotlari bor marketlar soni' })
  markets!: number;

  @ApiProperty({ example: 486, description: 'Jami dona (on_hand)' })
  on_hand!: number;

  @ApiProperty({ example: 38, description: 'Band dona' })
  reserved!: number;

  @ApiProperty({
    example: 448,
    description: 'Sotish uchun mavjud (on_hand − reserved)',
  })
  available!: number;

  @ApiProperty({
    example: 14,
    description: 'Band qilingan (kuryerga berilmagan) faol buyurtmalar soni',
  })
  reserved_orders!: number;

  @ApiProperty({
    example: 2,
    description: '«Kam qoldi» pozitsiyalar (0 < mavjud ≤ chegara)',
  })
  low_count!: number;

  @ApiProperty({
    example: 1,
    description: '«Tugagan» pozitsiyalar (mavjud ≤ 0)',
  })
  out_count!: number;
}

export class WarehouseLastMovementDto {
  @ApiProperty({ example: '901' })
  id!: string;

  @ApiProperty({ enum: STOCK_MOVEMENT_TYPES })
  type!: string;

  @ApiProperty({ example: 40, description: 'Ishorali son (tur bo‘yicha)' })
  qty!: number;

  @ApiPropertyOptional({ enum: STOCK_MOVEMENT_REF_TYPES, nullable: true })
  ref_type!: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '10236',
    description: 'order → buyurtma id',
  })
  ref_id!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at!: string;
}

export class WarehouseDto {
  @ApiProperty({ example: '3' })
  id!: string;

  @ApiProperty({ example: 'Samarqand filiali ombori' })
  name!: string;

  @ApiProperty({ enum: WAREHOUSE_STATUSES, example: 'ACTIVE' })
  status!: string;

  @ApiProperty({ example: '11' })
  branch_id!: string;

  @ApiPropertyOptional({ type: WarehouseBranchDto, nullable: true })
  branch!: WarehouseBranchDto | null;

  @ApiPropertyOptional({
    type: WarehouseRefDto,
    nullable: true,
    description: 'Viloyat (logistika hududi)',
  })
  region!: WarehouseRefDto | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  manager_user_id!: string | null;

  @ApiPropertyOptional({ type: WarehouseManagerDto, nullable: true })
  manager!: WarehouseManagerDto | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  address!: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'address ?? filial manzili',
  })
  effective_address!: string | null;

  @ApiProperty({ example: 5 })
  low_stock_default!: number;

  @ApiPropertyOptional({ type: String, nullable: true })
  note!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  paused_at!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  paused_by!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  created_by!: string | null;

  @ApiProperty({ type: String, format: 'date-time', description: '«Ochilgan»' })
  created_at!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updated_at!: string;

  @ApiProperty({ type: WarehouseSummaryDto })
  summary!: WarehouseSummaryDto;

  @ApiPropertyOptional({ type: WarehouseLastMovementDto, nullable: true })
  last_movement!: WarehouseLastMovementDto | null;
}

export class WarehouseDetailDto extends WarehouseDto {
  @ApiProperty({ example: 86, description: '«Harakatlar» tab soni' })
  movements_count!: number;
}

export class WarehouseCountsDto {
  @ApiProperty({ example: 4 })
  all!: number;

  @ApiProperty({ example: 3 })
  active!: number;

  @ApiProperty({ example: 1 })
  paused!: number;
}

export class WarehouseListSummaryDto {
  @ApiProperty({ example: 4 })
  warehouses!: number;

  @ApiProperty({ example: 3 })
  active!: number;

  @ApiProperty({ example: 1 })
  paused!: number;

  @ApiProperty({ example: 33 })
  positions!: number;

  @ApiProperty({ example: 1156 })
  on_hand!: number;

  @ApiProperty({ example: 68 })
  reserved!: number;

  @ApiProperty({ example: 1088 })
  available!: number;

  @ApiProperty({ example: 27 })
  reserved_orders!: number;

  @ApiProperty({ example: 5 })
  low_count!: number;

  @ApiProperty({ example: 1 })
  out_count!: number;
}

export class WarehouseListResponseDto {
  @ApiProperty({ type: [WarehouseDto] })
  data!: WarehouseDto[];

  @ApiProperty({ example: 4 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({
    type: WarehouseCountsDto,
    description: 'Viloyat/qidiruv filtridan keyin holat bo‘yicha',
  })
  counts!: WarehouseCountsDto;

  @ApiProperty({
    type: WarehouseListSummaryDto,
    description: 'Ko‘rinadigan HAMMA omborlar (filtrsiz)',
  })
  summary!: WarehouseListSummaryDto;
}

export class WarehouseCodeDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '8806095501239',
  })
  value!: string | null;

  @ApiProperty({
    enum: ['barcode', 'sku'],
    description: 'barcode — zavod shtrix kodi; sku — Elchi QR kodi',
  })
  kind!: string;

  @ApiProperty({ enum: ['ELC', 'EAN-13', 'EAN-8', 'GTIN-14', 'TEXT'] })
  format!: string;
}

export class WarehouseProductDto {
  @ApiProperty({ example: '142' })
  id!: string;

  @ApiProperty({ example: 'Simsiz quloqchin' })
  name!: string;

  @ApiProperty({ example: '121' })
  market_id!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'ELC-P-000142',
  })
  sku_code!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  barcode!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  image_url!: string | null;

  @ApiProperty({
    description: "O'chirilgan mahsulot (jismoniy qoldiq baribir ko'rinadi)",
  })
  is_deleted!: boolean;

  @ApiProperty({
    type: WarehouseCodeDto,
    description: 'Ekrandagi kod: zavod kodi bo‘lsa o‘sha, aks holda ELC-P',
  })
  code!: WarehouseCodeDto;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 0.2 })
  weight_kg!: number | null;

  @ApiPropertyOptional({ type: 'integer', nullable: true })
  length_cm!: number | null;

  @ApiPropertyOptional({ type: 'integer', nullable: true })
  width_cm!: number | null;

  @ApiPropertyOptional({ type: 'integer', nullable: true })
  height_cm!: number | null;

  @ApiProperty()
  volumetric_enabled!: boolean;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 38.4,
    description:
      '«Hisob vazni» = max(og‘irlik, U×K×B/5000), kg (3 kasr). AQ9lkgVB: hajmli vazn narx sozlamasidagi `volumetric_from_kg` dan kichik bo‘lsa — faqat og‘irlik',
  })
  chargeable_weight_kg!: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'U×K×B/5000, kg — chegaradan qat‘i nazar (hajm o‘chiq yoki o‘lcham yo‘q — null)',
  })
  volumetric_weight_kg!: number | null;

  @ApiPropertyOptional({
    enum: ['actual', 'volumetric'],
    nullable: true,
    description: 'volumetric — «hajm bo‘yicha»',
  })
  chargeable_basis!: string | null;

  @ApiProperty({
    description:
      "Og'irlik yo'q — «O'lchov yo'q — yetkazish narxi hisoblanmaydi»",
  })
  measure_missing!: boolean;
}

export class WarehouseMarketRefDto {
  @ApiProperty({ example: '121' })
  id!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Baraka Shop' })
  name!: string | null;
}

export class WarehouseStockRowDto {
  @ApiProperty({ example: '55' })
  stock_id!: string;

  @ApiProperty({ type: WarehouseProductDto })
  product!: WarehouseProductDto;

  @ApiProperty({ type: WarehouseMarketRefDto })
  market!: WarehouseMarketRefDto;

  @ApiProperty({ example: 4, description: 'Qoldiq' })
  on_hand!: number;

  @ApiProperty({ example: 1, description: 'Band' })
  reserved!: number;

  @ApiProperty({ example: 3, description: 'Mavjud' })
  available!: number;

  @ApiPropertyOptional({
    type: 'integer',
    nullable: true,
    description: 'Mahsulotning o‘z chegarasi (null — ombor sukuti)',
  })
  low_stock_threshold!: number | null;

  @ApiProperty({ example: 2, description: 'Amaldagi chegara' })
  threshold!: number;

  @ApiProperty({
    enum: WAREHOUSE_STOCK_LEVELS,
    description: 'ok — Yetarli, low — Kam qoldi, out — Tugagan',
  })
  level!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  last_movement_at!: string | null;
}

export class WarehouseLevelFacetDto {
  @ApiProperty() all!: number;
  @ApiProperty() ok!: number;
  @ApiProperty() low!: number;
  @ApiProperty() out!: number;
}

export class WarehouseMarketFacetDto extends WarehouseMarketRefDto {
  @ApiProperty({ example: 4 })
  positions!: number;
}

export class WarehouseStockFacetsDto {
  @ApiProperty({
    type: WarehouseLevelFacetDto,
    description: 'Market/qidiruv filtridan keyin holat bo‘yicha',
  })
  levels!: WarehouseLevelFacetDto;

  @ApiProperty({
    type: [WarehouseMarketFacetDto],
    description: '«Market:» filtri',
  })
  markets!: WarehouseMarketFacetDto[];
}

export class WarehouseShortRefDto {
  @ApiProperty({ example: '3' })
  id!: string;

  @ApiProperty({ example: 'Samarqand filiali ombori' })
  name!: string;

  @ApiProperty({ enum: WAREHOUSE_STATUSES })
  status!: string;
}

export class WarehouseStockListResponseDto {
  @ApiProperty({ type: WarehouseShortRefDto })
  warehouse!: WarehouseShortRefDto;

  @ApiProperty({ type: [WarehouseStockRowDto] })
  data!: WarehouseStockRowDto[];

  @ApiProperty({ example: 12 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ type: WarehouseStockFacetsDto })
  facets!: WarehouseStockFacetsDto;
}

export class WarehouseMovementProductDto {
  @ApiProperty({ example: '142' })
  id!: string;

  @ApiProperty({ example: 'Quvvatlagich 20 W' })
  name!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  sku_code!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  barcode!: string | null;
}

export class WarehouseActorDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: '2' })
  id!: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Nilufar Rashidova',
  })
  name!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'admin' })
  role!: string | null;
}

export class WarehouseMovementDto {
  @ApiProperty({ example: '901' })
  id!: string;

  @ApiProperty({
    enum: STOCK_MOVEMENT_TYPES,
    description:
      'IN — Kirim, RESERVE — Band, OUT — Chiqim (kuryerga berildi), RELEASE — band bo‘shadi (bekor), RETURN — Qaytdi, ADJUST — Tuzatish (inventarizatsiya), MOVE_* — ko‘chirish (hozir yo‘q)',
  })
  type!: string;

  @ApiProperty({
    example: 40,
    description:
      'Ishorali: IN/RETURN +, OUT −, ADJUST ±, RESERVE + (band), RELEASE − (band)',
  })
  qty!: number;

  @ApiProperty({ example: 49 })
  on_hand_after!: number;

  @ApiProperty({ example: 2 })
  reserved_after!: number;

  @ApiPropertyOptional({ enum: STOCK_MOVEMENT_REF_TYPES, nullable: true })
  ref_type!: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'order → buyurtma id; stock_in/inventory → Idempotency-Key',
  })
  ref_id!: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '10241',
    description: '«Buyurtma №…»',
  })
  order_id!: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Kirim izohi / inventarizatsiya sababi',
  })
  note!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at!: string;

  @ApiProperty({ type: WarehouseMovementProductDto })
  product!: WarehouseMovementProductDto;

  @ApiProperty({ type: WarehouseMarketRefDto })
  market!: WarehouseMarketRefDto;

  @ApiPropertyOptional({ type: WarehouseActorDto, nullable: true })
  actor!: WarehouseActorDto | null;
}

export class WarehouseMovementListResponseDto {
  @ApiProperty({ type: WarehouseShortRefDto })
  warehouse!: WarehouseShortRefDto;

  @ApiProperty({ type: [WarehouseMovementDto] })
  data!: WarehouseMovementDto[];

  @ApiProperty({ example: 86 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;
}

export class WarehouseLookupStockDto {
  @ApiProperty() on_hand!: number;
  @ApiProperty() reserved!: number;
  @ApiProperty() available!: number;
  @ApiProperty() threshold!: number;
  @ApiProperty({ enum: WAREHOUSE_STOCK_LEVELS }) level!: string;
}

export class WarehouseLookupItemDto {
  @ApiProperty({ type: WarehouseProductDto })
  product!: WarehouseProductDto;

  @ApiProperty({ type: WarehouseMarketRefDto })
  market!: WarehouseMarketRefDto;

  @ApiPropertyOptional({
    type: WarehouseLookupStockDto,
    nullable: true,
    description: 'null — omborda hali yo‘q («0 · yangi»)',
  })
  stock!: WarehouseLookupStockDto | null;
}

export class WarehouseLookupResponseDto {
  @ApiProperty({ type: WarehouseShortRefDto })
  warehouse!: WarehouseShortRefDto;

  @ApiProperty({ example: '4780123450017' })
  code!: string;

  @ApiPropertyOptional({ enum: ['sku_code', 'barcode'], nullable: true })
  matched_by!: string | null;

  @ApiProperty({
    type: [WarehouseLookupItemDto],
    description:
      'Bo‘sh — topilmadi (zavod kodi bo‘lsa «Mahsulotga bog‘lash»: PATCH /product/:id { barcode }, keyin kirim).',
  })
  data!: WarehouseLookupItemDto[];
}

export class WarehouseStockInLineResultDto {
  @ApiProperty() product_id!: string;
  @ApiProperty() product_name!: string;
  @ApiProperty() market_id!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) sku_code!:
    | string
    | null;
  @ApiPropertyOptional({ type: String, nullable: true }) barcode!:
    | string
    | null;
  @ApiProperty({ example: 40 }) qty!: number;
  @ApiProperty({ example: 49, description: 'Kirimdan keyingi qoldiq' })
  on_hand!: number;
  @ApiProperty() reserved!: number;
  @ApiProperty() available!: number;
  @ApiProperty() movement_id!: string;
}

export class WarehouseStockInResponseDto {
  @ApiProperty() warehouse_id!: string;
  @ApiProperty() warehouse_name!: string;

  @ApiProperty({
    description:
      'true — shu Idempotency-Key bilan avval bajarilgan; qoldiq qayta o‘zgarmadi',
  })
  replayed!: boolean;

  @ApiProperty({ example: 3 }) positions!: number;
  @ApiProperty({ example: 100 }) total_qty!: number;
  @ApiProperty({ type: [WarehouseStockInLineResultDto] })
  lines!: WarehouseStockInLineResultDto[];
}

export class WarehouseInventoryLineResultDto {
  @ApiProperty() product_id!: string;
  @ApiProperty() product_name!: string;
  @ApiProperty() market_id!: string;
  @ApiProperty({ example: 6 }) counted!: number;
  @ApiProperty({ example: 8 }) before!: number;
  @ApiProperty({ example: 6 }) after!: number;
  @ApiProperty({ example: -2 }) delta!: number;
  @ApiProperty() reserved!: number;
  @ApiProperty() available!: number;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'null — farq 0, yozilmadi',
  })
  movement_id!: string | null;
}

export class WarehouseInventoryResponseDto {
  @ApiProperty() warehouse_id!: string;
  @ApiProperty() replayed!: boolean;
  @ApiProperty() reason!: string;
  @ApiProperty({ example: 1 }) changed!: number;
  @ApiProperty({ example: 2 }) unchanged!: number;
  @ApiProperty({ type: [WarehouseInventoryLineResultDto] })
  lines!: WarehouseInventoryLineResultDto[];
}

export class WarehouseThresholdResponseDto {
  @ApiProperty() warehouse_id!: string;
  @ApiProperty() product_id!: string;
  @ApiPropertyOptional({ type: 'integer', nullable: true })
  low_stock_threshold!: number | null;
  @ApiProperty() effective_threshold!: number;
  @ApiProperty() on_hand!: number;
  @ApiProperty() reserved!: number;
  @ApiProperty() available!: number;
}

export class WarehouseCandidateDto {
  @ApiProperty({ example: '3' }) id!: string;
  @ApiProperty({ example: 'Samarqand filiali ombori' }) name!: string;
  @ApiProperty({ enum: WAREHOUSE_STATUSES }) status!: string;
  @ApiProperty({ example: '11' }) branch_id!: string;
  @ApiProperty({ example: 'Samarqand filiali' }) branch_name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) region_id!:
    | string
    | null;
  @ApiPropertyOptional({ type: String, nullable: true }) region_name!:
    | string
    | null;
}

export class WarehouseSourceItemDto {
  @ApiProperty() product_id!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ example: 2, description: 'kerak' }) required!: number;
  @ApiProperty({ example: 1, description: 'bor (mavjud)' }) available!: number;
  @ApiProperty() enough!: boolean;
}

export class WarehouseShortageDto {
  @ApiProperty() product_id!: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Bluetooth quloqchin',
  })
  name!: string | null;
  @ApiProperty({ example: 2 }) required!: number;
  @ApiProperty({ example: 1 }) available!: number;
}

export class WarehouseResolveSourceResponseDto {
  @ApiProperty({ enum: FULFILLMENT_SOURCES, example: 'WAREHOUSE' })
  source!: string;

  @ApiProperty({
    enum: WAREHOUSE_SOURCE_REASONS,
    description:
      "OK — ombor; qolgani — HQ: NO_ITEMS, NO_REGION (tuman hududi aniqlanmadi), NO_WAREHOUSE (hududda ombor yo'q), WAREHOUSE_PAUSED («Tuman ombori to'xtatilgan»), INSUFFICIENT_STOCK («Omborda yetmaydi — butun buyurtma HQ'dan»), MARKET_NOT_ALLOWED (market kaliti o'chiq), PRODUCT_INVALID",
  })
  reason!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  region_id!: string | null;

  @ApiPropertyOptional({ type: WarehouseCandidateDto, nullable: true })
  warehouse!: WarehouseCandidateDto | null;

  @ApiProperty({ type: [WarehouseSourceItemDto] })
  items!: WarehouseSourceItemDto[];

  @ApiProperty({ type: [WarehouseShortageDto] })
  shortages!: WarehouseShortageDto[];
}

export class WarehouseAvailabilityItemDto {
  @ApiProperty() product_id!: string;
  @ApiProperty() on_hand!: number;
  @ApiProperty() reserved!: number;
  @ApiProperty({ description: '«Omborda: N»' }) available!: number;
}

export class WarehouseAvailabilityResponseDto {
  @ApiPropertyOptional({ type: String, nullable: true }) region_id!:
    | string
    | null;

  @ApiPropertyOptional({
    type: WarehouseCandidateDto,
    nullable: true,
    description: 'PAUSED bo‘lsa items bo‘sh',
  })
  warehouse!: WarehouseCandidateDto | null;

  @ApiProperty({
    type: [WarehouseAvailabilityItemDto],
    description: 'Faqat omborda qatori bor mahsulotlar',
  })
  items!: WarehouseAvailabilityItemDto[];
}

export class MarketStockWarehouseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: WAREHOUSE_STATUSES }) status!: string;
  @ApiPropertyOptional({ type: WarehouseRefDto, nullable: true })
  branch!: WarehouseRefDto | null;
  @ApiPropertyOptional({ type: WarehouseRefDto, nullable: true })
  region!: WarehouseRefDto | null;
}

export class MarketStockCellDto {
  @ApiProperty() warehouse_id!: string;
  @ApiProperty({ enum: WAREHOUSE_STATUSES }) warehouse_status!: string;
  @ApiProperty() on_hand!: number;
  @ApiProperty() reserved!: number;
  @ApiProperty({ description: 'Katakdagi raqam (sotish uchun mavjud)' })
  available!: number;
  @ApiProperty() threshold!: number;
  @ApiProperty({ enum: WAREHOUSE_STOCK_LEVELS }) level!: string;
}

export class MarketStockRowDto {
  @ApiProperty({ type: WarehouseProductDto }) product!: WarehouseProductDto;

  @ApiProperty({
    type: [MarketStockCellDto],
    description: 'Faqat qatori bor omborlar; yo‘q — «—»',
  })
  cells!: MarketStockCellDto[];

  @ApiProperty({
    example: 30,
    description: '«Jami» — faqat FAOL omborlar mavjud donasi',
  })
  total_available!: number;

  @ApiProperty() total_on_hand!: number;

  @ApiProperty({ description: 'Faol omborlardan birida kam qoldi / tugagan' })
  has_low!: boolean;
}

export class MarketStockSummaryDto {
  @ApiProperty({ example: 12 }) products_total!: number;
  @ApiProperty({ example: 8 }) products_in_warehouses!: number;
  @ApiProperty({
    example: 446,
    description: 'Faol omborlardagi jami mavjud dona',
  })
  total_available!: number;
  @ApiProperty({ example: 4 }) warehouses_total!: number;
  @ApiProperty({ example: 3 }) warehouses_active!: number;
  @ApiProperty({ example: 1 }) warehouses_paused!: number;
  @ApiProperty({
    example: 3,
    description: 'Sotish uchun mavjud donasi bor faol omborlar',
  })
  active_warehouses_with_stock!: number;
  @ApiProperty({ example: 3 }) low_positions!: number;
  @ApiProperty({ example: 1 }) out_positions!: number;
}

export class MarketWarehouseStockResponseDto {
  @ApiProperty() market_id!: string;
  @ApiProperty({
    type: [MarketStockWarehouseDto],
    description: 'Jadval ustunlari (hamma omborlar)',
  })
  warehouses!: MarketStockWarehouseDto[];
  @ApiProperty({ type: [MarketStockRowDto] }) data!: MarketStockRowDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty({ type: MarketStockSummaryDto }) summary!: MarketStockSummaryDto;
}
