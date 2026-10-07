import { NotificationCategory, NotificationPriority } from '@app/common';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

/** Query a single user's inbox. `recipient_id` is set by the gateway from the JWT. */
export class ListNotificationsDto {
  @IsString()
  @Matches(/^\d+$/)
  recipient_id!: string;

  @IsOptional()
  @IsBoolean()
  is_read?: boolean;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;

  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  /** "Faqat muhim" (n1sNvGLn): `critical` + `high`. `priority` dan ustun. */
  @IsOptional()
  @IsBoolean()
  important?: boolean;

  @IsOptional()
  page?: number;

  @IsOptional()
  limit?: number;
}
