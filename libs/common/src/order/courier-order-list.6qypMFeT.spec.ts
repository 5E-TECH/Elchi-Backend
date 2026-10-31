import { Order_status } from '../../enums';
import {
  COURIER_LIST_HIDDEN_STATUSES,
  courierPostOrdersQuery,
  isCourierScanTakenOrder,
} from './courier-order-list';

/**
 * 6qypMFeT — kuryer skan bilan O'ZI olgan posilka qo'lida: u yashirin
 * ON_THE_ROAD ro'yxatidan istisno. Jo'natilgan, hali qabul qilinmagan pochta
 * esa avvalgidek yashirin qoladi.
 */
describe('6qypMFeT — kuryer doirasi: skan bilan olingan posilka', () => {
  const POSTS = ['5', '6'];

  it('ON_THE_ROAD yashirinligicha qoladi (qabul qilinmagan pochta chiqmaydi)', () => {
    expect(COURIER_LIST_HIDDEN_STATUSES).toContain(Order_status.ON_THE_ROAD);
    expect(courierPostOrdersQuery(POSTS, undefined, '77')).toMatchObject({
      exclude_statuses: expect.arrayContaining([Order_status.ON_THE_ROAD]),
    });
  });

  it('«Barchasi» (holatsiz) va «Kutilayotgan» (waiting) — kuryer id bilan', () => {
    expect(
      courierPostOrdersQuery(POSTS, undefined, '77').scan_taken_courier_id,
    ).toBe('77');
    expect(
      courierPostOrdersQuery(POSTS, [Order_status.WAITING], '77')
        .scan_taken_courier_id,
    ).toBe('77');
  });

  it('boshqa holat tanlansa (sotilgan) — qo‘shilmaydi', () => {
    expect(
      courierPostOrdersQuery(POSTS, [Order_status.SOLD], '77'),
    ).not.toHaveProperty('scan_taken_courier_id');
  });

  it('kuryer id siz — eski so‘rov aynan saqlanadi', () => {
    expect(courierPostOrdersQuery(POSTS)).toEqual({
      post_ids: POSTS,
      status: undefined,
      exclude_statuses: [...COURIER_LIST_HIDDEN_STATUSES],
    });
  });

  describe('isCourierScanTakenOrder', () => {
    const taken = {
      status: Order_status.ON_THE_ROAD,
      holder_type: 'COURIER',
      holder_courier_id: '77',
      last_handover_by: '77',
      return_requested: false,
    };

    it('kuryer o‘zi olgan ON_THE_ROAD → true', () => {
      expect(isCourierScanTakenOrder(taken, '77')).toBe(true);
    });

    it.each([
      ['menejer biriktirgan / pochta jo‘natilgan', { last_handover_by: '500' }],
      ['boshqa kuryer qo‘lida', { holder_courier_id: '88' }],
      ['ushlovchi filial', { holder_type: 'BRANCH' }],
      ['pochta qabulida rad etilgan', { return_requested: true }],
      ['holat WAITING (oddiy qator)', { status: Order_status.WAITING }],
    ])('%s → false', (_name, patch) => {
      expect(isCourierScanTakenOrder({ ...taken, ...patch }, '77')).toBe(false);
    });

    it('bo‘sh kuryer id → false', () => {
      expect(isCourierScanTakenOrder(taken, '')).toBe(false);
    });
  });
});
