import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import {
  ORDER_INTAKE_CLOSED,
  ORDER_INTAKE_SETTING_KEYS,
  resolveOrderIntakeWindow,
} from '@app/common';
import { OrderIntakeService } from './order-intake.service';
import { OrderServiceController } from '../order-service.controller';

/**
 * BUGUNGI QABUL VAQTI (ega 2026-11-09) va KUN ALMASHISH SOATI (Trello #756):
 *  • faqat superadmin o'zgartiradi (gateway ham `@Roles(SUPERADMIN)`);
 *  • cheklov joriy ish kuni oynasiga yoziladi, kun almashganda o'zi bekor;
 *  • qabul yopiq — `order.create` / `order.external.create` /
 *    `order.receive_external` 409, idempotency kaliti EGALLANMAYDI.
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

const cutoffFor = (now: Date, cutoff: string, dayChange = 0) => {
  const window = resolveOrderIntakeWindow(now, dayChange);
  return {
    window_start: window.start.toISOString(),
    date: window.date,
    cutoff_time: cutoff,
  };
};

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

  it('10:00 qo`yildi: joriy oynaga yoziladi, 10:00 dan keyin yopiq', async () => {
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
        value: cutoffFor(now, '10:00'),
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
        old_value: { cutoff_time: null, date: '2026-11-09' },
        new_value: { cutoff_time: '10:00', date: '2026-11-09' },
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
    // Kun almashdi — yana ochiq.
    await expect(
      service.assertOpen(tashkent('2026-11-10T00:00:01')),
    ).resolves.toMatchObject({ is_open: true, cutoff_time: null });
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
      [ORDER_INTAKE_SETTING_KEYS.cutoff]: cutoffFor(now, '10:00'),
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

  it('kun almashish soati 06:00 (ish kuni o`sha) — bugungi cheklov ko`chadi', async () => {
    const now = tashkent('2026-11-09T08:00:00');
    const { service, store, activityLog } = makeService({
      [ORDER_INTAKE_SETTING_KEYS.cutoff]: cutoffFor(now, '10:00'),
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

  it('kun almashish 18:00 ga 19:00 da o`tdi — yangi kun, kechagi cheklov o`tmaydi', async () => {
    const now = tashkent('2026-11-09T19:00:00');
    const { service } = makeService({
      [ORDER_INTAKE_SETTING_KEYS.cutoff]: cutoffFor(now, '10:00'),
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
      cutoff_time: null,
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
