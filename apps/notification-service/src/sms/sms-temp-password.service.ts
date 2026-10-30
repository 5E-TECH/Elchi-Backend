import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  TEMP_PASSWORD_SMS_TEMPLATE_CODE,
  type PasswordSmsStatus,
} from '@app/common';
import { SmsOutbox } from '../entities/sms-outbox.entity';
import { SmsBlockedError } from './sms-gate.service';
import { SmsDuplicateError, SmsOutboxService } from './sms-outbox.service';
import { SmsProviderRegistry } from './sms-provider.registry';
import {
  SmsTemplateError,
  SmsTemplateService,
  renderSmsTemplate,
} from './sms-template.service';
import { maskPhone } from './sms-phone.util';
import type { SmsSenderProfile } from './sms.port';

export interface SendTempPasswordInput {
  phone?: string;
  password?: string;
  /** identity yaratgan id (`tmppw-<uuid>`) — DLR va holat shu bo'yicha. */
  client_message_id?: string;
  lang?: string | null;
}

export interface TempPasswordSmsState {
  client_message_id: string;
  status: PasswordSmsStatus;
  /** Mashina kodi (`sms_disabled`, `invalid_phone`, `not_delivered` …). */
  failure_reason: string | null;
  queued_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
}

/**
 * Shablon bo'lmasa / o'chirilgan bo'lsa — dizayndagi matn
 * (`superadmin-users-create-password-sms`), GSM-7, 1 bo'lak.
 */
export const DEFAULT_TEMP_PASSWORD_TEXT =
  'Elchi Pochta: hisobingiz yaratildi. Login: {{login}}, parol: {{password}} . Kirish: admin.elchipochta.uz. Parolni hech kimga bermang.';

/** Maskalangan matndagi parol o'rni (dizayndagi namuna kabi). */
export const TEMP_PASSWORD_MASK = '••••••••••••';

const CLIENT_MESSAGE_ID_RE = /^tmppw-[A-Za-z0-9-]{8,57}$/;
/** identity faqat harf+raqam yaratadi; boshqa narsa — buzilgan so'rov. */
const PASSWORD_RE = /^[A-Za-z0-9]{8,64}$/;

const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * `sms_outbox.last_error` → mashina kodi (provayderning xom matni javobga
 * chiqmaydi — ichida nima borligini kafolatlab bo'lmaydi).
 */
export function outboxFailureReason(lastError: string | null): string {
  const text = String(lastError ?? '');
  if (text.startsWith('DLR:')) return 'not_delivered';
  if (text.startsWith('cancelled:')) return 'cancelled';
  if (text.startsWith('staging_blocked')) return 'staging_blocked';
  if (text.startsWith('recovered:')) return 'provider_unavailable';
  if (text.includes('akkaunti sozlanmagan')) return 'provider_not_configured';
  if (/tarmoq xatosi/i.test(text)) return 'provider_unavailable';
  return 'provider_rejected';
}

/**
 * (aidsxJ2H) Vaqtinchalik parol SMS'i — `security` sinfi (tungi taqiqqa
 * tushmaydi, OTP kvotasi), `user.temp_password` shabloni, FAQAT `sms_outbox`
 * orqali. Parol:
 *  - logga, bildirishnomalar (inbox) jadvaliga, faoliyat jurnaliga
 *    YOZILMAYDI — xabar to'g'ridan-to'g'ri SMS navbatiga;
 *  - `sms_outbox.text` da faqat yuborilguncha turadi — provayder qabul
 *    qilgach (yoki terminal xatoda) `redacted_text` (`••••`) bilan
 *    almashtiriladi.
 *
 * `send` HECH QACHON xato tashlamaydi: xato RMQ'da DLQ'ga (parol bilan!)
 * tushardi — o'rniga `{ status: 'failed', failure_reason }` qaytadi
 * (foydalanuvchi baribir yaratiladi, admin «Qayta yuborish» ni bosadi).
 */
@Injectable()
export class SmsTempPasswordService {
  private readonly logger = new Logger(SmsTempPasswordService.name);

  constructor(
    private readonly outbox: SmsOutboxService,
    private readonly registry: SmsProviderRegistry,
    private readonly templates: SmsTemplateService,
    @InjectRepository(SmsOutbox)
    private readonly repo: Repository<SmsOutbox>,
  ) {}

  async send(input: SendTempPasswordInput): Promise<TempPasswordSmsState> {
    const clientMessageId = String(input?.client_message_id ?? '');
    const failed = (reason: string): TempPasswordSmsState => ({
      client_message_id: clientMessageId,
      status: 'failed',
      failure_reason: reason,
      queued_at: null,
      sent_at: null,
      delivered_at: null,
    });
    if (
      !CLIENT_MESSAGE_ID_RE.test(clientMessageId) ||
      !PASSWORD_RE.test(String(input?.password ?? ''))
    ) {
      return failed('invalid_request');
    }
    const password = String(input.password);
    const phone = String(input?.phone ?? '');
    try {
      const senderProfile = await this.senderProfile();
      if (!senderProfile) return failed('provider_not_configured');
      const template = await this.templates.resolve(
        TEMP_PASSWORD_SMS_TEMPLATE_CODE,
        input?.lang ?? 'uz',
      );
      const source = template?.text ?? DEFAULT_TEMP_PASSWORD_TEXT;
      const required = template?.required_vars ?? [];
      const login = phone.startsWith('+') ? phone : `+${phone}`;
      const text = renderSmsTemplate(source, { login, password }, required);
      const redactedText = renderSmsTemplate(
        source,
        { login, password: TEMP_PASSWORD_MASK },
        required,
      );
      // Shablonda {{password}} yo'q bo'lsa SMS foydasiz — yubormaymiz.
      if (text === redactedText) return failed('template_error');
      const result = await this.outbox.enqueue([
        {
          to: phone,
          text,
          redactedText,
          messageClass: 'security',
          templateCode: template?.code ?? TEMP_PASSWORD_SMS_TEMPLATE_CODE,
          senderProfile,
          clientMessageId,
        },
      ]);
      const queued = result.queued[0];
      if (!queued) return failed('invalid_phone');
      return {
        client_message_id: clientMessageId,
        status: 'pending',
        failure_reason: null,
        queued_at: iso(new Date()),
        sent_at: null,
        delivered_at: null,
      };
    } catch (error) {
      if (error instanceof SmsDuplicateError) {
        // Ayni so'rov ikkinchi marta (RMQ qayta yetkazdi) — mavjud holat.
        const [state] = await this.statuses([clientMessageId]).catch(() => []);
        return state ?? failed('duplicate');
      }
      if (error instanceof SmsBlockedError) return failed(error.reason);
      if (error instanceof SmsTemplateError) return failed('template_error');
      // Matn/parol logga TUSHMAYDI — faqat raqam maskasi va xato turi.
      this.logger.error(
        `Vaqtinchalik parol SMS navbatga qo'yilmadi (${maskPhone(phone)}): ${(error as Error)?.name ?? 'Error'}`,
      );
      return failed('internal_error');
    }
  }

  /** `client_message_id` lar bo'yicha joriy holat (topilmagani — ro'yxatda yo'q). */
  async statuses(ids: unknown): Promise<TempPasswordSmsState[]> {
    const clean = (Array.isArray(ids) ? ids : [])
      .map((id) => String(id ?? ''))
      .filter((id) => CLIENT_MESSAGE_ID_RE.test(id))
      .slice(0, 50);
    if (!clean.length) return [];
    const rows = await this.repo.find({
      where: { client_message_id: In(clean) },
      select: [
        'client_message_id',
        'status',
        'last_error',
        'dlr_status',
        'dlr_at',
        'sent_at',
        'created_at',
      ],
    });
    return rows.map((row) => {
      const status: PasswordSmsStatus =
        row.status === 'processing' ? 'pending' : row.status;
      return {
        client_message_id: row.client_message_id,
        status,
        failure_reason:
          status === 'failed' ? outboxFailureReason(row.last_error) : null,
        queued_at: iso(row.created_at),
        sent_at: iso(row.sent_at),
        delivered_at: status === 'delivered' ? iso(row.dlr_at) : null,
      };
    });
  }

  /**
   * OTP akkaunti ('otp' profili — reklama bloki login oqimini o'ldirmasin)
   * bo'lsa o'sha, aks holda asosiy ('default'). Hech biri — `null`.
   */
  private async senderProfile(): Promise<SmsSenderProfile | null> {
    if (await this.registry.hasAccount('otp')) return 'otp';
    if (await this.registry.hasAccount('default')) return 'default';
    return null;
  }
}
