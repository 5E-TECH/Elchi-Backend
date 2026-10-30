import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, IsOptional, registerDecorator } from 'class-validator';
import {
  normalizeSpecialCategories,
  ORDER_SPECIAL_CATEGORIES,
} from '@app/common';

/**
 * T8 (0OUcHZ7R) — `special_categories` maydoni uchun gateway tekshiruvi.
 * Qoida `normalizeSpecialCategories` da (libs/common/enums): massiv, faqat
 * ma'lum kodlar, takrorsiz. Xabar o'zbekcha va aniq kodni nomlaydi —
 * 400 «Noma'lum maxsus belgi: glass». Kanonik tartibga keltirish
 * order-service'da (yaratish / `order.special_categories.set`).
 */
export function IsOrderSpecialCategories(): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isOrderSpecialCategories',
      target: target.constructor,
      propertyName: String(propertyName),
      validator: {
        validate: (value: unknown) => normalizeSpecialCategories(value).ok,
        defaultMessage: (args) => {
          const result = normalizeSpecialCategories(args?.value);
          return result.ok ? '' : result.message;
        },
      },
    });
  };
}

const SWAGGER_DESCRIPTION =
  "Maxsus belgilar (T8): fragile — mo'rt, religious_book — diniy kitob, liquid — suyuqlik, " +
  'perishable — tez buziladi, battery — batareya, heavy — og‘ir, documents — hujjat. ' +
  "Javobda har doim shu kanonik tartibda. Noma'lum yoki takror kod — 400.";

/** Yaratish DTO'lari: ixtiyoriy, berilmasa `[]`. */
export function OptionalOrderSpecialCategories(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      enum: ORDER_SPECIAL_CATEGORIES,
      isArray: true,
      maxItems: ORDER_SPECIAL_CATEGORIES.length,
      uniqueItems: true,
      example: ['fragile', 'liquid'],
      description: SWAGGER_DESCRIPTION,
    }),
    IsOptional(),
    IsOrderSpecialCategories(),
  );
}

/** PUT /orders/:id/special-categories — to'liq to'plam, `[]` = hammasini olib tashlash. */
export class SetOrderSpecialCategoriesRequestDto {
  @ApiProperty({
    enum: ORDER_SPECIAL_CATEGORIES,
    isArray: true,
    maxItems: ORDER_SPECIAL_CATEGORIES.length,
    uniqueItems: true,
    example: ['fragile', 'liquid'],
    description:
      SWAGGER_DESCRIPTION +
      ' Yangi TO‘LIQ to‘plam yuboriladi; `[]` — barcha belgilarni olib tashlash.',
  })
  // Yo'q maydon `[]` deb talqin qilinmasin — aks holda bo'sh tana belgilarni
  // jimgina o'chirardi.
  @IsDefined({ message: 'special_categories majburiy (bo`sh massiv — `[]`)' })
  @IsOrderSpecialCategories()
  special_categories!: string[];
}
