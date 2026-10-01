import { of, throwError } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * FIX3 LC-03 — GET /post/new (newPosts) faqat HQ omboridagi yetim RECEIVED
 * buyurtmalarni HQ hudud pochtasiga oladi.
 *
 * Prod'da tasdiqlangan holat: HYBRID filial 22 paketni qabul qilgan (RECEIVED,
 * holder BRANCH/22, pochtasiz) buyurtma 65 HQ ning hudud NEW pochtasiga
 * biriktirilgan edi — pochta aralash doiraga ega bo'lib, HQ registratori uni
 * ocha olmay qolardi (403). HQ = '1'.
 */
describe('FIX3 LC-03 — newPosts yetim buyurtmalarni faqat HQ custody bo‘yicha oladi', () => {
  type Row = Record<string, unknown>;

  const orphan = (overrides: Row): Row => ({
    status: Order_status.RECEIVED,
    post_id: null,
    region_id: '14',
    total_price: 100_000,
    ...overrides,
  });

  function setup(options: {
    orphans: Row[];
    hqError?: boolean;
    existingNewPost?: Row | null;
  }) {
    const orderClient = {
      send: jest.fn(
        (pattern: { cmd: string }, payload: { id?: string; query?: Row }) => {
          if (pattern.cmd === 'order.find_all') {
            if (payload.query?.post_ids) {
              return of({ data: { data: [] } });
            }
            return of({ data: { data: options.orphans } });
          }
          if (pattern.cmd === 'order.update') {
            return of({ statusCode: 200 });
          }
          return of({});
        },
      ),
    };
    const branchClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'branch.find_hq') {
          return options.hqError
            ? throwError(() => new Error('branch-service down'))
            : of({ data: { id: '1' } });
        }
        return of({ data: null });
      }),
    };
    const postUpdateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const postRepo = {
      findOne: jest.fn((query: { where?: Row }) => {
        if (query?.where?.status === Post_status.NEW) {
          return Promise.resolve(
            options.existingNewPost === undefined
              ? {
                  id: 'p-region-14',
                  courier_id: '0',
                  region_id: '14',
                  branch_id: null,
                  status: Post_status.NEW,
                }
              : options.existingNewPost,
          );
        }
        return Promise.resolve(null);
      }),
      find: jest.fn((query?: { where?: Row }) => {
        // LOG-01: pochta mavjudligi tekshiruvi — bu spec'da ishora
        // qilingan pochtalar mavjud deb olinadi.
        const idFilter = query?.where?.id as { value?: unknown } | undefined;
        return Promise.resolve(
          idFilter && Array.isArray(idFilter.value)
            ? (idFilter.value as string[]).map((id) => ({ id }))
            : [],
        );
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

    const adoptedOrderIds = () =>
      orderClient.send.mock.calls
        .filter(([pattern]) => pattern.cmd === 'order.update')
        .map(([, payload]) => payload as { id: string; dto: Row })
        .filter(({ dto }) => 'post_id' in dto)
        .map(({ id }) => String(id));

    return {
      service,
      orderClient,
      branchClient,
      postRepo,
      postUpdateQb,
      activityLog,
      adoptedOrderIds,
    };
  }

  it('prod holati: HYBRID filial 22 qabul qilgan buyurtma HQ pochtasiga biriktirilmaydi', async () => {
    const ctx = setup({
      orphans: [
        orphan({
          id: '65',
          branch_id: '22',
          holder_type: 'BRANCH',
          holder_branch_id: '22',
        }),
      ],
    });

    const result: any = await ctx.service.newPosts(
      {},
      {
        id: '5',
        roles: ['registrator'],
      },
    );

    expect(result.statusCode).toBe(200);
    expect(ctx.adoptedOrderIds()).toEqual([]);
    // Hech qanday hisoblagich oshirilmaydi va auto_batch log yozilmaydi.
    expect(ctx.postUpdateQb.execute).not.toHaveBeenCalled();
    expect(ctx.activityLog.log).not.toHaveBeenCalled();
  });

  it('HQ paketni qabul qilgan (holder BRANCH/1) va HQ holderidagi buyurtmalar olinadi', async () => {
    const ctx = setup({
      orphans: [
        orphan({
          id: '201',
          branch_id: '1',
          holder_type: 'BRANCH',
          holder_branch_id: '1',
        }),
        orphan({
          id: '202',
          branch_id: '1',
          holder_type: 'HQ',
          holder_branch_id: null,
        }),
        // Doirasiz eski qator — HQ deb hisoblanadi (avvalgidek olinadi).
        orphan({ id: '203', branch_id: null, holder_type: null }),
        // Begona filial — olinmaydi.
        orphan({
          id: '204',
          branch_id: '21',
          holder_type: 'BRANCH',
          holder_branch_id: '21',
        }),
      ],
    });

    await ctx.service.newPosts({}, { id: '1', roles: ['superadmin'] });

    expect(ctx.adoptedOrderIds()).toEqual(['201', '202', '203']);
    expect(ctx.orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      { id: '201', dto: { post_id: 'p-region-14' }, requester: undefined },
    );
    // Hisoblagich faqat olingan 3 ta buyurtma bilan oshadi.
    const setArg = ctx.postUpdateQb.set.mock.calls[0][0] as Record<
      string,
      () => string
    >;
    expect(setArg.order_quantity()).toBe('order_quantity + 3');
    expect(setArg.post_total_price()).toBe('post_total_price + 300000');
  });

  it('holder_branch_id HQ dan boshqa bo‘lsa branch_id = HQ bo‘lsa ham olinmaydi (doira = holder_branch_id ?? branch_id)', async () => {
    const ctx = setup({
      orphans: [
        orphan({
          id: '301',
          branch_id: '1',
          holder_type: 'BRANCH',
          holder_branch_id: '22',
        }),
      ],
    });

    await ctx.service.newPosts({}, { id: '1', roles: ['admin'] });

    expect(ctx.adoptedOrderIds()).toEqual([]);
  });

  it('kuryer yoki marketdagi (COURIER/MARKET holder) RECEIVED qator olinmaydi', async () => {
    const ctx = setup({
      orphans: [
        orphan({
          id: '401',
          branch_id: '1',
          holder_type: 'COURIER',
          holder_branch_id: '1',
          holder_courier_id: '9',
        }),
        orphan({ id: '402', branch_id: '1', holder_type: 'MARKET' }),
      ],
    });

    await ctx.service.newPosts({}, { id: '1', roles: ['admin'] });

    expect(ctx.adoptedOrderIds()).toEqual([]);
  });

  it('HQ aniqlanmasa — hech narsa olinmaydi (fail closed), lekin ro‘yxat baribir qaytadi', async () => {
    const ctx = setup({
      orphans: [
        orphan({
          id: '501',
          branch_id: '1',
          holder_type: 'HQ',
        }),
      ],
      hqError: true,
    });

    const result: any = await ctx.service.newPosts(
      {},
      {
        id: '1',
        roles: ['admin'],
      },
    );

    expect(result.statusCode).toBe(200);
    expect(ctx.adoptedOrderIds()).toEqual([]);
  });

  it('yetim nomzod bo‘lmasa HQ so‘ralmaydi (ortiqcha RPC yo‘q)', async () => {
    const ctx = setup({
      orphans: [
        // Pochtasi bor yoki hududsiz — nomzod emas.
        orphan({ id: '601', post_id: 'p-x', branch_id: '1' }),
        orphan({ id: '602', region_id: null, branch_id: '1' }),
      ],
    });

    await ctx.service.newPosts({}, { id: '1', roles: ['admin'] });

    expect(ctx.adoptedOrderIds()).toEqual([]);
    expect(
      ctx.branchClient.send.mock.calls.filter(
        ([pattern]) => pattern.cmd === 'branch.find_hq',
      ),
    ).toHaveLength(0);
  });
});
