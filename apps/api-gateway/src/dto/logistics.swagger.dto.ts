import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
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
