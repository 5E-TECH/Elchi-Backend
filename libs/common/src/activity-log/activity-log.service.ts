import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { requestContext } from '../context/request-context';
import { ActivityLog } from './activity-log.entity';
import { computeDiff } from './diff';
import {
  ACTIVITY_LOG_SERVICE_NAME,
  ActivityAction,
  ActivityChangeInput,
  ActivityLogInput,
  ActivityLogPage,
  ActivityLogQuery,
} from './types';

function normaliseJsonb(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  // Wrap primitives/arrays so JSONB column always sees an object shape.
  return { value };
}

@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);

  constructor(
    @InjectRepository(ActivityLog)
    private readonly repo: Repository<ActivityLog>,
    @Optional()
    @Inject(ACTIVITY_LOG_SERVICE_NAME)
    private readonly serviceName: string | null = null,
  ) {}

  /**
   * Persist an audit event. Failures are caught — audit logging must not
   * break the business operation that triggered it. If the write fails,
   * the error is logged and processing continues.
   */
  async log(input: ActivityLogInput): Promise<void> {
    try {
      const ctx = requestContext.get();
      const entity = this.repo.create({
        entity_type: input.entity_type,
        entity_id: String(input.entity_id),
        action: input.action,
        old_value: normaliseJsonb(input.old_value),
        new_value: normaliseJsonb(input.new_value),
        user_id: input.user_id ?? ctx?.userId ?? null,
        user_name: input.user_name ?? null,
        user_role: input.user_role ?? null,
        service: this.serviceName,
        trace_id: input.trace_id ?? ctx?.traceId ?? null,
        metadata: normaliseJsonb(input.metadata),
      });
      await this.repo.save(entity);
    } catch (err) {
      this.logger.error(
        `activity-log write failed for ${input.entity_type}:${input.entity_id} action=${input.action}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /**
   * Log a diff between two snapshots. Only changed fields are stored.
   * If nothing changed (after default-ignore filtering), no row is written —
   * silent updates from save() should not pollute the audit table.
   */
  async logChange(input: ActivityChangeInput): Promise<void> {
    const diff = computeDiff(
      input.old_value,
      input.new_value,
      input.ignore_fields ?? [],
    );
    if (
      Object.keys(diff.before).length === 0 &&
      Object.keys(diff.after).length === 0
    ) {
      return;
    }
    await this.log({
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      action: input.action ?? ActivityAction.UPDATED,
      old_value: diff.before,
      new_value: diff.after,
      user_id: input.user_id,
      user_name: input.user_name,
      user_role: input.user_role,
      trace_id: input.trace_id,
      metadata: input.metadata,
    });
  }

  async findByEntity(
    entity_type: string,
    entity_id: string | number,
    limit = 50,
  ): Promise<ActivityLog[]> {
    return this.repo.find({
      where: { entity_type, entity_id: String(entity_id) },
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  async findByUser(user_id: string, limit = 50): Promise<ActivityLog[]> {
    return this.repo.find({
      where: { user_id },
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  /**
   * Filterable, paginated read over this service's own activity_logs table.
   * Backs the `{service}.activity_log.find_all` message pattern; the gateway
   * fans this out across services, merges by created_at DESC, and enriches ids.
   * Rows are ordered newest-first with id as a stable tiebreak.
   */
  async query(q: ActivityLogQuery = {}): Promise<ActivityLogPage<ActivityLog>> {
    const page = Number(q.page) > 0 ? Math.floor(Number(q.page)) : 1;
    const rawLimit = Number(q.limit) > 0 ? Math.floor(Number(q.limit)) : 50;
    const limit = Math.min(rawLimit, 500);

    const qb = this.repo.createQueryBuilder('a');

    if (q.entity_type) qb.andWhere('a.entity_type = :et', { et: q.entity_type });
    if (q.entity_id !== undefined && q.entity_id !== null && `${q.entity_id}` !== '') {
      qb.andWhere('a.entity_id = :eid', { eid: String(q.entity_id) });
    }
    if (q.action) qb.andWhere('a.action = :act', { act: q.action });
    if (q.user_id) qb.andWhere('a.user_id = :uid', { uid: String(q.user_id) });
    if (q.user_role) qb.andWhere('a.user_role ILIKE :urole', { urole: `%${q.user_role}%` });
    if (q.trace_id) qb.andWhere('a.trace_id = :tid', { tid: q.trace_id });
    // Parse date bounds defensively — an invalid value must be IGNORED, never
    // forwarded to the driver (which would throw and silently empty the feed).
    const parseDate = (v: string | Date): Date | null => {
      const d = v instanceof Date ? v : new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const isDateOnly = (v: string | Date): boolean =>
      typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
    if (q.from) {
      const from = parseDate(q.from);
      if (from) qb.andWhere('a.created_at >= :from', { from });
    }
    if (q.to) {
      let to = parseDate(q.to);
      // A date-only upper bound should be inclusive of that whole day.
      if (to && isDateOnly(q.to)) to = new Date(to.getTime() + 86_400_000 - 1);
      if (to) qb.andWhere('a.created_at <= :to', { to });
    }
    if (q.search && q.search.trim()) {
      const term = `%${q.search.trim()}%`;
      qb.andWhere(
        '(a.entity_type ILIKE :s OR a.entity_id ILIKE :s OR a.action ILIKE :s OR a.user_name ILIKE :s)',
        { s: term },
      );
    }

    qb.orderBy('a.created_at', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return {
      items,
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** Best-effort retention: delete rows older than `olderThanMs`. */
  async prune(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where('created_at < :cutoff', { cutoff })
      .execute();
    return result.affected ?? 0;
  }
}
