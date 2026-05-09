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
   * - 'in_progress' when another worker is still processing
   */
  async tryAcquire<T>(key: string, pattern: string): Promise<AcquireResult<T>> {
    try {
      await this.repo.insert({ key, pattern, status: 'in_progress' });
      return { status: 'new' };
    } catch (error) {
      if (
        !(error instanceof QueryFailedError) ||
        (error as QueryFailedError & { code?: string }).code !== PG_UNIQUE_VIOLATION
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
