import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  CONSENT_SOURCES,
  ConsentSource,
  CustomerConsent,
} from '../entities/customer-consent.entity';
import { SmsConfigService } from './sms-config.service';
import { normalizeSmsPhone } from './sms-phone.util';

export interface ConsentRecipient {
  phone: string;
  customer_id?: string | null;
}

export interface GrantConsentInput {
  phone: string;
  customer_id?: string | null;
  source: string;
  evidence?: Record<string, unknown> | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_LENGTH = 16;

/**
 * Reklama roziligi (sVByLMnt). Darvoza QAT'IY FAIL-CLOSED:
 * qator yo'q / granted=false / revoked_at / muddati o'tgan / raqam boshqa
 * mijozga o'tgan — hammasi "rozilik YO'Q". "Noma'lum = ruxsat" mantiqi yo'q.
 */
@Injectable()
export class SmsConsentService {
  constructor(
    @InjectRepository(CustomerConsent)
    private readonly repo: Repository<CustomerConsent>,
    private readonly sms: SmsConfigService,
    private readonly config: ConfigService,
  ) {}

  /** Rozilik amal qilish muddati (kun). Sukut 365 — eskirgan rozilik bilan reklama ketmaydi. */
  private get ttlDays(): number {
    const days = Number(this.config.get('SMS_CONSENT_TTL_DAYS'));
    return Number.isFinite(days) && days > 0 ? days : 365;
  }

  async partition<T extends ConsentRecipient>(
    recipients: T[],
    now = new Date(),
  ): Promise<{ allowed: T[]; blocked: T[] }> {
    const phones = [...new Set(recipients.map((r) => r.phone))];
    const rows = phones.length
      ? await this.repo.find({
          where: { phone: In(phones), channel: 'sms' },
          order: { granted_at: 'DESC' },
        })
      : [];
    // Har raqam uchun ENG SO'NGGI yozuv hal qiladi.
    const latest = new Map<string, CustomerConsent>();
    for (const row of rows)
      if (!latest.has(row.phone)) latest.set(row.phone, row);

    const minGrantedAt = now.getTime() - this.ttlDays * DAY_MS;
    const allowed: T[] = [];
    const blocked: T[] = [];
    for (const recipient of recipients) {
      const consent = latest.get(recipient.phone);
      const ok =
        !!consent &&
        consent.granted &&
        !consent.revoked_at &&
        consent.granted_at.getTime() >= minGrantedAt &&
        (!consent.customer_id ||
          !recipient.customer_id ||
          String(consent.customer_id) === String(recipient.customer_id));
      (ok ? allowed : blocked).push(recipient);
    }
    return { allowed, blocked };
  }

  async grant(
    input: GrantConsentInput,
    now = new Date(),
  ): Promise<CustomerConsent> {
    const phone = normalizeSmsPhone(input.phone);
    if (!phone) throw new Error("Telefon raqami noto'g'ri");
    if (!CONSENT_SOURCES.includes(input.source as ConsentSource)) {
      throw new Error(
        `source quyidagilardan biri bo'lsin: ${CONSENT_SOURCES.join(', ')}`,
      );
    }
    return this.repo.save(
      this.repo.create({
        phone,
        customer_id: input.customer_id ?? null,
        channel: 'sms',
        granted: true,
        source: input.source as ConsentSource,
        granted_at: now,
        evidence: input.evidence ?? null,
        revoked_at: null,
      }),
    );
  }

  /** Raqam bo'yicha barcha faol rozilikni bekor qiladi. */
  async revoke(rawPhone: string, now = new Date()): Promise<number> {
    const phone = normalizeSmsPhone(rawPhone);
    if (!phone) throw new Error("Telefon raqami noto'g'ri");
    const result = await this.repo.update(
      { phone, channel: 'sms', revoked_at: IsNull() },
      { revoked_at: now },
    );
    return result.affected ?? 0;
  }

  // ==================== Opt-out (sVByLMnt #4) ====================

  /** Raqamga bog'langan qisqa token — DB'da saqlanmaydi, sir bilan tekshiriladi. */
  optOutToken(phone: string): string {
    const secret = this.sms.dlrSecret;
    if (!secret) throw new Error('SMS_DLR_SECRET sozlanmagan');
    const digits = phone.replace(/\D/g, '');
    const mac = createHmac('sha256', secret)
      .update(`opt-out:${digits}`)
      .digest('base64url');
    return `${digits}.${mac.slice(0, TOKEN_LENGTH)}`;
  }

  /** Token to'g'ri bo'lsa normallashtirilgan raqam, aks holda null. */
  verifyOptOutToken(token: string): string | null {
    const [digits, mac] = String(token ?? '').split('.');
    const phone = normalizeSmsPhone(digits);
    if (!phone || !mac) return null;
    let expected: string;
    try {
      expected = this.optOutToken(phone).split('.')[1];
    } catch {
      return null;
    }
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b) ? phone : null;
  }

  /** Reklama matniga bekor qilish ko'rsatmasi — belgi/bo'lak hisobiga KIRADI. */
  appendOptOut(text: string, phone: string): string | null {
    const base = this.sms.optOutBaseUrl;
    if (!base || !this.sms.dlrSecret) return null;
    return `${text}\nRad etish: ${base}/${this.optOutToken(phone)}`;
  }
}
