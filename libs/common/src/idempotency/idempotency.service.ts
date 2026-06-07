import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryFailedError } from 'typeorm';
import { IdempotencyKey } from './idempotency-key.entity';

export type AcquireResult<T = unknown> =
  | { status: 'new' }
  | { status: 'cached'; response: T }
  | { status: 'in_progress' }
  | { status: 'failed'; error: unknown };

const PG_UNIQUE_VIOLATION = '23505';

/**
 * How long an `in_progress` reservation is considered alive. If a worker crashes
 * (process dies) between reserving the key and marking it completed/failed, the
 * key would otherwise stay `in_progress` forever — poisoning that request_id and
 * causing redeliveries to requeue endlessly. After this lease elapses the row is
 * treated as abandoned and may be reclaimed by the next caller. Override per call
 * (e.g. for unusually long handlers) via the `leaseMs` argument to `tryAcquire`.
 */
export const DEFAULT_IDEMPOTENCY_LEASE_MS = 30_000;

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @InjectRepository(IdempotencyKey)
    private readonly repo: Repository<IdempotencyKey>,
  ) {}

  /**
   * Atomically reserve a key. Returns:
   * - 'new' when this is the first call (caller must execute the work)
   * - 'cached'/'failed' when another caller already finished it (return cached result)
   * - 'in_progress' when another worker is still processing within the lease window
   *
   * Stale-lease recovery: an `in_progress` row older than `leaseMs` is assumed to
   * belong to a crashed worker. The next caller atomically reclaims it (re-stamping
   * `created_at`) and proceeds as 'new'. The reclaim is guarded in SQL so only one
   * concurrent caller wins; the rest still see 'in_progress'.
   */
  async tryAcquire<T>(
    key: string,
    pattern: string,
    leaseMs: number = DEFAULT_IDEMPOTENCY_LEASE_MS,
  ): Promise<AcquireResult<T>> {
    try {
      await this.repo.insert({ key, pattern, status: 'in_progress' });
      return { status: 'new' };
    } catch (error) {
      if (
        !(error instanceof QueryFailedError) ||
        (error as QueryFailedError & { code?: string }).code !==
          PG_UNIQUE_VIOLATION
      ) {
        throw error;
      }
    }

    const existing = await this.repo.findOne({ where: { key } });
    if (!existing) {
      return { status: 'new' };
    }

    if (existing.status === 'completed') {
      return { status: 'cached', response: existing.response as T };
    }
    if (existing.status === 'failed') {
      return { status: 'failed', error: existing.error };
    }

    // status === 'in_progress' — recover the key if its lease has expired.
    const cutoff = new Date(Date.now() - leaseMs);
    if (existing.created_at instanceof Date && existing.created_at < cutoff) {
      const reclaimed = await this.repo
        .createQueryBuilder()
        .update(IdempotencyKey)
        // Re-stamp the lease only. An `in_progress` row already has null
        // response/error/completed_at, so there is nothing else to reset.
        .set({ created_at: () => 'now()' })
        .where('key = :key', { key })
        .andWhere('status = :status', { status: 'in_progress' })
        .andWhere('created_at < :cutoff', { cutoff })
        .execute();
      if ((reclaimed.affected ?? 0) > 0) {
        this.logger.warn(
          `Reclaimed stale idempotency lease for key=${key} (pattern=${pattern}, leaseMs=${leaseMs})`,
        );
        return { status: 'new' };
      }
    }

    return { status: 'in_progress' };
  }

  async markCompleted(key: string, response: unknown): Promise<void> {
    await this.repo.update(
      { key },
      {
        status: 'completed',
        response: response as object,
        completed_at: new Date(),
      },
    );
  }

  async markFailed(key: string, error: unknown): Promise<void> {
    await this.repo.update(
      { key },
      {
        status: 'failed',
        error: error as object,
        completed_at: new Date(),
      },
    );
  }

  /** Best-effort cleanup: remove keys older than `olderThanMs`. */
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
