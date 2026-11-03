import { of } from 'rxjs';
import { Order_status, Post_status, startOfTashkentDay } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * Egasi qarori (2026-11-03, BeePost kabi): filial va kuryerning pochta
 * sahifasida har kun — alohida karta. Shuning uchun ochiq pochtaga faqat SHU
 * Toshkent kunida qo'shiladi: HQ → filial o'tkazmasi, kuryer qaytarishi va
 * bekor pochta guruhi kechagi pochta bilan qo'shilmaydi.
 */
describe('har kun — alohida pochta (Toshkent kuni)', () => {
  type Row = Record<string, unknown>;
  const today = () => startOfTashkentDay(new Date());
  const yesterday = () => new Date(Date.now() - 36 * 60 * 60 * 1000);

  function makeService(options: {
    postRepo: Row;
    orderClient?: Row;
    branchClient?: Row;
  }) {
    return new LogisticsServiceService(
      options.postRepo as any,
      {} as any,
      {} as any,
      (options.orderClient ?? { send: jest.fn(() => of({})) }) as any,
      (options.branchClient ?? {
        send: jest.fn(() => of({ data: null })),
      }) as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined), query: jest.fn() } as any,
    );
  }

  it('HQ → filial o‘tkazmasi: faqat bugungi kuryersiz SENT pochtaga qo‘shiladi', async () => {
    const postRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((post: Row) => Promise.resolve({ ...post, id: '501' })),
    };
    const service = makeService({ postRepo });

    await service.receiveOrdersIntoPosts([
      {
        order_id: '1',
        assigned_region: '14',
        total_price: 100_000,
        assigned_branch: '10',
        assigned_post_status: Post_status.SENT,
      },
    ]);

    const where = postRepo.findOne.mock.calls[0][0].where;
    expect(where).toEqual(
      expect.objectContaining({
        region_id: '14',
        status: Post_status.SENT,
        branch_id: '10',
        courier_id: '0',
      }),
    );
    expect(where.createdAt?.type).toBe('moreThanOrEqual');
    expect(where.createdAt?.value).toEqual(today());
  });

  it('HQ hudud (NEW) pochtasi kun bilan cheklanmaydi', async () => {
    const postRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((post: Row) => Promise.resolve({ ...post, id: '502' })),
    };
    const service = makeService({ postRepo });

    await service.receiveOrdersIntoPosts([
      { order_id: '1', assigned_region: '14', total_price: 100_000 },
    ]);

    expect(postRepo.findOne.mock.calls[0][0].where.createdAt).toBeUndefined();
  });

  it('kuryer qaytarishi: faqat bugungi ochiq bekor pochtaga qo‘shiladi', async () => {
    const postRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((post: Row) => Promise.resolve({ ...post, id: '601' })),
      find: jest.fn().mockResolvedValue([]),
    };
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) =>
        pattern.cmd === 'order.find_by_id'
          ? of({
              id: '7',
              status: Order_status.CANCELLED,
              courier_id: '44',
              holder_type: 'COURIER',
              holder_courier_id: '44',
              branch_id: '10',
              total_price: 100_000,
              region_id: '14',
            })
          : of({ statusCode: 200 }),
      ),
    };
    const branchClient = {
      send: jest.fn(() =>
        of({ data: { branch_id: '10', role: 'COURIER', user_id: '44' } }),
      ),
    };
    const service = makeService({ postRepo, orderClient, branchClient });

    await service.createCanceledPost(
      { id: '44', roles: ['courier'] },
      { order_ids: ['7'] },
    );

    const where = postRepo.findOne.mock.calls[0][0].where;
    expect(where).toEqual(
      expect.objectContaining({
        courier_id: '44',
        branch_id: '10',
        status: Post_status.CANCELED,
      }),
    );
    expect(where.createdAt?.type).toBe('moreThanOrEqual');
    expect(where.createdAt?.value).toEqual(today());
  });

  it('bekor pochta guruhi: boshqa kunning ochiq pochtasi qo‘shilmaydi', async () => {
    const source = {
      id: '70',
      courier_id: '44',
      branch_id: '10',
      region_id: '14',
      status: Post_status.CANCELED,
      createdAt: new Date(),
    };
    const sameDay = { ...source, id: '71' };
    const otherDay = { ...source, id: '72', createdAt: yesterday() };
    const postRepo = {
      find: jest.fn().mockResolvedValue([source, sameDay, otherDay]),
    };
    const orderClient = {
      send: jest.fn((_pattern: { cmd: string }, payload: { query: Row }) =>
        of({
          data: {
            data: [
              {
                id: `o-${String(payload.query.canceled_post_id)}`,
                status: Order_status.CANCELLED_SENT,
                canceled_post_id: payload.query.canceled_post_id,
              },
            ],
          },
        }),
      ),
    };
    const service = makeService({ postRepo, orderClient });

    const group = await (service as any).findCanceledPostGroup(source);

    expect(group.posts.map(({ id }: Row) => id)).toEqual(['70', '71']);
    expect(group.orders.map(({ id }: Row) => id)).toEqual(['o-70', 'o-71']);
  });
});
