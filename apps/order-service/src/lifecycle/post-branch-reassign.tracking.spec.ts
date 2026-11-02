import { of } from 'rxjs';
import { Order_status } from '@app/common';
import {
  OrderLifecycleService,
  POST_BRANCH_REASSIGNED_TRACKING_ACTION,
} from './order-lifecycle.service';

/**
 * Jo'natilgan pochta boshqa filialga o'tkazildi (branch-service
 * `reassignPostToBranch` → `order.update {branch_id}`): holat o'zgarmaydi
 * (yo'lda), lekin buyurtma tarixida «o'tkazildi» qatori bo'lishi shart —
 * aks holda tarix «1-filialga jo'natildi» deb qolardi.
 */
function makeService(order: Record<string, unknown>, nextHolder: string) {
  const service: any = Object.create(OrderLifecycleService.prototype);
  service.findById = jest.fn().mockResolvedValue(order);
  service.resolveHolderFromState = jest.fn().mockResolvedValue({
    holder_type: 'BRANCH',
    holder_branch_id: nextHolder,
    holder_courier_id: null,
  });
  service.resolveBranchTrackingLabel = jest.fn(() => Promise.resolve(null));
  service.identityClient = { send: jest.fn(() => of({ data: [] })) };
  service.custody = {
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    createCustodyEvent: jest.fn().mockResolvedValue(undefined),
    toTrackingRole: jest.fn(() => 'admin'),
  };
  service.syncOrderToSearch = jest.fn().mockResolvedValue(undefined);
  service.enqueueFinanceOnStatusChange = jest.fn().mockResolvedValue(undefined);
  const manager = {
    getRepository: jest.fn(() => ({ save: jest.fn((row) => row) })),
  };
  return { service, manager };
}

const onTheRoad = () => ({
  id: '501',
  status: Order_status.ON_THE_ROAD,
  post_id: '900',
  branch_id: '20',
  holder_type: 'BRANCH',
  holder_branch_id: '20',
  holder_courier_id: null,
  courier_id: null,
});

const reassignRequester = {
  id: '1',
  roles: ['admin'],
  note: "Pochta #900 Samarqand 1 filialidan Samarqand 2 filialiga o'tkazildi",
  post_branch_reassign: {
    post_id: '900',
    from_branch_id: '20',
    from_branch_name: 'Samarqand 1',
    to_branch_id: '22',
    to_branch_name: 'Samarqand 2',
  },
};

describe("post_branch_reassigned — pochta boshqa filialga o'tkazilganda tarix", () => {
  it("holat o'zgarmasa ham bitta «o'tkazildi» tracking qatori va custody hodisasi yoziladi", async () => {
    const order = onTheRoad();
    const { service, manager } = makeService(order, '22');
    await service.updateFull(
      '501',
      { branch_id: '22' },
      reassignRequester,
      manager,
    );

    expect(service.custody.createTrackingEvent).toHaveBeenCalledTimes(1);
    const tracking = service.custody.createTrackingEvent.mock.calls[0][0];
    expect(tracking).toMatchObject({
      order_id: '501',
      from_status: Order_status.ON_THE_ROAD,
      to_status: Order_status.ON_THE_ROAD,
      action: POST_BRANCH_REASSIGNED_TRACKING_ACTION,
      description:
        "Pochta Samarqand 1 filialidan Samarqand 2 filialiga o'tkazildi",
      changed_by: '1',
      old_value: { branch_id: '20' },
      new_value: { branch_id: '22' },
      metadata: {
        post_id: '900',
        from_branch_id: '20',
        from_branch_name: 'Samarqand 1',
        to_branch_id: '22',
        to_branch_name: 'Samarqand 2',
      },
    });
    expect(order).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      branch_id: '22',
      holder_branch_id: '22',
    });
    expect(service.custody.createCustodyEvent).toHaveBeenCalledTimes(1);
    expect(service.custody.createCustodyEvent.mock.calls[0][0]).toMatchObject({
      from_branch_id: '20',
      to_branch_id: '22',
    });
  });

  it("o'tkazish belgisisiz oddiy branch_id yangilanishi tracking yozmaydi", async () => {
    const { service, manager } = makeService(onTheRoad(), '22');
    await service.updateFull(
      '501',
      { branch_id: '22' },
      { id: '1', roles: ['admin'] },
      manager,
    );
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });

  it("filial o'zgarmagan bo'lsa (qayta urinish) — ikkinchi qator yozilmaydi", async () => {
    const order = { ...onTheRoad(), branch_id: '22', holder_branch_id: '22' };
    const { service, manager } = makeService(order, '22');
    await service.updateFull(
      '501',
      { branch_id: '22' },
      reassignRequester,
      manager,
    );
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['filial qabul qilgan (kutilmoqda)', { status: Order_status.WAITING }],
    ['«kelmadi» belgisi bor', { return_requested: true }],
    ['kuryerda', { courier_id: '77', holder_courier_id: '77' }],
    ['boshqa filialda', { branch_id: '40', holder_branch_id: '40' }],
  ])('409 — buyurtma %s: hech narsa yozilmaydi', async (_label, extra) => {
    const order = { ...onTheRoad(), ...extra };
    const { service, manager } = makeService(order, '22');
    let status: number | undefined;
    try {
      await service.updateFull(
        '501',
        { branch_id: '22' },
        reassignRequester,
        manager,
      );
    } catch (err: any) {
      status = err?.getError?.()?.statusCode;
    }
    expect(status).toBe(409);
    expect(order.branch_id).toBe(extra.branch_id ?? '20');
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });
});
