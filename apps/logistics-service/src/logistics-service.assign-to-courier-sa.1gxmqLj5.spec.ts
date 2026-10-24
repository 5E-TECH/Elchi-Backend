import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * 1gxmqLj5 ((a) yo'l) — SUPERADMIN/ADMIN `POST /orders/assign-to-courier`.
 *
 * Ilgari servis so'rovchidan MANAGER/REGISTRATOR filial biriktiruvini
 * talab qilardi — SA/admin `/dispatch` sahifasini ko'rib, amalda 403 olardi.
 * Endi SA/admin uchun doira BUYURTMALARDAN olinadi:
 *  - barcha buyurtmalar BITTA filialda (holder_branch_id ?? branch_id);
 *  - kuryer AYNAN o'sha filialning COURIER a'zosi (boshqa filial kuryeri — 400);
 *  - ixtiyoriy `branch_id` (UI filial tanlovi) buyurtmalar filialiga mos.
 * Menejer/registrator xulqi o'zgarmaydi (`branch_id` ularga e'tiborsiz).
 */
type Row = Record<string, any>;

const order = (overrides: Row): Row => ({
  status: Order_status.RECEIVED,
  courier_id: null,
  post_id: null,
  total_price: 100_000,
  region_id: '1',
  ...overrides,
});

const BRANCH_USERS: Record<string, Row[]> = {
  '10': [
    { user_id: '44', role: 'COURIER' },
    { user_id: '77', role: 'MANAGER' },
  ],
  '20': [
    { user_id: '55', role: 'COURIER' },
    { user_id: '88', role: 'MANAGER' },
  ],
};

function setup(orders: Row[]) {
  const ordersMap = new Map(orders.map((o) => [String(o.id), { ...o }]));
  const orderClient = {
    send: jest.fn((pattern: { cmd: string }, payload: Row) => {
      if (pattern.cmd === 'order.find_by_id') {
        return of(ordersMap.get(String(payload.id)));
      }
      if (pattern.cmd === 'order.update') {
        Object.assign(ordersMap.get(String(payload.id)) ?? {}, payload.dto);
      }
      return of({ statusCode: 200 });
    }),
  };
  const branchClient = {
    send: jest.fn((pattern: { cmd: string }, payload: Row) => {
      if (pattern.cmd === 'branch.user.find_by_user') {
        // Menejer 77 — 10-filial; SA/admin uchun bu chaqirilmasligi kerak.
        return of({
          data:
            String(payload.user_id) === '77'
              ? { branch_id: '10', role: 'MANAGER' }
              : null,
        });
      }
      if (pattern.cmd === 'branch.user.find_by_branch') {
        return of({ data: BRANCH_USERS[String(payload.branch_id)] ?? [] });
      }
      return of({ data: null });
    }),
  };
  const identityClient = {
    send: jest.fn((_pattern: { cmd: string }, payload: Row) =>
      of({
        data: (payload.ids as string[]).map((id) => ({ id, status: 'active' })),
      }),
    ),
  };
  const postRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((payload: Row) => payload),
    save: jest.fn((entity: Row) =>
      Promise.resolve({ ...entity, id: entity.id ?? 'p-new' }),
    ),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new LogisticsServiceService(
    postRepo as any,
    {} as any,
    {} as any,
    orderClient as any,
    branchClient as any,
    identityClient as any,
    { send: jest.fn(() => of({})) } as any,
    activityLog as any,
  );
  const calls = (client: { send: jest.Mock }, cmd: string) =>
    (client.send.mock.calls as Array<[{ cmd: string }, Row]>).filter(
      ([pattern]) => pattern.cmd === cmd,
    );
  return {
    service,
    orderClient,
    branchClient,
    postRepo,
    activityLog,
    ordersMap,
    updates: () => calls(orderClient, 'order.update'),
    branchCalls: (cmd: string) => calls(branchClient, cmd),
  };
}

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
  }
  throw new Error('RpcException kutilgan edi');
}

const SA = { id: '1', roles: ['superadmin'] };
const ADMIN = { id: '2', roles: ['admin'] };
const MANAGER = { id: '77', roles: ['manager'] };

describe('1gxmqLj5 — assign-to-courier SUPERADMIN/ADMIN', () => {
  it.each([
    ['superadmin', SA],
    ['admin', ADMIN],
  ])(
    '⭐ %s — boshqa filial (20) posilkalarini o‘sha filial kuryeriga biriktiradi',
    async (_label, requester) => {
      const ctx = setup([
        order({ id: '201', branch_id: '20' }),
        order({ id: '202', branch_id: '20', status: Order_status.NEW }),
      ]);

      const res: any = await ctx.service.assignOrdersToCourier(requester, {
        order_ids: ['201', '202'],
        courier_id: '55',
      });

      expect(res.statusCode).toBe(200);
      expect(res.data).toMatchObject({
        assigned_count: 2,
        courier_id: '55',
        post_created: true,
      });
      // Filial biriktiruvi so'ralmaydi; kuryer a'zoligi BUYURTMALAR filialida.
      expect(ctx.branchCalls('branch.user.find_by_user')).toHaveLength(0);
      expect(
        ctx
          .branchCalls('branch.user.find_by_branch')
          .map(([, p]) => p.branch_id),
      ).toEqual(['20']);
      expect(ctx.ordersMap.get('201')).toMatchObject({
        courier_id: '55',
        status: Order_status.ON_THE_ROAD,
      });
      expect(ctx.postRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ courier_id: '55', status: Post_status.SENT }),
      );
      expect(ctx.activityLog.log.mock.calls[0][0].metadata.branch_id).toBe(
        '20',
      );
    },
  );

  it('holder_branch_id ustun (filialdan filialga o‘tgan posilka)', async () => {
    const ctx = setup([
      order({ id: '201', branch_id: '10', holder_branch_id: '20' }),
    ]);

    const res: any = await ctx.service.assignOrdersToCourier(SA, {
      order_ids: ['201'],
      courier_id: '55',
    });

    expect(res.data.assigned_count).toBe(1);
  });

  it('⭐ kuryer boshqa filial a’zosi (10-filial kuryeri, 20-filial posilkasi) — 400, hech narsa yozilmaydi', async () => {
    const ctx = setup([order({ id: '201', branch_id: '20' })]);

    const error = await rpcError(
      ctx.service.assignOrdersToCourier(SA, {
        order_ids: ['201'],
        courier_id: '44',
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('COURIER sifatida biriktirilmagan');
    expect(ctx.updates()).toHaveLength(0);
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
  });

  it('⭐ aralash filial posilkalari — 400, hech narsa yozilmaydi', async () => {
    const ctx = setup([
      order({ id: '201', branch_id: '20' }),
      order({ id: '101', branch_id: '10' }),
    ]);

    const error = await rpcError(
      ctx.service.assignOrdersToCourier(SA, {
        order_ids: ['201', '101'],
        courier_id: '55',
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('aralash filialdan');
    expect(ctx.updates()).toHaveLength(0);
  });

  it('tanlangan branch_id mos — biriktiriladi', async () => {
    const ctx = setup([order({ id: '201', branch_id: '20' })]);

    const res: any = await ctx.service.assignOrdersToCourier(SA, {
      order_ids: ['201'],
      courier_id: '55',
      branch_id: '20',
    });

    expect(res.data.assigned_count).toBe(1);
  });

  it('⭐ tanlangan branch_id mos emas — 400, kuryer/yozuv tekshiruvigacha', async () => {
    const ctx = setup([order({ id: '201', branch_id: '20' })]);

    const error = await rpcError(
      ctx.service.assignOrdersToCourier(SA, {
        order_ids: ['201'],
        courier_id: '44',
        branch_id: '10',
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('Tanlangan filial');
    expect(ctx.branchCalls('branch.user.find_by_branch')).toHaveLength(0);
    expect(ctx.updates()).toHaveLength(0);
  });

  it('filialsiz posilka — 400', async () => {
    const ctx = setup([order({ id: '201', branch_id: null })]);

    const error = await rpcError(
      ctx.service.assignOrdersToCourier(SA, {
        order_ids: ['201'],
        courier_id: '55',
      }),
    );

    expect(error).toMatchObject({
      statusCode: 400,
      message: 'Order(lar) filialga biriktirilmagan',
    });
  });

  it('SA uchun ham status qoidasi: SOLD posilka — 400', async () => {
    const ctx = setup([
      order({ id: '201', branch_id: '20', status: Order_status.SOLD }),
    ]);

    const error = await rpcError(
      ctx.service.assignOrdersToCourier(SA, {
        order_ids: ['201'],
        courier_id: '55',
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(ctx.updates()).toHaveLength(0);
  });
});

describe('1gxmqLj5 — menejer xulqi o‘zgarmagan', () => {
  it('⭐ menejer boshqa filial posilkasi — avvalgidek 403; branch_id yuborsa ham doira kengaymaydi', async () => {
    const ctx = setup([order({ id: '201', branch_id: '20' })]);

    const error = await rpcError(
      ctx.service.assignOrdersToCourier(MANAGER, {
        order_ids: ['201'],
        courier_id: '44',
        branch_id: '20',
      }),
    );

    expect(error.statusCode).toBe(403);
    // Kuryer a'zoligi menejerning O'Z filialida tekshirildi.
    expect(
      ctx.branchCalls('branch.user.find_by_branch').map(([, p]) => p.branch_id),
    ).toEqual(['10']);
    expect(ctx.updates()).toHaveLength(0);
  });

  it('menejer o‘z filiali — avvalgidek biriktiradi', async () => {
    const ctx = setup([order({ id: '101', branch_id: '10' })]);

    const res: any = await ctx.service.assignOrdersToCourier(MANAGER, {
      order_ids: ['101'],
      courier_id: '44',
    });

    expect(res.data.assigned_count).toBe(1);
    expect(ctx.branchCalls('branch.user.find_by_user')).toHaveLength(1);
  });

  it('filialga biriktirilmagan boshqa rol (kuryer) — avvalgidek 403', async () => {
    const ctx = setup([order({ id: '101', branch_id: '10' })]);

    const error = await rpcError(
      ctx.service.assignOrdersToCourier(
        { id: '44', roles: ['courier'] },
        { order_ids: ['101'], courier_id: '44' },
      ),
    );

    expect(error.statusCode).toBe(403);
  });
});
