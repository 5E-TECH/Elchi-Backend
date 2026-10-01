import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { randomUUID } from 'crypto';
import { OutboxEvent } from './outbox-event.entity';
import { DEFAULT_OUTBOX_MAX_ATTEMPTS } from './tokens';

/** `requeueFailed` filtri — berilmagan maydon cheklamaydi. */
export interface RequeueFailedFilter {
  /** Faqat shu id'lar. */
  ids?: string[];
  /** Faqat shu patternlar (aniq moslik). */
  patterns?: string[];
}

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

  /**
   * Count terminal FAILED (poison) events. These are never retried and are
   * invisible to getDuePending, so a monitor must surface them or a stuck
   * money/state event sits silently forever.
   */
  async countFailed(): Promise<number> {
    return this.repo.count({ where: { status: 'failed' } });
  }

  /**
   * Hamon `pending`, lekin kamida `minAttempts` marta yiqilgan hodisalar soni
   * (audit M8). Doimiy (pul) hodisalar endi `failed` bo'lmaydi — ular uzoq
   * vaqt yetkazilmasa monitor shu son orqali ko'radi.
   */
  async countStuckPending(minAttempts: number): Promise<number> {
    return this.repo.count({
      where: { status: 'pending', attempts: MoreThanOrEqual(minAttempts) },
    });
  }

  /**
   * Operator uchun qayta o'ynash (audit M8): `failed` hodisalarni yana
   * `pending` qiladi — `attempts` 0 dan, darhol navbatga. `last_error`
   * tashxis uchun saqlanadi. Filtr berilmasa BARCHA `failed` hodisalar.
   *
   * ⚠️ Faqat tekshirilgandan keyin chaqiring: hodisa qo'lda (SQL bilan)
   * allaqachon qo'llangan bo'lsa, qabul qiluvchining dedup kaliti bo'lmagan
   * yo'lda ikki marta yozilishi mumkin. Qaytaradi — o'zgargan qatorlar soni.
   */
  async requeueFailed(filter: RequeueFailedFilter = {}): Promise<number> {
    const ids = (filter.ids ?? [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean);
    const patterns = (filter.patterns ?? [])
      .map((pattern) => String(pattern ?? '').trim())
      .filter(Boolean);
    const query = this.repo
      .createQueryBuilder()
      .update(OutboxEvent)
      .set({ status: 'pending', attempts: 0, scheduled_at: () => 'NOW()' })
      .where('status = :status', { status: 'failed' });
    if (ids.length) {
      query.andWhere('id IN (:...ids)', { ids });
    }
    if (patterns.length) {
      query.andWhere('pattern IN (:...patterns)', { patterns });
    }
    const result = await query.execute();
    return result.affected ?? 0;
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
   * `maxAttempts = Infinity` — hech qachon poison emas (doimiy pul hodisasi,
   * audit M8): faqat urinish soni va keyingi muddat yangilanadi.
   */
  async markFailed(
    id: string,
    error: string,
    backoffMs: number,
    maxAttempts = DEFAULT_OUTBOX_MAX_ATTEMPTS,
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
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      return { value: payload, request_id: id };
    }
    const obj = payload as Record<string, unknown>;
    if (typeof obj.request_id === 'string' && obj.request_id.length > 0) {
      return obj;
    }
    return { ...obj, request_id: id };
  }
}
