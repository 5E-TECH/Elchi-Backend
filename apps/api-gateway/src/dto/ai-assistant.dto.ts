import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { AI_ASSISTANT_MESSAGE_MAX_CHARS } from '@app/common';

/** F7PWp6cK — `/ai/assistant/*` DTO'lari. */

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class AiAssistantMessageDto {
  @ApiProperty({
    description: `Savol matni (1..${AI_ASSISTANT_MESSAGE_MAX_CHARS} belgi)`,
    example: 'Bu oy kassaga qancha kirdi va eng katta chiqimlar qaysilar?',
  })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(AI_ASSISTANT_MESSAGE_MAX_CHARS)
  message!: string;

  @ApiPropertyOptional({
    description:
      'Davom ettiriladigan suhbat ID si (yo‘q — yangi suhbat). Faqat o‘zingizniki.',
    example: '12',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(/^\d{1,19}$/, { message: "conversation_id noto'g'ri" })
  conversation_id?: string;
}

export class AiAssistantConversationsQueryDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class AiAssistantAccessUpdateDto {
  @ApiProperty({ description: 'ADMIN foydalanuvchi ID si', example: '25' })
  @Transform(trimString)
  @IsString()
  @Matches(/^\d{1,19}$/, { message: "user_id noto'g'ri" })
  user_id!: string;

  @ApiProperty({ description: 'Yordamchidan foydalanish ruxsati' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    description:
      'Kunlik savol limiti (Toshkent kuni). `null` — sukut (AI_ASSISTANT_DAILY_LIMIT, 100).',
    nullable: true,
    minimum: 0,
    maximum: 10000,
    example: 100,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(10000)
  daily_limit?: number | null;
}
