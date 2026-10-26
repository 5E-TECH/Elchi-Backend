import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';

export class CreateDistrictRequestDto {
  @ApiProperty({ example: 'Yangi Namangan' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: '1' })
  @IsNotEmpty()
  @IsNumberString()
  region_id!: string;

  @ApiProperty({ example: '1712234', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  sato_code?: string;
}

export class UpdateDistrictRequestDto {
  @ApiProperty({ example: '1' })
  @IsNotEmpty()
  @IsNumberString()
  assigned_region!: string;
}

export class UpdateDistrictNameRequestDto {
  @ApiProperty({ example: 'Yangi Namangan' })
  @IsNotEmpty()
  @IsString()
  name!: string;
}

export class UpdateDistrictSatoCodeRequestDto {
  @ApiProperty({ example: '1712234' })
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d+$/)
  sato_code!: string;
}

/** oNAE3LW9 — tumanlarni birlashtirish: A dagi hamma narsa B ga ko'chadi. */
export class MergeDistrictRequestDto {
  @ApiProperty({
    example: '28',
    description: 'Qabul qiluvchi (qoladigan) tuman ID',
  })
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d+$/)
  target_district_id!: string;
}

/**
 * Is1zvHN7 — tumanga bog'langan TIRIK (o'chirilmagan) yozuvlar soni:
 * `GET /district/:id/usage` javobi va `DELETE /district/:id` 400 `data.usage`.
 */
export class DistrictUsageCountsDto {
  @ApiProperty({ example: 5 })
  orders!: number;

  @ApiProperty({ example: 1, description: 'Mijoz/kuryer/market' })
  users!: number;

  @ApiProperty({ example: 0 })
  branches!: number;
}

export class DistrictUsageResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'success' })
  message!: string;

  @ApiProperty({ type: DistrictUsageCountsDto })
  data!: DistrictUsageCountsDto;
}

/** AF0fvJbw — xato javobidagi ixtiyoriy `data` (faqat reason/usage/details). */
export class DistrictInUseErrorDataDto {
  @ApiProperty({
    example: 'district_in_use',
    description: 'Mashina kodi (matnni emas, shuni tekshiring)',
  })
  reason!: string;

  @ApiPropertyOptional({
    example: { orders: 5, users: 1, branches: 0, transfer_batches: 0 },
    description: "Bog'langan tirik yozuvlar soni ({ kalit: son })",
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  usage?: Record<string, number>;
}

/** AF0fvJbw — `DELETE /district/:id` 400: tuman ishlatilmoqda. */
export class DistrictInUseErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({
    example:
      "Bu tumanda 5 ta buyurtma, 1 ta foydalanuvchi (mijoz/kuryer/market) bor, shuning uchun uni o'chirib bo'lmaydi. Avval tumanlarni birlashtiring (bu tumanni boshqa tumanga qo'shing) yoki buyurtma va foydalanuvchilarni boshqa tumanga ko'chiring.",
  })
  message!: string;

  @ApiPropertyOptional({ type: DistrictInUseErrorDataDto })
  data?: DistrictInUseErrorDataDto;

  @ApiPropertyOptional({
    example: '7d0c2a4e-1b2f-4c3d-9e8f-0a1b2c3d4e5f',
    type: String,
  })
  trace_id?: string;
}

/** vsmpTweI — `POST /district/:id/merge` 200 javobi. */
export class DistrictMergeResultDto {
  @ApiProperty({ example: '173' })
  from_district_id!: string;

  @ApiProperty({ example: '28' })
  to_district_id!: string;

  @ApiProperty({
    type: DistrictUsageCountsDto,
    example: { orders: 130, users: 2, branches: 1 },
    description:
      "Ko'chirilgan JAMI (o'chirilganlar bilan) — tekshiruv shunga tayanadi",
  })
  moved!: DistrictUsageCountsDto;

  @ApiProperty({
    type: DistrictUsageCountsDto,
    example: { orders: 128, users: 2, branches: 1 },
    description:
      "vsmpTweI: ko'chirilganlardan faqat TIRIK (o'chirilmagan) lari — natija oynasidagi «Ko'chirildi» shu. Ko'chirish qadamining o'zi sanaydi (B oldin/keyin farqidan emas).",
  })
  moved_live!: DistrictUsageCountsDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      "B tumanning ko'chirishdan oldingi sanog'i (tirik + `deleted`)",
  })
  target_before!: Record<string, unknown>;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: "B tumanning keyingi sanog'i (tirik + `deleted`)",
  })
  target_after!: Record<string, unknown>;
}

export class DistrictMergeResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'District merged' })
  message!: string;

  @ApiProperty({ type: DistrictMergeResultDto })
  data!: DistrictMergeResultDto;
}

/** tf324cXN — birlashtirish tekshiruvidagi bitta nomuvofiqlik (JAMI: tirik + o'chirilgan). */
export class DistrictMergeMismatchDto {
  @ApiProperty({ enum: ['orders', 'users', 'branches'], example: 'orders' })
  kind!: 'orders' | 'users' | 'branches';

  @ApiProperty({
    enum: ['source', 'target'],
    example: 'target',
    description:
      "`source` — A (o'chiriladigan) tumanda qoldiq (kutilgan 0); `target` — B jami",
  })
  district!: 'source' | 'target';

  @ApiProperty({ example: 1254 })
  expected!: number;

  @ApiProperty({ example: 1255 })
  actual!: number;
}

/** tf324cXN — kompensatsiyadan keyin joyiga qaytmagan qatorlar (ID'larsiz; to'liq ro'yxat — activity log). */
export class DistrictMergeStrandedDto {
  @ApiProperty({ enum: ['orders', 'users', 'branches'], example: 'orders' })
  kind!: 'orders' | 'users' | 'branches';

  @ApiProperty({ example: '28', nullable: true, type: String })
  district_id!: string | null;

  @ApiProperty({
    example: 5,
    nullable: true,
    type: Number,
    description: "`null` — ID'lar noma'lum (javobi kelmagan bosqich)",
  })
  count!: number | null;
}

/** tf324cXN — `POST /district/:id/merge` xatosidagi `data.details`. */
export class DistrictMergeErrorDetailsDto {
  @ApiProperty({
    enum: [
      'count_mismatch',
      'remote_refused',
      'timeout',
      'invalid_response',
      'delete_failed',
    ],
    example: 'count_mismatch',
  })
  reason!: string;

  @ApiProperty({
    enum: ['orders', 'users', 'branches'],
    nullable: true,
    example: 'orders',
    description:
      'Qaysi qadam; `count_mismatch` da — birinchi nomuvofiqlik turi; `delete_failed` da `null`',
  })
  kind!: 'orders' | 'users' | 'branches' | null;

  @ApiPropertyOptional({
    example: 15000,
    description: 'Faqat `timeout` da — servis javobini kutish chegarasi (ms)',
  })
  timeout_ms?: number;

  @ApiPropertyOptional({
    type: [DistrictMergeMismatchDto],
    description: 'Faqat `count_mismatch` da',
  })
  mismatches?: DistrictMergeMismatchDto[];

  @ApiProperty({ example: '173' })
  from_district_id!: string;

  @ApiProperty({ example: '28' })
  to_district_id!: string;

  @ApiProperty({
    example: 128,
    description:
      "Z1c1sNPT: A tumanga QAYTARILGAN buyurtmalar soni (jami, o'chirilganlar bilan); boshlanmagan qadam — 0",
  })
  rolled_back_orders!: number;

  @ApiProperty({
    example: 2,
    description: 'Z1c1sNPT: A tumanga qaytarilgan foydalanuvchilar soni',
  })
  rolled_back_users!: number;

  @ApiProperty({
    example: 0,
    description: 'Z1c1sNPT: A tumanga qaytarilgan filiallar soni',
  })
  rolled_back_branches!: number;

  @ApiProperty({
    example: false,
    description:
      "`true` — kompensatsiya to'liq bo'lmadi, qo'lda tuzatish kerak (activity log: `district.merge_compensation_failed`)",
  })
  manual_fix!: boolean;

  @ApiPropertyOptional({
    type: [DistrictMergeStrandedDto],
    description: 'Faqat `manual_fix: true` da',
  })
  stranded?: DistrictMergeStrandedDto[];

  @ApiPropertyOptional({
    type: [String],
    example: ['7001', '7002'],
    description:
      "Z1c1sNPT: faqat `manual_fix: true` da — A ga QAYTMAGAN buyurtmalarning birinchi ≤10 ta ID'si (to'liq ro'yxat — activity log); ID'lar noma'lum bo'lsa yo'q",
  })
  stranded_order_ids?: string[];
}

export class DistrictMergeErrorDataDto {
  @ApiProperty({ example: 'count_mismatch' })
  reason!: string;

  @ApiProperty({ type: DistrictMergeErrorDetailsDto })
  details!: DistrictMergeErrorDetailsDto;
}

/** tf324cXN — `POST /district/:id/merge` 409/503: birlashtirish bekor qilindi. */
export class DistrictMergeErrorResponseDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({
    example:
      "Birlashtirish bekor qilindi: tekshiruv mos kelmadi — B tumandagi buyurtmalar soni 1255, kutilgan 1126 + 128 = 1254. Ko'chirilganlar A tumanga (#173) qaytarildi, tuman o'chirilmadi — qayta urinib ko'ring.",
  })
  message!: string;

  @ApiProperty({ type: DistrictMergeErrorDataDto })
  data!: DistrictMergeErrorDataDto;

  @ApiPropertyOptional({
    example: '7d0c2a4e-1b2f-4c3d-9e8f-0a1b2c3d4e5f',
    type: String,
  })
  trace_id?: string;
}

export class CreateRegionRequestDto {
  @ApiProperty({ example: 'Namangan' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: 'REG-05' })
  @IsNotEmpty()
  @IsString()
  sato_code!: string;
}

export class UpdateRegionRequestDto {
  @ApiProperty({ example: 'Namangan viloyati', required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ example: 'REG-05-NEW', required: false })
  @IsOptional()
  @IsString()
  sato_code?: string;
}

/**
 * (dzyVftBx) bigint id: raqam ham (42), satr ham ('42') qabul qilinadi va
 * satrga keltiriladi. Musbat butun son, ko'pi bilan 19 xona.
 */
const BIGINT_ID_PATTERN = /^\d{1,19}$/;
const idToString = (value: unknown): unknown => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return typeof value === 'string' ? value.trim() : value;
};

/** (dzyVftBx) PATCH /region/:id/logist */
export class AssignRegionLogistRequestDto {
  @ApiProperty({
    example: '42',
    type: String,
    nullable: true,
    description:
      "LOGIST rolidagi faol foydalanuvchi id'si. `null` — viloyatdan logistni olib tashlash. Maydon MAJBURIY (yo'q bo'lsa 400).",
  })
  @Transform(({ value }: { value: unknown }) => idToString(value))
  @ValidateIf((_dto: unknown, value: unknown) => value !== null)
  @Matches(BIGINT_ID_PATTERN, {
    message: "logist_id musbat butun son (id) yoki null bo'lishi kerak",
  })
  logist_id!: string | null;
}

/** (dzyVftBx) POST /region/logist/bulk */
export class BulkAssignRegionLogistRequestDto {
  @ApiProperty({
    example: '42',
    type: String,
    nullable: true,
    description:
      "LOGIST id'si: `region_ids` dagi viloyatlar unga o'tadi, uning boshqa viloyatlaridan u olib tashlanadi (`region_ids: []` — hammasidan). `null` — faqat `region_ids` dagi viloyatlardan logist olinadi.",
  })
  @Transform(({ value }: { value: unknown }) => idToString(value))
  @ValidateIf((_dto: unknown, value: unknown) => value !== null)
  @Matches(BIGINT_ID_PATTERN, {
    message: "logist_id musbat butun son (id) yoki null bo'lishi kerak",
  })
  logist_id!: string | null;

  @ApiProperty({ example: ['1', '5', '9'], type: [String] })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? value.map(idToString) : value,
  )
  @IsArray()
  @ArrayMaxSize(200)
  @Matches(BIGINT_ID_PATTERN, {
    each: true,
    message: "region_ids faqat viloyat id'laridan iborat bo'lishi kerak",
  })
  region_ids!: string[];
}

/** kA70Rban + tveJKICY — `GET /post`, `/post/courier/old-posts` sahifasi. */
export class PostListPageDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  data!: Record<string, unknown>[];

  @ApiProperty({ example: 59, description: 'Filtr bo‘yicha jami pochtalar' })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 8 })
  totalPages!: number;

  @ApiProperty({ example: 8 })
  limit!: number;

  @ApiProperty({ example: false })
  limit_capped!: boolean;

  @ApiProperty({ example: 100 })
  max_limit!: number;

  @ApiProperty({
    example: 412,
    description:
      'tveJKICY: joriy filtr bo‘yicha (barcha sahifalar) pochtalardagi buyurtmalar jami (`order_quantity` yig‘indisi)',
  })
  orders_total!: number;

  @ApiProperty({
    example: 61800000,
    description:
      'tveJKICY: joriy filtr bo‘yicha (barcha sahifalar) pochta summalari jami (`post_total_price`), so‘m',
  })
  amount_total!: number;
}

export class PostListPageResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'All posts (paginated)' })
  message!: string;

  @ApiProperty({ type: PostListPageDto })
  data!: PostListPageDto;
}

/** 1mOjtOVC — pochta kuryeri (pochta chekidagi «haydovchi»). */
export class PostCourierRefDto {
  @ApiProperty({ example: '26' })
  id!: string;

  @ApiProperty({ example: 'TEST Kuryer', nullable: true, type: String })
  name!: string | null;

  @ApiProperty({ example: '+998901234567', nullable: true, type: String })
  phone_number!: string | null;
}

/**
 * 1mOjtOVC — `GET /post/:id` pochta cheki maydonlari (javob o'zgarmagan,
 * faqat `courier` QO'SHILDI).
 */
export class PostReceiptDto {
  @ApiProperty({ example: '11' })
  id!: string;

  @ApiProperty({
    example: '26',
    description: "Kuryer id; '0' — filial/hudud pochtasi (kuryersiz)",
  })
  courier_id!: string;

  @ApiProperty({
    type: PostCourierRefDto,
    nullable: true,
    description:
      '1mOjtOVC: haydovchi = pochta kuryeri `{ id, name, phone_number }`; kuryersiz pochta yoki identity javob bermasa — null',
  })
  courier!: PostCourierRefDto | null;

  @ApiPropertyOptional({
    example: 1250000,
    description: "Jami summa. LOGIST javobida YO'Q (Z3pUOxou)",
  })
  post_total_price?: number;

  @ApiProperty({ example: 12, description: 'Buyurtmalar soni' })
  order_quantity!: number;

  @ApiProperty({ example: 'PST-4KD9', nullable: true, type: String })
  qr_code_token!: string | null;

  @ApiProperty({ example: '5', nullable: true, type: String })
  region_id!: string | null;

  @ApiProperty({ example: '7', nullable: true, type: String })
  branch_id!: string | null;

  @ApiProperty({ example: 'sent' })
  status!: string;

  @ApiProperty({ example: '2026-10-26T09:15:00.000Z' })
  createdAt!: string;
}

export class PostReceiptResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'Post found' })
  message!: string;

  @ApiProperty({ type: PostReceiptDto })
  data!: PostReceiptDto;
}

export class CreatePostRequestDto {
  @ApiProperty({ example: '1' })
  @IsNotEmpty()
  @IsNumberString()
  courier_id!: string;

  @ApiProperty({ example: 'QR123TOKEN456', required: false })
  @IsOptional()
  @IsString()
  qr_code_token?: string;

  @ApiProperty({ example: ['1', '2'], required: false, type: [String] })
  @IsOptional()
  @IsString({ each: true })
  orderIDs?: string[];
}

export class SendPostRequestDto {
  @ApiProperty({ type: [String], example: ['1', '2'] })
  @IsNotEmpty()
  @IsString({ each: true })
  orderIds!: string[];

  @ApiProperty({ example: '1' })
  @IsNotEmpty()
  @IsNumberString()
  courierId!: string;

  @ApiProperty({ example: "Post jo'natildi", required: false })
  @IsOptional()
  @IsString()
  description?: string;
}

export class ReassignPostRequestDto {
  @ApiProperty({ example: '1' })
  @IsNotEmpty()
  @IsNumberString()
  courierId!: string;
}

export class ReceivePostRequestDto {
  @ApiProperty({ type: [String], example: ['1', '2'] })
  @IsNotEmpty()
  @IsString({ each: true })
  order_ids!: string[];
}

export class ReturnRequestsActionRequestDto {
  @ApiProperty({ type: [String], example: ['1', '2'] })
  @IsNotEmpty()
  @IsString({ each: true })
  order_ids!: string[];
}

export class PostIdRequestDto {
  @ApiProperty({ example: '1' })
  @IsNotEmpty()
  @IsNumberString()
  postId!: string;
}

/** Musbat butun son (bigint) satri — "0", "-1", "1.5", "abc" rad etiladi. */
const POSITIVE_ID_STRING = /^[1-9]\d{0,18}$/;

/** JSON son kelsa satrga keltiriladi (`7` → `"7"`), qolgani o'zgarmaydi. */
const toIdString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : value;

/**
 * yokjwjXG — `POST /post/delete` (faqat superadmin): buyurtmalarni SHU
 * pochtadan o'chirish. Bekor qilish (`POST /post/cancel`) EMAS — buyurtma
 * tizimdan butunlay (soft-delete) o'chiriladi.
 */
export class DeletePostOrdersRequestDto {
  @ApiProperty({
    example: '88',
    description: "Pochta id'si (faqat `status = new` pochta)",
  })
  @Transform(toIdString)
  @IsString()
  @Matches(POSITIVE_ID_STRING, {
    message: "post_id musbat butun son bo'lishi kerak",
  })
  post_id!: string;

  @ApiProperty({
    type: [String],
    example: ['700', '701'],
    description:
      "O'chiriladigan buyurtmalar (1–100, takrorsiz). Hammasi-yoki-hech biri",
  })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((item: unknown) => toIdString({ value: item }))
      : value,
  )
  @IsArray()
  @ArrayMinSize(1, { message: "order_ids bo'sh bo'lmasligi kerak" })
  @ArrayMaxSize(100, {
    message: "Bir so'rovda ko'pi bilan 100 ta buyurtma o'chiriladi",
  })
  @ArrayUnique({ message: 'order_ids takrorlanmasligi kerak' })
  @IsString({ each: true })
  @Matches(POSITIVE_ID_STRING, {
    each: true,
    message: "order_ids ichida faqat musbat butun son bo'ladi",
  })
  order_ids!: string[];

  @ApiProperty({
    example: "Market buyurtmani qaytarib oldi, posilka jo'natilmaydi",
    minLength: 3,
    maxLength: 500,
    description: "O'chirish sababi (jurnalga yoziladi)",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(3, 500, { message: "Sabab 3–500 belgi bo'lishi kerak" })
  reason!: string;
}
