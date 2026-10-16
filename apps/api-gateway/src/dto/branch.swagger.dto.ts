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
