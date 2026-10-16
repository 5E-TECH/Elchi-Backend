import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

/** Bitta chat navbatidagi ishlar chegarasi (BeePost `MAX_QUEUE = 12`). */
export const CHAT_QUEUE_MAX = 12;
/** Bir vaqtda bajariladigan chatlar (har biri DB qulf ulanishini ushlaydi). */
export const CHAT_CONCURRENCY = 4;
/** Boshqa replika qulfni ushlab tursa — ko'pi bilan shuncha kutiladi. */
const LOCK_WAIT = '15s';

export type SequenceResult = 'done' | 'dropped' | 'failed';

/**
 * (GL2GgtEc #3) Chat bo'yicha KETMA-KETLIK (BeePost `enqueueAi` naqshi),
 * lekin replikalararo:
 *  - replika ichida — chat bo'yicha promise zanjiri (tartib saqlanadi, bitta
 *    chatning sekin ishi boshqalarni to'smaydi; ish xatosi zanjirni BUZMAYDI);
 *  - replikalar orasida — Postgres advisory qulfi (`chat_id` bo'yicha,
 *    tranzaksiya oxirida o'zi bo'shaydi). Ikkinchi replika o'sha chatning
 *    ishini birinchisi tugaguncha kutadi.
 * Navbat to'lsa (12) ish JIM tashlanadi — javob yuborish limitni
 * amplifikatorga aylantirardi.
 */
export class ChatSequencer {
  private readonly logger = new Logger(ChatSequencer.name);
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly dataSource?: DataSource | null) {}

  run(chatId: string, task: () => Promise<void>): Promise<SequenceResult> {
    const count = this.pending.get(chatId) ?? 0;
    if (count >= CHAT_QUEUE_MAX) {
      this.logger.warn(
        `Chat navbati to'la (${CHAT_QUEUE_MAX}) — update jim tashlandi`,
      );
      return Promise.resolve('dropped');
    }
    this.pending.set(chatId, count + 1);
    let outcome: SequenceResult = 'done';
    const previous = this.tails.get(chatId) ?? Promise.resolve();
    const next = previous
      .then(() => this.withSlot(() => this.withChatLock(chatId, task)))
      .catch((error: unknown) => {
        outcome = 'failed';
        this.logger.error(
          `Chat navbatidagi ish xato berdi: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        const left = (this.pending.get(chatId) ?? 1) - 1;
        if (left <= 0) {
          this.pending.delete(chatId);
          if (this.tails.get(chatId) === next) this.tails.delete(chatId);
        } else {
          this.pending.set(chatId, left);
        }
      });
    this.tails.set(chatId, next);
    return next.then(() => outcome);
  }

  /** Shutdown: navbatdagi ishlarni ko'pi bilan `timeoutMs` kutadi. */
  async drain(timeoutMs: number): Promise<boolean> {
    const pending = [...this.tails.values()];
    if (!pending.length) return true;
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const drained = await Promise.race([
      Promise.allSettled(pending).then(() => true as const),
      cap,
    ]);
    if (timer) clearTimeout(timer);
    return drained;
  }

  get size(): number {
    return this.tails.size;
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= CHAT_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }

  private async withChatLock(
    chatId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    if (!this.dataSource) return task();
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      await runner.query(`SET LOCAL lock_timeout = '${LOCK_WAIT}'`);
      await runner.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`tg-chat:${chatId}`],
      );
      try {
        await task();
      } finally {
        await runner.commitTransaction().catch(() => undefined);
      }
    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction().catch(() => undefined);
      }
      await runner.release();
    }
  }
}
