import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';

export class CreatePartnerRequestDto {
  @ApiProperty({ example: 'Elchi Marketplace' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    example: 'https://marketplace.example.uz/webhooks/elchi',
  })
  @IsOptional()
  @IsUrl()
  webhook_url?: string;

  @ApiPropertyOptional({
    description: 'Chiquvchi webhook HMAC sekret (AES bilan shifrlab saqlanadi)',
  })
  @IsOptional()
  @IsString()
  webhook_secret?: string;

  @ApiPropertyOptional({ type: [String], example: ['203.0.113.10'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ip_allowlist?: string[];
}

/**
 * Hamkorni tahrirlash. Har bir maydon IXTIYORIY va semantikasi aniq:
 *   • berilmasa   — tegilmaydi;
 *   • bo'sh satr  — tozalanadi (webhook o'chadi).
 * `@IsUrl` bo'sh satrni rad etardi, shu bois `webhook_url` da u YO'Q —
 * manzilning haqiqiy tekshiruvi servisdagi SSRF guardida bajariladi.
 */
export class UpdatePartnerRequestDto {
  @ApiPropertyOptional({ example: 'BeePost' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    example: 'https://beepost.example.uz/api/v1/elchi/webhook',
    description: "Bo'sh satr yuborilsa webhook O'CHIRILADI",
  })
  @IsOptional()
  @IsString()
  webhook_url?: string;

  @ApiPropertyOptional({
    description: "Chiquvchi webhook HMAC sekreti. Bo'sh satr — tozalash.",
  })
  @IsOptional()
  @IsString()
  webhook_secret?: string;

  @ApiPropertyOptional({ type: [String], example: ['203.0.113.10'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ip_allowlist?: string[];
}

export class SetPartnerActiveRequestDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  is_active!: boolean;
}
