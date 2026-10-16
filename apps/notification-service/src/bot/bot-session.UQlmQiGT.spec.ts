import { Logger } from '@nestjs/common';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BotActionsService } from './bot-actions.service';
import { BotMaintenanceService } from './bot-maintenance.service';
import {
  BOT_SESSION_TTL_MS,
  BotSessionService,
  SessionPiiError,
  assertNoPii,
} from './bot-session.service';
import { marketActor, makeRouter, textUpdate } from './testing/bot-kit-spec';

/**
 * UQlmQiGT — sessiya va bog'lanish holati Postgres'da (`telegram_sessions`),
 * xotiradagi Map'lar o'chirildi. Haqiqiy SQL — bot-core.pg.spec.ts; bu yerda
 * mantiq (repo soxta).
 */
const SRC = join(__dirname, '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return name.endsWith('.ts') && !name.endsWith('spec.ts') ? [path] : [];
  });

describe('UQlmQiGT — xotiradagi bog‘lanish yo‘q', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('⭐ order-bot `links = new Map` va xotiradagi chat→market bog‘lanishi qolmagan', () => {
    const offenders = walk(SRC)
      .filter((file) =>
        /links\s*=\s*new Map|LinkedMarket/.test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('⭐ "restart"dan keyin bog‘langan chat qayta ulashni SO‘RAMAYDI (aktor users.telegram_id dan)', async () => {
    // Birinchi jarayon.
    const before = makeRouter({ actor: marketActor('37') });
    await before.router.dispatch(
      'elchi',
      textUpdate('/start', { chatId: 9001 }),
    );
    // "Restart": butunlay yangi router; xotirada hech narsa yo'q.
    const after = makeRouter({ actor: marketActor('37') });
    await after.router.dispatch(
      'elchi',
      textUpdate('/start', { chatId: 9001 }),
    );

    const reply = (
      after.outbox.send.mock.calls[0] as unknown as [{ text: string }]
    )[0].text;
    expect(reply).toContain('market');
    expect(reply).not.toMatch(/ulash uchun|token/i);
    expect(after.actors.resolve).toHaveBeenCalledWith('9001');
  });
});

describe('UQlmQiGT — BotSessionService (mantiq)', () => {
  const makeRepo = (row: Record<string, unknown> | null) => {
    let current = row ? { ...row } : null;
    const executes: Array<{ version: number }> = [];
    let conflicts = 0;
    return {
      setConflicts: (n: number) => {
        conflicts = n;
      },
      executes,
      findOne: jest.fn(() => Promise.resolve(current ? { ...current } : null)),
      query: jest.fn(() => Promise.resolve([{ chat_id: 'x' }])),
      createQueryBuilder: () => {
        let params: { version: number } = { version: -1 };
        let values: Record<string, unknown> = {};
        const builder = {
          update: () => builder,
          set: (v: Record<string, unknown>) => {
            values = v;
            return builder;
          },
          where: (_sql: string, p: { version: number }) => {
            params = p;
            return builder;
          },
          execute: () => {
            executes.push(params);
            if (conflicts > 0) {
              conflicts -= 1;
              // Boshqa update oldinroq yozdi — versiya o'sdi.
              current = { ...current!, version: Number(current!.version) + 1 };
              return Promise.resolve({ affected: 0 });
            }
            current = {
              ...current!,
              state: values.state,
              version: Number(current!.version) + 1,
            };
            return Promise.resolve({ affected: 1 });
          },
        };
        return builder;
      },
    };
  };

  it('⭐ expires_at o‘tgan sessiya o‘qilmaydi — initial holat', async () => {
    const service = new BotSessionService(
      makeRepo({
        chat_id: '1',
        user_id: '37',
        state: { step: 'x' },
        version: 4,
        expires_at: new Date(Date.now() - 1000),
      }) as never,
    );
    const loaded = await service.load('1', 'elchi');
    expect(loaded.state).toEqual({});
    expect(loaded.user_id).toBeNull();
    expect(loaded.persisted).toBe(true);
    expect(loaded.version).toBe(4);
  });

  it('⭐ optimistik to‘qnashuv — qayta o‘qib mutatorni yangi holatga qo‘llaydi', async () => {
    const repo = makeRepo({
      chat_id: '1',
      user_id: null,
      state: { n: 1 },
      version: 1,
      expires_at: new Date(Date.now() + BOT_SESSION_TTL_MS),
    });
    repo.setConflicts(1);
    const service = new BotSessionService(repo as never);
    await service.update('1', 'elchi', (s) => ({
      state: { n: Number(s.state.n) + 1 },
    }));
    // Birinchi yozish version=1 bilan rad, ikkinchisi yangi versiya (2) bilan.
    expect(repo.executes.map((e) => e.version)).toEqual([1, 2]);
  });

  it('3 marta ketma-ket to‘qnashuv — aniq xato (jim yo‘qolmaydi)', async () => {
    const repo = makeRepo({
      chat_id: '1',
      user_id: null,
      state: {},
      version: 1,
      expires_at: null,
    });
    repo.setConflicts(5);
    await expect(
      new BotSessionService(repo as never).update('1', 'elchi', () => ({
        state: {},
      })),
    ).rejects.toThrow(/to'qnashdi/);
  });
});

describe('UQlmQiGT — state ichida PII yo‘q', () => {
  it.each([
    [{ phone: '901234567' }, 'phone kaliti'],
    [{ customer_name: 'Ali' }, 'customer_name kaliti'],
    [{ address: 'Toshkent' }, 'address kaliti'],
    [{ note: 'tel +998901234567' }, '+998 telefon qiymati'],
    [{ list: [{ x: '998901234567' }] }, 'ichma-ich 998… qiymati'],
    [{ contact: { a: 1 } }, 'contact kaliti'],
  ] as Array<[Record<string, unknown>, string]>)(
    '⭐ %j — rad etiladi (%s)',
    (state) => {
      expect(() => assertNoPii(state)).toThrow(SessionPiiError);
    },
  );

  it('id’lar va bayroqlar — ruxsat', () => {
    expect(() =>
      assertNoPii({
        order_ids: ['1251145', '101'],
        market_id: '37',
        chat_id: '-1001234567890',
        step: 'awaiting_proof',
        blocked_at: '2026-10-16T10:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('tugma payload’i ham PII’siz (BotActionsService)', async () => {
    const actions = new BotActionsService({ insert: jest.fn() } as never);
    await expect(
      actions.create({
        chatId: '1',
        action: 'x',
        payload: { phone_number: '+998901234567' },
      }),
    ).rejects.toThrow(SessionPiiError);
  });
});

describe('UQlmQiGT — TTL tozalash cron’i', () => {
  it('⭐ faqat expires_at o‘tganlar (NULL — tizim qatori — qoladi), soatlik cron', async () => {
    const queries: string[] = [];
    const db = {
      query: jest.fn((sql: string) => {
        queries.push(sql.replace(/\s+/g, ' '));
        return Promise.resolve([[], 0]);
      }),
    };
    await new BotMaintenanceService(db as never).prune();
    const sessionsSql = queries.find((sql) =>
      sql.includes('telegram_sessions'),
    )!;
    expect(sessionsSql).toContain(
      '"expires_at" IS NOT NULL AND "expires_at" < now()',
    );
    const outboxSql = queries.find((sql) => sql.includes('telegram_outbox'))!;
    expect(outboxSql).not.toContain("'pending'");
  });
});
