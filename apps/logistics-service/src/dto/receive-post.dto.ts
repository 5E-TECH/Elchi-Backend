import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class ReceivePostDto {
  @IsNotEmpty()
  @IsArray()
  @IsString({ each: true })
  order_ids!: string[];

  /**
   * Skaner bilan qabul (2026-11-07): faqat `order_ids` qabul qilinadi,
   * pochtadagi qolgan yo'ldagilarga tegilmaydi. Faqat `PATCH post/receive/:id`
   * (gateway `ReceivePostScanRequestDto`); berilmasa — avvalgi bulk qoida.
   */
  @IsOptional()
  @IsBoolean()
  scan?: boolean;
}
