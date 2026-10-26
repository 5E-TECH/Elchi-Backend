import { of } from 'rxjs';
import { Order_status } from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderServiceService } from '../order-service.service';
import { OrderCustodyService } from '../custody/order-custody.service';

/**
 * vbu7Wr3o (prod E2E Surxondaryo, 2026-10-26; TEST buyurtmalar 129–137,
 * TEST filial 12 «TEST-SURX», menejer 101, kuryer 102):
 *   #1 menejer / kuryer pochtani QABUL qilganda tarix «Tizim buyurtmani
 *      kutilmoqda holatiga qaytardi» edi (logistics so'rovchisiz chaqirardi).
 *      Endi yozuv qabul qilgan xodim nomidan, `post_received` amali va qabul
 *      matni bilan;
 *   #2 HQ → filial jo'natish yozuvida filial nomi yo'q edi — frontend
 *      buyurtmaning JORIY filialini olardi (HQ'ga qaytgan 131/132 da «HQ
 *      Toshkent filialiga jo'natdi»). Endi nom yozuv paytida metadata'da;
 *      eski yozuvlarda — izohdagi (yozuv paytidagi) filial id'sidan.
 */
const BRANCH_NAMES: Record<string, string> = {
  '1': 'HQ Toshkent',
  '12': 'TEST Claude Surxondaryo filiali',
};

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
    send: jest.fn(() =>
      of({ data: [{ id: '102', name: 'TEST Claude Surx Kuryer' }] }),
    ),
  };
  service.custody = {
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    createCustodyEvent: jest.fn().mockResolvedValue(undefined),
    toTrackingRole: jest.fn((roles?: string[]) => roles?.[0] ?? 'system'),
  };
  service.syncOrderToSearch = jest.fn().mockResolvedValue(undefined);
  service.enqueueFinanceOnStatusChange = jest.fn().mockResolvedValue(undefined);
  const manager = {
    getRepository: jest.fn(() => ({ save: jest.fn((row) => row) })),
  };
  return { service, manager };
}

const onTheRoadInBranch = (extra: Record<string, unknown> = {}) => ({
  id: '129',
  status: Order_status.ON_THE_ROAD,
  branch_id: '12',
  post_id: '36',
  holder_type: 'BRANCH',
  holder_branch_id: '12',
  holder_courier_id: null,
  courier_id: null,
  ...extra,
});

describe('vbu7Wr3o #1 — pochta qabuli tracking`i qabul qilgan xodim nomidan', () => {
  it('⭐ filial menejeri qabul qildi: `post_received`, «<filial> pochtani qabul qildi», aktyor — menejer', async () => {
    const { service, manager } = makeLifecycle(onTheRoadInBranch());

    await service.updateFull(
      '129',
      {
        status: Order_status.WAITING,
        return_requested: false,
        branch_id: '12',
      },
      { id: '101', roles: ['manager'], note: 'Post received by branch' },
      manager,
    );

    const tracking = service.custody.createTrackingEvent.mock.calls[0][0];
    expect(tracking).toMatchObject({
      order_id: '129',
      from_status: Order_status.ON_THE_ROAD,
      to_status: Order_status.WAITING,
      changed_by: '101',
      changed_by_role: 'manager',
      action: 'post_received',
      description: 'TEST Claude Surxondaryo filiali pochtani qabul qildi',
      note: 'Post received by branch',
    });
    expect(tracking.metadata).toEqual({
      post_id: '36',
      branch_name: 'TEST Claude Surxondaryo filiali',
    });
    expect(tracking.changed_by).not.toBe('system');
  });

  it('⭐ kuryer qabul qildi: «Kuryer <ism> pochtani qabul qildi», aktyor — kuryer', async () => {
    const { service, manager } = makeLifecycle(
      onTheRoadInBranch({
        courier_id: '102',
        holder_type: 'COURIER',
        holder_courier_id: '102',
      }),
    );

    await service.updateFull(
      '129',
      { status: Order_status.WAITING, return_requested: false },
      { id: '102', roles: ['courier'], note: 'Post received by courier' },
      manager,
    );

    const tracking = service.custody.createTrackingEvent.mock.calls[0][0];
    expect(tracking).toMatchObject({
      changed_by: '102',
      changed_by_role: 'courier',
      action: 'post_received',
      description: 'Kuryer TEST Claude Surx Kuryer pochtani qabul qildi',
    });
    expect(tracking.metadata).toEqual({
      post_id: '36',
      courier_name: 'TEST Claude Surx Kuryer',
    });
  });

  it('nom olinmasa ham yoziladi (branch-service yiqildi): «Filial pochtani qabul qildi»', async () => {
    const { service, manager } = makeLifecycle(onTheRoadInBranch());
    service.branchClient.send = jest.fn(() => {
      throw new Error('branch-service down');
    });

    await service.updateFull(
      '129',
      { status: Order_status.WAITING, branch_id: '12' },
      { id: '101', roles: ['manager'], note: 'Post received by branch' },
      manager,
    );

    const tracking = service.custody.createTrackingEvent.mock.calls[0][0];
    expect(tracking.action).toBe('post_received');
    expect(tracking.description).toBe('Filial pochtani qabul qildi');
    expect(tracking.metadata).toEqual({ post_id: '36', branch_name: null });
  });

  it('qabul izohi bo`lmagan on the road → waiting (masalan qaytarish) — avvalgidek (amal/tavsif inferensiyasi)', async () => {
    const { service, manager } = makeLifecycle(onTheRoadInBranch());

    await service.updateFull(
      '129',
      { status: Order_status.WAITING },
      { id: '101', roles: ['manager'], note: 'Return request approved' },
      manager,
    );

    const tracking = service.custody.createTrackingEvent.mock.calls[0][0];
    expect(tracking.action).toBeUndefined();
    expect(tracking.description).toBeUndefined();
    expect(tracking.metadata).toBeUndefined();
  });
});

describe('vbu7Wr3o #2 — HQ → filial jo`natish yozuvida filial nomi YOZUV paytida', () => {
  it('⭐ dispatch (received → on the road, branch_id): metadata.branch_name — manzil filial', async () => {
    const { service, manager } = makeLifecycle({
      id: '131',
      status: Order_status.RECEIVED,
      branch_id: '1',
      post_id: '30',
      holder_type: 'HQ',
      holder_branch_id: null,
      holder_courier_id: null,
      courier_id: null,
    });

    await service.updateFull(
      '131',
      {
        branch_id: '12',
        holder_type: 'BRANCH',
        holder_branch_id: '12',
        holder_courier_id: null,
        post_id: '35',
        current_batch_id: null,
        status: Order_status.ON_THE_ROAD,
      },
      {
        id: '1',
        roles: ['superadmin'],
        note: "Post #35 HQ'dan branch #12 ga dispatch qilindi",
      },
      manager,
    );

    const tracking = service.custody.createTrackingEvent.mock.calls[0][0];
    expect(tracking.metadata).toEqual({
      post_id: '35',
      branch_name: 'TEST Claude Surxondaryo filiali',
    });
    // Amal va tavsif o'zgarmaydi (inferensiya: `sent`, izoh tavsifi).
    expect(tracking.action).toBeUndefined();
    expect(tracking.description).toBeUndefined();
    // `*_branch_id` kalitlari ATAYIN yo'q (frontend id'ni joriy filial bilan tiklaydi).
    expect(Object.keys(tracking.metadata)).not.toContain('branch_id');
  });
});

describe('vbu7Wr3o #2 — eski jo`natish yozuvlari o`qishda izohdagi filial bilan', () => {
  function makeReader(rows: Array<Record<string, unknown>>) {
    const service: any = Object.create(OrderServiceService.prototype);
    service.findById = jest.fn().mockResolvedValue({
      data: { id: '131', parent_order_id: null },
    });
    service.orderTrackingRepo = { find: jest.fn().mockResolvedValue(rows) };
    service.orderCustodyEventRepo = { find: jest.fn().mockResolvedValue([]) };
    service.resolveTrackingActors = jest.fn().mockResolvedValue(new Map());
    service.custody = Object.create(OrderCustodyService.prototype);
    service.branchClient = {
      send: jest.fn((_pattern: unknown, payload: { id: string }) =>
        of({ data: { id: payload.id, name: BRANCH_NAMES[payload.id] } }),
      ),
    };
    return service;
  }

  const dispatchRow = (extra: Record<string, unknown> = {}) => ({
    id: 't-1',
    order_id: '131',
    from_status: Order_status.RECEIVED,
    to_status: Order_status.ON_THE_ROAD,
    action: 'sent',
    changed_by: '1',
    changed_by_role: 'superadmin',
    note: "Post #35 HQ'dan branch #12 ga dispatch qilindi",
    description: "Post #35 HQ'dan branch #12 ga dispatch qilindi",
    old_value: { status: Order_status.RECEIVED },
    new_value: { status: Order_status.ON_THE_ROAD },
    metadata: null,
    created_at: new Date('2026-10-26T09:17:28Z'),
    ...extra,
  });

  it('⭐ HQ`ga qaytgan buyurtma (131): metadata.branch_name — izohdagi filial 12 («TEST … Surxondaryo»), joriy HQ emas', async () => {
    const service = makeReader([dispatchRow()]);

    const result = await service.getTrackingByOrderId('131', 1, 20);

    const event = result.data.find((row: any) => row.id === 't-1');
    expect(event.metadata).toEqual({
      branch_name: 'TEST Claude Surxondaryo filiali',
    });
    expect(service.branchClient.send).toHaveBeenCalledWith(
      { cmd: 'branch.find_by_id' },
      expect.objectContaining({ id: '12' }),
    );
  });

  it('yangi yozuvda (metadata.branch_name bor) — o`zgarmaydi, qo`shimcha so`rov yo`q', async () => {
    const service = makeReader([
      dispatchRow({
        metadata: { post_id: '35', branch_name: 'Yozuv paytidagi nom' },
      }),
    ]);

    const result = await service.getTrackingByOrderId('131', 1, 20);

    expect(result.data[0].metadata).toEqual({
      post_id: '35',
      branch_name: 'Yozuv paytidagi nom',
    });
    expect(service.branchClient.send).not.toHaveBeenCalled();
  });

  it('branch-service javob bermasa — metadata avvalgidek (null), tarix yiqilmaydi', async () => {
    const service = makeReader([dispatchRow()]);
    service.branchClient.send = jest.fn(() => {
      throw new Error('down');
    });

    const result = await service.getTrackingByOrderId('131', 1, 20);

    expect(result.data[0].metadata).toBeNull();
  });
});
