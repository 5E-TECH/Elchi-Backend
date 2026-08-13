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

export class SetPartnerActiveRequestDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  is_active!: boolean;
}
