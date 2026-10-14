import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
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
const PUSH_COUNT_CHUNK = 1000;
const ID_RE = /^\d{1,19}$/;

export interface AudiencePreviewInput extends AudienceTargetInput {
  recipient_id?: string | null;
  recipient_ids?: string[] | null;
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
  ) {}

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

  async preview(input: AudiencePreviewInput = {}) {
    try {
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
            exact: false,
            total: targetTotal + explicit.length,
            byRole: targetStats?.by_role ?? {},
            push: null,
            sms: targetStats?.with_valid_phone ?? null,
            explicit: explicit.length,
            notFound: 0,
            target,
            campaignMax,
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
        exact: true,
        total: collected.size + notFound,
        byRole,
        push,
        sms,
        explicit: explicit.length,
        notFound,
        target,
        campaignMax,
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
    exact: boolean;
    total: number;
    byRole: Record<string, number>;
    push: number | null;
    sms: number | null;
    explicit: number;
    notFound: number;
    target: IdentityAudienceTarget | null;
    campaignMax: number;
  }) {
    const { total } = args;
    const warnings: string[] = [];
    if (args.target?.include_customers) warnings.push('includes_customers');
    if (args.target?.confirm_all_customers) warnings.push('all_customers');
    if (args.notFound) warnings.push('recipients_not_found');
    if (total > MAX_FANOUT) warnings.push('over_dispatch_cap_use_campaign');
    if (total > args.campaignMax) warnings.push('over_campaign_cap');
    return successRes(
      {
        exact: args.exact,
        total,
        by_role: args.byRole,
        by_channel: {
          in_app: total,
          realtime: total,
          push: args.push,
          sms: args.sms,
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
        notes: {
          sms: 'SMS bu oqimda yoqilmagan (alohida SMS epik) — son faqat kanonik telefonlilar',
          telegram: "Market guruhi relay'i — qabul qiluvchi bo'yicha emas",
          email: 'Email provayderi ulanmagan',
        },
      },
      200,
      'Audience preview',
    );
  }
}
