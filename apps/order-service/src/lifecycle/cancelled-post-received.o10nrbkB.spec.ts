import { of } from 'rxjs';
import { Order_status } from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';
import {
  canceledPostReceiveCustodyFrom,
  normalizeCanceledPostSender,
} from '../cancel-return/cancel-return';

/**
 * o10nrbkB (BG5) — bekor pochta QABULI (`cancelled_post_received`):
 *   - manba — pochtaning HAQIQIY jo'natuvchisi (logistics `canceled_post_sender`:
 *     `post.courier_id`, roli, filiali), `previousHolderBranchId` EMAS (u
 *     jo'natishdayoq maqsadga almashgan: «HQ … HQdan», «Andijon … Andijondan»);
 *   - qabulda custody hodisasi DOIM yoziladi (qabul vaqti + xodim), holder
 *     o'zgarmasa ham; «kimdan» — jo'natuvchi.
 */
const BRANCH_LABELS: Record<string, string> = {
  '1': 'Toshkent HQ (HQ, ID: 1)',
  '10': 'Andijon filiali (AN, ID: 10)',
};

function makeService(order: Record<string, unknown>) {
  const service: any = Object.create(OrderLifecycleService.prototype);
  service.findById = jest.fn().mockResolvedValue(order);
  // Qabulda holder o'zgarmaydi (jo'natishda allaqachon maqsadga o'tgan).
  service.resolveHolderFromState = jest.fn().mockResolvedValue({
    holder_type: order.holder_type,
    holder_branch_id: order.holder_branch_id,
    holder_courier_id: null,
  });
  service.resolveBranchTrackingLabel = jest.fn((id?: string | null) =>
    Promise.resolve(id ? (BRANCH_LABELS[String(id)] ?? null) : null),
  );
  service.identityClient = {
    send: jest.fn(() => of({ data: [{ id: '7', name: 'Ali Valiyev' }] })),
  };
  service.custody = {
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    createCustodyEvent: jest.fn().mockResolvedValue(undefined),
    toTrackingRole: jest.fn(() => 'manager'),
  };
  service.syncOrderToSearch = jest.fn().mockResolvedValue(undefined);
  service.enqueueFinanceOnStatusChange = jest.fn().mockResolvedValue(undefined);
  const manager = {
    getRepository: jest.fn(() => ({ save: jest.fn((row) => row) })),
  };
  return { service, manager };
}

const receiveDto = (branchId: string) => ({
  status: Order_status.CANCELLED,
  branch_id: branchId,
  courier_id: null,
  assigned_at: null,
  canceled_post_id: null,
});

describe('o10nrbkB (BG5) — cancelled_post_received manbasi va custody', () => {
  it('⭐ kuryer o`z filialiga jo`natgan pochta: manba — kuryer (ismi), «Andijon … Andijondan» emas; custody COURIER → BRANCH', async () => {
    const order = {
      id: '101',
      status: Order_status.CANCELLED_SENT,
      canceled_post_id: '55',
      branch_id: '10',
      holder_type: 'BRANCH',
      holder_branch_id: '10',
      holder_courier_id: null,
      courier_id: null,
    };
    const { service, manager } = makeService(order);
    await service.updateFull(
      '101',
      receiveDto('10'),
      {
        id: '25',
        roles: ['manager'],
        note: 'Canceled order received by branch manager',
        canceled_post_sender: {
          user_id: '7',
          role: 'COURIER',
          branch_id: '10',
        },
      },
      manager,
    );

    const tracking = service.custody.createTrackingEvent.mock.calls[0][0];
    expect(tracking.action).toBe('cancelled_post_received');
    expect(tracking.description).toBe(
      'Andijon filiali (AN, ID: 10) bekor qilingan pochtani kuryer Ali Valiyevdan qabul qildi',
    );
    expect(tracking.metadata).toMatchObject({
      canceled_post_id: '55',
      source_type: 'COURIER',
      source_user_id: '7',
      source_courier_id: '7',
      source_courier_name: 'Ali Valiyev',
      source_branch_id: '10',
      destination_branch_id: '10',
      received_by_hq: false,
      received_by: '25',
    });

    // Holder o'zgarmagan bo'lsa ham qabul custody hodisasi — bitta.
    expect(service.custody.createCustodyEvent).toHaveBeenCalledTimes(1);
    expect(service.custody.createCustodyEvent.mock.calls[0][0]).toMatchObject({
      order_id: '101',
      from_holder_type: 'COURIER',
      from_courier_id: '7',
      from_branch_id: '10',
      to_holder_type: 'BRANCH',
      to_branch_id: '10',
      to_courier_id: null,
      changed_by: '25',
      note: 'Canceled order received by branch manager',
    });
    // Pul/eslatma hisobi tegilmaydi: holder o'zgarmadi → last_handover_* yo'q.
    expect(order).not.toHaveProperty('last_handover_by');
  });

  it('⭐ filial menejeri HQ`ga jo`natgan pochta: manba — jo`natuvchi filial («HQ … Andijondan»), «HQ … HQdan» emas', async () => {
    const order = {
      id: '102',
      status: Order_status.CANCELLED_SENT,
      canceled_post_id: '77',
      branch_id: '1',
      holder_type: 'HQ',
      holder_branch_id: null,
      holder_courier_id: null,
      courier_id: null,
    };
    const { service, manager } = makeService(order);
    await service.updateFull(
      '102',
      receiveDto('1'),
      {
        id: '1',
        roles: ['admin'],
        note: 'Canceled order received by HQ and held for market handover',
        canceled_post_sender: {
          user_id: '8',
          role: 'MANAGER',
          branch_id: '10',
        },
      },
      manager,
    );

    const tracking = service.custody.createTrackingEvent.mock.calls[0][0];
    expect(tracking.description).toBe(
      'HQ bekor qilingan pochtani Andijon filiali (AN, ID: 10)dan qabul qildi',
    );
    expect(tracking.metadata).toMatchObject({
      source_type: 'BRANCH',
      source_user_id: '8',
      source_user_role: 'MANAGER',
      source_courier_id: null,
      source_branch_id: '10',
      source_branch: 'Andijon filiali (AN, ID: 10)',
      received_by_hq: true,
      received_by: '1',
    });
    expect(service.identityClient.send).not.toHaveBeenCalled();
    expect(service.custody.createCustodyEvent).toHaveBeenCalledTimes(1);
    expect(service.custody.createCustodyEvent.mock.calls[0][0]).toMatchObject({
      from_holder_type: 'BRANCH',
      from_branch_id: '10',
      from_courier_id: null,
      to_holder_type: 'HQ',
      to_branch_id: null,
      changed_by: '1',
    });
  });

  it('jo`natuvchi noma`lum (eski logistics): manba taxmin qilinmaydi, custody baribir yoziladi (oldingi holder → joriy)', async () => {
    const order = {
      id: '103',
      status: Order_status.CANCELLED_SENT,
      canceled_post_id: '77',
      branch_id: '1',
      holder_type: 'HQ',
      holder_branch_id: null,
      holder_courier_id: null,
      courier_id: null,
    };
    const { service, manager } = makeService(order);
    await service.updateFull(
      '103',
      receiveDto('1'),
      {
        id: '1',
        roles: ['admin'],
        note: 'Canceled order received by HQ and held for market handover',
      },
      manager,
    );
    const tracking = service.custody.createTrackingEvent.mock.calls[0][0];
    expect(tracking.description).toBe('HQ bekor qilingan pochtani qabul qildi');
    expect(tracking.metadata).toMatchObject({
      source_type: null,
      source_branch_id: null,
      source_branch: null,
    });
    expect(service.custody.createCustodyEvent).toHaveBeenCalledTimes(1);
    expect(service.custody.createCustodyEvent.mock.calls[0][0]).toMatchObject({
      from_holder_type: 'HQ',
      to_holder_type: 'HQ',
      changed_by: '1',
    });
  });

  it('regressiya: oddiy holat o`zgarishi (qabul emas) — custody faqat holder o`zgarsa, cancelled_post_received yo`q', async () => {
    const order = {
      id: '104',
      status: Order_status.CANCELLED,
      canceled_post_id: null,
      branch_id: '10',
      holder_type: 'BRANCH',
      holder_branch_id: '10',
      holder_courier_id: null,
      courier_id: null,
    };
    const { service, manager } = makeService(order);
    await service.updateFull(
      '104',
      { comment: 'izoh' },
      { id: '25', roles: ['manager'] },
      manager,
    );
    expect(service.custody.createTrackingEvent).not.toHaveBeenCalled();
    expect(service.custody.createCustodyEvent).not.toHaveBeenCalled();
  });
});

describe('o10nrbkB (BG5) — sof yordamchilar', () => {
  it('normalizeCanceledPostSender: id/rol tozalanadi, bo`sh — null', () => {
    expect(
      normalizeCanceledPostSender({
        user_id: ' 7 ',
        role: 'courier',
        branch_id: 10,
      }),
    ).toEqual({ user_id: '7', role: 'COURIER', branch_id: '10' });
    expect(normalizeCanceledPostSender(null)).toBeNull();
    expect(
      normalizeCanceledPostSender({ user_id: '0', role: 'X', branch_id: '' }),
    ).toBeNull();
    expect(
      normalizeCanceledPostSender({ user_id: 'abc', branch_id: '10' }),
    ).toEqual({ user_id: null, role: null, branch_id: '10' });
  });

  it('canceledPostReceiveCustodyFrom: kuryer / filial / noma`lum', () => {
    const previous = {
      holder_type: 'HQ' as const,
      branch_id: null,
      courier_id: null,
    };
    expect(
      canceledPostReceiveCustodyFrom(
        { user_id: '7', role: 'COURIER', branch_id: '10' },
        previous,
      ),
    ).toEqual({ holder_type: 'COURIER', branch_id: '10', courier_id: '7' });
    expect(
      canceledPostReceiveCustodyFrom(
        { user_id: '8', role: 'MANAGER', branch_id: '10' },
        previous,
      ),
    ).toEqual({ holder_type: 'BRANCH', branch_id: '10', courier_id: null });
    expect(canceledPostReceiveCustodyFrom(null, previous)).toBe(previous);
    expect(
      canceledPostReceiveCustodyFrom(
        { user_id: '8', role: null, branch_id: null },
        previous,
      ),
    ).toBe(previous);
  });
});
