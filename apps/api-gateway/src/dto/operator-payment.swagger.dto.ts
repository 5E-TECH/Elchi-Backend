import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const BIGINT_ID = /^[1-9]\d{0,18}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Bo'shliqdan boshqa kamida bitta belgi. */
const NOT_BLANK = /\S/;

/**
 * F2qp6FtE — `POST /finance/operator-payments` (faqat MARKET). Market id —
 * JWT'dan, tanada YO'Q (`market_id` yuborilsa — 400, forbidNonWhitelisted).
 */
export class RecordOperatorPaymentRequestDto {
  @ApiProperty({
    example: '41',
    description: 'Operator (shu marketning operatori; begona yoki yo`q — 404)',
  })
  @IsString()
  @Matches(BIGINT_ID, { message: "operator_id noto'g'ri" })
  operator_id!: string;

  @ApiProperty({
    example: 150000,
    description:
      "To'langan summa, so'm (> 0, ko'pi bilan 2 kasr). Qoldiqdan oshsa ham yoziladi — «Qoldiq» manfiy (ortiqcha to'langan) bo'ladi.",
  })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false },
    { message: "Summa son bo'lishi kerak (ko'pi bilan 2 kasr)" },
  )
  @Min(0.01, { message: "Summa 0 dan katta bo'lishi kerak" })
  @Max(999_999_999_999.99, { message: 'Summa juda katta' })
  amount!: number;

  @ApiPropertyOptional({
    example: '2026-11-18',
    description:
      "To'lov sanasi (Toshkent kuni, `YYYY-MM-DD`). Berilmasa — bugun. Kelajak sanasi — 400.",
  })
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY, {
    message: "To'lov sanasi YYYY-MM-DD shaklida bo'lishi kerak",
  })
  paid_at?: string;

  @ApiPropertyOptional({ example: 'Oktabr komissiyasi, naqd', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** F2qp6FtE — `POST /finance/operator-payments/:id/cancel`. */
export class CancelOperatorPaymentRequestDto {
  @ApiProperty({
    example: 'Summa xato kiritildi',
    minLength: 3,
    maxLength: 500,
    description: 'Bekor qilish sababi (majburiy).',
  })
  @IsString()
  @Matches(NOT_BLANK, { message: 'Sabab majburiy' })
  @MaxLength(500)
  reason!: string;
}

/** F2qp6FtE — `GET /finance/operator-payments`. */
export class ListOperatorPaymentsQueryDto {
  @ApiPropertyOptional({
    example: '41',
    description: 'Faqat shu operator (shu marketning operatori)',
  })
  @IsOptional()
  @IsString()
  @Matches(BIGINT_ID, { message: "operator_id noto'g'ri" })
  operator_id?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20, description: '1…100, sukut 20' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class OperatorPaymentViewDto {
  @ApiProperty({ example: '301' })
  id!: string;

  @ApiProperty({ example: '41' })
  operator_id!: string;

  @ApiProperty({
    example: 'Madina Xoliqova',
    nullable: true,
    type: String,
    description:
      "Operator ismi (2026-11-20 dan o'chirilgan operatorda ham; ro'yxatda umuman yo'q bo'lsa — null)",
  })
  operator_name!: string | null;

  @ApiProperty({
    example: '12',
    nullable: true,
    type: String,
    description: 'Yozgan market (eski Elchi yozuvlarida — null)',
  })
  market_id!: string | null;

  @ApiProperty({ example: 150000 })
  amount!: number;

  @ApiProperty({ example: '2026-11-18', description: 'Toshkent kuni' })
  paid_at!: string;

  @ApiProperty({ example: 'Oktabr komissiyasi', nullable: true, type: String })
  note!: string | null;

  @ApiProperty({
    enum: ['market', 'elchi'],
    description:
      "`market` — market o'zi yozgan (kassasiz); `elchi` — eski yo'l, Elchi xodimi yozgan (bekor qilib bo'lmaydi).",
  })
  source!: 'market' | 'elchi';

  @ApiProperty({
    example: false,
    description:
      "Asosiy kassani o'zgartirganmi (faqat eski `elchi` yozuvlarida true).",
  })
  affects_cashbox!: boolean;

  @ApiProperty({ example: 'market', nullable: true, type: String })
  recorded_by_role!: string | null;

  @ApiProperty({ example: '2026-11-18T09:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ enum: ['active', 'cancelled'] })
  status!: 'active' | 'cancelled';

  @ApiProperty({ nullable: true, type: String, example: null })
  cancelled_at!: string | null;

  @ApiProperty({ nullable: true, type: String, example: null })
  cancelled_by_role!: string | null;

  @ApiProperty({ nullable: true, type: String, example: null })
  cancel_reason!: string | null;

  @ApiProperty({
    example: true,
    description: "Shu market bekor qila oladimi (o'z yozuvi, hali faol).",
  })
  can_cancel!: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      "Yozish/bekor qilish javobida: takroriy so'rov (ayni Idempotency-Key yoki allaqachon bekor) — true.",
  })
  idempotent?: boolean;
}

export class OperatorPaymentPaginationDto {
  @ApiProperty({ example: 42 })
  total!: number;
  @ApiProperty({ example: 1 })
  page!: number;
  @ApiProperty({ example: 20 })
  limit!: number;
  @ApiProperty({ example: 3 })
  totalPages!: number;
}

export class OperatorPaymentListDto {
  @ApiProperty({ type: [OperatorPaymentViewDto] })
  items!: OperatorPaymentViewDto[];

  @ApiProperty({ type: OperatorPaymentPaginationDto })
  pagination!: OperatorPaymentPaginationDto;
}

export class OperatorBalanceItemDto {
  @ApiProperty({ example: '41' })
  operator_id!: string;

  @ApiProperty({ example: 'Madina Xoliqova' })
  operator_name!: string;

  @ApiProperty({
    enum: ['active', 'inactive', 'deleted'],
    example: 'active',
    description:
      '`deleted` — o`chirilgan operator (2026-11-20): faqat daromadi yoki to`lovi bo`lsa chiqadi, uning hisobi yo`qolmasin',
  })
  status!: string;

  @ApiProperty({
    example: 1250000,
    description:
      '«Ishlab topdi» — o`chirilmagan daromadlar (GET operators/me/balance bilan AYNI qoida)',
  })
  earned!: number;

  @ApiProperty({
    example: 57,
    nullable: true,
    type: Number,
    description:
      'Shu marketdagi operator buyurtmalari (`orders.operator_id`), butun davr. order-service javob bermasa — null (hisob baribir qaytadi)',
  })
  orders_total!: number | null;

  @ApiProperty({
    example: 41,
    nullable: true,
    type: Number,
    description:
      'Sotilgan (sold / paid / partly_paid) — komissiya shulardan yoziladi',
  })
  orders_sold!: number | null;

  @ApiProperty({
    example: 9,
    nullable: true,
    type: Number,
    description:
      'Hali yo`lda (yangi … mijozni kutmoqda) — sotilsa komissiya yoziladi',
  })
  orders_pending!: number | null;

  @ApiProperty({
    example: 900000,
    description:
      '«To`landi» — o`chirilmagan va bekor qilinmagan to`lovlar (eski Elchi to`lovlari ham)',
  })
  paid!: number;

  @ApiProperty({
    example: 350000,
    description: '«Qoldiq» = earned − paid. Manfiy — ortiqcha to`langan.',
  })
  balance!: number;

  @ApiProperty({ example: 3 })
  payments_count!: number;

  @ApiProperty({ example: '2026-11-18', nullable: true, type: String })
  last_paid_at!: string | null;
}

export class OperatorBalanceTotalsDto {
  @ApiProperty({ example: 2500000 })
  earned!: number;
  @ApiProperty({ example: 1800000 })
  paid!: number;
  @ApiProperty({ example: 700000 })
  balance!: number;
}

export class OperatorBalancesDto {
  @ApiProperty({ type: [OperatorBalanceItemDto] })
  items!: OperatorBalanceItemDto[];

  @ApiProperty({ type: OperatorBalanceTotalsDto })
  totals!: OperatorBalanceTotalsDto;
}

/** GET /finance/operator-payments/earnings (2026-11-20) — market, o'z operatori daromad qatorlari. */
export class ListOperatorEarningsQueryDto {
  @ApiProperty({
    example: '41',
    description:
      'Shu marketning operatori (o`chirilgani ham); begona yoki yo`q — 404',
  })
  @IsString()
  @Matches(BIGINT_ID, { message: "operator_id noto'g'ri" })
  operator_id!: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20, description: '1…100, sukut 20' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class OperatorEarningViewDto {
  @ApiProperty({ example: '901' })
  id!: string;

  @ApiProperty({ example: '55120', description: 'Buyurtma ID' })
  order_id!: string;

  @ApiProperty({ example: 12500, description: 'Operator ulushi (so`m)' })
  amount!: number;

  @ApiProperty({
    example: 250000,
    description: 'Sotuv paytidagi buyurtma summasi',
  })
  order_total_price!: number;

  @ApiProperty({
    enum: ['percent', 'fixed'],
    nullable: true,
    type: String,
    description: 'Sotuv paytidagi komissiya turi (snapshot)',
  })
  commission_type!: string | null;

  @ApiProperty({ example: 5, description: 'Sotuv paytidagi stavka' })
  commission_value!: number;

  @ApiProperty({
    example: '2026-11-18T09:12:00.000Z',
    description: 'Yozilgan vaqt (sotuv)',
  })
  created_at!: string;
}

export class OperatorEarningListDto {
  @ApiProperty({ type: [OperatorEarningViewDto] })
  items!: OperatorEarningViewDto[];

  @ApiProperty({ type: OperatorPaymentPaginationDto })
  pagination!: OperatorPaymentPaginationDto;
}
