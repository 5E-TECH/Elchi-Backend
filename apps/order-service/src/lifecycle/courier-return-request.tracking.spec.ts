import { of } from 'rxjs';
import { Order_status } from '@app/common';
import {
  COURIER_RETURN_REQUESTED_TRACKING_ACTION,
  OrderLifecycleService,
} from './order-lifecycle.service';

/**
 * Kuryer «Bu buyurtma kelmagan» (logistics `requestCourierOrderReturn` →
 * `order.update {return_requested: true}`): holat o'zgarmaydi (yo'lda), lekin
 * tarixda so'rov qatori bo'lishi shart; shu orada qabul qilingan posilka
 * belgilanmaydi (409, qulf ostida ham).
 */
function makeService(
  order: Record<string, unknown>,
  lockedRow?: Record<string, unknown>,
) {
  const committed = { ...order };
  const service: any = Object.create(OrderLifecycleService.prototype);
  service.findById = jest.fn().mockResolvedValue(order);
  service.resolveHolderFromState = jest.fn().mockResolvedValue({
    holder_type: 'COURIER',
    holder_branch_id: null,
    holder_courier_id: 'c1',
  });
  service.resolveBranchTrackingLabel = jest.fn(() => Promise.resolve(null));
  service.identityClient = { send: jest.fn(() => of({ data: [] })) };
  service.custody = {
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    createCustodyEvent: jest.fn().mockResolvedValue(undefined),
    toTrackingRole: jest.fn(() => 'courier'),
  };
  service.syncOrderToSearch = jest.fn().mockResolvedValue(undefined);
  service.enqueueFinanceOnStatusChange = jest.fn().mockResolvedValue(undefined);
  const manager = {
    getRepository: jest.fn(() => ({
      save: jest.fn((row) => row),
      // Bazadagi (commit qilingan) qator — xotiradagi o'zgargan obyekt emas.
      findOne: jest.fn(() => Promise.resolve(lockedRow ?? committed)),
    })),
  };
  return { service, manager };
}

const onTheRoad = () => ({
  id: '801',
  status: Order_status.ON_THE_ROAD,
  post_id: '98',
  courier_id: 'c1',
  holder_type: 'COURIER',
  holder_courier_id: 'c1',
  return_requested: false,
});

const requester = {
  id: 'c1',
  roles: ['courier'],
  note: 'Courier reported the order did not arrive — return requested',
  courier_return_request: { post_id: '98' },
};

const statusOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (err: any) {
    return err?.getError?.()?.statusCode as number | undefined;
  }
};

describe('courier_return_requested — kuryer «buyurtma kelmagan»', () => {
  it('holat o‘zgarmaydi, tarixda bitta so‘rov qatori yoziladi', async () => {
    const order = onTheRoad();
    const { service, manager } = makeService(order);
    await service.updateFull(
      '801',
      { return_requested: true },
      requester,
      manager,
    );

    expect(service.custody.createTrackingEvent).toHaveBeenCalledTimes(1);
    expect(service.custody.createTrackingEvent.mock.calls[0][0]).toMatchObject({
      order_id: '801',
      from_status: Order_status.ON_THE_ROAD,
      to_status: Order_status.ON_THE_ROAD,
      action: COURIER_RETURN_REQUESTED_TRACKING_ACTION,
      changed_by: 'c1',
      metadata: { post_id: '98' },
    });
    expect(order).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      return_requested: true,
    });
  });

  it('belgisiz oddiy return_requested yangilanishi tarix yozmaydi', async () => {
    const { service, manager } = makeService(onTheRoad());
    await service.updateFull(
      '801',
      { return_requested: true },
      { id: 'c1', roles: ['courier'] },
      manager,
    );
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['allaqachon qabul qilingan', { status: Order_status.WAITING }],
    ['boshqa pochtada', { post_id: '99' }],
    ['so‘rov allaqachon yuborilgan', { return_requested: true }],
  ])('409 — buyurtma %s: hech narsa yozilmaydi', async (_label, extra) => {
    const order = { ...onTheRoad(), ...extra };
    const { service, manager } = makeService(order);
    expect(
      await statusOf(
        service.updateFull(
          '801',
          { return_requested: true },
          requester,
          manager,
        ),
      ),
    ).toBe(409);
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });

  it('poyga: qulf ostida qabul qilingan bo‘lsa — 409', async () => {
    const { service, manager } = makeService(onTheRoad(), {
      ...onTheRoad(),
      status: Order_status.WAITING,
    });
    expect(
      await statusOf(
        service.updateFull(
          '801',
          { return_requested: true },
          requester,
          manager,
        ),
      ),
    ).toBe(409);
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });

  it('so‘rov kutilayotgan buyurtmani «yetkaza olmadi» qilib bo‘lmaydi (409)', async () => {
    const { service } = makeService({ ...onTheRoad(), return_requested: true });
    expect(
      await statusOf(
        service.couldNotDeliverOrder({ id: 'c1', roles: ['courier'] }, '801', {
          reason: 'Mijoz telefonni olmadi, uyda yoq',
        }),
      ),
    ).toBe(409);
  });
});
