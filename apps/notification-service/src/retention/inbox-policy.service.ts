import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Bo'ron chegarasi sukuti — bir foydalanuvchiga bir turdagi xabar, soatiga. */
export const DEFAULT_HOURLY_CAP_PER_TYPE = 30;

/** Retention sukutlari (A1HzKEby #3). Muddatlar KODDA emas — `.env` dan. */
const DEFAULT_READ_DAYS = 60;
const DEFAULT_UNREAD_DAYS = 180;
const DEFAULT_BATCH_SIZE = 5000;
const DEFAULT_MAX_BATCHES = 200;
const DEFAULT_CRON = '0 30 3 * * *';
/** Xavfsizlik tagi: tasodifan `1` yozilsa butun inbox o'chib ketmasin. */
const MIN_READ_DAYS = 7;

export interface RetentionSettings {
  enabled: boolean;
  dryRun: boolean;
  readDays: number;
  unreadDays: number;
  batchSize: number;
  maxBatches: number;
  cron: string;
  /** Sozlama noto'g'ri bo'lsa — sabab; retention ISHLAMAYDI (fail-safe). */
  invalid: string | null;
}

const flag = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return ['true', '1'].includes(text.trim().toLowerCase());
};

const intOr = (value: unknown, fallback: number): number => {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  return Number.isInteger(num) ? num : NaN;
};

/**
 * Inbox siyosati (A1HzKEby): bo'ron chegarasi va retention muddatlari.
 * Hammasi `.env` dan; Joi (`notificationValidationSchema`) startda
 * tekshiradi, bu yerda esa qo'shimcha FAIL-SAFE: noto'g'ri qiymat bo'lsa
 * retention o'chiq qoladi (hech narsa o'chirilmaydi).
 */
@Injectable()
export class InboxPolicyService {
  constructor(private readonly config: ConfigService) {}

  /** 0 — chegara o'chiq. */
  get hourlyCapPerType(): number {
    const value = intOr(
      this.config.get('NOTIF_HOURLY_CAP_PER_TYPE'),
      DEFAULT_HOURLY_CAP_PER_TYPE,
    );
    return Number.isInteger(value) && value >= 0
      ? value
      : DEFAULT_HOURLY_CAP_PER_TYPE;
  }

  get retention(): RetentionSettings {
    const readDays = intOr(
      this.config.get('NOTIF_RETENTION_READ_DAYS'),
      DEFAULT_READ_DAYS,
    );
    const unreadDays = intOr(
      this.config.get('NOTIF_RETENTION_UNREAD_DAYS'),
      DEFAULT_UNREAD_DAYS,
    );
    const batchSize = intOr(
      this.config.get('NOTIF_RETENTION_BATCH_SIZE'),
      DEFAULT_BATCH_SIZE,
    );
    const maxBatches = intOr(
      this.config.get('NOTIF_RETENTION_MAX_BATCHES'),
      DEFAULT_MAX_BATCHES,
    );
    const cronRaw: unknown = this.config.get('NOTIF_RETENTION_CRON_EXPR');
    const cron =
      typeof cronRaw === 'string' && cronRaw.trim()
        ? cronRaw.trim()
        : DEFAULT_CRON;

    let invalid: string | null = null;
    if (!Number.isInteger(readDays) || readDays < MIN_READ_DAYS) {
      invalid = `NOTIF_RETENTION_READ_DAYS >= ${MIN_READ_DAYS} butun son bo'lishi kerak`;
    } else if (!Number.isInteger(unreadDays) || unreadDays <= readDays) {
      // DIQQAT (a): o'qilmagan — foydalanuvchi hali ko'rmagan xabar.
      invalid =
        "NOTIF_RETENTION_UNREAD_DAYS o'qilganlar muddatidan (NOTIF_RETENTION_READ_DAYS) UZUN bo'lishi shart";
    } else if (
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 10000
    ) {
      invalid = "NOTIF_RETENTION_BATCH_SIZE 1..10000 oralig'ida bo'lishi kerak";
    } else if (!Number.isInteger(maxBatches) || maxBatches < 1) {
      invalid = "NOTIF_RETENTION_MAX_BATCHES >= 1 bo'lishi kerak";
    }

    return {
      enabled: flag(this.config.get('NOTIF_RETENTION_ENABLED'), false),
      dryRun: flag(this.config.get('NOTIF_RETENTION_DRY_RUN'), false),
      readDays,
      unreadDays,
      batchSize,
      maxBatches,
      cron,
      invalid,
    };
  }
}
