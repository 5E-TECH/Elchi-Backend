import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  Equals,
  IsArray,
  IsDefined,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  AI_MAX_ITEMS_PER_ORDER,
  AI_MAX_ORDERS_PER_PARSE,
  AI_MAX_QUANTITY,
  AI_TEXT_MAX_CHARS,
  Where_deliver,
} from '@app/common';

/**
 * AI BUYURTMA DTO'LARI — `POST /orders/ai-parse` va `POST /orders/ai-confirm`
 * (C10; kartalar wgqxS0Cp, 32fNx0Ci, NsxoDSmm).
 *
 * ⚠️ Bu DTO AI xatosining bazaga kirishiga OXIRGI to'siq. Qoidalar mavjud
 * `CreateOrderRequestDto` dan ATAYLAB qattiqroq (telefon regex, `@Min(0)`
 * narx, bo'sh bo'lmagan items) — umumiy DTO'ga tegilmaydi, chunki hamkor
 * import yo'llari (orders/external, orders/receive) buzilishi mumkin.
 *
 * ⚠️ `status` maydoni YO'Q: gateway'da `forbidNonWhitelisted: true`, ya'ni
 * `status` yuborilsa 400. Buyurtma har doim sukutdagi NEW holatida yaratiladi.
 * `region_id` qabul qilinadi, lekin HECH QACHON o'qilmaydi — viloyat serverda
 * tuman yozuvidan olinadi.
 */

/** Elchi ID'lari bigint — satr ko'rinishida faqat raqamlar (UUID EMAS). */
const DIGITS_RE = /^\d+$/;
/** Frontend `+998XXXXXXXXX` yuboradi; boshqa har qanday shakl — 400. */
const UZ_PHONE_E164_RE = /^\+998\d{9}$/;

const hasValue = (value: unknown): boolean =>
  value !== undefined && value !== null;

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimOptionalId = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const toLowerCase = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.toLowerCase() : value;

/**
 * Mahsulot qatorida `product_id` va `product_name` IKKALASI birga kelmasin —
 * aks holda qaysi biri ishlatilishi noaniq (katalog mahsuloti yoki erkin
 * matn). Bittasi ham bo'lmasligi `product_id` ning o'z qoidasida ushlanadi.
 */
function OnlyOneProductRef(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'onlyOneProductRef',
      validator: {
        validate: (_value: unknown, args?: ValidationArguments): boolean => {
          const item = (args?.object ?? {}) as {
            product_id?: unknown;
            product_name?: unknown;
          };
          return !(hasValue(item.product_id) && hasValue(item.product_name));
        },
      },
    },
    validationOptions,
  );
}

export class AiParseRequestDto {
  @ApiPropertyOptional({
    example: 'Ali 90 123 45 67 Chilonzor, 2 ta atir 150 ming',
    maxLength: AI_TEXT_MAX_CHARS,
    description:
      'Operator matni (buyurtma yozishmasi). Matn yoki kamida bitta rasm majburiy.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: "text matn bo'lishi kerak" })
  @MaxLength(AI_TEXT_MAX_CHARS, {
    message: `Matn ${AI_TEXT_MAX_CHARS} belgidan oshmasligi kerak`,
  })
  text?: string;

  @ApiPropertyOptional({
    example: '12',
    description:
      'Market ID — faqat admin/superadmin/registrator/menejer uchun majburiy; market va market operatori uchun server o‘zi aniqlaydi (tanadagi qiymat e’tiborsiz).',
  })
  @Transform(trimOptionalId)
  @IsOptional()
  @IsString({ message: "market_id matn bo'lishi kerak" })
  @Matches(DIGITS_RE, {
    message: "market_id faqat raqamlardan iborat bo'lishi kerak",
  })
  market_id?: string;
}

export class AiConfirmCustomerDto {
  @ApiProperty({ example: 'Ali Valiyev', maxLength: 100 })
  @IsString({ message: "Mijoz ismi matn bo'lishi kerak" })
  @IsNotEmpty({ message: 'Mijoz ismi majburiy' })
  @MaxLength(100, { message: 'Mijoz ismi 100 belgidan oshmasligi kerak' })
  name!: string;

  @ApiProperty({
    example: '+998901234567',
    pattern: '^\\+998\\d{9}$',
    description:
      'Faqat +998XXXXXXXXX. Server o‘zi TO‘G‘RILAMAYDI — noto‘g‘ri shakl 400.',
  })
  @IsString({ message: "Telefon raqami matn bo'lishi kerak" })
  @Matches(UZ_PHONE_E164_RE, {
    message: "Telefon raqami +998XXXXXXXXX ko'rinishida bo'lishi kerak",
  })
  phone_number!: string;

  @ApiProperty({
    example: '12',
    description:
      'Tuman ID — buyurtmaning district_id bilan bir xil bo‘lishi shart',
  })
  @IsString({ message: "customer.district_id matn bo'lishi kerak" })
  @Matches(DIGITS_RE, {
    message: "customer.district_id faqat raqamlardan iborat bo'lishi kerak",
  })
  district_id!: string;

  @ApiPropertyOptional({
    example: '97-111-22-33',
    maxLength: 20,
    description: 'Qo‘shimcha raqam (frontend formati XX-XXX-XX-XX)',
  })
  @IsOptional()
  @IsString({ message: "Qo'shimcha raqam matn bo'lishi kerak" })
  @MaxLength(20, { message: "Qo'shimcha raqam 20 belgidan oshmasligi kerak" })
  extra_number?: string;

  @ApiPropertyOptional({ example: 'Chilonzor, 2-kvartal', maxLength: 255 })
  @IsOptional()
  @IsString({ message: "Manzil matn bo'lishi kerak" })
  @MaxLength(255, { message: 'Manzil 255 belgidan oshmasligi kerak' })
  address?: string;
}

export class AiConfirmItemDto {
  @ApiPropertyOptional({
    example: '15',
    description:
      'Katalogdagi mahsulot ID. product_name bilan BIRGA yuborilmaydi — aynan bittasi.',
  })
  @ValidateIf(
    (item: AiConfirmItemDto) =>
      hasValue(item.product_id) || !hasValue(item.product_name),
  )
  @IsString({ message: 'Mahsulot uchun product_id yoki product_name majburiy' })
  @Matches(DIGITS_RE, {
    message: "product_id faqat raqamlardan iborat bo'lishi kerak",
  })
  product_id?: string;

  @ApiPropertyOptional({
    example: 'Atir 50 ml',
    maxLength: 255,
    description:
      'Katalogda yo‘q mahsulot nomi — FAQAT allow_unlisted_product: true bilan.',
  })
  @ValidateIf((item: AiConfirmItemDto) => hasValue(item.product_name))
  @IsString({ message: "product_name matn bo'lishi kerak" })
  @IsNotEmpty({ message: "product_name bo'sh bo'lmasligi kerak" })
  @MaxLength(255, { message: 'product_name 255 belgidan oshmasligi kerak' })
  @OnlyOneProductRef({
    message:
      'Mahsulot uchun product_id YOKI product_name — faqat bittasi yuboriladi',
  })
  product_name?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Operator mahsulotni "katalogda yo‘q" deb ATAYLAB belgilagan. product_name bilan majburiy.',
  })
  // ⚠️ Bayroqsiz erkin matn 400 (wgqxS0Cp #9): AI to'qigan nom operator
  // tasdig'isiz buyurtmaga tushmasin.
  @ValidateIf((item: AiConfirmItemDto) => hasValue(item.product_name))
  @Equals(true, {
    message:
      "Katalogda yo'q mahsulot uchun allow_unlisted_product: true yuborilishi shart",
  })
  allow_unlisted_product?: boolean;

  @ApiProperty({ example: 1, minimum: 1, maximum: AI_MAX_QUANTITY })
  @IsInt({ message: "Mahsulot soni butun son bo'lishi kerak" })
  @Min(1, { message: "Mahsulot soni kamida 1 bo'lishi kerak" })
  @Max(AI_MAX_QUANTITY, {
    message: `Mahsulot soni ${AI_MAX_QUANTITY} dan oshmasligi kerak`,
  })
  quantity!: number;
}

export class AiConfirmOrderDto {
  @ApiProperty({ type: () => AiConfirmCustomerDto })
  @IsDefined({ message: "Mijoz (customer) ma'lumoti majburiy" })
  @IsObject({ message: "customer obyekt bo'lishi kerak" })
  @ValidateNested()
  @Type(() => AiConfirmCustomerDto)
  customer!: AiConfirmCustomerDto;

  @ApiProperty({ example: '12', description: 'Tuman ID (raqam)' })
  @IsString({ message: "district_id matn bo'lishi kerak" })
  @Matches(DIGITS_RE, {
    message: "district_id faqat raqamlardan iborat bo'lishi kerak",
  })
  district_id!: string;

  @ApiPropertyOptional({
    example: '1',
    description:
      'Qabul qilinadi, lekin HECH QACHON ishlatilmaydi — viloyat tuman yozuvidan olinadi.',
  })
  @IsOptional()
  @IsString({ message: "region_id matn bo'lishi kerak" })
  region_id?: string;

  @ApiPropertyOptional({
    example: '3f9b1c9e-5a7d-4c1e-9b3a-2d4e6f8a0b1c',
    description:
      'ai-parse javobidagi draft_id — AI xarajatini yaratilgan buyurtmaga bog‘lash uchun.',
  })
  @IsOptional()
  @IsUUID('all', { message: "draft_id UUID bo'lishi kerak" })
  draft_id?: string;

  @ApiProperty({
    type: () => [AiConfirmItemDto],
    maxItems: AI_MAX_ITEMS_PER_ORDER,
  })
  @IsArray({ message: "items massiv bo'lishi kerak" })
  @ArrayNotEmpty({ message: 'Buyurtmada kamida bitta mahsulot bo‘lishi kerak' })
  @ArrayMaxSize(AI_MAX_ITEMS_PER_ORDER, {
    message: `Bitta buyurtmada ${AI_MAX_ITEMS_PER_ORDER} tadan ortiq mahsulot bo'lmasligi kerak`,
  })
  @ValidateNested({ each: true })
  @Type(() => AiConfirmItemDto)
  items!: AiConfirmItemDto[];

  @ApiProperty({ example: 150000, minimum: 0 })
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: "total_price son bo'lishi kerak" },
  )
  @Min(0, { message: "total_price manfiy bo'lishi mumkin emas" })
  total_price!: number;

  @ApiProperty({ enum: Where_deliver, example: Where_deliver.CENTER })
  @Transform(toLowerCase)
  @IsEnum(Where_deliver, {
    message: "where_deliver faqat 'center' yoki 'address' bo'lishi mumkin",
  })
  where_deliver!: Where_deliver;

  @ApiPropertyOptional({ example: 'Chilonzor, 2-kvartal', maxLength: 255 })
  @IsOptional()
  @IsString({ message: "Manzil matn bo'lishi kerak" })
  @MaxLength(255, { message: 'Manzil 255 belgidan oshmasligi kerak' })
  address?: string;

  @ApiPropertyOptional({
    example: 'Kechqurun qo‘ng‘iroq qiling',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString({ message: "Izoh matn bo'lishi kerak" })
  @MaxLength(1000, { message: 'Izoh 1000 belgidan oshmasligi kerak' })
  comment?: string;

  @ApiPropertyOptional({
    example: 'sevinch',
    maxLength: 100,
    description:
      'Operator nomi — FAQAT matn (varchar). operator_id ga HECH QACHON bog‘lanmaydi.',
  })
  @IsOptional()
  @IsString({ message: "Operator matn bo'lishi kerak" })
  @MaxLength(100, { message: 'Operator nomi 100 belgidan oshmasligi kerak' })
  operator?: string;
}

export class AiConfirmRequestDto {
  @ApiPropertyOptional({
    example: '12',
    description:
      'Market ID — admin/superadmin/registrator/menejer uchun majburiy; market va market operatori uchun e’tiborsiz.',
  })
  @IsOptional()
  @IsString({ message: "market_id matn bo'lishi kerak" })
  @Matches(DIGITS_RE, {
    message: "market_id faqat raqamlardan iborat bo'lishi kerak",
  })
  market_id?: string;

  @ApiPropertyOptional({
    example: '7c2e0f4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
    description:
      'Frontend har yuborishda yangi UUID beradi. Dublikat himoyasi unga TAYANMAYDI (server buyurtma imzosidan foydalanadi).',
  })
  @IsOptional()
  @IsUUID('all', { message: "request_id UUID bo'lishi kerak" })
  request_id?: string;

  @ApiProperty({
    type: () => [AiConfirmOrderDto],
    maxItems: AI_MAX_ORDERS_PER_PARSE,
  })
  @IsArray({ message: "orders massiv bo'lishi kerak" })
  @ArrayNotEmpty({ message: 'Kamida bitta buyurtma yuborilishi kerak' })
  @ArrayMaxSize(AI_MAX_ORDERS_PER_PARSE, {
    message: `Bir yuborishda ${AI_MAX_ORDERS_PER_PARSE} tadan ortiq buyurtma bo'lmasligi kerak`,
  })
  @ValidateNested({ each: true })
  @Type(() => AiConfirmOrderDto)
  orders!: AiConfirmOrderDto[];
}
