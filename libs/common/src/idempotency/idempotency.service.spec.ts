import { Logger } from '@nestjs/common';
import { QueryFailedError, Repository } from 'typeorm';
import {
  DEFAULT_IDEMPOTENCY_LEASE_MS,
  IdempotencyService,
} from './idempotency.service';
import { IdempotencyKey } from './idempotency-key.entity';

/** Minimal in-memory stand-in for the TypeORM repository used by the service. */
function makeRepo() {
  const updateBuilder = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const deleteBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  const repo = {
    insert: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(() => ({
      update: jest.fn().mockReturnValue(updateBuilder),
      delete: jest.fn().mockReturnValue(deleteBuilder),
    })),
    _updateBuilder: updateBuilder,
    _deleteBuilder: deleteBuilder,
  };
  return repo;
}

function uniqueViolation(): QueryFailedError {
  const err = new QueryFailedError('insert', [], new Error('dup') as never);
  (err as QueryFailedError & { code?: string }).code = '23505';
  return err;
}

function makeService(repo: ReturnType<typeof makeRepo>) {
  return new IdempotencyService(repo as unknown as Repository<IdempotencyKey>);
}

/** Mavjud (dublikat) qator bilan repo: insert unique violation beradi. */
function repoWithExisting(existing: Partial<IdempotencyKey>) {
  const repo = makeRepo();
  repo.insert.mockRejectedValue(uniqueViolation());
  repo.findOne.mockResolvedValue(existing);
  return repo;
}

/** `.set(...)` ga berilgan qiymat (reclaim UPDATE nimalarni yozishi). */
function lastSetArg(repo: ReturnType<typeof makeRepo>) {
  const calls = repo._updateBuilder.set.mock.calls as unknown[][];
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

// Vaqtni muzlatamiz — cutoff qiymatlarini aniq tekshirish uchun.
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const TEN_MIN = 10 * 60_000;

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  warnSpy = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('IdempotencyService.tryAcquire', () => {
  it('returns "new" on a fresh key (insert succeeds)', async () => {
    const repo = makeRepo();
    repo.insert.mockResolvedValue(undefined);
    const svc = makeService(repo);

    const result = await svc.tryAcquire('order.create:req-1', 'order.create');

    expect(result).toEqual({ status: 'new' });
    expect(repo.insert).toHaveBeenCalledWith({
      key: 'order.create:req-1',
      pattern: 'order.create',
      status: 'in_progress',
    });
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('returns cached response when the key is already completed', async () => {
    const repo = makeRepo();
    repo.insert.mockRejectedValue(uniqueViolation());
    repo.findOne.mockResolvedValue({
      status: 'completed',
      response: { ok: true },
    } as Partial<IdempotencyKey>);
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p');

    expect(result).toEqual({ status: 'cached', response: { ok: true } });
  });

  it('returns failed error when the key previously failed', async () => {
    const repo = makeRepo();
    repo.insert.mockRejectedValue(uniqueViolation());
    repo.findOne.mockResolvedValue({
      status: 'failed',
      error: { message: 'boom' },
    } as Partial<IdempotencyKey>);
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p');

    expect(result).toEqual({ status: 'failed', error: { message: 'boom' } });
  });

  it('returns "in_progress" when another worker holds a FRESH lease', async () => {
    const repo = makeRepo();
    repo.insert.mockRejectedValue(uniqueViolation());
    repo.findOne.mockResolvedValue({
      status: 'in_progress',
      created_at: new Date(Date.now()), // just now (frozen NOW) → within lease
    } as Partial<IdempotencyKey>);
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p');

    expect(result).toEqual({ status: 'in_progress' });
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('reclaims a STALE lease (crashed worker) and returns "new"', async () => {
    const repo = makeRepo();
    repo.insert.mockRejectedValue(uniqueViolation());
    repo.findOne.mockResolvedValue({
      status: 'in_progress',
      created_at: new Date(Date.now() - (DEFAULT_IDEMPOTENCY_LEASE_MS + 5_000)),
    } as Partial<IdempotencyKey>);
    repo._updateBuilder.execute.mockResolvedValue({ affected: 1 });
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p');

    expect(result).toEqual({ status: 'new' });
    expect(repo.createQueryBuilder).toHaveBeenCalled();
    // The reclaim UPDATE is guarded by status + created_at predicates.
    expect(repo._updateBuilder.andWhere).toHaveBeenCalledWith(
      'status = :status',
      {
        status: 'in_progress',
      },
    );
    expect(repo._updateBuilder.andWhere).toHaveBeenCalledWith(
      'created_at < :cutoff',
      expect.objectContaining({ cutoff: expect.any(Date) as unknown }),
    );
  });

  it('stays "in_progress" if a concurrent caller won the reclaim race (affected=0)', async () => {
    const repo = makeRepo();
    repo.insert.mockRejectedValue(uniqueViolation());
    repo.findOne.mockResolvedValue({
      status: 'in_progress',
      created_at: new Date(Date.now() - (DEFAULT_IDEMPOTENCY_LEASE_MS + 5_000)),
    } as Partial<IdempotencyKey>);
    repo._updateBuilder.execute.mockResolvedValue({ affected: 0 });
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p');

    expect(result).toEqual({ status: 'in_progress' });
  });

  it('rethrows non-unique-violation insert errors', async () => {
    const repo = makeRepo();
    repo.insert.mockRejectedValue(new Error('connection lost'));
    const svc = makeService(repo);

    await expect(svc.tryAcquire('k', 'p')).rejects.toThrow('connection lost');
  });
});

/**
 * wgqxS0Cp #13 (libs qismi): ai-confirm `ai-dedupe:<sha256>` kaliti 10 daqiqa
 * ichida takror kelsa keshdan qaytadi, TTL o'tgach esa qayta egallanadi.
 */
describe('IdempotencyService.tryAcquire — completedTtlMs', () => {
  it('reclaims a completed row OLDER than the TTL: guarded UPDATE resets the row and returns "new"', async () => {
    const repo = repoWithExisting({
      status: 'completed',
      response: { data: { id: '42' } },
      created_at: new Date(NOW - TEN_MIN - 60_000),
      completed_at: new Date(NOW - TEN_MIN - 1_000),
    });
    const svc = makeService(repo);

    const result = await svc.tryAcquire(
      'order.create:ai-dedupe:abc',
      'p',
      undefined,
      {
        completedTtlMs: TEN_MIN,
      },
    );

    expect(result).toEqual({ status: 'new' });
    // Qator in_progress ga qaytadi, yangi lease, eski javob/xato/completed_at tozalanadi.
    const setArg = lastSetArg(repo);
    expect(setArg).toEqual({
      status: 'in_progress',
      created_at: expect.any(Function) as unknown,
      response: expect.any(Function) as unknown,
      error: expect.any(Function) as unknown,
      completed_at: null,
    });
    // Xom SQL: created_at = now(), response = NULL, error = NULL.
    expect((setArg.created_at as () => string)()).toBe('now()');
    expect((setArg.response as () => string)()).toBe('NULL');
    expect((setArg.error as () => string)()).toBe('NULL');
    // Guard: key + status='completed' + COALESCE(completed_at, created_at) < cutoff.
    expect(repo._updateBuilder.where).toHaveBeenCalledWith('key = :key', {
      key: 'order.create:ai-dedupe:abc',
    });
    expect(repo._updateBuilder.andWhere).toHaveBeenCalledWith(
      'status = :status',
      { status: 'completed' },
    );
    expect(repo._updateBuilder.andWhere).toHaveBeenCalledWith(
      'COALESCE(completed_at, created_at) < :cutoff',
      { cutoff: new Date(NOW - TEN_MIN) },
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Reclaimed expired completed idempotency key='),
    );
  });

  it('falls back to created_at when completed_at is missing', async () => {
    const repo = repoWithExisting({
      status: 'completed',
      response: { ok: true },
      created_at: new Date(NOW - TEN_MIN - 1_000),
      completed_at: null,
    });
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p', undefined, {
      completedTtlMs: TEN_MIN,
    });

    expect(result).toEqual({ status: 'new' });
    expect(repo._updateBuilder.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed row YOUNGER than the TTL cached (no UPDATE)', async () => {
    const repo = repoWithExisting({
      status: 'completed',
      response: { data: { id: '42' } },
      created_at: new Date(NOW - 5 * 60_000),
      completed_at: new Date(NOW - 5 * 60_000),
    });
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p', undefined, {
      completedTtlMs: TEN_MIN,
    });

    expect(result).toEqual({
      status: 'cached',
      response: { data: { id: '42' } },
    });
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('measures age by completed_at (a long handler finished recently stays cached)', async () => {
    const repo = repoWithExisting({
      status: 'completed',
      response: { ok: true },
      created_at: new Date(NOW - TEN_MIN - 60_000), // eski
      completed_at: new Date(NOW - 60_000), // yaqinda tugagan
    });
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p', undefined, {
      completedTtlMs: TEN_MIN,
    });

    expect(result).toEqual({ status: 'cached', response: { ok: true } });
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns cached when the reclaim guard loses a race (affected=0)', async () => {
    const repo = repoWithExisting({
      status: 'completed',
      response: { data: { id: '42' } },
      created_at: new Date(NOW - TEN_MIN - 60_000),
      completed_at: new Date(NOW - TEN_MIN - 1_000),
    });
    repo._updateBuilder.execute.mockResolvedValue({ affected: 0 });
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p', undefined, {
      completedTtlMs: TEN_MIN,
    });

    expect(result).toEqual({
      status: 'cached',
      response: { data: { id: '42' } },
    });
    expect(repo._updateBuilder.execute).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is unchanged without opts: an arbitrarily old completed row stays cached', async () => {
    const repo = repoWithExisting({
      status: 'completed',
      response: { ok: true },
      created_at: new Date(NOW - 365 * 24 * 3_600_000),
      completed_at: new Date(NOW - 365 * 24 * 3_600_000),
    });
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p');

    expect(result).toEqual({ status: 'cached', response: { ok: true } });
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('reclaimFailed alone does not reclaim a completed row', async () => {
    const repo = repoWithExisting({
      status: 'completed',
      response: { ok: true },
      created_at: new Date(NOW - 365 * 24 * 3_600_000),
      completed_at: new Date(NOW - 365 * 24 * 3_600_000),
    });
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p', undefined, {
      reclaimFailed: true,
    });

    expect(result).toEqual({ status: 'cached', response: { ok: true } });
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('IdempotencyService.tryAcquire — reclaimFailed', () => {
  it('reclaims a failed row (no age condition) and returns "new"', async () => {
    const repo = repoWithExisting({
      status: 'failed',
      error: { message: 'identity timeout' },
      created_at: new Date(NOW - 1_000), // yosh bo'lsa ham
      completed_at: new Date(NOW - 500),
    });
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p', undefined, {
      reclaimFailed: true,
    });

    expect(result).toEqual({ status: 'new' });
    expect(lastSetArg(repo)).toEqual({
      status: 'in_progress',
      created_at: expect.any(Function) as unknown,
      response: expect.any(Function) as unknown,
      error: expect.any(Function) as unknown,
      completed_at: null,
    });
    expect(repo._updateBuilder.where).toHaveBeenCalledWith('key = :key', {
      key: 'k',
    });
    expect(repo._updateBuilder.andWhere).toHaveBeenCalledWith(
      'status = :status',
      { status: 'failed' },
    );
    // Yosh sharti YO'Q — faqat status guard.
    expect(repo._updateBuilder.andWhere).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Reclaimed failed idempotency key=k'),
    );
  });

  it('returns failed without reclaimFailed (no UPDATE)', async () => {
    const repo = repoWithExisting({
      status: 'failed',
      error: { message: 'boom' },
      created_at: new Date(NOW - TEN_MIN * 10),
      completed_at: new Date(NOW - TEN_MIN * 10),
    });
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p', undefined, {
      completedTtlMs: TEN_MIN,
    });

    expect(result).toEqual({ status: 'failed', error: { message: 'boom' } });
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns failed when the reclaim guard loses a race (affected=0)', async () => {
    const repo = repoWithExisting({
      status: 'failed',
      error: { message: 'boom' },
      created_at: new Date(NOW - 1_000),
      completed_at: new Date(NOW - 500),
    });
    repo._updateBuilder.execute.mockResolvedValue({ affected: 0 });
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p', undefined, {
      reclaimFailed: true,
    });

    expect(result).toEqual({ status: 'failed', error: { message: 'boom' } });
    expect(repo._updateBuilder.execute).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not touch an in_progress row with a fresh lease', async () => {
    const repo = repoWithExisting({
      status: 'in_progress',
      created_at: new Date(NOW - 1_000),
    });
    const svc = makeService(repo);

    const result = await svc.tryAcquire('k', 'p', undefined, {
      completedTtlMs: TEN_MIN,
      reclaimFailed: true,
    });

    expect(result).toEqual({ status: 'in_progress' });
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });
});

/** HD5zOyBp #10 (libs qismi): preview PII qatorlari pattern bo'yicha tozalanadi. */
describe('IdempotencyService.prunePattern', () => {
  it('deletes only rows of the given pattern older than the cutoff and returns the count', async () => {
    const repo = makeRepo();
    repo._deleteBuilder.execute.mockResolvedValue({ affected: 7 });
    const svc = makeService(repo);

    const deleted = await svc.prunePattern(
      'order.ai_resolve_preview',
      3_600_000,
    );

    expect(deleted).toBe(7);
    expect(repo._deleteBuilder.where).toHaveBeenCalledWith(
      'pattern = :pattern',
      { pattern: 'order.ai_resolve_preview' },
    );
    expect(repo._deleteBuilder.andWhere).toHaveBeenCalledWith(
      'created_at < :cutoff',
      { cutoff: new Date(NOW - 3_600_000) },
    );
    expect(repo._deleteBuilder.execute).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when the driver reports no affected count', async () => {
    const repo = makeRepo();
    repo._deleteBuilder.execute.mockResolvedValue({});
    const svc = makeService(repo);

    await expect(svc.prunePattern('p', 1_000)).resolves.toBe(0);
  });
});
