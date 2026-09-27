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

/**
 * `tryAcquire` ning ixtiyoriy kengaytmalari. Berilmasa (`undefined`) xatti-harakat
 * AYNAN avvalgidek: tugagan kalit abadiy keshdan qaytadi, yiqilgan kalit abadiy
 * `failed` qaytaradi.
 */
export interface TryAcquireOptions {
  /**
   * `completed` javob shu muddatdan (ms) eskirgach kalit QAYTA egallanadi va
   * handler yana ishlaydi. Yosh `COALESCE(completed_at, created_at)` bo'yicha
   * o'lchanadi.
   *
   * ⚠️ Faqat DETERMINISTIK kalitlar uchun (masalan ai-confirm'ning
   * `ai-dedupe:<sha256>` kaliti, TTL 10 daqiqa): ular "shu daqiqalarda yuborilgan
   * dublikat"ni ushlaydi, lekin mijoz ertaga ATAYLAB xuddi shu buyurtmani yana
   * bersa, u abadiy bloklanib qolmasligi kerak. Tasodifiy (UUID) `request_id`
   * uchun TTL bermang — u yerda kesh abadiy bo'lishi to'g'ri.
   */
  completedTtlMs?: number;
  /**
   * `failed` kalit qayta egallanadi (yosh sharti YO'Q) — handler qayta urinadi.
   * Tranzient xato (masalan identity/order timeout) deterministik kalitni
   * zaharlab, keyingi haqiqiy urinishni ham abadiy rad etmasligi uchun.
   */
  reclaimFailed?: boolean;
}

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
   *
   * `opts` (ixtiyoriy, `TryAcquireOptions`):
   * - `completedTtlMs` — TTL'dan eski `completed` kalit xuddi shu uslubda
   *   (himoyalangan UPDATE) qayta egallanib 'new' qaytadi;
   * - `reclaimFailed` — `failed` kalit qayta egallanib 'new' qaytadi.
   * Poygada yutqazgan chaqiruvchi (affected=0) avvalgidek 'cached'/'failed' oladi.
   */
  async tryAcquire<T>(
    key: string,
    pattern: string,
    leaseMs: number = DEFAULT_IDEMPOTENCY_LEASE_MS,
    opts?: TryAcquireOptions,
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
      const completedTtlMs = opts?.completedTtlMs;
      if (completedTtlMs !== undefined) {
        // ⚠️ Yosh `completed_at` bo'yicha (javob keshlangan payt), u bo'lmasa
        // `created_at` bo'yicha — SQL guard'dagi COALESCE bilan AYNAN bir xil.
        const finishedAt = existing.completed_at ?? existing.created_at;
        const cutoff = new Date(Date.now() - completedTtlMs);
        if (finishedAt instanceof Date && finishedAt < cutoff) {
          const affected = await this.reclaimFinished(key, 'completed', cutoff);
          if (affected > 0) {
            this.logger.warn(
              `Reclaimed expired completed idempotency key=${key} (pattern=${pattern}, completedTtlMs=${completedTtlMs})`,
            );
            return { status: 'new' };
          }
          // affected=0 — boshqa chaqiruvchi poygada yutdi (yoki qator o'zgardi):
          // yangi ish BOSHLANMAYDI, eski kesh qaytadi (dublikat yaratilmaydi).
        }
      }
      return { status: 'cached', response: existing.response as T };
    }
    if (existing.status === 'failed') {
      if (opts?.reclaimFailed) {
        const affected = await this.reclaimFinished(key, 'failed');
        if (affected > 0) {
          this.logger.warn(
            `Reclaimed failed idempotency key=${key} for retry (pattern=${pattern})`,
          );
          return { status: 'new' };
        }
        // affected=0 — poygada yutqazdik: avvalgidek 'failed' qaytadi.
      }
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

  /**
   * Tugagan (`completed`/`failed`) kalitni atomik qayta egallash — yuqoridagi
   * stale-lease reclaim uslubida. UPDATE `status` (va `completed` uchun
   * `COALESCE(completed_at, created_at) < :cutoff`) bilan himoyalangan, shuning
   * uchun parallel chaqiruvchilardan FAQAT bittasi `affected=1` oladi.
   *
   * Qator `in_progress` ga qaytadi, `created_at=now()` (yangi lease), eski
   * `response`/`error`/`completed_at` tozalanadi — aks holda yangi ish yiqilsa
   * ham eski javob "tayyor" bo'lib ko'rinib qolardi.
   */
  private async reclaimFinished(
    key: string,
    fromStatus: 'completed' | 'failed',
    cutoff?: Date,
  ): Promise<number> {
    const query = this.repo
      .createQueryBuilder()
      .update(IdempotencyKey)
      .set({
        status: 'in_progress',
        created_at: () => 'now()',
        // jsonb `unknown` ustunlar — TypeORM tipi `null` ni qabul qilmaydi,
        // shuning uchun xom SQL NULL yoziladi (natija bir xil: `response = NULL`).
        response: () => 'NULL',
        error: () => 'NULL',
        completed_at: null,
      })
      .where('key = :key', { key })
      .andWhere('status = :status', { status: fromStatus });
    if (cutoff) {
      query.andWhere('COALESCE(completed_at, created_at) < :cutoff', {
        cutoff,
      });
    }
    const result = await query.execute();
    return result.affected ?? 0;
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

  /**
   * Faqat bitta `pattern` ning `olderThanMs` dan eski kalitlarini o'chiradi va
   * o'chirilganlar sonini qaytaradi.
   *
   * ⚠️ PII: `order.ai_resolve_preview` javobi (mijoz ismi, telefoni, manzili)
   * `response` jsonb ichida keshlanadi. Umumiy `prune()` boshqa pattern'larning
   * (masalan `order.create`) keshini ham o'chirib yuborardi — shu sababli PII
   * saqlovchi pattern alohida, qisqa muddat (1 soat) bilan tozalanadi.
   */
  async prunePattern(pattern: string, olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where('pattern = :pattern', { pattern })
      .andWhere('created_at < :cutoff', { cutoff })
      .execute();
    return result.affected ?? 0;
  }
}
