import { Order_status } from '../../enums';
import {
  COURIER_LIST_HIDDEN_STATUSES,
  courierPostOrdersQuery,
} from './courier-order-list';
import * as courierOrderList from './courier-order-list';

/**
 * COURIER-SCAN (ega, 2026-11-17) — skan bilan olingan posilka WAITING, ya'ni
 * kuryer doirasi oddiy holat filtri bilan yetarli: 6qypMFeT dagi
 * ON_THE_ROAD istisnosi (`scan_taken_courier_id`) olib tashlandi.
 */
describe('COURIER-SCAN — kuryer doirasi (courierPostOrdersQuery)', () => {
  const POSTS = ['5', '6'];

  it('«Barchasi» (holatsiz): yashirin holatlar, ON_THE_ROAD ham', () => {
    expect(COURIER_LIST_HIDDEN_STATUSES).toContain(Order_status.ON_THE_ROAD);
    expect(courierPostOrdersQuery(POSTS)).toEqual({
      post_ids: POSTS,
      status: undefined,
      exclude_statuses: [...COURIER_LIST_HIDDEN_STATUSES],
    });
  });

  it('holat berilsa — aynan o‘sha holatlar, istisno maydonisiz', () => {
    const query = courierPostOrdersQuery(POSTS, [Order_status.WAITING]);
    expect(query).toEqual({
      post_ids: POSTS,
      status: [Order_status.WAITING],
      exclude_statuses: undefined,
    });
    expect(query).not.toHaveProperty('scan_taken_courier_id');
  });

  it('6qypMFeT aylanma kodi (isCourierScanTakenOrder) endi yo‘q', () => {
    expect(courierOrderList).not.toHaveProperty('isCourierScanTakenOrder');
  });
});
