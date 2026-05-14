import { Group_type } from '@app/common';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
} from 'class-validator';

export class SendNotificationDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @IsOptional()
  @IsString()
  group_id?: string;

  @IsOptional()
  @IsEnum(Group_type)
  group_type?: Group_type;

  @IsOptional()
  @IsString()
  token?: string;

  // Telegram's sendMessage caps text at 4096 chars; reject anything longer
  // at the gateway rather than getting a confusing 400 from upstream.
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  message!: string;

  @IsOptional()
  @IsIn(['Markdown', 'MarkdownV2', 'HTML'])
  parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';

  @IsOptional()
  @IsBoolean()
  disable_web_page_preview?: boolean;
}
