import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsDateString,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

const BIGINT_ID = /^[1-9]\d{0,18}$/;

/** B824gOu5 — `POST /finance/pickup-visits`. */
export class CreatePickupVisitRequestDto {
  @ApiProperty({ example: '12', description: 'Market (foydalanuvchi id)' })
  @IsString()
  @Matches(BIGINT_ID)
  market_id!: string;

  @ApiProperty({ example: '55', description: 'Olib ketgan kuryer' })
  @IsString()
  @Matches(BIGINT_ID)
  courier_id!: string;

  @ApiProperty({
    example: 9,
    description:
      "Shu BITTA tashrifda olib ketilgan posilkalar soni. `pickup_free_from_count` va undan ko'p — tekin.",
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  parcel_count!: number;

  @ApiPropertyOptional({
    example: '2026-10-31T09:30:00.000Z',
    description: 'Tashrif vaqti (ISO). Berilmasa — hozir.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  occurred_at?: string;
}

export class FindPickupVisitsQueryDto {
  @ApiPropertyOptional({
    example: '12',
    description: "MARKET roli uchun faqat o'z id si (boshqasi — 403).",
  })
  @IsOptional()
  @IsString()
  @Matches(BIGINT_ID)
  market_id?: string;

  @ApiPropertyOptional({ example: '55' })
  @IsOptional()
  @IsString()
  @Matches(BIGINT_ID)
  courier_id?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: 'Faqat tekin (`true`) yoki faqat pullik (`false`) tashriflar.',
  })
  @IsOptional()
  @IsBooleanString()
  is_free?: string;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'Tashrif sanasi, Toshkent kuni.',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  from_date?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsDateString({ strict: true })
  to_date?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20, description: '1…100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class PickupVisitDto {
  @ApiProperty({ example: '301' }) id!: string;
  @ApiProperty({ example: '12' }) market_id!: string;
  @ApiProperty({ example: '55' }) courier_id!: string;
  @ApiProperty({ example: 9 }) parcel_count!: number;
  @ApiProperty({ example: 20000, description: 'Tekin tashrifda 0' })
  fee!: number;
  @ApiProperty({
    example: false,
    description: '«10+ posilka — tekin» holati alohida ko`rsatiladi.',
  })
  is_free!: boolean;
  @ApiProperty({ example: '7' }) created_by!: string;
  @ApiProperty({ example: '2026-10-31T09:30:00.000Z' }) occurred_at!: string;
  @ApiProperty({
    example: '9001',
    nullable: true,
    description: 'Market kassasidagi `pickup_fee` tarix qatori.',
  })
  cashbox_history_id!: string | null;
}

export class PickupVisitCreatedDto extends PickupVisitDto {
  @ApiProperty({
    example: false,
    description:
      'true — shu Idempotency-Key bilan tashrif allaqachon yozilgan.',
  })
  idempotent!: boolean;
}

export class PickupVisitRowDto extends PickupVisitDto {
  @ApiPropertyOptional({ nullable: true, type: String })
  market_name?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String })
  courier_name?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String })
  created_by_name?: string | null;
}

export class PickupVisitSummaryDto {
  @ApiProperty({ example: 40000, description: 'Pickup daromadi, so`m' })
  income!: number;
  @ApiProperty({ example: 3 }) visits!: number;
  @ApiProperty({ example: 2 }) paid_visits!: number;
  @ApiProperty({ example: 1 }) free_visits!: number;
  @ApiProperty({ example: 21 }) parcels!: number;
}

export class PickupVisitListDto {
  @ApiProperty({ type: [PickupVisitRowDto] })
  items!: PickupVisitRowDto[];
  @ApiProperty({ type: PickupVisitSummaryDto })
  summary!: PickupVisitSummaryDto;
  @ApiProperty({
    example: { total: 3, page: 1, limit: 20, totalPages: 1 },
  })
  pagination!: Record<string, number>;
}
