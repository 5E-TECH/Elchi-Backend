import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { startOfTashkentDay, TASHKENT_OFFSET_MINUTES } from '@app/common';
import { SmsOutbox } from '../entities/sms-outbox.entity';
import { SmsConfigService } from './sms-config.service';
import type { SmsMessageClass } from './sms.port';

export type SmsBlockReason =
  | 'sms_disabled'
  | 'fanout_exceeded'
  | 'daily_cap_exceeded'
  | 'opt_out_not_configured'
  | 'no_consent'
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
 * (rkz0yBxr) Kvota oqimi: OTP (`security`) — o'z kunlik kvotasi va o'z qulfi
 * bilan ALOHIDA oqim; tranzaksion + reklama — umumiy oqim. Avval bitta
 * `SMS_DAILY_CAP` hamma sinfni sanardi: reklama kampaniyasi kvotani tugatsa
 * login kodi ham ketmasdi (mijoz kabinetiga kirishning yagona yo'li).
 */
export type SmsQuotaStream = 'general' | 'otp';

const OTP_CLASSES: SmsMessageClass[] = ['security'];

export const smsQuotaStream = (
  messageClass: SmsMessageClass,
): SmsQuotaStream => (OTP_CLASSES.includes(messageClass) ? 'otp' : 'general');

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
  async assertCanEnqueue(
    count: number,
    now = new Date(),
    manager?: EntityManager,
    stream: SmsQuotaStream = 'general',
  ): Promise<void> {
    this.assertEnabledAndFanout(count);
    const usedToday = await this.usedToday(now, manager, stream);
    const cap = this.dailyCapFor(stream);
    if (usedToday + count > cap) {
      const env = stream === 'otp' ? 'SMS_OTP_DAILY_CAP' : 'SMS_DAILY_CAP';
      throw new SmsBlockedError(
        'daily_cap_exceeded',
        `Kunlik ${stream === 'otp' ? 'OTP ' : ''}SMS kvotasi tugadi: bugun ${usedToday} ta, so'ralgan ${count}, chegara ${cap} (${env}, Toshkent kuni)`,
        { used: usedToday, requested: count, cap, stream },
      );
    }
  }

  /** (rkz0yBxr) Oqim kvotasi: OTP — `SMS_OTP_DAILY_CAP`, qolgani — `SMS_DAILY_CAP`. */
  dailyCapFor(stream: SmsQuotaStream): number {
    return stream === 'otp' ? this.config.otpDailyCap : this.config.dailyCap;
  }

  /** Kill-switch va fan-out chegarasi (DB'siz). */
  assertEnabledAndFanout(count: number): void {
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
  }

  /**
   * Bugun (Toshkent kuni) shu OQIMda navbatga qo'yilgan SMS soni. `manager` —
   * kvota qulfi olingan tranzaksiya (3fRbyadQ #5: sanash va INSERT bitta qulf
   * ostida). (rkz0yBxr) `general` OTP qatorlarini, `otp` esa boshqalarini
   * SANAMAYDI — ikki kvota bir-birini yemaydi.
   */
  usedToday(
    now = new Date(),
    manager?: EntityManager,
    stream: SmsQuotaStream = 'general',
  ): Promise<number> {
    const repo = manager ? manager.getRepository(SmsOutbox) : this.outbox;
    return repo.count({
      where: {
        created_at: MoreThanOrEqual(startOfTashkentDay(now)),
        message_class:
          stream === 'otp' ? In(OTP_CLASSES) : Not(In(OTP_CLASSES)),
      },
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
