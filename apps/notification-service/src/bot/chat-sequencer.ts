import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

/** Bitta chat navbatidagi ishlar chegarasi (BeePost `MAX_QUEUE = 12`). */
export const CHAT_QUEUE_MAX = 12;
/** Bir vaqtda bajariladigan chatlar (BOT-3b: qulf DB ulanishini ushlamaydi). */
export const CHAT_CONCURRENCY = 4;
/** Boshqa replika qulfni ushlab tursa — ko'pi bilan shuncha kutiladi. */
export const LOCK_WAIT_MS = 15_000;
/** Lease muddati; ish davom etsa har uchdan birida uzaytiriladi. */
export const LOCK_LEASE_MS = 60_000;
const LOCK_POLL_MS = 200;

export type SequenceResult = 'done' | 'dropped' | 'failed';

/**
 * (GL2GgtEc #3) Chat bo'yicha KETMA-KETLIK (BeePost `enqueueAi` naqshi),
 * lekin replikalararo:
 *  - replika ichida — chat bo'yicha promise zanjiri (tartib saqlanadi, bitta
 *    chatning sekin ishi boshqalarni to'smaydi; ish xatosi zanjirni BUZMAYDI);
 *  - replikalar orasida — `telegram_chat_locks` lease qatori (BOT-3b; avval
 *    tranzaksiyadagi advisory qulf edi va ulanishni ushlardi). Ikkinchi
 *    replika o'sha chatning ishini birinchisi tugaguncha kutadi.
 * Navbat to'lsa (12) ish JIM tashlanadi — javob yuborish limitni
 * amplifikatorga aylantirardi.
 */
export class ChatSequencer {
  private readonly logger = new Logger(ChatSequencer.name);
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  /** Lease egasi — shu replika (har sequencer nusxasi alohida). */
  private readonly owner = randomUUID();

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

  /**
   * (BOT-3b) Replikalararo chat qulfi — LEASE qatori (`telegram_chat_locks`),
   * ochiq tranzaksiya EMAS: ish davomida pool ulanishi band qilinmaydi
   * (avval har faol chat advisory qulf uchun bitta ulanishni ishlov oxirigacha
   * ushlardi). Qulf `LOCK_LEASE_MS` ga olinadi va ish davom etsa har
   * uchdan birida uzaytiriladi; egasi yiqilsa muddat o'tgach o'zi bo'shaydi.
   * Boshqa replika ushlab tursa — `LOCK_WAIT_MS` gacha kutiladi, keyin xato.
   */
  private async withChatLock(
    chatId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    if (!this.dataSource) return task();
    const owner = this.owner;
    await this.acquireLease(chatId, owner);
    const heartbeat = setInterval(
      () => {
        void this.dataSource
          ?.query(
            `UPDATE "notification_schema"."telegram_chat_locks"
              SET "lock_until" = now() + ($3::int * interval '1 millisecond')
            WHERE "chat_id" = $1 AND "owner" = $2`,
            [chatId, owner, LOCK_LEASE_MS],
          )
          .catch(() => undefined);
      },
      Math.floor(LOCK_LEASE_MS / 3),
    );
    heartbeat.unref?.();
    try {
      await task();
    } finally {
      clearInterval(heartbeat);
      await this.dataSource
        .query(
          `DELETE FROM "notification_schema"."telegram_chat_locks"
            WHERE "chat_id" = $1 AND "owner" = $2`,
          [chatId, owner],
        )
        .catch((error: unknown) =>
          this.logger.warn(
            `chat qulfi bo'shatilmadi (muddat o'tgach o'zi bo'shaydi): ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }
  }

  private async acquireLease(chatId: string, owner: string): Promise<void> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const rows: unknown = await this.dataSource!.query(
        `INSERT INTO "notification_schema"."telegram_chat_locks"
                ("chat_id", "owner", "lock_until")
         VALUES ($1, $2, now() + ($3::int * interval '1 millisecond'))
         ON CONFLICT ("chat_id") DO UPDATE
            SET "owner" = EXCLUDED."owner", "lock_until" = EXCLUDED."lock_until"
          WHERE "telegram_chat_locks"."lock_until" < now()
         RETURNING "chat_id"`,
        [chatId, owner, LOCK_LEASE_MS],
      );
      if (Array.isArray(rows) && rows.length > 0) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `chat qulfi ${LOCK_WAIT_MS / 1000} s ichida olinmadi (boshqa replika band)`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}
