import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BranchOwnership, BranchType } from '@app/common';
import {
  IsArray,
  IsEnum,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { BranchUserRole } from '@app/common';

// EiZj47Gc: forma (PICKUP va h.k.) bo'sh ota filialni `parent_id: ''` qilib
// yuboradi. @IsOptional faqat null/undefined ni o'tkazadi, shuning uchun ''
// tushunarsiz "parent_id must be a number string" 400 berardi. Bo'sh satr /
// null → undefined: so'rov branch-service qoidasiga yetib boradi va HQ'dan
// boshqa tur uchun aniq "ota filial (parent_id) majburiy" xabari qaytadi.
const emptyToUndefined = ({ value }: { value: unknown }) =>
  value === '' || value === null ? undefined : value;

// 8jtzNlFt: hamkor filial ulushi son (5000) yoki satr ('5000.50') bo'lib
// kelishi mumkin — ikkalasi satrga keltiriladi va bir xil tekshiriladi:
// manfiy emas, ko'pi bilan 2 kasr, ustun numeric(14,2) ga sig'adi.
const moneyToString = ({ value }: { value: unknown }) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
const PER_ORDER_SHARE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const PER_ORDER_SHARE_MESSAGE =
  "per_order_share — 0 yoki musbat summa (so'm, ko'pi bilan 2 kasr xona)";
const OWNERSHIP_DESCRIPTION =
  "Filial turi (8jtzNlFt): 'owned' — o'zimizniki (standart, filial hamma " +
  "pulni HQ'ga topshiradi), 'partner' — hamkor (har sotilgan buyurtmadan " +
  "per_order_share ni o'zida olib qoladi). HQ faqat 'owned'.";
const PER_ORDER_SHARE_DESCRIPTION =
  "Hamkor filial har sotilgan buyurtmadan olib qoladigan summa (so'm). " +
  "Faqat ownership='partner' da va 0 dan katta bo'lishi shart; 'owned' " +
  'filialda 0 saqlanadi.';

export class CreateBranchRequestDto {
  @ApiProperty({ example: 'Namangan filial' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiPropertyOptional({ example: "Namangan shahar, Bobur ko'chasi 12" })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  @IsOptional()
  @IsString()
  phone_number?: string;

  @ApiPropertyOptional({
    example: '5',
    description: 'Region ID (bigint string)',
  })
  @IsOptional()
  @IsNumberString()
  region_id?: string;

  @ApiPropertyOptional({
    example: '60',
    description: 'District ID (bigint string)',
  })
  @IsOptional()
  @IsNumberString()
  district_id?: string;

  @ApiPropertyOptional({
    example: '1',
    description:
      "Parent branch ID (bigint string). HQ'dan boshqa barcha turlar " +
      '(PICKUP/REGIONAL/HYBRID) uchun majburiy; HQ uchun yuborilmaydi.',
  })
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsNumberString()
  parent_id?: string;

  @ApiProperty({ example: 'REGIONAL', enum: BranchType })
  @IsEnum(BranchType)
  type!: BranchType;

  @ApiProperty({ example: 'SAM' })
  @Matches(/^[A-Z0-9-]{2,32}$/)
  code!: string;
  @ApiPropertyOptional({
    example: '12',
    description: 'Manager user ID (bigint string)',
  })
  @IsOptional()
  @IsNumberString()
  manager_id?: string;

  @ApiPropertyOptional({
    example: 'partner',
    enum: BranchOwnership,
    description: OWNERSHIP_DESCRIPTION,
  })
  @IsOptional()
  @IsEnum(BranchOwnership)
  ownership?: BranchOwnership;

  @ApiPropertyOptional({
    example: '5000',
    oneOf: [{ type: 'string' }, { type: 'number' }],
    description: PER_ORDER_SHARE_DESCRIPTION,
  })
  @IsOptional()
  @Transform(moneyToString)
  @Matches(PER_ORDER_SHARE_PATTERN, { message: PER_ORDER_SHARE_MESSAGE })
  per_order_share?: string;
}

export class UpdateBranchRequestDto {
  @ApiPropertyOptional({ example: 'Namangan filial 2' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({
    example: "Namangan shahar, Alisher Navoiy ko'chasi 20",
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: '+998901234568' })
  @IsOptional()
  @IsString()
  phone_number?: string;

  @ApiPropertyOptional({
    example: '5',
    description: 'Region ID (bigint string)',
  })
  @IsOptional()
  @IsNumberString()
  region_id?: string;

  @ApiPropertyOptional({
    example: '60',
    description: 'District ID (bigint string)',
  })
  @IsOptional()
  @IsNumberString()
  district_id?: string;

  @ApiPropertyOptional({
    example: '1',
    description: 'Parent branch ID (bigint string)',
  })
  @IsOptional()
  @IsNumberString()
  parent_id?: string;

  @ApiPropertyOptional({ example: 'PICKUP', enum: BranchType })
  @IsOptional()
  @IsEnum(BranchType)
  type?: BranchType;

  @ApiPropertyOptional({ example: 'TSH-CHL' })
  @IsOptional()
  @Matches(/^[A-Z0-9-]{2,32}$/)
  code?: string;
  @ApiPropertyOptional({ example: 'active', enum: ['active', 'inactive'] })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: string;

  @ApiPropertyOptional({
    example: '12',
    description: 'Manager user ID (bigint string)',
  })
  @IsOptional()
  @IsNumberString()
  manager_id?: string;

  @ApiPropertyOptional({
    example: 'partner',
    enum: BranchOwnership,
    description: OWNERSHIP_DESCRIPTION,
  })
  @IsOptional()
  @IsEnum(BranchOwnership)
  ownership?: BranchOwnership;

  @ApiPropertyOptional({
    example: '5000',
    oneOf: [{ type: 'string' }, { type: 'number' }],
    description: PER_ORDER_SHARE_DESCRIPTION,
  })
  @IsOptional()
  @Transform(moneyToString)
  @Matches(PER_ORDER_SHARE_PATTERN, { message: PER_ORDER_SHARE_MESSAGE })
  per_order_share?: string;
}

export class AssignBranchUserRequestDto {
  @ApiProperty({ example: '12', description: 'User ID (bigint string)' })
  @IsNumberString()
  user_id!: string;

  @ApiPropertyOptional({
    enum: BranchUserRole,
    example: BranchUserRole.REGISTRATOR,
  })
  @IsOptional()
  @IsEnum(BranchUserRole)
  role?: BranchUserRole;
}

/**
 * PATCH /couriers/:id/branch — kuryerni boshqa filialga o'tkazish (R3).
 * `IsNumberString` ATAYLAB ishlatilmaydi: u '1.5' va '-1' ni ham o'tkazadi.
 */
export class TransferCourierBranchRequestDto {
  @ApiProperty({
    example: '15',
    description: 'Yangi filial ID (faqat raqamlar)',
  })
  @Matches(/^\d+$/, {
    message: "branch_id faqat raqamlardan iborat bo'lishi kerak",
  })
  branch_id!: string;
}

export class SetBranchConfigRequestDto {
  @ApiProperty({ example: 'working_hours' })
  @IsString()
  @MinLength(1)
  config_key!: string;

  @ApiPropertyOptional({
    example: { start: '09:00', end: '18:00', timezone: 'Asia/Tashkent' },
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  config_value?: Record<string, unknown> | null;
}

export class UpdateBranchConfigRequestDto {
  @ApiPropertyOptional({
    example: { start: '10:00', end: '19:00', timezone: 'Asia/Tashkent' },
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  config_value?: Record<string, unknown> | null;
}

export class CreateBranchTransferBatchesRequestDto {
  @ApiPropertyOptional({
    example: ['46', '47', '48'],
    description: "Batchga o'tkaziladigan NEW order ID'lari",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  orderIds?: string[];

  @ApiPropertyOptional({
    example: ['46', '47', '48'],
    description: "Batchga o'tkaziladigan NEW order ID'lari (snake_case)",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  order_ids?: string[];
}

export class SendTransferBatchRequestDto {
  @ApiPropertyOptional({
    example: ['46', '47', '48'],
    description: "Yuborilayotgan batch ichidagi order ID'lar",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  orderIds?: string[];

  @ApiPropertyOptional({
    example: ['46', '47', '48'],
    description: "Yuborilayotgan batch ichidagi order ID'lar (snake_case)",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  order_ids?: string[];

  @ApiPropertyOptional({ example: '01A123AA' })
  @IsOptional()
  @IsString()
  vehicle_plate?: string;

  @ApiPropertyOptional({ example: 'Ali Valiyev' })
  @IsOptional()
  @IsString()
  driver_name?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  @IsOptional()
  @IsString()
  driver_phone?: string;
}

export class CreateReturnBatchesRequestDto {
  @ApiProperty({
    example: ['46', '47', '48'],
    description: "Qaytariladigan order ID'lari ro'yxati",
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  order_ids!: string[];

  @ApiPropertyOptional({
    example: 'ret_20260430_A1B2C3D4',
    description: 'Idempotency key (berilmasa server generatsiya qiladi)',
  })
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{8,80}$/)
  request_key?: string;

  @ApiPropertyOptional({ example: "HQ'dan qaytarish: mijoz olmadi" })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CancelTransferBatchRequestDto {
  @ApiProperty({
    example: "Noto'g'ri viloyat tanlangan, paket noto'g'ri yo'naltirilgan",
    description: 'Bekor qilish sababi (kamida 10 ta belgi)',
  })
  @IsString()
  @MinLength(10)
  reason!: string;
}

export class ReceiveTransferBatchOrdersRequestDto {
  @ApiPropertyOptional({
    example: ['46', '47'],
    description: "Qabul qilinadigan batch ichidagi order ID'lar",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  orderIds?: string[];

  @ApiPropertyOptional({
    example: ['46', '47'],
    description: "Qabul qilinadigan batch ichidagi order ID'lar (snake_case)",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  order_ids?: string[];
}

/** (3HKvAyhm) Paketdagi filial — `{ id, name }`. */
export class TransferBatchBranchRefDto {
  @ApiProperty({ example: '3' })
  id!: string;

  @ApiProperty({ example: 'Andijon filiali', nullable: true, type: String })
  name!: string | null;
}

/**
 * (3HKvAyhm) `GET /transfer-batches/:id`. 1mOjtOVC: paket cheki maydonlari
 * (token, filiallar, yo'nalish, soni, summa, haydovchi, telefon, avtomobil,
 * vaqt) ham hujjatlashtirildi — javob o'zgarmagan.
 */
export class TransferBatchDetailDto {
  @ApiProperty({ example: '601' })
  id!: string;

  @ApiProperty({ example: '3' })
  source_branch_id!: string;

  @ApiProperty({ example: '1' })
  destination_branch_id!: string;

  @ApiProperty({
    example: 'BTB-8F3K2Q9X',
    description:
      '1mOjtOVC (paket cheki): QR token — `BTB-` (FORWARD) / `BTR-` (RETURN)',
  })
  qr_code_token!: string;

  @ApiProperty({
    enum: ['FORWARD', 'RETURN'],
    example: 'FORWARD',
    description: "Yo'nalish: FORWARD — HQ → filial, RETURN — filial → HQ",
  })
  direction!: string;

  @ApiProperty({
    enum: ['PENDING', 'SENT', 'RECEIVED', 'CANCELLED'],
    example: 'SENT',
  })
  status!: string;

  @ApiProperty({ example: '5', description: 'Manzil viloyati' })
  target_region_id!: string;

  @ApiProperty({ example: 12, description: 'Paketdagi buyurtmalar soni' })
  order_count!: number;

  @ApiPropertyOptional({
    example: 1250000,
    description:
      "Jami summa. LOGIST javobida YO'Q (Z3pUOxou — pulsiz proyeksiya)",
  })
  total_price?: number;

  @ApiProperty({
    example: 'Aliyev Vali',
    nullable: true,
    type: String,
    description:
      "1mOjtOVC: haydovchi — jo'natishda (`POST /transfer-batches/:id/send`) yoziladi; jo'natilmagan paketda null",
  })
  driver_name!: string | null;

  @ApiProperty({
    example: '+998901234567',
    nullable: true,
    type: String,
    description: '1mOjtOVC: haydovchi telefoni (jo‘natishda)',
  })
  driver_phone!: string | null;

  @ApiProperty({
    example: '01A123BC',
    nullable: true,
    type: String,
    description: '1mOjtOVC: avtomobil raqami (jo‘natishda)',
  })
  vehicle_plate!: string | null;

  @ApiProperty({
    example: '2026-10-26T09:15:00.000Z',
    description: 'Yaratilgan vaqt',
  })
  createdAt!: string;

  @ApiProperty({
    example: '2026-10-26T10:00:00.000Z',
    nullable: true,
    type: String,
  })
  sent_at!: string | null;

  @ApiProperty({ example: null, nullable: true, type: String })
  received_at!: string | null;

  @ApiProperty({
    type: TransferBatchBranchRefDto,
    nullable: true,
    description:
      "3HKvAyhm: jo'natuvchi filial nomi — barcha ruxsat etilgan rollarga (menejer ham)",
  })
  source_branch!: TransferBatchBranchRefDto | null;

  @ApiProperty({
    type: TransferBatchBranchRefDto,
    nullable: true,
    description: '3HKvAyhm: qabul qiluvchi filial nomi',
  })
  destination_branch!: TransferBatchBranchRefDto | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  region?: Record<string, unknown> | null;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  items!: Record<string, unknown>[];
}

/** (3HKvAyhm) Tarix qatorini bajargan foydalanuvchi. */
export class TransferBatchHistoryUserDto {
  @ApiProperty({ example: '25' })
  id!: string;

  @ApiProperty({ example: 'Test Menejer', nullable: true, type: String })
  name!: string | null;
}

/** (3HKvAyhm) `GET /transfer-batches/:id/history` qatori. */
export class TransferBatchHistoryItemDto {
  @ApiProperty({ example: '1201' })
  id!: string;

  @ApiProperty({ example: '601' })
  batch_id!: string;

  @ApiProperty({ example: '25' })
  user_id!: string;

  @ApiProperty({
    enum: ['CREATED', 'SENT', 'RECEIVED', 'CANCELLED'],
    example: 'SENT',
  })
  action!: string;

  @ApiProperty({
    example: "Jo'natildi",
    description:
      "O'zbekcha nom: Yaratildi / Jo'natildi / Qabul qilindi / Bekor qilindi",
  })
  action_label!: string;

  @ApiProperty({ example: null, nullable: true, type: String })
  notes!: string | null;

  @ApiProperty({ example: '2026-10-24T09:15:00.000Z' })
  created_at!: string;

  @ApiProperty({
    type: TransferBatchHistoryUserDto,
    nullable: true,
    description: "identity javob bermasa yoki tizim (user_id '0') — null",
  })
  user!: TransferBatchHistoryUserDto | null;
}

export class TransferBatchHistoryResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'Transfer batch history' })
  message!: string;

  @ApiProperty({ type: [TransferBatchHistoryItemDto] })
  data!: TransferBatchHistoryItemDto[];
}

/** Pa1KaXmj: `GET /branches/hq` — viloyat (`{ id, name }`). */
export class HqBranchRegionDto {
  @ApiProperty({ example: '1' })
  id!: string;

  @ApiProperty({ example: 'Toshkent shahri' })
  name!: string;
}

/**
 * Pa1KaXmj: HQ filiali — «Markaziy ombor» ochish oynasi uchun. Oq ro'yxat:
 * pul/maosh maydonlari (`ownership`, `per_order_share`, menejer oyligi …)
 * chiqmaydi.
 */
export class HqBranchDto {
  @ApiProperty({ example: '1' })
  id!: string;

  @ApiProperty({ example: 'Bosh ofis (Toshkent)' })
  name!: string;

  @ApiProperty({ example: 'HQ-TSHKNT', nullable: true, type: String })
  code!: string | null;

  @ApiProperty({ enum: BranchType, example: BranchType.HQ })
  type!: string;

  @ApiProperty({ example: 'active', enum: ['active', 'inactive'] })
  status!: string;

  @ApiProperty({ example: null, nullable: true, type: String })
  address!: string | null;

  @ApiProperty({ example: '1', nullable: true, type: String })
  region_id!: string | null;

  @ApiProperty({
    type: HqBranchRegionDto,
    nullable: true,
    description:
      "Logistika hududi nomi bilan; `region_id` yo'q yoki hudud olinmasa — null",
  })
  region!: HqBranchRegionDto | null;
}

export class HqBranchResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'HQ branch' })
  message!: string;

  @ApiProperty({ type: HqBranchDto })
  data!: HqBranchDto;
}
