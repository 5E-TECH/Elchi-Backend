import { of } from 'rxjs';
import { RpcException } from '@nestjs/microservices';
import { COURIER_SCAN_TRACKING_NOTES, Order_status } from '@app/common';
import {
  COURIER_SCAN_CONFLICT_REASON,
  OrderLifecycleService,
} from './order-lifecycle.service';

/**
 * COURIER-SCAN (ega, 2026-11-17) — kuryer skani = QABUL. Logistics
 * `scan-assign` kuryer nomidan `order.update` ga skan izohini uzatadi:
 *  - tarixda «Kuryer <ism> skan bilan oldi» (`courier_scan_received`) —
 *    «Kuryer pochtani qabul qildi» (`post_received`) EMAS;
 *  - filial qabul qilgan WAITING buyurtma (holat o'zgarmaydi) uchun ham
 *    tarixda bitta qator;
 *  - o'tkazma pochtasidan kuryer skani bilan filialga qabul —
 *    `branch_post_received_by_courier_scan`;
 *  - `courier_scan_guard`: ikki kuryer bir vaqtda — faqat birinchisi.
 */
const BRANCH_NAMES: Record<string, string> = { '10': 'Andijon filiali' };

function makeLifecycle(order: Record<string, unknown>) {
  const service: any = Object.create(OrderLifecycleService.prototype);
  service.findById = jest.fn().mockResolvedValue(order);
  service.resolveHolderFromState = jest.fn(
    (branchId: string | null, courierId: string | null) =>
      Promise.resolve(
        courierId
          ? {
              holder_type: 'COURIER',
              holder_branch_id: branchId,
              holder_courier_id: courierId,
            }
          : {
              holder_type: 'BRANCH',
              holder_branch_id: branchId,
              holder_courier_id: null,
            },
      ),
  );
  service.branchClient = {
    send: jest.fn((_pattern: unknown, payload: { id: string }) =>
      of({ data: { id: payload.id, name: BRANCH_NAMES[payload.id] } }),
    ),
  };
  service.identityClient = {
    send: jest.fn(() => of({ data: [{ id: '44', name: 'Ali Valiyev' }] })),
  };
  service.custody = {
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    createCustodyEvent: jest.fn().mockResolvedValue(undefined),
    toTrackingRole: jest.fn((roles?: string[]) => roles?.[0] ?? 'system'),
  };
  service.syncOrderToSearch = jest.fn().mockResolvedValue(undefined);
  service.enqueueFinanceOnStatusChange = jest.fn().mockResolvedValue(undefined);
  // Qulf ostidagi qayta o'qish (`pessimistic_write`) — `locked` bilan.
  let locked: Record<string, unknown> = { ...order };
  const manager = {
    getRepository: jest.fn(() => ({
      save: jest.fn((row) => row),
      findOne: jest.fn(() => Promise.resolve({ ...locked })),
    })),
  };
  return {
    service,
    manager,
    setLocked: (next: Record<string, unknown>) => {
      locked = next;
    },
  };
}

const COURIER = { id: '44', roles: ['courier'] };
const takeNote = COURIER_SCAN_TRACKING_NOTES.TAKE;

const trackingRows = (service: any) =>
  service.custody.createTrackingEvent.mock.calls.map(
    ([row]: [Record<string, unknown>]) => row,
  );

describe('COURIER-SCAN — kuryer skani tarix qatori', () => {
  it('⭐ filial qabul qilgan WAITING (kuryersiz) → WAITING + kuryer: holat o‘zgarmasa ham bitta «Kuryer <ism> skan bilan oldi» qatori', async () => {
    const { service, manager } = makeLifecycle({
      id: '201',
      status: Order_status.WAITING,
      branch_id: '10',
      post_id: '42',
      holder_type: 'BRANCH',
      holder_branch_id: '10',
      holder_courier_id: null,
      courier_id: null,
    });

    await service.updateFull(
      '201',
      {
        courier_id: '44',
        status: Order_status.WAITING,
        post_id: '77',
        assigned_at: new Date().toISOString(),
      },
      { ...COURIER, note: takeNote },
      manager,
    );

    const rows = trackingRows(service);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      order_id: '201',
      from_status: Order_status.WAITING,
      to_status: Order_status.WAITING,
      changed_by: '44',
      changed_by_role: 'courier',
      action: 'courier_scan_received',
      description: 'Kuryer Ali Valiyev skan bilan oldi',
      old_value: { courier_id: null },
      new_value: { courier_id: '44' },
    });
    expect(rows[0].metadata).toEqual({
      post_id: '77',
      courier_name: 'Ali Valiyev',
    });
    // Mas'uliyat: filial → kuryer (custody hodisasi ham yoziladi).
    expect(service.custody.createCustodyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        from_holder_type: 'BRANCH',
        to_holder_type: 'COURIER',
        to_courier_id: '44',
      }),
      expect.anything(),
    );
  });

  it('⭐ RECEIVED → WAITING (NEW/RECEIVED skani): `courier_scan_received`, ON_THE_ROAD yo‘q', async () => {
    const { service, manager } = makeLifecycle({
      id: '202',
      status: Order_status.RECEIVED,
      branch_id: '10',
      post_id: null,
      holder_type: 'BRANCH',
      holder_branch_id: '10',
      holder_courier_id: null,
      courier_id: null,
    });

    await service.updateFull(
      '202',
      { courier_id: '44', status: Order_status.WAITING, post_id: '77' },
      { ...COURIER, note: takeNote },
      manager,
    );

    const rows = trackingRows(service);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_status: Order_status.RECEIVED,
      to_status: Order_status.WAITING,
      action: 'courier_scan_received',
      description: 'Kuryer Ali Valiyev skan bilan oldi',
    });
  });

  it('⭐ kuryer o‘zidagi yo‘ldagini qayta skanladi (ON_THE_ROAD → WAITING): «skan bilan oldi», «pochtani qabul qildi» EMAS', async () => {
    const { service, manager } = makeLifecycle({
      id: '203',
      status: Order_status.ON_THE_ROAD,
      branch_id: '10',
      post_id: '40',
      holder_type: 'COURIER',
      holder_branch_id: '10',
      holder_courier_id: '44',
      courier_id: '44',
    });

    await service.updateFull(
      '203',
      { status: Order_status.WAITING, return_requested: false },
      { ...COURIER, note: takeNote },
      manager,
    );

    const rows = trackingRows(service);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('courier_scan_received');
    expect(rows[0].action).not.toBe('post_received');
    expect(rows[0].description).toBe('Kuryer Ali Valiyev skan bilan oldi');
  });

  it('⭐ o‘tkazma pochtasidan kuryer skani bilan filialga qabul: `branch_post_received_by_courier_scan`', async () => {
    const { service, manager } = makeLifecycle({
      id: '204',
      status: Order_status.ON_THE_ROAD,
      branch_id: '10',
      post_id: '42',
      holder_type: 'BRANCH',
      holder_branch_id: '10',
      holder_courier_id: null,
      courier_id: null,
    });

    await service.updateFull(
      '204',
      {
        status: Order_status.WAITING,
        return_requested: false,
        branch_id: '10',
      },
      { ...COURIER, note: COURIER_SCAN_TRACKING_NOTES.BRANCH_RECEIVE },
      manager,
    );

    const rows = trackingRows(service);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_status: Order_status.ON_THE_ROAD,
      to_status: Order_status.WAITING,
      changed_by: '44',
      action: 'branch_post_received_by_courier_scan',
      description: 'Kuryer Ali Valiyev skani bilan filialga qabul qilindi',
    });
    expect(rows[0].metadata).toEqual({
      post_id: '42',
      branch_name: 'Andijon filiali',
      courier_name: 'Ali Valiyev',
    });
  });

  it('o‘z WAITING buyurtmasi (kuryer o‘zgarmadi) — qo‘shimcha qator yo‘q', async () => {
    const { service, manager } = makeLifecycle({
      id: '205',
      status: Order_status.WAITING,
      branch_id: '10',
      post_id: '77',
      holder_type: 'COURIER',
      holder_branch_id: '10',
      holder_courier_id: '44',
      courier_id: '44',
    });

    await service.updateFull(
      '205',
      { courier_id: '44', status: Order_status.WAITING, post_id: '77' },
      { ...COURIER, note: takeNote },
      manager,
    );

    expect(trackingRows(service)).toEqual([]);
  });
});

describe('COURIER-SCAN — courier_scan_guard (ikki kuryer bir vaqtda)', () => {
  const base = {
    id: '206',
    status: Order_status.WAITING,
    branch_id: '10',
    post_id: '42',
    holder_type: 'BRANCH',
    holder_branch_id: '10',
    holder_courier_id: null,
    courier_id: null,
  };
  const guard = {
    status: Order_status.WAITING,
    post_id: '42',
    courier_id: null,
  };

  async function conflictOf(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as Record<string, unknown>;
    }
    throw new Error('409 kutilgan edi');
  }

  it('⭐ qulf ostida boshqa kuryer allaqachon olgan — 409 `courier_scan_conflict`, hech narsa yozilmaydi', async () => {
    const { service, manager, setLocked } = makeLifecycle({ ...base });
    setLocked({
      ...base,
      courier_id: '45',
      holder_type: 'COURIER',
      holder_courier_id: '45',
      post_id: '78',
    });

    const error = await conflictOf(
      service.updateFull(
        '206',
        { courier_id: '44', status: Order_status.WAITING, post_id: '77' },
        { ...COURIER, note: takeNote, courier_scan_guard: guard },
        manager,
      ),
    );

    expect(error).toMatchObject({
      statusCode: 409,
      reason: COURIER_SCAN_CONFLICT_REASON,
    });
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
    expect(service.custody.createCustodyEvent).not.toHaveBeenCalled();
  });

  it('qulfsiz o‘qishda ham mos kelmasa — 409 (tranzaksiyaga yetmaydi)', async () => {
    const { service, manager } = makeLifecycle({
      ...base,
      status: Order_status.ON_THE_ROAD,
    });

    const error = await conflictOf(
      service.updateFull(
        '206',
        { courier_id: '44', status: Order_status.WAITING, post_id: '77' },
        { ...COURIER, note: takeNote, courier_scan_guard: guard },
        manager,
      ),
    );

    expect(error.reason).toBe(COURIER_SCAN_CONFLICT_REASON);
    expect(manager.getRepository).not.toHaveBeenCalled();
  });

  it('mos kelsa — yoziladi', async () => {
    const { service, manager } = makeLifecycle({ ...base });

    await service.updateFull(
      '206',
      { courier_id: '44', status: Order_status.WAITING, post_id: '77' },
      { ...COURIER, note: takeNote, courier_scan_guard: guard },
      manager,
    );

    expect(trackingRows(service)).toHaveLength(1);
  });
});
