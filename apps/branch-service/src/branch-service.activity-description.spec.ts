import { of } from 'rxjs';
import { BranchServiceService } from './branch-service.service';

/**
 * 2WRzdWpZ — filiallararo jo'natma (branch transfer) jurnal qatorida
 * o'zbekcha gap. Harness `branch-service.service.spec.ts` bilan bir uslub.
 */
describe('filiallararo jo`natma jurnal gapi (2WRzdWpZ)', () => {
  it('transfer_batch_create: "Jo`natma #501 yaratildi: Filial #10 → Filial #1, 1 ta buyurtma"', async () => {
    const qb: Record<string, jest.Mock> = {};
    for (const m of ['where', 'andWhere', 'select', 'orderBy', 'take']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getOne = jest.fn().mockResolvedValue(null);
    qb.getMany = jest.fn().mockResolvedValue([]);
    const branchRepo = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce({ id: '10', parent_id: '1', isDeleted: false })
        .mockResolvedValueOnce({ id: '1', isDeleted: false }),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qb),
      manager: { query: jest.fn().mockResolvedValue([]) },
      metadata: { tablePath: 'branch_schema.branches' },
    };
    const branchUserRepo = {
      find: jest
        .fn()
        .mockResolvedValue([
          { branch_id: '10', role: 'REGISTRATOR', isDeleted: false },
        ]),
      findOne: jest.fn(),
    };
    const orderClient = {
      send: jest
        .fn()
        .mockReturnValueOnce(
          of({
            statusCode: 201,
            data: {
              idempotent: false,
              batches: [{ id: '501', qr_code_token: 'BTB-abc123xy' }],
            },
          }),
        )
        .mockReturnValue(of({ statusCode: 201, data: { id: 'h-1' } })),
    };
    const fileClient = {
      send: jest.fn().mockReturnValue(of({ data: { key: 'k', url: 'u' } })),
    };
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new BranchServiceService(
      branchRepo as never,
      branchUserRepo as never,
      { findOne: jest.fn(), find: jest.fn() } as never,
      { send: jest.fn(() => of({ data: { id: 'u1' } })) } as never,
      { send: jest.fn(() => of({ data: [] })) } as never,
      orderClient as never,
      fileClient as never,
      { send: jest.fn(() => of({ data: {} })) } as never,
      { get: jest.fn((_k: string, fallback?: string) => fallback) } as never,
      activityLog as never,
    );

    await service.createTransferBatches(
      '10',
      { orderIds: ['900'] },
      { id: '77', roles: ['branch'] },
    );

    const entry = activityLog.log.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((e) => e.action === 'branch.transfer_batch_create');
    expect(entry?.description).toBe(
      "Jo'natma #501 yaratildi: Filial #10 → Filial #1, 1 ta buyurtma",
    );
  });
});
