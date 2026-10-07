import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { startOfTashkentDay, TASHKENT_OFFSET_MINUTES } from '@app/common';
import { SmsOutbox } from '../entities/sms-outbox.entity';
import { SmsConfigService } from './sms-config.service';
import type { SmsMessageClass } from './sms.port';

export type SmsBlockReason =
  | 'sms_disabled'
  | 'fanout_exceeded'
  | 'daily_cap_exceeded'
  | 'opt_out_not_configured'
  | 'provider_not_configured';

/** Darvoza rad etdi — chaqiruvchiga ANIQ sabab qaytadi (fail-closed). */
export class SmsBlockedError extends Error {
  constructor(
    readonly reason: SmsBlockReason,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SmsBlockedError';
  }
}

const MINUTE_MS = 60_000;

/**
 * Toshkent devor soati (daqiqa, 00:00 dan). O'zbekiston doimiy UTC+5 (yozgi
 * vaqt yo'q) — umumiy `@app/common` tashkent-time qoidasi. Tungi taqiq va
 * kunlik kvota FAQAT shu qoida orqali hisoblanadi (qo'shaloq konversiya yo'q).
 */
export const tashkentMinuteOfDay = (now: Date): number =>
  Math.floor((now.getTime() / MINUTE_MS + TASHKENT_OFFSET_MINUTES) % (24 * 60));

/**
 * Xarajat darvozasi (3fRbyadQ #5) va reklama vaqt darvozasi (sVByLMnt #3).
 */
@Injectable()
export class SmsGateService {
  constructor(
    private readonly config: SmsConfigService,
    @InjectRepository(SmsOutbox)
    private readonly outbox: Repository<SmsOutbox>,
  ) {}

  /**
   * Navbatga qo'yishdan OLDIN: kill-switch, fan-out chegarasi, kunlik kvota.
   * Har biri rad etsa — XATO (jimgina kesish yoki "muvaffaqiyat" yo'q).
   */
  async assertCanEnqueue(count: number, now = new Date()): Promise<void> {
    if (!this.config.enabled) {
      throw new SmsBlockedError(
        'sms_disabled',
        "SMS o'chiq (SMS_ENABLED=false) — hech narsa navbatga qo'yilmadi",
      );
    }
    if (count > this.config.maxFanout) {
      throw new SmsBlockedError(
        'fanout_exceeded',
        `SMS qabul qiluvchilar soni ${count} — chegara ${this.config.maxFanout} (SMS_MAX_FANOUT)`,
        { requested: count, max: this.config.maxFanout },
      );
    }
    const usedToday = await this.usedToday(now);
    if (usedToday + count > this.config.dailyCap) {
      throw new SmsBlockedError(
        'daily_cap_exceeded',
        `Kunlik SMS kvotasi tugadi: bugun ${usedToday} ta, so'ralgan ${count}, chegara ${this.config.dailyCap} (SMS_DAILY_CAP, Toshkent kuni)`,
        { used: usedToday, requested: count, cap: this.config.dailyCap },
      );
    }
  }

  /** Bugun (Toshkent kuni) navbatga qo'yilgan SMS soni. */
  usedToday(now = new Date()): Promise<number> {
    return this.outbox.count({
      where: { created_at: MoreThanOrEqual(startOfTashkentDay(now)) },
    });
  }

  /**
   * Qachon yuborilsin. Reklama taqiq oynasiga (sukut 18:00–09:00, Toshkent)
   * tushsa TASHLANMAYDI — oyna tugash vaqtiga suriladi. Transaksion va
   * security (OTP) darvozaga TUSHMAYDI — tunda ham ketadi.
   */
  scheduleFor(messageClass: SmsMessageClass, now = new Date()): Date {
    if (messageClass !== 'promo') return now;
    const { start, end } = this.config.quietHours;
    if (start === end) return now;
    const minute = tashkentMinuteOfDay(now);
    const inQuiet =
      start > end
        ? minute >= start || minute < end
        : minute >= start && minute < end;
    if (!inQuiet) return now;
    const dayStart = startOfTashkentDay(now).getTime();
    let release = dayStart + end * MINUTE_MS;
    if (release <= now.getTime()) release += 24 * 60 * MINUTE_MS;
    return new Date(release);
  }
}
