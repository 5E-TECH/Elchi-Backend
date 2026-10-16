import { Order_status, Post_status, Where_deliver } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * yokjwjXG — `GET /post/orders/:id` (logistics.post.orders_by_post) javobiga
 * pochtaning o'zi (`post: { id, status }`) qo'shildi: frontend savatni
 * (`POST /post/delete`) faqat `status = new` da ko'rsatadi. ADDITIVE — mavjud
 * maydonlar o'zgarmaydi.
 */
function makeService(post: Record<string, unknown>) {
  const service = Object.create(
    LogisticsServiceService.prototype,
  ) as LogisticsServiceService & Record<string, any>;
  const orders = [
    {
      id: '700',
      post_id: post.id,
      status: Order_status.RECEIVED,
      where_deliver: Where_deliver.ADDRESS,
      total_price: 100_000,
      branch_id: '1',
    },
    {
      id: '701',
      post_id: post.id,
      status: Order_status.RECEIVED,
      where_deliver: Where_deliver.CENTER,
      total_price: 50_000,
      branch_id: '1',
    },
  ];
  Object.assign(service, {
    postRepo: { findOne: jest.fn().mockResolvedValue({ ...post }) },
    findOrders: jest.fn((query: Record<string, unknown>) =>
      Promise.resolve(query.post_id ? orders : []),
    ),
    resolveScopedBranchId: jest.fn().mockResolvedValue(null),
  });
  return service;
}

describe('yokjwjXG — getPostOrders: post.status (additive)', () => {
  it.each([Post_status.NEW, Post_status.SENT])(
    'pochta %s — data.post = { id, status }, eski maydonlar joyida',
    async (status) => {
      const service = makeService({ id: '88', status, courier_id: '0' });

      const res: any = await service.getPostOrders('88', {
        id: '1',
        roles: ['superadmin'],
      } as never);

      // 4YZcTTDQ: `post` ga pochta meta'si (kuryer, QR, ...) QO'SHILDI —
      // yokjwjXG kontrakti (id, status) o'zgarmagan.
      expect(res.data.post).toMatchObject({ id: '88', status });
      expect(Object.keys(res.data).sort()).toEqual(
        ['allOrdersByPostId', 'centerOrders', 'homeOrders', 'post'].sort(),
      );
      expect(
        res.data.allOrdersByPostId.map((o: { id: string }) => o.id),
      ).toEqual(['700', '701']);
      expect(res.data.homeOrders).toEqual({
        homeOrders: 1,
        homeOrdersTotalPrice: 100_000,
      });
      expect(res.data.centerOrders).toEqual({
        centerOrders: 1,
        centerOrdersTotalPrice: 50_000,
      });
    },
  );
});
