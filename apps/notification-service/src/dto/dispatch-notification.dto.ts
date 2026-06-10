import {
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  Group_type,
} from '@app/common';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';

// class-validator's @IsNotEmpty allows whitespace-only strings; this rejects them.
function IsNotBlank(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isNotBlank',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && value.trim().length > 0,
        defaultMessage: () => `${propertyName} must not be empty`,
      },
    });
  };
}

/**
 * The single generic entry point other services use to raise a notification.
 *
 * Targeting (at least one required):
 *   - `recipient_id`            → one user
 *   - `recipient_ids`           → explicit list of users
 *   - `roles`                   → every (employee/market) user with that role
 *   - `broadcast: true`         → every active user
 *
 * Telegram relay (optional): set `telegram` to also push the message to the
 * market's connected group via the existing telegram_markets config.
 */
export class DispatchNotificationDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  recipient_id?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  recipient_ids?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];

  @IsOptional()
  @IsBoolean()
  broadcast?: boolean;

  /** Fine-grained event key, convention `{domain}.{event}` e.g. `order.sold`. */
  @IsString()
  @IsNotBlank()
  @MaxLength(120)
  type!: string;

  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;

  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @IsString()
  @IsNotBlank()
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  body?: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  link?: string;

  /** Channels to fan out to. Defaults to [in_app, realtime] when omitted. */
  @IsOptional()
  @IsArray()
  @IsEnum(NotificationChannel, { each: true })
  channels?: NotificationChannel[];

  /** Dedupe/collapse key — same key + same recipient updates the existing row. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  group_key?: string;

  /** Optional telegram relay target (reuses telegram_markets config). */
  @IsOptional()
  @IsObject()
  telegram?: {
    market_id?: string;
    group_id?: string;
    group_type?: Group_type;
    token?: string;
  };
}
