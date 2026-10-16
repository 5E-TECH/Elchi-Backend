import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { of } from 'rxjs';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationServiceService } from './notification-service.service';
import { RecipientDirectoryService } from './recipients/recipient-directory.service';

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  };
});

/**
 * 3SeRYFqx — bildirishnoma API: xato muvaffaqiyat sifatida qaytmaydi va
 * mavjud bo'lmagan qabul qiluvchiga yetim qator yozilmaydi.
 * HTTP darajasi (kod = tana statusCode) —
 * apps/api-gateway/src/notification-gateway.status-code.3SeRYFqx.spec.ts.
 */
const SECRET = 'group_token-0123456789abcdef0123456789abcdef';

const rpcErrorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
  }
  throw new Error('RpcException kutilgan edi');
};

beforeEach(() => {
  rmqSendMock.mockReset();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const makeTelegramService = (
  market: Record<string, unknown> | null = { id: '5', name: 'Beshinchi' },
) => {
  const rows: Array<Record<string, unknown>> = [];
  const repo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        rows.find((row) =>
          Object.entries(where).every(([key, value]) =>
            key === 'isDeleted'
              ? row.isDeleted === value
              : String(row[key]) === String(value),
          ),
        ) ?? null,
      ),
    ),
    find: jest.fn(),
    findAndCount: jest.fn(),
    save: jest.fn((value: Record<string, unknown>) =>
      Promise.resolve({ id: '41', ...value }),
    ),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
  };
  rmqSendMock.mockImplementation(
    (_client: unknown, pattern: { cmd: string }, payload: any) => {
      if (pattern.cmd === 'identity.market.find_by_tg_token') {
        return payload?.market_tg_token === SECRET
          ? Promise.resolve({ success: true, data: { id: '5' } })
          : Promise.reject(new Error('not found'));
      }
      if (pattern.cmd === 'identity.market.find_by_id') {
        return Promise.resolve(market ? { success: true, data: market } : null);
      }
      return Promise.resolve(null);
    },
  );
  const service = new NotificationServiceService(
    repo as never,
    { get: jest.fn(() => 'ENV_TOKEN') } as never,
    {} as never,
    {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    } as never,
  );
  return { service, repo, rows };
};

describe('3SeRYFqx #1 — POST /notifications/connect-by-token (HTTP yo‘li)', () => {
  it('noto‘g‘ri format token → RpcException 400 (statusCode + message), 201 + { message } EMAS', async () => {
    const { service, repo } = makeTelegramService();
    const err = await rpcErrorOf(
      service.connectGroupByToken('totally-not-a-token', '-100999'),
    );
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('Token formati');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('mavjud bo‘lmagan token → 400; market topilmadi → 404', async () => {
    const unknown = makeTelegramService();
    const err = await rpcErrorOf(
      unknown.service.connectGroupByToken(
        'group_token-' + 'f'.repeat(32),
        '-100999',
      ),
    );
    expect(err).toEqual({
      statusCode: 400,
      message: 'Token topilmadi yoki yaroqsiz',
    });

    const noMarket = makeTelegramService(null);
    const missing = await rpcErrorOf(
      noMarket.service.connectGroupByToken(SECRET, '-100999'),
    );
    expect(missing).toEqual({ statusCode: 404, message: 'Market topilmadi' });
  });

  it('group_id yo‘q yoki noto‘g‘ri → 400, hech narsa saqlanmaydi', async () => {
    const { service, repo } = makeTelegramService();
    for (const groupId of ['', 'abc', undefined]) {
      const err = await rpcErrorOf(
        service.connectGroupByToken(SECRET, groupId as unknown as string),
      );
      expect(err.statusCode).toBe(400);
    }
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('kutilmagan (DB) xato → 500 umumiy xabar, xom matn mijozga chiqmaydi', async () => {
    const { service, repo } = makeTelegramService();
    repo.findOne.mockRejectedValue(
      new Error('relation "telegram_markets" does not exist'),
    );
    const err = await rpcErrorOf(
      service.connectGroupByToken(SECRET, '-100999'),
    );
    expect(err.statusCode).toBe(500);
    expect(err.message).not.toContain('relation');
  });

  it('muvaffaqiyat → standart konvert { statusCode: 201, data }', async () => {
    const { service } = makeTelegramService();
    const res: any = await service.connectGroupByToken(SECRET, ' -100777 ');
    expect(res.statusCode).toBe(201);
    expect(res.data).toEqual(
      expect.objectContaining({ market_id: '5', group_id: '-100777' }),
    );
  });

  it('bot yo‘li o‘zgarmagan: connectGroupByTokenText xatoda guruhga { message } qaytaradi', async () => {
    const { service } = makeTelegramService();
    const res = await service.connectGroupByTokenText(
      'totally-not-a-token',
      '-100999',
    );
    expect(res).toEqual({ message: expect.stringContaining('Token formati') });
  });

  it('RMQ notification.telegram.connect_by_token → connectGroupByToken (bot metodi emas)', () => {
    const src = readFileSync(
      join(__dirname, 'notification-service.controller.ts'),
      'utf8',
    );
    const handler = src.slice(
      src.indexOf("cmd: 'notification.telegram.connect_by_token'"),
      src.indexOf("cmd: 'notification.telegram.delete'"),
    );
    expect(handler).toContain('notificationService.connectGroupByToken(');
    expect(handler).not.toContain(
      'notificationService.connectGroupByTokenText(',
    );
  });
});

describe('3SeRYFqx #2 — POST /notifications/send: hammasi yiqilsa 2xx EMAS', () => {
  const groups = [
    {
      id: '1',
      market_id: '13',
      group_type: 'create',
      group_id: '-1001',
      token: null,
    },
    {
      id: '2',
      market_id: '13',
      group_type: 'cancel',
      group_id: '-1002',
      token: null,
    },
  ];
  const telegram = (okFor: string[]) =>
    jest.fn((url: string, init: { body: string }) => {
      const chat = String(JSON.parse(init.body).chat_id);
      return Promise.resolve(
        okFor.includes(chat)
          ? { ok: true, json: () => Promise.resolve({ ok: true, result: {} }) }
          : {
              ok: false,
              status: 400,
              json: () =>
                Promise.resolve({ ok: false, description: 'chat not found' }),
            },
      );
    });
  const run = async (okFor: string[]) => {
    const { service, repo } = makeTelegramService();
    repo.find.mockResolvedValue(groups);
    (global as any).fetch = telegram(okFor);
    return (await service.sendNotification({
      message: 'salom',
      market_id: '13',
    } as any)) as any;
  };

  it('hech biri ketmadi → statusCode 502, natijalar tanada saqlangan', async () => {
    const res = await run([]);
    expect(res.statusCode).toBe(502);
    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.data).toEqual(
      expect.objectContaining({ total: 2, success: 0, failed: 2 }),
    );
    expect(res.data.results[0].error).toBe('chat not found');
  });

  it('qisman → 207 (Multi-Status); hammasi ketdi → 200', async () => {
    const partial = await run(['-1001']);
    expect(partial.statusCode).toBe(207);
    expect(partial.data).toEqual(
      expect.objectContaining({ success: 1, failed: 1 }),
    );
    const all = await run(['-1001', '-1002']);
    expect(all.statusCode).toBe(200);
    expect(all.message).toBe('Notification send result');
  });
});

const makeInbox = (known: string[]) => {
  const store = new Map() as Map<string, Record<string, any>>;
  let nextId = 100;
  const valuesOf = (op: any): string[] => (op?.value ?? op ?? []).map(String);
  const txRepo = {
    create: jest.fn((v: any) => ({ ...v })),
    insert: jest.fn((rows: any[]) =>
      Promise.resolve({
        identifiers: rows.map((row) => {
          const id = String(nextId++);
          store.set(id, { id, ...row });
          return { id };
        }),
      }),
    ),
    update: jest.fn(),
    find: jest.fn(({ where }: any) =>
      Promise.resolve(
        where.id
          ? [...store.values()].filter((r) => valuesOf(where.id).includes(r.id))
          : [],
      ),
    ),
  };
  const qb: any = {};
  for (const m of ['update', 'set', 'setParameter', 'whereInIds']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.execute = jest.fn().mockResolvedValue({ affected: 0 });
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    manager: {
      transaction: jest.fn((work: (m: unknown) => Promise<unknown>) =>
        work({ getRepository: () => txRepo }),
      ),
    },
  };
  rmqSendMock.mockImplementation(
    (_client: unknown, pattern: { cmd: string }, payload: any) => {
      if (pattern.cmd === 'identity.user.contacts_by_ids') {
        const ids = (payload?.ids ?? []) as string[];
        return Promise.resolve({
          statusCode: 200,
          data: ids
            .filter((id) => known.includes(id))
            .map((id) => ({
              id,
              phone_number: '+998901112233',
              role: 'market',
            })),
        });
      }
      if (pattern.cmd === 'identity.audience.resolve') {
        return Promise.resolve({
          data: { items: [{ id: '7', role: 'courier' }], next_after_id: null },
        });
      }
      return Promise.resolve(null);
    },
  );
  const directory = new RecipientDirectoryService({} as never);
  const existing = jest.spyOn(directory, 'existing');
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new NotificationInboxService(
    repo as never,
    { send: jest.fn() } as never,
    { emit: jest.fn(() => of(null)) } as never,
    { sendNotification: jest.fn() } as never,
    activityLog as never,
    { enqueue: jest.fn() } as never,
    { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    directory,
  );
  return { service, store, txRepo, activityLog, existing };
};

describe('3SeRYFqx #3 — mavjud bo‘lmagan recipient_id: yetim qator YO‘Q', () => {
  const dto = (extra: Record<string, unknown>) =>
    ({ type: 'system.manual', title: 'Xabar', ...extra }) as any;

  it('yagona mavjud bo‘lmagan recipient_id → 400, qator va audit YOZILMAYDI', async () => {
    const h = makeInbox(['42']);
    const err = await rpcErrorOf(
      h.service.dispatch(dto({ recipient_id: '99999999' })),
    );
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('99999999');
    expect(h.txRepo.insert).not.toHaveBeenCalled();
    expect(h.activityLog.log).not.toHaveBeenCalled();
    expect(h.store.size).toBe(0);
  });

  it('aralash: topilmaganlar javobda unresolved, qator FAQAT mavjudlarga', async () => {
    const h = makeInbox(['42', '43']);
    const res: any = await h.service.dispatch(
      dto({ recipient_ids: ['42', '99999999', '43', '88888888'] }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.data.dispatched).toBe(2);
    expect(res.data.unresolved).toEqual(['99999999', '88888888']);
    expect([...h.store.values()].map((r) => r.recipient_id).sort()).toEqual([
      '42',
      '43',
    ]);
    // Bitta identity so'rovi (sikl emas), telefon javobga chiqmaydi.
    expect(h.existing).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res)).not.toContain('998901112233');
    expect(h.activityLog.log.mock.calls[0][0].metadata.unresolved_count).toBe(
      2,
    );
  });

  it('hammasi topildi → unresolved bo‘sh ro‘yxat', async () => {
    const h = makeInbox(['42']);
    const res: any = await h.service.dispatch(dto({ recipient_id: '42' }));
    expect(res.data.unresolved).toEqual([]);
    expect(h.store.size).toBe(1);
  });

  it('identity javob bermasa → 502 (fail-closed), tekshiruvsiz yozilmaydi', async () => {
    const h = makeInbox(['42']);
    rmqSendMock.mockRejectedValue(new Error('identity timeout'));
    const err = await rpcErrorOf(
      h.service.dispatch(dto({ recipient_id: '42' })),
    );
    expect(err.statusCode).toBe(502);
    expect(h.txRepo.insert).not.toHaveBeenCalled();
  });

  it('rol bo‘yicha (identity auditoriyasidan) topilganlar qayta tekshirilmaydi', async () => {
    const h = makeInbox([]);
    const res: any = await h.service.dispatch(dto({ roles: ['courier'] }));
    expect(res.data.dispatched).toBe(1);
    expect(h.existing).not.toHaveBeenCalled();
    expect(res.data.unresolved).toEqual([]);
  });

  it('RecipientDirectoryService: identity.user.contacts_by_ids (rol filtrsiz, o‘chirilganlarsiz), 1000 tadan bo‘lak', async () => {
    makeInbox(['1']);
    const directory = new RecipientDirectoryService({} as never);
    const ids = Array.from({ length: 2500 }, (_, i) => String(i + 1));
    const found = await directory.existing(ids);
    expect([...found]).toEqual(['1']);
    const calls = rmqSendMock.mock.calls.filter(
      ([, pattern]) => pattern.cmd === 'identity.user.contacts_by_ids',
    );
    expect(calls.map(([, , payload]) => payload.ids.length)).toEqual([
      1000, 1000, 500,
    ]);
  });
});
