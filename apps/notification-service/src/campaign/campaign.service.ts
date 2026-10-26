import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  FindOptionsWhere,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThan,
  Repository,
} from 'typeorm';
import { createHash } from 'node:crypto';
import {
  ActivityLogService,
  NotificationChannel,
  OutboxService,
  isKnownNotificationType,
  maskPhonesForLog,
  notificationTypeErrorMessage,
  resolveNotificationDefaults,
  rmqSend,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { DispatchNotificationDto } from '../dto/dispatch-notification.dto';
import { NotificationInboxService } from '../notification-inbox.service';
import {
  AUDIENCE_RESOLVE_PATTERN,
  AudienceTargetInput,
  IdentityAudienceTarget,
  audienceRpcError,
  buildAudienceTarget,
  primitiveText,
  toAudiencePage,
} from '../audience/audience-request';
import {
  CAMPAIGN_ALLOWED_CHANNELS,
  CAMPAIGN_BATCH_PATTERN,
  CAMPAIGN_BATCH_SIZE,
  CAMPAIGN_MAX_BATCH_ATTEMPTS,
  CAMPAIGN_MAX_RECIPIENT_IDS,
  CAMPAIGN_MAX_SCHEDULE_DAYS,
  campaignMaxFanout,
} from './campaign-limits';
import { DispatchAbortedError } from './dispatch-hooks';
import { SmsConfigService } from '../sms/sms-config.service';
import { SmsConsentService } from '../sms/sms-consent.service';
import {
  CAMPAIGN_CANCELLABLE_STATUSES,
  CAMPAIGN_DISPLAY_STATUSES,
  CAMPAIGN_TIMEZONE,
  CampaignDisplayStatus,
  campaignDisplayStatus,
  campaignQuietHours,
  formatMinuteOfDay,
  isPromoCategory,
  parseZonedInstant,
  promoReleaseAt,
  toTashkentIso,
} from './campaign-schedule';
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_TERMINAL_STATUSES,
  CampaignAudience,
  CampaignStatus,
  NotificationCampaign,
} from './notification-campaign.entity';

const ID_RE = /^\d{1,19}$/;
const ERROR_MAX = 300;

export interface CreateCampaignInput extends AudienceTargetInput {
  type?: string;
  category?: string;
  priority?: string;
  title?: string;
  body?: string | null;
  data?: Record<string, unknown> | null;
  link?: string | null;
  channels?: string[] | null;
  recipient_ids?: string[] | null;
  scheduled_at?: string | null;
  idempotency_key?: string | null;
  requester?: { id?: string | number | null; roles?: string[] } | null;
}

export interface CampaignBatchPayload {
  campaign_id?: string | number;
  batch_no?: number;
  limit?: number;
}

interface CampaignPlan {
  type: string;
  category: string;
  priority: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  link: string | null;
  channels: NotificationChannel[];
  audience: CampaignAudience;
  scheduledAt: Date | null;
  key: string;
  hash: string;
  createdBy: string | null;
}

const shortError = (error: unknown): string => {
  const raw =
    error instanceof RpcException
      ? (error.getError() as { message?: unknown })?.message
      : error instanceof Error
        ? error.message
        : (error as { message?: unknown })?.message;
  return maskPhonesForLog(
    (primitiveText(raw) || 'unknown').replace(/\s+/g, ' '),
  )
    .trim()
    .slice(0, ERROR_MAX);
};

/**
 * KAMPANIYA NAVBATI (xHPdpj0W) — katta yuborish asinxron.
 *
 *   create  → kampaniya qatori + 0-partiya outbox'ga BITTA tranzaksiyada,
 *             darhol 202 `{ campaign_id }` (8 s gateway timeout'iga tushmaydi);
 *   batch   → outbox (`notification.campaign.batch`, `scheduledAt` bilan
 *             rejalashtirish) → identity keyset sahifasi (200 ta) → mavjud
 *             `dispatch` mantiqi (bulk INSERT, kanallar) shu tranzaksiyada:
 *             da'vo → qatorlar → `sent = sent + n` → keyingi partiya outbox'ga;
 *   get/list → progress va tarix; cancel → keyingi partiyalar boshlanmaydi.
 *
 * ⚠️ Alohida scheduler/cron servisi YO'Q (karta #5) va RabbitMQ navbat
 * argumentlariga tegilmaydi — kechiktirish faqat outbox `scheduled_at`.
 * (9D1Gl9MS) SMS kanali — DOIM reklama (`promo`): rozilik darvozasi,
 * 18:00–09:00 taqiq, opt-out havolasi, kunlik kvota; auditoriya
 * SMS_MAX_FANOUT dan oshsa — 400 (jimgina kesilmaydi).
 */
@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    @InjectRepository(NotificationCampaign)
    private readonly repo: Repository<NotificationCampaign>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    private readonly inbox: NotificationInboxService,
    private readonly outbox: OutboxService,
    private readonly activityLog: ActivityLogService,
    private readonly config: ConfigService,
    /** (9D1Gl9MS) SMS kanali: kill-switch, fan-out, opt-out sozlamasi. */
    @Optional() private readonly smsConfig?: SmsConfigService,
    @Optional() private readonly smsConsent?: SmsConsentService,
  ) {}

  private get maxFanout(): number {
    return campaignMaxFanout(
      this.config?.get?.('NOTIFICATION_CAMPAIGN_MAX_FANOUT'),
    );
  }

  private static wantsSms(channels: readonly string[] | null | undefined) {
    return (channels ?? []).includes(NotificationChannel.SMS);
  }

  /** (9D1Gl9MS) SMS kanali bo'lsa — SMS_MAX_FANOUT ham chegara (pul). */
  private fanoutFor(channels: readonly string[] | null | undefined): number {
    return CampaignService.wantsSms(channels) && this.smsConfig
      ? Math.min(this.maxFanout, this.smsConfig.maxFanout)
      : this.maxFanout;
  }

  /**
   * (9D1Gl9MS) SMS kanali so'ralgan — yaratishdan OLDIN: SMS yoqiq
   * (kill-switch), reklama bekor qilish havolasi sozlangan. Aks holda 409 —
   * kampaniya "SMS bilan" yaratilib, jimgina SMS'siz ketmasin.
   */
  private assertSmsReady() {
    if (!this.smsConfig || !this.smsConsent) {
      throw new ConflictException('SMS kanali sozlanmagan (sms_disabled)');
    }
    if (!this.smsConfig.enabled) {
      throw new ConflictException(
        "SMS o'chiq (SMS_ENABLED=false) — SMS kanali bilan kampaniya yaratilmadi (sms_disabled)",
      );
    }
    if (this.smsConsent.appendOptOut('x', '+998900000000') === null) {
      throw new ConflictException(
        'Reklama SMS uchun bekor qilish havolasi sozlanmagan (SMS_OPT_OUT_BASE_URL, SMS_DLR_SECRET) — kampaniya yaratilmadi (opt_out_not_configured)',
      );
    }
  }

  /** (WIsb9Ytq) SMS darvozasi bilan BIR xil sozlama (sukut 18:00-09:00). */
  private get quietHours() {
    return campaignQuietHours(this.config?.get?.('NOTIF_PROMO_QUIET_HOURS'));
  }

  /**
   * (WIsb9Ytq) Reklama shu lahzada ketishi mumkin bo'lgan eng erta lahza —
   * SQL'da bitta `AT TIME ZONE 'Asia/Tashkent'` (campaign-schedule.ts).
   */
  private promoRelease(at: Date): Promise<Date> {
    return promoReleaseAt(this.repo.manager, at, this.quietHours);
  }

  private toRpcError(error: unknown): never {
    if (error instanceof RpcException) throw error;
    for (const [type, statusCode] of [
      [BadRequestException, 400],
      [NotFoundException, 404],
      [ConflictException, 409],
    ] as const) {
      if (error instanceof type) {
        throw new RpcException({ statusCode, message: error.message });
      }
    }
    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }

  // ==================== CREATE ====================

  async create(input: CreateCampaignInput = {}) {
    try {
      const plan = this.plan(input ?? {});
      const existing = await this.repo.findOne({
        where: { idempotency_key: plan.key },
      });
      if (existing) return this.duplicate(existing, plan.hash);

      const wantsSms = CampaignService.wantsSms(plan.channels);
      if (wantsSms) this.assertSmsReady();
      const total = await this.countAudience(plan.audience);
      if (!total) {
        throw new BadRequestException(
          "Auditoriya bo'sh: tanlangan nishonda faol foydalanuvchi yo'q — kampaniya yaratilmadi",
        );
      }
      if (total > this.maxFanout) {
        throw new BadRequestException(
          `Kampaniya auditoriyasi ${total} — chegara ${this.maxFanout} ` +
            '(NOTIFICATION_CAMPAIGN_MAX_FANOUT). Nishonni toraytiring — jimgina kesilmaydi.',
        );
      }
      if (wantsSms && total > this.fanoutFor(plan.channels)) {
        throw new BadRequestException(
          `SMS kanali bilan kampaniya auditoriyasi ${total} — chegara ${this.fanoutFor(plan.channels)} ` +
            '(SMS_MAX_FANOUT). Nishonni toraytiring yoki SMS kanalisiz yuboring — jimgina kesilmaydi.',
        );
      }

      // (WIsb9Ytq) Reklama tungi taqiq oynasiga tushsa — TASHLANMAYDI, oyna
      // tugashiga (Toshkent 09:00) suriladi. Tranzaksion (promo emas) —
      // darvozaga tushmaydi, tunda ham darhol/belgilangan vaqtda ketadi.
      const requestedAt = plan.scheduledAt;
      // (fb4qy6bd) so'ralgan lahza — belgilangan vaqt yoki hozir (darhol).
      const requestedMoment = requestedAt ?? new Date();
      let scheduledAt = requestedAt;
      let quietShifted = false;
      if (isPromoCategory(plan.category)) {
        const base = requestedMoment;
        const release = await this.promoRelease(base);
        if (release.getTime() > base.getTime()) {
          scheduledAt = release;
          quietShifted = true;
        }
      }

      let saved: NotificationCampaign;
      try {
        saved = await this.repo.manager.transaction(async (manager) => {
          const campaigns = manager.getRepository(NotificationCampaign);
          const row = await campaigns.save(
            campaigns.create({
              created_by: plan.createdBy,
              type: plan.type,
              category: plan.category,
              priority: plan.priority,
              channels: plan.channels,
              audience: plan.audience,
              template_code: null,
              title: plan.title,
              body: plan.body,
              data: plan.data,
              link: plan.link,
              status: 'queued',
              total,
              batch_size: CAMPAIGN_BATCH_SIZE,
              scheduled_at: scheduledAt,
              // (fb4qy6bd) GET campaigns da ham ko'rinadi.
              requested_at: requestedMoment,
              quiet_hours_shifted: quietShifted,
              idempotency_key: plan.key,
              request_hash: plan.hash,
            }),
          );
          await this.enqueueBatch(manager, row.id, 0, scheduledAt);
          return row;
        });
      } catch (error) {
        // Parallel ikki bosish: UNIQUE(idempotency_key) — mavjudini qaytaramiz.
        if ((error as { code?: string })?.code === '23505') {
          const raced = await this.repo.findOne({
            where: { idempotency_key: plan.key },
          });
          if (raced) return this.duplicate(raced, plan.hash);
        }
        throw error;
      }

      await this.activityLog.log({
        entity_type: 'NotificationCampaign',
        entity_id: String(saved.id),
        action: 'notification.campaign.created',
        user_id: plan.createdBy,
        user_role: input.requester?.roles?.length
          ? input.requester.roles.join(',')
          : null,
        metadata: {
          type: plan.type,
          channels: plan.channels,
          audience: plan.audience,
          total,
          scheduled_at: scheduledAt,
          requested_scheduled_at: requestedAt,
          quiet_hours_shifted: quietShifted,
        },
      });

      return successRes(
        {
          campaign_id: String(saved.id),
          status: saved.status,
          total,
          scheduled_at: saved.scheduled_at,
          duplicate: false,
          display_status: (scheduledAt
            ? 'scheduled'
            : 'sending') as CampaignDisplayStatus,
          requested_scheduled_at: requestedAt,
          // (fb4qy6bd) GET campaigns bilan bir xil maydon.
          requested_at: requestedMoment,
          quiet_hours_shifted: quietShifted,
          timezone: CAMPAIGN_TIMEZONE,
          scheduled_at_tashkent: toTashkentIso(scheduledAt),
        },
        202,
        scheduledAt ? 'Campaign scheduled' : 'Campaign queued',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  private duplicate(existing: NotificationCampaign, hash: string) {
    if (existing.request_hash !== hash) {
      throw new ConflictException(
        'Bu Idempotency-Key boshqa mazmundagi kampaniyaga tegishli — yangi kalit bilan yuboring',
      );
    }
    return successRes(
      {
        campaign_id: String(existing.id),
        status: existing.status,
        total: existing.total,
        scheduled_at: existing.scheduled_at,
        duplicate: true,
      },
      200,
      'Campaign already exists (Idempotency-Key)',
    );
  }

  /** Kiruvchi so'rovni tekshiradi (RMQ'da ValidationPipe yo'q — fail-closed). */
  private plan(input: CreateCampaignInput): CampaignPlan {
    const key = String(input.idempotency_key ?? '').trim();
    if (!key || key.length > 128) {
      throw new BadRequestException(
        'Idempotency-Key majburiy (≤128 belgi) — qayta bosilganda ikkinchi kampaniya yaratilmasin',
      );
    }
    const type = String(input.type ?? '').trim();
    if (!type) throw new BadRequestException('type is required');
    if (!isKnownNotificationType(type)) {
      throw new BadRequestException(notificationTypeErrorMessage(type));
    }
    const title = String(input.title ?? '').trim();
    if (!title) throw new BadRequestException('title is required');
    if (title.length > 255) throw new BadRequestException('title ≤ 255');
    const body =
      input.body === undefined || input.body === null
        ? null
        : String(input.body);
    if (body !== null && body.length > 4096) {
      throw new BadRequestException('body ≤ 4096');
    }
    const link = input.link ? String(input.link) : null;
    if (link && link.length > 512) throw new BadRequestException('link ≤ 512');
    if (
      input.data !== undefined &&
      input.data !== null &&
      (typeof input.data !== 'object' || Array.isArray(input.data))
    ) {
      throw new BadRequestException("data obyekt bo'lishi kerak");
    }

    const defaults = resolveNotificationDefaults({
      type,
      category: input.category as never,
      priority: input.priority as never,
      channels: (input.channels ?? undefined) as never,
      data: input.data ?? undefined,
    });
    const channels = [...new Set(defaults.channels)];
    const blocked = channels.filter(
      (channel) => !CAMPAIGN_ALLOWED_CHANNELS.includes(channel),
    );
    if (blocked.length) {
      throw new BadRequestException(
        `Kampaniyada faqat ${CAMPAIGN_ALLOWED_CHANNELS.join(', ')} kanallari: ` +
          `${blocked.join(', ')} qabul qilinmaydi ` +
          "(telegram — market guruhi relay'i; email — provayder yo'q)",
      );
    }

    const audience = this.audienceOf(input);
    const scheduledAt = this.scheduleOf(input.scheduled_at);
    const createdBy = (() => {
      const raw = input.requester?.id;
      const id = raw === undefined || raw === null ? '' : String(raw).trim();
      return ID_RE.test(id) ? id : null;
    })();

    const fingerprint = {
      type,
      category: defaults.category,
      priority: defaults.priority,
      title,
      body,
      data: input.data ?? null,
      link,
      channels,
      audience,
      scheduled_at: scheduledAt?.toISOString() ?? null,
    };
    const hash = createHash('sha256')
      .update(JSON.stringify(fingerprint))
      .digest('hex');

    return {
      type,
      category: defaults.category,
      priority: defaults.priority,
      title,
      body,
      data: input.data ?? null,
      link,
      channels,
      audience,
      scheduledAt,
      key,
      hash,
      createdBy,
    };
  }

  /** Nishon: rol/broadcast/mijoz (W8aerwL6 qoidalari) YOKI aniq ro'yxat. */
  private audienceOf(input: CreateCampaignInput): CampaignAudience {
    const target = buildAudienceTarget(input);
    const rawIds = Array.isArray(input.recipient_ids)
      ? input.recipient_ids
      : [];
    const ids = [
      ...new Set(rawIds.map((id) => String(id ?? '').trim())),
    ].filter(Boolean);
    if (ids.length) {
      if (target) {
        throw new BadRequestException(
          'Kampaniyada recipient_ids boshqa nishon (roles/broadcast/include_customers) bilan birga berilmaydi',
        );
      }
      const invalid = ids.find((id) => !ID_RE.test(id));
      if (invalid) {
        throw new BadRequestException(`recipient_ids noto'g'ri: ${invalid}`);
      }
      if (ids.length > CAMPAIGN_MAX_RECIPIENT_IDS) {
        throw new BadRequestException(
          `recipient_ids ${CAMPAIGN_MAX_RECIPIENT_IDS} tadan ko'p`,
        );
      }
      return { recipient_ids: ids };
    }
    if (!target) {
      throw new BadRequestException(
        "Auditoriya bo'sh: roles, broadcast, include_customers (+segment) yoki recipient_ids bering",
      );
    }
    return target as CampaignAudience;
  }

  private scheduleOf(raw: unknown): Date | null {
    const value = primitiveText(raw).trim();
    if (!value) return null;
    // (WIsb9Ytq) ISO + ANIQ zona majburiy — zonasiz satr serverda boshqa
    // zona deb o'qilmasin (qo'shaloq konversiya → tunda yuborish).
    const date = parseZonedInstant(value);
    const now = Date.now();
    if (date.getTime() <= now) return null; // o'tgan vaqt — darhol
    if (date.getTime() > now + CAMPAIGN_MAX_SCHEDULE_DAYS * 86_400_000) {
      throw new BadRequestException(
        `scheduled_at ko'pi bilan ${CAMPAIGN_MAX_SCHEDULE_DAYS} kun oldinga`,
      );
    }
    return date;
  }

  private identityTarget(audience: CampaignAudience): IdentityAudienceTarget {
    if (audience.recipient_ids?.length) {
      return { user_ids: audience.recipient_ids };
    }
    const { recipient_ids: _ignored, ...target } = audience;
    void _ignored;
    return target as IdentityAudienceTarget;
  }

  private async identityPage(
    audience: CampaignAudience,
    params: Record<string, unknown>,
  ) {
    try {
      return toAudiencePage(
        await rmqSend<unknown>(
          this.identityClient,
          { cmd: AUDIENCE_RESOLVE_PATTERN },
          { ...this.identityTarget(audience), fields: 'minimal', ...params },
        ),
      );
    } catch (error) {
      throw audienceRpcError(error);
    }
  }

  private async countAudience(audience: CampaignAudience): Promise<number> {
    const page = await this.identityPage(audience, {
      limit: 1,
      with_total: true,
    });
    return Number(page.total ?? page.items.length);
  }

  private enqueueBatch(
    manager: EntityManager,
    campaignId: string,
    batchNo: number,
    scheduledAt?: Date | null,
  ) {
    // `offset` o'rniga keyset: kursor kampaniya qatorida (cursor_after_id),
    // payload faqat partiya raqami — eskirgan/qayta yetkazilgan partiya
    // `batch_no` mos kelmagani uchun e'tiborsiz qoladi.
    const payload: CampaignBatchPayload = {
      campaign_id: String(campaignId),
      batch_no: batchNo,
      limit: CAMPAIGN_BATCH_SIZE,
    };
    return this.outbox.enqueue(
      'NOTIFICATION',
      CAMPAIGN_BATCH_PATTERN,
      payload,
      {
        manager,
        requestId: `campaign:${campaignId}:b${batchNo}`,
        ...(scheduledAt ? { scheduledAt } : {}),
      },
    );
  }

  // ==================== BATCH (outbox iste'molchisi) ====================

  async runBatch(payload: CampaignBatchPayload = {}) {
    const id = String(payload?.campaign_id ?? '').trim();
    const batchNo = Number(payload?.batch_no ?? 0);
    if (!ID_RE.test(id) || !Number.isInteger(batchNo) || batchNo < 0) {
      return this.skip(id, batchNo, 'bad_payload');
    }

    let campaign = await this.repo.findOne({
      where: { id, isDeleted: false },
    });
    if (!campaign) return this.skip(id, batchNo, 'not_found');
    // (TC6) Bekor qilingan / tugagan — keyingi partiya BOSHLANMAYDI.
    if (CAMPAIGN_TERMINAL_STATUSES.includes(campaign.status)) {
      return this.skip(id, batchNo, campaign.status);
    }
    if (campaign.batch_no !== batchNo) {
      return this.skip(id, batchNo, 'stale_batch');
    }

    const pending = campaign.status === 'queued' || campaign.status === 'draft';
    // (TC7) Erta yetib kelgan (masalan qo'lda requeue) — vaqtida qayta.
    if (
      pending &&
      campaign.scheduled_at &&
      new Date(campaign.scheduled_at).getTime() > Date.now() + 1000
    ) {
      await this.enqueueBatch(
        this.repo.manager,
        id,
        batchNo,
        campaign.scheduled_at,
      );
      return this.skip(id, batchNo, 'not_due');
    }

    // (WIsb9Ytq) Reklama — HAR partiya oldidan tungi taqiq darvozasi: 17:59
    // da boshlangan katta kampaniyaning 18:00 dan keyingi partiyalari ham
    // tunda ketmaydi, oyna tugashiga suriladi (tashlanmaydi). Tranzaksion
    // kampaniya bu yerdan o'tmaydi — tunda ham ketadi.
    if (isPromoCategory(campaign.category)) {
      const now = new Date();
      const release = await this.promoRelease(now);
      if (release.getTime() > now.getTime() + 1000) {
        return this.deferForQuietHours(campaign, batchNo, release);
      }
    }

    if (pending) {
      let started: NotificationCampaign | null;
      try {
        started = await this.start(campaign);
      } catch (error) {
        return this.batchFailed(campaign, batchNo, error, ['queued', 'draft']);
      }
      if (!started) return this.skip(id, batchNo, 'start_race');
      campaign = started;
      if (campaign.status !== 'running') {
        return this.skip(id, batchNo, campaign.status);
      }
    }

    try {
      const page = await this.identityPage(campaign.audience, {
        after_id: campaign.cursor_after_id,
        limit: campaign.batch_size || CAMPAIGN_BATCH_SIZE,
        with_total: false,
      });
      const items = page.items
        .map((item) => ({
          id: String(item.id ?? '').trim(),
          role: item.role ?? null,
        }))
        .filter((item) => ID_RE.test(item.id));

      if (!items.length) {
        await this.finish(campaign.id, batchNo);
        return { campaign_id: id, batch_no: batchNo, status: 'done', sent: 0 };
      }

      // Ishlash davomida auditoriya o'sib chegaradan oshsa — XATO, kesish emas.
      const processed = campaign.sent + campaign.failed;
      const limit = this.fanoutFor(campaign.channels);
      if (processed + items.length > limit) {
        await this.fail(
          campaign.id,
          batchNo,
          `Auditoriya ishlash davomida chegaradan (${limit}) oshdi — to'xtatildi`,
        );
        return { campaign_id: id, batch_no: batchNo, status: 'failed' };
      }

      const isLast =
        items.length < (campaign.batch_size || CAMPAIGN_BATCH_SIZE);
      const lastId = items[items.length - 1].id;
      const current = campaign;
      const result = (await this.inbox.dispatch(
        this.dispatchDto(current, batchNo),
        {
          recipients: items,
          // (9D1Gl9MS) kampaniya SMS'i — doim reklama (rozilik, taqiq, kvota).
          ...(CampaignService.wantsSms(current.channels)
            ? { smsMessageClass: 'promo' as const }
            : {}),
          beforePersist: (manager) => this.claim(manager, current.id, batchNo),
          afterPersist: (manager, rows) =>
            this.advance(
              manager,
              current,
              batchNo,
              rows.length,
              lastId,
              isLast,
            ),
        },
      )) as { data?: { dispatched?: number } } | undefined;

      return {
        campaign_id: id,
        batch_no: batchNo,
        status: isLast ? 'done' : 'running',
        sent: Number(result?.data?.dispatched ?? items.length),
      };
    } catch (error) {
      if (error instanceof DispatchAbortedError) {
        return this.skip(id, batchNo, error.reason);
      }
      return this.batchFailed(campaign, batchNo, error);
    }
  }

  private skip(id: string, batchNo: number, reason: string) {
    return { campaign_id: id || null, batch_no: batchNo, skipped: reason };
  }

  /**
   * (WIsb9Ytq) Partiya tungi taqiq tugashiga suriladi: o'sha partiya raqami
   * bilan outbox `scheduledAt` (RabbitMQ navbat argumentlari EMAS).
   * Bekor qilingan/tugagan kampaniya — qayta navbatga qo'yilmaydi.
   */
  private async deferForQuietHours(
    campaign: NotificationCampaign,
    batchNo: number,
    release: Date,
  ) {
    const id = String(campaign.id);
    const res = await this.repo
      .createQueryBuilder()
      .update(NotificationCampaign)
      .set({ paused_until: release })
      .where('id = :id', { id })
      .andWhere('batch_no = :batchNo', { batchNo })
      .andWhere('status IN (:...active)', {
        active: [...CAMPAIGN_CANCELLABLE_STATUSES],
      })
      .execute();
    if (!res.affected) return this.skip(id, batchNo, 'not_active');
    await this.enqueueBatch(this.repo.manager, id, batchNo, release);
    this.logger.log(
      `campaign ${id} batch ${batchNo}: reklama tungi taqiqi — ${release.toISOString()} ga surildi`,
    );
    return { ...this.skip(id, batchNo, 'quiet_hours'), resume_at: release };
  }

  /** queued → running; auditoriya hajmi ishga tushish paytida qayta sanaladi. */
  private async start(
    campaign: NotificationCampaign,
  ): Promise<NotificationCampaign | null> {
    // Xato — chaqiruvchida `batchFailed` (outbox qayta urinadi).
    const total = await this.countAudience(campaign.audience);
    const limit = this.fanoutFor(campaign.channels);
    if (total > limit) {
      await this.fail(
        campaign.id,
        campaign.batch_no,
        `Auditoriya ishga tushishda ${total} — chegara ${limit}; yuborilmadi`,
        ['queued', 'draft'],
      );
      return this.repo.findOne({ where: { id: campaign.id } });
    }
    const res = await this.repo
      .createQueryBuilder()
      .update(NotificationCampaign)
      .set({
        status: 'running',
        started_at: () => 'now()',
        total,
        batch_attempts: 0,
        paused_until: null,
      })
      .where('id = :id', { id: campaign.id })
      .andWhere('status IN (:...from)', { from: ['queued', 'draft'] })
      .andWhere('batch_no = :batchNo', { batchNo: campaign.batch_no })
      .execute();
    if (!res.affected) return null;
    return this.repo.findOne({ where: { id: campaign.id } });
  }

  /** Dispatch tranzaksiyasi ichida: partiya da'vosi (qator qulfi). */
  private async claim(
    manager: EntityManager,
    id: string,
    batchNo: number,
  ): Promise<void> {
    const res = await manager
      .createQueryBuilder()
      .update(NotificationCampaign)
      .set({ last_batch_at: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('status = :running', { running: 'running' })
      .andWhere('batch_no = :batchNo', { batchNo })
      .execute();
    if (!res.affected) {
      // Bekor qilingan yoki bu partiya allaqachon bajarilgan (outbox
      // at-least-once) — hech narsa yozilmaydi.
      throw new DispatchAbortedError('claim_lost');
    }
  }

  /** Dispatch tranzaksiyasi ichida: hisoblagich + kursor + keyingi partiya. */
  private async advance(
    manager: EntityManager,
    campaign: NotificationCampaign,
    batchNo: number,
    written: number,
    lastId: string,
    isLast: boolean,
  ): Promise<void> {
    const qb = manager
      .createQueryBuilder()
      .update(NotificationCampaign)
      .set({
        sent: () => '"sent" + :written',
        batch_no: () => '"batch_no" + 1',
        batch_attempts: 0,
        cursor_after_id: lastId,
        last_error: null,
        paused_until: null,
        ...(isLast
          ? {
              status: 'done' as CampaignStatus,
              finished_at: () => 'now()',
              skipped: () =>
                'GREATEST("total" - ("sent" + :written) - "failed", 0)',
            }
          : {}),
      })
      .where('id = :id', { id: campaign.id })
      .andWhere('batch_no = :batchNo', { batchNo })
      .setParameter('written', written);
    await qb.execute();
    if (!isLast) {
      await this.enqueueBatch(manager, campaign.id, batchNo + 1);
    }
  }

  /** Bo'sh sahifa — auditoriya tugadi. */
  private async finish(id: string, batchNo: number) {
    await this.repo
      .createQueryBuilder()
      .update(NotificationCampaign)
      .set({
        status: 'done',
        finished_at: () => 'now()',
        skipped: () => 'GREATEST("total" - "sent" - "failed", 0)',
        last_error: null,
      })
      .where('id = :id', { id })
      .andWhere('status = :running', { running: 'running' })
      .andWhere('batch_no = :batchNo', { batchNo })
      .execute();
  }

  /** Kampaniyani to'xtatadi: yuborilmaganlar `failed` ga (yashirilmaydi). */
  private async fail(
    id: string,
    batchNo: number,
    reason: string,
    from: CampaignStatus[] = ['running'],
  ) {
    await this.repo
      .createQueryBuilder()
      .update(NotificationCampaign)
      .set({
        status: 'failed',
        finished_at: () => 'now()',
        failed: () => 'GREATEST("total" - "sent", "failed")',
        last_error: reason.slice(0, ERROR_MAX),
      })
      .where('id = :id', { id })
      .andWhere('status IN (:...from)', { from })
      .andWhere('batch_no = :batchNo', { batchNo })
      .execute();
    this.logger.warn(`campaign ${id} failed at batch ${batchNo}: ${reason}`);
  }

  /**
   * Partiya yiqildi: urinishlar soni oshadi. Chegaragacha — RpcException
   * (outbox backoff bilan qayta yuboradi; RMQ requeue YO'Q). Chegarada —
   * kampaniya `failed`, outbox'ga muvaffaqiyat (cheksiz aylanish yo'q).
   */
  private async batchFailed(
    campaign: NotificationCampaign,
    batchNo: number,
    error: unknown,
    from: CampaignStatus[] = ['running'],
  ) {
    const reason = shortError(error);
    const res = await this.repo
      .createQueryBuilder()
      .update(NotificationCampaign)
      .set({
        batch_attempts: () => '"batch_attempts" + 1',
        last_error: reason,
      })
      .where('id = :id', { id: campaign.id })
      .andWhere('status IN (:...from)', { from })
      .andWhere('batch_no = :batchNo', { batchNo })
      .returning(['batch_attempts'])
      .execute();
    if (!res.affected) {
      return this.skip(String(campaign.id), batchNo, 'not_active');
    }
    const attempts = Number(
      (res.raw as Array<{ batch_attempts?: number }>)?.[0]?.batch_attempts ??
        CAMPAIGN_MAX_BATCH_ATTEMPTS,
    );
    if (attempts < CAMPAIGN_MAX_BATCH_ATTEMPTS) {
      throw new RpcException({
        statusCode: 503,
        message: `campaign ${campaign.id} batch ${batchNo} attempt ${attempts} failed: ${reason}`,
      });
    }
    await this.fail(
      String(campaign.id),
      batchNo,
      `Partiya ${batchNo} ${attempts} marta yiqildi: ${reason}`,
      from,
    );
    return {
      campaign_id: String(campaign.id),
      batch_no: batchNo,
      status: 'failed',
    };
  }

  /** Partiya uchun dispatch so'rovi (kampaniyaning saqlangan mazmuni). */
  private dispatchDto(
    campaign: NotificationCampaign,
    batchNo: number,
  ): DispatchNotificationDto {
    return {
      type: campaign.type,
      category: campaign.category,
      priority: campaign.priority,
      title: campaign.title,
      body: campaign.body ?? undefined,
      data: { ...(campaign.data ?? {}), campaign_id: String(campaign.id) },
      link: campaign.link ?? undefined,
      channels: campaign.channels,
      // Xavfsizlik to'ri: bir qabul qiluvchiga bir kampaniya = bitta qator.
      group_key: `campaign:${campaign.id}`,
      // Audit: har partiya bitta `notification.dispatched` qatori.
      request_id: `campaign:${campaign.id}:b${batchNo}`,
      requester: campaign.created_by ? { id: campaign.created_by } : undefined,
    } as unknown as DispatchNotificationDto;
  }

  // ==================== READ / CANCEL ====================

  private toPublic(row: NotificationCampaign) {
    const done = row.sent + row.failed + row.skipped;
    return {
      id: String(row.id),
      status: row.status,
      type: row.type,
      category: row.category,
      priority: row.priority,
      channels: row.channels,
      audience: row.audience,
      title: row.title,
      body: row.body,
      link: row.link,
      total: row.total,
      sent: row.sent,
      failed: row.failed,
      skipped: row.skipped,
      progress_pct: row.total
        ? Math.min(100, Math.round((done / row.total) * 100))
        : row.status === 'done'
          ? 100
          : 0,
      batches_done: row.batch_no,
      batch_size: row.batch_size,
      created_by: row.created_by,
      created_at: row.createdAt,
      scheduled_at: row.scheduled_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      last_batch_at: row.last_batch_at,
      cancelled_at: row.cancelled_at,
      cancelled_by: row.cancelled_by,
      last_error: row.last_error,
      // (WIsb9Ytq) ro'yxat holati va boshqaruv.
      display_status: campaignDisplayStatus(row),
      can_cancel: CAMPAIGN_CANCELLABLE_STATUSES.includes(row.status),
      is_promo: isPromoCategory(row.category),
      paused_until: row.paused_until ?? null,
      // (fb4qy6bd) so'ralgan lahza va tungi taqiq surilishi (KM-8).
      requested_at: row.requested_at ?? null,
      requested_at_tashkent: toTashkentIso(row.requested_at ?? null),
      quiet_hours_shifted: row.quiet_hours_shifted ?? false,
      timezone: CAMPAIGN_TIMEZONE,
      scheduled_at_tashkent: toTashkentIso(row.scheduled_at),
    };
  }

  /**
   * (WIsb9Ytq) `state` filtri → TypeORM `where` (OR ro'yxati). Holat qoidasi
   * `campaignDisplayStatus` bilan bir xil.
   */
  private stateWhere(
    state: CampaignDisplayStatus,
  ): FindOptionsWhere<NotificationCampaign>[] {
    const base = { isDeleted: false };
    const now = new Date();
    const pending = In(['queued', 'draft'] as CampaignStatus[]);
    switch (state) {
      case 'sent':
        return [{ ...base, status: 'done' }];
      case 'failed':
      case 'cancelled':
        return [{ ...base, status: state }];
      case 'scheduled':
        return [
          { ...base, status: pending, scheduled_at: MoreThan(now) },
          { ...base, status: pending, paused_until: MoreThan(now) },
        ];
      default: {
        const notFuture = [IsNull(), LessThanOrEqual(now)];
        return [
          { ...base, status: 'running' },
          ...notFuture.flatMap((scheduled) =>
            notFuture.map((paused) => ({
              ...base,
              status: pending,
              scheduled_at: scheduled,
              paused_until: paused,
            })),
          ),
        ];
      }
    }
  }

  /**
   * (WIsb9Ytq) Rejalashtirish qoidasi — frontend DatePicker uchun: Toshkent
   * zonasi, reklama taqiq oynasi (sozlamadan), va ixtiyoriy tekshiruv:
   * `scheduled_at` (+ `type`/`category`) berilsa — haqiqiy yuborish lahzasi
   * (taqiqqa tushsa "ertangi 09:00 ga suriladi"). Hech narsa yaratilmaydi.
   */
  async schedulePolicy(
    input: {
      scheduled_at?: string | null;
      type?: string | null;
      category?: string | null;
    } = {},
  ) {
    try {
      const window = this.quietHours;
      const type = primitiveText(input?.type).trim();
      let category = primitiveText(input?.category).trim() || null;
      if (type && !category) {
        if (!isKnownNotificationType(type)) {
          throw new BadRequestException(notificationTypeErrorMessage(type));
        }
        category = resolveNotificationDefaults({ type }).category;
      }
      const promo = category ? isPromoCategory(category) : null;
      const start = formatMinuteOfDay(window.start);
      const end = formatMinuteOfDay(window.end);

      const raw = primitiveText(input?.scheduled_at).trim();
      let check: Record<string, unknown> | null = null;
      if (raw) {
        const requested = parseZonedInstant(raw);
        const immediate = requested.getTime() <= Date.now();
        const base = immediate ? new Date() : requested;
        const effective = promo ? await this.promoRelease(base) : base;
        const shifted = effective.getTime() > base.getTime();
        check = {
          requested_at: requested,
          requested_at_tashkent: toTashkentIso(requested),
          immediate,
          effective_at: effective,
          effective_at_tashkent: toTashkentIso(effective),
          shifted,
          reason: shifted ? 'promo_quiet_hours' : null,
          message: shifted
            ? `Reklama ${start}–${end} (Toshkent) oralig'ida yuborilmaydi — ${toTashkentIso(effective)?.slice(0, 16).replace('T', ' ')} ga suriladi`
            : null,
        };
      }
      return successRes(
        {
          timezone: CAMPAIGN_TIMEZONE,
          utc_offset: '+05:00',
          promo_quiet_hours: {
            start,
            end,
            enabled: window.start !== window.end,
            env: 'NOTIF_PROMO_QUIET_HOURS',
          },
          promo_categories: ['marketing'],
          is_promo: promo,
          max_schedule_days: CAMPAIGN_MAX_SCHEDULE_DAYS,
          check,
        },
        200,
        'Campaign schedule policy',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  private assertId(value: unknown): string {
    const id = primitiveText(value).trim();
    if (!ID_RE.test(id)) {
      throw new BadRequestException('id must be a bigint-like numeric string');
    }
    return id;
  }

  async get(input: { id?: string } = {}) {
    try {
      const id = this.assertId(input?.id);
      const row = await this.repo.findOne({ where: { id, isDeleted: false } });
      if (!row) throw new NotFoundException('Kampaniya topilmadi');
      return successRes(this.toPublic(row), 200, 'Campaign');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async list(
    input: {
      page?: number | string;
      limit?: number | string;
      status?: string;
      state?: string;
    } = {},
  ) {
    try {
      const page = Number(input?.page) > 0 ? Math.floor(Number(input.page)) : 1;
      const limit =
        Number(input?.limit) > 0
          ? Math.min(Math.floor(Number(input.limit)), 100)
          : 20;
      const status = input?.status ? String(input.status).trim() : '';
      if (status && !CAMPAIGN_STATUSES.includes(status as CampaignStatus)) {
        throw new BadRequestException(
          `status: ${CAMPAIGN_STATUSES.join(' | ')}`,
        );
      }
      // (WIsb9Ytq) `state` — ro'yxat holati (scheduled / sending / sent /
      // failed / cancelled); `status` — xom holat. Ikkalasi birga — 400.
      const state = input?.state ? String(input.state).trim() : '';
      if (
        state &&
        !CAMPAIGN_DISPLAY_STATUSES.includes(state as CampaignDisplayStatus)
      ) {
        throw new BadRequestException(
          `state: ${CAMPAIGN_DISPLAY_STATUSES.join(' | ')}`,
        );
      }
      if (state && status) {
        throw new BadRequestException('status yoki state — faqat bittasi');
      }
      const [rows, total] = await this.repo.findAndCount({
        where: state
          ? this.stateWhere(state as CampaignDisplayStatus)
          : {
              isDeleted: false,
              ...(status ? { status: status as CampaignStatus } : {}),
            },
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });
      return successRes(
        {
          items: rows.map((row) => this.toPublic(row)),
          meta: {
            page,
            limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
          },
        },
        200,
        'Campaigns',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async cancel(
    input: {
      id?: string;
      requester?: { id?: string | number | null; roles?: string[] } | null;
    } = {},
  ) {
    try {
      const id = this.assertId(input?.id);
      const actorRaw = input?.requester?.id;
      const actor =
        actorRaw !== undefined &&
        actorRaw !== null &&
        ID_RE.test(String(actorRaw))
          ? String(actorRaw)
          : null;
      const res = await this.repo
        .createQueryBuilder()
        .update(NotificationCampaign)
        .set({
          status: 'cancelled',
          cancelled_at: () => 'now()',
          cancelled_by: actor,
          finished_at: () => 'now()',
          skipped: () => 'GREATEST("total" - "sent" - "failed", 0)',
        })
        .where('id = :id', { id })
        .andWhere('is_deleted = false')
        .andWhere('status IN (:...active)', {
          active: ['draft', 'queued', 'running'],
        })
        .execute();
      const row = await this.repo.findOne({ where: { id, isDeleted: false } });
      if (!row) throw new NotFoundException('Kampaniya topilmadi');
      if (!res.affected) {
        throw new ConflictException(
          `Kampaniya allaqachon yakunlangan (${row.status}) — bekor qilib bo'lmaydi`,
        );
      }
      await this.activityLog.log({
        entity_type: 'NotificationCampaign',
        entity_id: id,
        action: 'notification.campaign.cancelled',
        user_id: actor,
        user_role: input?.requester?.roles?.length
          ? input.requester.roles.join(',')
          : null,
        metadata: { sent: row.sent, total: row.total },
      });
      return successRes(this.toPublic(row), 200, 'Campaign cancelled');
    } catch (error) {
      this.toRpcError(error);
    }
  }
}
