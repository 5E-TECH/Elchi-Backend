import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export class UpdateCashboxBalanceDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_id?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  user_id?: string;

  @IsOptional()
  @IsEnum(Cashbox_type)
  cashbox_type?: Cashbox_type;

  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @IsEnum(Operation_type)
  operation_type!: Operation_type;

  @IsEnum(Source_type)
  source_type!: Source_type;

  @IsOptional()
  @IsEnum(PaymentMethod)
  payment_method?: PaymentMethod;

  @IsOptional()
  @IsString()
  comment?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  created_by?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_id?: string | null;

  // Per-attempt idempotency discriminator (see CashboxHistory.dedup_epoch).
  // Free-form token (a timestamp); omitted/'' for non-sell-flow callers.
  @IsOptional()
  @IsString()
  dedup_epoch?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_user_id?: string | null;

  @IsOptional()
  payment_date?: string | Date | null;

  // MinIO object keys of expense-proof files (image/video). Set by
  // order-service for EXTRA_COST events when the market requires proof.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  proof_files?: string[];

  /**
   * (i75GDixP) BRANCH kassasini manfiyga tushirishga ANIQ ruxsat.
   *
   * Faqat order-service outbox'i (sotuv / bekor qilish / qo'shimcha xarajat /
   * tuzatish oyoqlari) `true` yuboradi: filial ulushli sotuv filial kassasini
   * qonuniy manfiyga olib boradi (HQ to'ldiradi) va bu oyoq rad etilsa outbox
   * 10 marta qayta urinib, jimgina tashlab yuborardi. Gateway (PATCH
   * /finance/cashbox/balance) va qo'lda kirim/chiqim (spend/fill) DOIMO
   * `false` yuboradi — gateway whitelist DTO'sida bu maydon YO'Q. Qo'lda
   * oyoq (MANUAL_EXPENSE / MANUAL_INCOME) bayroq bilan ham ruxsat olmaydi.
   * Maydon yo'q (eski, deploydan oldin navbatga tushgan outbox qatori) —
   * eski source_type ro'yxati bo'yicha qaror qilinadi.
   */
  @IsOptional()
  @IsBoolean()
  allow_negative?: boolean;

  /**
   * (QTCUUgjA) Servis ICHIDAGI bayroq: qo'lda kirim/chiqim (`spendMoney` /
   * `fillTheCashbox`) `true` qo'yadi — kassada ochiq smena bo'lishi shart
   * (`FINANCE_REQUIRE_OPEN_SHIFT` yoqilgan bo'lsa). order-service outbox'i
   * (sotuv yo'li) va gateway uni yubormaydi: sotuv smenaga bog'liq emas.
   * Bayroq faqat cheklov QO'SHADI, hech narsani ochmaydi.
   */
  @IsOptional()
  @IsBoolean()
  require_open_shift?: boolean;
}
