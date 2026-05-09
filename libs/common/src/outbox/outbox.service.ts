import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, LessThanOrEqual, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { OutboxEvent } from './outbox-event.entity';

export interface EnqueueOptions {
  /** When set, write inside the caller's transaction. */
  manager?: EntityManager;
  /** Optional logical request id to embed into payload (for downstream idempotency). */
  requestId?: string;
  /** Schedule the event for later (e.g. delayed retry). Default: NOW. */
  scheduledAt?: Date;
}

@Injectable()
export class OutboxService {
  constructor(
    @InjectRepository(OutboxEvent)
    private readonly repo: Repository<OutboxEvent>,
  ) {}

  /**
   * Insert an outbox event. Pass `options.manager` to enroll into the caller's
   * transaction (so the event is persisted iff the business write also commits).
   */
  async enqueue(
    target: string,
    pattern: string,
    payload: unknown,
    options: EnqueueOptions = {},
  ): Promise<OutboxEvent> {
    const enrichedPayload = this.attachRequestId(payload, options.requestId);
    const repo = options.manager
      ? options.manager.getRepository(OutboxEvent)
      : this.repo;
    const entity = repo.create({
      target,
      pattern,
      payload: enrichedPayload,
      status: 'pending',
      attempts: 0,
      scheduled_at: options.scheduledAt ?? new Date(),
    });
    return repo.save(entity);
  }

  async getDuePending(limit: number): Promise<OutboxEvent[]> {
    return this.repo.find({
      where: { status: 'pending', scheduled_at: LessThanOrEqual(new Date()) },
      order: { scheduled_at: 'ASC', id: 'ASC' },
      take: limit,
    });
  }

  async markPublished(id: string): Promise<void> {
    await this.repo.update(
      { id },
      { status: 'published', published_at: new Date(), last_error: null },
    );
  }

  /**
   * Increment attempts, store last error, schedule next attempt with backoff.
   * After `maxAttempts`, mark as failed (poison) — operator must inspect.
   */
  async markFailed(
    id: string,
    error: string,
    backoffMs: number,
    maxAttempts = 10,
  ): Promise<void> {
    const event = await this.repo.findOne({ where: { id } });
    if (!event) return;
    const nextAttempts = event.attempts + 1;
    if (nextAttempts >= maxAttempts) {
      await this.repo.update(
        { id },
        { status: 'failed', attempts: nextAttempts, last_error: error },
      );
      return;
    }
    await this.repo.update(
      { id },
      {
        attempts: nextAttempts,
        last_error: error,
        scheduled_at: new Date(Date.now() + backoffMs),
      },
    );
  }

  /** Best-effort cleanup of old published events. */
  async pruneOldPublished(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where('status = :status', { status: 'published' })
      .andWhere('published_at < :cutoff', { cutoff })
      .execute();
    return result.affected ?? 0;
  }

  private attachRequestId(payload: unknown, requestId?: string): unknown {
    const id = requestId ?? randomUUID();
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return { value: payload, request_id: id };
    }
    const obj = payload as Record<string, unknown>;
    if (typeof obj.request_id === 'string' && obj.request_id.length > 0) {
      return obj;
    }
    return { ...obj, request_id: id };
  }
}
