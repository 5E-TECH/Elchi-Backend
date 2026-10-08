/**
 * fix3b (LC-03 alomati) — HQ qabuli (`receiveNewOrders`) FILIALDA TURGAN
 * buyurtmani olmaydi.
 *
 * SA/ADMIN (doira yo'q) va HQ registratori qabuli buyurtmani HQ hudud
 * pochtasiga qo'yadi. Saqlanishi (custody) HQ'dan boshqa filialda bo'lgan NEW
 * buyurtma (filial xodimi yaratgan) shu yo'l bilan qabul qilinsa u HQ hudud
 * pochtasiga yopishib qolardi (jonli: #65 — HYBRID filial 22). Endi 400
 * "Bu buyurtma filialda turibdi — uni o'sha filial qabul qiladi", butun
 * so'rov rad etiladi va logistikaga hech narsa yuborilmaydi.
 */
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: jest.fn() };
});

import { RpcException } from '@nestjs/microservices';
import { Order_status, rmqSend as rmqSendFn } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderHolderType, Order_source } from './entities/order.entity';

const rmqSend = rmqSendFn as unknown as jest.Mock;

type Row = Record<string, unknown>;
type RpcBody = { statusCode?: number; message?: string };

const HQ_ID = '1';
const SUPERADMIN = { id: '1', roles: ['superadmin'] };
const ADMIN = { id: '2', roles: ['admin'] };
const REGISTRATOR = { id: '301', roles: ['registrator'] };
const MANAGER = { id: '201', roles: ['manager'] };

async function rpcError(promise: Promise<unknown>): Promise<RpcBody> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as RpcBody;
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

const order = (over: Row = {}): Row => ({
  id: '65',
  status: Order_status.NEW,
  source: Order_source.INTERNAL,
  customer_id: 'c1',
  district_id: '12',
  total_price: 100000,
  branch_id: HQ_ID,
  holder_type: OrderHolderType.HQ,
  holder_branch_id: null,
  ...over,
});

const BRANCH_HELD = order({
  id: '65',
  branch_id: '22',
  holder_type: OrderHolderType.BRANCH,
  holder_branch_id: '22',
});
const HQ_HELD = order({ id: '66' });

function makeSvc(
  rows: Row[],
  opts: { scope?: string | null; hqId?: string | null } = {},
) {
  rmqSend.mockReset();
  rmqSend.mockImplementation((_client: unknown, pattern: { cmd: string }) => {
    switch (pattern.cmd) {
      case 'identity.customer.find_by_ids':
        return Promise.resolve({ data: [{ id: 'c1' }] });
      case 'logistics.district.find_by_ids':
        return Promise.resolve({ data: [{ id: '12', assigned_region: '5' }] });
      case 'logistics.post.receive_orders':
        return Promise.resolve({
          data: rows.map((row) => ({
            order_id: String(row.id),
            post_id: '9001',
          })),
        });
      default:
        return Promise.resolve(null);
    }
  });

  const qb = {
    update: jest.fn(() => qb),
    set: jest.fn(() => qb),
    where: jest.fn(() => qb),
    execute: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      createQueryBuilder: jest.fn(() => qb),
      getRepository: jest.fn(() => ({})),
    },
  };
  const s = Object.create(OrderLifecycleService.prototype) as Record<
    string,
    any
  >;
  Object.assign(s, {
    orderRepo: {
      find: jest.fn(() => Promise.resolve(rows.map((r) => ({ ...r })))),
    },
    identityClient: {},
    logisticsClient: {},
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    resolveReceiveBranchScope: jest
      .fn()
      .mockResolvedValue(opts.scope === undefined ? null : opts.scope),
    lookup: {
      getHqBranchId: jest
        .fn()
        .mockResolvedValue(opts.hqId === undefined ? HQ_ID : opts.hqId),
    },
    custody: {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn((roles?: string[]) => roles?.[0] ?? 'system'),
    },
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
  });
  const receive = (requester: Row, ids = rows.map((r) => String(r.id))) =>
    (s as unknown as OrderLifecycleService).receiveNewOrders(
      ids,
      undefined,
      requester as never,
    );
  const sentCmds = () =>
    rmqSend.mock.calls.map((call) => (call[1] as { cmd: string }).cmd);
  return { s, receive, sentCmds, queryRunner, qb };
}

describe('fix3b — HQ qabuli filialda turgan buyurtmani rad etadi', () => {
  it.each([
    ['superadmin', SUPERADMIN, null],
    ['admin', ADMIN, null],
    ['HQ registratori', REGISTRATOR, HQ_ID],
  ])(
    '⭐ %s: filialda (22) turgan NEW buyurtma — 400, logistikaga hech narsa ketmaydi',
    async (_label, requester, scope) => {
      const h = makeSvc([BRANCH_HELD], { scope });

      const error = await rpcError(h.receive(requester));

      expect(error.statusCode).toBe(400);
      expect(error.message).toContain(
        "Bu buyurtma filialda turibdi — uni o'sha filial qabul qiladi",
      );
      expect(error.message).toContain('#65');
      expect(h.sentCmds()).toEqual([]);
      expect(h.queryRunner.startTransaction).not.toHaveBeenCalled();
    },
  );

  it('⭐ aralash to`da (HQ + filial) — BUTUN so`rov rad etiladi, HQ buyurtmasi ham qabul qilinmaydi', async () => {
    const h = makeSvc([HQ_HELD, BRANCH_HELD], { scope: null });

    const error = await rpcError(h.receive(SUPERADMIN));

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('#65');
    expect(error.message).not.toContain('#66');
    expect(h.sentCmds()).not.toContain('logistics.post.receive_orders');
  });

  it('HQ aniqlanmasa ham (kesh sovuq) SA uchun filial ushlovchisi rad etiladi (fail-closed)', async () => {
    const h = makeSvc([BRANCH_HELD], { scope: null, hqId: null });

    const error = await rpcError(h.receive(SUPERADMIN));

    expect(error.statusCode).toBe(400);
  });

  it('HQ da turgan market buyurtmasi — avvalgidek qabul qilinadi', async () => {
    const h = makeSvc([HQ_HELD], { scope: null });

    await expect(h.receive(SUPERADMIN)).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(h.sentCmds()).toContain('logistics.post.receive_orders');
  });

  it('⭐ o`sha filial menejeri o`z filialidagi buyurtmani avvalgidek qabul qiladi', async () => {
    const h = makeSvc([BRANCH_HELD], { scope: '22' });

    await expect(h.receive(MANAGER)).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(h.sentCmds()).toContain('logistics.post.receive_orders');
  });

  it('filial menejeri: HQ id aniqlanmasa ham o`z buyurtmasi to`silmaydi', async () => {
    const h = makeSvc([BRANCH_HELD], { scope: '22', hqId: null });

    await expect(h.receive(MANAGER)).resolves.toMatchObject({
      statusCode: 200,
    });
  });

  it('filialda turgan buyurtma bo`lmasa HQ id umuman so`ralmaydi', async () => {
    const h = makeSvc([HQ_HELD], { scope: null });

    await h.receive(SUPERADMIN);

    expect(
      (h.s.lookup as { getHqBranchId: jest.Mock }).getHqBranchId,
    ).not.toHaveBeenCalled();
  });

  /**
   * rTzcjrdo — qabul mas'uliyat zanjirini MUHRLAYDI: kim, qachon, kimga.
   * Ilgari `last_handover_at` yaratilish vaqtida, `last_handover_by` null
   * qolardi.
   */
  it('⭐ qabul last_handover_at/by va HQ ushlovchisini yozadi', async () => {
    const h = makeSvc([HQ_HELD], { scope: null });
    const before = Date.now();

    await h.receive(SUPERADMIN);

    const set = (h.qb.set.mock.calls as unknown as Array<[Row]>)[0][0];
    expect(set).toMatchObject({
      status: Order_status.RECEIVED,
      holder_type: OrderHolderType.HQ,
      holder_branch_id: null,
      last_handover_by: SUPERADMIN.id,
    });
    expect((set.last_handover_at as Date).getTime()).toBeGreaterThanOrEqual(
      before,
    );
    const tracking = (h.s.custody as { createTrackingEvent: jest.Mock })
      .createTrackingEvent.mock.calls[0][0] as Row;
    expect(tracking.changed_by).toBe(SUPERADMIN.id);
  });

  it('filial menejeri qabulida ushlovchi o`sha filial, custody hodisasi ochiladi', async () => {
    const h = makeSvc([order({ id: '67', branch_id: '22' })], { scope: '22' });

    await h.receive(MANAGER);

    const set = (h.qb.set.mock.calls as unknown as Array<[Row]>)[0][0];
    expect(set).toMatchObject({
      holder_type: OrderHolderType.BRANCH,
      holder_branch_id: '22',
      last_handover_by: MANAGER.id,
    });
    const custody = h.s.custody as { createCustodyEvent: jest.Mock };
    expect(custody.createCustodyEvent).toHaveBeenCalledTimes(1);
    expect(custody.createCustodyEvent.mock.calls[0][0]).toMatchObject({
      from_holder_type: OrderHolderType.HQ,
      to_holder_type: OrderHolderType.BRANCH,
      to_branch_id: '22',
      changed_by: MANAGER.id,
    });
  });
});
