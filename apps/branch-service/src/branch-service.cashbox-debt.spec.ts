/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { createMemoryBranchService } from '../test/branch-memory-repo';

/**
 * (2026-11-11) Filial «Kassa qarzga ishlaydi» (`cashbox_debt_enabled`,
 * mig 217): PATCH faqat admin/superadmin, boolean, HQ'da yoqilmaydi; GET va
 * ro'yxat qaytaradi. Ro'yxatda HQ filialdan ortiqcha qabul qilgan bo'lsa
 * (daftar summasi manfiy) — `berilishi_kerak` 0, `hq_qarzi` musbat.
 */
describe('Filial kassasi qarzga ishlaydi — sozlama va HQ qarzi', () => {
  const ADMIN = { id: '1', roles: ['admin'] };
  const SUPERADMIN = { id: '2', roles: ['superadmin'] };

  const rpcErrorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as {
        statusCode?: number;
        message?: string;
      };
    }
    throw new Error('chaqiruv rad etilishi kutilgandi');
  };

  async function world() {
    const w = createMemoryBranchService();
    const hq: any = await w.service.createBranch(
      { name: 'Bosh ofis', type: 'HQ', code: 'HQ' },
      SUPERADMIN,
    );
    const branch: any = await w.service.createBranch(
      {
        name: 'Namangan',
        type: 'REGIONAL',
        code: 'NAM',
        parent_id: String(hq.data.id),
      },
      ADMIN,
    );
    return { ...w, hqId: String(hq.data.id), id: String(branch.data.id) };
  }

  it('sukut — o`chiq', async () => {
    const { service, id } = await world();
    const byId: any = await service.findBranchById(id, ADMIN);
    expect(byId.data.cashbox_debt_enabled).toBe(false);
  });

  it('⭐ admin yoqadi/o`chiradi — saqlanadi, GET qaytaradi, jurnal eski/yangi', async () => {
    const { service, id, activityLog } = await world();

    const on: any = await service.updateBranch(
      id,
      { cashbox_debt_enabled: true },
      ADMIN,
    );
    expect(on.data.cashbox_debt_enabled).toBe(true);
    expect(
      ((await service.findBranchById(id, ADMIN)) as any).data
        .cashbox_debt_enabled,
    ).toBe(true);
    expect(activityLog.logChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        old_value: expect.objectContaining({ cashbox_debt_enabled: false }),
        new_value: expect.objectContaining({ cashbox_debt_enabled: true }),
      }),
    );

    // Boshqa maydon o'zgarsa bayroq saqlanadi.
    const renamed: any = await service.updateBranch(
      id,
      { name: 'Namangan 2' },
      SUPERADMIN,
    );
    expect(renamed.data.cashbox_debt_enabled).toBe(true);

    const off: any = await service.updateBranch(
      id,
      { cashbox_debt_enabled: false },
      SUPERADMIN,
    );
    expect(off.data.cashbox_debt_enabled).toBe(false);
  });

  it('menejer — 403, bayroq o`zgarmaydi', async () => {
    const { service, id } = await world();
    jest
      .spyOn(service as any, 'assertCanWriteBranch')
      .mockResolvedValue(undefined);
    const err = await rpcErrorOf(
      service.updateBranch(
        id,
        { cashbox_debt_enabled: true },
        { id: '9', roles: ['manager'] },
      ),
    );
    expect(err.statusCode).toBe(403);
    expect(
      ((await service.findBranchById(id, ADMIN)) as any).data
        .cashbox_debt_enabled,
    ).toBe(false);
  });

  it('boolean emas ("true" satr) — 400', async () => {
    const { service, id } = await world();
    const err = await rpcErrorOf(
      service.updateBranch(
        id,
        { cashbox_debt_enabled: 'true' as never },
        ADMIN,
      ),
    );
    expect(err.statusCode).toBe(400);
  });

  it('HQ filialda yoqib bo`lmaydi — 400', async () => {
    const { service, hqId } = await world();
    const err = await rpcErrorOf(
      service.updateBranch(hqId, { cashbox_debt_enabled: true }, SUPERADMIN),
    );
    expect(err.statusCode).toBe(400);
  });

  it('⭐ ro`yxat: daftar −500 000 → berilishi_kerak 0, hq_qarzi 500 000; musbat → aksincha', async () => {
    const { service, id, hqId } = await world();
    const other: any = await service.createBranch(
      { name: 'Andijon', type: 'REGIONAL', code: 'AND', parent_id: hqId },
      ADMIN,
    );
    const otherId = String(other.data.id);
    const orderClient = (service as any).orderClient;
    orderClient.send.mockImplementation((pattern: { cmd: string }) =>
      pattern.cmd === 'order.settlement.financial_balance_summary'
        ? of({
            data: {
              branches: [
                { branch_id: id, amount: -500_000 },
                { branch_id: otherId, amount: 300_000 },
              ],
            },
          })
        : of({ data: [] }),
    );

    const list: any = await service.findAllBranches({ limit: 100 }, ADMIN);
    const row = (bid: string) =>
      list.data.items.find((item: any) => String(item.id) === bid);

    expect(row(id)).toMatchObject({
      berilishi_kerak: 0,
      olinishi_kerak: 0,
      hq_qarzi: 500_000,
    });
    expect(row(otherId)).toMatchObject({
      berilishi_kerak: 300_000,
      olinishi_kerak: 300_000,
      hq_qarzi: 0,
    });
    expect(row(hqId)).toMatchObject({ berilishi_kerak: 0, hq_qarzi: 0 });
  });
});
