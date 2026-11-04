import { of } from 'rxjs';
import { Order_status } from '@app/common';
import {
  BRANCH_RETURN_REQUESTED_TRACKING_ACTION,
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

/**
 * Filial menejeri «Bu buyurtma kelmagan» (logistics
 * `requestBranchTransferOrderReturn`, HQ → filial o'tkazma pochtasi): kuryer
 * bilan bir xil tekshiruv (qulf ostida ham), tarixda alohida
 * `branch_return_requested` qatori — kim bildirgani ko'rinadi.
 */
describe('branch_return_requested — filial «buyurtma kelmagan»', () => {
  const inTransfer = () => ({
    id: '801',
    status: Order_status.ON_THE_ROAD,
    post_id: '98',
    branch_id: '10',
    courier_id: null,
    holder_type: 'BRANCH',
    holder_branch_id: '10',
    holder_courier_id: null,
    return_requested: false,
  });

  const branchRequester = {
    id: '198',
    roles: ['manager'],
    note: 'Branch manager reported the order did not arrive — return requested',
    branch_return_request: { post_id: '98' },
  };

  it('holat o‘zgarmaydi, tarixda filial so‘rovi qatori (post_id, branch_id) yoziladi', async () => {
    const order = inTransfer();
    const { service, manager } = makeService(order);
    await service.updateFull(
      '801',
      { return_requested: true },
      branchRequester,
      manager,
    );

    expect(service.custody.createTrackingEvent).toHaveBeenCalledTimes(1);
    const event = service.custody.createTrackingEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      order_id: '801',
      from_status: Order_status.ON_THE_ROAD,
      to_status: Order_status.ON_THE_ROAD,
      action: BRANCH_RETURN_REQUESTED_TRACKING_ACTION,
      changed_by: '198',
      description:
        "Filial menejeri buyurtma filialga kelmaganini bildirdi — qaytarish so'rovi yuborildi",
      old_value: { return_requested: false },
      new_value: { return_requested: true },
      metadata: { post_id: '98', branch_id: '10' },
    });
    expect(event.action).not.toBe(COURIER_RETURN_REQUESTED_TRACKING_ACTION);
    expect(order).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      return_requested: true,
    });
  });

  it.each([
    ['filial qabul qilgan', { status: Order_status.WAITING }],
    ['boshqa pochtada', { post_id: '99' }],
    ['so‘rov allaqachon yuborilgan', { return_requested: true }],
  ])('409 — buyurtma %s: hech narsa yozilmaydi', async (_label, extra) => {
    const { service, manager } = makeService({ ...inTransfer(), ...extra });
    expect(
      await statusOf(
        service.updateFull(
          '801',
          { return_requested: true },
          branchRequester,
          manager,
        ),
      ),
    ).toBe(409);
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });

  it('poyga: qulf ostida filial qabul qilgan bo‘lsa — 409', async () => {
    const { service, manager } = makeService(inTransfer(), {
      ...inTransfer(),
      status: Order_status.WAITING,
    });
    expect(
      await statusOf(
        service.updateFull(
          '801',
          { return_requested: true },
          branchRequester,
          manager,
        ),
      ),
    ).toBe(409);
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });
});

/**
 * «Qaytarish» tasdig'i / radi (logistics `approveReturnRequests` /
 * `rejectReturnRequests`) va filial qabuli (`receivePost`) — qulf ostidagi
 * shartli yozuvlar (2026-11-04). HQ tasdig'i ↔ filial qabuli poygasida
 * ikkinchisi 409 oladi; filial o'tkazmasi tasdig'i — yagona `on the road →
 * received` ruxsati (HQ omboriga, qayta jo'natish uchun).
 */
describe('return_request_review / post_receive_guard — qulf ostidagi shartli yozuvlar', () => {
  const flaggedTransfer = () => ({
    id: '801',
    status: Order_status.ON_THE_ROAD,
    post_id: '98',
    branch_id: '10',
    courier_id: null,
    holder_type: 'BRANCH',
    holder_branch_id: '10',
    holder_courier_id: null,
    return_requested: true,
  });
  const transferReview = {
    post_id: '98',
    status: Order_status.ON_THE_ROAD,
    source: 'branch_transfer' as const,
  };
  const approveDto = {
    status: Order_status.RECEIVED,
    return_requested: false,
    courier_id: null,
    assigned_at: null,
    post_id: '700',
    branch_id: '1',
  };
  const admin = (extra: Record<string, unknown> = {}) => ({
    id: '2',
    roles: ['admin'],
    note: "Qaytarish so'rovi tasdiqlandi — filialga kelmagan buyurtma HQ omboriga qaytarildi (qayta jo'natish mumkin)",
    ...extra,
  });
  const errorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return null;
    } catch (err: any) {
      return err?.getError?.() as
        { statusCode?: number; reason?: string } | undefined;
    }
  };
  const asHq = (service: any) => {
    service.resolveHolderFromState = jest.fn().mockResolvedValue({
      holder_type: 'HQ',
      holder_branch_id: null,
      holder_courier_id: null,
    });
  };

  it('filial o‘tkazmasi tasdig‘i: on the road → received, HQ NEW pochtasiga, holder HQ', async () => {
    const order = flaggedTransfer();
    const { service, manager } = makeService(order);
    asHq(service);

    await service.updateFull(
      '801',
      approveDto,
      admin({ return_request_review: transferReview }),
      manager,
    );

    expect(order).toMatchObject({
      status: Order_status.RECEIVED,
      return_requested: false,
      post_id: '700',
      branch_id: '1',
      holder_type: 'HQ',
    });
    expect(service.custody.createTrackingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        from_status: Order_status.ON_THE_ROAD,
        to_status: Order_status.RECEIVED,
        changed_by: '2',
      }),
      expect.anything(),
    );
    expect(service.custody.createCustodyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        from_holder_type: 'BRANCH',
        to_holder_type: 'HQ',
      }),
      expect.anything(),
    );
  });

  it('belgisiz on the road → received — 400 (umumiy mashinada qirra yo‘q)', async () => {
    const { service, manager } = makeService(flaggedTransfer());
    asHq(service);
    const error = await errorOf(
      service.updateFull('801', approveDto, admin(), manager),
    );
    expect(error?.statusCode).toBe(400);
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });

  it('kuryer manbali belgi filial qatorida — 409 (received ruxsati faqat branch_transfer ga)', async () => {
    const { service, manager } = makeService(flaggedTransfer());
    asHq(service);
    const error = await errorOf(
      service.updateFull(
        '801',
        approveDto,
        admin({
          return_request_review: { ...transferReview, source: 'courier' },
        }),
        manager,
      ),
    );
    expect(error).toMatchObject({
      statusCode: 409,
      reason: 'return_request_review_conflict',
    });
  });

  it.each([
    ['filial qabul qilgan', { status: Order_status.WAITING }],
    ['boshqa xodim rad etgan', { return_requested: false }],
    ['boshqa pochtaga o‘tgan', { post_id: '99' }],
    [
      'kuryerga berilgan',
      { holder_type: 'COURIER', courier_id: 'c1', holder_courier_id: 'c1' },
    ],
  ])(
    'poyga: qulf ostida %s — 409 return_request_review_conflict, hech narsa yozilmaydi',
    async (_label, lockedExtra) => {
      const { service, manager } = makeService(flaggedTransfer(), {
        ...flaggedTransfer(),
        ...lockedExtra,
      });
      asHq(service);
      const error = await errorOf(
        service.updateFull(
          '801',
          approveDto,
          admin({ return_request_review: transferReview }),
          manager,
        ),
      );
      expect(error).toMatchObject({
        statusCode: 409,
        reason: 'return_request_review_conflict',
      });
      expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
    },
  );

  it('kuryer so‘rovi tasdig‘i (WAITING) — belgi bilan o‘tadi; qulf ostida kuryer qabul qilgan bo‘lsa 409', async () => {
    const courierRequest = () => ({ ...onTheRoad(), return_requested: true });
    const review = {
      post_id: '98',
      status: Order_status.ON_THE_ROAD,
      source: 'courier' as const,
    };
    const dto = {
      status: Order_status.WAITING,
      return_requested: false,
      courier_id: null,
      assigned_at: null,
      post_id: null,
      branch_id: '10',
    };

    const ok = makeService(courierRequest());
    await ok.service.updateFull(
      '801',
      dto,
      { id: '198', roles: ['manager'], return_request_review: review },
      ok.manager,
    );
    expect(ok.service.custody.createTrackingEvent).toHaveBeenCalledTimes(1);

    const raced = makeService(courierRequest(), {
      ...courierRequest(),
      status: Order_status.WAITING,
      return_requested: false,
    });
    const error = await errorOf(
      raced.service.updateFull(
        '801',
        dto,
        { id: '198', roles: ['manager'], return_request_review: review },
        raced.manager,
      ),
    );
    expect(error).toMatchObject({
      statusCode: 409,
      reason: 'return_request_review_conflict',
    });
  });

  it('rad etish (faqat belgi) — qulf ostida so‘rov hali turgan bo‘lsa o‘tadi, holat o‘zgarmaydi', async () => {
    const order = flaggedTransfer();
    const { service, manager } = makeService(order);
    await service.updateFull(
      '801',
      { return_requested: false },
      admin({ return_request_review: transferReview }),
      manager,
    );
    expect(order).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      return_requested: false,
      post_id: '98',
    });
  });

  it('post_receive_guard: qulf ostida HQ tasdiqlab NEW pochtaga olgan — 409 post_receive_conflict', async () => {
    const order = { ...flaggedTransfer(), return_requested: false };
    const { service, manager } = makeService(order, {
      ...order,
      status: Order_status.RECEIVED,
      post_id: '700',
      branch_id: '1',
      holder_type: 'HQ',
    });
    const error = await errorOf(
      service.updateFull(
        '801',
        {
          status: Order_status.WAITING,
          return_requested: false,
          branch_id: '10',
        },
        {
          post_receive_guard: {
            post_id: '98',
            status: Order_status.ON_THE_ROAD,
          },
        },
        manager,
      ),
    );
    expect(error).toMatchObject({
      statusCode: 409,
      reason: 'post_receive_conflict',
    });
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });

  it('post_receive_guard: buyurtma hali shu pochtada — qabul yoziladi', async () => {
    const order = { ...flaggedTransfer(), return_requested: false };
    const { service, manager } = makeService(order);
    await service.updateFull(
      '801',
      { status: Order_status.WAITING, return_requested: false },
      {
        post_receive_guard: {
          post_id: '98',
          status: Order_status.ON_THE_ROAD,
        },
      },
      manager,
    );
    expect(order.status).toBe(Order_status.WAITING);
  });
});
