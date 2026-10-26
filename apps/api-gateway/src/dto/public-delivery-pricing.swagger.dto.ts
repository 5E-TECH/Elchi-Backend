import { applyDecorators } from '@nestjs/common';
import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
  OmitType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  DELIVERY_TARIFF_IDS,
  PRODUCT_WEIGHT_KG_DECIMALS,
  PRODUCT_WEIGHT_KG_MAX,
  PRODUCT_WEIGHT_KG_MIN,
  Where_deliver,
} from '@app/common';
import {
  DeliveryQuoteItemRequestDto,
  DimensionField,
  MaxDecimals,
} from './delivery-pricing.swagger.dto';

/**
 * mSkzzNBJ — ochiq kalkulyator (`/public/delivery-*`) DTO'lari.
 * Global ValidationPipe `whitelist + forbidNonWhitelisted + transform`:
 * `product_id`, `from_district_id`, `requester` va boshqa noma'lum maydon —
 * 400 (ochiq route catalog'dan begona mahsulot o'lchovini o'qiy olmasin).
 */

/** Ochiq hisobdagi elementlar chegarasi (tokenli route — 200). */
export const PUBLIC_DELIVERY_QUOTE_MAX_ITEMS = 20;
export const PUBLIC_DELIVERY_QUOTE_MAX_QUANTITY = 1000;

const ID_PATTERN = /^\d{1,18}$/;

/** Raqam ko'rinishidagi id son bo'lib kelsa — satrga. */
const toIdString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' && Number.isInteger(value) ? String(value) : value;

const RegionIdField = (field: string, description: string) =>
  applyDecorators(
    ApiProperty({ type: String, example: '1', description }),
    Transform(toIdString),
    IsDefined({ message: `${field} majburiy` }),
    IsString({ message: `${field} — raqamli id (satr)` }),
    Matches(ID_PATTERN, { message: `${field} — raqamli id` }),
  );

/**
 * Bitta element — FAQAT o'lchov: tokenli `DeliveryQuoteItemRequestDto`
 * qoidalari (weight_kg majburiy, L/W/H uchalasi birga, chegaralar) AYNAN,
 * `product_id` siz.
 */
export class PublicDeliveryQuoteItemRequestDto extends OmitType(
  DeliveryQuoteItemRequestDto,
  ['product_id', 'quantity'] as const,
) {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: PUBLIC_DELIVERY_QUOTE_MAX_QUANTITY,
    default: 1,
    example: 1,
    description: "Soni — og'irlik va hajm shunga ko'paytiriladi.",
  })
  @IsOptional()
  @IsInt({ message: 'quantity — butun son' })
  @Min(1, { message: "quantity kamida 1 bo'lishi kerak" })
  @Max(PUBLIC_DELIVERY_QUOTE_MAX_QUANTITY, {
    message: `quantity ${PUBLIC_DELIVERY_QUOTE_MAX_QUANTITY} dan oshmasligi kerak`,
  })
  quantity?: number;
}

const noItems = (o: { items?: unknown }) => o.items == null;

/**
 * `POST /public/delivery-quote`. Posilka — YO `items[]`, YO yuqori darajadagi
 * bitta posilka maydonlari (`weight_kg`, `length_cm`, … — landing kalkulyatori
 * shakli). Ikkalasi birga — 400.
 */
export class PublicDeliveryQuoteRequestDto {
  @RegionIdField(
    'from_region_id',
    "Jo'natuvchi viloyati (`GET /public/delivery-tariffs` → `regions[].id`).",
  )
  from_region_id!: string;

  @RegionIdField('to_region_id', 'Qabul qiluvchi viloyati.')
  to_region_id!: string;

  @ApiProperty({
    enum: Where_deliver,
    example: Where_deliver.CENTER,
    description:
      "Yetkazish turi. Ikkala viloyat ham shahar zonasida (Toshkent shahri) bo'lsa e'tiborsiz: har doim `city` tarifi.",
  })
  @IsEnum(Where_deliver, {
    message: "where_deliver — 'center' yoki 'address'",
  })
  where_deliver!: Where_deliver;

  @ApiPropertyOptional({
    type: [PublicDeliveryQuoteItemRequestDto],
    minItems: 1,
    maxItems: PUBLIC_DELIVERY_QUOTE_MAX_ITEMS,
    description:
      "Bir nechta element — BITTA jo'natma (og'irlik va hajm qo'shiladi, baza bir marta). Berilmasa yuqori darajadagi `weight_kg`/L/W/H — bitta posilka.",
  })
  @IsOptional()
  @IsArray({ message: "items — massiv bo'lishi kerak" })
  @ArrayMinSize(1, { message: 'items — kamida bitta element' })
  @ArrayMaxSize(PUBLIC_DELIVERY_QUOTE_MAX_ITEMS, {
    message: `items — ko'pi bilan ${PUBLIC_DELIVERY_QUOTE_MAX_ITEMS} ta element`,
  })
  @ValidateNested({ each: true })
  @Type(() => PublicDeliveryQuoteItemRequestDto)
  items?: PublicDeliveryQuoteItemRequestDto[];

  @ApiPropertyOptional({
    type: Number,
    minimum: PRODUCT_WEIGHT_KG_MIN,
    maximum: PRODUCT_WEIGHT_KG_MAX,
    example: 1.2,
    description: `Bitta posilka og'irligi, kg (ko'pi bilan ${PRODUCT_WEIGHT_KG_DECIMALS} kasr). \`items\` YO'Q bo'lsa MAJBURIY.`,
  })
  @ValidateIf(noItems)
  @IsDefined({ message: 'weight_kg majburiy (kg) — yoki items yuboring' })
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'weight_kg — 0 dan katta son (kg)' },
  )
  @MaxDecimals(
    PRODUCT_WEIGHT_KG_DECIMALS,
    `weight_kg — ko'pi bilan ${PRODUCT_WEIGHT_KG_DECIMALS} kasrli son (kg)`,
  )
  @Min(PRODUCT_WEIGHT_KG_MIN, {
    message: "weight_kg 0 dan katta bo'lishi kerak",
  })
  @Max(PRODUCT_WEIGHT_KG_MAX, {
    message: `weight_kg ${PRODUCT_WEIGHT_KG_MAX} kg dan oshmasligi kerak`,
  })
  weight_kg?: number;

  @DimensionField('length_cm', 'Uzunlik', 30)
  length_cm?: number;

  @DimensionField('width_cm', 'Kenglik', 22)
  width_cm?: number;

  @DimensionField('height_cm', 'Balandlik', 15)
  height_cm?: number;

  @ApiPropertyOptional({
    type: Boolean,
    default: true,
    description: "Hajmga qarab hisoblash. false — faqat og'irlik.",
  })
  @IsOptional()
  @IsBoolean({ message: 'volumetric_enabled — true yoki false' })
  volumetric_enabled?: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'Tezkor yetkazish — subtotal × (express_multiplier − 1) ustama.',
  })
  @IsOptional()
  @IsBoolean({ message: 'express — true yoki false' })
  express?: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      "Kuryer posilkani olib ketadi (bitta posilkali tashrif). `pickupFee` va `totalWithPickup` ga qo'shiladi; `total` (buyurtma narxi) ga KIRMAYDI.",
  })
  @IsOptional()
  @IsBoolean({ message: 'pickup — true yoki false' })
  pickup?: boolean;
}

// ------------------------------------------------------------ javoblar

export class PublicDeliveryQuoteResultDto {
  @ApiProperty({ enum: DELIVERY_TARIFF_IDS }) tariffId!: string;
  @ApiProperty({
    description: 'Ikkala viloyat ham shahar zonasida — `city` tarifi',
  })
  cityRoute!: boolean;
  @ApiProperty({ example: 40000 }) base!: number;
  @ApiProperty({ example: 4000 }) perExtraKg!: number;
  @ApiProperty({ nullable: true, example: 1 }) daysMin!: number | null;
  @ApiProperty({ nullable: true, example: 2 }) daysMax!: number | null;
  @ApiProperty({
    type: [Number],
    example: [1, 2],
    description: '`[daysMin, daysMax]` (landing `Quote.days`)',
  })
  days!: (number | null)[];
  @ApiProperty({ example: 1.2 }) actualKg!: number;
  @ApiProperty({ example: 1.98 }) volumetricKg!: number;
  @ApiProperty({
    example: 3,
    description:
      'Hajm chegarasi, kg: hajmli vazn shundan kichik — hajm hisobga olinmaydi',
  })
  volumetricFromKg!: number;
  @ApiProperty() volumetricApplied!: boolean;
  @ApiProperty({ example: 2 }) billableKg!: number;
  @ApiProperty({ example: 1 }) extraKg!: number;
  @ApiProperty({ example: 4000 }) extra!: number;
  @ApiProperty({ example: 44000 }) subtotal!: number;
  @ApiProperty({ example: 0 }) expressFee!: number;
  @ApiProperty({ example: 0 }) pickupFee!: number;
  @ApiProperty({
    example: 44000,
    description: "Buyurtma narxi (500 ga karrali), pickup'siz",
  })
  total!: number;
  @ApiProperty({
    example: 44000,
    description:
      'Kalkulyator jami: subtotal + express + pickup (landing `quote().total`)',
  })
  totalWithPickup!: number;
  @ApiProperty({ enum: ['weight', 'volume'], nullable: true }) basis!:
    | 'weight'
    | 'volume'
    | null;
  @ApiProperty({ example: 0 }) missingDimensionItems!: number;
  @ApiProperty() estimated!: boolean;
}

export class PublicDeliveryQuoteResponseDto {
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiProperty({ example: 'success' }) message!: string;
  @ApiProperty({ type: PublicDeliveryQuoteResultDto })
  data!: PublicDeliveryQuoteResultDto;
}

export class PublicDeliveryTariffDto {
  @ApiProperty({ example: 40000 }) base_price!: number;
  @ApiProperty({ example: 4000 }) extra_per_kg!: number;
  @ApiProperty({ example: 1 }) days_min!: number;
  @ApiProperty({ example: 2 }) days_max!: number;
}

export class PublicDeliveryPricingSettingsDto {
  @ApiProperty({ example: 5000 }) volumetric_divisor!: number;
  @ApiProperty({ example: 3 }) volumetric_from_kg!: number;
  @ApiProperty({ example: 1 }) first_kg_included!: number;
  @ApiProperty({ example: 0.1 }) min_billable_kg!: number;
  @ApiProperty({ example: 0.1 }) billable_step_kg!: number;
  @ApiProperty({ example: 500 }) round_to!: number;
  @ApiProperty({ example: 20000, description: "Pickup tashrifi haqi, so'm" })
  pickup_fee!: number;
  @ApiProperty({
    example: 10,
    nullable: true,
    type: Number,
    description:
      "Shuncha va undan ko'p posilka — pickup tekin (null — hech qachon)",
  })
  pickup_free_from_count!: number | null;
  @ApiProperty({ example: 1.4 }) express_multiplier!: number;
}

export class PublicDeliveryRegionDto {
  @ApiProperty({ example: '1' }) id!: string;
  @ApiProperty({ example: 'Toshkent shahri' }) name!: string;
  @ApiProperty({ description: 'Shahar zonasi (ikkala uchi — `city` tarifi)' })
  is_city_zone!: boolean;
}

export class PublicDeliveryTariffsDataDto {
  @ApiProperty({
    description:
      "Har tarifning HOZIRGI qiymatlari: `{ city, center, address }` (faol versiyasi yo'q — null).",
    type: 'object',
    additionalProperties: { $ref: getSchemaPath(PublicDeliveryTariffDto) },
  })
  tariffs!: Record<string, PublicDeliveryTariffDto | null>;
  @ApiProperty({ type: PublicDeliveryPricingSettingsDto })
  settings!: PublicDeliveryPricingSettingsDto;
  @ApiProperty({ type: [PublicDeliveryRegionDto] })
  regions!: PublicDeliveryRegionDto[];
}

export class PublicDeliveryTariffsResponseDto {
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiProperty({ example: 'success' }) message!: string;
  @ApiProperty({ type: PublicDeliveryTariffsDataDto })
  data!: PublicDeliveryTariffsDataDto;
}
