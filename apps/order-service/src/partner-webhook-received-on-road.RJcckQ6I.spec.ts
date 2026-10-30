/**
 * T1 K3 (RJcckQ6I) — hamkorga `received` va `on the road` webhooklari.
 *
 * - HQ qabuli (`receiveNewOrders`) → `external_id` li har buyurtma uchun
 *   BITTA `received`; integration ishlamasa ham qabul javobi 200.
 * - `updateFull` orqali ON_THE_ROAD (pochta jo'natilishi) → `on_the_road`.
 * - Filiallararo FORWARD paket (xom UPDATE) → `on_the_road`.
 * - Eski adapter yo'li (`integration.sync.enqueue`) bu harakatlarni OLMAYDI.
 * - `external_id` siz buyurtma → hech qanday chaqiruv yo'q.
 */
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: jest.fn() };
});

import {
  BranchTransferBatchStatus,
  BranchTransferDirection,
  Order_status,
  rmqSend as rmqSendFn,
} from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { BranchTransferBatchService } from './transfer-batch/branch-transfer-batch.service';
import { OrderHolderType, Order_source } from './entities/order.entity';

const rmqSend = rmqSendFn as unknown as jest.Mock;
type Row = Record<string, unknown>;

const flush = () => new Promise((resolve) => setImmediate(resolve));

const partnerCalls = () =>
  rmqSend.mock.calls.filter(
    ([, pattern]) =>
      (pattern as { cmd: string }).cmd ===
      'integration.partner.webhook.enqueue',
  );
const legacyCalls = () =>
  rmqSend.mock.calls.filter(
    ([, pattern]) =>
      (pattern as { cmd: string }).cmd === 'integration.sync.enqueue',
  );

const order = (over: Row = {}): Row => ({
  id: '31',
  status: Order_status.NEW,
  source: Order_source.INTERNAL,
  customer_id: 'c1',
  district_id: '120',
  region_id: '13',
  total_price: 100000,
  paid_amount: 0,
  branch_id: '1',
  holder_type: OrderHolderType.HQ,
  holder_branch_id: null,
  external_id: null,
  operator: null,
  ...over,
});

function lifecycleWith(over: Row = {}) {
  const s = Object.create(OrderLifecycleService.prototype) as Record<
    string,
    any
  >;
  Object.assign(
    s,
    {
      integrationClient: {},
      identityClient: {},
      logisticsClient: {},
      logger: { warn: jest.fn() },
      activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    },
    over,
  );
  return s;
}

function receiveHarness(rows: Row[], opts: { integrationDown?: boolean } = {}) {
  rmqSend.mockReset();
  rmqSend.mockImplementation((_client: unknown, pattern: { cmd: string }) => {
    switch (pattern.cmd) {
      case 'identity.customer.find_by_ids':
        return Promise.resolve({ data: [{ id: 'c1' }] });
      case 'logistics.district.find_by_ids':
        return Promise.resolve({
          data: [{ id: '120', assigned_region: '13' }],
        });
      case 'logistics.post.receive_orders':
        return Promise.resolve({
          data: rows.map((row) => ({
            order_id: String(row.id),
            post_id: '48',
          })),
        });
      case 'integration.partner.webhook.enqueue':
      case 'integration.sync.enqueue':
        return opts.integrationDown
          ? Promise.reject(new Error('integration down'))
          : Promise.resolve({ statusCode: 201 });
      default:
        return Promise.resolve(null);
    }
  });
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['update', 'set', 'where']) qb[m] = jest.fn(() => qb);
  qb.execute = jest.fn(() => Promise.resolve({ affected: 1 }));
  const s = lifecycleWith({
    orderRepo: {
      find: jest.fn(() => Promise.resolve(rows.map((r) => ({ ...r })))),
    },
    dataSource: {
      createQueryRunner: jest.fn(() => ({
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          createQueryBuilder: jest.fn(() => qb),
          getRepository: jest.fn(() => ({})),
        },
      })),
    },
    resolveReceiveBranchScope: jest.fn().mockResolvedValue(null),
    lookup: { getHqBranchId: jest.fn().mockResolvedValue('1') },
    custody: {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'superadmin'),
    },
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
  });
  return {
    s,
    receive: () =>
      (s as unknown as OrderLifecycleService).receiveNewOrders(
        rows.map((r) => String(r.id)),
        undefined,
        { id: '1', roles: ['superadmin'] },
      ),
  };
}

describe('T1 K3 — HQ qabuli → `received`', () => {
  it('⭐ external_id li buyurtma → BITTA received (pul maydonlari null, cod 0); external_id siz → yo`q', async () => {
    const h = receiveHarness([
      order({ id: '31', external_id: 'EXT-31', operator: 'external_amocrm' }),
      order({ id: '32' }),
    ]);
    await expect(h.receive()).resolves.toMatchObject({ statusCode: 200 });
    await flush();

    expect(partnerCalls()).toHaveLength(1);
    expect(partnerCalls()[0][2]).toEqual(
      expect.objectContaining({
        order_id: '31',
        external_order_id: 'EXT-31',
        action: 'received',
        old_status: Order_status.NEW,
        new_status: 'received',
        cod_collected: 0,
        collected_from_customer: null,
        elchi_fee: null,
        market_amount: null,
      }),
    );
    // `external_` operatorli bo'lsa ham eski adapter yo'li OLMAYDI.
    expect(legacyCalls()).toHaveLength(0);
  });

  it('⭐ integration RMQ xatosi → qabul baribir 200 (faqat log)', async () => {
    const h = receiveHarness([order({ id: '31', external_id: 'EXT-31' })], {
      integrationDown: true,
    });
    await expect(h.receive()).resolves.toMatchObject({ statusCode: 200 });
    await flush();
    expect(partnerCalls()).toHaveLength(1);
  });

  it('queueExternalStatusSync o`zi tashlasa ham (sinxron xato) — 200, log', async () => {
    const h = receiveHarness([order({ id: '31', external_id: 'EXT-31' })]);
    h.s.queueExternalStatusSync = jest.fn(() =>
      Promise.reject(new Error('boom')),
    );
    await expect(h.receive()).resolves.toMatchObject({ statusCode: 200 });
    await flush();
    expect(h.s.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('order=31'),
    );
  });
});

describe('T1 K3 — `updateFull` → ON_THE_ROAD → `on_the_road`', () => {
  beforeEach(() => {
    rmqSend.mockReset();
    rmqSend.mockResolvedValue({ statusCode: 201 });
  });

  it('resolveSyncAction: ON_THE_ROAD → on_the_road; NEW → RECEIVED hamon null', () => {
    const s = lifecycleWith();
    expect(
      s.resolveSyncAction(Order_status.RECEIVED, Order_status.ON_THE_ROAD),
    ).toBe('on_the_road');
    expect(
      s.resolveSyncAction(Order_status.NEW, Order_status.RECEIVED),
    ).toBeNull();
  });

  it('⭐ pochta jo`natildi (updateFull yordamchisi) → hamkorga on_the_road, eski adapterga yo`q', async () => {
    const s = lifecycleWith();
    s.syncExternalAfterUpdate(
      order({
        status: Order_status.ON_THE_ROAD,
        external_id: 'EXT-31',
        operator: 'external_amocrm',
      }),
      Order_status.RECEIVED,
    );
    await flush();
    expect(partnerCalls()).toHaveLength(1);
    expect(partnerCalls()[0][2]).toEqual(
      expect.objectContaining({
        action: 'on_the_road',
        old_status: Order_status.RECEIVED,
        new_status: 'on the road',
        cod_collected: 0,
        collected_from_customer: null,
      }),
    );
    expect(legacyCalls()).toHaveLength(0);
  });

  it('eski adapter yo`li boshqa harakatlarda o`zgarmagan (sold → sync.enqueue bor)', async () => {
    const s = lifecycleWith();
    await s.queueExternalStatusSync(
      order({ external_id: 'EXT-31', operator: 'external_amocrm' }),
      'sold',
      Order_status.WAITING,
      Order_status.SOLD,
    );
    expect(legacyCalls()).toHaveLength(1);
  });

  it('T6 suppressExternalSync → signal yo`q; external_id siz → signal yo`q', async () => {
    const s = lifecycleWith();
    s.syncExternalAfterUpdate(
      order({ status: Order_status.ON_THE_ROAD, external_id: 'EXT-31' }),
      Order_status.RECEIVED,
      { suppressExternalSync: true },
    );
    s.syncExternalAfterUpdate(
      order({ status: Order_status.ON_THE_ROAD }),
      Order_status.RECEIVED,
    );
    await flush();
    expect(rmqSend).not.toHaveBeenCalled();
  });
});

describe('T1 K3 — filiallararo FORWARD paket → `on_the_road`', () => {
  function sendHarness(direction: BranchTransferDirection) {
    const batch = {
      id: '70',
      status: BranchTransferBatchStatus.PENDING,
      direction,
      source_branch_id: '1',
      destination_branch_id: '12',
      order_count: 2,
      total_price: 0,
      isDeleted: false,
    };
    const items = [
      { id: 'i1', batch_id: '70', order_id: '900', sent_at: null },
      { id: 'i2', batch_id: '70', order_id: '901', sent_at: null },
    ];
    const qb: Record<string, jest.Mock> = {};
    for (const m of ['update', 'set', 'where', 'andWhere']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.execute = jest.fn(() => Promise.resolve({ affected: 2 }));
    const lifecycle = {
      notifyPartnerStatusChanged: jest.fn().mockResolvedValue(undefined),
    };
    const service = new BranchTransferBatchService(
      {} as never,
      {
        findOne: jest.fn().mockResolvedValue(batch),
        save: jest.fn((v: unknown) => Promise.resolve(v)),
      } as never,
      {
        find: jest.fn().mockResolvedValue(items),
        save: jest.fn((v: unknown) => Promise.resolve(v)),
        createQueryBuilder: jest.fn(() => qb),
      } as never,
      {
        create: jest.fn((v: unknown) => v),
        save: jest.fn((v: unknown) => Promise.resolve(v)),
      } as never,
      {
        find: jest.fn().mockResolvedValue([
          { id: '900', status: Order_status.RECEIVED },
          // takroriy jo'natish — allaqachon yo'lda, signal qayta ketmaydi
          { id: '901', status: Order_status.ON_THE_ROAD },
        ]),
        createQueryBuilder: jest.fn(() => qb),
      } as never,
      {} as never,
      {} as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      {
        toTrackingRole: jest.fn(() => 'manager'),
        createTrackingEvent: jest.fn().mockResolvedValue(undefined),
        auditActor: jest.fn(() => ({})),
      } as never,
      undefined,
      lifecycle as never,
    );
    const send = () =>
      service.sendBranchTransferBatch({
        batch_id: '70',
        order_ids: ['900', '901'],
        vehicle_plate: '01A123BC',
        driver_name: 'Haydovchi',
        driver_phone: '+998901112233',
        requester_id: '41',
        requester_roles: ['manager'],
      });
    return { send, lifecycle };
  }

  it('⭐ FORWARD → notifyPartnerStatusChanged(on_the_road), allaqachon yo`ldagisiz', async () => {
    const h = sendHarness(BranchTransferDirection.FORWARD);
    await h.send();
    expect(h.lifecycle.notifyPartnerStatusChanged).toHaveBeenCalledTimes(1);
    const [ids, action, prior, next] =
      h.lifecycle.notifyPartnerStatusChanged.mock.calls[0];
    expect(ids).toEqual(['900']);
    expect(action).toBe('on_the_road');
    expect((prior as Map<string, string>).get('900')).toBe(
      Order_status.RECEIVED,
    );
    expect(next).toBe(Order_status.ON_THE_ROAD);
  });

  it('RETURN paket (holat o`zgarmaydi) → signal yo`q', async () => {
    const h = sendHarness(BranchTransferDirection.RETURN);
    await h.send();
    expect(h.lifecycle.notifyPartnerStatusChanged).not.toHaveBeenCalled();
  });

  it('notifyPartnerStatusChanged: faqat external_id li buyurtmalar o`qiladi va navbatga qo`yiladi', async () => {
    rmqSend.mockReset();
    rmqSend.mockResolvedValue({ statusCode: 201 });
    const find = jest.fn().mockResolvedValue([
      order({
        id: '900',
        status: Order_status.ON_THE_ROAD,
        external_id: 'EXT-900',
      }),
    ]);
    const s = lifecycleWith({ orderRepo: { find } });
    await (s as unknown as OrderLifecycleService).notifyPartnerStatusChanged(
      ['900', '900', '902'],
      'on_the_road',
      new Map([['900', Order_status.RECEIVED]]),
      Order_status.ON_THE_ROAD,
    );
    await flush();
    const where = find.mock.calls[0][0].where;
    expect(where.id.value).toEqual(['900', '902']);
    expect(where.external_id).toBeDefined();
    expect(partnerCalls()).toHaveLength(1);
    expect(partnerCalls()[0][2]).toEqual(
      expect.objectContaining({
        order_id: '900',
        action: 'on_the_road',
        old_status: Order_status.RECEIVED,
        new_status: 'on the road',
      }),
    );
  });

  it('notifyPartnerStatusChanged: bo`sh ro`yxat → DB ham, RMQ ham yo`q', async () => {
    rmqSend.mockReset();
    const find = jest.fn();
    const s = lifecycleWith({ orderRepo: { find } });
    await (s as unknown as OrderLifecycleService).notifyPartnerStatusChanged(
      [],
      'on_the_road',
      new Map(),
      Order_status.ON_THE_ROAD,
    );
    expect(find).not.toHaveBeenCalled();
    expect(rmqSend).not.toHaveBeenCalled();
  });
});
