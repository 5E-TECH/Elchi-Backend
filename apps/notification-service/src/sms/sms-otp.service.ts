import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { SmsBlockedError } from './sms-gate.service';
import { SmsOutboxService } from './sms-outbox.service';
import { SmsProviderRegistry } from './sms-provider.registry';
import { SmsTemplateService, renderSmsTemplate } from './sms-template.service';

export interface SendOtpInput {
  phone: string;
  code: string;
  otp_id: string;
  lang?: string | null;
}

/** Shablon bo'lmasa — qisqa lotin matn (GSM-7, 1 bo'lak). */
const DEFAULT_OTP_TEXT =
  'Elchi tasdiqlash kodi: {{code}}. Kodni hech kimga bermang.';

/**
 * OTP SMS (rkz0yBxr #6/#7): `security` sinfi — tungi taqiqqa TUSHMAYDI;
 * 'otp' akkaunt/alfa-nomidan — reklama bloki login oqimini o'ldirmasin.
 * Kod sms_outbox matnida faqat yuborilguncha turadi (keyin `******`).
 */
@Injectable()
export class SmsOtpService {
  constructor(
    private readonly outbox: SmsOutboxService,
    private readonly registry: SmsProviderRegistry,
    private readonly templates: SmsTemplateService,
  ) {}

  async send(input: SendOtpInput) {
    if (!/^\d{4,8}$/.test(String(input?.code ?? '')) || !input?.otp_id) {
      throw new RpcException({
        statusCode: 400,
        message: "code/otp_id noto'g'ri",
      });
    }
    if (!(await this.registry.hasAccount('otp'))) {
      throw new RpcException({
        statusCode: 503,
        message: "OTP uchun alohida SMS akkaunti ('otp' profili) sozlanmagan",
        reason: 'provider_not_configured',
      });
    }
    const template = await this.templates.resolve('otp.login', input.lang);
    const text = renderSmsTemplate(template?.text ?? DEFAULT_OTP_TEXT, {
      code: input.code,
    });
    try {
      const result = await this.outbox.enqueue([
        {
          to: input.phone,
          text,
          messageClass: 'security',
          templateCode: template?.code ?? null,
          senderProfile: 'otp',
          clientMessageId: `otp-${input.otp_id}`,
        },
      ]);
      if (!result.queued.length) {
        throw new RpcException({
          statusCode: 400,
          message: "Telefon raqami noto'g'ri",
        });
      }
      return { queued: true };
    } catch (error) {
      if (error instanceof SmsBlockedError) {
        throw new RpcException({
          statusCode: 503,
          message: error.message,
          reason: error.reason,
        });
      }
      throw error;
    }
  }
}
