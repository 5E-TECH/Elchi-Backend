import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { BranchServiceService } from './branch-service.service';

/**
 * wLNccBkX — POST /transfer-batches/:id/cancel: gateway registrator /
 * menejer / branch'ni o'tkazadi, lekin servis faqat MANBA filialning
 * registratori/menejeri (yoki menejer daraxti) va admin/superadmin'ga
 * ruxsat beradi — partiya yaratish huquqi bilan bir xil. Kutilgan status
 * kodlari qat'iy: o'z filiali → 200, boshqa filial → 403.
 */
describe('wLNccBkX — cancelTransferBatch doirasi', () => {
  const REASON = "noto'g'ri viloyat tanlangan";
  let service: BranchServiceService;
  let orderSend: jest.Mock;
  let branchUserFind: jest.Mock;

  let batchStatus: string | undefined;

  beforeEach(() => {
    batchStatus = 'PENDING';
    orderSend = jest.fn(({ cmd }: { cmd: string }) => {
      if (cmd === 'order.transfer_batch.find_by_id') {
        return of({
          statusCode: 200,
          data: { id: '501', source_branch_id: '10', status: batchStatus },
        });
      }
      return of({ statusCode: 200, data: { id: '501', status: 'CANCELLED' } });
    });
    branchUserFind = jest.fn();
    const client = () => ({ send: jest.fn(() => of({ data: {} })) });
    service = new BranchServiceService(
      {
        findOne: jest.fn().mockResolvedValue(null),
        manager: { query: jest.fn().mockResolvedValue([]) },
        metadata: { tablePath: 'branch_schema.branches' },
      } as any,
      { find: branchUserFind } as any,
      {} as any,
      client() as any,
      client() as any,
      { send: orderSend } as any,
      client() as any,
      client() as any,
      { get: jest.fn((_k: string, fallback?: string) => fallback) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
  });

  const cancelCalled = () =>
    orderSend.mock.calls.some(
      ([pattern]) => pattern.cmd === 'order.transfer_batch.cancel',
    );

  it('manba filial registratori → 200', async () => {
    branchUserFind.mockResolvedValue([
      { branch_id: '10', role: 'REGISTRATOR', isDeleted: false },
    ]);
    const res: any = await service.cancelTransferBatch(
      '501',
      { reason: REASON },
      { id: '21', roles: ['registrator'] },
    );
    expect(res.statusCode).toBe(200);
    expect(cancelCalled()).toBe(true);
  });

  it('BOSHQA filial registratori → 403, order-service bekor qilmaydi', async () => {
    branchUserFind.mockResolvedValue([
      { branch_id: '99', role: 'REGISTRATOR', isDeleted: false },
    ]);
    let error: unknown;
    try {
      await service.cancelTransferBatch(
        '501',
        { reason: REASON },
        { id: '21', roles: ['registrator'] },
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RpcException);
    expect(
      ((error as RpcException).getError() as { statusCode?: number })
        .statusCode,
    ).toBe(403);
    expect(cancelCalled()).toBe(false);
  });

  const rpcError = async (promise: Promise<unknown>) => {
    let error: unknown;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode?: number;
      message?: string;
      data?: { reason?: string; details?: Record<string, unknown> };
    };
  };

  /**
   * oP02jE2P — yo'ldagi (SENT) paket hech kimga bekor qilinmaydi: posilkalar
   * tizimda manba filialda «yangi» bo'lib qolmasin. Superadmin ham — 409.
   */
  it.each([
    ['superadmin', { id: '1', roles: ['superadmin'] }],
    ['admin', { id: '2', roles: ['admin'] }],
    ['manba filial registratori', { id: '21', roles: ['registrator'] }],
  ])(
    'oP02jE2P — SENT paket: %s → 409 batch_in_transit, order-service bekor qilmaydi',
    async (_label, requester) => {
      batchStatus = 'SENT';
      branchUserFind.mockResolvedValue([
        { branch_id: '10', role: 'REGISTRATOR', isDeleted: false },
      ]);

      const err = await rpcError(
        service.cancelTransferBatch('501', { reason: REASON }, requester),
      );

      expect(err.statusCode).toBe(409);
      expect(err.message).toMatch(/yo'lda/);
      expect(err.data).toEqual({
        reason: 'batch_in_transit',
        details: { batch_id: '501', status: 'SENT' },
      });
      expect(cancelCalled()).toBe(false);
    },
  );

  it('oP02jE2P — SENT paket, BOSHQA filial registratori → 403 (holat oshkor qilinmaydi)', async () => {
    batchStatus = 'SENT';
    branchUserFind.mockResolvedValue([
      { branch_id: '99', role: 'REGISTRATOR', isDeleted: false },
    ]);

    const err = await rpcError(
      service.cancelTransferBatch(
        '501',
        { reason: REASON },
        { id: '21', roles: ['registrator'] },
      ),
    );

    expect(err.statusCode).toBe(403);
    expect(cancelCalled()).toBe(false);
  });

  it.each([
    ['RECEIVED', 'batch_received'],
    ['CANCELLED', 'batch_already_cancelled'],
  ])(
    'oP02jE2P — %s paket → 400 %s, order-service bekor qilmaydi',
    async (status, reason) => {
      batchStatus = status;
      const err = await rpcError(
        service.cancelTransferBatch(
          '501',
          { reason: REASON },
          { id: '1', roles: ['superadmin'] },
        ),
      );
      expect(err.statusCode).toBe(400);
      expect(err.data?.reason).toBe(reason);
      expect(cancelCalled()).toBe(false);
    },
  );

  it('oP02jE2P — PENDING paket, superadmin → 200 (bekor qilinadi)', async () => {
    const res: any = await service.cancelTransferBatch(
      '501',
      { reason: REASON },
      { id: '1', roles: ['superadmin'] },
    );
    expect(res.statusCode).toBe(200);
    expect(cancelCalled()).toBe(true);
  });

  it("oP02jE2P — find_by_id holatsiz qaytsa, qaror order-service'da (qulf bilan)", async () => {
    batchStatus = undefined;
    const res: any = await service.cancelTransferBatch(
      '501',
      { reason: REASON },
      { id: '1', roles: ['superadmin'] },
    );
    expect(res.statusCode).toBe(200);
    expect(cancelCalled()).toBe(true);
  });
});
