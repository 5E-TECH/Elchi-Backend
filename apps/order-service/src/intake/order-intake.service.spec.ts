import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import {
  ORDER_INTAKE_CLOSED,
  ORDER_INTAKE_SETTING_KEYS,
  ORDER_RECEIVE_CLOSED,
} from '@app/common';
import { OrderIntakeService } from './order-intake.service';
import { OrderServiceController } from '../order-service.controller';

/**
 * «KUN TARTIBI» (ega 2026-11-09 / 2026-11-11, Trello #756):
 *  • faqat superadmin o'zgartiradi (gateway ham `@Roles(SUPERADMIN)`);
 *  • yaratish va qabul qilish chegaralari DOIMIY — har ish kuni takrorlanadi,
 *    kun almashganda yangi kun ochiq boshlanadi;
 *  • yaratish yopiq — `order.create` / `order.external.create` /
 *    `order.receive_external` 409 `ORDER_INTAKE_CLOSED`, idempotency kaliti
 *    EGALLANMAYDI; qabul yopiq — `order.receive` / `order.receive_by_scan`
 *    409 `ORDER_RECEIVE_CLOSED`.
 */

const tashkent = (iso: string) => new Date(`${iso}+05:00`);
const stub = <T>(value: unknown): T => value as T;
const ctx = stub<RmqContext>({});
const SUPERADMIN = { id: '1', roles: ['superadmin'] };

function makeDataSource(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const writes: Array<{
    key: string;
    value: unknown;
    updated_by: string | null;
  }> = [];
  const repo = {
    find: jest.fn(() =>
      Promise.resolve([...store].map(([key, value]) => ({ key, value }))),
    ),
  };
  const manager = {
    query: jest.fn(() => Promise.resolve([])),
    getRepository: jest.fn(() => repo),
    createQueryBuilder: jest.fn(() => {
      let row: { key: string; value: unknown; updated_by: string | null };
      const qb = {
        insert: () => qb,
        into: () => qb,
        values: (value: typeof row) => {
          row = value;
          return qb;
        },
        orUpdate: () => qb,
        execute: () => {
          store.set(row.key, row.value);
          writes.push(row);
          return Promise.resolve({});
        },
      };
      return qb;
    }),
  };
  const dataSource = {
    manager,
    transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
  };
  return { dataSource, store, writes, manager };
}

function makeService(initial: Record<string, unknown> = {}) {
  const db = makeDataSource(initial);
  const activityLog = { log: jest.fn(() => Promise.resolve()) };
  const service = new OrderIntakeService(
    stub(db.dataSource),
    stub(activityLog),
  );
  return { service, activityLog, ...db };
}

const rpcError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as Record<string, unknown>;
  }
  throw new Error('xato kutilgan edi');
};

/** DB'dagi doimiy chegara qiymati. */
const stored = (cutoff: string | null) => ({ cutoff_time: cutoff });

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('OrderIntakeService', () => {
  it('sozlama yo`q — qabul ochiq, kun 00:00 da almashadi', async () => {
    const { service } = makeService();
    const state = await service.getState(tashkent('2026-11-09T15:00:00'));
    expect(state).toMatchObject({
      is_open: true,
      cutoff_time: null,
      day_change_time: '00:00',
      date: '2026-11-09',
    });
  });

  it.each([
    [{ id: '2', roles: ['admin'] }],
    [{ id: '3', roles: ['registrator'] }],
    [{ id: '4', roles: ['market'] }],
    [null],
  ])('superadmin emas (%p) — 403, hech narsa yozilmaydi', async (requester) => {
    const { service, dataSource } = makeService();
    const error = await rpcError(
      service.update({ cutoff_time: '10:00', requester }),
    );
    expect(error.statusCode).toBe(403);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('bo`sh so`rov — 400', async () => {
    const { service } = makeService();
    const error = await rpcError(service.update({ requester: SUPERADMIN }));
    expect(error.statusCode).toBe(400);
  });

  it.each(['25:00', '9:00', '10:00:00', 600])(
    'noto`g`ri vaqt %p — 400',
    async (value) => {
      const { service, dataSource } = makeService();
      const error = await rpcError(
        service.update({ cutoff_time: value, requester: SUPERADMIN }),
      );
      expect(error.statusCode).toBe(400);
      expect(String(error.message)).toContain('cutoff_time');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    },
  );

  it('10:00 qo`yildi: doimiy yoziladi, har kuni 10:00 dan kun almashguncha yopiq', async () => {
    const now = tashkent('2026-11-09T08:00:00');
    const { service, writes, manager, activityLog } = makeService();

    const state = await service.update(
      { cutoff_time: '10:00', requester: SUPERADMIN },
      now,
    );

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['order.intake.settings'],
    );
    expect(writes).toEqual([
      {
        key: ORDER_INTAKE_SETTING_KEYS.cutoff,
        value: { cutoff_time: '10:00' },
        updated_by: '1',
      },
    ]);
    expect(state).toMatchObject({
      is_open: true,
      cutoff_time: '10:00',
      closes_at: tashkent('2026-11-09T10:00:00').toISOString(),
      reopens_at: tashkent('2026-11-10T00:00:00').toISOString(),
    });
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'order.intake_cutoff_changed',
        entity_id: ORDER_INTAKE_SETTING_KEYS.cutoff,
        old_value: { cutoff_time: null },
        new_value: { cutoff_time: '10:00' },
        user_id: '1',
      }),
    );

    await expect(
      service.assertOpen(tashkent('2026-11-09T09:59:00')),
    ).resolves.toMatchObject({ is_open: true });
    const closed = await rpcError(
      service.assertOpen(tashkent('2026-11-09T10:00:00')),
    );
    expect(closed).toMatchObject({
      statusCode: 409,
      code: ORDER_INTAKE_CLOSED,
      cutoff_time: '10:00',
      reopens_at: tashkent('2026-11-10T00:00:00').toISOString(),
    });
    // Kun almashdi — yana ochiq, lekin chegara SAQLANADI (har kuni).
    await expect(
      service.assertOpen(tashkent('2026-11-10T00:00:01')),
    ).resolves.toMatchObject({ is_open: true, cutoff_time: '10:00' });
    await expect(
      service.assertOpen(tashkent('2026-11-10T10:00:00')),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('sozlamani o`qib bo`lmasa — darvoza fail open (yaratish to`xtamaydi)', async () => {
    const { service, manager } = makeService();
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    manager.getRepository.mockReturnValue({
      find: jest.fn(() =>
        Promise.reject(new Error('relation "order_settings" does not exist')),
      ),
    } as never);
    await expect(service.assertOpen()).resolves.toBeNull();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('fail open'));
    // Holat endpointi xatoni yashirmaydi.
    await expect(service.getState()).rejects.toThrow('order_settings');
  });

  it('o`tgan vaqt qo`yilsa — qabul darhol yopiladi', async () => {
    const now = tashkent('2026-11-09T11:30:00');
    const { service } = makeService();
    const state = await service.update(
      { cutoff_time: '10:00', requester: SUPERADMIN },
      now,
    );
    expect(state.is_open).toBe(false);
  });

  it('DINAMIK: kun davomida istalgancha o`zgaradi, darvoza darhol yangi qiymatni oladi', async () => {
    const { service } = makeService();
    const set = (cutoff: string | null, at: string) =>
      service.update(
        { cutoff_time: cutoff, requester: SUPERADMIN },
        tashkent(at),
      );
    const isOpen = async (at: string) =>
      (await service.getState(tashkent(at))).is_open;

    // 08:00 — 10:00 gacha qilindi.
    await set('10:00', '2026-11-09T08:00:00');
    expect(await isOpen('2026-11-09T09:30:00')).toBe(true);
    expect(await isOpen('2026-11-09T10:30:00')).toBe(false);

    // 10:30 — yopilgan, superadmin 12:00 gacha uzaytirdi → darhol ochiq.
    const extended = await set('12:00', '2026-11-09T10:30:00');
    expect(extended).toMatchObject({ is_open: true, cutoff_time: '12:00' });
    await expect(
      service.assertOpen(tashkent('2026-11-09T11:59:00')),
    ).resolves.toMatchObject({ is_open: true });
    await expect(
      service.assertOpen(tashkent('2026-11-09T12:00:00')),
    ).rejects.toBeInstanceOf(RpcException);

    // 10:45 — 11:00 gacha qisqartirildi → 11:00 da yopiq.
    expect((await set('11:00', '2026-11-09T10:45:00')).is_open).toBe(true);
    expect(await isOpen('2026-11-09T11:00:00')).toBe(false);

    // 13:00 — cheklov olib tashlandi → darhol ochiq, kun oxirigacha.
    expect((await set(null, '2026-11-09T13:00:00')).is_open).toBe(true);
    expect(await isOpen('2026-11-09T23:59:00')).toBe(true);
  });

  it('`null` — cheklov olib tashlanadi', async () => {
    const now = tashkent('2026-11-09T11:00:00');
    const { service, store } = makeService({
      [ORDER_INTAKE_SETTING_KEYS.cutoff]: stored('10:00'),
    });
    expect((await service.getState(now)).is_open).toBe(false);

    const state = await service.update(
      { cutoff_time: null, requester: SUPERADMIN },
      now,
    );
    expect(state).toMatchObject({ is_open: true, cutoff_time: null });
    expect(store.get(ORDER_INTAKE_SETTING_KEYS.cutoff)).toMatchObject({
      cutoff_time: null,
    });
  });

  it('kun almashish soati 06:00 — chegara yangi oynada o`z soatida', async () => {
    const now = tashkent('2026-11-09T08:00:00');
    const { service, store, activityLog } = makeService({
      [ORDER_INTAKE_SETTING_KEYS.cutoff]: stored('10:00'),
    });

    const state = await service.update(
      { day_change_time: '06:00', requester: SUPERADMIN },
      now,
    );

    expect(store.get(ORDER_INTAKE_SETTING_KEYS.dayChangeTime)).toEqual({
      time: '06:00',
    });
    expect(state).toMatchObject({
      day_change_time: '06:00',
      cutoff_time: '10:00',
      is_open: true,
      closes_at: tashkent('2026-11-09T10:00:00').toISOString(),
      reopens_at: tashkent('2026-11-10T06:00:00').toISOString(),
      day_started_at: tashkent('2026-11-09T06:00:00').toISOString(),
    });
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'order.day_change_time_changed',
        old_value: { day_change_time: '00:00' },
        new_value: { day_change_time: '06:00' },
      }),
    );
    // Faqat kun almashish soati berildi — cheklov jurnali yozilmaydi.
    expect(activityLog.log).toHaveBeenCalledTimes(1);
  });

  it('kun almashish 18:00 ga 19:00 da o`tdi — yangi kun ochiq, chegara saqlanadi', async () => {
    const now = tashkent('2026-11-09T19:00:00');
    const { service } = makeService({
      [ORDER_INTAKE_SETTING_KEYS.cutoff]: stored('10:00'),
    });
    expect((await service.getState(now)).is_open).toBe(false);

    const state = await service.update(
      { day_change_time: '18:00', requester: SUPERADMIN },
      now,
    );
    expect(state).toMatchObject({
      day_change_time: '18:00',
      date: '2026-11-10',
      is_open: true,
      cutoff_time: '10:00',
      closes_at: tashkent('2026-11-10T10:00:00').toISOString(),
    });
  });

  it('`day_change_time: null` — sukut 00:00 ga qaytadi', async () => {
    const now = tashkent('2026-11-09T12:00:00');
    const { service } = makeService({
      [ORDER_INTAKE_SETTING_KEYS.dayChangeTime]: { time: '18:00' },
    });
    const state = await service.update(
      { day_change_time: null, requester: SUPERADMIN },
      now,
    );
    expect(state.day_change_time).toBe('00:00');
  });

  it('⭐ qabul qilish chegarasi: 16:00 qo`yildi — 16:00 dan kun almashguncha 409 ORDER_RECEIVE_CLOSED', async () => {
    const now = tashkent('2026-11-09T08:00:00');
    const { service, writes, activityLog } = makeService();
    const state = await service.update(
      { receive_cutoff_time: '16:00', requester: SUPERADMIN },
      now,
    );
    expect(writes).toEqual([
      {
        key: ORDER_INTAKE_SETTING_KEYS.receiveCutoff,
        value: { cutoff_time: '16:00' },
        updated_by: '1',
      },
    ]);
    expect(state).toMatchObject({
      receive_cutoff_time: '16:00',
      receive_is_open: true,
      receive_closes_at: tashkent('2026-11-09T16:00:00').toISOString(),
      // Yaratish chegarasiga tegilmagan.
      cutoff_time: null,
      is_open: true,
    });
    expect(activityLog.log).toHaveBeenCalledTimes(1);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'order.receive_cutoff_changed',
        old_value: { receive_cutoff_time: null },
        new_value: { receive_cutoff_time: '16:00' },
      }),
    );

    await expect(
      service.assertReceiveOpen(tashkent('2026-11-09T15:59:00')),
    ).resolves.toMatchObject({ receive_is_open: true });
    const closed = await rpcError(
      service.assertReceiveOpen(tashkent('2026-11-09T16:00:00')),
    );
    expect(closed).toMatchObject({
      statusCode: 409,
      code: ORDER_RECEIVE_CLOSED,
      receive_cutoff_time: '16:00',
      reopens_at: tashkent('2026-11-10T00:00:00').toISOString(),
    });
    // Yaratish darvozasi qabul chegarasidan mustaqil.
    await expect(
      service.assertOpen(tashkent('2026-11-09T17:00:00')),
    ).resolves.toMatchObject({ is_open: true });
    // Ertasi kuni — yana ochiq, 16:00 da yana yopiladi.
    await expect(
      service.assertReceiveOpen(tashkent('2026-11-10T09:00:00')),
    ).resolves.toMatchObject({ receive_is_open: true });
  });

  it('bir nechta maydon birga — hammasi bitta tranzaksiyada', async () => {
    const { service, store, dataSource, activityLog } = makeService();
    const state = await service.update(
      {
        cutoff_time: '10:00',
        receive_cutoff_time: '16:00',
        day_change_time: '06:00',
        requester: SUPERADMIN,
      },
      tashkent('2026-11-09T08:00:00'),
    );
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(store.get(ORDER_INTAKE_SETTING_KEYS.cutoff)).toEqual(
      stored('10:00'),
    );
    expect(store.get(ORDER_INTAKE_SETTING_KEYS.receiveCutoff)).toEqual(
      stored('16:00'),
    );
    expect(state).toMatchObject({
      cutoff_time: '10:00',
      receive_cutoff_time: '16:00',
      day_change_time: '06:00',
    });
    expect(activityLog.log).toHaveBeenCalledTimes(3);
  });

  it('bitta maydon xato — hech biri yozilmaydi (400)', async () => {
    const { service, dataSource } = makeService();
    const error = await rpcError(
      service.update({
        cutoff_time: '10:00',
        receive_cutoff_time: '25:00',
        requester: SUPERADMIN,
      }),
    );
    expect(error.statusCode).toBe(400);
    expect(String(error.message)).toContain('receive_cutoff_time');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('o`zgarmagan qiymat — yozilmaydi, jurnalga tushmaydi', async () => {
    const { service, writes, activityLog } = makeService({
      [ORDER_INTAKE_SETTING_KEYS.cutoff]: stored('10:00'),
    });
    await service.update(
      { cutoff_time: '10:00', requester: SUPERADMIN },
      tashkent('2026-11-09T08:00:00'),
    );
    expect(writes).toEqual([]);
    expect(activityLog.log).not.toHaveBeenCalled();
  });

  it('qabul darvozasi ham fail open — sozlamani o`qib bo`lmasa o`tkazadi', async () => {
    const { service, manager } = makeService();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    manager.getRepository.mockReturnValue({
      find: jest.fn(() => Promise.reject(new Error('db down'))),
    });
    await expect(service.assertReceiveOpen()).resolves.toBeNull();
  });

  it('raqamsiz requester id — updated_by null', async () => {
    const { service, writes } = makeService();
    await service.update(
      {
        cutoff_time: '10:00',
        requester: { id: 'partner:7', roles: ['superadmin'] },
      },
      tashkent('2026-11-09T08:00:00'),
    );
    expect(writes[0].updated_by).toBeNull();
  });
});

describe('OrderServiceController — qabul darvozasi', () => {
  function makeController(intake?: Partial<OrderIntakeService>) {
    const rmqService = {
      ack: jest.fn(),
      nack: jest.fn(),
      nackForError: jest.fn(),
    };
    const idempotencyService = {
      tryAcquire: jest.fn(() => Promise.resolve({ status: 'new' })),
      markCompleted: jest.fn(() => Promise.resolve()),
      markFailed: jest.fn(() => Promise.resolve()),
    };
    const lifecycle = {
      create: jest.fn(() => Promise.resolve({ id: '55' })),
      createExternalOrder: jest.fn(() => Promise.resolve({ id: '56' })),
      receiveExternalOrders: jest.fn(() => Promise.resolve({ created: [] })),
      receiveNewOrders: jest.fn(() => Promise.resolve({ received: 1 })),
      receiveExternalByScan: jest.fn(() => Promise.resolve({ ok: true })),
    };
    const controller = new OrderServiceController(
      stub(rmqService),
      stub({}),
      stub({}),
      stub({}),
      stub({}),
      stub(lifecycle),
      stub(idempotencyService),
      stub({ resolve: jest.fn() }),
      undefined,
      undefined,
      undefined,
      intake ? stub(intake) : undefined,
    );
    return { controller, rmqService, idempotencyService, lifecycle };
  }

  const closedIntake = () => ({
    assertOpen: jest.fn(() =>
      Promise.reject(
        new RpcException({
          statusCode: 409,
          code: ORDER_INTAKE_CLOSED,
          message: 'Bugungi buyurtma qabuli yopilgan',
          reopens_at: '2026-11-09T19:00:00.000Z',
          cutoff_time: '10:00',
        }),
      ),
    ),
  });

  const createPayload = {
    dto: { market_id: '5', customer_id: '9' },
    requester: { id: '5', roles: ['market'] },
    request_id: 'partner:7:ord-1',
  };

  it('yopiq — order.create 409, idempotency kaliti egallanmaydi', async () => {
    const { controller, idempotencyService, lifecycle, rmqService } =
      makeController(closedIntake());
    const error = await rpcError(controller.create(createPayload, ctx));
    expect(error).toMatchObject({ statusCode: 409, code: ORDER_INTAKE_CLOSED });
    expect(idempotencyService.tryAcquire).not.toHaveBeenCalled();
    expect(idempotencyService.markFailed).not.toHaveBeenCalled();
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(rmqService.nackForError).toHaveBeenCalledTimes(1);
  });

  it('ochiq — order.create odatdagidek (idempotency + lifecycle)', async () => {
    const intake = { assertOpen: jest.fn(() => Promise.resolve({})) };
    const { controller, idempotencyService, lifecycle } =
      makeController(intake);
    await expect(controller.create(createPayload, ctx)).resolves.toEqual({
      id: '55',
    });
    expect(intake.assertOpen).toHaveBeenCalledTimes(1);
    expect(idempotencyService.tryAcquire).toHaveBeenCalledTimes(1);
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
  });

  it('yopiq — order.external.create va order.receive_external ham 409', async () => {
    const { controller, lifecycle } = makeController(closedIntake());
    await rpcError(
      controller.createExternal(
        { dto: { market_id: '5', customer_id: '9' }, requester: null },
        ctx,
      ),
    );
    await rpcError(
      controller.receiveExternalOrders(
        { integration_id: '3', orders: [] },
        ctx,
      ),
    );
    expect(lifecycle.createExternalOrder).not.toHaveBeenCalled();
    expect(lifecycle.receiveExternalOrders).not.toHaveBeenCalled();
  });

  it('⭐ qabul yopiq — order.receive va order.receive_by_scan 409, yaratish ochiq', async () => {
    const intake = {
      assertOpen: jest.fn(() => Promise.resolve({})),
      assertReceiveOpen: jest.fn(() =>
        Promise.reject(
          new RpcException({
            statusCode: 409,
            code: ORDER_RECEIVE_CLOSED,
            message: 'Bugungi buyurtma qabul qilish vaqti tugagan',
            reopens_at: '2026-11-09T19:00:00.000Z',
            receive_cutoff_time: '16:00',
          }),
        ),
      ),
    };
    const { controller, lifecycle } = makeController(intake);
    expect(
      await rpcError(controller.receive({ order_ids: ['1'] }, ctx)),
    ).toMatchObject({ code: ORDER_RECEIVE_CLOSED });
    expect(
      await rpcError(controller.receiveByScan({ tokens: ['qr-1'] }, ctx)),
    ).toMatchObject({ code: ORDER_RECEIVE_CLOSED });
    expect(lifecycle.receiveNewOrders).not.toHaveBeenCalled();
    expect(lifecycle.receiveExternalByScan).not.toHaveBeenCalled();
    // Yaratish darvozasi alohida — qabul yopiqligi yaratishni to'smaydi.
    await controller.create(createPayload, ctx);
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
    expect(intake.assertOpen).toHaveBeenCalledTimes(1);
  });

  it('qabul ochiq — order.receive odatdagidek', async () => {
    const intake = {
      assertReceiveOpen: jest.fn(() => Promise.resolve({})),
    };
    const { controller, lifecycle } = makeController(intake);
    await expect(
      controller.receive({ order_ids: ['1'] }, ctx),
    ).resolves.toEqual({ received: 1 });
    expect(lifecycle.receiveNewOrders).toHaveBeenCalledTimes(1);
  });

  it('servis yo`q (eski spec) — darvoza o`chiq, avvalgi xulq', async () => {
    const { controller, lifecycle } = makeController();
    await controller.create(createPayload, ctx);
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
  });

  it('order.intake.update — servisga uzatiladi, javob envelope bilan', async () => {
    const intake = {
      update: jest.fn(() => Promise.resolve({ is_open: true })),
    };
    const { controller } = makeController(intake);
    const payload = { cutoff_time: '10:00', requester: SUPERADMIN };
    await expect(controller.intakeUpdate(payload, ctx)).resolves.toMatchObject({
      statusCode: 200,
      data: { is_open: true },
    });
    expect(intake.update).toHaveBeenCalledWith(payload);
  });
});
