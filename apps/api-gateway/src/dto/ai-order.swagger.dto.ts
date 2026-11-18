import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  Equals,
  IsArray,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsBoolean,
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
  ORDER_FULFILLMENT_MODES,
  type OrderFulfillmentMode,
  Where_deliver,
} from '@app/common';
import { OptionalChosenOperatorId } from '../order-create/order-chosen-operator';
import { OptionalOperatorPhone } from '../order-create/order-operator-phone';
import { OptionalOrderSpecialCategories } from '../order-create/order-special-categories';

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

  // (AI ack S5) Swagger'da MAJBURIY; runtime tekshiruvi kontrollerda (400
  // `AI_DRAFT_REQUIRED` + `indexes` shakli saqlanishi uchun class-validator
  // `@IsOptional` qoladi).
  @ApiProperty({
    required: true,
    example: '3f9b1c9e-5a7d-4c1e-9b3a-2d4e6f8a0b1c',
    description:
      'ai-parse javobidagi draft_id — AI xarajatini yaratilgan buyurtmaga bog‘lash uchun. MAJBURIY (AI ack, 2026-11-15): yo‘q bo‘lsa 400 `AI_DRAFT_REQUIRED` (`indexes`). Shu market uchun topilmasa — 400 `AI_DRAFT_NOT_FOUND`.',
  })
  @IsOptional()
  @IsUUID('all', { message: "draft_id UUID bo'lishi kerak" })
  draft_id?: string;

  @ApiProperty({
    required: true,
    example: 0,
    minimum: 0,
    maximum: AI_MAX_ORDERS_PER_PARSE - 1,
    description:
      'Preview’dagi `index` (ai-parse javobi). `draft_id` bilan birga BARQAROR dublikat kaliti (`ai:<market>:<draft>:<index>`), audit (edited_fields) va AI tekshiruvi tasdig‘i uchun. MAJBURIY: yo‘q bo‘lsa 400 `AI_DRAFT_REQUIRED`; saqlangan preview’da bunday `index` bo‘lmasa 400 `AI_DRAFT_ITEM_NOT_FOUND` (`indexes`). Qayta yuborishda O‘ZGARTIRMANG.',
  })
  @IsOptional()
  @IsInt({ message: "ai_item_index butun son bo'lishi kerak" })
  @Min(0, { message: "ai_item_index manfiy bo'lishi mumkin emas" })
  @Max(AI_MAX_ORDERS_PER_PARSE - 1, {
    message: `ai_item_index ${AI_MAX_ORDERS_PER_PARSE - 1} dan oshmasligi kerak`,
  })
  ai_item_index?: number;

  /**
   * AI ack (ega qarori 2026-11-14): operator ko'rib, «baribir yaratish»ni
   * tasdiqlagan BLOKLOVCHI tekshiruv kodlari. Qaysi kod kerakligini server
   * o'zi saqlangan snapshot'dan biladi — bu ro'yxat faqat tasdiq.
   */
  @ApiPropertyOptional({
    type: [String],
    example: ['district_low_confidence', 'price_check'],
    maxItems: 10,
    description:
      'Operator tasdiqlagan bloklovchi AI tekshiruvlari (`district_low_confidence`, `price_check`). ' +
      'Server talab qilinadigan kodlarni ai-parse paytida SAQLANGAN preview’dan oladi (mijoz yuborgan `checks` ga ishonilmaydi). ' +
      'Kerakli kod yo‘q bo‘lsa — butun so‘rov 409 `CHECKS_NOT_ACKNOWLEDGED` (`missing`, `orders[{index, missing}]`), hech narsa yaratilmaydi. ' +
      'Operator tuman (`district_id`) ni o‘zgartirsa `district_low_confidence`, summani (`total_price`) o‘zgartirsa `price_check` talab qilinmaydi. ' +
      'Boshqa (yumshoq) kodlar va ortiqcha kodlar e’tiborsiz qoldiriladi.',
  })
  @IsOptional()
  @IsArray({ message: "ack_checks massiv bo'lishi kerak" })
  @ArrayMaxSize(10, {
    message: "ack_checks 10 tadan ortiq bo'lmasligi kerak",
  })
  @IsString({
    each: true,
    message: "ack_checks elementlari matn bo'lishi kerak",
  })
  @Matches(/^[a-z][a-z_]{0,31}$/, {
    each: true,
    message: "ack_checks elementi tekshiruv kodi bo'lishi kerak",
  })
  ack_checks?: string[];

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

  // Sxemada ixtiyoriy: `replaced_order_id` bilan berilmasa ham bo'ladi —
  // qolgan holatda majburiyligini ValidateIf tutadi.
  @ApiPropertyOptional({
    example: 150000,
    minimum: 0,
    description:
      'Majburiy. Faqat `replaced_order_id` bilan (almashtirish) berilmasa bo‘ladi — buyurtma 0 narx bilan (bepul almashtirish) yaratiladi.',
  })
  // Almashtirish (BeePost): eski buyurtma bog'langan bo'lsa narx so'ralmaydi.
  @ValidateIf(
    (order: AiConfirmOrderDto) =>
      !hasValue(order.replaced_order_id) || hasValue(order.total_price),
  )
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: "total_price son bo'lishi kerak" },
  )
  @Min(0, { message: "total_price manfiy bo'lishi mumkin emas" })
  total_price?: number;

  /**
   * ALMASHTIRISH (kafolat-swap): `POST /orders` dagi `replaced_order_id`
   * bilan AYNI qoida. Egalik/holat/takror — order-service'da (market —
   * server aniqlagan so'rovchi marketi).
   */
  @ApiPropertyOptional({
    example: '1024',
    description:
      'Almashtiriladigan eski buyurtma ID si (ai-parse `replacement_candidates`, GET /orders/replaceable). Faqat shu marketning yetkazilgan buyurtmasi; ' +
      'boshqa marketniki, yetkazilmagan yoki allaqachon almashtirilgani — natijada `create_failed` (sababi bilan).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'number' ? String(value) : value,
  )
  @IsString()
  @Matches(/^\d{1,18}$/, {
    message: "replaced_order_id buyurtma raqami (ID) bo'lishi kerak",
  })
  replaced_order_id?: string;

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
      'Operator nomi — FAQAT matn (varchar); matndan operator_id HECH QACHON aniqlanmaydi. ' +
      '`operator_id` berilsa bu matn e’tiborsiz — buyurtmaga tanlangan operator ismi yoziladi (POST /orders bilan bir xil).',
  })
  @IsOptional()
  @IsString({ message: "Operator matn bo'lishi kerak" })
  @MaxLength(100, { message: 'Operator nomi 100 belgidan oshmasligi kerak' })
  operator?: string;

  /**
   * Formadagi «Operator» tanlovi — `POST /orders` `operator_id` bilan AYNI
   * (DTO tekshiruvi umumiy, server tekshiruvi `createOrderInternal` dagi
   * `resolveChosenOrderOperator`). Har buyurtmaga ALOHIDA.
   */
  @ApiPropertyOptional({
    type: String,
    example: '26',
    description:
      'Tanlangan market operatori ID si (GET /market-operators/selectable ro`yxatidan) — POST /orders `operator_id` bilan AYNI qoida. ' +
      "Buyurtma marketining faol, o'chirilmagan operatori bo'lishi SHART (superadmin/admin ham tekshiriladi); market operatori faqat o'zini tanlay oladi. " +
      'Aks holda SHU buyurtma yaratilmaydi: natijada `ok: false, code: "create_failed"`, `reason` — POST /orders 400 matni ' +
      '(«Tanlangan operator bu marketga tegishli emas yoki faol emas» yoki «Market operatori faqat o‘zini operator qilib tanlay oladi»); ' +
      'partiyadagi boshqa buyurtmalar yaratiladi. To‘g‘ri bo‘lsa buyurtmaga `operator_id` va `operator` = operator ismi yoziladi (`operator` matni e’tiborsiz). ' +
      'Raqam bo‘lmasa — 400 (DTO). Bo‘sh satr — tanlanmagan. Berilmasa — avvalgi xulq (`operator` matni; market operatori — o‘zi; qolganlar — operatorsiz).',
  })
  @OptionalChosenOperatorId()
  operator_id?: string | null;

  /**
   * VRyloH62 — formadagi operator raqami, `POST /orders` `operator_phone`
   * bilan AYNI (DTO tekshiruvi umumiy, 1-/2-raqam qarori
   * `createOrderInternal` dagi `resolveOrderOperatorPhones`). Ilgari bu
   * maydon yo'q edi — `require_operator_phone=true` va doimiy raqamsiz
   * marketda veb AI buyurtmasi DOIM `create_failed` bo'lardi.
   */
  @ApiPropertyOptional({
    example: '+998901234567',
    description:
      'Operator raqami — POST /orders `operator_phone` bilan AYNI qoida (normallashtiriladi: "90 123 45 67", "0901234567" → +998XXXXXXXXX; noto‘g‘ri shakl — 400, bo‘sh satr — yuborilmagan). ' +
      'Market `default_operator_phone` bo‘lsa u 1-raqam, bu esa 2-raqam (bir xil bo‘lsa takrorlanmaydi); ' +
      '`require_operator_phone=true` va default yo‘q bo‘lsa MAJBURIY va 1-raqam bo‘ladi — yuborilmasa SHU buyurtma `ok: false, code: "create_failed"`, ' +
      '`reason` — POST /orders 400 matni («Operator telefon raqami majburiy…»).',
  })
  @OptionalOperatorPhone()
  operator_phone?: string | null;

  @ApiPropertyOptional({
    enum: ORDER_FULFILLMENT_MODES,
    description:
      '6kHnNH9j: shu buyurtma manbasi (auto | hq). Berilmasa — so‘rov darajasidagi `fulfillment`, u ham bo‘lmasa `auto`.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(ORDER_FULFILLMENT_MODES as unknown as string[], {
    message: "fulfillment faqat 'auto' yoki 'hq' bo'lishi mumkin",
  })
  fulfillment?: OrderFulfillmentMode;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'txmkXVBa: mavjud mijoz kartasi shu buyurtmadagi ma`lumot bilan yangilansinmi (POST /orders `update_customer_card` bilan bir xil). Berilmasa — karta o`zgarmaydi.',
  })
  @IsOptional()
  @IsBoolean({ message: "update_customer_card true yoki false bo'lishi kerak" })
  update_customer_card?: boolean;

  /** T8 (0OUcHZ7R): har buyurtmaga alohida (masalan, faqat 2-siga religious_book). */
  @OptionalOrderSpecialCategories()
  special_categories?: string[];
}

export class AiConfirmRequestDto {
  @ApiPropertyOptional({
    enum: ORDER_FULFILLMENT_MODES,
    default: 'auto',
    description:
      '6kHnNH9j: partiyadagi hamma buyurtma manbasi (auto | hq; sukut auto). `orders[i].fulfillment` ustun.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(ORDER_FULFILLMENT_MODES as unknown as string[], {
    message: "fulfillment faqat 'auto' yoki 'hq' bo'lishi mumkin",
  })
  fulfillment?: OrderFulfillmentMode;

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
