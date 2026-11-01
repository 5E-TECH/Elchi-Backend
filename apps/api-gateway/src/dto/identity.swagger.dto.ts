import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Equals,
  IsArray,
  IsEnum,
  IsIn,
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
import {
  ExpenseProofCondition,
  Roles,
  IsPasswordPolicy,
  PASSWORD_MODES,
  type PasswordMode,
} from '@app/common';

/** (aidsxJ2H) Yaratish DTO'laridagi parol rejimi tavsifi (Swagger). */
const PASSWORD_MODE_DESCRIPTION =
  "(aidsxJ2H) Parolni qanday berish. `generate_sms` (SUKUT) — tizim 12 belgili tasodifiy parol yaratadi va foydalanuvchi telefoniga SMS qiladi (`sms_outbox`, «security» shablon `user.temp_password`); `password` YUBORILMAYDI (400), javobda parol YO'Q, `must_change_password` doim true — birinchi kirishda parol almashtiriladi. `manual` — `password` majburiy, SMS yo'q, `must_change_password` ixtiyoriy. Moslik: `password_mode` yuborilmasa va `password` bor — `manual` (eski forma). Javob `data`: foydalanuvchi + `password_mode` + `password_sms` (`generate_sms` da: `status` `pending | sent | delivered | failed`, `failure_reason`, `failure_message`, `requested_at`, `sent_at`, `delivered_at`, `resend_available_at`, `resends_left_today`; `manual` da `null`). SMS yuborilmasa ham foydalanuvchi yaratiladi (`status: failed` + sabab) — `POST /users/:id/password/resend-sms`.";
const MUST_CHANGE_PASSWORD_DESCRIPTION =
  '(aidsxJ2H) Faqat `manual` da: true — birinchi kirishda parolni almashtirish majburiy (login javobida `must_change_password: true`, almashtirmaguncha boshqa API 403 `PASSWORD_CHANGE_REQUIRED`). `generate_sms` da doim true (false — 400).';
const MANUAL_PASSWORD_DESCRIPTION =
  "(aidsxJ2H) Faqat `password_mode: 'manual'` da (yoki `password_mode` yuborilmagan eski so'rovda). Kamida 8 belgi (xodim — 10), oddiy parollar taqiqlangan";

export class CreateAdminRequestDto {
  @ApiProperty({ example: 'Admin User' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiPropertyOptional({
    example: 'Kuchli-Parol-2026',
    minLength: 10,
    description: MANUAL_PASSWORD_DESCRIPTION,
  })
  @IsOptional()
  @IsString()
  @IsPasswordPolicy(Roles.ADMIN)
  password?: string;

  @ApiPropertyOptional({
    enum: PASSWORD_MODES,
    default: 'generate_sms',
    example: 'generate_sms',
    description: PASSWORD_MODE_DESCRIPTION,
  })
  @IsOptional()
  @IsIn(PASSWORD_MODES)
  password_mode?: PasswordMode;

  @ApiPropertyOptional({
    example: true,
    description: MUST_CHANGE_PASSWORD_DESCRIPTION,
  })
  @IsOptional()
  @IsBoolean()
  must_change_password?: boolean;

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
  /** (C4R3YyvH) Bildirishnoma/SMS tili — `PATCH /auth/my-profile` da ham. */
  @ApiPropertyOptional({ example: 'ru', enum: ['uz', 'ru', 'en'] })
  @IsOptional()
  @IsIn(['uz', 'ru', 'en'])
  language?: 'uz' | 'ru' | 'en';

  @ApiPropertyOptional({ example: 'Admin User Updated' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  @IsOptional()
  @IsPhoneNumber('UZ')
  phone_number?: string;

  @ApiPropertyOptional({
    example: 'Kuchli-Parol-2026',
    minLength: 8,
    description: 'Kamida 8 belgi (xodim — 10), oddiy parollar taqiqlangan',
  })
  @IsOptional()
  @IsString()
  @IsPasswordPolicy()
  password?: string;

  @ApiPropertyOptional({
    example: 'Joriy-Parol-2026',
    description:
      "(aidsxJ2H) O'z parolini almashtirishda (`PATCH /auth/my-profile`, o'zini `PATCH /users/:id`) — joriy parol. Berilsa doim tekshiriladi: noto'g'ri — 400 `OLD_PASSWORD_INVALID` (401 emas), yangisi joriysi bilan bir xil — 400. Berilmasa: `PASSWORD_CHANGE_REQUIRE_OLD=on` da 400 `OLD_PASSWORD_REQUIRED`, sukut (off) da avvalgidek. Admin boshqa foydalanuvchi parolini o'rnatganda kerak emas.",
  })
  @IsOptional()
  @IsString()
  old_password?: string;

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

  // YEThmZBn — ilgari yo'q edi: forbidNonWhitelisted bilan 400.
  @ApiPropertyOptional({
    type: String,
    example: '12',
    nullable: true,
    description:
      'Tuman ID (raqamli satr). Tuman mavjud va foydalanuvchining viloyatiga ' +
      "tegishli bo'lishi kerak: tumanning geografik viloyati (region_id) YOKI " +
      'u biriktirilgan xizmat viloyati (assigned_region), aks holda 400; ' +
      "o'zgarmagan district_id qayta yuborilsa — faqat mavjudligi; viloyati " +
      "yo'q foydalanuvchida (mijoz) — faqat mavjudligi. null — tumanni " +
      "tozalash. Viloyat bu maydon bilan o'zgarmaydi.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,19}$/, { message: "district_id raqamli ID bo'lishi kerak" })
  district_id?: string | null;

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

  /**
   * NFiXfmq6 — market tahrirlash formasidagi "AI buyurtma narxi" (so'm).
   * `null` — global `AI_PRICE_PER_ORDER` (sukut 300) ga qaytarish; 0 — AI
   * bepul. Faqat SUPERADMIN/ADMIN va faqat market yozuvida (aks holda
   * 403/400). Eski AI buyurtmalar qayta hisoblanmaydi.
   */
  @ApiPropertyOptional({
    example: 300,
    nullable: true,
    minimum: 0,
    maximum: 1_000_000,
    description:
      "Market AI buyurtma narxi (so'm, 1 ta buyurtma). null — global narx (AI_PRICE_PER_ORDER, sukut 300); 0 — bepul. Faqat SUPERADMIN/ADMIN.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  ai_price_per_order?: number | null;

  /**
   * hY7uacJu — market tahrirlash formasidagi «Ombor → Ombordan buyurtma
   * yaratish». Faqat SUPERADMIN/ADMIN va faqat market yozuvida (aks holda
   * 403/400). Alohida yo'l ham bor: PATCH /markets/:id/warehouse-order.
   */
  @ApiPropertyOptional({
    example: true,
    description:
      'Market «Ombordan buyurtma yaratish» kaliti (sukut false). Faqat SUPERADMIN/ADMIN, faqat market.',
  })
  @IsOptional()
  @IsBoolean()
  can_order_from_warehouse?: boolean;

  /**
   * KmWO9gTA — market «Vazn va hajm bo'yicha narx» kaliti. Faqat
   * SUPERADMIN/ADMIN va faqat market yozuvida (aks holda 403/400).
   */
  @ApiPropertyOptional({
    example: true,
    description:
      "(KmWO9gTA) Market «Vazn va hajm bo'yicha narx» kaliti (sukut true). FALSE — sotuvda faqat standart narx (tariff_home/tariff_center), vazn/hajm qo'shimchasiz. Faqat SUPERADMIN/ADMIN, faqat market.",
  })
  @IsOptional()
  @IsBoolean()
  weight_volume_pricing?: boolean;
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

  @ApiPropertyOptional({
    example: 'Kuchli-Parol-2026',
    minLength: 8,
    description: MANUAL_PASSWORD_DESCRIPTION,
  })
  @IsOptional()
  @IsString()
  @IsPasswordPolicy(Roles.MARKET)
  password?: string;

  @ApiPropertyOptional({
    enum: PASSWORD_MODES,
    default: 'generate_sms',
    example: 'generate_sms',
    description: PASSWORD_MODE_DESCRIPTION,
  })
  @IsOptional()
  @IsIn(PASSWORD_MODES)
  password_mode?: PasswordMode;

  @ApiPropertyOptional({
    example: true,
    description: MUST_CHANGE_PASSWORD_DESCRIPTION,
  })
  @IsOptional()
  @IsBoolean()
  must_change_password?: boolean;

  @ApiPropertyOptional({
    example: 10000,
    description:
      '(KmWO9gTA) Standart uy narxi — LEGACY, ixtiyoriy. Berilmasa NULL (0 emas); sotuvda dvigatel yoqilganda baza tarif jadvalidan olinadi.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @ApiPropertyOptional({
    example: 8000,
    description:
      '(KmWO9gTA) Standart markaz narxi — LEGACY, ixtiyoriy. Berilmasa NULL (0 emas).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;

  @ApiPropertyOptional({
    example: true,
    description:
      "(KmWO9gTA) «Vazn va hajm bo'yicha narx» (sukut true). Faqat SUPERADMIN/ADMIN (menejer — 403).",
  })
  @IsOptional()
  @IsBoolean()
  weight_volume_pricing?: boolean;

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

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      "w2bDrE3i: market bo'yicha qo'shimcha xarajat ochiq/yopiq (faqat admin/superadmin). Sukut — YOPIQ.",
  })
  @IsOptional()
  @IsBoolean()
  extra_cost_enabled?: boolean;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description:
      "w2bDrE3i: TRUE — qo'shimcha xarajat market tasdig'idan o'tadi; FALSE — tasdiqsiz yoziladi (faqat admin/superadmin).",
  })
  @IsOptional()
  @IsBoolean()
  extra_cost_requires_approval?: boolean;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      "VRyloH62: TRUE — har buyurtmada operator raqami majburiy (doimiy raqam bo'lmasa formada).",
  })
  @IsOptional()
  @IsBoolean()
  require_operator_phone?: boolean;

  @ApiPropertyOptional({
    example: '+998901234567',
    nullable: true,
    description:
      'VRyloH62: marketning doimiy operator raqami — chekda 1-raqam. null — yo`q.',
  })
  @IsOptional()
  @IsPhoneNumber('UZ')
  default_operator_phone?: string | null;
}

export class CreateCourierRequestDto {
  @ApiPropertyOptional({
    example: '12',
    description:
      "Filial ID. Menejer — avtomatik o'z filiali (yuborish shart emas; boshqa filial — 400). " +
      'Superadmin/admin (perqZ3oM) — istalgan FAOL HQ / REGIONAL / HYBRID filial; yuborilmasa — HQ. ' +
      "Noma'lum / nofaol / PICKUP / viloyatsiz filial — 400.",
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

  @ApiPropertyOptional({
    example: 'Kuchli-Parol-2026',
    minLength: 10,
    description: MANUAL_PASSWORD_DESCRIPTION,
  })
  @IsOptional()
  @IsString()
  @IsPasswordPolicy(Roles.COURIER)
  password?: string;

  @ApiPropertyOptional({
    enum: PASSWORD_MODES,
    default: 'generate_sms',
    example: 'generate_sms',
    description: PASSWORD_MODE_DESCRIPTION,
  })
  @IsOptional()
  @IsIn(PASSWORD_MODES)
  password_mode?: PasswordMode;

  @ApiPropertyOptional({
    example: true,
    description: MUST_CHANGE_PASSWORD_DESCRIPTION,
  })
  @IsOptional()
  @IsBoolean()
  must_change_password?: boolean;

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

  // DtKKY0V8 — kuryer tumani yaratishda ham (PATCH /users/:id dagi qoida).
  @ApiPropertyOptional({
    type: String,
    example: '41',
    nullable: true,
    description:
      'DtKKY0V8 — kuryer tumani (raqamli satr). Tuman mavjud va kuryer ' +
      "viloyatiga (filial viloyati) tegishli bo'lishi kerak — tumanning " +
      'geografik viloyati YOKI biriktirilgan xizmat viloyati (assigned_region), aks holda 400 ' +
      '(«Tuman topilmadi» / «Tuman foydalanuvchining viloyatiga tegishli ' +
      "emas»); viloyati yo'q (HQ) — faqat mavjudligi. Berilmasa / null — " +
      'tumansiz. Logistika javob bermasa — 503, kuryer yaratilmaydi.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,19}$/, { message: "district_id raqamli ID bo'lishi kerak" })
  district_id?: string | null;
}

export class CreateManagerRequestDto {
  @ApiProperty({ example: 'Branch manager' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiPropertyOptional({
    example: 'Kuchli-Parol-2026',
    minLength: 10,
    description: MANUAL_PASSWORD_DESCRIPTION,
  })
  @IsOptional()
  @IsString()
  @IsPasswordPolicy(Roles.MANAGER)
  password?: string;

  @ApiPropertyOptional({
    enum: PASSWORD_MODES,
    default: 'generate_sms',
    example: 'generate_sms',
    description: PASSWORD_MODE_DESCRIPTION,
  })
  @IsOptional()
  @IsIn(PASSWORD_MODES)
  password_mode?: PasswordMode;

  @ApiPropertyOptional({
    example: true,
    description: MUST_CHANGE_PASSWORD_DESCRIPTION,
  })
  @IsOptional()
  @IsBoolean()
  must_change_password?: boolean;

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

  @ApiPropertyOptional({
    example: 'Kuchli-Parol-2026',
    minLength: 8,
    description: 'Kamida 8 belgi (xodim — 10), oddiy parollar taqiqlangan',
  })
  @IsOptional()
  @IsString()
  @IsPasswordPolicy(Roles.MARKET)
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

/**
 * (ysBqD9Nx, ega qarori) Market Telegram guruhi kartasida mijoz ismi/telefoni.
 * Sukut TRUE; FALSE — ism yo'q, telefon niqoblangan (+998 90 *** ** 12).
 */
export class UpdateMarketTelegramGroupPiiRequestDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  tg_group_show_customer_pii!: boolean;
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

/**
 * K3scaE0W — PATCH /users/:id/role. Qiymat Roles enum'idan; qaysi rollar
 * almashtirilishi mumkinligini identity hal qiladi (GET /roles →
 * `changeable_roles`: admin, registrator, manager, logist), boshqasi — 400.
 */
export class ChangeUserRoleRequestDto {
  @ApiProperty({
    example: 'manager',
    enum: Roles,
    description:
      "Yangi rol. Faqat GET /roles javobidagi changeable_roles (hozir: admin, registrator, manager, logist) — manba rol ham shu ro'yxatda bo'lishi shart.",
  })
  @IsEnum(Roles)
  role!: Roles;
}

/**
 * w2bDrE3i — `PATCH /admin/markets/:id`: market bo'yicha qo'shimcha xarajat
 * (extra_cost) sozlamasi. Faqat admin/superadmin.
 */
export class UpdateMarketExtraCostRequestDto {
  @ApiPropertyOptional({
    example: true,
    description:
      "Qo'shimcha xarajat shu market buyurtmalariga yozilishi mumkinmi (FALSE — sotuv/bekor qilishda extraCost > 0 → 403).",
  })
  @IsOptional()
  @IsBoolean()
  extra_cost_enabled?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      "TRUE — qo'shimcha xarajat market tasdig'idan o'tadi (202); FALSE — tasdiqsiz darhol yoziladi.",
  })
  @IsOptional()
  @IsBoolean()
  extra_cost_requires_approval?: boolean;
}

/**
 * VRyloH62 — `PATCH /markets/:id/operator-phone`: chekdagi operator raqami
 * sozlamasi. Market — faqat o'zi; admin/superadmin — istalgan market.
 */
export class UpdateMarketOperatorPhoneRequestDto {
  @ApiPropertyOptional({
    example: true,
    description:
      "TRUE — har buyurtmada operator raqami majburiy (doimiy raqam bo'lmasa POST /orders da operator_phone shart, aks holda 400).",
  })
  @IsOptional()
  @IsBoolean()
  require_operator_phone?: boolean;

  @ApiPropertyOptional({
    example: '+998901234567',
    nullable: true,
    description: "Doimiy operator raqami (chekda 1-raqam). null — o'chirish.",
  })
  @IsOptional()
  @IsPhoneNumber('UZ')
  default_operator_phone?: string | null;
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
