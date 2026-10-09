import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Equals,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  IsBoolean,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { ExpenseProofCondition } from '@app/common';

export class CreateAdminRequestDto {
  @ApiProperty({ example: 'Admin User' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiProperty({ example: 'strongPassword123' })
  @IsString()
  @MinLength(4)
  password!: string;

  @ApiProperty({ example: 3000000 })
  @IsNumber()
  @Min(0)
  salary!: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  payment_day?: number;
}

/**
 * (dzyVftBx) POST /logists — admin bilan bir xil maydonlar (ism, telefon,
 * parol, maosh, to'lov kuni). `branch_id` YO'Q: logist filial xodimi emas,
 * viloyatlar alohida (PATCH /region/:id/logist, POST /region/logist/bulk).
 */
export class CreateLogistRequestDto extends CreateAdminRequestDto {}

export class CreateRegistratorRequestDto extends CreateAdminRequestDto {
  @ApiPropertyOptional({
    example: '1',
    description: 'Branch ID (manager HYBRID flowda avtomatik aniqlanadi)',
  })
  @IsOptional()
  @IsString()
  branch_id?: string;
}

export class UpdateAdminRequestDto {
  @ApiPropertyOptional({ example: 'Admin User Updated' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  @IsOptional()
  @IsPhoneNumber('UZ')
  phone_number?: string;

  @ApiPropertyOptional({ example: 'newStrongPassword123' })
  @IsOptional()
  @IsString()
  @MinLength(4)
  password?: string;

  @ApiPropertyOptional({ example: 'active' })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: string;

  @ApiPropertyOptional({ example: 3000000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  salary?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  payment_day?: number;

  @ApiPropertyOptional({ example: 11000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @ApiPropertyOptional({ example: 9000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  add_order?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      "Courier/manager buyurtmaga qo'shimcha xarajat yoza olishini boshqaradi. Faqat admin/superadmin o'zgartira oladi.",
  })
  @IsOptional()
  @IsBoolean()
  can_add_extra_cost?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'HYBRID filial menejerining SOTISH/BEKOR qila olishini boshqaradi (#4). Faqat admin/superadmin o‘zgartira oladi; default false.',
  })
  @IsOptional()
  @IsBoolean()
  can_sell_cancel?: boolean;

  @ApiPropertyOptional({ example: 'center', enum: ['center', 'address'] })
  @IsOptional()
  @IsEnum(['center', 'address'])
  default_tariff?: string;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  region_id?: string;

  @ApiPropertyOptional({
    example: 'percent',
    enum: ['percent', 'fixed'],
    description:
      'Operator commission type. percent → % of order total_price; fixed → flat per sold order.',
  })
  @IsOptional()
  @IsEnum(['percent', 'fixed'])
  commission_type?: string;

  @ApiPropertyOptional({
    example: 5,
    description: 'Commission value (percent number or fixed amount).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  commission_value?: number;
}

export class CreateMarketRequestDto {
  @ApiProperty({ example: 'Market 1' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiProperty({ example: 'market_01' })
  @IsString()
  @MinLength(3)
  username!: string;

  @ApiProperty({ example: 'secret123' })
  @IsString()
  @MinLength(4)
  password!: string;

  @ApiPropertyOptional({
    example: 10000,
    description: 'Optional, default is 0',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @ApiPropertyOptional({ example: 8000, description: 'Optional, default is 0' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;

  @ApiProperty({ example: 'center', enum: ['center', 'address'] })
  @IsEnum(['center', 'address'])
  default_tariff!: string;

  @ApiPropertyOptional({ example: false, default: false })
  @IsOptional()
  @IsBoolean()
  add_order?: boolean;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  cancelled_handover_qr_required?: boolean;

  @ApiPropertyOptional({
    isArray: true,
    enum: ExpenseProofCondition,
    description:
      'Isbot (rasm/video) majburiy bo‘ladigan vaziyatlar to‘plami. Bo‘sh = isbot talab qilinmaydi.',
    example: [
      ExpenseProofCondition.CANCEL_EXTRA_COST,
      ExpenseProofCondition.CANCEL_ZERO_TOTAL,
    ],
  })
  @IsOptional()
  @IsArray()
  @IsEnum(ExpenseProofCondition, { each: true })
  expense_proof_conditions?: ExpenseProofCondition[];
}

export class CreateCourierRequestDto {
  @ApiPropertyOptional({
    example: '12',
    description:
      'Branch ID (manager flowda avtomatik aniqlanadi, yuborish shart emas)',
  })
  @IsOptional()
  @IsString()
  branch_id?: string;

  @ApiProperty({ example: 'Akmal Abdullaev' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiProperty({ example: 'secret123' })
  @IsString()
  @MinLength(4)
  password!: string;

  @ApiPropertyOptional({
    example: 2000000,
    description: 'Optional, default is 0',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  salary?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  payment_day?: number;

  @ApiProperty({ example: 10000 })
  @IsNumber()
  @Min(0)
  tariff_home!: number;

  @ApiProperty({ example: 8000 })
  @IsNumber()
  @Min(0)
  tariff_center!: number;
}

export class CreateManagerRequestDto {
  @ApiProperty({ example: 'Branch manager' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiProperty({ example: 'secret123' })
  @IsString()
  @MinLength(4)
  password!: string;

  @ApiPropertyOptional({ example: 3000000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  salary?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  payment_day?: number;

  @ApiPropertyOptional({ example: 10000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @ApiPropertyOptional({ example: 8000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;

  // Faqat raqamlar: Postgres '+1', ' 1 ', '0x1' kabi qiymatlarni ham bigint'ga
  // (masalan HQ id'siga) aylantiradi va identity'dagi "HQ'ga menejer yo'q"
  // tekshiruvini chetlab o'tardi. identity createManager ham xuddi shu
  // qoidani qo'llaydi ("branch_id noto'g'ri").
  @ApiProperty({ example: '1', description: 'Branch ID' })
  @IsString()
  @Matches(/^\d+$/, {
    message: "branch_id faqat raqamlardan iborat bo'lishi kerak",
  })
  branch_id!: string;
}

export class UpdateMarketRequestDto {
  @ApiPropertyOptional({ example: 'Market 1 Updated' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  @IsOptional()
  @IsPhoneNumber('UZ')
  phone_number?: string;

  @ApiPropertyOptional({ example: 'newSecret123' })
  @IsOptional()
  @IsString()
  @MinLength(4)
  password?: string;

  @ApiPropertyOptional({ example: 'active' })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  add_order?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  cancelled_handover_qr_required?: boolean;

  @ApiPropertyOptional({ example: 11000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @ApiPropertyOptional({ example: 9000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;

  @ApiPropertyOptional({ example: 'address', enum: ['center', 'address'] })
  @IsOptional()
  @IsEnum(['center', 'address'])
  default_tariff?: string;
}

export class UpdateMarketAddOrderRequestDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  add_order!: boolean;
}

export class UpdateMarketCancelledHandoverQrRequestDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  cancelled_handover_qr_required!: boolean;
}

export class UpdateMarketExpenseProofRequestDto {
  @ApiProperty({
    isArray: true,
    enum: ExpenseProofCondition,
    description:
      'Isbot (rasm/video) majburiy bo‘ladigan vaziyatlar to‘plami. Bo‘sh massiv = isbotni butunlay o‘chiradi.',
    example: [
      ExpenseProofCondition.CANCEL_EXTRA_COST,
      ExpenseProofCondition.CANCEL_ZERO_TOTAL,
      ExpenseProofCondition.SELL_EXTRA_COST,
    ],
  })
  @IsArray()
  @IsEnum(ExpenseProofCondition, { each: true })
  expense_proof_conditions!: ExpenseProofCondition[];
}

export class UpdateUserStatusRequestDto {
  @ApiProperty({ example: 'active', enum: ['active', 'inactive'] })
  @IsEnum(['active', 'inactive'])
  status!: string;
}

/**
 * (GvL6ZFAd) POST /markets/tg-token/rotate-all tasdig'i. Qiymat identity
 * `MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM` (contracts/market.payloads.ts) bilan
 * BIR XIL — kontrakt spec'i solishtiradi.
 */
export const MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM = 'ROTATE_ALL';

export class RotateAllMarketTgTokensRequestDto {
  @ApiProperty({
    example: MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM,
    enum: [MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM],
    description:
      "Aniq tasdiq: AYNAN 'ROTATE_ALL'. Boshqa qiymat yoki maydon yo'q — 400.",
  })
  @Equals(MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM, {
    message: `confirm aynan '${MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM}' bo'lishi kerak`,
  })
  confirm!: string;
}

export class MarketTgTokenDataDto {
  @ApiProperty({ example: '3' })
  id!: string;

  @ApiProperty({
    example: 'group_token-0123456789abcdef0123456789abcdef',
    nullable: true,
    type: String,
    description:
      "Marketning maxfiy Telegram tokeni (group_token-<32 hex>). Faqat SUPERADMIN ko'radi; marketga xavfsiz kanal orqali bering.",
  })
  market_tg_token!: string | null;
}

export class MarketTgTokenResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'Market Telegram tokeni' })
  message!: string;

  @ApiProperty({ type: MarketTgTokenDataDto })
  data!: MarketTgTokenDataDto;
}

export class RotateAllMarketTgTokensDataDto {
  @ApiProperty({
    example: 11,
    description:
      "Tokeni almashtirilgan faol marketlar soni (tokenlarning o'zi YO'Q).",
  })
  rotated_count!: number;
}

export class RotateAllMarketTgTokensResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: '11 ta market Telegram tokeni yangilandi' })
  message!: string;

  @ApiProperty({ type: RotateAllMarketTgTokensDataDto })
  data!: RotateAllMarketTgTokensDataDto;
}

export class EntityItemDto {
  @ApiProperty({ example: '1' })
  id!: string;

  @ApiProperty({ example: '2026-02-12T09:34:04.236Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-02-12T09:34:04.236Z' })
  updatedAt!: string;

  @ApiProperty({ example: 'Admin User' })
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  phone_number!: string;

  @ApiProperty({ example: 'admin' })
  role!: string;

  @ApiProperty({ example: 'active' })
  status!: string;

  @ApiPropertyOptional({ example: 10000 })
  tariff_home?: number;

  @ApiPropertyOptional({ example: 8000 })
  tariff_center?: number;

  @ApiPropertyOptional({ example: 'center' })
  default_tariff?: string;

  @ApiPropertyOptional({ example: false })
  add_order?: boolean;
}

export class SingleEntityResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiPropertyOptional({ example: 'success' })
  message!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {
      id: '1',
      name: 'Admin User',
      phone_number: '+998901234567',
      role: 'admin',
      status: 'active',
    },
  })
  data!: Record<string, unknown>;
}

export class ListEntityResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiPropertyOptional({ example: 'success' })
  message!: string;

  @ApiProperty({
    example: {
      items: [
        {
          id: '1',
          createdAt: '2026-02-12T09:34:04.236Z',
          updatedAt: '2026-02-12T09:34:04.236Z',
          name: 'Admin User',
          phone_number: '+998901234567',
          role: 'admin',
          status: 'active',
        },
      ],
      meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
    },
  })
  data!: Record<string, unknown>;
}

export class DeleteEntityResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'O‘chirildi' })
  message!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: false,
    example: { id: '1' },
  })
  data!: Record<string, unknown>;
}
