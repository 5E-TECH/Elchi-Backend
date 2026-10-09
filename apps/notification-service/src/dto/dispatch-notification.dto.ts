import {
  IsNotificationType,
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

  /**
   * Fine-grained event key, convention `{domain}.{event}` e.g. `order.sold`.
   * (Eh8y21Ha) Reyestrda (`NOTIFICATION_TYPES`) bo'lishi SHART yoki `x.`
   * prefiksli vaqtinchalik tur. ⚠️ RMQ'da ValidationPipe yo'q — servis
   * `dispatch()` ham aynan shuni tekshiradi.
   */
  @IsString()
  @IsNotBlank()
  @MaxLength(120)
  @IsNotificationType()
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

  /**
   * Optional telegram relay target (reuses telegram_markets config).
   *
   * (n0kLbx3d) `token` YO'Q — bot tokeni faqat DB yoki env'dan; payload'da
   * kelsa e'tiborsiz qoldiriladi. `text` — ichki chaqiruvchi (order-service)
   * tayyorlagan, allaqachon HTML-escape qilingan Telegram matni (market
   * guruhi uchun; in_app `body` dan farqli, PII bo'lishi mumkin). Gateway
   * DTO'sida `text` yo'q — HTTP orqali yuborib bo'lmaydi.
   */
  @IsOptional()
  @IsObject()
  telegram?: {
    market_id?: string;
    group_id?: string;
    group_type?: Group_type;
    text?: string;
  };
}
