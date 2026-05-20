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
