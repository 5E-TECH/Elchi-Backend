import { Logger } from '@nestjs/common';
import { RmqContext, RpcException } from '@nestjs/microservices';
import { QueryFailedError, Repository } from 'typeorm';
import { RmqService } from '../rmq/rmq.service';
import { IdempotencyKey, IdempotencyStatus } from './idempotency-key.entity';
import { AcquireResult, IdempotencyService } from './idempotency.service';
import {
  IdempotentExecuteOptions,
  executeIdempotent,
} from './idempotent-execute.helper';

const TEN_MIN = 10 * 60_000;
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

function makeRmq() {
  return { ack: jest.fn(), nack: jest.fn(), nackForError: jest.fn() };
}

function makeContext(): RmqContext {
  return { getPattern: () => 'order.create' } as unknown as RmqContext;
}

/** `tryAcquire` natijasi qo'lda beriladigan IdempotencyService mock'i. */
function makeIdem(acquire: AcquireResult) {
  return {
    tryAcquire: jest.fn().mockResolvedValue(acquire),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
}

function run<T>(
  rmq: ReturnType<typeof makeRmq>,
  idem: object,
  options: IdempotentExecuteOptions,
  handler: () => Promise<T> | T,
): Promise<T> {
  return executeIdempotent(
    rmq as unknown as RmqService,
    idem as IdempotencyService,
    makeContext(),
    options,
    handler,
  );
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('executeIdempotent — markReplay', () => {
  const opts: IdempotentExecuteOptions = {
    requestId: 'ai-dedupe:abc',
    pattern: 'order.create',
    markReplay: true,
  };

  it('adds idempotent_replay:true to a cached object response (handler NOT run, acked once)', async () => {
    const rmq = makeRmq();
    const idem = makeIdem({
      status: 'cached',
      response: { statusCode: 201, data: { id: '42' } },
    });
    const handler = jest.fn<unknown, []>();

    const result = await run(rmq, idem, opts, handler);

    expect(result).toEqual({
      statusCode: 201,
      data: { id: '42' },
      idempotent_replay: true,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(rmq.ack).toHaveBeenCalledTimes(1);
    expect(rmq.nack).not.toHaveBeenCalled();
    expect(rmq.nackForError).not.toHaveBeenCalled();
  });

  it('does NOT mark a freshly executed response, and caches it without the flag', async () => {
    const rmq = makeRmq();
    const idem = makeIdem({ status: 'new' });
    const created = { statusCode: 201, data: { id: '43' } };

    const result = await run(rmq, idem, opts, () => created);

    expect(result).toBe(created);
    expect(result).not.toHaveProperty('idempotent_replay');
    expect(idem.markCompleted).toHaveBeenCalledWith(
      'order.create:ai-dedupe:abc',
      created,
    );
    expect(rmq.ack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an array', [{ id: '1' }]],
    ['null', null],
    ['a string', 'ok'],
    ['a number', 7],
  ])('returns %s cached response unchanged', async (_label, response) => {
    const rmq = makeRmq();
    const idem = makeIdem({ status: 'cached', response });

    const result = await run(rmq, idem, opts, jest.fn<unknown, []>());

    expect(result).toEqual(response);
    expect(rmq.ack).toHaveBeenCalledTimes(1);
  });

  it('is unchanged without markReplay: the cached object is returned as-is', async () => {
    const rmq = makeRmq();
    const cached = { statusCode: 201, data: { id: '42' } };
    const idem = makeIdem({ status: 'cached', response: cached });

    const result = await run(
      rmq,
      idem,
      { requestId: 'r-1', pattern: 'order.create' },
      jest.fn<unknown, []>(),
    );

    expect(result).toBe(cached);
    expect(result).not.toHaveProperty('idempotent_replay');
  });

  it('keeps failed semantics with markReplay: ack + RpcException, handler NOT run', async () => {
    const rmq = makeRmq();
    const idem = makeIdem({
      status: 'failed',
      error: { statusCode: 400, message: 'bad' },
    });
    const handler = jest.fn<unknown, []>();

    await expect(run(rmq, idem, opts, handler)).rejects.toBeInstanceOf(
      RpcException,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(rmq.ack).toHaveBeenCalledTimes(1);
    expect(rmq.nack).not.toHaveBeenCalled();
  });

  it('in_progress with markReplay: nack(requeue) ONCE + RpcException({statusCode:409}) (C10 duplicate_in_progress)', async () => {
    const rmq = makeRmq();
    const idem = makeIdem({ status: 'in_progress' });
    const handler = jest.fn<unknown, []>();

    const error: unknown = await run(rmq, idem, opts, handler).then(
      () => {
        throw new Error('rad etilishi kerak edi');
      },
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toEqual({
      statusCode: 409,
      message:
        'Idempotency in_progress for order.create:ai-dedupe:abc, message requeued',
    });
    expect(handler).not.toHaveBeenCalled();
    // Xabar faqat BIR marta nack (requeue) qilinadi — ikkinchi ack/nack yo'q.
    expect(rmq.nack).toHaveBeenCalledTimes(1);
    expect(rmq.nack).toHaveBeenCalledWith(expect.anything(), {
      requeue: true,
    });
    expect(rmq.ack).not.toHaveBeenCalled();
    expect(rmq.nackForError).not.toHaveBeenCalled();
    expect(idem.markFailed).not.toHaveBeenCalled();
    expect(idem.markCompleted).not.toHaveBeenCalled();
  });

  it('in_progress WITHOUT markReplay is unchanged: nack(requeue) ONCE + plain Error (not RpcException)', async () => {
    const rmq = makeRmq();
    const idem = makeIdem({ status: 'in_progress' });
    const handler = jest.fn<unknown, []>();

    const error: unknown = await run(
      rmq,
      idem,
      { requestId: 'r-1', pattern: 'order.create' },
      handler,
    ).then(
      () => {
        throw new Error('rad etilishi kerak edi');
      },
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RpcException);
    expect((error as Error).message).toBe(
      'Idempotency in_progress for order.create:r-1, message requeued',
    );
    expect(handler).not.toHaveBeenCalled();
    expect(rmq.nack).toHaveBeenCalledTimes(1);
    expect(rmq.nack).toHaveBeenCalledWith(expect.anything(), {
      requeue: true,
    });
    expect(rmq.ack).not.toHaveBeenCalled();
    expect(rmq.nackForError).not.toHaveBeenCalled();
    expect(idem.markFailed).not.toHaveBeenCalled();
    expect(idem.markCompleted).not.toHaveBeenCalled();
  });

  it('keeps handler-error semantics: markFailed + nackForError + rethrow', async () => {
    const rmq = makeRmq();
    const idem = makeIdem({ status: 'new' });
    const boom = new RpcException({ statusCode: 400, message: 'bad' });

    await expect(
      run(rmq, idem, opts, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(idem.markFailed).toHaveBeenCalledWith('order.create:ai-dedupe:abc', {
      statusCode: 400,
      message: 'bad',
    });
    expect(rmq.nackForError).toHaveBeenCalledWith(expect.anything(), boom);
    expect(rmq.ack).not.toHaveBeenCalled();
  });
});

describe('executeIdempotent — tryAcquire options pass-through', () => {
  it('passes completedTtlMs and reclaimFailed to tryAcquire (default lease)', async () => {
    const rmq = makeRmq();
    const idem = makeIdem({ status: 'new' });

    await run(
      rmq,
      idem,
      {
        requestId: 'ai-dedupe:abc',
        pattern: 'order.create',
        completedTtlMs: TEN_MIN,
        reclaimFailed: true,
        markReplay: true,
      },
      () => ({ ok: true }),
    );

    expect(idem.tryAcquire).toHaveBeenCalledWith(
      'order.create:ai-dedupe:abc',
      'order.create',
      undefined,
      { completedTtlMs: TEN_MIN, reclaimFailed: true },
    );
  });

  it('passes opts=undefined when no new option is set (existing callers unchanged)', async () => {
    const rmq = makeRmq();
    const idem = makeIdem({ status: 'new' });

    await run(
      rmq,
      idem,
      { requestId: 'r-1', pattern: 'order.create', markReplay: true },
      () => ({ ok: true }),
    );

    expect(idem.tryAcquire).toHaveBeenCalledWith(
      'order.create:r-1',
      'order.create',
      undefined,
      undefined,
    );
  });

  it('uses keyPrefix for the key when given', async () => {
    const rmq = makeRmq();
    const idem = makeIdem({ status: 'new' });

    await run(
      rmq,
      idem,
      { requestId: 'r-1', pattern: 'order.create', keyPrefix: 'svc' },
      () => ({ ok: true }),
    );

    expect(idem.tryAcquire).toHaveBeenCalledWith(
      'svc:r-1',
      'order.create',
      undefined,
      undefined,
    );
  });

  it('without requestId falls back to plain executeAndAck (no idempotency)', async () => {
    const rmq = makeRmq();
    const idem = makeIdem({ status: 'cached', response: { stale: true } });

    const result = await run(
      rmq,
      idem,
      { pattern: 'order.create', markReplay: true },
      () => ({ fresh: true }),
    );

    expect(result).toEqual({ fresh: true });
    expect(idem.tryAcquire).not.toHaveBeenCalled();
    expect(rmq.ack).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Oqim testlari: HAQIQIY IdempotencyService + xotiradagi `idempotency_keys`
// jadvali (unique key, guarded UPDATE semantikasi) — handler necha marta
// ishlashini uchidan-uchiga tekshiradi.
// ---------------------------------------------------------------------------

interface MemRow {
  key: string;
  pattern: string;
  status: IdempotencyStatus;
  response: unknown;
  error: unknown;
  created_at: Date;
  completed_at: Date | null;
}

function uniqueViolation(): QueryFailedError {
  const err = new QueryFailedError('insert', [], new Error('dup') as never);
  (err as QueryFailedError & { code?: string }).code = '23505';
  return err;
}

const KNOWN_CLAUSES = new Set([
  'key = :key',
  'status = :status',
  'created_at < :cutoff',
  'COALESCE(completed_at, created_at) < :cutoff',
]);

/** `.set({col: () => 'SQL'})` dagi xom SQL ifodalarining qiymati. */
function rawSql(sql: string): unknown {
  if (sql === 'now()') return new Date(Date.now());
  if (sql === 'NULL') return null;
  throw new Error(`memory repo: unsupported raw SQL "${sql}"`);
}

/** Servis ishlatadigan UPDATE query builder'ni SQL guard semantikasi bilan taqlid qiladi. */
function memUpdateBuilder(rows: Map<string, MemRow>) {
  let patch: Record<string, unknown> = {};
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  const addWhere = (clause: string, p: Record<string, unknown>) => {
    if (!KNOWN_CLAUSES.has(clause)) {
      throw new Error(`memory repo: unsupported clause "${clause}"`);
    }
    clauses.push(clause);
    Object.assign(params, p);
    return qb;
  };
  const qb = {
    update: () => qb,
    set: (p: Record<string, unknown>) => {
      patch = p;
      return qb;
    },
    where: addWhere,
    andWhere: addWhere,
    execute: () => {
      const row = rows.get(params.key as string);
      const cutoff = params.cutoff as Date;
      const matches =
        row !== undefined &&
        row.status === params.status &&
        (!clauses.includes('created_at < :cutoff') ||
          row.created_at < cutoff) &&
        (!clauses.includes('COALESCE(completed_at, created_at) < :cutoff') ||
          (row.completed_at ?? row.created_at) < cutoff);
      if (!matches) return Promise.resolve({ affected: 0 });
      const target = row as unknown as Record<string, unknown>;
      for (const [field, value] of Object.entries(patch)) {
        target[field] =
          typeof value === 'function'
            ? rawSql((value as () => string)())
            : value;
      }
      return Promise.resolve({ affected: 1 });
    },
  };
  return qb;
}

function makeMemoryRepo() {
  const rows = new Map<string, MemRow>();
  const repo = {
    insert: jest.fn(
      (row: { key: string; pattern: string; status: IdempotencyStatus }) => {
        if (rows.has(row.key)) return Promise.reject(uniqueViolation());
        rows.set(row.key, {
          ...row,
          response: null,
          error: null,
          created_at: new Date(Date.now()),
          completed_at: null,
        });
        return Promise.resolve({});
      },
    ),
    findOne: jest.fn(({ where }: { where: { key: string } }) => {
      const row = rows.get(where.key);
      return Promise.resolve(row ? { ...row } : null);
    }),
    update: jest.fn((where: { key: string }, patch: Partial<MemRow>) => {
      const row = rows.get(where.key);
      if (row) Object.assign(row, patch);
      return Promise.resolve({ affected: row ? 1 : 0 });
    }),
    createQueryBuilder: jest.fn(() => memUpdateBuilder(rows)),
  };
  return { repo, rows };
}

function makeRealService() {
  const { repo, rows } = makeMemoryRepo();
  const svc = new IdempotencyService(
    repo as unknown as Repository<IdempotencyKey>,
  );
  return { svc, rows };
}

describe('executeIdempotent — flows over a real IdempotencyService', () => {
  // ⚠️ `Date.now` spy yetmaydi: markCompleted/markFailed `new Date()` ishlatadi —
  // shuning uchun soat to'liq (Date konstruktori bilan) soxtalashtiriladi.
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const advance = (ms: number) => jest.setSystemTime(Date.now() + ms);

  /** ai-confirm → order.create: `ai-dedupe:<sha256>` kaliti bilan chaqiruv opsiyalari. */
  const dedupeOpts: IdempotentExecuteOptions = {
    requestId: 'ai-dedupe:0f3a',
    pattern: 'order.create',
    completedTtlMs: TEN_MIN,
    reclaimFailed: true,
    markReplay: true,
  };

  it('wgqxS0Cp #13: the same batch twice within 10 min creates ONE order; the second call is a marked replay', async () => {
    const { svc } = makeRealService();
    const rmq = makeRmq();
    let seq = 0;
    const createOrder = jest.fn(() => ({ data: { id: String(++seq) } }));

    const first = await run(rmq, svc, dedupeOpts, createOrder);
    advance(5 * 60_000); // 5 daqiqadan keyin xuddi shu partiya
    const second = await run(rmq, svc, dedupeOpts, createOrder);

    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ data: { id: '1' } });
    expect(second).toEqual({ data: { id: '1' }, idempotent_replay: true });
    expect(rmq.ack).toHaveBeenCalledTimes(2);
    expect(rmq.nack).not.toHaveBeenCalled();
  });

  it('wgqxS0Cp #13 / C10: the same batch while the first create is still running → RpcException 409 in_progress (nack once), handler NOT re-run', async () => {
    const { svc } = makeRealService();
    const firstRmq = makeRmq();
    const secondRmq = makeRmq();
    let finish: (value: { data: { id: string } }) => void = () => undefined;
    const createOrder = jest.fn(
      () =>
        new Promise<{ data: { id: string } }>((resolve) => {
          finish = resolve;
        }),
    );

    const first = run(firstRmq, svc, dedupeOpts, createOrder);
    // Birinchi handler ishga tushguncha (kalit `in_progress`) kutiladi —
    // chegaralangan sikl: xatoda test osilib qolmaydi, pastdagi expect yiqiladi.
    for (let tick = 0; tick < 100 && createOrder.mock.calls.length === 0; ) {
      tick += 1;
      await Promise.resolve();
    }
    expect(createOrder).toHaveBeenCalledTimes(1);
    const second: unknown = await run(
      secondRmq,
      svc,
      dedupeOpts,
      createOrder,
    ).then(
      () => {
        throw new Error('rad etilishi kerak edi');
      },
      (thrown: unknown) => thrown,
    );

    expect(second).toBeInstanceOf(RpcException);
    expect((second as RpcException).getError()).toEqual({
      statusCode: 409,
      message:
        'Idempotency in_progress for order.create:ai-dedupe:0f3a, message requeued',
    });
    expect(secondRmq.nack).toHaveBeenCalledTimes(1);
    expect(secondRmq.nack).toHaveBeenCalledWith(expect.anything(), {
      requeue: true,
    });
    expect(secondRmq.ack).not.toHaveBeenCalled();
    expect(secondRmq.nackForError).not.toHaveBeenCalled();

    finish({ data: { id: '1' } });
    await expect(first).resolves.toEqual({ data: { id: '1' } });
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(firstRmq.ack).toHaveBeenCalledTimes(1);
  });

  it('after the 10 min TTL the same key runs the handler again (no permanent block)', async () => {
    const { svc, rows } = makeRealService();
    const rmq = makeRmq();
    let seq = 0;
    const createOrder = jest.fn(() => ({ data: { id: String(++seq) } }));

    await run(rmq, svc, dedupeOpts, createOrder);
    advance(TEN_MIN + 1_000);
    const later = await run(rmq, svc, dedupeOpts, createOrder);

    expect(createOrder).toHaveBeenCalledTimes(2);
    expect(later).toEqual({ data: { id: '2' } });
    expect(rows.get('order.create:ai-dedupe:0f3a')).toMatchObject({
      status: 'completed',
      response: { data: { id: '2' } },
    });
  });

  it('reclaimFailed: a failed attempt does not poison the key; the next call retries and succeeds', async () => {
    const { svc } = makeRealService();
    const rmq = makeRmq();
    const createOrder = jest
      .fn<{ data: { id: string } }, []>()
      .mockImplementationOnce(() => {
        throw new RpcException({ statusCode: 504, message: 'timeout' });
      })
      .mockImplementationOnce(() => ({ data: { id: '9' } }));

    await expect(run(rmq, svc, dedupeOpts, createOrder)).rejects.toBeInstanceOf(
      RpcException,
    );
    const retried = await run(rmq, svc, dedupeOpts, createOrder);

    expect(createOrder).toHaveBeenCalledTimes(2);
    expect(retried).toEqual({ data: { id: '9' } });
  });

  it('without reclaimFailed a failed key keeps returning the stored error (unchanged)', async () => {
    const { svc } = makeRealService();
    const rmq = makeRmq();
    const opts: IdempotentExecuteOptions = {
      requestId: 'r-1',
      pattern: 'order.create',
    };
    const handler = jest.fn(() => {
      throw new RpcException({ statusCode: 400, message: 'bad' });
    });

    await expect(run(rmq, svc, opts, handler)).rejects.toBeInstanceOf(
      RpcException,
    );
    await expect(run(rmq, svc, opts, handler)).rejects.toBeInstanceOf(
      RpcException,
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fPre2MRr #12: the same request_id twice returns ONE result (handler once, no replay flag)', async () => {
    const { svc } = makeRealService();
    const rmq = makeRmq();
    const opts: IdempotentExecuteOptions = {
      requestId: '6f1c2b1e-7d2a-4c1e-9d55-2b0f4f3f9a10',
      pattern: 'order.ai_resolve_preview',
    };
    const resolvePreview = jest.fn(() => ({
      previews: [{ index: 0, customer_name: 'Ali' }],
    }));

    const first = await run(rmq, svc, opts, resolvePreview);
    advance(60 * 60_000);
    const second = await run(rmq, svc, opts, resolvePreview);

    expect(resolvePreview).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second).not.toHaveProperty('idempotent_replay');
  });
});
