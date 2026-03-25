import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import { Group_type } from '@app/common';

export class CreateTelegramMarketRequestDto {
  @ApiProperty({ example: '2' })
  @IsString()
  @Matches(/^\d+$/)
  market_id!: string;

  @ApiProperty({ example: '-1001234567890' })
  @IsString()
  group_id!: string;

  @ApiProperty({ enum: Group_type, example: Group_type.CREATE })
  @IsEnum(Group_type)
  group_type!: Group_type;

  @ApiPropertyOptional({ example: '123456:ABCDEF...' })
  @IsOptional()
  @IsString()
  token?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  is_active?: boolean;
}

export class FindTelegramMarketsQueryDto {
  @ApiPropertyOptional({ example: '2' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({ enum: Group_type, example: Group_type.CREATE })
  @IsOptional()
  @IsEnum(Group_type)
  group_type?: Group_type;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true'
      ? true
      : value === false || value === 'false'
        ? false
        : value,
  )
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}

export class UpdateTelegramMarketRequestDto {
  @ApiPropertyOptional({ example: '10' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  id?: string;

  @ApiPropertyOptional({ example: '2' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({ example: '-1001234567890' })
  @IsOptional()
  @IsString()
  group_id?: string;

  @ApiPropertyOptional({ enum: Group_type, example: Group_type.CANCEL })
  @IsOptional()
  @IsEnum(Group_type)
  group_type?: Group_type;

  @ApiPropertyOptional({ example: '123456:ABCDEF...' })
  @IsOptional()
  @IsString()
  token?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  is_active?: boolean;
}

export class DeleteTelegramMarketRequestDto {
  @ApiPropertyOptional({ example: '10' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  id?: string;

  @ApiPropertyOptional({ example: '2' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({ enum: Group_type, example: Group_type.CREATE })
  @IsOptional()
  @IsEnum(Group_type)
  group_type?: Group_type;
}

export class SendNotificationRequestDto {
  @ApiPropertyOptional({ example: '2' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({ example: '-1001234567890' })
  @IsOptional()
  @IsString()
  group_id?: string;

  @ApiPropertyOptional({ enum: Group_type, example: Group_type.CREATE })
  @IsOptional()
  @IsEnum(Group_type)
  group_type?: Group_type;

  @ApiPropertyOptional({ example: '123456:ABCDEF...' })
  @IsOptional()
  @IsString()
  token?: string;

  @ApiProperty({ example: "Buyurtma yaratildi: #123" })
  @IsString()
  message!: string;

  @ApiPropertyOptional({ enum: ['Markdown', 'MarkdownV2', 'HTML'], example: 'HTML' })
  @IsOptional()
  @IsString()
  parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  disable_web_page_preview?: boolean;
}

export class ConnectTelegramByTokenRequestDto {
  @ApiProperty({ example: 'group_token-2-create' })
  @IsString()
  text!: string;

  @ApiProperty({ example: '-1001234567890' })
  @IsString()
  group_id!: string;
}
