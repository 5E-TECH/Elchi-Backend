import { QueryFailedError } from 'typeorm';
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
  const repo = {
    insert: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(() => ({
      update: jest.fn().mockReturnValue(updateBuilder),
    })),
    _updateBuilder: updateBuilder,
  };
  return repo;
}

function uniqueViolation(): QueryFailedError {
  const err = new QueryFailedError('insert', [], new Error('dup') as never);
  (err as QueryFailedError & { code?: string }).code = '23505';
  return err;
}

function makeService(repo: ReturnType<typeof makeRepo>) {
  return new IdempotencyService(repo as any);
}

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
      created_at: new Date(), // just now → within lease
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
