import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  Cashbox_type,
  FinancialSource_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';

export class CreateCashboxRequestDto {
  @ApiProperty({ example: '12345' })
  @IsString()
  @Matches(/^\d+$/)
  user_id!: string;

  @ApiProperty({ enum: Cashbox_type, example: Cashbox_type.FOR_COURIER })
  @IsEnum(Cashbox_type)
  cashbox_type!: Cashbox_type;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  balance?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  balance_cash?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  balance_card?: number;
}

export class FindCashboxByUserQueryDto {
  @ApiPropertyOptional({ enum: Cashbox_type })
  @IsOptional()
  @IsEnum(Cashbox_type)
  cashbox_type?: Cashbox_type;

  @ApiPropertyOptional({
    example: 'courier_payment,market_payment,branch_to_main',
    description:
      'Comma-separated source_type list for cashbox history tabs. Omit for all history.',
  })
  @IsOptional()
  @IsString()
  sourceTypes?: string;

  @ApiPropertyOptional({
    example: 'sell,cancel,extra_cost,correction',
    description: 'Snake_case alias for sourceTypes',
  })
  @IsOptional()
  @IsString()
  source_types?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  with_history?: boolean;

  /**
   * FE-PAY-04 / C2: kassa sahifasidagi sana filtri. Ilgari DTO'da yo'q edi —
   * `forbidNonWhitelisted` 400 qaytarardi va sahifa bo'shab qolardi.
   */
  @ApiPropertyOptional({
    example: '2026-10-01',
    description:
      'Tarix boshlanishi: YYYY-MM-DD (Toshkent kuni 00:00) yoki to‘liq ISO',
  })
  @IsOptional()
  @IsString()
  fromDate?: string;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description:
      'Tarix oxiri: YYYY-MM-DD (Toshkent kuni 23:59:59.999) yoki to‘liq ISO',
  })
  @IsOptional()
  @IsString()
  toDate?: string;

  @ApiPropertyOptional({
    example: 1,
    description: '0 yuborilsa pagination o‘chadi va hamma history qaytadi',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  page?: number;

  @ApiPropertyOptional({
    example: 20,
    description: '0 yuborilsa pagination o‘chadi va hamma history qaytadi',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  limit?: number;
}

export class UpdateCashboxBalanceRequestDto {
  @ApiPropertyOptional({ example: '1001' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_id?: string;

  @ApiPropertyOptional({ example: '12345' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  user_id?: string;

  @ApiPropertyOptional({ enum: Cashbox_type })
  @IsOptional()
  @IsEnum(Cashbox_type)
  cashbox_type?: Cashbox_type;

  @ApiProperty({ example: 150000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @ApiProperty({ enum: Operation_type, example: Operation_type.INCOME })
  @IsEnum(Operation_type)
  operation_type!: Operation_type;

  @ApiProperty({ enum: Source_type, example: Source_type.COURIER_PAYMENT })
  @IsEnum(Source_type)
  source_type!: Source_type;

  @ApiPropertyOptional({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsOptional()
  @IsEnum(PaymentMethod)
  payment_method?: PaymentMethod;

  @ApiPropertyOptional({ example: 'Izoh' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiPropertyOptional({ example: '999' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  created_by?: string;

  @ApiPropertyOptional({ example: '777' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_id?: string;

  @ApiPropertyOptional({ example: '555' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_user_id?: string;

  @ApiPropertyOptional({ example: '2026-03-06T11:00:00Z' })
  @IsOptional()
  payment_date?: string;
}

export class FindHistoryQueryDto {
  @ApiPropertyOptional({ example: '1001' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_id?: string;

  @ApiPropertyOptional({ example: '12345' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  user_id?: string;

  @ApiPropertyOptional({ enum: Cashbox_type, description: 'Snake_case filter' })
  @IsOptional()
  @IsEnum(Cashbox_type)
  cashbox_type?: Cashbox_type;

  @ApiPropertyOptional({
    enum: Cashbox_type,
    description: 'CamelCase filter alias',
  })
  @IsOptional()
  @IsEnum(Cashbox_type)
  cashboxType?: Cashbox_type;

  @ApiPropertyOptional({ enum: Operation_type })
  @IsOptional()
  @IsEnum(Operation_type)
  operation_type?: Operation_type;

  @ApiPropertyOptional({ enum: Source_type })
  @IsOptional()
  @IsEnum(Source_type)
  source_type?: Source_type;

  @ApiPropertyOptional({
    example: 'courier_payment,market_payment',
    description:
      'Comma-separated source_type list for tabs like all/payments/sales',
  })
  @IsOptional()
  @IsString()
  sourceTypes?: string;

  @ApiPropertyOptional({
    example: 'sell,cancel,extra_cost,correction',
    description: 'Snake_case alias for sourceTypes',
  })
  @IsOptional()
  @IsString()
  source_types?: string;

  @ApiPropertyOptional({ example: '777' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_id?: string;

  @ApiPropertyOptional({ example: '555' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_user_id?: string;

  @ApiPropertyOptional({ example: '999' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  created_by?: string;

  @ApiPropertyOptional({ example: '2026-03-01T00:00:00Z' })
  @IsOptional()
  @IsString()
  from_date?: string;

  @ApiPropertyOptional({ example: '2026-03-07T23:59:59Z' })
  @IsOptional()
  @IsString()
  to_date?: string;

  @ApiPropertyOptional({
    example: 1,
    description: '0 yuborilsa pagination o‘chadi va hamma history qaytadi',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  page?: number;

  @ApiPropertyOptional({
    example: 20,
    description: '0 yuborilsa pagination o‘chadi va hamma history qaytadi',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  limit?: number;
}

export class OpenShiftRequestDto {
  /**
   * (kfdfYDik) E'tiborga olinmaydi — smenani ochgan odam JWT'dan
   * (`req.user.sub`) olinadi. Eski frontend yuborgani uchun qabul qilinadi.
   */
  @ApiPropertyOptional({
    example: '15',
    description: "E'tiborga olinmaydi — JWT foydalanuvchisi yoziladi",
    deprecated: true,
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  opened_by?: string;

  @ApiPropertyOptional({ example: 100000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  opening_balance_cash?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  opening_balance_card?: number;

  @ApiPropertyOptional({ example: 'Kunlik smena ochildi' })
  @IsOptional()
  @IsString()
  comment?: string;
}

/** (8OYPuz7J, ega S5) POST /finance/shift/close — sanalgan naqd yuborilmasa. */
export const CLOSING_BALANCE_CASH_REQUIRED_MESSAGE =
  'Sanalgan naqd summani kiriting (closing_balance_cash majburiy)';

export class CloseShiftRequestDto {
  @ApiPropertyOptional({ example: '12' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  shift_id?: string;

  @ApiPropertyOptional({ example: '15' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  opened_by?: string;

  /**
   * (kfdfYDik) E'tiborga olinmaydi — smenani yopgan odam JWT'dan
   * (`req.user.sub`) olinadi. Ilgari MAJBURIY edi va `{comment}` bilan
   * yopish har doim 400 qaytarardi.
   */
  @ApiPropertyOptional({
    example: '15',
    description: "E'tiborga olinmaydi — JWT foydalanuvchisi yoziladi",
    deprecated: true,
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  closed_by?: string;

  // (QTCUUgjA) Sanab topshirilgan summa: discrepancy_cash = sanalgan − kutilgan.
  // (8OYPuz7J, ega S5) Sanalgan NAQD MAJBURIY — yopish oynasini chetlab
  // o'tgan API chaqiruvi ham smenani sanalmagan naqd bilan yopolmaydi.
  @ApiProperty({
    example: 120000,
    description:
      'Sanab topshirilgan naqd (MAJBURIY, ega S5). discrepancy_cash = shu − expected_balance_cash',
  })
  @IsDefined({ message: CLOSING_BALANCE_CASH_REQUIRED_MESSAGE })
  @Type(() => Number)
  @IsNumber({}, { message: "closing_balance_cash son bo'lishi kerak" })
  @Min(0, { message: "closing_balance_cash manfiy bo'lmasligi kerak" })
  closing_balance_cash!: number;

  @ApiPropertyOptional({
    example: 50000,
    description:
      "Sanab topshirilgan karta qoldig'i. Yuborilsa discrepancy_card hisoblanadi",
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  closing_balance_card?: number;

  @ApiPropertyOptional({ example: 'Smena yopildi' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiPropertyOptional({
    type: () => [CloseShiftAccountRequestDto],
    description:
      "(kiZgTybn) Har karta / hisob qoldig'ini tasdiqlash. `shift.account_check.enabled` yoqilgan bo'lsa kassaning HAR faol kartasi uchun majburiy (aks holda 400). Rasm majburiy kartada rasm yo'q — 400; farq ≠ 0, AI `mismatch` yoki kiritilgan qiymat rasmdagidan farqli — `comment` majburiy (400). AI natijasi `pending` bo'lsa yopish 30 s gacha kutadi, keyin baribir yopiladi.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CloseShiftAccountRequestDto)
  accounts?: CloseShiftAccountRequestDto[];
}

/** (kiZgTybn) POST /finance/shift/close — `accounts[]` qatori. */
export class CloseShiftAccountRequestDto {
  @ApiProperty({ example: '3', description: 'Kassa kartasi ID si' })
  @IsString()
  @Matches(/^\d+$/)
  card_id!: string;

  @ApiProperty({
    example: 1250000,
    description: "Kassir kiritgan qoldiq (so'm)",
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  entered_balance!: number;

  @ApiPropertyOptional({
    example: 'shift-check-1730000000000-uuid-photo.jpg',
    description:
      'Ixtiyoriy: `POST /finance/shift/account-photo` qaytargan kalit (boshqa kalit — 400). Berilmasa — oxirgi yuklangan rasm.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  photo_file_key?: string;

  @ApiPropertyOptional({ example: 'Bank komissiyasi yechilgan' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

/** (kiZgTybn) POST /finance/shift/account-photo — multipart matn maydonlari. */
export class ShiftAccountPhotoRequestDto {
  @ApiProperty({ example: '3', description: 'Kassa kartasi ID si' })
  @IsString()
  @Matches(/^\d+$/)
  card_id!: string;

  @ApiPropertyOptional({
    example: '12',
    description: 'Smena ID si. Berilmasa — karta kassasining ochiq smenasi',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  shift_id?: string;

  @ApiPropertyOptional({
    example: 1250000,
    description: 'Qoralama: kassir kiritgan qoldiq (yopishda qayta yuboriladi)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  entered_balance?: number;

  @ApiPropertyOptional({ example: 'Izoh' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

/**
 * (kiZgTybn) Faqat Swagger uchun: `photo` fayl maydoni. `@Body()` da
 * ISHLATILMAYDI (fayl multer orqali keladi; whitelist uni rad etardi).
 */
export class ShiftAccountPhotoSwaggerDto extends ShiftAccountPhotoRequestDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description:
      'Qoldiq skrinshoti: jpeg / png / webp, ≤ 5 MB (EXIF tozalanadi)',
  })
  photo!: unknown;
}

/** (kiZgTybn) GET /finance/shift/settings — kassa doirasi. */
export class ShiftSettingsQueryDto {
  @ApiPropertyOptional({
    example: '0',
    description:
      "Kassa: '0' — asosiy (MAIN), aks holda filial ID si (faqat superadmin/admin; menejer — o'z filiali, registrator — '0')",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_user_id?: string;
}

export class ShiftCardSettingRequestDto {
  @ApiProperty({ example: '3' })
  @IsString()
  @Matches(/^\d+$/)
  card_id!: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  require_photo_on_shift_close?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Faqat rasm talab qilinganda yoqiladi (aks holda 400)',
  })
  @IsOptional()
  @IsBoolean()
  ai_check_enabled?: boolean;
}

/** (y8Tqm9Ap) Smenani avtomatik yopish jadvali (qisman yangilanadi). */
export class ShiftAutoCloseSettingsRequestDto {
  @ApiPropertyOptional({
    example: true,
    description:
      "`shift.auto_close.enabled` (sukut false). O'chiq — hech bir smena avtomatik yopilmaydi",
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    example: ['14:00', '23:00'],
    description:
      "`shift.auto_close.times` — kuniga N marta, Toshkent vaqti `HH:MM` (1–12 ta; takrorlar olib tashlanadi, tartiblanadi). Sukut ['23:00']",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { each: true })
  times?: string[];

  @ApiPropertyOptional({
    example: 'main',
    enum: ['main', 'main+branches'],
    description:
      '`shift.auto_close.scope`: `main` — faqat asosiy kassa smenasi (sukut), `main+branches` — filial kassalari ham',
  })
  @IsOptional()
  @IsIn(['main', 'main+branches'])
  scope?: 'main' | 'main+branches';

  @ApiPropertyOptional({
    example: 15,
    description:
      '`shift.auto_close.warn_before_min` (sukut 15; 0 — ogohlantirishsiz): smenani ochgan xodimga yopishdan N daqiqa oldin in-app + Telegram',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(180)
  warn_before_min?: number;
}

/** (gWI4gYkw) Bitta qabul qiluvchi guruhi kanallari. */
export class ShiftReportChannelsRequestDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  telegram?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Tizim (ichki bildirishnoma)',
  })
  @IsOptional()
  @IsBoolean()
  in_app?: boolean;
}

export class ShiftReportRecipientsRequestDto {
  @ApiPropertyOptional({ type: () => ShiftReportChannelsRequestDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShiftReportChannelsRequestDto)
  superadmin?: ShiftReportChannelsRequestDto;

  @ApiPropertyOptional({ type: () => ShiftReportChannelsRequestDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShiftReportChannelsRequestDto)
  couriers?: ShiftReportChannelsRequestDto;

  @ApiPropertyOptional({ type: () => ShiftReportChannelsRequestDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShiftReportChannelsRequestDto)
  markets?: ShiftReportChannelsRequestDto;
}

/** (gWI4gYkw) Smena hisobotini kimlarga / qaysi kanal / qaysi formatda yuborish. */
export class ShiftReportSettingsRequestDto {
  @ApiPropertyOptional({
    type: () => ShiftReportRecipientsRequestDto,
    description:
      "`shift.report.recipients` — superadmin / couriers / markets × telegram / in_app (sukut — hammasi false: hisobot yuborish O'CHIQ, superadmin yoqadi)",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShiftReportRecipientsRequestDto)
  recipients?: ShiftReportRecipientsRequestDto;

  @ApiPropertyOptional({
    example: 'pdf',
    enum: ['pdf', 'xlsx'],
    description: '`shift.report.format` — superadmin ilovasi (sukut pdf)',
  })
  @IsOptional()
  @IsIn(['pdf', 'xlsx'])
  format?: 'pdf' | 'xlsx';
}

/** (kiZgTybn) PATCH /finance/shift/settings — FAQAT superadmin. */
export class UpdateShiftSettingsRequestDto {
  @ApiPropertyOptional({
    example: true,
    description:
      'Global `shift.account_check.enabled` (sukut false): yoqilsa yopishda har faol karta uchun `accounts[]` majburiy',
  })
  @IsOptional()
  @IsBoolean()
  account_check_enabled?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      "Global `shift.photo.required` (sukut true) — master kalit: o'chiq bo'lsa hech bir kartada rasm majburiy emas; yoqiq — karta bo'yicha `require_photo_on_shift_close` hal qiladi",
  })
  @IsOptional()
  @IsBoolean()
  photo_required?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      "Global `shift.ai_check.enabled` (sukut false) — master kalit: o'chiq bo'lsa AI chaqirilmaydi; yoqiq — karta bo'yicha `ai_check_enabled` hal qiladi",
  })
  @IsOptional()
  @IsBoolean()
  ai_check_enabled?: boolean;

  @ApiPropertyOptional({ type: () => [ShiftCardSettingRequestDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ShiftCardSettingRequestDto)
  cards?: ShiftCardSettingRequestDto[];

  @ApiPropertyOptional({
    type: () => ShiftAutoCloseSettingsRequestDto,
    description: '(y8Tqm9Ap) Avtomatik yopish jadvali',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShiftAutoCloseSettingsRequestDto)
  auto_close?: ShiftAutoCloseSettingsRequestDto;

  @ApiPropertyOptional({
    type: () => ShiftReportSettingsRequestDto,
    description: '(gWI4gYkw) Hisobot qabul qiluvchilari, kanallar va format',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShiftReportSettingsRequestDto)
  report?: ShiftReportSettingsRequestDto;
}

/**
 * (32Sw3DfC) GET /finance/shift/current — superadmin/admin filial kassasi
 * sahifasida shu filial smenasini o'qiydi (FAQAT o'qish). Menejer — o'z
 * filiali yoki '0' (HQ asosiy kassa smenasi holati, faqat status).
 */
export class CurrentShiftQueryDto {
  @ApiPropertyOptional({
    example: '13',
    description:
      "Kassa: '0' — asosiy (MAIN), aks holda filial ID si. Superadmin/admin — istalgan filial (mavjud bo'lmasa 404); menejer — o'z filiali yoki '0' (faqat holat); registrator — faqat '0'. Boshqasi — 403",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_user_id?: string;
}

export class FindShiftQueryDto {
  @ApiPropertyOptional({ example: '15' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  opened_by?: string;

  @ApiPropertyOptional({ enum: ['open', 'closed'], example: 'open' })
  @IsOptional()
  @IsString()
  status?: 'open' | 'closed';

  @ApiPropertyOptional({ example: '2026-03-01T00:00:00Z' })
  @IsOptional()
  @IsString()
  from_date?: string;

  @ApiPropertyOptional({ example: '2026-03-07T23:59:59Z' })
  @IsOptional()
  @IsString()
  to_date?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;

  /**
   * (8OYPuz7J, ega S3) Kassa bo'yicha filtr: '0' — markaziy MAIN, aks holda
   * filial ID si. Menejer — faqat o'z filiali (boshqa qiymat — 403).
   */
  @ApiPropertyOptional({
    example: '0',
    description:
      "Kassa: '0' — asosiy (MAIN), aks holda filial ID si. Menejer uchun o'z filiali majburlanadi (boshqasi — 403)",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_user_id?: string;

  @ApiPropertyOptional({
    enum: ['opened_at', 'closed_at'],
    example: 'closed_at',
    description:
      'Saralash maydoni (sukut opened_at). closed_at — ochiq smenalar oxirida',
  })
  @IsOptional()
  @IsIn(['opened_at', 'closed_at'])
  sort_by?: 'opened_at' | 'closed_at';

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    example: 'desc',
    description: "Saralash yo'nalishi (sukut desc)",
  })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort_dir?: 'asc' | 'desc';
}

export class CreateSalaryRequestDto {
  @ApiProperty({ example: '3001' })
  @IsString()
  @Matches(/^\d+$/)
  user_id!: string;

  @ApiProperty({ example: 3000000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  salary_amount!: number;

  @ApiPropertyOptional({ example: 3000000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  have_to_pay?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(31)
  payment_day?: number;
}

export class UpdateSalaryRequestDto {
  @ApiProperty({ example: '3001' })
  @IsString()
  @Matches(/^\d+$/)
  user_id!: string;

  @ApiPropertyOptional({ example: 3500000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  salary_amount?: number;

  @ApiPropertyOptional({ example: 1000000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  have_to_pay?: number;

  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(31)
  payment_day?: number;

  @ApiPropertyOptional({ example: 250000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  increase_have_to_pay_by?: number;
}

export class PaymentFromCourierRequestDto {
  @ApiProperty({ example: '1001' })
  @IsString()
  @Matches(/^\d+$/)
  courier_id!: string;

  @ApiProperty({ example: 250000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsEnum(PaymentMethod)
  payment_method!: PaymentMethod;

  @ApiPropertyOptional({ example: '2002' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({ example: '2026-03-06T11:00:00Z' })
  @IsOptional()
  @IsString()
  payment_date?: string;

  @ApiPropertyOptional({ example: 'Courierdan tolov olindi' })
  @IsOptional()
  @IsString()
  comment?: string;

  // Zv3MLn0a — qabul qiluvchi kassa kartasi.
  @ApiPropertyOptional({
    example: '3',
    description:
      "Zv3MLn0a — pul QABUL QILUVCHI kassaning kartasi ID si (`GET /finance/cashbox/cards`; superadmin/admin — asosiy kassa, menejer — o'z filiali kassasi `?branch_id` siz). Faqat `click` to'lovida (aks holda 400); berilmasa — Asosiy karta. Boshqa kassa (filial) kartasi → 403.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  card_id?: string;
}

/**
 * (2crjWf7v #4) Kuryerning kvitansiyaga javobi (bot tugmalari). FAQAT audit
 * yozuvi — kassaga ta'sir qilmaydi.
 */
export class CourierPaymentAckRequestDto {
  @ApiProperty({ enum: ['confirmed', 'disputed'], example: 'confirmed' })
  @IsIn(['confirmed', 'disputed'])
  ack!: 'confirmed' | 'disputed';

  @ApiPropertyOptional({ example: 'Summa kam yozilgan', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

export class PaymentToMarketRequestDto {
  @ApiProperty({ example: '2002' })
  @IsString()
  @Matches(/^\d+$/)
  market_id!: string;

  @ApiProperty({ example: 500000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsEnum(PaymentMethod)
  payment_method!: PaymentMethod;

  @ApiPropertyOptional({ example: '2026-03-06T12:00:00Z' })
  @IsOptional()
  @IsString()
  payment_date?: string;

  @ApiPropertyOptional({ example: 'Marketga pul o‘tkazma' })
  @IsOptional()
  @IsString()
  comment?: string;

  // (3PE0B03q) Ilgari DTO'da yo'q edi → "property source_user_id should
  // not exist" (400) va to'lov o'tmasdi.
  @ApiPropertyOptional({
    example: '7',
    description:
      "O'tkazma manbasi (click): o'tkazmani qilgan xodim ID si. Faqat audit — tarixda `transfer_source_user_id` bo'lib saqlanadi; pul baribir asosiy kassaning balance_card idan yechiladi. Naqd (cash) to'lovda e'tiborga olinmaydi.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_user_id?: string;

  // 3PE0B03q — nomli karta (BeePost cashbox_card porti).
  @ApiPropertyOptional({
    example: '3',
    description:
      "Asosiy kassaning NOMLI kartasi ID si (`GET /finance/cashbox/cards`). Faqat `click` to'lovida; berilmasa — Asosiy karta. Nomli kartada mablag' yetmasa 400.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  card_id?: string;
}

export class PaymentBranchToMainRequestDto {
  @ApiProperty({
    example: '13',
    description: 'Branch ID (branch cashboxdan yechiladi)',
  })
  @IsString()
  @Matches(/^\d+$/)
  branch_id!: string;

  @ApiProperty({ example: 250000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsEnum(PaymentMethod)
  payment_method!: PaymentMethod;

  @ApiPropertyOptional({ example: '2026-03-06T11:00:00Z' })
  @IsOptional()
  @IsString()
  payment_date?: string;

  @ApiPropertyOptional({
    example: "Branch managerdan HQ main kassaga o'tkazma",
  })
  @IsOptional()
  @IsString()
  comment?: string;

  // (3PE0B03q) Ilgari DTO'da yo'q edi → 400 "property source_user_id should
  // not exist".
  @ApiPropertyOptional({
    example: '7',
    description:
      "O'tkazma manbasi (click): o'tkazmani qilgan xodim ID si. Faqat audit — tarixda `transfer_source_user_id` bo'lib saqlanadi; pul filial kassasining va asosiy kassaning balance_card idan harakatlanadi. Naqd (cash) to'lovda e'tiborga olinmaydi.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_user_id?: string;

  // 3PE0B03q — nomli karta (BeePost cashbox_card porti).
  @ApiPropertyOptional({
    example: '3',
    description:
      "Asosiy kassaning NOMLI kartasi ID si (`GET /finance/cashbox/cards`). Faqat `click` to'lovida; berilmasa — Asosiy karta. Nomli kartada mablag' yetmasa 400.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  card_id?: string;

  // Zv3MLn0a — filial oyog'i kartasi.
  @ApiPropertyOptional({
    example: '7',
    description:
      "Zv3MLn0a — pul chiqadigan FILIAL kassasining kartasi ID si (`GET /finance/cashbox/cards?branch_id=`). Faqat `click` to'lovida; berilmasa — filialning Asosiy kartasi. Boshqa kassa kartasi → 403, mablag' yetmasa 400.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  branch_card_id?: string;
}

export class MainCashboxFilterQueryDto {
  @ApiPropertyOptional({ example: '2026-03-01T00:00:00Z' })
  @IsOptional()
  @IsString()
  fromDate?: string;

  @ApiPropertyOptional({ example: '2026-03-07T23:59:59Z' })
  @IsOptional()
  @IsString()
  toDate?: string;

  @ApiPropertyOptional({
    example: 'courier_payment,market_payment',
    description:
      'Comma-separated source_type list. Omit for all history; use payment types for Oldi-berdi.',
  })
  @IsOptional()
  @IsString()
  sourceTypes?: string;

  @ApiPropertyOptional({
    example: 'sell,cancel,extra_cost,correction',
    description: 'Snake_case alias for sourceTypes',
  })
  @IsOptional()
  @IsString()
  source_types?: string;
}

export class CashboxAllInfoQueryDto {
  @ApiPropertyOptional({ enum: Operation_type })
  @IsOptional()
  @IsEnum(Operation_type)
  operationType?: Operation_type;

  @ApiPropertyOptional({ enum: Source_type })
  @IsOptional()
  @IsEnum(Source_type)
  sourceType?: Source_type;

  @ApiPropertyOptional({ example: '101' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  createdBy?: string;

  @ApiPropertyOptional({ enum: Cashbox_type })
  @IsOptional()
  @IsEnum(Cashbox_type)
  cashboxType?: Cashbox_type;

  @ApiPropertyOptional({ example: '2026-03-01T00:00:00Z' })
  @IsOptional()
  @IsString()
  fromDate?: string;

  @ApiPropertyOptional({ example: '2026-03-07T23:59:59Z' })
  @IsOptional()
  @IsString()
  toDate?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}

export class MainCashboxManualRequestDto {
  @ApiProperty({ example: 150000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @ApiPropertyOptional({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsOptional()
  @IsEnum(PaymentMethod)
  type?: PaymentMethod;

  @ApiPropertyOptional({ example: 'Manual operatsiya' })
  @IsOptional()
  @IsString()
  comment?: string;

  // 3PE0B03q / Zv3MLn0a — karta (BeePost cashbox_card porti).
  @ApiPropertyOptional({
    example: '3',
    description:
      "Kassa kartasi ID si (`GET /finance/cashbox/cards`): superadmin/admin — asosiy kassa kartasi, menejer — o'z filiali kassasi kartasi (boshqa kassa kartasi → 403). Faqat `click` to'lovida; berilmasa — Asosiy karta. Kartada mablag' yetmasa 400.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  card_id?: string;
}

/** (Elchi Pochta №1) Kategoriyasiz / noto'g'ri kategoriya bilan chiqim — 400 matni. */
export const SPEND_CATEGORY_REQUIRED_MESSAGE = 'Xarajat kategoriyasini tanlang';

/**
 * PATCH /finance/cashbox/spend — qo'lda chiqim. Kirim (`/cashbox/fill`)
 * kategoriya QABUL QILMAYDI (whitelist — 400).
 *
 * (Elchi Pochta №1, 2026-10-22) HTTP orqali chiqimda kategoriya MAJBURIY,
 * izoh (`comment`) ixtiyoriy. Majburiylik FAQAT shu DTO'da: finance-service
 * `finance.cashbox.spend` handleri kategoriyasiz ichki chiqimni ham qabul
 * qiladi (investor foyda to'lovi va boshqa servis→servis chaqiruvlari).
 */
export class MainCashboxSpendRequestDto extends MainCashboxManualRequestDto {
  // Elchi Pochta №1 — kassa xarajati kategoriyasi.
  @ApiProperty({
    example: '2',
    description:
      "MAJBURIY. Kassa xarajati kategoriyasi ID si (`GET /finance/cashbox/expense-categories`), raqamli satr. Yo'q, bo'sh yoki raqam emas → 400 «Xarajat kategoriyasini tanlang»; mavjud bo'lmagan / o'chirilgan → 400 «Xarajat kategoriyasi topilmadi yoki o'chirilgan — ro'yxatdan faol kategoriya tanlang». Tarix qatorida `expense_category_id` + `expense_category_name` bo'lib qaytadi. `comment` ixtiyoriy.",
  })
  // `Matches` satr bo'lmagan qiymatni ham rad etadi (IsString shu yerda) —
  // bitta qoida → 400 javobida bitta toza xabar (takrorsiz).
  @Matches(/^\d+$/, { message: SPEND_CATEGORY_REQUIRED_MESSAGE })
  expense_category_id!: string;
}

// ───────── Elchi Pochta №1 — kassa xarajatlari kategoriyalari (superadmin) ─────────

export class CreateCashboxExpenseCategoryRequestDto {
  @ApiProperty({ example: "Yoqilg'i" })
  @IsString()
  @Length(1, 100)
  name!: string;

  @ApiPropertyOptional({
    example: 'Benzin, gaz, dizel',
    description: 'Nimalar kiradi',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    example: 18,
    description: "Ro'yxatdagi o'rni (kichigi tepada). Berilmasa — oxiriga.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  sort_order?: number;
}

export class UpdateCashboxExpenseCategoryRequestDto {
  @ApiPropertyOptional({ example: "Yoqilg'i va moy" })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional({
    example: 'Benzin, gaz, dizel, moy',
    nullable: true,
    description: "Nimalar kiradi; `null` yoki '' — tavsifni tozalash",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  sort_order?: number;
}

// ───────── 3PE0B03q — asosiy kassa NOMLI kartalari (BeePost cashbox_card) ─────────

/** Zv3MLn0a — karta / hisob turi (finance `CashboxCardKind` bilan bir xil). */
export enum CashboxCardKindDto {
  VIRTUAL_CARD = 'virtual_card',
  PLASTIC_CARD = 'plastic_card',
  BANK_ACCOUNT = 'bank_account',
}

/** Zv3MLn0a — 4 raqamdan uzun / raqam bo'lmagan `last4` — 400 matni. */
export const CARD_LAST4_DTO_MESSAGE =
  "last4 — aniq 4 ta raqam (to'liq karta yoki hisob raqami qabul qilinmaydi)";

/**
 * Zv3MLn0a — karta tafsilotlari (yaratish va tahrirlashda umumiy). To'liq
 * karta (PAN) / hisob raqami QABUL QILINMAYDI — faqat `last4`.
 */
export class CashboxCardDetailsRequestDto {
  @ApiPropertyOptional({
    enum: CashboxCardKindDto,
    example: CashboxCardKindDto.VIRTUAL_CARD,
    description:
      'Turi: virtual_card (bank ilovasidagi karta), plastic_card (Uzcard/Humo/Visa), bank_account (korxona hisobi).',
  })
  @IsOptional()
  @IsEnum(CashboxCardKindDto)
  kind?: CashboxCardKindDto;

  @ApiPropertyOptional({ example: 'Agrobank', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bank_name?: string;

  @ApiPropertyOptional({
    example: 'Uzcard',
    maxLength: 30,
    description: '«Karta tizimi» (Uzcard, Humo, Visa …); hisob raqamida bo`sh.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  card_network?: string;

  @ApiPropertyOptional({
    example: '1234',
    description:
      "FAQAT oxirgi 4 raqam (`^\\d{4}$`). 4 raqamdan uzun qiymat (to'liq karta / hisob raqami) → 400. `''` — tozalash.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^(\d{4})?$/, { message: CARD_LAST4_DTO_MESSAGE })
  last4?: string;

  @ApiPropertyOptional({ example: 'Shodiyor Ergashev', maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  holder_name?: string;

  @ApiPropertyOptional({ example: 'Click to`lovlari uchun', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Smena yopishda shu kartaning qoldiq skrinshoti talab qilinadi. FAQAT superadmin (admin → 403). `false` — AI tekshiruvi ham o`chadi.',
  })
  @IsOptional()
  @IsBoolean()
  require_photo_on_shift_close?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      'Skrinshot AI bilan tekshiriladi. FAQAT superadmin (admin → 403); faqat rasm talab qilinganda (aks holda 400).',
  })
  @IsOptional()
  @IsBoolean()
  ai_check_enabled?: boolean;
}

export class CreateCashboxCardRequestDto extends CashboxCardDetailsRequestDto {
  @ApiProperty({ example: 'Humo 8600' })
  @IsString()
  @Length(1, 100)
  name!: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort_order?: number;

  @ApiPropertyOptional({
    example: '13',
    description:
      "Zv3MLn0a — filial (BRANCH) kassasiga karta: filial ID si. Berilmasa — asosiy (MAIN) kassa. Filial kassasi yo'q bo'lsa 404.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  branch_id?: string;

  @ApiPropertyOptional({
    example: false,
    description:
      '«Asosiy karta qilish»: yaratilgan karta darhol kassaning Asosiy kartasi bo`ladi (karta tanlanmagan to`lovlar shu kartaga). Eski Asosiy karta nomli bo`lib, qoldig`ini saqlaydi.',
  })
  @IsOptional()
  @IsBoolean()
  make_default?: boolean;
}

/**
 * Zv3MLn0a — PATCH /finance/cashbox/cards/:id: nom va tafsilotlar (hammasi
 * ixtiyoriy). Asosiy kartada ham ishlaydi; Asosiy kartaning NOMI o'zgarmaydi.
 */
export class UpdateCashboxCardRequestDto extends CashboxCardDetailsRequestDto {
  @ApiPropertyOptional({
    example: 'Uzcard 5614',
    description: 'Asosiy kartada nomni o`zgartirish → 400.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort_order?: number;
}

export class RenameCashboxCardRequestDto {
  @ApiProperty({ example: 'Uzcard 5614' })
  @IsString()
  @Length(1, 100)
  name!: string;
}

export class SetCashboxCardStatusRequestDto {
  @ApiProperty({
    example: false,
    description: 'false — arxivlash (balans 0 bo`lishi shart)',
  })
  @IsBoolean()
  is_active!: boolean;
}

export class TransferCashboxCardRequestDto {
  @ApiProperty({ example: '1', description: 'Manba karta ID' })
  @IsString()
  @Matches(/^\d+$/)
  from_card_id!: string;

  @ApiProperty({ example: '3', description: 'Maqsad karta ID' })
  @IsString()
  @Matches(/^\d+$/)
  to_card_id!: string;

  @ApiProperty({ example: 500000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiProperty({
    example: 'Humo kartaga o`tkazildi',
    description: 'Sabab (majburiy)',
  })
  @IsString()
  @Length(1, 1000)
  comment!: string;
}

export enum CashboxCardConvertType {
  CARD_TO_CASH = 'card_to_cash',
  CASH_TO_CARD = 'cash_to_card',
}

export class ConvertCashboxCardRequestDto {
  @ApiProperty({
    enum: CashboxCardConvertType,
    example: CashboxCardConvertType.CARD_TO_CASH,
  })
  @IsEnum(CashboxCardConvertType)
  type!: CashboxCardConvertType;

  @ApiProperty({ example: '3', description: 'Karta ID' })
  @IsString()
  @Matches(/^\d+$/)
  card_id!: string;

  @ApiProperty({ example: 500000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiProperty({
    example: 'Bankomatdan yechildi',
    description: 'Sabab (majburiy)',
  })
  @IsString()
  @Length(1, 1000)
  comment!: string;
}

export class RecordFinancialBalanceRequestDto {
  @ApiProperty({
    example: -50000,
    description:
      'Signed amount: positive = income, negative = expense. Match the sign to source_type.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(-1e15)
  @Max(1e15)
  amount!: number;

  @ApiProperty({
    enum: FinancialSource_type,
    example: FinancialSource_type.MANUAL_EXPENSE,
  })
  @IsEnum(FinancialSource_type)
  source_type!: FinancialSource_type;

  @ApiPropertyOptional({ example: '1001', description: 'Linked order id' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  order_id?: string;

  @ApiPropertyOptional({
    example: '7',
    description: 'Linked user id (market/courier/employee)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  related_user_id?: string;

  @ApiPropertyOptional({ example: 'Ofis ijarasi' })
  @IsOptional()
  @IsString()
  comment?: string;
}

export class CreateOperatorPaymentRequestDto {
  @ApiProperty({
    example: '42',
    description: 'Operator user id (bigint string)',
  })
  @IsString()
  @Matches(/^\d+$/, {
    message: 'operator_id must be a bigint-like numeric string',
  })
  operator_id!: string;

  @ApiPropertyOptional({
    example: '7',
    description: 'Market id (bigint string)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, {
    message: 'market_id must be a bigint-like numeric string',
  })
  market_id?: string;

  @ApiProperty({ example: 50000, description: 'Payout amount' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @ApiPropertyOptional({ example: 'Oylik komissiya to`lovi' })
  @IsOptional()
  @IsString()
  note?: string;
}

// --- GET /finance/cashbox/hq-couriers (C1) — faqat javob hujjati ---

export class HqCourierCashboxDto {
  @ApiProperty({ example: '812' })
  id!: string;

  @ApiProperty({ example: 1250000 })
  balance!: number;

  @ApiProperty({ example: 1250000 })
  balance_cash!: number;

  @ApiProperty({ example: 0 })
  balance_card!: number;
}

export class HqCourierReceivableItemDto {
  @ApiProperty({ example: '263', description: 'Kuryer user id' })
  id!: string;

  @ApiProperty({
    example: 'Ali Valiyev',
    description:
      "Manba tartibi: identity (`identity.courier.find_by_ids`, bo'lsa) → branch_users qatori ma'lumoti (`row.user`) → ''. Soft-delete qilingan kuryerni identity bermaydi — uning qatori puli bor ekan ro'yxatda qoladi (odatda ''), naqdi C4 orqali qabul qilinadi",
  })
  name!: string;

  @ApiPropertyOptional({
    example: '+998901234567',
    nullable: true,
    description: 'identity → branch_users qatori → null',
  })
  phone_number!: string | null;

  @ApiProperty({
    example: 'active',
    description:
      "identity → branch_users qatori → ''. Bloklangan/nofaol kuryer ham ro'yxatda qoladi (puli bor)",
  })
  status!: string;

  @ApiProperty({
    example: 1250000,
    description: 'FOR_COURIER kassa balansi (> 0)',
  })
  balance!: number;

  @ApiProperty({ type: HqCourierCashboxDto })
  cashbox!: HqCourierCashboxDto;
}

export class HqCourierReceivablesDataDto {
  @ApiProperty({
    type: [HqCourierReceivableItemDto],
    description:
      "Faol HQ branch_users qatori (COURIER) bo'lgan, kassasi > 0 kuryerlar; balans bo'yicha kamayish tartibida",
  })
  items!: HqCourierReceivableItemDto[];

  @ApiProperty({ example: 1, description: 'items dagi kuryerlar soni' })
  total!: number;

  @ApiProperty({ example: '1' })
  hq_branch_id!: string;
}

export class HqCourierReceivablesResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'HQ kuryerlari (qabul qilinishi kerak)' })
  message!: string;

  @ApiProperty({ type: HqCourierReceivablesDataDto })
  data!: HqCourierReceivablesDataDto;
}

/**
 * qzjTMWPb — GET /finance/history/daily: kunlik kirim/chiqim agregati va kun
 * boshi / oxiri qoldig'i. Sana — faqat 'YYYY-MM-DD' (Toshkent kuni).
 */
export class HistoryDailyQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    description:
      'Toshkent kuni (YYYY-MM-DD). Berilmasa — to_date dan 13 kun oldin (oxirgi 14 kun). Oraliq ≤ 366 kun.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from_date?: string;

  @ApiPropertyOptional({
    example: '2026-10-08',
    description: 'Toshkent kuni (YYYY-MM-DD). Berilmasa — bugun.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to_date?: string;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'from_date aliasi',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  fromDate?: string;

  @ApiPropertyOptional({ example: '2026-10-08', description: 'to_date aliasi' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  toDate?: string;

  @ApiPropertyOptional({ example: '1001' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_id?: string;

  @ApiPropertyOptional({ example: '12345' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  user_id?: string;

  @ApiPropertyOptional({ enum: Cashbox_type })
  @IsOptional()
  @IsEnum(Cashbox_type)
  cashbox_type?: Cashbox_type;

  @ApiPropertyOptional({
    enum: Cashbox_type,
    description: 'cashbox_type aliasi',
  })
  @IsOptional()
  @IsEnum(Cashbox_type)
  cashboxType?: Cashbox_type;

  @ApiPropertyOptional({ enum: Operation_type })
  @IsOptional()
  @IsEnum(Operation_type)
  operation_type?: Operation_type;

  @ApiPropertyOptional({ enum: Source_type })
  @IsOptional()
  @IsEnum(Source_type)
  source_type?: Source_type;

  @ApiPropertyOptional({ example: 'courier_payment,market_payment' })
  @IsOptional()
  @IsString()
  source_types?: string;

  @ApiPropertyOptional({ description: 'source_types aliasi' })
  @IsOptional()
  @IsString()
  sourceTypes?: string;

  @ApiPropertyOptional({ example: '555' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_user_id?: string;

  @ApiPropertyOptional({ example: '999' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  created_by?: string;
}

/** qzjTMWPb — GET /finance/financial-balance/daily. */
export class FinancialBalanceDailyQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    description:
      'Toshkent kuni (YYYY-MM-DD). Berilmasa — to_date dan 13 kun oldin. Oraliq ≤ 366 kun.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from_date?: string;

  @ApiPropertyOptional({
    example: '2026-10-08',
    description: 'Berilmasa — bugun.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to_date?: string;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'from_date aliasi',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  fromDate?: string;

  @ApiPropertyOptional({ example: '2026-10-08', description: 'to_date aliasi' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  toDate?: string;
}

/** uzWcMR1C — GET /finance/cashbox/payments-meta. */
export class PaymentsMetaQueryDto {
  @ApiPropertyOptional({
    example: 3,
    description: 'Top marketlar soni (0–10, sukut 3); qolgani «Yana N ta».',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  top?: number;
}
