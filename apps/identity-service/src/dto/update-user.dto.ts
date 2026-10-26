import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  Commission_type,
  Status,
  Where_deliver,
  IsPasswordPolicy,
} from '@app/common';

/** NFiXfmq6 — market AI buyurtma narxining yuqori chegarasi (so'm). */
export const AI_PRICE_PER_ORDER_MAX_UZS = 1_000_000;

/** (C4R3YyvH) Foydalanuvchi tili — migratsiya 1716000000085 CHECK bilan bir xil. */
export const USER_LANGUAGES = ['uz', 'ru', 'en'] as const;
export type UserLanguage = (typeof USER_LANGUAGES)[number];

export class UpdateUserDto {
  /** (C4R3YyvH) Bildirishnoma/SMS tili — profil tahrirlashda ham. */
  @IsOptional()
  @IsIn(USER_LANGUAGES)
  language?: UserLanguage;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsPhoneNumber('UZ')
  phone_number?: string;

  @IsOptional()
  @IsString()
  @IsPasswordPolicy()
  password?: string;

  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  @IsOptional()
  @IsNumber()
  @Min(0)
  salary?: number;

  @IsOptional()
  @IsNumber()
  payment_day?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;

  @IsOptional()
  @IsBoolean()
  add_order?: boolean;

  @IsOptional()
  @IsBoolean()
  can_add_extra_cost?: boolean;

  @IsOptional()
  @IsBoolean()
  can_sell_cancel?: boolean;

  @IsOptional()
  @IsEnum(Where_deliver)
  default_tariff?: Where_deliver;

  @IsOptional()
  @IsString()
  region_id?: string;

  /**
   * YEThmZBn — tuman: mavjud va foydalanuvchi viloyatiga tegishli bo'lishi
   * kerak (servis tekshiradi); `null` — tozalash.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,19}$/, { message: "district_id raqamli ID bo'lishi kerak" })
  district_id?: string | null;

  // Operator commission config. Used by finance-service to compute per-order
  // earnings when an order created by this operator is sold.
  @IsOptional()
  @IsEnum(Commission_type)
  commission_type?: Commission_type;

  @IsOptional()
  @IsNumber()
  @Min(0)
  commission_value?: number;

  /**
   * NFiXfmq6 — market AI buyurtma narxi (so'm). `null` — global narxga
   * qaytarish, 0 — bepul. Faqat SUPERADMIN/ADMIN va faqat MARKET uchun.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(AI_PRICE_PER_ORDER_MAX_UZS)
  ai_price_per_order?: number | null;

  /**
   * hY7uacJu — market «Ombordan buyurtma yaratish» kaliti. Faqat
   * SUPERADMIN/ADMIN va faqat MARKET uchun.
   */
  @IsOptional()
  @IsBoolean()
  can_order_from_warehouse?: boolean;
}
