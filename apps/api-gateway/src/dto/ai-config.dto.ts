import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * «AI kalit va modellar» DTO'lari (openapi-fragment v0.2).
 *
 * ⚠️ MAXFIYLIK: gateway konvertni OCHA OLMAYDI — faqat shakl/hajm
 * tekshiriladi. Hech bir validatsiya xabari qiymatni (`$value`) takrorlamaydi;
 * noma'lum maydon (masalan `api_key`) global `forbidNonWhitelisted` bilan
 * rad etiladi. `label`/`reason` kalit o'xshash qiymati (D9) ai-service'da
 * `AI_CONFIG_INVALID {field}` bilan qaytadi (kodli 400 — FE maydon ostida
 * ko'rsatadi), shuning uchun bu yerda faqat tur/uzunlik.
 */
const B64URL = /^[A-Za-z0-9_-]+$/;

export class AiKeyEnvelopeDto {
  @ApiProperty({ enum: [1] })
  @Equals(1)
  v!: 1;

  @ApiProperty({ pattern: '^[0-9a-f]{16}$', description: 'key_wrap.kid' })
  @IsString()
  @Matches(/^[0-9a-f]{16}$/)
  kid!: string;

  @ApiProperty({ enum: ['RSA-OAEP-256+A256GCM'] })
  @IsIn(['RSA-OAEP-256+A256GCM'])
  alg!: 'RSA-OAEP-256+A256GCM';

  @ApiProperty({ minLength: 400, maxLength: 700, description: 'base64url' })
  @IsString()
  @Length(400, 700)
  @Matches(B64URL)
  ek!: string;

  @ApiProperty({ pattern: '^[A-Za-z0-9_-]{16}$' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16}$/)
  iv!: string;

  @ApiProperty({ minLength: 40, maxLength: 1024, description: 'base64url' })
  @IsString()
  @Length(40, 1024)
  @Matches(B64URL)
  ct!: string;
}

export class AiKeySetDto {
  @ApiProperty({
    type: AiKeyEnvelopeDto,
    description:
      'Brauzerda (WebCrypto) ai-service ochiq kaliti bilan muhrlangan kalit. Ochiq kalit HECH QACHON yuborilmaydi.',
  })
  @ValidateNested()
  @Type(() => AiKeyEnvelopeDto)
  key_envelope!: AiKeyEnvelopeDto;

  @ApiPropertyOptional({
    maxLength: 60,
    description:
      "Ixtiyoriy; sukut «Anthropic kaliti». Harf, raqam, bo'sh joy va . , _ ( ) ' ʻ ʼ -. Kalit o'xshash qiymat → 400 AI_CONFIG_INVALID {field:'label'}.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @ApiProperty({ minimum: 1, description: 'GET /ai/config → version.key' })
  @IsInt()
  @Min(1)
  version!: number;
}

export class AiVersionedDto {
  @ApiProperty({ minimum: 1, description: 'GET /ai/config → version.key' })
  @IsInt()
  @Min(1)
  version!: number;
}

export class AiDeactivateDto extends AiVersionedDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
