import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramSession } from '../entities/telegram-session.entity';

/** (UQlmQiGT #2) Sessiya TTL — 24 soat, har yozuvda suriladi. */
export const BOT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Optimistik yangilashda qayta urinishlar soni. */
const MAX_UPDATE_ATTEMPTS = 3;

export interface BotSession {
  chat_id: string;
  bot_slug: string;
  user_id: string | null;
  state: Record<string, unknown>;
  version: number;
  /** DB'da qator bormi (eskirgan bo'lsa ham) — INSERT/UPDATE tanlovi. */
  persisted: boolean;
}

/**
 * (UQlmQiGT DIQQAT) Sessiyaga PII YOZILMAYDI — faqat id'lar. Kalit nomlari
 * va telefon ko'rinishidagi qiymatlar rad etiladi, aks holda jadval ikkinchi,
 * RBAC'dan tashqaridagi PII omboriga aylanadi.
 */
const PII_KEY_RE =
  /^(?:name|full_?name|first_?name|last_?name|phone|phone_?number|tel|address|addr|customer_?(?:name|phone|address)|passport|contact)$/i;
const PHONE_VALUE_RE = /(?:\+\d{9,15}\b|(?<!\d)998\d{9}(?!\d))/;

export class SessionPiiError extends Error {
  constructor(path: string) {
    super(`telegram_sessions.state: PII yozish taqiqlangan (${path})`);
    this.name = 'SessionPiiError';
  }
}

export function assertNoPii(value: unknown, path = 'state'): void {
  if (typeof value === 'string') {
    if (PHONE_VALUE_RE.test(value)) throw new SessionPiiError(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPii(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (PII_KEY_RE.test(key)) throw new SessionPiiError(`${path}.${key}`);
      assertNoPii(item, `${path}.${key}`);
    }
  }
}

/**
 * (UQlmQiGT / Mvx0h1Fv #3) Chat holati Postgres'da. Xotiradagi Map YO'Q —
 * restart va ikkinchi replika holatni yo'qotmaydi.
 */
@Injectable()
export class BotSessionService {
  now: () => Date = () => new Date();

  constructor(
    @InjectRepository(TelegramSession)
    private readonly sessions: Repository<TelegramSession>,
  ) {}

  /**
   * Sessiyani o'qiydi. Yo'q yoki `expires_at` o'tgan bo'lsa — bo'sh
   * (`initial`) holat: eskirgan qator O'QILMAYDI.
   */
  async load(chatId: string, botSlug: string): Promise<BotSession> {
    const row = await this.sessions.findOne({ where: { chat_id: chatId } });
    const fresh =
      row &&
      (!row.expires_at || row.expires_at.getTime() > this.now().getTime());
    return {
      chat_id: chatId,
      bot_slug: botSlug,
      user_id: fresh ? (row.user_id ?? null) : null,
      state: fresh ? { ...(row.state ?? {}) } : {},
      version: row?.version ?? 0,
      persisted: Boolean(row),
    };
  }

  /**
   * Optimistik saqlash: faqat o'qilgan `version` hali o'zgarmagan bo'lsa.
   * `false` — boshqa update oldinroq yozdi (chaqiruvchi qayta o'qiydi).
   */
  async save(
    session: BotSession,
    next: { state: Record<string, unknown>; user_id?: string | null },
  ): Promise<boolean> {
    assertNoPii(next.state);
    const userId = next.user_id === undefined ? session.user_id : next.user_id;
    const expiresAt = new Date(this.now().getTime() + BOT_SESSION_TTL_MS);
    if (!session.persisted) {
      // Parallel birinchi yozuv: faqat bittasi qo'shadi, ikkinchisi `false`.
      const inserted: unknown[] = await this.sessions.query(
        `INSERT INTO "notification_schema"."telegram_sessions"
                ("chat_id", "bot_slug", "user_id", "state", "version", "updated_at", "expires_at")
         VALUES ($1, $2, $3, $4::jsonb, 1, $5, $6)
         ON CONFLICT ("chat_id") DO NOTHING
         RETURNING "chat_id"`,
        [
          session.chat_id,
          session.bot_slug,
          userId,
          JSON.stringify(next.state),
          this.now(),
          expiresAt,
        ],
      );
      return Array.isArray(inserted) && inserted.length > 0;
    }
    const updated = await this.sessions
      .createQueryBuilder()
      .update(TelegramSession)
      .set({
        state: next.state as never,
        user_id: userId,
        bot_slug: session.bot_slug,
        version: () => '"version" + 1',
        updated_at: this.now(),
        expires_at: expiresAt,
      })
      .where('chat_id = :chatId AND version = :version', {
        chatId: session.chat_id,
        version: session.version,
      })
      .execute();
    return (updated.affected ?? 0) > 0;
  }

  /**
   * O'qish → o'zgartirish → optimistik yozish; to'qnashuvda qayta o'qib
   * (eng ko'pi 3 marta) mutatorni yangi holatga qo'llaydi — parallel
   * update'lar bir-birining o'zgarishini yo'qotmaydi.
   */
  async update(
    chatId: string,
    botSlug: string,
    mutate: (session: BotSession) => {
      state: Record<string, unknown>;
      user_id?: string | null;
    },
  ): Promise<BotSession> {
    for (let attempt = 1; ; attempt += 1) {
      const session = await this.load(chatId, botSlug);
      const next = mutate(session);
      if (await this.save(session, next)) {
        return {
          ...session,
          state: next.state,
          user_id: next.user_id === undefined ? session.user_id : next.user_id,
          version: session.persisted ? session.version + 1 : 1,
          persisted: true,
        };
      }
      if (attempt >= MAX_UPDATE_ATTEMPTS) {
        throw new Error(
          `telegram_sessions: ${chatId} uchun optimistik yozish ${MAX_UPDATE_ATTEMPTS} marta to'qnashdi`,
        );
      }
    }
  }

  /** (UQlmQiGT #4) Polling zaxirasining `getUpdates` offset'i — shu jadvalda. */
  async getPollOffset(botSlug: string): Promise<number> {
    const row = await this.sessions.findOne({
      where: { chat_id: `poll:${botSlug}` },
    });
    const offset = Number(row?.state?.offset);
    return Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  }

  async setPollOffset(botSlug: string, offset: number): Promise<void> {
    await this.sessions.query(
      `INSERT INTO "notification_schema"."telegram_sessions"
              ("chat_id", "bot_slug", "state", "version", "updated_at", "expires_at")
       VALUES ($1, $2, jsonb_build_object('offset', $3::bigint), 1, now(), NULL)
       ON CONFLICT ("chat_id") DO UPDATE
          SET "state" = jsonb_build_object('offset', $3::bigint),
              "version" = "telegram_sessions"."version" + 1,
              "updated_at" = now()`,
      [`poll:${botSlug}`, botSlug, offset],
    );
  }
}
