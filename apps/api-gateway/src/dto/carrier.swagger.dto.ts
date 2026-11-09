import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  CancelReason,
  IP_ALLOWLIST_MAX_ENTRIES,
  Order_status,
} from '@app/common';

/**
 * Carrier API DTO'lari — tashqi yetkazuvchi kompaniya (`/carrier/*`) va
 * ularni boshqaruvchi admin (`/admin/carriers`).
 *
 * ⚠️ Maydon nomlari `docs/public/CARRIER_API.md` bilan kontrakt testida
 * (`carrier-api-docs-contract.spec.ts`) solishtiriladi — DTO o'zgarsa hujjat
 * ham o'zgarishi shart.
 *
 * Gateway `whitelist + forbidNonWhitelisted` (`main.ts`): ro'yxatda yo'q
 * maydon (masalan `extraCost`, `paidAmount`) → 400. Carrier API v1 da
 * qo'shimcha xarajat va marketga to'g'ridan-to'g'ri to'lov YO'Q — bu
 * ATAYLAB: qo'shimcha xarajat market tasdig'ini (202, kutish) talab qilishi
 * mumkin, tashqi tizim esa bunday kutish holatini ko'tarmaydi.
 */

/** multipart/form-data da raqam satr bo'lib keladi. */
const toNumber = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : value;
  }
  return value;
};

/** multipart/form-data da massiv JSON satr bo'lib keladi. */
const toJsonArray = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
};

/** "true"/"1" — true, "false"/"0" — false (multipart). */
const toBooleanFlag = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return value;
};

/** Postgres BIGINT id (yetakchi nolsiz). */
const BIGINT_ID_RE = /^[1-9]\d{0,18}$/;
/** Faqat sana (Toshkent kuni). */
const DATE_ONLY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const IP_ALLOWLIST_DOC =
  'Ruxsat etilgan manzillar: IPv4 (203.0.113.10), IPv4 diapazon (203.0.113.0/24) yoki ' +
  'IPv6 manzil (2001:db8::1). IPv6 diapazon qo‘llab-quvvatlanmaydi. Tushunilmagan yozuv — 400.';

// ===== Admin: /admin/carriers =====

export class CreateCarrierAccountRequestDto {
  @ApiProperty({ example: 'BTS Express' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    example: '55',
    description:
      'Bog‘lanadigan KURIER user id (POST /couriers bilan oldindan ochilgan, faol). ' +
      'Barcha Carrier API amallari shu kurier nomidan bajariladi; bitta kurier — bitta carrier.',
  })
  @IsString()
  @Matches(BIGINT_ID_RE, {
    message: 'courier_id musbat butun son (kurier user id) bo‘lishi kerak',
  })
  courier_id!: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['203.0.113.10', '203.0.113.0/24', '2001:db8::1'],
    description: IP_ALLOWLIST_DOC,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(IP_ALLOWLIST_MAX_ENTRIES)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  ip_allowlist?: string[];
}

export class UpdateCarrierAccountRequestDto {
  @ApiPropertyOptional({ example: 'BTS Express' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['203.0.113.10'],
    description: `${IP_ALLOWLIST_DOC} Bo‘sh massiv — IP cheklovi olib tashlanadi.`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(IP_ALLOWLIST_MAX_ENTRIES)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  ip_allowlist?: string[];
}

export class SetCarrierActiveRequestDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  is_active!: boolean;
}

// ===== Tashqi kompaniya: /carrier/* =====

export class CarrierScanRequestDto {
  @ApiProperty({
    example: 'a1b2c3d4e5',
    description:
      'Posilka yorlig‘idagi QR qiymati (buyurtmaning qr_code_token).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  qr_token!: string;
}

export enum CarrierOrderStatus {
  SOLD = 'sold',
  PARTLY_SOLD = 'partly_sold',
  CANCELLED = 'cancelled',
  ROLLBACK = 'rollback',
}

export class CarrierPartlySoldItemDto {
  @ApiPropertyOptional({
    example: '5501',
    description:
      'Buyurtma qatori id (scan javobidagi items[].id). Tavsiya etiladi.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  order_item_id?: string;

  @ApiPropertyOptional({
    type: String,
    example: '1',
    nullable: true,
    description: 'Katalog mahsuloti id — order_item_id berilmasa majburiy.',
  })
  @ValidateIf((item: CarrierPartlySoldItemDto) => !item.order_item_id)
  @IsString()
  @IsNotEmpty()
  product_id?: string | null;

  @ApiProperty({
    type: 'integer',
    example: 1,
    minimum: 0,
    description: 'SOTILGAN dona soni (0 — bu qatordan hech narsa sotilmadi).',
  })
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  quantity!: number;
}

export class CarrierOrderStatusRequestDto {
  @ApiProperty({
    enum: CarrierOrderStatus,
    example: CarrierOrderStatus.SOLD,
    description:
      '`sold` — to‘liq sotildi; `partly_sold` — qisman (items + total_price majburiy); ' +
      '`cancelled` — bekor (reason majburiy); `rollback` — xato belgilangan sotuv/bekorni ' +
      'qaytarish (shu buyurtma hisob-kitobi hali yopilmagan bo‘lsa).',
  })
  @IsEnum(CarrierOrderStatus)
  status!: CarrierOrderStatus;

  @ApiPropertyOptional({ example: 'Mijoz qabul qildi', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  @ApiPropertyOptional({
    enum: CancelReason,
    example: CancelReason.CUSTOMER_REFUSED,
    description:
      '`cancelled` uchun majburiy. `OTHER` bo‘lsa comment ham majburiy.',
  })
  @ValidateIf(
    (dto: CarrierOrderStatusRequestDto) =>
      dto.status === CarrierOrderStatus.CANCELLED,
  )
  @IsEnum(CancelReason)
  reason?: CancelReason;

  @ApiPropertyOptional({
    example: 150000,
    minimum: 0,
    description:
      '`partly_sold` uchun majburiy: mijoz OLGAN tovarlarning to‘liq qiymati (so‘m), ' +
      'oldindan onlayn to‘langan qism (paid_online_amount) HAM shu ichida. Buyurtma ' +
      'summasidan oshmaydi. Siz yig‘adigan naqd = max(total_price − paid_online_amount, 0).',
  })
  @ValidateIf(
    (dto: CarrierOrderStatusRequestDto) =>
      dto.status === CarrierOrderStatus.PARTLY_SOLD,
  )
  @Transform(toNumber)
  @IsNumber()
  @Min(0)
  total_price?: number;

  @ApiPropertyOptional({
    type: [CarrierPartlySoldItemDto],
    description:
      '`partly_sold` uchun majburiy: buyurtmaning HAR BIR qatori va undan sotilgan dona soni.',
  })
  @ValidateIf(
    (dto: CarrierOrderStatusRequestDto) =>
      dto.status === CarrierOrderStatus.PARTLY_SOLD,
  )
  /**
   * ⚠️ class-transformer `@Type` ni `@Transform` dan OLDIN qo'llaydi: multipart
   * JSON satri `@Type` dan satr bo'lib o'tadi va `@Transform` dan keyin oddiy
   * obyektlar qoladi — ichki validatsiya va `quantity` ning raqamga
   * aylanishi ishlamasdi. Shu bois klass nusxasi shu yerda yaratiladi.
   */
  @Transform(({ value }: { value: unknown }) => {
    /**
     * Multipart'da `items` uch xil keladi: bitta JSON-massiv satri,
     * takroriy qismlar (har biri JSON-obyekt satri — Swagger UI va OpenAPI
     * generatorlari shunday yuboradi) yoki bitta obyekt. Hammasi massivga.
     */
    const asItem = (v: unknown): unknown => {
      if (typeof v !== 'string') return v;
      try {
        return JSON.parse(v.trim()) as unknown;
      } catch {
        return v;
      }
    };
    let parsed = toJsonArray({ value });
    if (Array.isArray(parsed)) {
      parsed = parsed.flatMap((v: unknown) => {
        const item = asItem(v);
        return Array.isArray(item) ? (item as unknown[]) : [item];
      });
    } else if (typeof parsed === 'string') {
      const item = asItem(parsed);
      parsed =
        item && typeof item === 'object' && !Array.isArray(item)
          ? [item]
          : item;
    } else if (parsed && typeof parsed === 'object') {
      parsed = [parsed];
    }
    return Array.isArray(parsed)
      ? parsed.map((item: unknown) =>
          item instanceof CarrierPartlySoldItemDto ||
          !item ||
          typeof item !== 'object'
            ? item
            : plainToInstance(CarrierPartlySoldItemDto, item),
        )
      : parsed;
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CarrierPartlySoldItemDto)
  items?: CarrierPartlySoldItemDto[];

  @ApiPropertyOptional({
    example: true,
    description:
      'Almashtirish buyurtmasi: eski mahsulot mijozdan olindi. Almashtirish buyurtmasini sotishda majburiy true.',
  })
  @IsOptional()
  @Transform(toBooleanFlag)
  @IsBoolean()
  old_item_collected?: boolean;
}

const CARRIER_LIST_STATUSES = Object.values(Order_status) as string[];

export class CarrierOrderListQueryDto {
  @ApiPropertyOptional({
    example: 'waiting,sold',
    description: `Vergul bilan ajratilgan holatlar: ${CARRIER_LIST_STATUSES.join(', ')}.`,
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description:
      'Boshlanish kuni (YYYY-MM-DD, Toshkent vaqti, kun kiradi). Filtr BUYURTMA ' +
      'YARATILGAN sana bo‘yicha (biriktirilgan yoki sotilgan sana emas).',
  })
  @IsOptional()
  @Matches(DATE_ONLY_RE, { message: 'from YYYY-MM-DD bo‘lishi kerak' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-10',
    description:
      'Tugash kuni (YYYY-MM-DD, Toshkent vaqti, kun kiradi) — buyurtma yaratilgan sana.',
  })
  @IsOptional()
  @Matches(DATE_ONLY_RE, { message: 'to YYYY-MM-DD bo‘lishi kerak' })
  to?: string;

  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 50, enum: [10, 25, 50, 100] })
  @IsOptional()
  @Transform(toNumber)
  @IsIn([10, 25, 50, 100])
  limit?: number;
}

export class CarrierCashboxQueryDto {
  @ApiPropertyOptional({
    example: '2026-11-01',
    description:
      'Tarix boshi (YYYY-MM-DD, Toshkent kuni). Berilmasa — `to` dan 29 kun oldin ' +
      '(ya’ni oxirgi 30 kun). Oraliq 92 kundan oshmaydi. Balansga ta’sir qilmaydi.',
  })
  @IsOptional()
  @Matches(DATE_ONLY_RE, { message: 'from YYYY-MM-DD bo‘lishi kerak' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-10',
    description: 'Tarix oxiri (YYYY-MM-DD, Toshkent kuni). Berilmasa — bugun.',
  })
  @IsOptional()
  @Matches(DATE_ONLY_RE, { message: 'to YYYY-MM-DD bo‘lishi kerak' })
  to?: string;
}

export class CarrierReturnRequestDto {
  @ApiProperty({
    type: [String],
    example: ['901', '905'],
    description:
      'Elchi filialiga qaytariladigan BEKOR QILINGAN posilkalar id’lari (sizda turgan, ' +
      'holati `cancelled`; qisman sotuvdan ajralgan qism ham). 1–50 ta.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(BIGINT_ID_RE, {
    each: true,
    message: 'order_ids — buyurtma id’lari',
  })
  order_ids!: string[];
}

/** Ichki: status listi uchun ruxsat etilgan qiymatlar. */
export const CARRIER_ORDER_LIST_STATUSES: readonly string[] =
  CARRIER_LIST_STATUSES;

// ===== Javob sxemalari (faqat Swagger hujjati uchun) =====
//
// ⚠️ Maydonlar `toCarrierOrderView` / `toCarrierCashboxView` bilan kontrakt
// testida solishtiriladi (`carrier-api-docs-contract.spec.ts`).

/** Viloyat / tuman — nom EMAS, rasmiy SOATO kodi (`toCarrierOrderView` → `geoRef`). */
export class CarrierGeoRefDto {
  @ApiProperty({ example: '2', description: 'Elchi ichki id' })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1726294',
    description:
      'Rasmiy SOATO kodi (viloyat — 4 xona, tuman — 7 xona). null — bu hudud uchun kod ' +
      'Elchi’da yo‘q (id dan foydalaning).',
  })
  soato_code!: string | null;
}

export class CarrierReplacementDto {
  @ApiProperty({
    example: '880',
    description: 'Qaysi buyurtma o‘rniga (eski buyurtma id)',
  })
  of_order_id!: string;

  @ApiProperty({
    example: true,
    description:
      'true — sotishda old_item_collected: true SHART (eski mahsulotni oling)',
  })
  old_item_required!: boolean;
}

export class CarrierRefDto {
  @ApiProperty({ example: '7' })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Chilonzor' })
  name!: string | null;
}

export class CarrierCustomerDto {
  @ApiProperty({ type: String, nullable: true, example: 'Ali Valiyev' })
  name!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '+998901112233' })
  phone_number!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  extra_number!: string | null;
}

export class CarrierOrderItemDto {
  @ApiProperty({
    example: '5501',
    description: 'Qator id — partly_sold da items[].order_item_id',
  })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: '1' })
  product_id!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Kurtka' })
  name!: string | null;

  @ApiProperty({ example: 2 })
  quantity!: number;
}

export class CarrierOrderDto {
  @ApiProperty({
    example: '900',
    description: 'POST /carrier/orders/{id}/status uchun',
  })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: 'E-900' })
  order_number!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'a1b2c3d4e5' })
  qr_token!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Qisman sotuvdan ajralgan sotilmagan qism bo‘lsa — asl buyurtma',
  })
  parent_order_id!: string | null;

  @ApiProperty({ example: 'waiting', description: 'Elchi’dagi holat' })
  status!: string;

  @ApiProperty({ example: 200000, description: 'Buyurtma summasi, so‘m' })
  total_price!: number;

  @ApiProperty({ example: 50000, description: 'Oldindan onlayn to‘langan' })
  paid_online_amount!: number;

  @ApiProperty({
    example: 150000,
    description:
      'Mijozdan NAQD olinadigan summa = total_price − paid_online_amount',
  })
  cod_amount!: number;

  @ApiProperty({ type: String, nullable: true, example: 'address' })
  where_deliver!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Chilonzor 5, 12-uy' })
  address!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  comment!: string | null;

  @ApiProperty({ type: CarrierCustomerDto, nullable: true })
  customer!: CarrierCustomerDto | null;

  @ApiProperty({
    type: CarrierGeoRefDto,
    nullable: true,
    description: 'Viloyat — SOATO kodi bilan (nom yuborilmaydi)',
  })
  region!: CarrierGeoRefDto | null;

  @ApiProperty({
    type: CarrierGeoRefDto,
    nullable: true,
    description: 'Tuman — SOATO kodi bilan (nom yuborilmaydi)',
  })
  district!: CarrierGeoRefDto | null;

  @ApiProperty({
    type: CarrierRefDto,
    nullable: true,
    description: 'Sotuvchi',
  })
  market!: CarrierRefDto | null;

  @ApiProperty({
    type: () => CarrierReplacementDto,
    nullable: true,
    description:
      'Almashtirish buyurtmasi bo‘lsa — eski mahsulot mijozdan olinishi kerak; aks holda null',
  })
  replacement!: CarrierReplacementDto | null;

  @ApiProperty({ type: [CarrierOrderItemDto] })
  items!: CarrierOrderItemDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-11-09T10:00:00.000Z',
  })
  created_at!: string | null;
}

class CarrierEnvelopeDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'ok' })
  message!: string;
}

export class CarrierPingCarrierDto {
  @ApiProperty({ example: '3' })
  id!: string;

  @ApiProperty({ example: 'BTS Express' })
  name!: string;
}

export class CarrierPingDataDto {
  @ApiProperty({ example: true })
  authenticated!: boolean;

  @ApiProperty({ type: CarrierPingCarrierDto })
  carrier!: CarrierPingCarrierDto;
}

export class CarrierPingResponseDto extends CarrierEnvelopeDto {
  @ApiProperty({ type: CarrierPingDataDto })
  data!: CarrierPingDataDto;
}

export class CarrierScanDataDto {
  @ApiProperty({
    example: true,
    description: 'true — posilka shu skanda sizga qabul qilindi (waiting)',
  })
  received!: boolean;

  @ApiProperty({
    type: CarrierOrderDto,
    nullable: true,
    description:
      'Buyurtma. null (refreshed: false) — posilka QABUL QILINDI, lekin ma’lumotni hozir ' +
      'o‘qib bo‘lmadi: keyinroq qayta skanerlang (received: false bilan keladi — bu normal).',
  })
  order!: CarrierOrderDto | null;

  @ApiProperty({ example: true })
  refreshed!: boolean;
}

export class CarrierScanResponseDto extends CarrierEnvelopeDto {
  @ApiProperty({ type: CarrierScanDataDto })
  data!: CarrierScanDataDto;
}

export class CarrierStatusDataDto {
  @ApiProperty({
    type: CarrierOrderDto,
    nullable: true,
    description:
      'Yangilangan buyurtma. null — holat QABUL QILINDI, lekin yangilangan buyurtmani hozir ' +
      'o‘qib bo‘lmadi (refreshed: false): GET /carrier/orders bilan keyinroq oling, QAYTA YUBORMANG.',
  })
  order!: CarrierOrderDto | null;

  @ApiProperty({ example: true })
  refreshed!: boolean;
}

export class CarrierReturnDataDto {
  @ApiProperty({
    example: '77',
    description:
      'Qaytarish pochtasi id — posilkalarni Elchi filialiga shu bilan topshirasiz',
  })
  post_id!: string;

  @ApiProperty({ type: [String], example: ['901', '905'] })
  order_ids!: string[];
}

export class CarrierReturnResponseDto extends CarrierEnvelopeDto {
  @ApiProperty({ type: CarrierReturnDataDto })
  data!: CarrierReturnDataDto;
}

export class CarrierStatusResponseDto extends CarrierEnvelopeDto {
  @ApiProperty({ type: CarrierStatusDataDto })
  data!: CarrierStatusDataDto;
}

export class CarrierOrderListDataDto {
  @ApiProperty({ type: [CarrierOrderDto] })
  items!: CarrierOrderDto[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 50 })
  limit!: number;
}

export class CarrierOrderListResponseDto extends CarrierEnvelopeDto {
  @ApiProperty({ type: CarrierOrderListDataDto })
  data!: CarrierOrderListDataDto;
}

export class CarrierCashboxEntryDto {
  @ApiProperty({ example: '7001' })
  id!: string;

  @ApiProperty({
    enum: ['income', 'expense'],
    example: 'income',
    description: 'income — kirim, expense — chiqim',
  })
  type!: string;

  @ApiProperty({
    example: 'sell',
    description:
      'Manba: sell — sotuv, cancel — bekor, correction — tuzatish (rollback), ' +
      'courier_payment — Elchi’ga topshirilgan naqd, extra_cost, payment_reversal — to‘lov ' +
      'tuzatishi. Ro‘yxat OCHIQ — yangi qiymat paydo bo‘lishi mumkin.',
  })
  source_type!: string;

  @ApiProperty({
    example: 125000,
    description:
      'Doim musbat; yo‘nalish `type` da. `sell` qatori ham `expense` bo‘lishi mumkin ' +
      '(oldindan to‘langan buyurtma — Elchi sizga qarzdor).',
  })
  amount!: number;

  @ApiProperty({
    example: 125000,
    description: 'Shu harakatdan keyingi balans',
  })
  balance_after!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '900',
    description: 'Buyurtma bilan bog‘liq qatorda — buyurtma id',
  })
  order_id!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'cash' })
  payment_method!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  comment!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-11-09T12:30:00.000Z',
  })
  created_at!: string | null;
}

export class CarrierCashboxDataDto {
  @ApiProperty({
    example: '2026-10-12',
    description: 'Tarix oynasi boshi (Toshkent kuni)',
  })
  from!: string;

  @ApiProperty({
    example: '2026-11-10',
    description: 'Tarix oynasi oxiri (Toshkent kuni)',
  })
  to!: string;

  @ApiProperty({
    example: 125000,
    description: 'Joriy balans — Elchi’ga topshirilishi kerak bo‘lgan summa',
  })
  balance!: number;

  @ApiProperty({ example: 125000, description: 'Davrdagi jami kirim' })
  income!: number;

  @ApiProperty({ example: 0, description: 'Davrdagi jami chiqim' })
  outcome!: number;

  @ApiProperty({ type: [CarrierCashboxEntryDto] })
  history!: CarrierCashboxEntryDto[];
}

export class CarrierCashboxResponseDto extends CarrierEnvelopeDto {
  @ApiProperty({ type: CarrierCashboxDataDto })
  data!: CarrierCashboxDataDto;
}

export class CarrierErrorResponseDto {
  @ApiProperty({ example: 404 })
  statusCode!: number;

  @ApiProperty({ example: 'Buyurtma topilmadi yoki sizga biriktirilmagan' })
  message!: string;

  @ApiPropertyOptional({
    type: String,
    example: 'CARRIER_IDEMPOTENCY_KEY_STALE',
    description:
      'Mashina o‘qiydigan kod (bo‘lsa): CARRIER_IDEMPOTENCY_KEY_REQUIRED (400), ' +
      'CARRIER_COURIER_INACTIVE (403), CARRIER_IDEMPOTENCY_KEY_STALE (409 — yangi kalit), ' +
      'IDEMPOTENCY_IN_PROGRESS (409 — ayni kalit bilan kutib), IDEMPOTENCY_KEY_MISMATCH (422), ' +
      'CARRIER_KEY_CHECK_UNAVAILABLE / CARRIER_TEMPORARILY_UNAVAILABLE (503 — ayni kalit bilan). ' +
      'Qarorni matnga emas, statusCode + code ga qarab qiling.',
  })
  code?: string;

  @ApiPropertyOptional({
    example: 'eaff465b-4c89-4721-b7c8-30cf22fb403e',
    description: 'Muammo bo‘lganda Elchi jamoasiga yuboring',
  })
  trace_id?: string;
}
