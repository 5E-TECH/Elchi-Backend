import { Inject, Injectable, Optional } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { rmqSend } from '@app/common';
import { CAMPAIGN_MAX_SCHEDULE_DAYS } from '../campaign/campaign-limits';
import {
  parseZonedInstant,
  toTashkentIso,
} from '../campaign/campaign-schedule';
import { NotificationAudienceSegment } from '../audience/audience-segment.entity';
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
  piiVars,
  renderSmsTemplate,
  SmsTemplateError,
  templateVars,
} from './sms-template.service';
import type { SmsMessageClass } from './sms.port';

export interface CampaignSegment {
  market_id?: string | null;
  region_id?: string | null;
  district_id?: string | null;
  last_order_from?: string | null;
  last_order_to?: string | null;
  min_orders?: number | null;
  /** (sdNGqCBa) Buyurtmalar soni «gacha» (kiradi) — push kampaniyasi bilan bir xil. */
  max_orders?: number | null;
  /** Qo'lda raqamlar ro'yxati (segment o'rniga). */
  phones?: string[] | null;
  /** (sdNGqCBa) Qaysi saqlangan segmentdan olingan (faqat ma'lumot). */
  audience_segment_id?: string | null;
}

/** order-service `order.customer.segment` tushunadigan filtrlar (boshqasi yuborilmaydi). */
const ORDER_SEGMENT_KEYS = [
  'market_id',
  'region_id',
  'district_id',
  'last_order_from',
  'last_order_to',
  'min_orders',
  'max_orders',
] as const;

export interface CampaignInput {
  /** Faqat 'promo' (berilmasa ham promo); boshqasi — 400 campaign_promo_only. */
  message_class?: string;
  text?: string | null;
  template_code?: string | null;
  lang?: string | null;
  vars?: Record<string, unknown> | null;
  segment?: CampaignSegment | null;
  /**
   * (sdNGqCBa) Saqlangan segment (`notifications/audience/segments`) — push
   * kampaniyasi bilan BITTA jadval. `segment` bilan birga berilmaydi.
   */
  audience_segment_id?: string | null;
  /**
   * (2aS7PFX0) Rejalashtirish: ISO 8601 + ANIQ zona (`+05:00` yoki `Z`), ≤90
   * kun. O'tgan/bo'sh — darhol. Reklama taqiq oynasiga tushsa — oyna tugashiga.
   */
  scheduled_at?: string | null;
}

/** (2aS7PFX0) Bitta tikda ko'pi bilan shuncha rejalashtirilgan kampaniya ishga tushadi. */
export const SMS_CAMPAIGN_RELEASE_BATCH = 5;
const ERROR_MAX = 300;
const ID_RE = /^\d{1,19}$/;

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
 * (sVByLMnt) Kampaniya FAQAT reklama: admin yozgan ommaviy xabar mijoz
 * segmentiga — bu reklama, rozilik va 18:00–09:00 taqiqi SHART. Ilgari
 * `message_class='transactional'` ("Xizmat xabari") ikkala darvozani
 * chetlab o'tardi — reklama matnini tunda roziliksiz yuborish mumkin edi.
 * Transaksion istisnosi PQ-265 da alohida yozilmagan (yurist), shuning uchun
 * xizmat (transactional) va OTP (security) SMS faqat TIZIM hodisalaridan
 * ketadi: buyurtma holati dispatch'i, CRITICAL eskalatsiya, OTP.
 */
const CAMPAIGN_PROMO_ONLY =
  "Kampaniya faqat reklama (message_class='promo') — rozilik va 18:00–09:00 taqiqi bilan. Xizmat (transactional) va OTP (security) SMS faqat tizim hodisalaridan (buyurtma holati, OTP) avtomatik ketadi.";

/**
 * (nkhURiKX #8) PII minimumi: mijoz ismi/manzili/mahsulot ro'yxati SMS
 * o'zgaruvchisi bo'la olmaydi — xom matnda ham, shablonda ham (eski qator).
 */
const assertNoPii = (keys: readonly string[]) => {
  const pii = piiVars(keys);
  if (pii.length) {
    throw rpcError(
      400,
      `SMS'da shaxsiy ma'lumot taqiqlangan (PII minimumi): ${pii.join(', ')}`,
      { reason: 'pii_forbidden', pii_vars: pii },
    );
  }
};

const promoOnly = (requested: unknown) =>
  rpcError(400, CAMPAIGN_PROMO_ONLY, {
    reason: 'campaign_promo_only',
    message_class: requested ?? null,
  });

const isBlank = (value: unknown) =>
  value === undefined ||
  value === null ||
  String(value as string).trim() === '';

/**
 * (sdNGqCBa) Segment tekshiruvi — identity audience-resolver bilan BIR XIL
 * xabarlar: buyurtmalar soni musbat butun, teskari oraliq — 400 (jim 0 emas).
 */
export const normalizeCampaignSegment = (
  raw: CampaignSegment,
): CampaignSegment => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw rpcError(400, "segment obyekt bo'lishi kerak");
  }
  const segment: CampaignSegment = { ...raw };
  for (const key of ['min_orders', 'max_orders'] as const) {
    if (isBlank(segment[key])) {
      delete segment[key];
      continue;
    }
    const value = Number(segment[key]);
    if (!Number.isInteger(value) || value < 1) {
      throw rpcError(400, `segment.${key} — musbat butun son bo'lishi kerak`);
    }
    segment[key] = value;
  }
  if (
    segment.min_orders !== undefined &&
    segment.min_orders !== null &&
    segment.max_orders !== undefined &&
    segment.max_orders !== null &&
    segment.min_orders > segment.max_orders
  ) {
    throw rpcError(
      400,
      "segment: min_orders max_orders dan katta bo'lmasligi kerak (teskari oraliq)",
      { reason: 'segment_inverted_range' },
    );
  }
  return segment;
};

const shortError = (error: unknown): string => {
  const rpc =
    error instanceof RpcException
      ? (error.getError() as { message?: unknown })
      : null;
  const message =
    (typeof rpc?.message === 'string' && rpc.message) ||
    (error instanceof Error ? error.message : '') ||
    'unknown';
  return message.slice(0, ERROR_MAX);
};

type CampaignPlan = Awaited<ReturnType<SmsCampaignService['planFor']>>;

/**
 * Reklama kampaniyasi (sVByLMnt #5-#7): segment → rozilik darvozasi
 * (fail-closed) → tasdiq oynasi uchun prognoz → navbat → tarix.
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
    /** (sdNGqCBa) Saqlangan auditoriya segmentlari (push bilan umumiy jadval). */
    @Optional()
    @InjectRepository(NotificationAudienceSegment)
    private readonly savedSegments?: Repository<NotificationAudienceSegment>,
  ) {}

  /** Tasdiq oynasi uchun: hech narsa yuborilmaydi. */
  async preview(input: CampaignInput) {
    const schedule = this.scheduleOf(input?.scheduled_at);
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
      scheduled_for:
        schedule?.scheduledAt ?? this.gate.scheduleFor(plan.messageClass),
      // (2aS7PFX0) rejalashtirish: so'ralgan lahza, Toshkent ko'rinishi, surilish.
      requested_at: schedule?.requestedAt ?? null,
      scheduled_for_tashkent: toTashkentIso(
        schedule?.scheduledAt ?? this.gate.scheduleFor(plan.messageClass),
      ),
      quiet_hours_shifted: schedule?.shifted ?? false,
      sms_enabled: this.config.enabled,
    };
  }

  /**
   * (2aS7PFX0) `scheduled_at` → haqiqiy yuborish lahzasi. Bo'sh yoki o'tgan
   * vaqt — null (darhol). Zonasiz — 400 (qo'shaloq konversiya bo'lmasin),
   * 90 kundan uzoq — 400. Reklama 18:00–09:00 oynasiga tushsa — oyna
   * tugashiga suriladi (yagona `gate.scheduleFor` qoidasi).
   */
  private scheduleOf(raw: unknown): {
    requestedAt: Date;
    scheduledAt: Date;
    shifted: boolean;
  } | null {
    // Faqat satr (RMQ'da ValidationPipe yo'q) — obyekt/son — 400.
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      throw rpcError(400, "scheduled_at satr bo'lishi kerak (ISO + zona)", {
        reason: 'scheduled_at_invalid',
      });
    }
    const value = (raw ?? '').trim();
    if (!value) return null;
    let requested: Date;
    try {
      requested = parseZonedInstant(value);
    } catch (error) {
      throw rpcError(400, (error as Error).message, {
        reason: 'scheduled_at_invalid',
      });
    }
    const now = Date.now();
    if (requested.getTime() <= now) return null;
    if (requested.getTime() > now + CAMPAIGN_MAX_SCHEDULE_DAYS * 86_400_000) {
      throw rpcError(
        400,
        `scheduled_at ko'pi bilan ${CAMPAIGN_MAX_SCHEDULE_DAYS} kun oldinga`,
        { reason: 'scheduled_at_too_far' },
      );
    }
    const release = this.gate.scheduleFor('promo', requested);
    const scheduledAt =
      release.getTime() > requested.getTime() ? release : requested;
    return {
      requestedAt: requested,
      scheduledAt,
      shifted: scheduledAt.getTime() !== requested.getTime(),
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

    const schedule = this.scheduleOf(input?.scheduled_at);
    const plan = await this.plan(input);
    this.assertSendable(plan);

    let campaign: SmsCampaign;
    try {
      campaign = await this.repo.save(
        this.repo.create({
          idempotency_key: key,
          created_by: userId,
          message_class: plan.messageClass,
          template_code: input.template_code ?? null,
          text: plan.text,
          // (sdNGqCBa) Hal qilingan shart (saqlangan segmentdan ham) — vaqti
          // kelganda (2aS7PFX0) aynan shu shart bilan qayta sanaladi.
          segment: plan.segment as Record<string, unknown>,
          status: schedule ? 'scheduled' : 'queued',
          scheduled_at: schedule?.scheduledAt ?? null,
          requested_at: schedule?.requestedAt ?? null,
          quiet_hours_shifted: schedule?.shifted ?? false,
          started_at: schedule ? null : new Date(),
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

    if (schedule) {
      // (2aS7PFX0) sms_outbox'ga HOZIR yozilmaydi: vaqti kelganda auditoriya,
      // rozilik/opt-out va kunlik kvota O'SHA KUNI qayta tekshiriladi
      // (`releaseDue`). Bu yerdagi sonlar — prognoz.
      return {
        campaign_id: campaign.id,
        status: 'scheduled' as const,
        queued: 0,
        recipients: plan.allowed.length,
        blocked_no_consent: plan.blocked.length,
        skipped_invalid_phone: plan.invalid,
        estimated_cost: plan.estimatedCost,
        scheduled_for: schedule.scheduledAt,
        scheduled_for_tashkent: toTashkentIso(schedule.scheduledAt),
        requested_at: schedule.requestedAt,
        quiet_hours_shifted: schedule.shifted,
      };
    }

    try {
      const result = await this.enqueuePlan(campaign, plan);
      return {
        campaign_id: campaign.id,
        status: 'queued' as const,
        queued: result.queued.length,
        blocked_no_consent: plan.blocked.length,
        skipped_invalid_phone: plan.invalid + result.skipped.length,
        estimated_cost: result.estimated_cost,
        scheduled_for: result.queued[0]?.scheduled_at ?? null,
      };
    } catch (error) {
      await this.repo.update(
        { id: campaign.id },
        { status: 'failed', last_error: shortError(error) },
      );
      if (error instanceof SmsBlockedError) {
        throw rpcError(409, error.message, {
          reason: error.reason,
          ...error.details,
        });
      }
      throw error;
    }
  }

  /** Bo'sh / chegaradan katta reja — XATO (jimgina kesilmaydi). */
  private assertSendable(plan: CampaignPlan) {
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
  }

  /** Reja → sms_outbox (darvoza: rozilik, opt-out, kill-switch, kunlik kvota). */
  private async enqueuePlan(campaign: SmsCampaign, plan: CampaignPlan) {
    const result = await this.outbox.enqueue(
      plan.allowed.map((recipient) => ({
        to: recipient.phone,
        customerId: recipient.customer_id,
        text: plan.text,
        messageClass: plan.messageClass,
        templateCode: campaign.template_code ?? null,
        campaignId: campaign.id,
        clientMessageId: `camp-${campaign.id}-${recipient.phone.replace(/\D/g, '')}`,
      })),
    );
    await this.repo.update(
      { id: campaign.id },
      { queued: result.queued.length },
    );
    return result;
  }

  /**
   * (2aS7PFX0) Vaqti kelgan rejalashtirilgan kampaniyalar → sms_outbox.
   * SMS navbati tikida (advisory lock ostida, bitta replika) chaqiriladi.
   * Har biri: `scheduled → queued` atomik da'vo (ikki marta yuborilmaydi),
   * auditoriya JONLI qayta olinadi, rozilik/opt-out va KUNLIK KVOTA o'sha
   * kuni `outbox.enqueue` darvozasida tekshiriladi. Rad etilsa — `failed` +
   * `last_error` (hech narsa yuborilmaydi).
   */
  async releaseDue(now = new Date(), limit = SMS_CAMPAIGN_RELEASE_BATCH) {
    const due = await this.repo.find({
      where: { status: 'scheduled', scheduled_at: LessThanOrEqual(now) },
      order: { scheduled_at: 'ASC', id: 'ASC' },
      take: limit,
    });
    let released = 0;
    for (const campaign of due) {
      const claimed = await this.repo.update(
        { id: campaign.id, status: 'scheduled' },
        { status: 'queued', started_at: now },
      );
      if (!claimed.affected) continue;
      try {
        const plan = await this.planFor(
          campaign.text,
          (campaign.segment ?? {}) as CampaignSegment,
        );
        await this.repo.update(
          { id: campaign.id },
          {
            total: plan.total,
            blocked: plan.blocked.length,
            skipped: plan.invalid,
            estimated_cost:
              plan.estimatedCost === null
                ? null
                : plan.estimatedCost.toFixed(2),
          },
        );
        this.assertSendable(plan);
        await this.enqueuePlan(campaign, plan);
        released += 1;
      } catch (error) {
        await this.repo.update(
          { id: campaign.id },
          { status: 'failed', last_error: shortError(error) },
        );
      }
    }
    return released;
  }

  /** (2aS7PFX0) Faqat `scheduled` (hali navbatga qo'yilmagan) bekor qilinadi. */
  async cancel(rawId: unknown, actor: string | null) {
    const id =
      typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId).trim()
        : '';
    if (!ID_RE.test(id)) throw rpcError(400, "id noto'g'ri");
    const result = await this.repo.update(
      { id, status: 'scheduled' },
      {
        status: 'cancelled',
        cancelled_at: new Date(),
        cancelled_by: actor && ID_RE.test(actor) ? actor : null,
      },
    );
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw rpcError(404, 'SMS kampaniya topilmadi');
    if (!result.affected) {
      throw rpcError(
        409,
        `Kampaniya bekor qilinmaydi (holati: ${row.status}) — faqat rejalashtirilgan (scheduled) kampaniya`,
        { status: row.status },
      );
    }
    return this.toPublic(row, {});
  }

  private toPublic(row: SmsCampaign, byStatus: Record<string, number>) {
    return {
      ...row,
      sent: (byStatus.sent ?? 0) + (byStatus.delivered ?? 0),
      delivered: byStatus.delivered ?? 0,
      failed: byStatus.failed ?? 0,
      pending: (byStatus.pending ?? 0) + (byStatus.processing ?? 0),
      // (2aS7PFX0) rejalashtirish ko'rinishi.
      scheduled_for: row.scheduled_at ?? null,
      scheduled_for_tashkent: toTashkentIso(row.scheduled_at ?? null),
      can_cancel: row.status === 'scheduled',
    };
  }

  async history(limit = 50) {
    const rows = await this.repo.find({
      order: { created_at: 'DESC' },
      take: Math.min(limit, 200),
    });
    const counts = await this.outbox.countByCampaign(rows.map((row) => row.id));
    return rows.map((row) =>
      this.toPublic(row, counts.get(String(row.id)) ?? {}),
    );
  }

  // ---------------------------------------------------------------------------

  private async plan(input: CampaignInput): Promise<CampaignPlan> {
    const segment = await this.segmentOf(input);
    const { text } = await this.resolveText(input);
    return this.planFor(text, segment);
  }

  /**
   * (sdNGqCBa) Kampaniya sharti: `segment` YOKI `audience_segment_id`
   * (saqlangan segment — push kampaniyasi bilan bitta jadval). Saqlangan
   * shartdan faqat MIJOZ segmenti olinadi: xodim rollari / broadcast — SMS
   * reklama kampaniyasida 400 (bu API buyurtmalar bo'yicha mijozlarga).
   */
  private async segmentOf(input: CampaignInput): Promise<CampaignSegment> {
    const rawId = input?.audience_segment_id;
    if (rawId === undefined || rawId === null || rawId === '') {
      return normalizeCampaignSegment(input?.segment ?? {});
    }
    const id =
      typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId).trim()
        : '';
    if (!ID_RE.test(id)) {
      throw rpcError(400, "audience_segment_id noto'g'ri");
    }
    const given = input?.segment ?? {};
    if (
      (Array.isArray(given.phones) && given.phones.length) ||
      ORDER_SEGMENT_KEYS.some((key) => !isBlank(given[key]))
    ) {
      throw rpcError(
        400,
        'audience_segment_id va segment birga berilmaydi — bittasini tanlang',
      );
    }
    const saved = this.savedSegments
      ? await this.savedSegments.findOne({ where: { id, isDeleted: false } })
      : null;
    if (!saved) throw rpcError(404, 'Segment topilmadi');
    const audience = saved.audience ?? {};
    const staffRoles = (audience.roles ?? []).filter(
      (role) => String(role).toLowerCase() !== 'customer',
    );
    if (audience.broadcast === true || staffRoles.length) {
      throw rpcError(
        400,
        'Saqlangan segmentda xodim rollari / broadcast bor — SMS reklama kampaniyasi faqat mijozlar segmenti bilan (POST /notifications/campaigns da SMS kanalidan foydalaning)',
        { reason: 'segment_not_customer_only' },
      );
    }
    if (audience.include_customers !== true) {
      throw rpcError(
        400,
        "Saqlangan segment mijozlarni nishonlamaydi (include_customers yo'q)",
        { reason: 'segment_not_customer_only' },
      );
    }
    const source = (audience.segment ?? {}) as Record<string, unknown>;
    const mapped: Record<string, unknown> = {};
    for (const key of ORDER_SEGMENT_KEYS) {
      if (!isBlank(source[key])) mapped[key] = source[key];
    }
    return normalizeCampaignSegment({
      ...(mapped as CampaignSegment),
      audience_segment_id: id,
    });
  }

  /**
   * Tayyor matn + segment → reja. Preview, darhol yuborish va vaqti kelgan
   * rejalashtirilgan kampaniya — BITTA yo'l (son bitta manbadan).
   */
  private async planFor(text: string, segment: CampaignSegment) {
    const messageClass = 'promo' as const;
    const { recipients, invalid, truncated } =
      await this.resolveRecipients(segment);
    const total = recipients.length + invalid;

    // Kampaniya faqat reklama — rozilik darvozasi chetlab o'tilmaydi.
    const { allowed, blocked } = await this.consent.partition(recipients);

    // Prognoz: reklamada bekor qilish havolasi ham bo'lak hisobiga KIRADI.
    const sampleText = this.consent.appendOptOut(
      text,
      allowed[0]?.phone ?? '+998900000000',
    );
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
      segment,
      segments,
      total,
      allowed,
      blocked,
      invalid,
      truncated,
      estimatedCost,
    };
  }

  private async resolveText(input: CampaignInput): Promise<{
    messageClass: Extract<SmsMessageClass, 'promo'>;
    text: string;
  }> {
    // Berilmasa — reklama (kampaniyaning yagona sinfi, eng qat'iy yo'l).
    const requested = input.message_class ?? 'promo';
    if (requested !== 'promo') throw promoOnly(requested);
    const messageClass = 'promo' as const;
    if (input.template_code) {
      const template = await this.templates.resolve(
        input.template_code,
        input.lang,
      );
      if (!template)
        throw rpcError(404, `Shablon topilmadi: ${input.template_code}`);
      // Tranzaksion/OTP shabloni kampaniyada — darvozalarni chetlab o'tish yo'li.
      if (template.message_class !== 'promo')
        throw promoOnly(template.message_class);
      assertNoPii([
        ...(template.required_vars ?? []),
        ...templateVars(template.text),
      ]);
      try {
        return {
          messageClass,
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
    const text = String(input.text ?? '').trim();
    if (!text) throw rpcError(400, "Xabar matni bo'sh");
    let rendered: string;
    try {
      // Matnda {{var}} qolsa — to'ldirilmagan, yuborilmaydi.
      rendered = renderSmsTemplate(text, input.vars ?? {});
    } catch (error) {
      if (error instanceof SmsTemplateError)
        throw rpcError(400, error.message, { missing: error.missing });
      throw error;
    }
    assertNoPii(templateVars(text));
    return { messageClass, text: rendered };
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
        // (sdNGqCBa) faqat order-service filtrlari (max_orders ham).
        ...Object.fromEntries(
          ORDER_SEGMENT_KEYS.filter((key) => !isBlank(segment[key])).map(
            (key) => [key, segment[key]],
          ),
        ),
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
