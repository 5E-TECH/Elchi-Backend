import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { rmqSend } from '@app/common';
import { SmsCampaign } from '../entities/sms-campaign.entity';
import { SmsConfigService } from './sms-config.service';
import { SmsConsentService } from './sms-consent.service';
import { SmsDispatchService } from './sms-dispatch.service';
import { SmsBlockedError, SmsGateService } from './sms-gate.service';
import { SmsOutboxService } from './sms-outbox.service';
import { normalizeSmsPhone } from './sms-phone.util';
import { countSmsSegments } from './sms-segments.util';
import {
  SmsTemplateService,
  renderSmsTemplate,
  SmsTemplateError,
} from './sms-template.service';
import type { SmsMessageClass } from './sms.port';

export interface CampaignSegment {
  market_id?: string | null;
  region_id?: string | null;
  district_id?: string | null;
  last_order_from?: string | null;
  last_order_to?: string | null;
  min_orders?: number | null;
  /** Qo'lda raqamlar ro'yxati (segment o'rniga). */
  phones?: string[] | null;
}

export interface CampaignInput {
  message_class?: string;
  text?: string | null;
  template_code?: string | null;
  lang?: string | null;
  vars?: Record<string, unknown> | null;
  segment?: CampaignSegment | null;
}

interface Recipient {
  phone: string;
  customer_id: string | null;
}

const rpcError = (
  statusCode: number,
  message: string,
  extra: Record<string, unknown> = {},
) => new RpcException({ statusCode, message, ...extra });

/**
 * Reklama/xabar kampaniyasi (sVByLMnt #5-#7): segment → rozilik darvozasi
 * (reklama uchun fail-closed) → tasdiq oynasi uchun prognoz → navbat → tarix.
 */
@Injectable()
export class SmsCampaignService {
  constructor(
    @InjectRepository(SmsCampaign)
    private readonly repo: Repository<SmsCampaign>,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    private readonly config: SmsConfigService,
    private readonly consent: SmsConsentService,
    private readonly dispatch: SmsDispatchService,
    private readonly gate: SmsGateService,
    private readonly outbox: SmsOutboxService,
    private readonly templates: SmsTemplateService,
  ) {}

  /** Tasdiq oynasi uchun: hech narsa yuborilmaydi. */
  async preview(input: CampaignInput) {
    const plan = await this.plan(input);
    return {
      message_class: plan.messageClass,
      text: plan.text,
      sample_text: plan.sampleText,
      encoding: plan.segments.encoding,
      parts: plan.segments.parts,
      total: plan.total,
      recipients: plan.allowed.length,
      blocked_no_consent: plan.blocked.length,
      skipped_invalid_phone: plan.invalid,
      max_fanout: this.config.maxFanout,
      fanout_exceeded:
        plan.allowed.length > this.config.maxFanout || plan.truncated,
      tariff: this.config.tariff(plan.messageClass),
      estimated_cost: plan.estimatedCost,
      scheduled_for: this.gate.scheduleFor(plan.messageClass),
      sms_enabled: this.config.enabled,
    };
  }

  async send(
    input: CampaignInput,
    idempotencyKey: string | null,
    userId: string | null,
  ) {
    const key = String(idempotencyKey ?? '').trim();
    if (!key || key.length > 128) {
      throw rpcError(
        400,
        'Idempotency-Key sarlavhasi majburiy (≤128 belgi) — qayta bosilganda ikki marta yuborilmasin',
      );
    }
    const existing = await this.repo.findOne({
      where: { idempotency_key: key },
    });
    if (existing) {
      throw rpcError(
        409,
        'Bu kampaniya allaqachon yuborilgan (Idempotency-Key takror)',
        {
          campaign_id: existing.id,
        },
      );
    }

    const plan = await this.plan(input);
    if (plan.truncated || plan.allowed.length > this.config.maxFanout) {
      throw rpcError(
        400,
        `Qabul qiluvchilar ${plan.allowed.length}${plan.truncated ? '+' : ''} — chegara ${this.config.maxFanout} (SMS_MAX_FANOUT). Segmentni toraytiring.`,
      );
    }
    if (!plan.allowed.length) {
      throw rpcError(
        400,
        "Yuboriladigan qabul qiluvchi yo'q (rozilik yo'q yoki raqamlar noto'g'ri)",
        {
          blocked_no_consent: plan.blocked.length,
          skipped_invalid_phone: plan.invalid,
        },
      );
    }

    let campaign: SmsCampaign;
    try {
      campaign = await this.repo.save(
        this.repo.create({
          idempotency_key: key,
          created_by: userId,
          message_class: plan.messageClass,
          template_code: input.template_code ?? null,
          text: plan.text,
          segment: (input.segment ?? {}) as Record<string, unknown>,
          status: 'queued',
          total: plan.total,
          blocked: plan.blocked.length,
          skipped: plan.invalid,
          estimated_cost:
            plan.estimatedCost === null ? null : plan.estimatedCost.toFixed(2),
        }),
      );
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw rpcError(
          409,
          'Bu kampaniya allaqachon yuborilgan (Idempotency-Key takror)',
        );
      }
      throw error;
    }

    try {
      const result = await this.outbox.enqueue(
        plan.allowed.map((recipient) => ({
          to: recipient.phone,
          text: plan.text,
          messageClass: plan.messageClass,
          templateCode: input.template_code ?? null,
          campaignId: campaign.id,
          clientMessageId: `camp-${campaign.id}-${recipient.phone.replace(/\D/g, '')}`,
        })),
      );
      await this.repo.update(
        { id: campaign.id },
        { queued: result.queued.length },
      );
      return {
        campaign_id: campaign.id,
        queued: result.queued.length,
        blocked_no_consent: plan.blocked.length,
        skipped_invalid_phone: plan.invalid + result.skipped.length,
        estimated_cost: result.estimated_cost,
        scheduled_for: result.queued[0]?.scheduled_at ?? null,
      };
    } catch (error) {
      await this.repo.update({ id: campaign.id }, { status: 'failed' });
      if (error instanceof SmsBlockedError) {
        throw rpcError(409, error.message, {
          reason: error.reason,
          ...error.details,
        });
      }
      throw error;
    }
  }

  async history(limit = 50) {
    const rows = await this.repo.find({
      order: { created_at: 'DESC' },
      take: Math.min(limit, 200),
    });
    const counts = await this.outbox.countByCampaign(rows.map((row) => row.id));
    return rows.map((row) => {
      const byStatus = counts.get(String(row.id)) ?? {};
      return {
        ...row,
        sent: (byStatus.sent ?? 0) + (byStatus.delivered ?? 0),
        delivered: byStatus.delivered ?? 0,
        failed: byStatus.failed ?? 0,
        pending: (byStatus.pending ?? 0) + (byStatus.processing ?? 0),
      };
    });
  }

  // ---------------------------------------------------------------------------

  private async plan(input: CampaignInput) {
    const { messageClass, text } = await this.resolveText(input);
    const { recipients, invalid, truncated } = await this.resolveRecipients(
      input.segment ?? {},
    );
    const total = recipients.length + invalid;

    const { allowed, blocked } =
      messageClass === 'promo'
        ? await this.consent.partition(recipients)
        : { allowed: recipients, blocked: [] as Recipient[] };

    // Prognoz: reklamada bekor qilish havolasi ham bo'lak hisobiga KIRADI.
    const sampleText =
      messageClass === 'promo'
        ? this.consent.appendOptOut(text, allowed[0]?.phone ?? '+998900000000')
        : text;
    if (sampleText === null) {
      throw rpcError(
        409,
        'Reklama uchun bekor qilish havolasi sozlanmagan (SMS_OPT_OUT_BASE_URL, SMS_DLR_SECRET)',
        { reason: 'opt_out_not_configured' },
      );
    }
    const segments = countSmsSegments(sampleText);
    const tariff = this.config.tariff(messageClass);
    const estimatedCost =
      tariff === null ? null : tariff * segments.parts * allowed.length;
    return {
      messageClass,
      text,
      sampleText,
      segments,
      total,
      allowed,
      blocked,
      invalid,
      truncated,
      estimatedCost,
    };
  }

  private async resolveText(
    input: CampaignInput,
  ): Promise<{ messageClass: SmsMessageClass; text: string }> {
    if (input.template_code) {
      const template = await this.templates.resolve(
        input.template_code,
        input.lang,
      );
      if (!template)
        throw rpcError(404, `Shablon topilmadi: ${input.template_code}`);
      try {
        return {
          messageClass: template.message_class,
          text: renderSmsTemplate(
            template.text,
            input.vars ?? {},
            template.required_vars,
          ),
        };
      } catch (error) {
        if (error instanceof SmsTemplateError) {
          throw rpcError(400, error.message, { missing: error.missing });
        }
        throw error;
      }
    }
    const messageClass =
      input.message_class === 'promo'
        ? 'promo'
        : input.message_class === 'transactional'
          ? 'transactional'
          : null;
    if (!messageClass)
      throw rpcError(400, "message_class: 'promo' yoki 'transactional'");
    const text = String(input.text ?? '').trim();
    if (!text) throw rpcError(400, "Xabar matni bo'sh");
    try {
      // Matnda {{var}} qolsa — to'ldirilmagan, yuborilmaydi.
      return { messageClass, text: renderSmsTemplate(text, input.vars ?? {}) };
    } catch (error) {
      if (error instanceof SmsTemplateError)
        throw rpcError(400, error.message, { missing: error.missing });
      throw error;
    }
  }

  private async resolveRecipients(segment: CampaignSegment) {
    if (Array.isArray(segment.phones) && segment.phones.length) {
      const seen = new Set<string>();
      const recipients: Recipient[] = [];
      let invalid = 0;
      for (const raw of segment.phones) {
        const phone = normalizeSmsPhone(raw);
        if (!phone) invalid += 1;
        else if (!seen.has(phone)) {
          seen.add(phone);
          recipients.push({ phone, customer_id: null });
        }
      }
      return { recipients, invalid, truncated: false };
    }

    const res = await rmqSend<{
      data?: { items?: Array<{ customer_id: string }>; truncated?: boolean };
    }>(
      this.orderClient,
      { cmd: 'order.customer.segment' },
      {
        ...segment,
        limit: this.config.maxFanout,
      },
    );
    const items = res?.data?.items ?? [];
    const contacts = await this.dispatch.contacts(
      items.map((item) => String(item.customer_id)),
    );
    const seen = new Set<string>();
    const recipients: Recipient[] = [];
    let invalid = 0;
    for (const item of items) {
      const contact = contacts.get(String(item.customer_id));
      const phone = normalizeSmsPhone(contact?.phone_number);
      if (!phone) invalid += 1;
      else if (!seen.has(phone)) {
        seen.add(phone);
        recipients.push({ phone, customer_id: String(item.customer_id) });
      }
    }
    return { recipients, invalid, truncated: Boolean(res?.data?.truncated) };
  }
}
