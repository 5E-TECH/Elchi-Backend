import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { rmqSend } from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { PushSubscription } from '../entities/push-subscription.entity';
import { MAX_FANOUT } from '../notification-inbox.service';
import { campaignMaxFanout } from '../campaign/campaign-limits';
import { maskPhone, normalizeSmsPhone } from '../sms/sms-phone.util';
import { SmsConfigService } from '../sms/sms-config.service';
import { SmsConsentService } from '../sms/sms-consent.service';
import { SmsDispatchService } from '../sms/sms-dispatch.service';
import { countSmsSegments } from '../sms/sms-segments.util';
import { NotificationAudienceSegment } from './audience-segment.entity';
import {
  AUDIENCE_RESOLVE_PATTERN,
  AudienceTargetInput,
  IdentityAudiencePage,
  IdentityAudienceTarget,
  audienceRpcError,
  buildAudienceTarget,
  toAudiencePage,
} from './audience-request';

/** Preview sahifasi — identity'ning AUDIENCE_MAX_LIMIT i. */
const PREVIEW_PAGE_SIZE = 1000;
/** (ebSV5oyP #6) "Namunani ko'rish" — ko'pi bilan shuncha qator. */
export const AUDIENCE_SAMPLE_SIZE = 20;
const PUSH_COUNT_CHUNK = 1000;
const ID_RE = /^\d{1,19}$/;

export interface AudiencePreviewInput extends AudienceTargetInput {
  recipient_id?: string | null;
  recipient_ids?: string[] | null;
  /** (ebSV5oyP #6) 20 tagacha namuna — telefon MASKALANGAN (`***7434`). */
  with_sample?: boolean | null;
  /** (ebSV5oyP #7) Saqlangan segment — sharti shu yerdan olinadi. */
  audience_segment_id?: string | null;
  /** (9D1Gl9MS) `sms` bo'lsa — rozilik bo'yicha bo'linish + narx (`sms` bloki). */
  channels?: string[] | null;
  /** (9D1Gl9MS) SMS matni = `title: body` (kampaniya bilan bir xil). */
  title?: string | null;
  body?: string | null;
}

/** (9D1Gl9MS) Rozilik bo'yicha SMS bo'linishi — preview javobining `sms` bloki. */
export interface AudienceSmsSplit {
  exact: boolean;
  message_class: 'promo';
  /** Roziligi bor — SMS ketadi (kampaniya partiyasi bilan bir xil qoida). */
  recipients: number | null;
  blocked_no_consent: number | null;
  skipped_invalid_phone: number | null;
  with_valid_phone: number | null;
  encoding: string;
  parts: number;
  text_provided: boolean;
  tariff: number | null;
  estimated_cost: number | null;
  max_fanout: number;
  fanout_exceeded: boolean;
  sms_enabled: boolean;
  opt_out_configured: boolean;
  quiet_hours: { start: number; end: number };
}

const CONTACTS_CHUNK = 500;
const PREVIEW_SMS_PHONE = '+998900000000';

/** Namuna qatori: telefon faqat maska — to'liq raqam javobga CHIQMAYDI. */
export interface AudienceSampleItem {
  id: string;
  role: string | null;
  phone: string | null;
}

interface Collected {
  role: string | null;
  phone_valid: boolean;
}

/**
 * (W8aerwL6 #5) Yuborishdan OLDIN auditoriya ko'rinishi —
 * `notification.audience.preview` (gateway `POST /notifications/audience/
 * preview`, SUPERADMIN/ADMIN). BeePostdagi tasdiqlash oynasi namunasi: aniq
 * son, rollar kesimi va kanal bo'yicha yaroqlilar. HECH NARSA yuborilmaydi.
 *
 * ⚠️ Telefon/ism javobga chiqmaydi: identity'dan `fields: 'minimal'` (id,
 * rol, til, `phone_valid` bayrog'i) olinadi — faqat sonlar qaytadi.
 *
 * Kanal bo'yicha yaroqlilar:
 *   • in_app / realtime — hamma (inbox qatori har kimga; realtime ack'siz);
 *   • push — kamida bitta push obunasi borlar;
 *   • sms — kanonik telefonlilar (SMS bu oqimda YOQILMAGAN — faqat ma'lumot);
 *   • email — provayder yo'q (0); telegram — market guruhi relay'i (null).
 */
@Injectable()
export class AudiencePreviewService {
  constructor(
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @InjectRepository(PushSubscription)
    private readonly pushRepo: Repository<PushSubscription>,
    private readonly config: ConfigService,
    /** (ebSV5oyP) saqlangan segmentlar — preview `audience_segment_id`. */
    @Optional()
    @InjectRepository(NotificationAudienceSegment)
    private readonly segments?: Repository<NotificationAudienceSegment>,
    /** (9D1Gl9MS) SMS kanali — rozilik bo'yicha son va narx. */
    @Optional() private readonly smsConfig?: SmsConfigService,
    @Optional() private readonly smsConsent?: SmsConsentService,
    @Optional() private readonly smsDispatch?: SmsDispatchService,
  ) {}

  private static wantsSms(input: AudiencePreviewInput): boolean {
    return Array.isArray(input?.channels) && input.channels.includes('sms');
  }

  /**
   * (9D1Gl9MS) SMS bo'linishi: kanonik telefoni borlar → identity
   * `contacts_by_ids` (500 tadan) → rozilik darvozasi (`partition` —
   * kampaniya partiyasi va SMS API bilan BIR xil). Telefonlar faqat shu
   * chunk ichida — javobga chiqmaydi. Narx: tarif × bo'laklar (opt-out
   * havolasi bilan) × roziligi borlar.
   */
  private async smsSplit(
    input: AudiencePreviewInput,
    collected: Map<string, Collected> | null,
    total: number,
  ): Promise<AudienceSmsSplit | null> {
    if (!AudiencePreviewService.wantsSms(input) || !this.smsConfig) return null;
    const text = [input.title, input.body]
      .filter(
        (part): part is string => typeof part === 'string' && !!part.trim(),
      )
      .join(': ')
      .slice(0, 640);
    const sample =
      this.smsConsent?.appendOptOut(text || '', PREVIEW_SMS_PHONE) ?? null;
    const segments = countSmsSegments(sample ?? text);
    const tariff = this.smsConfig.tariff('promo');
    const maxFanout = Math.min(this.smsConfig.maxFanout, this.campaignMax);
    const base = {
      message_class: 'promo' as const,
      encoding: segments.encoding,
      parts: segments.parts,
      text_provided: Boolean(text),
      tariff,
      max_fanout: maxFanout,
      fanout_exceeded: total > maxFanout,
      sms_enabled: this.smsConfig.enabled,
      opt_out_configured: sample !== null,
      quiet_hours: this.smsConfig.quietHours,
    };
    if (!collected || !this.smsConsent || !this.smsDispatch) {
      return {
        ...base,
        exact: false,
        recipients: null,
        blocked_no_consent: null,
        skipped_invalid_phone: null,
        with_valid_phone: null,
        estimated_cost: null,
      };
    }
    const candidates = [...collected.entries()].filter(
      ([, entry]) => entry.phone_valid,
    );
    let withPhone = 0;
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < candidates.length; i += CONTACTS_CHUNK) {
      const chunk = candidates.slice(i, i + CONTACTS_CHUNK);
      const contacts = await this.smsDispatch.contacts(chunk.map(([id]) => id));
      const recipients = chunk
        .map(([id, entry]) => ({
          phone: normalizeSmsPhone(contacts.get(id)?.phone_number) ?? '',
          customer_id: entry.role === 'customer' ? id : null,
        }))
        .filter((recipient) => recipient.phone);
      withPhone += recipients.length;
      const split = await this.smsConsent.partition(recipients);
      allowed += split.allowed.length;
      blocked += split.blocked.length;
    }
    return {
      ...base,
      exact: true,
      recipients: allowed,
      blocked_no_consent: blocked,
      skipped_invalid_phone: collected.size - withPhone,
      with_valid_phone: withPhone,
      estimated_cost:
        tariff === null ? null : tariff * segments.parts * allowed,
    };
  }

  /** (ebSV5oyP #7) `audience_segment_id` → saqlangan shart (aks holda kirish). */
  private async withSavedSegment(
    input: AudiencePreviewInput,
  ): Promise<AudiencePreviewInput> {
    const raw = input?.audience_segment_id;
    if (raw === undefined || raw === null || raw === '') return input;
    const id = String(raw).trim();
    if (!ID_RE.test(id))
      throw new BadRequestException("audience_segment_id noto'g'ri");
    const saved = this.segments
      ? await this.segments.findOne({ where: { id, isDeleted: false } })
      : null;
    if (!saved) throw new NotFoundException('Segment topilmadi');
    return {
      ...saved.audience,
      with_sample: input.with_sample ?? null,
      // (9D1Gl9MS) kanal va matn — so'rovdan (segment faqat shart).
      channels: input.channels ?? null,
      title: input.title ?? null,
      body: input.body ?? null,
    };
  }

  /**
   * (ebSV5oyP #6) 20 tagacha namuna. identity'dan `contact` maydonlari
   * olinadi, lekin javobga faqat rol va MASKALANGAN telefon chiqadi —
   * to'liq raqam ham, ism ham tarmoq javobida yo'q.
   */
  private async sample(
    target: IdentityAudienceTarget | null,
    explicit: string[],
  ): Promise<AudienceSampleItem[]> {
    const page = target
      ? await this.page({
          ...target,
          limit: AUDIENCE_SAMPLE_SIZE,
          with_total: false,
          fields: 'contact',
        })
      : explicit.length
        ? await this.page({
            user_ids: explicit.slice(0, AUDIENCE_SAMPLE_SIZE),
            limit: AUDIENCE_SAMPLE_SIZE,
            with_total: false,
            fields: 'contact',
          })
        : { items: [] };
    return page.items.slice(0, AUDIENCE_SAMPLE_SIZE).map((item) => {
      const phone = (item as { phone?: unknown }).phone;
      return {
        id: String(item.id),
        role: item.role ?? null,
        phone: typeof phone === 'string' && phone ? maskPhone(phone) : null,
      };
    });
  }

  private get campaignMax(): number {
    return campaignMaxFanout(
      this.config?.get?.('NOTIFICATION_CAMPAIGN_MAX_FANOUT'),
    );
  }

  private toRpcError(error: unknown): never {
    if (error instanceof RpcException) throw error;
    if (error instanceof BadRequestException) {
      throw new RpcException({ statusCode: 400, message: error.message });
    }
    if (error instanceof NotFoundException) {
      throw new RpcException({ statusCode: 404, message: error.message });
    }
    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }

  private async page(
    payload: IdentityAudienceTarget & Record<string, unknown>,
  ): Promise<IdentityAudiencePage> {
    try {
      return toAudiencePage(
        await rmqSend<unknown>(
          this.identityClient,
          { cmd: AUDIENCE_RESOLVE_PATTERN },
          { fields: 'minimal', ...payload },
        ),
      );
    } catch (error) {
      throw audienceRpcError(error);
    }
  }

  private explicitIds(input: AudiencePreviewInput): string[] {
    const raw = [
      ...(input.recipient_id ? [input.recipient_id] : []),
      ...(Array.isArray(input.recipient_ids) ? input.recipient_ids : []),
    ].map((id) => String(id ?? '').trim());
    const ids = [...new Set(raw.filter(Boolean))];
    const invalid = ids.find((id) => !ID_RE.test(id));
    if (invalid) {
      throw new BadRequestException(`recipient_ids noto'g'ri: ${invalid}`);
    }
    return ids;
  }

  async preview(rawInput: AudiencePreviewInput = {}) {
    try {
      const input = await this.withSavedSegment(rawInput ?? {});
      const target = buildAudienceTarget(input ?? {});
      const explicit = this.explicitIds(input ?? {});
      if (!target && !explicit.length) {
        throw new BadRequestException(
          "Auditoriya bo'sh: recipient_ids, roles, broadcast yoki include_customers (+segment) bering",
        );
      }
      const campaignMax = this.campaignMax;
      const collected = new Map<string, Collected>();
      let targetTotal = 0;
      let targetStats: IdentityAudiencePage['stats'] | undefined;

      if (target) {
        let page = await this.page({
          ...target,
          limit: PREVIEW_PAGE_SIZE,
          with_total: true,
          with_stats: true,
        });
        targetTotal = page.total ?? page.items.length;
        targetStats = page.stats;

        if (targetTotal + explicit.length > campaignMax) {
          // Juda katta — hammasini yig'maymiz; identity statistikasi aniq.
          return this.respond({
            sample: input.with_sample
              ? await this.sample(target, explicit)
              : undefined,
            exact: false,
            total: targetTotal + explicit.length,
            byRole: targetStats?.by_role ?? {},
            push: null,
            sms: targetStats?.with_valid_phone ?? null,
            explicit: explicit.length,
            notFound: 0,
            target,
            campaignMax,
            smsSplit: await this.smsSplit(
              input,
              null,
              targetTotal + explicit.length,
            ),
          });
        }

        while (true) {
          for (const item of page.items) {
            collected.set(String(item.id), {
              role: item.role ?? null,
              phone_valid: item.phone_valid === true,
            });
          }
          const next =
            page.items.length === PREVIEW_PAGE_SIZE
              ? (page.next_after_id ??
                String(page.items[page.items.length - 1]?.id ?? ''))
              : null;
          if (!next) break;
          page = await this.page({
            ...target,
            limit: PREVIEW_PAGE_SIZE,
            after_id: next,
            with_total: false,
          });
          if (!page.items.length) break;
        }
      }

      // Aniq id'lar: hali yig'ilmaganlarini identity'dan (rolsiz filtr).
      const missing = explicit.filter((id) => !collected.has(id));
      for (let i = 0; i < missing.length; i += PREVIEW_PAGE_SIZE) {
        const chunk = missing.slice(i, i + PREVIEW_PAGE_SIZE);
        const page = await this.page({
          user_ids: chunk,
          limit: PREVIEW_PAGE_SIZE,
          with_total: false,
        });
        for (const item of page.items) {
          collected.set(String(item.id), {
            role: item.role ?? null,
            phone_valid: item.phone_valid === true,
          });
        }
      }
      // Dispatch aniq id'larga baribir qator yozadi — ular jami songa kiradi.
      const notFound = missing.filter((id) => !collected.has(id)).length;

      const byRole: Record<string, number> = {};
      let sms = 0;
      for (const entry of collected.values()) {
        const role = entry.role ?? 'unknown';
        byRole[role] = (byRole[role] ?? 0) + 1;
        if (entry.phone_valid) sms += 1;
      }
      if (notFound) byRole.unknown = (byRole.unknown ?? 0) + notFound;

      const push = await this.countPushEligible([...collected.keys()]);

      return this.respond({
        sample: input.with_sample
          ? await this.sample(target, explicit)
          : undefined,
        exact: true,
        total: collected.size + notFound,
        byRole,
        push,
        sms,
        explicit: explicit.length,
        notFound,
        target,
        campaignMax,
        smsSplit: await this.smsSplit(
          input,
          collected,
          collected.size + notFound,
        ),
      });
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /** Kamida bitta push obunasi bor foydalanuvchilar (chunk'lab DISTINCT). */
  private async countPushEligible(ids: string[]): Promise<number> {
    let count = 0;
    for (let i = 0; i < ids.length; i += PUSH_COUNT_CHUNK) {
      const chunk = ids.slice(i, i + PUSH_COUNT_CHUNK);
      const rows = await this.pushRepo
        .createQueryBuilder('s')
        .select('COUNT(DISTINCT s.user_id)', 'count')
        .where({ user_id: In(chunk) })
        .getRawOne<{ count: string | number }>();
      count += Number(rows?.count ?? 0);
    }
    return count;
  }

  private respond(args: {
    sample?: AudienceSampleItem[];
    exact: boolean;
    total: number;
    byRole: Record<string, number>;
    push: number | null;
    sms: number | null;
    explicit: number;
    notFound: number;
    target: IdentityAudienceTarget | null;
    campaignMax: number;
    smsSplit?: AudienceSmsSplit | null;
  }) {
    const { total } = args;
    const warnings: string[] = [];
    if (args.target?.include_customers) warnings.push('includes_customers');
    if (args.target?.confirm_all_customers) warnings.push('all_customers');
    if (args.notFound) warnings.push('recipients_not_found');
    if (total > MAX_FANOUT) warnings.push('over_dispatch_cap_use_campaign');
    if (total > args.campaignMax) warnings.push('over_campaign_cap');
    // (ebSV5oyP) 0 ta — xom BadRequest emas, tushunarli holat.
    if (total === 0) warnings.push('empty_audience');
    return successRes(
      {
        exact: args.exact,
        total,
        by_role: args.byRole,
        by_channel: {
          in_app: total,
          realtime: total,
          push: args.push,
          // (9D1Gl9MS) SMS kanali tanlangan — roziligi borlar (haqiqatan
          // ketadiganlar); aks holda — kanonik telefonlilar (avvalgidek).
          sms: args.smsSplit ? args.smsSplit.recipients : args.sms,
          email: 0,
          telegram: null,
        },
        explicit: args.explicit,
        not_found: args.notFound,
        limits: { dispatch_max: MAX_FANOUT, campaign_max: args.campaignMax },
        // Sinxron POST /notifications/dispatch shu hajmga ruxsat beradimi.
        dispatch_allowed: total > 0 && total <= MAX_FANOUT,
        // POST /notifications/campaigns (asinxron) shu hajmga ruxsat beradimi.
        campaign_allowed: total > 0 && total <= args.campaignMax,
        warnings,
        ...(total === 0
          ? {
              hint: "Tanlangan filtrlar bo'yicha qabul qiluvchi topilmadi — filtrlarni kengaytiring",
            }
          : {}),
        ...(args.sample ? { sample: args.sample } : {}),
        ...(args.smsSplit ? { sms: args.smsSplit } : {}),
        notes: {
          sms: args.smsSplit
            ? "SMS — reklama: faqat roziligi borlarga; 18:00–09:00 da yuborilmaydi (09:00 ga suriladi); narx taxminiy (tarif × bo'laklar)"
            : "SMS: by_channel.sms — kanonik telefonlilar; rozilik bo'yicha son uchun channels: ['sms'] bering",
          telegram: "Market guruhi relay'i — qabul qiluvchi bo'yicha emas",
          email: 'Email provayderi ulanmagan',
        },
      },
      200,
      'Audience preview',
    );
  }
}
