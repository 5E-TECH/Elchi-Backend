import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { firstValueFrom, timeout } from 'rxjs';
import { ActivityAction, Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { AuditEnrichmentService } from './audit/audit-enrichment.service';
import { ActivityLogQueryDto } from './dto/activity-log.swagger.dto';

type Row = Record<string, any>;

interface ServiceLeg {
  name: string;
  client: ClientProxy;
}

/**
 * Admin audit-log viewer. Logs live in per-schema activity_logs tables, so this
 * fans out to each service's `{svc}.activity_log.find_all` / `.find_by_entity`,
 * merges by created_at DESC, then enriches raw ids into full data.
 *
 * SUPERADMIN/ADMIN only (the audit trail exposes cross-tenant + financial info).
 * Each fan-out leg is fault-isolated: one slow/missing schema never 504s the view.
 */
@ApiTags('Activity Log')
@Controller('activity-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
@ApiBearerAuth()
export class AuditGatewayController {
  private readonly TIMEOUT = 12000;
  private readonly WINDOW_CAP = 500;
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

  @Get('actions')
  @ApiOperation({ summary: 'Known audit action verbs (for filter dropdowns)' })
  actions() {
    return { data: Object.values(ActivityAction) };
  }

  @Get()
  @ApiOperation({ summary: 'Audit-log feed (merged across services, enriched)' })
  async list(@Query() q: ActivityLogQueryDto) {
    const page = q.page && q.page > 0 ? Math.floor(q.page) : 1;
    const limit = q.limit && q.limit > 0 ? Math.min(Math.floor(q.limit), 100) : 20;

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
    };

    // Over-fetch a bounded window from each leg, then merge+sort+slice. Exact
    // for the first pages; deep history should narrow with from/to or service.
    const window = Math.min(this.WINDOW_CAP, page * limit);
    const legs = q.service
      ? this.services.filter((s) => s.name === q.service)
      : this.services;

    const responses = await Promise.all(
      legs.map((leg) =>
        this.send(leg.client, `${leg.name}.activity_log.find_all`, {
          query: { ...filters, page: 1, limit: window },
        })
          .then((r) => ({
            name: leg.name,
            items: this.itemsOf(r),
            total: Number(r?.meta?.total ?? r?.data?.meta?.total ?? 0),
          }))
          .catch(() => ({ name: leg.name, items: [] as Row[], total: 0 })),
      ),
    );

    const merged = responses
      .flatMap((r) => r.items.map((it) => ({ ...it, _service: r.name })))
      .sort(this.byNewest);
    const total = responses.reduce((acc, r) => acc + r.total, 0);
    const slice = merged.slice((page - 1) * limit, (page - 1) * limit + limit);
    const items = await this.enrichment.enrich(slice);

    return {
      data: {
        items,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      },
    };
  }

  @Get('entity/:entity_type/:entity_id')
  @ApiOperation({ summary: 'Full history of one entity (merged across services)' })
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
          .then((r) => this.itemsOf(r).map((it: Row) => ({ ...it, _service: leg.name })))
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
    return firstValueFrom(client.send({ cmd }, payload).pipe(timeout(this.TIMEOUT)));
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
    const t = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (t !== 0 && !Number.isNaN(t)) return t;
    return Number(b.id ?? 0) - Number(a.id ?? 0);
  };
}
