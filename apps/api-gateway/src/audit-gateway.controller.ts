import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, timeout } from 'rxjs';
import {
  ACTIVITY_ACTION_CATEGORIES,
  Roles as RoleEnum,
  listActivityActions,
} from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { AuditEnrichmentService } from './audit/audit-enrichment.service';
import {
  ACTIVITY_FEED_OFFSET_CAP,
  FeedKey,
  compareFeedKeys,
  decodeFeedCursor,
  encodeFeedCursor,
  feedKeyOf,
  isAfterCursor,
  legBefore,
} from './audit/audit-feed-merge';
import { ActivityLogQueryDto } from './dto/activity-log.swagger.dto';

type Row = Record<string, any>;

interface ServiceLeg {
  name: string;
  client: ClientProxy;
}

/** Servis + uning global tartib raqami (k-way merge tie-break'i). */
interface RankedLeg extends ServiceLeg {
  rank: number;
}

/** Bitta sahifa natijasi (8eYmt4NV). */
interface FeedPage {
  items: Row[];
  /** Filtrlarning to'liq jami (servislar yig'indisi). */
  total: number;
  hasMore: boolean;
  /** Javob bermagan servislar — UI ogohlantirishi uchun. */
  failed: string[];
  /** Chuqurlik chegarasi yo'q (bitta servis yoki kursor rejimi). */
  exactDepth: boolean;
}

/**
 * Admin audit-log viewer. Logs live in per-schema activity_logs tables, so this
 * fans out to each service's `{svc}.activity_log.find_all` / `.find_by_entity`,
 * merges by created_at DESC, then enriches raw ids into full data.
 *
 * SUPERADMIN/ADMIN only (the audit trail exposes cross-tenant + financial info).
 * `?archive=true` (i6Nyedea) reads the cold `activity_logs_archive` tables
 * instead (rows moved there by retention) — same roles, same filters.
 * Each fan-out leg is fault-isolated: one slow/missing schema never 504s the view.
 */
@ApiTags('Activity Log')
@Controller('activity-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
@ApiBearerAuth()
export class AuditGatewayController {
  private readonly TIMEOUT = 12000;
  private readonly services: ServiceLeg[];

  constructor(
    @Inject('IDENTITY') identity: ClientProxy,
    @Inject('ORDER') order: ClientProxy,
    @Inject('FINANCE') finance: ClientProxy,
    @Inject('BRANCH') branch: ClientProxy,
    @Inject('INTEGRATION') integration: ClientProxy,
    @Inject('LOGISTICS') logistics: ClientProxy,
    @Inject('CATALOG') catalog: ClientProxy,
    @Inject('INVESTOR') investor: ClientProxy,
    @Inject('NOTIFICATION') notification: ClientProxy,
    private readonly enrichment: AuditEnrichmentService,
  ) {
    this.services = [
      { name: 'identity', client: identity },
      { name: 'order', client: order },
      { name: 'finance', client: finance },
      { name: 'branch', client: branch },
      { name: 'integration', client: integration },
      { name: 'logistics', client: logistics },
      { name: 'catalog', client: catalog },
      { name: 'investor', client: investor },
      { name: 'notification', client: notification },
    ];
  }

  /**
   * (y8CxCtcK) Fe'llar REYESTRDAN (statik 16 ta enum emas): `data` — fe'l
   * satrlari (orqaga mos: frontend `data.map(String)`), `registry` — har
   * fe'lning o'zbekcha yorlig'i, kategoriyasi, ikona/toni, `categories` —
   * dropdown guruhlari tartibi (antd optGroup).
   */
  @Get('actions')
  @ApiOperation({
    summary:
      'Audit action verbs registry (label/category/icon/tone) for filter dropdowns',
  })
  actions() {
    const registry = listActivityActions();
    return {
      data: registry.map((a) => a.action),
      registry,
      categories: ACTIVITY_ACTION_CATEGORIES,
    };
  }

  /**
   * (8eYmt4NV) ANIQ sahifalash — har qanday `page <= totalPages` qatorli,
   * global `created_at DESC` tartibda, dublikatsiz:
   *   • `?service=X` — servisning o'z ofseti (chegarasiz, aniq);
   *   • bir nechta servis, `?page=N` — 1-faza: har servisdan faqat KALITLAR
   *     (`keys_only`, `(N-1)*limit` ta) → global chegara qator; 2-faza: har
   *     servisdan chegaradan keyingi `limit+1` qator (keyset) → k-way merge.
   *     `ACTIVITY_FEED_OFFSET_CAP` dan chuqur — `meta.truncated`;
   *   • `?cursor=<meta.next_cursor>` — istalgan chuqurlik, har sahifa O(limit).
   * `meta.total` = haqiqatan o'qiladigan qatorlar (cheklangan bo'lsa
   * `meta.total_all` — to'liq jami).
   */
  @Get()
  @ApiOperation({
    summary: 'Audit-log feed (merged across services, enriched)',
  })
  async list(@Query() q: ActivityLogQueryDto) {
    const page = q.page && q.page > 0 ? Math.floor(q.page) : 1;
    const limit =
      q.limit && q.limit > 0 ? Math.min(Math.floor(q.limit), 100) : 20;

    const filters = {
      entity_type: q.entity_type,
      entity_id: q.entity_id,
      action: q.action,
      user_id: q.user_id,
      user_role: q.user_role,
      trace_id: q.trace_id,
      from: q.from,
      to: q.to,
      search: q.search,
      // i6Nyedea — arxiv (cold jadval) o'qish; faqat so'ralganda uzatiladi
      // (eski servis versiyasi uni bilmasa — hot jadval, avvalgidek).
      ...(q.archive === true ? { archive: true } : {}),
    };

    const legs: RankedLeg[] = this.services
      .map((s, rank) => ({ ...s, rank }))
      .filter((s) => !q.service || s.name === q.service);
    const names = this.services.map((s) => s.name);

    let result: FeedPage;
    if (q.cursor !== undefined) {
      const cursor = decodeFeedCursor(q.cursor, names);
      if (!cursor) {
        throw new BadRequestException(
          "cursor yaroqsiz — meta.next_cursor qiymatini o'zgartirmasdan yuboring",
        );
      }
      result = await this.fetchAfter(legs, filters, cursor, limit, true);
    } else if (legs.length === 1) {
      result = await this.fetchSingleLegPage(legs[0], filters, page, limit);
    } else {
      result = await this.fetchMergedPage(legs, filters, page, limit);
    }

    const total = result.total;
    const truncated = total > ACTIVITY_FEED_OFFSET_CAP && !result.exactDepth;
    const readable = truncated ? ACTIVITY_FEED_OFFSET_CAP : total;
    const items = await this.enrichment.enrich(result.items);
    const last = result.items[result.items.length - 1];

    return {
      data: {
        items,
        meta: {
          page: q.cursor !== undefined ? null : page,
          limit,
          total: readable,
          totalPages: Math.max(1, Math.ceil(readable / limit)),
          next_cursor:
            result.hasMore && last
              ? encodeFeedCursor(
                  feedKeyOf(last, names.indexOf(String(last._service))),
                  String(last._service),
                )
              : null,
          ...(truncated
            ? {
                truncated: true,
                total_all: total,
                hint: "Chuqurroq ko'rish uchun sana oralig'ini toraytiring, xizmatni tanlang yoki next_cursor bilan davom eting",
              }
            : {}),
          ...(result.failed.length ? { failed_services: result.failed } : {}),
          ...(q.archive === true ? { archive: true } : {}),
        },
      },
    };
  }

  /** Bitta servis — uning o'z ofseti aniq (chegarasiz). */
  private async fetchSingleLegPage(
    leg: RankedLeg,
    filters: Record<string, unknown>,
    page: number,
    limit: number,
  ): Promise<FeedPage> {
    try {
      const r = await this.send(
        leg.client,
        `${leg.name}.activity_log.find_all`,
        { query: { ...filters, page, limit, with_total: true } },
      );
      const items = this.itemsOf(r).map((it) => ({
        ...it,
        _service: leg.name,
      }));
      const total = this.totalOf(r);
      return {
        items,
        total,
        hasMore: (page - 1) * limit + items.length < total,
        failed: [],
        exactDepth: true,
      };
    } catch {
      return {
        items: [],
        total: 0,
        hasMore: false,
        failed: [leg.name],
        exactDepth: true,
      };
    }
  }

  /** Bir nechta servis, `?page=N`: kalitlar bilan global chegara → keyset. */
  private async fetchMergedPage(
    legs: RankedLeg[],
    filters: Record<string, unknown>,
    page: number,
    limit: number,
  ): Promise<FeedPage> {
    const offset = (page - 1) * limit;
    if (offset === 0) {
      return this.fetchAfter(legs, filters, null, limit, true);
    }

    // 1-faza: faqat kalitlar (id + cursor_ts), har servisdan `offset` tagacha.
    // Chegaradan chuqur sahifa — kalit yuklanmaydi, faqat jami (limit 1).
    const tooDeep = offset > ACTIVITY_FEED_OFFSET_CAP;
    const window = tooDeep ? 1 : offset;
    const keyed = await Promise.all(
      legs.map((leg) =>
        this.send(leg.client, `${leg.name}.activity_log.find_all`, {
          query: {
            ...filters,
            page: 1,
            limit: window,
            keys_only: true,
            with_total: true,
          },
        })
          .then((r) => ({
            leg,
            ok: true,
            keys: this.itemsOf(r)
              .map((it) => feedKeyOf(it, leg.rank))
              .sort(compareFeedKeys)
              .slice(0, window),
            total: this.totalOf(r),
          }))
          .catch(() => ({
            leg,
            ok: false,
            keys: [] as FeedKey[],
            total: 0,
          })),
      ),
    );
    const total = keyed.reduce((acc, k) => acc + k.total, 0);
    const failed = keyed.filter((k) => !k.ok).map((k) => k.leg.name);
    const okLegs = keyed.filter((k) => k.ok).map((k) => k.leg);

    const allKeys = keyed.flatMap((k) => k.keys).sort(compareFeedKeys);
    if (tooDeep || allKeys.length < offset) {
      // Chuqurlik chegarasidan tashqari yoki ma'lumot tugagan.
      return { items: [], total, hasMore: false, failed, exactDepth: false };
    }
    const boundary = allKeys[offset - 1];

    // 2-faza: chegaradan keyingi qatorlar (sanashsiz).
    const after = await this.fetchAfter(
      okLegs,
      filters,
      boundary,
      limit,
      false,
    );
    return {
      items: after.items,
      total,
      hasMore: after.hasMore,
      failed: [...failed, ...after.failed],
      exactDepth: false,
    };
  }

  /**
   * Kursordan (yoki boshidan) keyingi `limit` qator: har servisga o'z keyset
   * sharti, `limit+1` (keyingi sahifa bormi), k-way merge. Servis eski
   * versiyada bo'lib shartni e'tiborsiz qoldirsa ham — gateway qatorlarni
   * o'zi ham kursor bo'yicha kesadi (dublikat chiqmaydi).
   */
  private async fetchAfter(
    legs: RankedLeg[],
    filters: Record<string, unknown>,
    cursor: FeedKey | null,
    limit: number,
    withTotal: boolean,
  ): Promise<FeedPage> {
    const responses = await Promise.all(
      legs.map((leg) =>
        this.send(leg.client, `${leg.name}.activity_log.find_all`, {
          query: {
            ...filters,
            page: 1,
            limit: limit + 1,
            with_total: withTotal,
            ...(cursor ? legBefore(cursor, leg.rank) : {}),
          },
        })
          .then((r) => ({
            leg,
            ok: true,
            items: this.itemsOf(r),
            total: this.totalOf(r),
          }))
          .catch(() => ({ leg, ok: false, items: [] as Row[], total: 0 })),
      ),
    );

    const merged = responses
      .flatMap((r) =>
        r.items.map((it) => ({
          row: { ...it, _service: r.leg.name },
          key: feedKeyOf(it, r.leg.rank),
        })),
      )
      .filter((x) => !cursor || isAfterCursor(x.key, cursor))
      .sort((a, b) => compareFeedKeys(a.key, b.key));

    return {
      items: merged.slice(0, limit).map((x) => x.row),
      total: responses.reduce((acc, r) => acc + r.total, 0),
      hasMore: merged.length > limit,
      failed: responses.filter((r) => !r.ok).map((r) => r.leg.name),
      exactDepth: cursor !== null,
    };
  }

  private totalOf(r: any): number {
    return Number(r?.meta?.total ?? r?.data?.meta?.total ?? 0) || 0;
  }

  @Get('entity/:entity_type/:entity_id')
  @ApiOperation({
    summary: 'Full history of one entity (merged across services)',
  })
  @ApiParam({ name: 'entity_type', example: 'Order' })
  @ApiParam({ name: 'entity_id', example: '123' })
  async entityHistory(
    @Param('entity_type') entityType: string,
    @Param('entity_id') entityId: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Number(limitRaw) > 0 ? Math.min(Number(limitRaw), 500) : 200;
    const responses = await Promise.all(
      this.services.map((leg) =>
        this.send(leg.client, `${leg.name}.activity_log.find_by_entity`, {
          entity_type: entityType,
          entity_id: entityId,
          limit,
        })
          .then((r) =>
            this.itemsOf(r).map((it: Row) => ({ ...it, _service: leg.name })),
          )
          .catch(() => [] as Row[]),
      ),
    );
    const merged = responses.flat().sort(this.byNewest);
    const items = await this.enrichment.enrich(merged);
    return { data: { items, meta: { total: items.length } } };
  }

  @Get('user/:user_id')
  @ApiOperation({ summary: 'Everything a user did (merged across services)' })
  @ApiParam({ name: 'user_id', example: '42' })
  async userHistory(
    @Param('user_id') userId: string,
    @Query() q: ActivityLogQueryDto,
  ) {
    return this.list({ ...q, user_id: userId } as ActivityLogQueryDto);
  }

  // ---- helpers ---------------------------------------------------------

  private send(client: ClientProxy, cmd: string, payload: unknown) {
    return firstValueFrom(
      client.send({ cmd }, payload).pipe(timeout(this.TIMEOUT)),
    );
  }

  /** Normalise the various envelope shapes a service might return. */
  private itemsOf(r: any): Row[] {
    if (Array.isArray(r)) return r;
    if (Array.isArray(r?.items)) return r.items;
    if (Array.isArray(r?.data)) return r.data;
    if (Array.isArray(r?.data?.items)) return r.data.items;
    return [];
  }

  private byNewest = (a: Row, b: Row): number => {
    const t =
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (t !== 0 && !Number.isNaN(t)) return t;
    return Number(b.id ?? 0) - Number(a.id ?? 0);
  };
}
