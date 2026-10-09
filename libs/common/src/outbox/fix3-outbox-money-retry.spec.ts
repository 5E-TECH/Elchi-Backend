jest.mock('../sentry/sentry.helper', () => ({
  captureException: jest.fn(),
}));

import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import type { FindOperator } from 'typeorm';
import { captureException } from '../sentry/sentry.helper';
import { OutboxEvent } from './outbox-event.entity';
import { OutboxPublisher } from './outbox.publisher';
import { OutboxService } from './outbox.service';
import {
  DEFAULT_PERSISTENT_OUTBOX_PATTERNS,
  isPersistentOutboxPattern,
} from './tokens';
import type { OutboxOptions } from './tokens';

/**
 * Audit M8 — pul hodisalari maqsad servis uzoq ishlamay tursa ham TASHLAB
 * YUBORILMAYDI. Ilgari har qanday hodisa 10 urinishdan (~4-5 daqiqa) keyin
 * `failed` (poison) bo'lardi va qayta o'ynash yo'li yo'q edi: kassa ko'chgan,
 * daftar esa hech qachon yetib olmasdi.
 */

type StoredEvent = Pick<
  OutboxEvent,
  'id' | 'target' | 'pattern' | 'payload' | 'status' | 'attempts'
> & {
  last_error: string | null;
  scheduled_at: Date;
  published_at: Date | null;
};

function makeEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: '1',
    target: 'FINANCE',
    pattern: 'finance.cashbox.update_balance',
    payload: { request_id: 'r1' },
    status: 'pending',
    attempts: 0,
    last_error: null,
    scheduled_at: new Date(0),
    published_at: null,
    ...overrides,
  };
}

/** Xotiradagi `outbox_events` — OutboxService'ning haqiqiy kodi ishlaydi. */
function makeOutbox(events: StoredEvent[]) {
  const store = events.map((event) => ({ ...event }));
  const updateQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 3 }),
  };
  const repo = {
    findOne: jest.fn((opts: { where: { id: string } }) =>
      Promise.resolve(store.find((row) => row.id === opts.where.id) ?? null),
    ),
    update: jest.fn((criteria: { id: string }, patch: Partial<StoredEvent>) => {
      const row = store.find((item) => item.id === criteria.id);
      if (row) Object.assign(row, patch);
      return Promise.resolve({ affected: row ? 1 : 0 });
    }),
    find: jest.fn(() =>
      Promise.resolve(store.filter((row) => row.status === 'pending')),
    ),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(() => updateQb),
  };
  const service = new OutboxService(repo as never);
  return { service, repo, store, updateQb };
}

function makePublisher(
  outbox: OutboxService,
  clients: Record<string, { send: jest.Mock }>,
  options?: OutboxOptions,
) {
  const publisher = new OutboxPublisher(
    {} as ModuleRef,
    outbox,
    Object.keys(clients),
    options,
  );
  const internals = publisher as unknown as {
    clients: Map<string, unknown>;
    tick: () => Promise<void>;
    checkFailedEvents: () => Promise<void>;
  };
  for (const [target, client] of Object.entries(clients)) {
    internals.clients.set(target, client);
  }
  return internals;
}

const failingClient = () => ({
  send: jest.fn(() => throwError(() => new Error('Timeout has occurred'))),
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('isPersistentOutboxPattern — pul hodisalari ro`yxati', () => {
  it.each([
    'finance.cashbox.update_balance',
    'finance.financial_balance.record',
    'finance.operator.earning.record',
    'finance.operator.earning.remove',
    'order.settlement.advance',
  ])('%s — doimiy (poison qilinmaydi)', (pattern) => {
    expect(isPersistentOutboxPattern(pattern)).toBe(true);
  });

  it.each([
    'search.index.upsert',
    'search.index.remove',
    'order.settlement.advance_extra',
    'financex.cashbox',
    '',
  ])('%p — oddiy hodisa', (pattern) => {
    expect(isPersistentOutboxPattern(pattern)).toBe(false);
  });

  it('sukutdagi ro`yxat muzlatilgan va aynan finance.* + advance', () => {
    expect(DEFAULT_PERSISTENT_OUTBOX_PATTERNS).toEqual([
      'finance.*',
      'order.settlement.advance',
    ]);
    expect(Object.isFrozen(DEFAULT_PERSISTENT_OUTBOX_PATTERNS)).toBe(true);
  });

  it('bo`sh ro`yxat — hech narsa doimiy emas (eski xatti-harakat)', () => {
    expect(
      isPersistentOutboxPattern('finance.cashbox.update_balance', []),
    ).toBe(false);
  });
});

describe('OutboxService.markFailed — maxAttempts', () => {
  it('sukut (10): 10-urinishda failed bo`ladi — avvalgidek', async () => {
    const { service, store } = makeOutbox([makeEvent({ attempts: 9 })]);

    await service.markFailed('1', 'boom', 60_000);

    expect(store[0].status).toBe('failed');
    expect(store[0].attempts).toBe(10);
    expect(store[0].last_error).toBe('boom');
  });

  it('Infinity: 10 000-urinishda ham pending, keyingi muddat surildi', async () => {
    const { service, store } = makeOutbox([makeEvent({ attempts: 9_999 })]);
    const before = Date.now();

    await service.markFailed('1', 'boom', 60_000, Number.POSITIVE_INFINITY);

    expect(store[0].status).toBe('pending');
    expect(store[0].attempts).toBe(10_000);
    expect(store[0].scheduled_at.getTime()).toBeGreaterThanOrEqual(
      before + 60_000,
    );
  });
});

describe('OutboxPublisher — pul hodisasi maqsad ishlamasa ham tashlanmaydi', () => {
  it('⭐ finance.cashbox.update_balance 10-urinishda ham FAILED bo`lmaydi, 60 s da qayta', async () => {
    const { service, store } = makeOutbox([makeEvent({ attempts: 9 })]);
    const publisher = makePublisher(service, { FINANCE: failingClient() });
    const before = Date.now();

    await publisher.tick();

    expect(store[0].status).toBe('pending');
    expect(store[0].attempts).toBe(10);
    expect(store[0].last_error).toBe('Timeout has occurred');
    expect(store[0].scheduled_at.getTime()).toBeGreaterThanOrEqual(
      before + 60_000,
    );
  });

  it('⭐ order.settlement.advance (finance → order) ham doimiy', async () => {
    const { service, store } = makeOutbox([
      makeEvent({
        target: 'ORDER',
        pattern: 'order.settlement.advance',
        attempts: 25,
      }),
    ]);
    const publisher = makePublisher(service, { ORDER: failingClient() });

    await publisher.tick();

    expect(store[0].status).toBe('pending');
    expect(store[0].attempts).toBe(26);
  });

  it('oddiy hodisa (search) 10-urinishda avvalgidek FAILED', async () => {
    const { service, store } = makeOutbox([
      makeEvent({
        target: 'SEARCH',
        pattern: 'search.index.upsert',
        attempts: 9,
      }),
    ]);
    const publisher = makePublisher(service, { SEARCH: failingClient() });

    await publisher.tick();

    expect(store[0].status).toBe('failed');
    expect(store[0].attempts).toBe(10);
  });

  it('backoff 2^n s, yuqori chegara 60 s (katta n da ham)', async () => {
    const { service, repo } = makeOutbox([
      makeEvent({ id: '1', attempts: 2 }),
      makeEvent({ id: '2', attempts: 5_000 }),
    ]);
    const publisher = makePublisher(service, { FINANCE: failingClient() });
    const before = Date.now();

    await publisher.tick();

    const scheduled = (id: string) =>
      (
        repo.update.mock.calls.find(
          ([criteria]) => (criteria as { id: string }).id === id,
        )?.[1] as { scheduled_at: Date }
      ).scheduled_at.getTime() - before;
    expect(scheduled('1')).toBeGreaterThanOrEqual(4_000);
    expect(scheduled('1')).toBeLessThan(4_000 + 1_000);
    expect(scheduled('2')).toBeGreaterThanOrEqual(60_000);
    expect(scheduled('2')).toBeLessThan(60_000 + 1_000);
  });

  it('client ro`yxatdan o`tmagan pul hodisasi ham poison qilinmaydi', async () => {
    const { service, store } = makeOutbox([
      makeEvent({ target: 'FINANCE', attempts: 9 }),
    ]);
    const publisher = makePublisher(service, {});

    await publisher.tick();

    expect(store[0].status).toBe('pending');
    expect(store[0].last_error).toContain(
      "No client registered for target 'FINANCE'",
    );
  });

  it('client ro`yxatdan o`tmagan oddiy hodisa — avvalgidek failed', async () => {
    const { service, store } = makeOutbox([
      makeEvent({
        target: 'SEARCH',
        pattern: 'search.index.remove',
        attempts: 9,
      }),
    ]);
    const publisher = makePublisher(service, {});

    await publisher.tick();

    expect(store[0].status).toBe('failed');
  });

  it('persistentPatterns: [] — eski xatti-harakat (finance ham 10 da failed)', async () => {
    const { service, store } = makeOutbox([makeEvent({ attempts: 9 })]);
    const publisher = makePublisher(
      service,
      { FINANCE: failingClient() },
      { persistentPatterns: [] },
    );

    await publisher.tick();

    expect(store[0].status).toBe('failed');
  });

  it('maxAttempts opsiyasi oddiy hodisa chegarasini o`zgartiradi', async () => {
    const { service, store } = makeOutbox([
      makeEvent({
        target: 'SEARCH',
        pattern: 'search.index.upsert',
        attempts: 9,
      }),
    ]);
    const publisher = makePublisher(
      service,
      { SEARCH: failingClient() },
      { maxAttempts: 20 },
    );

    await publisher.tick();

    expect(store[0].status).toBe('pending');
    expect(store[0].attempts).toBe(10);
  });

  it('muvaffaqiyatli yuborish — published (o`zgarishsiz)', async () => {
    const { service, store } = makeOutbox([makeEvent({ attempts: 12 })]);
    const client = { send: jest.fn(() => of({ ok: true })) };
    const publisher = makePublisher(service, { FINANCE: client });

    await publisher.tick();

    expect(client.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.update_balance' },
      { request_id: 'r1' },
    );
    expect(store[0].status).toBe('published');
    expect(store[0].last_error).toBeNull();
  });
});

describe('OutboxPublisher — STUCK ogohlantirishi', () => {
  it('kamida 10 urinishli pending hodisa — error log; Sentry faqat soni o`zgarganda', async () => {
    const { service, repo } = makeOutbox([]);
    // countFailed → 0, countStuckPending → 2, 2, 3
    repo.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(3);
    const publisher = makePublisher(service, {});
    const errorSpy = jest.spyOn(Logger.prototype, 'error');

    await publisher.checkFailedEvents();
    await publisher.checkFailedEvents();
    await publisher.checkFailedEvents();

    const stuckLogs = errorSpy.mock.calls.filter((call) =>
      String(call[0]).includes('STUCK pending'),
    );
    expect(stuckLogs).toHaveLength(3);
    const sentry = jest.mocked(captureException);
    expect(sentry).toHaveBeenCalledTimes(2);
    expect(sentry.mock.calls[0][1]).toEqual({ outbox_stuck_count: 2 });
    expect(sentry.mock.calls[1][1]).toEqual({ outbox_stuck_count: 3 });

    // countStuckPending: status pending + attempts >= 10
    const stuckWhere = (repo.count.mock.calls[1] as unknown[])[0] as {
      where: { status: string; attempts: FindOperator<number> };
    };
    expect(stuckWhere.where.status).toBe('pending');
    expect(stuckWhere.where.attempts.type).toBe('moreThanOrEqual');
    expect(stuckWhere.where.attempts.value).toBe(10);
  });

  it('stuck tekshiruvi yiqilsa ham failed tekshiruvi buzilmaydi (xato yutiladi)', async () => {
    const { service, repo } = makeOutbox([]);
    repo.count
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('db down'));
    const publisher = makePublisher(service, {});

    await expect(publisher.checkFailedEvents()).resolves.toBeUndefined();
    expect(jest.mocked(captureException)).toHaveBeenCalledWith(
      expect.any(Error),
      { outbox_failed_count: 1 },
    );
  });
});

describe('OutboxPublisher — fire-and-forget FAILED hodisalari (OA16fdSq)', () => {
  it('bildirishnoma FAILED — Sentry "money/state stuck" EMAS, faqat WARN', async () => {
    const { service, repo } = makeOutbox([]);
    const failedQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
    };
    repo.createQueryBuilder.mockReturnValueOnce(failedQb as never);
    // countFailed(hammasi) → 3, countStuckPending → 0
    repo.count.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    const publisher = makePublisher(
      service,
      {},
      {
        fireAndForgetPatterns: ['notification.dispatch', 'notify.*'],
      },
    );
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    jest.mocked(captureException).mockClear();

    await publisher.checkFailedEvents();

    expect(failedQb.andWhere).toHaveBeenCalledWith('e.pattern <> :exclude_0', {
      exclude_0: 'notification.dispatch',
    });
    expect(failedQb.andWhere).toHaveBeenCalledWith(
      'e.pattern NOT LIKE :exclude_1',
      { exclude_1: 'notify.%' },
    );
    expect(jest.mocked(captureException)).not.toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes('3 FAILED best-effort'),
      ),
    ).toBe(true);
  });

  it('pul hodisasi FAILED bo`lsa — Sentry avvalgidek', async () => {
    const { service, repo } = makeOutbox([]);
    const failedQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(2),
    };
    repo.createQueryBuilder.mockReturnValueOnce(failedQb as never);
    repo.count.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const publisher = makePublisher(
      service,
      {},
      {
        fireAndForgetPatterns: ['notification.dispatch'],
      },
    );
    jest.mocked(captureException).mockClear();

    await publisher.checkFailedEvents();

    expect(jest.mocked(captureException)).toHaveBeenCalledWith(
      expect.any(Error),
      { outbox_failed_count: 2 },
    );
  });
});

describe('OutboxService.requeueFailed — operator replay', () => {
  it('faqat failed qatorlar, attempts 0, darhol navbatga; id va pattern filtri', async () => {
    const { service, updateQb } = makeOutbox([]);

    const affected = await service.requeueFailed({
      ids: [' 7 ', '9', ''],
      patterns: ['order.settlement.advance'],
    });

    expect(affected).toBe(3);
    expect(updateQb.update).toHaveBeenCalledWith(OutboxEvent);
    const patch = (updateQb.set.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(patch.status).toBe('pending');
    expect(patch.attempts).toBe(0);
    expect(typeof patch.scheduled_at).toBe('function');
    expect((patch.scheduled_at as () => string)()).toBe('NOW()');
    expect(updateQb.where).toHaveBeenCalledWith('status = :status', {
      status: 'failed',
    });
    expect(updateQb.andWhere).toHaveBeenCalledWith('id IN (:...ids)', {
      ids: ['7', '9'],
    });
    expect(updateQb.andWhere).toHaveBeenCalledWith(
      'pattern IN (:...patterns)',
      { patterns: ['order.settlement.advance'] },
    );
  });

  it('filtrsiz — barcha failed; bo`sh ro`yxatlar shart qo`shmaydi', async () => {
    const { service, updateQb } = makeOutbox([]);

    await service.requeueFailed({ ids: [], patterns: [] });

    expect(updateQb.where).toHaveBeenCalledTimes(1);
    expect(updateQb.andWhere).not.toHaveBeenCalled();
  });
});
