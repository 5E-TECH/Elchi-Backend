import { applyDecorators } from '@nestjs/common';
import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  DELIVERY_TARIFF_IDS,
  PRODUCT_DIMENSION_CM_MAX,
  PRODUCT_DIMENSION_CM_MIN,
  PRODUCT_WEIGHT_KG_DECIMALS,
  PRODUCT_WEIGHT_KG_MAX,
  PRODUCT_WEIGHT_KG_MIN,
  Where_deliver,
} from '@app/common';

/**
 * DAqXPeSy — yetkazish narxi dvigateli: so'rov/javob DTO'lari.
 * Global ValidationPipe `whitelist + forbidNonWhitelisted + transform` —
 * ichki elementlar ham (`ValidateNested` + `Type`) oq ro'yxat bilan
 * tekshiriladi; noma'lum maydon — 400.
 */

/** Bitta hisobdagi elementlar chegarasi (logistics `DELIVERY_QUOTE_MAX_ITEMS`). */
export const DELIVERY_QUOTE_MAX_ITEMS = 200;
export const DELIVERY_QUOTE_MAX_QUANTITY = 10_000;
const MONEY_MAX = 999_999_999_999.99;
const ID_PATTERN = /^\d{1,18}$/;

/** `round(v·10ⁿ)/10ⁿ === v` (catalog DTO'dagi qoida — eksponentli songa ham xavfsiz). */
export const MaxDecimals = (decimals: number, message: string) => {
  const scale = 10 ** decimals;
  return ValidateBy(
    {
      name: 'maxDecimals',
      constraints: [decimals],
      validator: {
        validate: (value: unknown): boolean =>
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          Math.round(value * scale) / scale === value,
      },
    },
    { message },
  );
};

/** Raqam ko'rinishidagi id son bo'lib kelsa — satrga (bigint id'lar). */
const toIdString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' && Number.isInteger(value) ? String(value) : value;

const IdField = (field: string, description: string) =>
  applyDecorators(
    ApiPropertyOptional({ type: String, example: '1', description }),
    IsOptional(),
    Transform(toIdString),
    IsString({ message: `${field} — raqamli id (satr)` }),
    Matches(ID_PATTERN, { message: `${field} — raqamli id` }),
  );

const hasProduct = (o: { product_id?: unknown }) =>
  o.product_id !== undefined && o.product_id !== null && o.product_id !== '';

const hasAnyDimension = (o: {
  length_cm?: unknown;
  width_cm?: unknown;
  height_cm?: unknown;
}) =>
  [o.length_cm, o.width_cm, o.height_cm].some(
    (d) => d !== undefined && d !== null,
  );

/**
 * L/W/H — uchalasi birga (catalog `CHK_products_dimensions_all_or_none` bilan
 * AYNI): bittasi berilsa qolgan ikkitasi ham majburiy.
 */
export const DimensionField = (
  field: 'length_cm' | 'width_cm' | 'height_cm',
  label: string,
  example: number,
) =>
  applyDecorators(
    ApiPropertyOptional({
      type: 'integer',
      minimum: PRODUCT_DIMENSION_CM_MIN,
      maximum: PRODUCT_DIMENSION_CM_MAX,
      example,
      description: `${label}, sm (butun son). Uzunlik, kenglik, balandlik — uchalasi birga yoki hech biri. \`product_id\` bilan yuborilmaydi.`,
    }),
    ValidateIf((o: Parameters<typeof hasAnyDimension>[0]) =>
      hasAnyDimension(o),
    ),
    IsDefined({ message: `${field} — L/W/H uchalasi birga yuboriladi` }),
    IsInt({ message: `${field} — butun son (sm)` }),
    Min(PRODUCT_DIMENSION_CM_MIN, {
      message: `${field} ${PRODUCT_DIMENSION_CM_MIN} sm dan kichik bo'lmasligi kerak`,
    }),
    Max(PRODUCT_DIMENSION_CM_MAX, {
      message: `${field} ${PRODUCT_DIMENSION_CM_MAX} sm dan oshmasligi kerak`,
    }),
  );

/**
 * Hisobdagi bitta element: YO `product_id` (o'lchov catalog'dan, MARKET —
 * faqat o'z mahsuloti), YO to'g'ridan o'lchov (`weight_kg` majburiy).
 * Ikkalasi birga — 400.
 */
export class DeliveryQuoteItemRequestDto {
  @ApiPropertyOptional({
    type: String,
    example: '42',
    description:
      "Catalog mahsuloti — o'lchov (weight_kg, L/W/H, volumetric_enabled) catalog'dan olinadi. Berilsa o'lchov maydonlari yuborilmaydi (400). MARKET roli faqat o'z mahsulotini (begonasi — 404).",
  })
  @IsOptional()
  @Transform(toIdString)
  @IsString({ message: 'product_id — raqamli id (satr)' })
  @Matches(ID_PATTERN, { message: 'product_id — raqamli id' })
  product_id?: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: PRODUCT_WEIGHT_KG_MIN,
    maximum: PRODUCT_WEIGHT_KG_MAX,
    example: 1.2,
    description: `Og'irlik, kg (ko'pi bilan ${PRODUCT_WEIGHT_KG_DECIMALS} kasr). \`product_id\` YO'Q bo'lsa MAJBURIY; bor bo'lsa yuborilmaydi.`,
  })
  @ValidateIf((o: DeliveryQuoteItemRequestDto) => !hasProduct(o))
  @IsDefined({ message: 'weight_kg majburiy (kg) — yoki product_id yuboring' })
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
    description:
      "Hajmga qarab hisoblash (U×K×B / bo'luvchi). false — faqat og'irlik. `product_id` bilan yuborilmaydi.",
  })
  @IsOptional()
  @IsBoolean({ message: 'volumetric_enabled — true yoki false' })
  volumetric_enabled?: boolean;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: DELIVERY_QUOTE_MAX_QUANTITY,
    default: 1,
    example: 1,
    description: "Soni — og'irlik va hajm shunga ko'paytiriladi.",
  })
  @IsOptional()
  @IsInt({ message: 'quantity — butun son' })
  @Min(1, { message: "quantity kamida 1 bo'lishi kerak" })
  @Max(DELIVERY_QUOTE_MAX_QUANTITY, {
    message: `quantity ${DELIVERY_QUOTE_MAX_QUANTITY} dan oshmasligi kerak`,
  })
  quantity?: number;
}

export class DeliveryQuoteRequestDto {
  @ApiProperty({
    type: [DeliveryQuoteItemRequestDto],
    minItems: 1,
    maxItems: DELIVERY_QUOTE_MAX_ITEMS,
    description:
      "Jo'natma elementlari — BITTA posilka: og'irliklar va hajmlar qo'shiladi, baza narx bir marta olinadi.",
  })
  @IsArray({ message: "items — massiv bo'lishi kerak" })
  @ArrayMinSize(1, { message: 'items — kamida bitta element' })
  @ArrayMaxSize(DELIVERY_QUOTE_MAX_ITEMS, {
    message: `items — ko'pi bilan ${DELIVERY_QUOTE_MAX_ITEMS} ta element`,
  })
  @ValidateNested({ each: true })
  @Type(() => DeliveryQuoteItemRequestDto)
  items!: DeliveryQuoteItemRequestDto[];

  @IdField(
    'from_region_id',
    "Jo'natuvchi viloyati. `from_region_id` yoki `from_district_id` — kamida bittasi.",
  )
  from_region_id?: string;

  @IdField(
    'from_district_id',
    "Jo'natuvchi tumani (viloyati tumandan olinadi; ikkalasi berilsa mos bo'lishi shart).",
  )
  from_district_id?: string;

  @IdField(
    'to_region_id',
    'Qabul qiluvchi viloyati. `to_region_id` yoki `to_district_id` — kamida bittasi.',
  )
  to_region_id?: string;

  @IdField(
    'to_district_id',
    "Qabul qiluvchi tumani (buyurtmadagi `district_id`). Narx GEOGRAFIK viloyatdan (`districts.region_id`), `assigned_region` ta'sir qilmaydi.",
  )
  to_district_id?: string;

  @ApiProperty({
    enum: Where_deliver,
    example: Where_deliver.CENTER,
    description:
      "Yetkazish turi. Ikkala uchi ham shahar zonasida (`regions.is_city_zone` — Toshkent shahri) bo'lsa e'tiborsiz: har doim `city` tarifi.",
  })
  @IsEnum(Where_deliver, {
    message: "where_deliver — 'center' yoki 'address'",
  })
  where_deliver!: Where_deliver;

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
    type: 'integer',
    minimum: 0,
    example: 0,
    description:
      "Bitta pickup tashrifidagi posilkalar soni (kalkulyator uchun). `pickupFee` ALOHIDA qaytadi va buyurtma narxiga (`total`) QO'SHILMAYDI; `pickup_free_from_count` va undan ko'p — tekin.",
  })
  @IsOptional()
  @IsInt({ message: 'pickup_count — butun son' })
  @Min(0, { message: "pickup_count manfiy bo'lmasligi kerak" })
  @Max(DELIVERY_QUOTE_MAX_QUANTITY, {
    message: `pickup_count ${DELIVERY_QUOTE_MAX_QUANTITY} dan oshmasligi kerak`,
  })
  pickup_count?: number;
}

/**
 * `POST /delivery/quote/by-tariff` — hudud yo'q: bir xil elementlar uchun
 * uchala tarif (city / center / address) bo'yicha taxminiy narx. Mahsulot
 * formasidagi «Taxminiy yetkazish narxi» bloki uchun (6FLyjO6j).
 */
export class DeliveryQuoteByTariffRequestDto {
  @ApiProperty({
    type: [DeliveryQuoteItemRequestDto],
    description:
      "Bitta jo'natma elementlari: `product_id` (o'lchov catalog'dan) YOKI to'g'ridan o'lchov.",
  })
  @IsArray({ message: "items — massiv bo'lishi kerak" })
  @ArrayMinSize(1, { message: 'items — kamida bitta element' })
  @ArrayMaxSize(DELIVERY_QUOTE_MAX_ITEMS, {
    message: `items — ko'pi bilan ${DELIVERY_QUOTE_MAX_ITEMS} ta element`,
  })
  @ValidateNested({ each: true })
  @Type(() => DeliveryQuoteItemRequestDto)
  items!: DeliveryQuoteItemRequestDto[];

  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @IsBoolean({ message: 'express — true yoki false' })
  express?: boolean;
}

const MoneyField = (field: string, example: number, description: string) =>
  applyDecorators(
    ApiProperty({ type: Number, minimum: 0, example, description }),
    IsNumber(
      { allowNaN: false, allowInfinity: false },
      { message: `${field} — son (so'm)` },
    ),
    MaxDecimals(2, `${field} — ko'pi bilan 2 kasrli son`),
    Min(0, { message: `${field} manfiy bo'lmasligi kerak` }),
    Max(MONEY_MAX, { message: `${field} juda katta` }),
  );

const DaysField = (field: string, example: number) =>
  applyDecorators(
    ApiProperty({ type: 'integer', minimum: 0, maximum: 365, example }),
    IsInt({ message: `${field} — butun son (kun)` }),
    Min(0, { message: `${field} manfiy bo'lmasligi kerak` }),
    Max(365, { message: `${field} 365 dan oshmasligi kerak` }),
  );

/** `POST /delivery/tariffs` — YANGI versiya (eski qator o'chirilmaydi). */
export class CreateDeliveryTariffRequestDto {
  @ApiProperty({ enum: DELIVERY_TARIFF_IDS, example: 'center' })
  @IsIn(DELIVERY_TARIFF_IDS as unknown as string[], {
    message: "tariff_id — 'city', 'center' yoki 'address'",
  })
  tariff_id!: string;

  @MoneyField('base_price', 40000, "Baza narx (birinchi kg kiradi), so'm")
  base_price!: number;

  @MoneyField('extra_per_kg', 4000, "Har qo'shimcha kg narxi, so'm")
  extra_per_kg!: number;

  @DaysField('days_min', 1)
  days_min!: number;

  @DaysField('days_max', 2)
  days_max!: number;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: '2026-11-01T00:00:00+05:00',
    description:
      "Qachondan amal qiladi. Berilmasa — hozir. Kelajak — rejalashtirilgan versiya; o'tmish (5 daqiqadan ko'p) — 400.",
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'valid_from — ISO 8601 sana-vaqt' })
  valid_from?: string;
}

const KgSettingField = (
  field: string,
  min: number,
  example: number,
  description: string,
) =>
  applyDecorators(
    ApiPropertyOptional({
      type: Number,
      minimum: min,
      maximum: 1000,
      example,
      description,
    }),
    IsOptional(),
    IsNumber(
      { allowNaN: false, allowInfinity: false },
      { message: `${field} — son (kg)` },
    ),
    MaxDecimals(3, `${field} — ko'pi bilan 3 kasrli son (kg)`),
    Min(min, { message: `${field} ${min} dan kichik bo'lmasligi kerak` }),
    Max(1000, { message: `${field} 1000 dan oshmasligi kerak` }),
  );

/** `PATCH /delivery/pricing-settings` — qisman; yangi faol versiya yoziladi. */
export class UpdateDeliveryPricingSettingsRequestDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    example: 5000,
    description:
      "Hajmli vazn bo'luvchisi (U×K×B sm / shu son). Ega qarori — 5000.",
  })
  @IsOptional()
  @IsInt({ message: 'volumetric_divisor — butun son' })
  @Min(1, { message: "volumetric_divisor 0 dan katta bo'lishi kerak" })
  @Max(1_000_000, { message: 'volumetric_divisor juda katta' })
  volumetric_divisor?: number;

  @KgSettingField(
    'volumetric_from_kg',
    0,
    3,
    "(AQ9lkgVB) Hajm qaysi kg dan boshlab hisobga olinadi. Hajmli vazn (Σ U×K×B / volumetric_divisor) shundan KICHIK bo'lsa — hajm hisobga olinmaydi (standart narx, faqat haqiqiy og'irlik); KATTA yoki TENG bo'lsa — hisob vazni = katta(haqiqiy, hajmli). 0 — hajm har doim qo'llanadi (sukut).",
  )
  volumetric_from_kg?: number;

  @KgSettingField(
    'first_kg_included',
    0,
    1,
    'Baza narxga kiradigan vazn, kg (1.0).',
  )
  first_kg_included?: number;

  @KgSettingField(
    'min_billable_kg',
    0.001,
    0.1,
    'Eng kichik hisob vazni, kg (0.1).',
  )
  min_billable_kg?: number;

  @KgSettingField(
    'billable_step_kg',
    0.001,
    0.1,
    'Hisob vazni shu qadam bilan YUQORIGA yaxlitlanadi, kg (0.1).',
  )
  billable_step_kg?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    example: 500,
    description: "Yakuniy narx shu songa karrali, so'm (500).",
  })
  @IsOptional()
  @IsInt({ message: "round_to — butun son (so'm)" })
  @Min(1, { message: "round_to 0 dan katta bo'lishi kerak" })
  @Max(1_000_000, { message: 'round_to juda katta' })
  round_to?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: 0,
    example: 20000,
    description:
      "Pickup tashrifi haqi, so'm. Buyurtma narxiga QO'SHILMAYDI (market hisobiga alohida — B824gOu5).",
  })
  @IsOptional()
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: "pickup_fee — son (so'm)" },
  )
  @MaxDecimals(2, "pickup_fee — ko'pi bilan 2 kasrli son")
  @Min(0, { message: "pickup_fee manfiy bo'lmasligi kerak" })
  @Max(MONEY_MAX, { message: 'pickup_fee juda katta' })
  pickup_fee?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    nullable: true,
    example: 10,
    description:
      "Bir tashrifda shuncha va undan ko'p posilka — pickup tekin. null — hech qachon tekin emas.",
  })
  @ValidateIf(
    (_o: object, value: unknown) => value !== undefined && value !== null,
  )
  @IsInt({ message: 'pickup_free_from_count — butun son yoki null' })
  @Min(1, { message: "pickup_free_from_count kamida 1 bo'lishi kerak" })
  @Max(1_000_000, { message: 'pickup_free_from_count juda katta' })
  pickup_free_from_count?: number | null;

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    example: 1.4,
    description:
      'Tezkor yetkazish ko`paytiruvchisi (1.4 → subtotal × 0.4 ustama).',
  })
  @IsOptional()
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'express_multiplier — son' },
  )
  @MaxDecimals(3, "express_multiplier — ko'pi bilan 3 kasrli son")
  @Min(1, { message: "express_multiplier 1 dan kichik bo'lmasligi kerak" })
  @Max(100, { message: 'express_multiplier juda katta' })
  express_multiplier?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: 0,
    nullable: true,
    example: 25000,
    description:
      "(KmWO9gTA) DARVOZA 1 — sotuvda dvigatel hisoblagan market tarifi shundan (va kuryer + filial ulushidan) past bo'lsa shu qiymatga ko'tariladi. null — faqat ulushlar. Faqat SALE_PRICING_ENGINE yoqilganda ishlaydi.",
  })
  @ValidateIf(
    (_o: object, value: unknown) => value !== undefined && value !== null,
  )
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: "min_delivery_price — son (so'm) yoki null" },
  )
  @MaxDecimals(2, "min_delivery_price — ko'pi bilan 2 kasrli son")
  @Min(0, { message: "min_delivery_price manfiy bo'lmasligi kerak" })
  @Max(MONEY_MAX, { message: 'min_delivery_price juda katta' })
  min_delivery_price?: number | null;

  @ApiPropertyOptional({
    type: Number,
    minimum: 0,
    nullable: true,
    example: 20000,
    description:
      "(KmWO9gTA) DARVOZA 2 — dvigatel yoqilgan sotuvda kuryer qo'shimcha xarajatining aniq chegarasi, so'm. null — tarif jadvalidagi `address.base − center.base` (teng bo'lsa center.base ning 50%i).",
  })
  @ValidateIf(
    (_o: object, value: unknown) => value !== undefined && value !== null,
  )
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: "extra_cost_limit_amount — son (so'm) yoki null" },
  )
  @MaxDecimals(2, "extra_cost_limit_amount — ko'pi bilan 2 kasrli son")
  @Min(0, { message: "extra_cost_limit_amount manfiy bo'lmasligi kerak" })
  @Max(MONEY_MAX, { message: 'extra_cost_limit_amount juda katta' })
  extra_cost_limit_amount?: number | null;
}

// ------------------------------------------------------------ javob sxemalari

export class DeliveryQuoteRouteDto {
  @ApiProperty({ example: '1' }) from_region_id!: string;
  @ApiProperty({ example: '6' }) to_region_id!: string;
  @ApiProperty({
    description: 'Ikkala uchi ham shahar zonasida — `city` tarifi.',
  })
  city_route!: boolean;
  @ApiProperty({ enum: Where_deliver }) where_deliver!: Where_deliver;
}

export class DeliveryTariffRowDto {
  @ApiProperty({ example: '2' }) id!: string;
  @ApiProperty({ enum: DELIVERY_TARIFF_IDS }) tariff_id!: string;
  @ApiProperty({ example: 40000 }) base_price!: number;
  @ApiProperty({ example: 4000 }) extra_per_kg!: number;
  @ApiProperty({ example: 1 }) days_min!: number;
  @ApiProperty({ example: 2 }) days_max!: number;
  @ApiProperty({ type: String, format: 'date-time' }) valid_from!: string;
  @ApiPropertyOptional() is_active?: boolean;
  @ApiPropertyOptional({ nullable: true, type: String }) created_by?:
    | string
    | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Kim yaratgan (ism; GET /delivery/tariffs da)',
  })
  created_by_name?: string | null;
}

/** `POST /delivery/quote` → `data`. Pul — so'm, vazn — kg. */
export class DeliveryQuoteResultDto {
  @ApiProperty({ enum: DELIVERY_TARIFF_IDS }) tariffId!: string;
  @ApiProperty({ example: 40000 }) base!: number;
  @ApiProperty({ example: 4000 }) perExtraKg!: number;
  @ApiProperty({ nullable: true, example: 1 }) daysMin!: number | null;
  @ApiProperty({ nullable: true, example: 2 }) daysMax!: number | null;
  @ApiProperty({ example: 1.2, description: "Haqiqiy og'irliklar yig'indisi" })
  actualKg!: number;
  @ApiProperty({
    example: 1.98,
    description:
      "Hajmli vazn yig'indisi — chegaradan qat'i nazar har doim hisoblangan qiymat",
  })
  volumetricKg!: number;
  @ApiProperty({
    example: 0,
    description:
      "(AQ9lkgVB) Qo'llangan hajm chegarasi, kg (`volumetric_from_kg`; 0 — chegara yo'q)",
  })
  volumetricFromKg!: number;
  @ApiProperty({
    example: true,
    description:
      "(AQ9lkgVB) Hajm hisobga olindimi: o'lchamli hajmli element bor VA `volumetricKg` ≥ `volumetricFromKg`. false — hisob vazni faqat haqiqiy og'irlikdan",
  })
  volumetricApplied!: boolean;
  @ApiProperty({ example: 2, description: 'Hisob vazni (0.1 kg qadam)' })
  billableKg!: number;
  @ApiProperty({ example: 1 }) extraKg!: number;
  @ApiProperty({ example: 4000 }) extra!: number;
  @ApiProperty({ example: 44000 }) subtotal!: number;
  @ApiProperty({ example: 0 }) expressFee!: number;
  @ApiProperty({
    example: 0,
    description: 'Pickup tashrifi haqi — `total` ga KIRMAYDI.',
  })
  pickupFee!: number;
  @ApiProperty({
    example: 44000,
    description:
      'Yetkazish narxi — 500 ga karrali (YOZILADIGAN qiymat, UI qayta yaxlitlamaydi). Pickup kirmaydi.',
  })
  total!: number;
  @ApiProperty({
    example: 44000,
    description:
      'Kalkulyator jami: subtotal + express + pickup (bitta yaxlitlash).',
  })
  totalWithPickup!: number;
  @ApiProperty({
    enum: ['weight', 'volume'],
    nullable: true,
    description:
      "Hisob vazni qaysi biridan; hech narsa o'lchanmagan — null. `volumetricApplied: false` bo'lsa — `weight` (yoki null)",
  })
  basis!: 'weight' | 'volume' | null;
  @ApiProperty({ example: 0, description: "Og'irligi yo'q elementlar soni" })
  unmeasuredItems!: number;
  @ApiProperty({
    example: 0,
    description: "Hajm hisobi yoqiq, lekin L/W/H yo'q elementlar soni",
  })
  missingDimensionItems!: number;
  @ApiProperty({ description: "Narx taxminiy (o'lchovsiz element bor)" })
  estimated!: boolean;
  @ApiProperty({ type: DeliveryQuoteRouteDto }) route!: DeliveryQuoteRouteDto;
  @ApiProperty({ type: DeliveryTariffRowDto }) tariff!: DeliveryTariffRowDto;
  @ApiProperty({ example: '1' }) settings_id!: string;
  @ApiProperty({ type: [String], description: "Og'irligi yo'q mahsulotlar" })
  unmeasured_product_ids!: string[];
  @ApiProperty({
    type: [String],
    description: "Hajm hisobi yoqiq, o'lchami yo'q mahsulotlar",
  })
  missing_dimension_product_ids!: string[];
}

export class DeliveryQuoteResponseDto {
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiProperty({ example: 'success' }) message!: string;
  @ApiProperty({ type: DeliveryQuoteResultDto }) data!: DeliveryQuoteResultDto;
}

export class DeliveryPricingSettingsRowDto {
  @ApiProperty({ example: '1' }) id!: string;
  @ApiProperty({ example: 5000 }) volumetric_divisor!: number;
  @ApiProperty({
    example: 0,
    description:
      '(AQ9lkgVB) Hajm shu kg dan (≥) boshlab hisobga olinadi; 0 — har doim',
  })
  volumetric_from_kg!: number;
  @ApiProperty({ example: 1 }) first_kg_included!: number;
  @ApiProperty({ example: 0.1 }) min_billable_kg!: number;
  @ApiProperty({ example: 0.1 }) billable_step_kg!: number;
  @ApiProperty({ example: 500 }) round_to!: number;
  @ApiProperty({ example: 20000 }) pickup_fee!: number;
  @ApiProperty({ example: 10, nullable: true }) pickup_free_from_count!:
    | number
    | null;
  @ApiProperty({ example: 1.4 }) express_multiplier!: number;
  @ApiProperty({
    example: null,
    nullable: true,
    type: Number,
    description: '(KmWO9gTA) DARVOZA 1 minimal narxi; null — faqat ulushlar',
  })
  min_delivery_price!: number | null;
  @ApiProperty({
    example: null,
    nullable: true,
    type: Number,
    description:
      '(KmWO9gTA) DARVOZA 2 aniq chegarasi; null — address.base − center.base',
  })
  extra_cost_limit_amount!: number | null;
  @ApiProperty() is_active!: boolean;
  @ApiProperty({ nullable: true, type: String }) created_by!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: "Kim o'zgartirgan (ism; faqat /pricing-settings/history da)",
  })
  created_by_name?: string | null;
}

export class DeliveryPricingSettingsResponseDto {
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiProperty({ example: 'success' }) message!: string;
  @ApiProperty({ type: DeliveryPricingSettingsRowDto })
  data!: DeliveryPricingSettingsRowDto;
}

export class DeliveryTariffVersionDto extends DeliveryTariffRowDto {
  @ApiProperty({ description: 'Hozir amaldagi versiya' }) is_current!: boolean;
  @ApiProperty({ description: 'Kelajakda kuchga kiradi' })
  is_scheduled!: boolean;
}

export class DeliveryTariffsListDataDto {
  @ApiProperty({
    description:
      "Har tarifning hozirgi versiyasi: `{ city, center, address }` (yo'q bo'lsa null).",
    type: 'object',
    additionalProperties: { $ref: getSchemaPath(DeliveryTariffRowDto) },
  })
  current!: Record<string, DeliveryTariffRowDto | null>;
  @ApiProperty({ type: [DeliveryTariffVersionDto] })
  versions!: DeliveryTariffVersionDto[];
}

export class DeliveryTariffsListResponseDto {
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiProperty({ example: 'success' }) message!: string;
  @ApiProperty({ type: DeliveryTariffsListDataDto })
  data!: DeliveryTariffsListDataDto;
}
