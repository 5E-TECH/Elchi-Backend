import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
  RpcException,
} from '@nestjs/microservices';
import {
  NOTIFICATION_SMS_DELIVERY_STATUS_PATTERN,
  NOTIFICATION_SMS_TEMP_PASSWORD_PATTERN,
  RmqService,
  executeAndAck,
} from '@app/common';
import { SmsCampaignService } from './sms-campaign.service';
import type { CampaignInput } from './sms-campaign.service';
import { SmsConfigService } from './sms-config.service';
import { SmsConsentService } from './sms-consent.service';
import type { GrantConsentInput } from './sms-consent.service';
import { SmsDlrService } from './sms-dlr.service';
import type { SmsDlrInput } from './sms-dlr.service';
import { SmsGateService } from './sms-gate.service';
import { SmsOtpService } from './sms-otp.service';
import type { SendOtpInput } from './sms-otp.service';
import { SmsTempPasswordService } from './sms-temp-password.service';
import type { SendTempPasswordInput } from './sms-temp-password.service';
import { SmsOutboxService, smsReportRange } from './sms-outbox.service';
import { SmsProviderAccountsService } from './sms-provider-accounts.service';
import type { UpsertAccountInput } from './sms-provider-accounts.service';
import { SmsProviderRegistry } from './sms-provider.registry';
import { SmsTemplateService, previewSmsText } from './sms-template.service';
import type {
  SmsTextPreviewInput,
  UpsertTemplateInput,
} from './sms-template.service';

/** Reklama prognozida bekor qilish havolasi uchun namuna raqam (kampaniya bilan bir xil). */
const PREVIEW_PHONE = '+998900000000';

/** Oddiy validatsiya xatosi (Error) → 400; RpcException o'zgarishsiz. */
const asRpc = async <T>(work: () => Promise<T> | T): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RpcException) throw error;
    if (error instanceof Error && error.constructor === Error) {
      throw new RpcException({ statusCode: 400, message: error.message });
    }
    if (
      error instanceof Error &&
      /Template|Blocked|Duplicate/.test(error.name)
    ) {
      throw new RpcException({ statusCode: 400, message: error.message });
    }
    throw error;
  }
};

/** SMS RMQ patternlari (3fRbyadQ, 8auPBa1O, sVByLMnt, rkz0yBxr, nkhURiKX). */
@Controller()
export class SmsController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly config: SmsConfigService,
    private readonly gate: SmsGateService,
    private readonly outbox: SmsOutboxService,
    private readonly accounts: SmsProviderAccountsService,
    private readonly registry: SmsProviderRegistry,
    private readonly templates: SmsTemplateService,
    private readonly campaigns: SmsCampaignService,
    private readonly consent: SmsConsentService,
    private readonly dlr: SmsDlrService,
    private readonly otp: SmsOtpService,
    private readonly tempPassword: SmsTempPasswordService,
  ) {}

  private run<T>(context: RmqContext, work: () => Promise<T> | T) {
    return executeAndAck(this.rmqService, context, () => asRpc(work));
  }

  @MessagePattern({ cmd: 'notification.sms.dlr' })
  deliveryReport(@Payload() data: SmsDlrInput, @Ctx() context: RmqContext) {
    return this.run(context, () => this.dlr.handle(data));
  }

  @MessagePattern({ cmd: 'notification.sms.send_otp' })
  sendOtp(@Payload() data: SendOtpInput, @Ctx() context: RmqContext) {
    return this.run(context, () => this.otp.send(data));
  }

  /**
   * (aidsxJ2H) identity: yangi foydalanuvchining vaqtinchalik paroli —
   * `security` SMS navbatiga. Xato TASHLAMAYDI (DLQ'ga parol tushmasin) —
   * `{ status: 'pending' | 'failed', failure_reason }`.
   */
  @MessagePattern({ cmd: NOTIFICATION_SMS_TEMP_PASSWORD_PATTERN })
  sendTempPassword(
    @Payload() data: SendTempPasswordInput,
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () => this.tempPassword.send(data));
  }

  /** (aidsxJ2H) `client_message_ids` bo'yicha SMS yetkazish holati. */
  @MessagePattern({ cmd: NOTIFICATION_SMS_DELIVERY_STATUS_PATTERN })
  deliveryStatus(
    @Payload() data: { client_message_ids?: unknown },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      this.tempPassword.statuses(data?.client_message_ids),
    );
  }

  /** Admin ekrani uchun holat: yoqilganmi, akkauntlar, bugungi sarf, tariflar. */
  @MessagePattern({ cmd: 'notification.sms.status' })
  status(@Ctx() context: RmqContext) {
    return this.run(context, async () => ({
      enabled: this.config.enabled,
      provider: this.config.provider,
      default_account: await this.registry.hasAccount('default'),
      otp_account: await this.registry.hasAccount('otp'),
      credential_secret_configured: this.accounts.cipherConfigured,
      used_today: await this.gate.usedToday(),
      daily_cap: this.config.dailyCap,
      // (rkz0yBxr) OTP — alohida oqim, alohida kvota.
      otp_used_today: await this.gate.usedToday(undefined, undefined, 'otp'),
      otp_daily_cap: this.config.otpDailyCap,
      max_fanout: this.config.maxFanout,
      quiet_hours: this.config.quietHours,
      tariffs: {
        transactional: this.config.tariff('transactional'),
        promo: this.config.tariff('promo'),
        security: this.config.tariff('security'),
      },
    }));
  }

  /** Muharrir hisoblagichi uchun tariflar (D5sxjGBY #2). Sozlanmagan → null. */
  @MessagePattern({ cmd: 'notification.sms.tariffs' })
  tariffs(@Ctx() context: RmqContext) {
    return this.run(context, () => ({
      currency: 'UZS',
      transactional: this.config.tariff('transactional'),
      promo: this.config.tariff('promo'),
      security: this.config.tariff('security'),
    }));
  }

  @MessagePattern({ cmd: 'notification.sms.report' })
  report(
    @Payload() data: { from?: string; to?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () => {
      // (8auPBa1O TC11) Kun chegaralari Toshkent bo'yicha (smsReportRange).
      const range = smsReportRange(data?.from, data?.to);
      if (!range) throw new Error("from/to noto'g'ri");
      return this.outbox.costReport(range.from, range.to);
    });
  }

  @MessagePattern({ cmd: 'notification.sms.accounts.list' })
  listAccounts(@Ctx() context: RmqContext) {
    return this.run(context, () => this.accounts.list());
  }

  @MessagePattern({ cmd: 'notification.sms.accounts.upsert' })
  upsertAccount(
    @Payload() data: UpsertAccountInput & { requester_id?: string | null },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      this.accounts.upsert(data, data?.requester_id ?? null),
    );
  }

  @MessagePattern({ cmd: 'notification.sms.templates.list' })
  listTemplates(@Ctx() context: RmqContext) {
    return this.run(context, async () =>
      (await this.templates.list()).map((template) =>
        this.templates.withMeta(template),
      ),
    );
  }

  @MessagePattern({ cmd: 'notification.sms.templates.upsert' })
  upsertTemplate(
    @Payload() data: UpsertTemplateInput,
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () => this.templates.upsert(data));
  }

  /**
   * Muharrir hisoblagichi (nkhURiKX #6): kodlash, bo'laklar, UCS-2 ga
   * o'tkazgan belgilar, taxminiy narx, PII/yetishmagan o'zgaruvchilar.
   * Hech narsa yozilmaydi va yuborilmaydi.
   */
  @MessagePattern({ cmd: 'notification.sms.templates.preview' })
  previewTemplate(
    @Payload() data: SmsTextPreviewInput,
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      previewSmsText(data ?? {}, {
        tariff: (messageClass) => this.config.tariff(messageClass),
        appendOptOut: (text) => this.consent.appendOptOut(text, PREVIEW_PHONE),
      }),
    );
  }

  @MessagePattern({ cmd: 'notification.sms.templates.approve' })
  approveTemplate(
    @Payload() data: { id: string; provider_template_id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      this.templates.markApproved(
        data.id,
        String(data.provider_template_id ?? ''),
      ),
    );
  }

  @MessagePattern({ cmd: 'notification.sms.templates.delete' })
  deleteTemplate(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.run(context, () => this.templates.remove(data.id));
  }

  @MessagePattern({ cmd: 'notification.sms.campaign.preview' })
  previewCampaign(@Payload() data: CampaignInput, @Ctx() context: RmqContext) {
    return this.run(context, () => this.campaigns.preview(data));
  }

  @MessagePattern({ cmd: 'notification.sms.campaign.send' })
  sendCampaign(
    @Payload()
    data: CampaignInput & {
      idempotency_key?: string;
      requester_id?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      this.campaigns.send(
        data,
        data?.idempotency_key ?? null,
        data?.requester_id ?? null,
      ),
    );
  }

  /** (2aS7PFX0) Rejalashtirilgan (hali navbatga qo'yilmagan) kampaniyani bekor qilish. */
  @MessagePattern({ cmd: 'notification.sms.campaign.cancel' })
  cancelCampaign(
    @Payload() data: { id?: string; requester_id?: string | null },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      this.campaigns.cancel(data?.id, data?.requester_id ?? null),
    );
  }

  @MessagePattern({ cmd: 'notification.sms.campaign.history' })
  campaignHistory(
    @Payload() data: { limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      this.campaigns.history(Number(data?.limit) || 50),
    );
  }

  @MessagePattern({ cmd: 'notification.sms.consent.grant' })
  grantConsent(@Payload() data: GrantConsentInput, @Ctx() context: RmqContext) {
    return this.run(context, async () => {
      const row = await this.consent.grant(data);
      return { id: row.id, phone: row.phone, granted_at: row.granted_at };
    });
  }

  @MessagePattern({ cmd: 'notification.sms.consent.revoke' })
  revokeConsent(
    @Payload() data: { phone: string },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, async () => ({
      revoked: await this.consent.revoke(String(data?.phone ?? '')),
    }));
  }

  /** SMS'dagi bekor qilish havolasi (public) — token sir bilan tekshiriladi. */
  @MessagePattern({ cmd: 'notification.sms.opt_out' })
  optOut(@Payload() data: { token?: string }, @Ctx() context: RmqContext) {
    return this.run(context, async () => {
      const phone = this.consent.verifyOptOutToken(String(data?.token ?? ''));
      if (!phone)
        throw new RpcException({
          statusCode: 404,
          message: "Havola noto'g'ri yoki eskirgan",
        });
      await this.consent.revoke(phone);
      return { unsubscribed: true };
    });
  }
}
