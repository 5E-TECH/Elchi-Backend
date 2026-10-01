import { of } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * fix3b (lead) LOG-01 — GET /post/new (newPosts):
 *
 *  1. O'chirilgan pochtaga ishora qiladigan HQ omboridagi RECEIVED buyurtma
 *     yetim hisoblanadi va o'z hudud pochtasiga qaytadi (ilgari faqat
 *     `post_id IS NULL` olinardi — bunday buyurtma hech bir kartada
 *     ko'rinmay qolardi).
 *  2. Dublikat NEW pochta o'chirishdan oldin qayta tekshiriladi: ko'chirish
 *     davomida unga yozilgan buyurtmalar ham ko'chiriladi; hali ishora
 *     qilinayotgan dublikat o'chirilmaydi.
 */
type Row = Record<string, unknown>;

function setup(options: {
  orphans?: Row[];
  existingPostIds?: string[];
  newPosts?: Row[];
  /** `post_ids: [id]` so'rovlariga navbat bilan qaytariladigan javoblar. */
  postOrderQueues?: Record<string, Row[][]>;
}) {
  const queues = options.postOrderQueues ?? {};
  const orderClient = {
    send: jest.fn(
      (pattern: { cmd: string }, payload: { id?: string; query?: Row }) => {
        if (pattern.cmd === 'order.find_all') {
          const postIds = payload.query?.post_ids as string[] | undefined;
          if (postIds) {
            if (postIds.length === 1 && queues[postIds[0]]) {
              const queue = queues[postIds[0]];
              const next = queue.length > 1 ? queue.shift() : queue[0];
              return of({ data: { data: next ?? [] } });
            }
            return of({ data: { data: [] } });
          }
          return of({ data: { data: options.orphans ?? [] } });
        }
        if (pattern.cmd === 'order.update') {
          return of({ statusCode: 200 });
        }
        return of({});
      },
    ),
  };
  const branchClient = {
    send: jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'branch.find_hq'
        ? of({ data: { id: '1' } })
        : of({ data: null }),
    ),
  };
  const postUpdateQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const postRepo = {
    findOne: jest.fn((query: { where?: Row }) =>
      Promise.resolve(
        query?.where?.status === Post_status.NEW
          ? {
              id: 'p-region-14',
              courier_id: '0',
              region_id: '14',
              branch_id: null,
              status: Post_status.NEW,
            }
          : null,
      ),
    ),
    find: jest.fn((query?: { where?: Row }) => {
      const idFilter = query?.where?.id as { value?: unknown } | undefined;
      if (idFilter && Array.isArray(idFilter.value)) {
        const existing = new Set(options.existingPostIds ?? []);
        return Promise.resolve(
          (idFilter.value as string[])
            .filter((id) => existing.has(id))
            .map((id) => ({ id })),
        );
      }
      if (query?.where?.status === Post_status.NEW) {
        return Promise.resolve(options.newPosts ?? []);
      }
      return Promise.resolve([]);
    }),
    create: jest.fn((payload: Row) => payload),
    save: jest.fn((entity: Row) =>
      Promise.resolve({ ...entity, id: entity.id ?? 'p-created' }),
    ),
    remove: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(() => postUpdateQb),
  };
  const regionRepo = { find: jest.fn().mockResolvedValue([]) };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };

  const service = new LogisticsServiceService(
    postRepo as any,
    regionRepo as any,
    {} as any,
    orderClient as any,
    branchClient as any,
    { send: jest.fn(() => of({})) } as any,
    { send: jest.fn(() => of({})) } as any,
    activityLog as any,
  );

  const movedTo = () =>
    orderClient.send.mock.calls
      .filter(([pattern]) => pattern.cmd === 'order.update')
      .map(([, payload]) => payload as { id: string; dto: Row })
      .filter(({ dto }) => 'post_id' in dto)
      .map(({ id, dto }) => `${id}->${String(dto.post_id)}`);

  return { service, postRepo, movedTo };
}

const SA = { id: '1', roles: ['superadmin'] };

const hqOrphan = (overrides: Row): Row => ({
  status: Order_status.RECEIVED,
  post_id: null,
  region_id: '14',
  total_price: 100_000,
  branch_id: '1',
  holder_type: 'HQ',
  holder_branch_id: null,
  ...overrides,
});

describe("fix3b lead LOG-01 — o'chirilgan pochtaga ishora qiluvchi buyurtma qayta olinadi", () => {
  it("pochtasi o'chirilgan HQ buyurtmasi hudud pochtasiga qaytadi; mavjud pochtadagisi tegilmaydi", async () => {
    const ctx = setup({
      orphans: [
        hqOrphan({ id: '701', post_id: 'p-gone' }),
        hqOrphan({ id: '702', post_id: 'p-live' }),
        hqOrphan({ id: '703', post_id: null }),
      ],
      existingPostIds: ['p-live'],
    });

    await ctx.service.newPosts({}, SA);

    expect(ctx.movedTo()).toEqual(['701->p-region-14', '703->p-region-14']);
  });

  it('boshqa filial omboridagi buyurtma pochtasi o`chgan bo`lsa ham olinmaydi (LC-03)', async () => {
    const ctx = setup({
      orphans: [
        hqOrphan({
          id: '801',
          post_id: 'p-gone',
          branch_id: '22',
          holder_type: 'BRANCH',
          holder_branch_id: '22',
        }),
      ],
    });

    await ctx.service.newPosts({}, SA);

    expect(ctx.movedTo()).toEqual([]);
  });
});

describe("fix3b lead LOG-01 — dublikat NEW pochta o'chirishdan oldin qayta tekshiriladi", () => {
  const posts = () => [
    {
      id: 'p-dup',
      region_id: '14',
      branch_id: null,
      status: Post_status.NEW,
      createdAt: new Date('2026-10-01T09:05:00Z'),
    },
    {
      id: 'p-main',
      region_id: '14',
      branch_id: null,
      status: Post_status.NEW,
      createdAt: new Date('2026-10-01T09:00:00Z'),
    },
  ];
  const o = (id: string) => ({ id, total_price: 50_000 });

  it("ko'chirish paytida dublikatga tushgan buyurtma ham ko'chiriladi, keyin dublikat o'chadi", async () => {
    const ctx = setup({
      newPosts: posts(),
      postOrderQueues: {
        // snapshot: o1; qayta tekshiruv: kechikkan o2; so'ng bo'sh.
        'p-dup': [[o('o1')], [o('o2')], []],
        'p-main': [[o('o1'), o('o2')]],
      },
    });

    await ctx.service.newPosts({}, SA);

    expect(ctx.movedTo()).toEqual(['o1->p-main', 'o2->p-main']);
    expect(ctx.postRepo.remove).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p-dup' }),
    );
    expect(ctx.postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'p-main',
        order_quantity: 2,
        post_total_price: 100_000,
      }),
    );
  });

  it("hali buyurtma ishora qilayotgan dublikat o'chirilmaydi (keyingi yuklashda birlashadi)", async () => {
    const ctx = setup({
      newPosts: posts(),
      postOrderQueues: {
        'p-dup': [[o('o1')], [o('o2')], [o('o3')]],
        'p-main': [[o('o1'), o('o2')]],
      },
    });

    await ctx.service.newPosts({}, SA);

    expect(ctx.postRepo.remove).not.toHaveBeenCalled();
    expect(ctx.postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p-main', order_quantity: 2 }),
    );
  });
});
