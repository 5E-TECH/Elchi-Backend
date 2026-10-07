import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SmsMessageClass } from './sms.port';
import { asText } from './sms-phone.util';

export interface QuietHours {
  /** Daqiqa (00:00 dan): taqiq boshlanishi, masalan 18:00 → 1080. */
  start: number;
  /** Daqiqa: taqiq tugashi, masalan 09:00 → 540. */
  end: number;
}

const DEFAULT_QUIET_HOURS = '18:00-09:00';

const toMinutes = (hhmm: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

export const parseQuietHours = (value: string | undefined): QuietHours => {
  const [rawStart, rawEnd] = (value || DEFAULT_QUIET_HOURS).split('-');
  const start = toMinutes(rawStart ?? '');
  const end = toMinutes(rawEnd ?? '');
  if (start === null || end === null)
    return parseQuietHours(DEFAULT_QUIET_HOURS);
  return { start, end };
};

const optionalNumber = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
};

const flag = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null || value === '') return fallback;
  return asText(value).trim().toLowerCase() === 'true';
};

/**
 * SMS sozlamalari (env). Sukutlar XAVFSIZ tomonda:
 * - SMS_ENABLED sukut `false` — kill-switch yoqilmaguncha hech narsa ketmaydi;
 * - tarif berilmasa narx `null` ("tarif sozlanmagan"), 0 yoki taxmin EMAS;
 * - reklama tungi taqiq oynasi sozlanadi (NOTIF_PROMO_QUIET_HOURS), kodga
 *   qotirilmagan — qonun soatlari o'zgarishi mumkin.
 */
@Injectable()
export class SmsConfigService {
  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return flag(this.config.get('SMS_ENABLED'), false);
  }

  get provider(): string {
    return (this.config.get<string>('SMS_PROVIDER') || 'eskiz')
      .trim()
      .toLowerCase();
  }

  /** Toshkent kuni bo'yicha kunlik SMS soni chegarasi. */
  get dailyCap(): number {
    return optionalNumber(this.config.get('SMS_DAILY_CAP')) ?? 500;
  }

  /** Bitta dispatch/kampaniyadagi SMS qabul qiluvchilar chegarasi (MAX_FANOUT=5000 EMAS). */
  get maxFanout(): number {
    return optionalNumber(this.config.get('SMS_MAX_FANOUT')) ?? 200;
  }

  get cronEnabled(): boolean {
    return flag(this.config.get('SMS_CRON_ENABLED'), true);
  }

  get cronExpression(): string {
    return this.config.get<string>('SMS_CRON_EXPR') || '*/15 * * * * *';
  }

  get batchSize(): number {
    return optionalNumber(this.config.get('SMS_BATCH_SIZE')) || 50;
  }

  get balanceAlertThreshold(): number | null {
    return optionalNumber(this.config.get('SMS_BALANCE_ALERT_THRESHOLD'));
  }

  get balanceCronExpression(): string {
    return this.config.get<string>('SMS_BALANCE_CRON_EXPR') || '0 0 * * * *';
  }

  /** DLR webhook manzili (masalan https://api.elchipochta.uz/webhooks/sms). */
  get callbackBaseUrl(): string | null {
    const url = this.config.get<string>('SMS_DLR_CALLBACK_URL')?.trim();
    return url ? url.replace(/\/+$/, '') : null;
  }

  /** DLR so'rovini tasdiqlovchi sir — faqat shu servisda yashaydi. */
  get dlrSecret(): string | null {
    return this.config.get<string>('SMS_DLR_SECRET')?.trim() || null;
  }

  /** Reklama SMS'dagi bekor qilish havolasi bazasi (masalan https://api.elchipochta.uz/sms/stop). */
  get optOutBaseUrl(): string | null {
    const url = this.config.get<string>('SMS_OPT_OUT_BASE_URL')?.trim();
    return url ? url.replace(/\/+$/, '') : null;
  }

  get quietHours(): QuietHours {
    return parseQuietHours(this.config.get<string>('NOTIF_PROMO_QUIET_HOURS'));
  }

  /** Bir bo'lak narxi (so'm). Sozlanmagan bo'lsa null — narx hisoblanmaydi. */
  tariff(messageClass: SmsMessageClass): number | null {
    return messageClass === 'promo'
      ? optionalNumber(this.config.get('SMS_TARIFF_PROMO'))
      : optionalNumber(this.config.get('SMS_TARIFF_TRANSACTIONAL'));
  }

  cost(messageClass: SmsMessageClass, parts: number): number | null {
    const tariff = this.tariff(messageClass);
    return tariff === null ? null : tariff * parts;
  }
}
