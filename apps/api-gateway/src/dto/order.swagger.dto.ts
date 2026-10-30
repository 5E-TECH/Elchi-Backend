import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProblemContactDto } from './contacts.swagger.dto';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsEnum,
  IsIn,
  IsISO8601,
  MaxLength,
  MinLength,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  CancelReason,
  normalizeUzPhone,
  ORDER_FULFILLMENT_MODES,
  type OrderFulfillmentMode,
  Order_status,
  Where_deliver,
  ExtraCostRejectReason,
} from '@app/common';
import {
  IsOrderCreateDistrict,
  IsOrderCreateItems,
  isProvidedDistrictId,
} from '../order-create/order-create-content';

/**
 * (lQjt6sKP) Sotuv `multipart/form-data` bilan ham keladi — "true"/"1"
 * satrlari ham `true`. Boshqa qiymat o'zgarishsiz qoladi va `IsBoolean`
 * uni 400 bilan rad etadi.
 */
const parseBooleanFlag = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0' || v === '') return false;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  return value;
};

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

/**
 * Mijoz telefoni (zfPNDCCr): qabul qilinadigan har shakl ("998901112233",
 * "+998 90 111 22 33", "90 111 22 33", "0901112233") kanonik
 * `+998XXXXXXXXX` ga keltiriladi — umumiy `normalizeUzPhone` (hamkor DTO,
 * AI va OTP bilan AYNI qoida). Keltirib bo'lmasa qiymat O'ZGARMAYDI va
 * `@Matches(UZ_PHONE_E164_RE)` uni 400 bilan rad etadi.
 */
const UZ_PHONE_E164_RE = /^\+998\d{9}$/;
const UZ_PHONE_MESSAGE =
  "Telefon raqam noto'g'ri — +998XXXXXXXXX formatidagi raqam kerak";
const toCanonicalUzPhone = ({ value }: { value: unknown }): unknown =>
  normalizeUzPhone(value) ?? value;
/** Ixtiyoriy telefon: bo'sh satr/bo'shliq — yuborilmagan (`undefined`). */
const toOptionalCanonicalUzPhone = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === ''
    ? undefined
    : toCanonicalUzPhone({ value });

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

  /**
   * ⚠️ TELEFON NORMALLASHTIRILADI (zfPNDCCr). Ilgari faqat `@IsString()`
   * edi — himoya faqat admin formasi maskasida edi: API'ga to'g'ridan-to'g'ri
   * "998887009150" yoki "+998 88 700 91 50" yuborilsa, identity mijozni xom
   * satr bo'yicha qidirgani uchun bitta odam bir nechta mijozga bo'linardi,
   * "not-a-phone" esa 201 bilan o'tardi. POST /orders va /orders/external
   * (meros) shu DTO'dan o'tadi.
   */
  @ApiProperty({
    example: '+998901112233',
    description:
      "O'zbekiston raqami. Qabul qilinadi: +998XXXXXXXXX, 998XXXXXXXXX, " +
      '0XXXXXXXXX, XXXXXXXXX (probel/qavs/defis bilan ham) — server ' +
      '+998XXXXXXXXX ga keltiradi; boshqasi 400.',
  })
  @Transform(toCanonicalUzPhone)
  @IsNotEmpty()
  @IsString()
  @Matches(UZ_PHONE_E164_RE, { message: UZ_PHONE_MESSAGE })
  phone_number!: string;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  market_id?: string;

  /**
   * IR2OHIiN (prod tester, 2026-10-26): yo'q / bo'sh tuman bu yerda
   * tekshirilMAYDI — ichki (nested) xato Nest'da `customer.` prefiksi bilan
   * inglizcha matn berardi («customer.district_id must be a string.
   * customer.district_id should not be empty. Buyurtma uchun tuman
   * tanlanmagan»). Majburiylik o'zgarmagan: buyurtma darajasidagi
   * `@IsOrderCreateDistrict` (`district_id`) inline mijoz tumansiz bo'lsa
   * BITTA o'zbekcha xabar beradi. Berilgan, lekin satr bo'lmagan qiymat —
   * avvalgidek `customer.district_id must be a string`.
   */
  @ApiProperty({ example: '12' })
  @ValidateIf((_, value: unknown) => isProvidedDistrictId(value))
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

  /**
   * (lQjt6sKP) ALMASHTIRISH (kafolat-swap): yangi buyurtma shu marketning
   * YETKAZILGAN (sold / paid / partly_paid) eski buyurtmasi o'rniga ketadi.
   * Eski buyurtma puli o'zgarmaydi; yangisini kuryer "eskisini oldim"
   * (`oldItemCollected: true`) tasdig'isiz sota olmaydi.
   */
  @ApiPropertyOptional({
    example: '1024',
    description:
      'Almashtiriladigan eski buyurtma ID si (GET /orders/replaceable). Faqat shu marketning yetkazilgan buyurtmasi; ' +
      'yangi (new), boshqa marketniki yoki allaqachon almashtirilgani — 400.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'number' ? String(value) : value))
  @IsString()
  @Matches(/^\d{1,18}$/, {
    message: "replaced_order_id buyurtma raqami (ID) bo'lishi kerak",
  })
  replaced_order_id?: string;

  /**
   * 6kHnNH9j — buyurtma manbasi tanlovi (ega qarori 4/5). `auto` (sukut) —
   * tuman filialida FAOL ombor bo'lsa va HAMMA mahsulot yetarli bo'lsa
   * ombordan (darhol viloyat filialida «qabul qilingan», band bilan), aks
   * holda butun buyurtma HQ'dan; `hq` — har doim HQ. Market — faqat
   * «Ombordan buyurtma yaratish» kaliti yoqilgan bo'lsa ombor.
   */
  @ApiPropertyOptional({
    enum: ORDER_FULFILLMENT_MODES,
    default: 'auto',
    description:
      "auto — ombor (hamma mahsulot yetarli bo'lsa) yoki HQ; hq — har doim HQ. Natija javobdagi `fulfillment_source` (HQ | WAREHOUSE).",
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(ORDER_FULFILLMENT_MODES as unknown as string[], {
    message: "fulfillment faqat 'auto' yoki 'hq' bo'lishi mumkin",
  })
  fulfillment?: OrderFulfillmentMode;

  @ApiPropertyOptional({
    example: '1',
    description:
      'Customer ID (as string/bigint). Superadmin/admin — istalgan mijoz. ' +
      'POST /orders da boshqa rollar (market, operator, filial xodimi) — GET /customers/suggest qoidasi (hiqRNhkI, WCuZzUCv): ' +
      "shu marketda buyurtmasi bor mijoz, yoki boshqa market mijozi — faqat `customer.phone_number` kartadagi telefonga TO'LIQ mos kelsa. " +
      "Tasdiqlanmagan id: `customer` obyekti bo'lsa u ishlatiladi (telefon bo'yicha), bo'lmasa 403. " +
      'POST /orders/external da faqat superadmin/admin (fix3 RBAC-01).',
  })
  @IsOptional()
  @IsString()
  customer_id?: string;

  @ApiPropertyOptional({ type: CreateOrderCustomerDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateOrderCustomerDto)
  customer?: CreateOrderCustomerDto;

  /**
   * txmkXVBa (ega qarori 2026-10-19 S5): «Mijoz kartasi ham yangilansinmi?»
   * dialogi javobi. Faqat POST /orders (qo'lda forma) va ai-confirm;
   * POST /orders/external, Telegram bot, hamkor — e'tiborsiz (avvalgi xulq).
   */
  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'txmkXVBa — POST /orders va ai-confirm: mavjud mijoz kartasi formadagi maydonlar bilan yangilansinmi. ' +
      '`true` — «Kartani ham yangilash»: buyurtma yaratilgach karta `customer` obyektidagi berilgan va farq qiladigan ' +
      "maydonlar (name, district_id, address, extra_number) bilan yangilanadi (customer_id yo'lida ham); market / market " +
      "operatori faqat o'z marketida buyurtmasi bor mijoz kartasini yangilay oladi (aks holda 403, buyurtma yaratilmaydi). " +
      "`false` / berilmasa — «Faqat shu buyurtmada»: karta O'ZGARMAYDI (telefon yo'lida ham), manzil, tuman va qo'shimcha " +
      "raqam faqat buyurtmaning o'z ustunlariga (`address`, `district_id`, `extra_number`) yoziladi. Javobda " +
      "`customer_card_updated` (boolean) va `customer_card_changed_fields` (string[]). POST /orders/external da e'tiborsiz.",
  })
  @IsOptional()
  @IsBoolean({ message: "update_customer_card true yoki false bo'lishi kerak" })
  update_customer_card?: boolean;

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

  @ApiPropertyOptional({
    example: 'Operator',
    description:
      "Bo'sh bo'lsa registrator / market operatori uchun server uning ismini yozadi (VRyloH62)",
  })
  @IsOptional()
  @IsString()
  operator?: string | null;

  /**
   * VRyloH62 — formadagi operator raqami. Server uni market sozlamasi
   * (`require_operator_phone`, `default_operator_phone`) bo'yicha 1- yoki
   * 2-raqam qiladi; bo'sh satr — yuborilmagan.
   */
  @ApiPropertyOptional({
    example: '+998901234567',
    description:
      "Formadagi operator raqami. Market `default_operator_phone` bo'lsa u 1-raqam, bu esa 2-raqam; " +
      "`require_operator_phone=true` va default yo'q bo'lsa MAJBURIY (yo'q → 400) va 1-raqam bo'ladi.",
  })
  @Transform(toOptionalCanonicalUzPhone)
  @IsOptional()
  @IsString()
  @Matches(UZ_PHONE_E164_RE, { message: UZ_PHONE_MESSAGE })
  operator_phone?: string | null;

  @ApiPropertyOptional({
    example: '+998901234568',
    description:
      '`operator_phone` sinonimi (BeePost bilan moslik) — `operator_phone` bo‘lmasa shu olinadi.',
  })
  @Transform(toOptionalCanonicalUzPhone)
  @IsOptional()
  @IsString()
  @Matches(UZ_PHONE_E164_RE, { message: UZ_PHONE_MESSAGE })
  secondary_operator_phone?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '1',
    description: 'Faqat superadmin/admin; boshqa rollarda e’tiborsiz',
  })
  @IsOptional()
  @IsString()
  post_id?: string | null;

  /**
   * IR2OHIiN: tumansiz buyurtma yaratilmaydi. Berilmasa — inline mijozning
   * `customer.district_id` si yoki mavjud mijozniki (`customer_id`) buyurtmaga
   * YOZILADI; uchalasi ham yo'q bo'lsa 400 «Buyurtma uchun tuman tanlanmagan».
   */
  @ApiPropertyOptional({
    type: String,
    example: '1',
    description:
      "Tuman ID. Berilmasa `customer.district_id` (yoki mavjud mijozning tumani) buyurtmaga yoziladi; hech qayerda bo'lmasa — 400 «Buyurtma uchun tuman tanlanmagan».",
  })
  @IsOrderCreateDistrict()
  district_id?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '1',
    description:
      'Viloyat ID. Berilmasa (yoki tuman mijozdan olinsa) tumandan aniqlanadi.',
  })
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

  /**
   * IDG1z5y9 + IR2OHIiN: MAJBURIY — kamida bitta mahsulot qatori. Ilgari
   * ixtiyoriy edi (faqat yuborilsa bo'sh bo'lmasligi tekshirilardi): `items`
   * siz so'rov mahsulotsiz buyurtma yaratardi.
   */
  @ApiProperty({
    type: [OrderItemDto],
    minItems: 1,
    description:
      "Kamida bitta mahsulot (miqdori ≥ 1, berilmasa 1). Yo'q yoki bo'sh — 400 «Buyurtmada kamida bitta mahsulot bo‘lishi kerak».",
  })
  // Massiv bo'lmagan qiymat (null, satr) — «yo'q» deb: bitta aniq xabar.
  @Transform(({ value }) => (Array.isArray(value) ? value : undefined))
  @IsOrderCreateItems()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];
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
   * T0UGh8bL — SOTUVDA MARKETGA TO'G'RIDAN-TO'G'RI BERILGAN NAQD.
   *
   * Ilgari (ZsPLevZZ (b)) faqat 0 qabul qilinardi: maydon buyurtmani
   * "to'landi" qilardi-yu, kassa/settlement oyog'i yozilmasdi. Endi (a) yo'l:
   * order-service shu sotuv tranzaksiyasida market kassasidan va sotuvchi
   * (kuryer / menejer sotuvida filial) kassasidan X ni yechadi, settlement
   * oyoqlarini ham X ga kamaytiradi — daftarlar ajralmaydi. Chegaralar va
   * holat (PAID / PARTLY_PAID) servisda tekshiriladi; bu yerda faqat shakl:
   * butun, manfiy bo'lmagan son (`paid_amount` ustuni `int`).
   */
  @ApiPropertyOptional({
    example: 0,
    minimum: 0,
    description:
      "Sotuvchi (kuryer / menejer) yig'ilgan naqddan marketga TO'G'RIDAN-TO'G'RI bergan summa (so'm, butun son). " +
      '0 yoki berilmasa — oddiy sotuv (SOLD). >0 bo`lsa market va sotuvchi kassasidan shu summa yechiladi; ' +
      "buyurtma bo'yicha marketga to'lanadigan summa to'liq yopilsa PAID, aks holda PARTLY_PAID. " +
      "Marketga to'lanadigan summadan (to_be_paid − extraCost) yoki market kassasidagi qarzdan oshsa 400; " +
      "hamkor (tashqi) buyurtmasida va HQ menejeri sotuvida >0 — 400 (to'lov /finance/cashbox/payment/market orqali).",
  })
  @IsOptional()
  @Transform(({ value }) => parseFormattedNumber(value))
  @IsInt({ message: "paidAmount butun son (so'm) bo'lishi kerak" })
  @Min(0, { message: "paidAmount manfiy bo'lishi mumkin emas" })
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

  /**
   * (lQjt6sKP) Almashtirish buyurtmasida kuryer eski mahsulotni mijozdan
   * olganini tasdiqlaydi. Almashtirish buyurtmasini usiz sotib bo'lmaydi (400).
   */
  @ApiPropertyOptional({
    example: true,
    description:
      'Almashtirish buyurtmasi uchun: kuryer eski mahsulotni mijozdan oldi ("Eskisini oldim"). ' +
      "Almashtirish buyurtmasida true bo'lmasa sotuv 400. Oddiy buyurtmada e'tiborsiz.",
  })
  @IsOptional()
  @Transform(parseBooleanFlag)
  @IsBoolean({ message: "oldItemCollected true/false bo'lishi kerak" })
  oldItemCollected?: boolean;
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
  @MaxLength(500)
  comment?: string;

  @ApiPropertyOptional({
    enum: ExtraCostRejectReason,
    example: ExtraCostRejectReason.TOO_EXPENSIVE,
    description:
      "(DuST9k8j) Faqat /reject uchun: rad etish sababi — YOPIQ ro'yxat (boshqa qiymat → 400).",
  })
  @IsOptional()
  @IsEnum(ExtraCostRejectReason)
  reason?: ExtraCostRejectReason;
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

  /**
   * (lQjt6sKP) Almashtirish buyurtmasida kuryer eski mahsulotni mijozdan
   * olganini tasdiqlaydi. Almashtirish buyurtmasini usiz sotib bo'lmaydi (400).
   */
  @ApiPropertyOptional({
    example: true,
    description:
      'Almashtirish buyurtmasi uchun: kuryer eski mahsulotni mijozdan oldi ("Eskisini oldim"). ' +
      "Almashtirish buyurtmasida true bo'lmasa sotuv 400. Oddiy buyurtmada e'tiborsiz.",
  })
  @IsOptional()
  @Transform(parseBooleanFlag)
  @IsBoolean({ message: "oldItemCollected true/false bo'lishi kerak" })
  oldItemCollected?: boolean;
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

  @ApiPropertyOptional({
    example: '10',
    description:
      "(1gxmqLj5) Faqat SUPERADMIN/ADMIN: tanlangan filial. Berilsa orderlar shu filialda bo'lishi kerak (aks holda 400). " +
      "Menejer/registrator uchun e'tiborsiz (doim o'z filiali).",
  })
  @IsOptional()
  @IsString()
  branch_id?: string;
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
    // y2RarzlT: «Bekor qilish» sotilgan holatlardan ham ishlaydi.
    description:
      "Rollback target status. Default: 'waiting'. 'cancelled' — " +
      'sold / paid / partly_paid / closed buyurtmani «Bekor qilingan» ga ' +
      "qaytaradi (sotuv kassa oyoqlari va foydasi 'waiting' dagidek teskari " +
      "yoziladi). 'cancelled_sent' — faqat kuryer.",
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

  // zfPNDCCr: POST /orders bilan AYNI qoida — kanonik +998XXXXXXXXX, aks holda 400.
  @ApiProperty({
    example: '+998901112233',
    description:
      "O'zbekiston raqami (+998XXXXXXXXX, 998..., 0..., 9 xona) — server " +
      '+998XXXXXXXXX ga keltiradi; boshqasi 400.',
  })
  @Transform(toCanonicalUzPhone)
  @IsNotEmpty()
  @IsString()
  @Matches(UZ_PHONE_E164_RE, { message: UZ_PHONE_MESSAGE })
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

  // IR2OHIiN: matn `POST /orders` bilan AYNI (`createOrderInternal` ham tekshiradi).
  @ApiProperty({ type: [OrderItemDto], minItems: 1 })
  @Transform(({ value }) => (Array.isArray(value) ? value : undefined))
  @IsOrderCreateItems()
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
 * positive, 2-dp money value.
 */
class SettlementAmountDto {
  @ApiProperty({ description: 'Amount to settle in som (>= 0.01, 2 dp)' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01) // (qGaxcaD4) Nol summali hisob-kitob yozuvi yaratilmasin.
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

/**
 * 1mOjtOVC — chek uchun market ma'lumoti (`order.market`, enriched javob).
 * Kuryer/logist uchun market tariflari olib tashlanadi. T7 (QPq2C1co):
 * menejer / filial / kuryerga telefon YO'Q.
 */
export class OrderReceiptMarketDto {
  @ApiProperty({ example: '37' })
  id!: string;

  @ApiProperty({ example: 'TEST Market', nullable: true, type: String })
  name!: string | null;

  @ApiPropertyOptional({
    example: '+998901234567',
    nullable: true,
    type: String,
    description:
      "Market telefoni. T7: menejer/filial/kuryerga YO'Q (SA/admin/registrator/logist/market — bor). Chekdagi «Muammo bo'lsa» manbasi EMAS — `problem_contacts`.",
  })
  phone_number?: string | null;
}

/**
 * 1mOjtOVC — buyurtma javobining CHEK uchun kerakli maydonlari (qisman sxema:
 * javobda boshqa maydonlar ham bor, ular o'zgarmagan). `GET /orders`
 * qatorlari va `GET /orders/:id`. Pul maydonlari — rol bo'yicha (kH2zZsz3 /
 * 4BftLLnc). T7 (QPq2C1co): operator telefonlari va `market.phone_number`
 * menejer / filial / kuryerga YO'Q; «Muammo bo'lsa» — `problem_contacts`
 * (har rolga).
 */
export class OrderReceiptFieldsDto {
  @ApiProperty({ example: '81' })
  id!: string;

  @ApiPropertyOptional({ example: 'EL-100081' })
  order_number?: string;

  @ApiProperty({ example: 'new', enum: Order_status })
  status!: Order_status;

  @ApiPropertyOptional({
    example: 'Operator Ali',
    nullable: true,
    type: String,
    description: 'Market operatori (matn)',
  })
  operator?: string | null;

  @ApiPropertyOptional({
    example: '+998901112233',
    nullable: true,
    type: String,
    description:
      "Operator telefoni. T7: menejer/filial/kuryerga YO'Q. Chekdagi «Muammo bo'lsa» manbasi EMAS — `problem_contacts`.",
  })
  operator_phone?: string | null;

  @ApiPropertyOptional({
    example: '+998904445566',
    nullable: true,
    type: String,
    description:
      "Operatorning qo'shimcha telefoni. T7: menejer/filial/kuryerga YO'Q.",
  })
  secondary_operator_phone?: string | null;

  @ApiPropertyOptional({
    type: [ProblemContactDto],
    description:
      "T7: «Muammo bo'lsa» — buyurtma viloyati logisti (`source: logist`), u yo'q/nofaol — zaxira raqamlar (`source: support`); ≤ 2, har rolga. `[]` — raqam yo'q (chekda qism chiqmaydi). Maydon umuman yo'q — aloqa xizmati javob bermadi.",
  })
  problem_contacts?: ProblemContactDto[];

  @ApiPropertyOptional({
    type: OrderReceiptMarketDto,
    nullable: true,
    description:
      'Enriched javobda (GET /orders, GET /orders/:id) — market nomi; telefoni faqat SA/admin/registrator/logist/market ga (T7).',
  })
  market?: OrderReceiptMarketDto | null;

  @ApiPropertyOptional({ example: '501', nullable: true, type: String })
  district_id?: string | null;

  @ApiPropertyOptional({ example: '5', nullable: true, type: String })
  region_id?: string | null;

  @ApiPropertyOptional({ example: 'center', enum: Where_deliver })
  where_deliver?: Where_deliver;

  @ApiPropertyOptional({
    example: 'ORD-6f1c2a',
    nullable: true,
    type: String,
    description: 'Chekdagi QR (buyurtma tokeni)',
  })
  qr_code_token?: string | null;

  @ApiPropertyOptional({ example: '2026-10-26T09:15:00.000Z' })
  createdAt?: string;
}

/** 1mOjtOVC — `GET /orders` sahifasi (qatorlar — `OrderReceiptFieldsDto`, qisman sxema). */
export class OrderListReceiptPageDto {
  @ApiProperty({ type: [OrderReceiptFieldsDto] })
  data!: OrderReceiptFieldsDto[];

  @ApiProperty({ example: 120 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 10 })
  limit!: number;

  @ApiPropertyOptional({ example: false })
  search_truncated?: boolean;
}
