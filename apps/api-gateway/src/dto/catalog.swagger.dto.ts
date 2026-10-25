import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import {
  PRODUCT_BARCODE_MAX_LENGTH,
  PRODUCT_DIMENSION_CM_MAX,
  PRODUCT_DIMENSION_CM_MIN,
  PRODUCT_WEIGHT_KG_DECIMALS,
  PRODUCT_WEIGHT_KG_MAX,
  PRODUCT_WEIGHT_KG_MIN,
} from '@app/common';

/** zRqDRLAZ: `numeric(14,2)` chegarasi (catalog-service bilan AYNI). */
const PRODUCT_PRICE_MAX = 999_999_999_999.99;

/**
 * Kasr xonalari soni chegarasi — `IsNumber({ maxDecimalPlaces })` O'RNIGA.
 * class-validator 0.14 da u `value.toString().split('.')[1].length` ni
 * hisoblaydi: 1e-6 dan kichik son eksponent ko'rinishida (`1e-7`) satrga
 * aylanadi, `[1]` — undefined, ValidationPipe ichida TypeError → HTTP 500.
 * Bu yerda qoida catalog-service bilan AYNI: `round(v·10ⁿ)/10ⁿ === v`.
 * Son bo'lmagan / cheksiz qiymat — IsNumber'ning ishi (xabar takrorlanmasin).
 */
const MaxDecimals = (decimals: number, message: string) => {
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

/**
 * zRqDRLAZ: narx multipart'da satr bo'lib keladi. Bo'sh satr / `null` —
 * narxni tozalash (`null`); raqamli satr — son; boshqa qiymat o'zgarishsiz
 * (keyin `IsNumber` uni 400 bilan rad etadi).
 */
const toPriceValue = ({ value }: { value: unknown }): unknown => {
  if (value === null) return null;
  if (typeof value === 'string') {
    const text = value.trim().replace(/\s+/g, '');
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
};

/** zRqDRLAZ: create va update DTO'larida umumiy narx maydoni. */
const PriceField = () =>
  applyDecorators(
    ApiPropertyOptional({
      example: 125000,
      nullable: true,
      minimum: 0,
      description:
        "Mahsulotning ma'lumotnoma narxi (so'm, ko'pi bilan 2 kasr). Ixtiyoriy; bo'sh satr yoki null — narxni tozalaydi. " +
        'Buyurtma summasiga avtomatik yozilmaydi — forma faqat taklif qiladi.',
    }),
    IsOptional(),
    Transform(toPriceValue),
    IsNumber(
      { allowNaN: false, allowInfinity: false },
      { message: "price — 0 dan katta yoki teng, ko'pi bilan 2 kasrli son" },
    ),
    MaxDecimals(2, "price — ko'pi bilan 2 kasrli son"),
    Min(0, { message: "price manfiy bo'lishi mumkin emas" }),
    Max(PRODUCT_PRICE_MAX, { message: 'price juda katta' }),
  );

/**
 * MH-3 (9fHyFp3y): o'lchov multipart'da SATR bo'lib keladi (global
 * ValidationPipe'da `enableImplicitConversion` yo'q). Probellar olinadi,
 * o'nlik vergul nuqtaga (`1,2` → 1.2); o'nlik son yozuvi — son. Boshqa
 * qiymat (`''`, `ikki`, `1e2`) o'zgarishsiz qoladi — keyin IsNumber/IsInt
 * uni 400 bilan rad etadi.
 */
const toMeasureNumber = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  let text = value.trim().replace(/\s+/g, '');
  if (/^-?\d+,\d+$/.test(text)) text = text.replace(',', '.');
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return value;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : value;
};

/**
 * MH-3: multipart'dagi `"true"`/`"false"` (va forma qiymatlari `1/0`,
 * `on/off`). `@Type(() => Boolean)` ISHLATILMAYDI — u `"false"` ni `true`
 * qiladi. Bo'sh satr — berilmagan; boshqa qiymat o'zgarishsiz (IsBoolean 400).
 */
const toOptionalBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const text = value.trim().toLowerCase();
  if (!text) return undefined;
  if (['true', '1', 'on', 'yes'].includes(text)) return true;
  if (['false', '0', 'off', 'no'].includes(text)) return false;
  return value;
};

/**
 * MH-3: majburiy (create — MH-S1) yoki ixtiyoriy (PATCH) o'lchov maydoni.
 * Ixtiyoriyda `IsOptional` EMAS, `ValidateIf(v !== undefined)`: PATCH'da
 * `null` / `''` — 400 (o'lchovni tozalab bo'lmaydi), `IsOptional` esa
 * `null` ni o'tkazib yuborardi.
 */
const measurePresence = (required: boolean, message: string) =>
  required
    ? IsDefined({ message })
    : ValidateIf((_object: object, value: unknown) => value !== undefined);

/** MH-3: og'irlik, kg (kasrli). */
const WeightKgField = (required: boolean) =>
  applyDecorators(
    (required ? ApiProperty : ApiPropertyOptional)({
      type: Number,
      minimum: PRODUCT_WEIGHT_KG_MIN,
      maximum: PRODUCT_WEIGHT_KG_MAX,
      example: 1.2,
      description:
        `Og'irlik, kg (ko'pi bilan ${PRODUCT_WEIGHT_KG_DECIMALS} kasr; multipart'da satr, o'nlik vergul ham qabul qilinadi).` +
        (required
          ? ' Yangi mahsulotda MAJBURIY (MH-S1).'
          : " Berilmasa o'zgarmaydi; null / bo'sh — 400 (o'lchovni tozalab bo'lmaydi)."),
    }),
    measurePresence(required, 'weight_kg majburiy (kg)'),
    Transform(toMeasureNumber),
    IsNumber(
      { allowNaN: false, allowInfinity: false },
      {
        message: `weight_kg — 0 dan katta, ko'pi bilan ${PRODUCT_WEIGHT_KG_DECIMALS} kasrli son (kg)`,
      },
    ),
    MaxDecimals(
      PRODUCT_WEIGHT_KG_DECIMALS,
      `weight_kg — ko'pi bilan ${PRODUCT_WEIGHT_KG_DECIMALS} kasrli son (kg)`,
    ),
    Min(PRODUCT_WEIGHT_KG_MIN, {
      message: "weight_kg 0 dan katta bo'lishi kerak",
    }),
    Max(PRODUCT_WEIGHT_KG_MAX, {
      message: `weight_kg ${PRODUCT_WEIGHT_KG_MAX} kg dan oshmasligi kerak`,
    }),
  );

/** MH-3: o'lcham, sm (butun son). */
const DimensionCmField = (
  field: 'length_cm' | 'width_cm' | 'height_cm',
  label: string,
  example: number,
  required: boolean,
) =>
  applyDecorators(
    (required ? ApiProperty : ApiPropertyOptional)({
      // OpenAPI'da `integer` (butun son) — frontend generatsiyasi uchun.
      type: 'integer',
      minimum: PRODUCT_DIMENSION_CM_MIN,
      maximum: PRODUCT_DIMENSION_CM_MAX,
      example,
      description:
        `${label}, sm (butun son). Uzunlik, kenglik va balandlik birga — uchalasi ham.` +
        (required
          ? ' Yangi mahsulotda MAJBURIY (MH-S1).'
          : " Berilmasa o'zgarmaydi; null / bo'sh — 400."),
    }),
    measurePresence(required, `${field} majburiy (sm)`),
    Transform(toMeasureNumber),
    IsInt({ message: `${field} — butun son (sm)` }),
    Min(PRODUCT_DIMENSION_CM_MIN, {
      message: `${field} ${PRODUCT_DIMENSION_CM_MIN} sm dan kichik bo'lmasligi kerak`,
    }),
    Max(PRODUCT_DIMENSION_CM_MAX, {
      message: `${field} ${PRODUCT_DIMENSION_CM_MAX} sm dan oshmasligi kerak`,
    }),
  );

/** MH-3: «hajmga qarab hisoblash» — sukut bo'yicha YONIQ. */
const VolumetricField = () =>
  applyDecorators(
    ApiPropertyOptional({
      type: Boolean,
      default: true,
      description:
        "Hajmga qarab hisoblash (hajmli vazn = U×K×B / 5000). Yaratishda berilmasa — true. O'chirilsa narx faqat haqiqiy og'irlikdan hisoblanadi. Multipart: 'true'/'false' (1/0, on/off).",
    }),
    ValidateIf((_object: object, value: unknown) => value !== undefined),
    Transform(toOptionalBoolean),
    IsBoolean({ message: 'volumetric_enabled — true yoki false' }),
  );

/**
 * hY7uacJu: zavod shtrix kodi. Bo'sh satr / null — kodsiz (PATCH'da —
 * tozalash). Nazorat raqami (EAN/UPC/GTIN), GS1 va `ELC-P-` taqiqi
 * catalog-service'da tekshiriladi — RMQ yo'llari ham shu qoidaga bo'ysunsin.
 */
const BarcodeField = () =>
  applyDecorators(
    ApiPropertyOptional({
      type: String,
      nullable: true,
      maxLength: PRODUCT_BARCODE_MAX_LENGTH,
      example: '4780000000007',
      description:
        "Zavod shtrix kodi (EAN-13/8, UPC-A, UPC-E, GTIN-14, GS1 DataMatrix/QR yoki zavod QR matni). Ixtiyoriy; bo'sh / null — kodsiz. EAN/UPC/GTIN nazorat raqami tekshiriladi; market ichida yagona (409). GTIN KANONIK shaklda saqlanadi va javobda shunday qaytadi: UPC-A (12) va GTIN-14 → 13 xonali EAN shakli (`036000291452` → `0036000291452`), UPC-E (8 xona, 0/1 bilan boshlanadi) → kengaytirilgan UPC-A ning shu shakli (`04963406` → `0049000006346`), GTIN-8 → 8 xona, indikatorli GTIN-14 o'zicha; DataMatrix/QR'dan GTIN ajratiladi. Satr sifatida yuboring (boshidagi nollar saqlansin). `ELC-P-…` (Elchi kodi) bu yerga yozilmaydi.",
    }),
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim() || null : value,
    ),
    IsOptional(),
    IsString({ message: "barcode satr bo'lishi kerak" }),
    MaxLength(PRODUCT_BARCODE_MAX_LENGTH, {
      message: `barcode ${PRODUCT_BARCODE_MAX_LENGTH} belgidan oshmasligi kerak`,
    }),
  );

export class CreateProductRequestDto {
  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description:
      "Product rasmi. Berilsa gateway uni avtomatik yuklab, `image_url`ni o'zi to'ldiradi.",
  })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiProperty({ example: 'Pepsi' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/product.png',
    description:
      'Ixtiyoriy. Agar `image` yuborilsa bu maydonni yuborish shart emas.',
  })
  @IsOptional()
  @IsString()
  image_url?: string;

  // Pc4CAFdB: mahsulotni faqat xodim yaratadi — `market_id` HAR DOIM
  // majburiy. Tekshiruv handler'da (aniq 400 xabari); pipe darajasida
  // ixtiyoriy qoldirilgan, OpenAPI'da esa majburiy.
  @ApiProperty({
    example: '1',
    description:
      'Mahsulot qaysi marketniki — MAJBURIY (superadmin/admin/registrator/menejer yuboradi). Yuborilmasa 400.',
  })
  @IsOptional()
  @IsString()
  market_id?: string;

  @PriceField()
  price?: number | null;

  // MH-3 (9fHyFp3y, MH-S1): o'lchov yangi mahsulotda MAJBURIY — runtime'da
  // ValidationPipe (IsDefined) va OpenAPI `required` ta'minlaydi. TS turi
  // ixtiyoriy: DTO'ga faqat pipe'dan o'tgandan keyin ishoniladi, servis
  // qatlamida esa o'lchov ixtiyoriy (hamkor yo'li).
  @WeightKgField(true)
  weight_kg?: number;

  @DimensionCmField('length_cm', 'Uzunlik', 30, true)
  length_cm?: number;

  @DimensionCmField('width_cm', 'Kenglik', 22, true)
  width_cm?: number;

  @DimensionCmField('height_cm', 'Balandlik', 15, true)
  height_cm?: number;

  @VolumetricField()
  volumetric_enabled?: boolean;

  @BarcodeField()
  barcode?: string | null;
}

export class UpdateProductRequestDto {
  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    nullable: true,
    description:
      "Product rasmi. Berilsa gateway uni avtomatik yuklab, `image_url`ni o'zi to'ldiradi. " +
      "j4kTqiSQ: `null` (JSON) — saqlangan rasm o'chiriladi.",
  })
  @IsOptional()
  @IsString()
  image?: string | null;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      "j4kTqiSQ: multipart'da rasmni o'chirish (`true`); yangi `image` fayl berilsa e'tiborsiz.",
  })
  @IsOptional()
  @IsIn([true, false, 'true', 'false', '1', '0'])
  remove_image?: boolean | string;

  @ApiPropertyOptional({ example: 'Pepsi Max' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/product-new.png',
    nullable: true,
    description:
      "Ixtiyoriy. Agar `image` yuborilsa bu maydonni yuborish shart emas. j4kTqiSQ: `null` yoki `''` — rasm o'chiriladi.",
  })
  @IsOptional()
  @IsString()
  image_url?: string | null;

  @PriceField()
  price?: number | null;

  // MH-3: PATCH — hammasi ixtiyoriy; berilsa tekshiriladi (null — 400).
  @WeightKgField(false)
  weight_kg?: number;

  @DimensionCmField('length_cm', 'Uzunlik', 30, false)
  length_cm?: number;

  @DimensionCmField('width_cm', 'Kenglik', 22, false)
  width_cm?: number;

  @DimensionCmField('height_cm', 'Balandlik', 15, false)
  height_cm?: number;

  @VolumetricField()
  volumetric_enabled?: boolean;

  @BarcodeField()
  barcode?: string | null;
}

/** hY7uacJu: `GET /product/by-code/:code` qatori (faqat Swagger uchun). */
export class ProductByCodeMarketDto {
  @ApiProperty({ example: '121' })
  id!: string;

  @ApiProperty({ example: 'Mobimax' })
  name!: string;

  @ApiPropertyOptional({
    type: String,
    example: '+998901234567',
    nullable: true,
  })
  phone_number!: string | null;

  @ApiProperty({ example: 'active' })
  status!: string;
}

export class ProductByCodeItemDto {
  @ApiProperty({ example: '7' })
  id!: string;

  @ApiProperty({ example: 'Pepsi 0.5' })
  name!: string;

  @ApiProperty({ example: '121', description: 'Market id' })
  user_id!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  image_url!: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 125000 })
  price!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1.2 })
  weight_kg!: number | null;

  @ApiPropertyOptional({ type: 'integer', nullable: true, example: 30 })
  length_cm!: number | null;

  @ApiPropertyOptional({ type: 'integer', nullable: true, example: 22 })
  width_cm!: number | null;

  @ApiPropertyOptional({ type: 'integer', nullable: true, example: 15 })
  height_cm!: number | null;

  @ApiProperty({ example: true })
  volumetric_enabled!: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '4780000000007',
    description:
      'Zavod shtrix kodi — GTIN kanonik shaklda (UPC-A va UPC-E → 13 xona)',
  })
  barcode!: string | null;

  @ApiProperty({
    example: 'ELC-P-000007',
    description: 'Elchi kodi — avtomatik, o`zgarmas',
  })
  sku_code!: string;

  @ApiPropertyOptional({ type: ProductByCodeMarketDto, nullable: true })
  market!: ProductByCodeMarketDto | null;
}

export class ProductByCodeResponseDto {
  @ApiProperty({ type: [ProductByCodeItemDto] })
  data!: ProductByCodeItemDto[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiPropertyOptional({
    enum: ['sku_code', 'barcode'],
    nullable: true,
    description:
      'Qaysi kod bo`yicha topildi; topilmasa null (data: [] — 404 emas).',
  })
  matched_by!: 'sku_code' | 'barcode' | null;
}
