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

  beforeEach(() => {
    orderSend = jest.fn(({ cmd }: { cmd: string }) => {
      if (cmd === 'order.transfer_batch.find_by_id') {
        return of({
          statusCode: 200,
          data: { id: '501', source_branch_id: '10', status: 'PENDING' },
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
});
