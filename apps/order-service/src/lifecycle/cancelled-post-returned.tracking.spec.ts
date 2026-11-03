import { of } from 'rxjs';
import { Order_status } from '@app/common';
import {
  CANCELLED_POST_RETURNED_TRACKING_ACTION,
  OrderLifecycleService,
} from './order-lifecycle.service';

/**
 * HQ «Filialga qaytarish» (logistics `returnCanceledOrdersToSender` →
 * `order.update`): holat o'zgarmaydi (`cancelled (sent)`), lekin tarixda
 * «HQ filialga qaytardi» qatori bo'lishi shart; shu orada boshqa xodim qabul
 * qilgan yoki qaytargan buyurtma qayta yozilmaydi (409).
 */
function makeService(
  order: Record<string, unknown>,
  nextHolder: string,
  /** Tranzaksiya ichida qulf bilan o'qilgan qator (shu orada boshqa commit). */
  lockedRow?: Record<string, unknown>,
) {
  const committed = { ...order };
  const service: any = Object.create(OrderLifecycleService.prototype);
  service.findById = jest.fn().mockResolvedValue(order);
  service.resolveHolderFromState = jest.fn().mockResolvedValue({
    holder_type: 'BRANCH',
    holder_branch_id: nextHolder,
    holder_courier_id: null,
  });
  service.resolveBranchTrackingLabel = jest.fn((branchId: string) =>
    Promise.resolve(`Samarqand (ID: ${branchId})`),
  );
  service.identityClient = { send: jest.fn(() => of({ data: [] })) };
  service.custody = {
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    createCustodyEvent: jest.fn().mockResolvedValue(undefined),
    toTrackingRole: jest.fn(() => 'admin'),
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

const atHq = () => ({
  id: '701',
  status: Order_status.CANCELLED_SENT,
  canceled_post_id: '77',
  branch_id: '1',
  holder_type: 'HQ',
  holder_branch_id: null,
  holder_courier_id: null,
  courier_id: null,
});

const returnDto = {
  status: Order_status.CANCELLED_SENT,
  branch_id: '10',
  courier_id: null,
  assigned_at: null,
  canceled_post_id: '88',
};

const returnRequester = {
  id: '1',
  roles: ['admin'],
  note: 'Canceled order returned to sender branch by HQ',
  canceled_post_guard: { post_id: '77' },
  canceled_post_return: {
    post_id: '77',
    return_post_id: '88',
    to_branch_id: '10',
    to_branch_name: 'Samarqand',
  },
};

describe('cancelled_post_returned — HQ bekor buyurtmani filialga qaytardi', () => {
  it('holat o‘zgarmasa ham bitta «qaytardi» tracking qatori yoziladi', async () => {
    const order = atHq();
    const { service, manager } = makeService(order, '10');
    await service.updateFull('701', returnDto, returnRequester, manager);

    expect(service.custody.createTrackingEvent).toHaveBeenCalledTimes(1);
    expect(service.custody.createTrackingEvent.mock.calls[0][0]).toMatchObject({
      order_id: '701',
      from_status: Order_status.CANCELLED_SENT,
      to_status: Order_status.CANCELLED_SENT,
      action: CANCELLED_POST_RETURNED_TRACKING_ACTION,
      description:
        'HQ bekor qilingan buyurtmani Samarqand (ID: 10) filialiga qaytardi',
      changed_by: '1',
      old_value: { canceled_post_id: '77', holder_type: 'HQ' },
      new_value: { canceled_post_id: '88', holder_branch_id: '10' },
      metadata: {
        post_id: '77',
        return_post_id: '88',
        from_branch: 'HQ',
        to_branch_id: '10',
        to_branch_name: 'Samarqand',
      },
    });
    expect(order).toMatchObject({
      status: Order_status.CANCELLED_SENT,
      canceled_post_id: '88',
      holder_branch_id: '10',
    });
  });

  it('qaytarish belgisisiz (filial qabulidagi LC-06) tracking yozilmaydi', async () => {
    const { service, manager } = makeService(atHq(), '10');
    await service.updateFull(
      '701',
      returnDto,
      {
        id: '1',
        roles: ['manager'],
        note: 'Canceled order returned to courier after partial branch receive',
      },
      manager,
    );
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });

  it.each([
    [
      'HQ qabul qilgan',
      { status: Order_status.CANCELLED, canceled_post_id: null },
    ],
    ['boshqa pochtaga qaytarilgan', { canceled_post_id: '90' }],
  ])('409 — buyurtma %s: hech narsa yozilmaydi', async (_label, extra) => {
    const order = { ...atHq(), ...extra };
    const { service, manager } = makeService(order, '10');
    let status: number | undefined;
    try {
      await service.updateFull('701', returnDto, returnRequester, manager);
    } catch (err: any) {
      status = err?.getError?.()?.statusCode;
    }
    expect(status).toBe(409);
    expect(order.branch_id).toBe('1');
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });

  it('HQ qabulida ham himoya: qaytarilgan buyurtma qabul qilinmaydi (409)', async () => {
    const order = { ...atHq(), canceled_post_id: '88', branch_id: '10' };
    const { service, manager } = makeService(order, '1');
    let status: number | undefined;
    try {
      await service.updateFull(
        '701',
        {
          status: Order_status.CANCELLED,
          branch_id: '1',
          courier_id: null,
          assigned_at: null,
          canceled_post_id: null,
        },
        {
          id: '1',
          roles: ['admin'],
          note: 'Canceled order received by HQ and held for market handover',
          canceled_post_guard: { post_id: '77' },
        },
        manager,
      );
    } catch (err: any) {
      status = err?.getError?.()?.statusCode;
    }
    expect(status).toBe(409);
    expect(order.status).toBe(Order_status.CANCELLED_SENT);
  });

  it('bir vaqtda ikki amal: qulf ostida qayta tekshiriladi — ikkinchisi 409, hech narsa yozilmaydi', async () => {
    // Qulfsiz o'qishda hali pochtada, qulf ostida — boshqa xodim qabul qilib bo'lgan.
    const order = atHq();
    const { service, manager } = makeService(order, '10', {
      ...atHq(),
      status: Order_status.CANCELLED,
      canceled_post_id: null,
    });
    let status: number | undefined;
    try {
      await service.updateFull('701', returnDto, returnRequester, manager);
    } catch (err: any) {
      status = err?.getError?.()?.statusCode;
    }
    expect(status).toBe(409);
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
  });

  it('filial nomini o‘qib bo‘lmasa (403) — logistics bergan nom yoziladi, so‘rov tizim nomidan', async () => {
    const order = atHq();
    const { service, manager } = makeService(order, '10');
    service.resolveBranchTrackingLabel = jest.fn(() =>
      Promise.resolve('branch ID: 10'),
    );
    await service.updateFull('701', returnDto, returnRequester, manager);

    expect(service.resolveBranchTrackingLabel).toHaveBeenCalledWith('10', null);
    expect(
      service.custody.createTrackingEvent.mock.calls[0][0].description,
    ).toBe(
      'HQ bekor qilingan buyurtmani Samarqand (ID: 10) filialiga qaytardi',
    );
  });
});
