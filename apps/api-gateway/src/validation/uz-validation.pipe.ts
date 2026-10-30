import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { translateValidationMessages } from '@app/common';
import { CreatePartnerMarketRequestDto } from '../dto/partner-market.swagger.dto';
import {
  CreatePartnerShipmentRequestDto,
  PartnerShipmentsStatusRequestDto,
  UpdatePartnerShipmentRequestDto,
} from '../dto/partner-shipment.swagger.dto';

/**
 * (ZDweRm02) Hamkor API (`/partner/*`) DTO'lari tarjima qilinmaydi: matn —
 * tashqi shartnoma (`docs/public/MARKETPLACE_API.md` da
 * `property … should not exist` ochiq yozilgan). Yangi `/partner/*` DTO'si shu
 * ro'yxatga qo'shiladi — spec kontroller metadata'sidan tekshiradi. Ichki
 * `/admin/partners` DTO'lari ro'yxatda YO'Q: u yerda Elchi xodimi ishlaydi.
 */
const PARTNER_API_DTOS: ReadonlySet<unknown> = new Set([
  CreatePartnerMarketRequestDto,
  CreatePartnerShipmentRequestDto,
  PartnerShipmentsStatusRequestDto,
  UpdatePartnerShipmentRequestDto,
]);

export function shouldTranslateValidation(
  metatype: ArgumentMetadata['metatype'],
): boolean {
  return !PARTNER_API_DTOS.has(metatype);
}

/**
 * (ZDweRm02) Global ValidationPipe — class-validator'ning inglizcha xabarlari
 * o'zbekchaga (`translateValidationMessage`). Konvert O'ZGARMAYDI: 400
 * `BadRequestException`, `message: string[]` (AllExceptionsFilter ularni `. `
 * bilan qo'shadi), `error: 'Bad Request'`. DTO'dagi maxsus xabarlar saqlanadi.
 */
export class UzValidationPipe extends ValidationPipe {
  async transform(value: unknown, metadata: ArgumentMetadata) {
    try {
      return (await super.transform(value, metadata)) as unknown;
    } catch (error) {
      if (
        error instanceof BadRequestException &&
        shouldTranslateValidation(metadata.metatype)
      ) {
        const response = error.getResponse();
        if (
          typeof response === 'object' &&
          response !== null &&
          Array.isArray((response as { message?: unknown }).message)
        ) {
          throw new BadRequestException({
            ...(response as Record<string, unknown>),
            message: translateValidationMessages(
              (response as { message: unknown[] }).message,
            ),
          });
        }
      }
      throw error;
    }
  }
}
