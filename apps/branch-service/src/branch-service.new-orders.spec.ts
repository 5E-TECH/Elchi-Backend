import { of } from 'rxjs';
import { BranchServiceService } from './branch-service.service';

/**
 * (RghzFldr) /branches/new-orders — marshrut endi `:id` soyasidan chiqdi, lekin
 * jadval baribir doim bo'sh edi: order-service `order.analytics.count_by_branch`
 * XOM massiv qaytaradi, branch-service esa faqat `response.data` ni o'qirdi.
 */
describe('getBranchesWithNewOrders — sanoq javobi shakli (RghzFldr)', () => {
  function make(countResponse: unknown) {
    const svc: any = Object.create(BranchServiceService.prototype);
    svc.resolveAccessScope = jest.fn(() =>
      Promise.resolve({ readableBranchIds: new Set(['3', '4']) }),
    );
    svc.isSystemPrivileged = jest.fn(() => true);
    svc.branchRepo = {
      find: jest.fn(() =>
        Promise.resolve([
          { id: '3', name: 'QA Filial', type: 'REGIONAL', level: 1 },
          { id: '4', name: 'Bo`sh filial', type: 'REGIONAL', level: 1 },
        ]),
      ),
    };
    svc.orderClient = { send: jest.fn(() => of(countResponse)) };
    return svc;
  }

  it('⭐ order-service XOM massiv qaytarsa — yangi buyurtmali filial chiqadi', async () => {
    const svc = make([{ branch_id: '3', count: 17 }]);
    const res = await svc.getBranchesWithNewOrders({
      id: '1',
      roles: ['superadmin'],
    });
    expect(res.data).toEqual([
      expect.objectContaining({ id: '3', new_orders_count: 17 }),
    ]);
  });

  it('`{ data: [...] }` shakli ham ishlaydi (orqaga moslik)', async () => {
    const svc = make({ data: [{ branch_id: '4', count: 2 }] });
    const res = await svc.getBranchesWithNewOrders({
      id: '1',
      roles: ['superadmin'],
    });
    expect(res.data).toEqual([
      expect.objectContaining({ id: '4', new_orders_count: 2 }),
    ]);
  });

  it('yangi buyurtma yo`q — bo`sh ro`yxat', async () => {
    const svc = make([]);
    const res = await svc.getBranchesWithNewOrders({
      id: '1',
      roles: ['superadmin'],
    });
    expect(res.data).toEqual([]);
  });
});
