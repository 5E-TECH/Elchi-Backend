import { EntityManager, Repository, ObjectLiteral } from 'typeorm';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityAction } from '../activity-log/types';

export interface SoftDeleteOptions {
  /** Entity type label used in activity log (e.g. 'Order', 'Cashbox'). */
  entityType: string;
  /** Primary key value of the row being deleted. */
  entityId: string | number;
  /**
   * Acting user — denormalised into the activity log so a renamed/deleted
   * user does not erase the audit trail. Pass `null` for system actions.
   */
  user?: {
    id?: string | null;
    name?: string | null;
    role?: string | null;
  } | null;
  /** Optional human-readable reason (goes into metadata). */
  reason?: string | null;
  /** Extra context to attach to the activity log entry. */
  metadata?: Record<string, unknown> | null;
  /** Run inside the caller's transaction when provided. */
  manager?: EntityManager;
}

/**
 * Soft-delete a row in a way that keeps every audit trail in sync:
 *   1. Stamps `deleted_at = NOW()` (TypeORM-native — auto-filters from queries).
 *   2. Flips the legacy `is_deleted` flag so existing explicit filters still work.
 *   3. Writes an ActivityLog entry with who/why/when.
 *
 * Single entry point removes the failure mode where one of the three states
 * gets updated and the others drift — that bug is hard to spot until support
 * is staring at a row that's "deleted" by one query and "active" by another.
 *
 * The entity must have BOTH `deleted_at` (DeleteDateColumn) AND `is_deleted`
 * (boolean from BaseEntity). For entities that only have one, call
 * `repo.softDelete()` directly.
 */
export async function softDeleteWithAudit<T extends ObjectLiteral>(
  repo: Repository<T>,
  activityLog: ActivityLogService,
  options: SoftDeleteOptions,
): Promise<void> {
  const targetRepo = options.manager
    ? options.manager.getRepository(repo.target)
    : repo;

  const id = String(options.entityId);
  const now = new Date();

  // Single UPDATE so the two flags can never diverge mid-write.
  await targetRepo
    .createQueryBuilder()
    .update()
    .set({
      deleted_at: now,
      is_deleted: true,
    } as never)
    .where('id = :id', { id })
    .execute();

  await activityLog.log({
    entity_type: options.entityType,
    entity_id: id,
    action: ActivityAction.DELETED,
    user_id: options.user?.id ?? null,
    user_name: options.user?.name ?? null,
    user_role: options.user?.role ?? null,
    metadata: {
      reason: options.reason ?? null,
      ...(options.metadata ?? {}),
    },
  });
}

/**
 * Reverse a soft delete. Mirror of softDeleteWithAudit — clears both
 * deleted_at and is_deleted, writes a RESTORED activity log entry.
 */
export async function restoreWithAudit<T extends ObjectLiteral>(
  repo: Repository<T>,
  activityLog: ActivityLogService,
  options: SoftDeleteOptions,
): Promise<void> {
  const targetRepo = options.manager
    ? options.manager.getRepository(repo.target)
    : repo;
  const id = String(options.entityId);

  await targetRepo
    .createQueryBuilder()
    .update()
    .set({
      deleted_at: null,
      is_deleted: false,
    } as never)
    .where('id = :id', { id })
    .execute();

  await activityLog.log({
    entity_type: options.entityType,
    entity_id: id,
    action: ActivityAction.RESTORED,
    user_id: options.user?.id ?? null,
    user_name: options.user?.name ?? null,
    user_role: options.user?.role ?? null,
    metadata: {
      reason: options.reason ?? null,
      ...(options.metadata ?? {}),
    },
  });
}
