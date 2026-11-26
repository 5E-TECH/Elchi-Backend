import { Cashbox_type, Operation_type, Source_type } from '@app/common';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export class FindHistoryDto {
  /** T3 — «Chek holati» filtri (gateway tekshiradi: AI holatlari + `none`). */
  @IsOptional()
  @IsString()
  receipt_status?: string;

  /** ljVOuNz4 — kassa kategoriyasi ID si yoki `none` (kategoriyasiz chiqim). */
  @IsOptional()
  @IsString()
  expense_category_id?: string;

  /**
   * KRN902pg — to'lov usuli: vergul bilan `cash`, `click`, `click_to_market`,
   * `none` (servis tekshiradi, noma'lum → 400).
   */
  @IsOptional()
  @IsString()
  payment_method?: string;

  /** KRN902pg — karta: vergul bilan karta ID'lari va/yoki `none`. */
  @IsOptional()
  @IsString()
  card_id?: string;

  /** T3 — `receipt` blokini qo'shish (FAQAT gateway, SA/admin/menejer). */
  @IsOptional()
  @IsBoolean()
  include_receipts?: boolean;

  /**
   * (2026-11-26, ega) Excel «Yo'nalish» — har to'lov qatoriga `route`
   * (kimdan → kimga: kuryer, filial, asosiy kassa, market). FAQAT gateway
   * Excel eksportlari yoqadi (ommaviy `GET finance/history` DTO sida yo'q).
   */
  @IsOptional()
  @IsBoolean()
  include_route?: boolean;

  /**
   * (2026-11-26, ega) O'tkazma izi juftini «Barchasi» ro'yxatida BITTA qator
   * qilish: chiqim oyog'i ro'yxatdan chiqadi va kirim oyog'iga
   * `pass_through_partner` bo'lib biriktiriladi (sahifalash, `total` va
   * `counts.all` bir xil). FAQAT gateway `GET finance/history` (ekran)
   * yoqadi; Excel va boshqa o'quvchilar ikkala qatorni oladi.
   */
  @IsOptional()
  @IsBoolean()
  collapse_pass_through?: boolean;

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

  @IsOptional()
  @IsEnum(Cashbox_type)
  cashboxType?: Cashbox_type;

  @IsOptional()
  @IsEnum(Operation_type)
  operation_type?: Operation_type;

  @IsOptional()
  @IsEnum(Source_type)
  source_type?: Source_type;

  @IsOptional()
  @IsString()
  sourceTypes?: string;

  @IsOptional()
  @IsString()
  source_types?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_id?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_user_id?: string;

  /**
   * 2026-11-15 — filial bo'yicha manba: `source_user_id = <filial id>` VA faqat
   * filial yozadigan turlar (`branch_to_main` va uning T6 teskari yozuvi).
   * `source_user_id` ustunida foydalanuvchi (market, kuryer) id'lari ham turadi,
   * filial id'lari esa alohida sanaladi — `source_user_id=11` id'si 11 bo'lgan
   * marketga HQ to'lovini ham filial 11 tarixiga olib kelardi.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_branch_id?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  created_by?: string;

  @IsOptional()
  @IsString()
  from_date?: string;

  @IsOptional()
  @IsString()
  to_date?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  limit?: number;
}
