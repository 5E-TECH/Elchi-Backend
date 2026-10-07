import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IsNull, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  ActivityAction,
  ActivityLogService,
  Roles,
  Status,
  normalizeUzPhone,
  rmqSend,
} from '@app/common';
import { User } from '../entities/user.entity';
import { OTP_PURPOSES, OtpCode, OtpPurpose } from '../entities/otp-code.entity';
import { AuthService } from '../auth/auth.service';

export interface OtpRequestInput {
  phone_number?: string;
  purpose?: string;
  ip?: string | null;
}

export interface OtpVerifyInput extends OtpRequestInput {
  code?: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CLEANUP_BATCH = 1000;

/** Raqam mavjud-mavjud emasligidan qat'i nazar BIR XIL javob (rkz0yBxr: oshkor qilmaslik). */
const SENT_MESSAGE =
  "Agar raqam ro'yxatdan o'tgan bo'lsa, unga tasdiq kodi yuborildi";
const INVALID_CODE = "Kod noto'g'ri yoki muddati o'tgan";

const tooMany = (message: string, retryAfterSeconds: number) =>
  new RpcException({
    statusCode: 429,
    message,
    retry_after: retryAfterSeconds,
  });

/**
 * OTP (rkz0yBxr): so'rash va tekshirish.
 *
 * - kod faqat HMAC hash ko'rinishida saqlanadi;
 * - raqam bo'yicha limit: 1 kod / OTP_RESEND_SECONDS, OTP_HOURLY_LIMIT / soat,
 *   OTP_DAILY_LIMIT / kun (IP limiti gateway'da — ClientIpThrottlerGuard);
 * - noto'g'ri kod OTP_MAX_ATTEMPTS marta → kod bekor (yangi kod kerak);
 * - to'g'ri kod darhol `consumed_at` bilan yopiladi;
 * - mavjud bo'lmagan raqamga ham qator yoziladi (SMS ketmaydi) — javob ham,
 *   limit ham bir xil, raqam ro'yxatdan o'tgani oshkor bo'lmaydi;
 * - OTP login faqat MIJOZLAR uchun (xodimlar parol bilan).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @InjectRepository(OtpCode)
    private readonly codes: Repository<OtpCode>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @Inject('NOTIFICATION') private readonly notificationClient: ClientProxy,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly activityLog: ActivityLogService,
  ) {}

  private num(key: string, fallback: number): number {
    const value = Number(this.config.get(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private hash(phone: string, code: string): string {
    const key =
      this.config.get<string>('OTP_HASH_SECRET') ||
      this.config.get<string>('ACCESS_TOKEN_KEY') ||
      '';
    return createHmac('sha256', key)
      .update(`otp:${phone}:${code}`)
      .digest('hex');
  }

  private parse(input: OtpRequestInput): {
    phone: string;
    purpose: OtpPurpose;
  } {
    const phone = normalizeUzPhone(input?.phone_number);
    if (!phone)
      throw new RpcException({
        statusCode: 400,
        message: "Telefon raqami noto'g'ri",
      });
    const purpose = (input?.purpose ?? 'login') as OtpPurpose;
    if (!OTP_PURPOSES.includes(purpose)) {
      throw new RpcException({
        statusCode: 400,
        message: `purpose: ${OTP_PURPOSES.join(', ')}`,
      });
    }
    return { phone, purpose };
  }

  private async findCustomer(phone: string): Promise<User | null> {
    return this.users.findOne({
      where: {
        phone_number: phone,
        isDeleted: false,
        role: Roles.CUSTOMER,
        status: Status.ACTIVE,
      },
    });
  }

  async request(input: OtpRequestInput, now = new Date()) {
    const { phone, purpose } = this.parse(input);
    const resend = this.num('OTP_RESEND_SECONDS', 60);

    const [last] = await this.codes.find({
      where: { phone, purpose },
      order: { created_at: 'DESC' },
      take: 1,
    });
    if (last && now.getTime() - last.created_at.getTime() < resend * 1000) {
      const wait = Math.ceil(
        (resend * 1000 - (now.getTime() - last.created_at.getTime())) / 1000,
      );
      throw tooMany(`Yangi kodni ${wait} soniyadan keyin so'rang`, wait);
    }
    const hourly = await this.codes.count({
      where: {
        phone,
        purpose,
        created_at: MoreThanOrEqual(new Date(now.getTime() - HOUR_MS)),
      },
    });
    if (hourly >= this.num('OTP_HOURLY_LIMIT', 5)) {
      throw tooMany(
        "Soatlik kod so'rash chegarasi tugadi, keyinroq urinib ko'ring",
        3600,
      );
    }
    const daily = await this.codes.count({
      where: {
        phone,
        purpose,
        created_at: MoreThanOrEqual(new Date(now.getTime() - DAY_MS)),
      },
    });
    if (daily >= this.num('OTP_DAILY_LIMIT', 10)) {
      throw tooMany("Kunlik kod so'rash chegarasi tugadi", 86400);
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const row = await this.codes.save(
      this.codes.create({
        phone,
        purpose,
        code_hash: this.hash(phone, code),
        expires_at: new Date(
          now.getTime() + this.num('OTP_TTL_SECONDS', 300) * 1000,
        ),
        attempts: 0,
        max_attempts: this.num('OTP_MAX_ATTEMPTS', 5),
        consumed_at: null,
        ip: input?.ip ? String(input.ip).slice(0, 64) : null,
      }),
    );

    const user = purpose === 'login' ? await this.findCustomer(phone) : null;
    const shouldSend = purpose === 'phone_verify' || Boolean(user);
    if (shouldSend) {
      try {
        await rmqSend(
          this.notificationClient,
          { cmd: 'notification.sms.send_otp' },
          {
            phone,
            code,
            otp_id: row.id,
            lang: user?.language ?? 'uz',
          },
        );
      } catch (error) {
        // Javob BIR XIL qoladi (oshkor qilmaslik); sabab jurnalda.
        this.logger.error(
          `OTP SMS navbatga tushmadi (${this.auth.phoneForAudit(phone).phone_masked}): ${(error as Error).message}`,
        );
      }
    }
    await this.audit('otp_requested', phone, input?.ip, {
      purpose,
      delivered: shouldSend,
    });
    return { statusCode: 200, message: SENT_MESSAGE, resend_after: resend };
  }

  async verify(input: OtpVerifyInput, now = new Date()) {
    const { phone, purpose } = this.parse(input);
    const code = String(input?.code ?? '').trim();
    if (!/^\d{6}$/.test(code))
      throw new RpcException({ statusCode: 400, message: INVALID_CODE });

    const [row] = await this.codes.find({
      where: { phone, purpose, consumed_at: IsNull() },
      order: { created_at: 'DESC' },
      take: 1,
    });
    if (!row || row.expires_at.getTime() <= now.getTime()) {
      await this.audit('otp_failed', phone, input?.ip, {
        purpose,
        reason: 'expired_or_missing',
      });
      throw new RpcException({ statusCode: 400, message: INVALID_CODE });
    }
    if (row.attempts >= row.max_attempts) {
      throw new RpcException({
        statusCode: 400,
        message: "Urinishlar tugadi — yangi kod so'rang",
      });
    }

    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(this.hash(phone, code), 'hex');
    const ok =
      expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!ok) {
      const attempts = row.attempts + 1;
      await this.codes.update(
        { id: row.id },
        attempts >= row.max_attempts
          ? { attempts, consumed_at: now }
          : { attempts },
      );
      await this.audit('otp_failed', phone, input?.ip, {
        purpose,
        reason: 'bad_code',
        attempts,
      });
      throw new RpcException({
        statusCode: 400,
        message:
          attempts >= row.max_attempts
            ? "Urinishlar tugadi — yangi kod so'rang"
            : INVALID_CODE,
      });
    }

    // Darhol yopiladi — ayni kod QAYTA ishlamaydi (poyga holatida ham: WHERE consumed_at IS NULL).
    const consumed = await this.codes.update(
      { id: row.id, consumed_at: IsNull() },
      { consumed_at: now, attempts: row.attempts + 1 },
    );
    if (!consumed.affected)
      throw new RpcException({ statusCode: 400, message: INVALID_CODE });

    if (purpose === 'phone_verify') {
      await this.audit('otp_verified', phone, input?.ip, { purpose });
      return {
        statusCode: 200,
        message: 'Telefon tasdiqlandi',
        verified: true,
      };
    }
    const user = await this.findCustomer(phone);
    if (!user) {
      await this.audit('otp_failed', phone, input?.ip, {
        purpose,
        reason: 'no_customer',
      });
      throw new RpcException({
        statusCode: 401,
        message: 'Invalid credentials',
      });
    }
    return this.auth.sessionForUser(user, 'otp');
  }

  /** Muddati o'tgan qatorlarni partiyalab tozalash (rkz0yBxr #9). */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanup(now = new Date()): Promise<number> {
    let total = 0;
    for (let round = 0; round < 20; round += 1) {
      const stale = await this.codes.find({
        select: ['id'],
        where: { expires_at: LessThan(new Date(now.getTime() - DAY_MS)) },
        take: CLEANUP_BATCH,
      });
      if (!stale.length) break;
      const result = await this.codes.delete(stale.map((row) => row.id));
      total += result.affected ?? 0;
      if (stale.length < CLEANUP_BATCH) break;
    }
    if (total) this.logger.log(`OTP: ${total} ta eskirgan qator tozalandi`);
    return total;
  }

  private async audit(
    event: string,
    phone: string,
    ip: string | null | undefined,
    extra: Record<string, unknown>,
  ) {
    const masked = this.auth.phoneForAudit(phone);
    await this.activityLog
      .log({
        entity_type: 'Auth',
        entity_id: masked.phone_hash,
        action:
          event === 'otp_failed'
            ? ActivityAction.AUTH_FAILURE
            : `auth.${event}`,
        user_id: null,
        metadata: { event, ...masked, ip: ip ?? null, ...extra },
      })
      .catch(() => undefined);
  }
}
