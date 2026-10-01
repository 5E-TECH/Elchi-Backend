import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { NEVER, Observable, defer, of, throwError } from 'rxjs';
import { ActivityAction, Roles, Status } from '@app/common';
import { IdentityController } from './identity.controller';
import { UserServiceService } from './user-service.service';
import type { RequesterContext } from './contracts/user.payloads';

/**
 * Item 1 (identity qismi) — kuryer faqat pul va qo'lida buyurtma bo'lmaganda
 * filialdan filialga o'tadi.
 *
 * 1) deleteUser: kuryer o'chirilishidan oldin branch.user.courier_transfer_check.
 *    O'chirilgan filial kuryerining pulini hech kim qabul qila olmaydi, qo'lidagi
 *    buyurtmalar osilib qoladi. Sabab bor → 409, tekshiruv bajarilmadi → 503.
 * 2) Bloklash (status → inactive) tekshiruvsiz — qaror shu testlar bilan
 *    qotiriladi.
 * 3) identity.courier.set_region — LOKAL (masofaviy chaqiruv yo'q): faqat
 *    raqamli region_id yoki null. O'qish+yozish bitta tranzaksiyada qator
 *    qulfi bilan; `deadline_at` qulfdan keyin tekshiriladi — muddati o'tgan
 *    set_region hech narsa yozmaydi (409), muddatsiz tiklash yoziladi.
 */
const CHECK_CMD = 'branch.user.courier_transfer_check';
const DELETE_PREFIX = "Kuryerni o'chirib bo'lmaydi: ";
const DELETE_UNAVAILABLE =
  "Kuryer kassasi va qo'lidagi buyurtmalarni tekshirib bo'lmadi — kuryer o'chirilmadi. Birozdan so'ng qayta urinib ko'ring.";

type Row = Record<string, unknown> & { id: string; role: Roles };
type SendHandler = (
  pattern: { cmd: string },
  payload: unknown,
) => Observable<unknown>;

const courierRow = (overrides: Record<string, unknown> = {}): Row => ({
  id: '263',
  role: Roles.COURIER,
  name: 'Filial kuryeri',
  phone_number: '+998900009911',
  username: null,
  status: Status.ACTIVE,
  region_id: '13',
  district_id: '101',
  isDeleted: false,
  ...overrides,
});

function makeService(options: { rows?: Row[]; branchSend?: SendHandler } = {}) {
  const rows = new Map<string, Row>(
    (options.rows ?? []).map((row) => [row.id, { ...row }]),
  );
  /** Tartib: tx:begin → findOne → save → tx:commit|tx:rollback → logChange. */
  const events: string[] = [];
  const repo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      events.push('findOne');
      const row = rows.get(String(where.id));
      return Promise.resolve(row && row.isDeleted === false ? row : null);
    }),
    save: jest.fn((value: Record<string, unknown>) => {
      events.push('save');
      return Promise.resolve({ ...value });
    }),
    // setCourierRegion tranzaksiyasi: ichidagi repo — shu `repo` (assertlar
    // bir xil qoladi); xatoda rollback qayd etiladi va xato qayta otiladi.
    manager: {
      transaction: jest.fn(
        async (work: (em: unknown) => Promise<unknown>): Promise<unknown> => {
          events.push('tx:begin');
          try {
            const result = await work({ getRepository: () => repo });
            events.push('tx:commit');
            return result;
          } catch (error) {
            events.push('tx:rollback');
            throw error;
          }
        },
      ),
    },
  };
  const makeClient = (reply: unknown) => ({
    send: jest.fn(() => of(reply)),
    emit: jest.fn(),
  });
  const searchClient = makeClient({ ok: true });
  const catalogClient = makeClient({ statusCode: 200 });
  const orderClient = makeClient({ data: null });
  const logisticsClient = makeClient({ data: { id: '7' } });
  const financeClient = makeClient({ data: null });
  const branchSend: SendHandler =
    options.branchSend ?? (() => of({ data: null }));
  const branchClient = { send: jest.fn(branchSend), emit: jest.fn() };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn(() => {
      events.push('logChange');
      return Promise.resolve(undefined);
    }),
  };

  const service = new UserServiceService(
    repo as never,
    searchClient as never, // search
    catalogClient as never, // catalog
    orderClient as never, // order
    logisticsClient as never, // logistics
    financeClient as never, // finance
    branchClient as never, // branch
    {
      encrypt: jest.fn().mockResolvedValue('hashed'),
      compare: jest.fn(),
    } as never,
    { get: jest.fn() } as never,
    activityLog as never,
  );

  return {
    service,
    repo,
    events,
    searchClient,
    catalogClient,
    logisticsClient,
    branchClient,
    activityLog,
  };
}

/** branch.user.courier_transfer_check shu `data` bilan javob beradi. */
const checkReplies =
  (data: Record<string, unknown>): SendHandler =>
  ({ cmd }) =>
    cmd === CHECK_CMD
      ? of({ statusCode: 200, message: "Kuryer o'tkazish tekshiruvi", data })
      : of({ data: null });

const superadmin: RequesterContext = { id: '1', roles: ['superadmin'] };
const admin: RequesterContext = { id: '2', roles: ['admin'] };

const sentCmds = (client: { send: jest.Mock }) =>
  client.send.mock.calls.map(([pattern]) => (pattern as { cmd: string }).cmd);

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('rad etilishi kutilgandi');
    },
    (error: unknown) => error,
  );
}

async function rpcErrorOf(
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; message?: string }> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
}

describe("deleteUser — kuryer pul/buyurtma bilan o'chirilmaydi", () => {
  it('sabablar bor → 409 "Kuryerni o\'chirib bo\'lmaydi: …"; user saqlanmaydi', async () => {
    const reasons = [
      "kuryer qo'lida 150 000 so'm pul bor — avval uni 'Samarqand' filiali menejeri qabul qilib olsin.",
      "kuryer qo'lida 2 ta yakunlanmagan buyurtma bor (#101, #102) — avval ularni yetkazing yoki filialga qaytaring.",
    ];
    const h = makeService({
      rows: [courierRow()],
      branchSend: checkReplies({ reasons, can_transfer: false }),
    });

    const err = await rpcErrorOf(h.service.deleteUser('263', superadmin));

    expect(err.statusCode).toBe(409);
    expect(err.message).toBe(DELETE_PREFIX + reasons.join(' '));
    expect(
      err.message?.startsWith(
        "Kuryerni o'chirib bo'lmaydi: kuryer qo'lida 150 000",
      ),
    ).toBe(true);
    expect(h.repo.save).not.toHaveBeenCalled();
    expect(h.activityLog.log).not.toHaveBeenCalled();
  });

  it("tekshiruv so'rovi: AYNAN { user_id, requester } (request_id qo'shilmaydi), bir marta", async () => {
    const h = makeService({
      rows: [courierRow()],
      branchSend: checkReplies({ reasons: ['sabab'], can_transfer: false }),
    });

    await rejectionOf(h.service.deleteUser('263', admin));

    expect(h.branchClient.send).toHaveBeenCalledTimes(1);
    expect(h.branchClient.send).toHaveBeenCalledWith(
      { cmd: CHECK_CMD },
      { user_id: '263', requester: admin },
    );
  });

  it.each([
    [
      'branch-service 503',
      {
        statusCode: 503,
        message:
          "Kuryer kassasi va qo'lidagi buyurtmalarni tekshirib bo'lmadi (xizmat javob bermadi). Birozdan so'ng qayta urinib ko'ring.",
      },
    ],
    ['branch-service 404', { statusCode: 404, message: 'Kuryer topilmadi' }],
    [
      "Nest 'Internal server error'",
      { status: 'error', message: 'Internal server error' },
    ],
    ['ulanish xatosi', new Error('connection closed')],
  ])(
    '%s → 503, user o‘chirilmaydi, qayta urinish yo‘q (retries 0)',
    async (_label, failure) => {
      let attempts = 0;
      const h = makeService({
        rows: [courierRow()],
        branchSend: () =>
          defer(() => {
            attempts += 1;
            return throwError(() => failure);
          }),
      });

      const err = await rpcErrorOf(h.service.deleteUser('263', superadmin));

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 503,
          message: DELETE_UNAVAILABLE,
        }),
      );
      expect(attempts).toBe(1);
      expect(h.repo.save).not.toHaveBeenCalled();
    },
  );

  it('tekshiruv javob bermasa: 12 s kutiladi (gateway 15 s dan qisqa), keyin 503', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const h = makeService({ rows: [courierRow()], branchSend: () => NEVER });
      let settled = false;
      const outcome = h.service.deleteUser('263', superadmin).then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );

      // Sukutdagi 5 s (RMQ_SERVICE_TIMEOUT) emas — 12 s.
      await jest.advanceTimersByTimeAsync(11_999);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      const error = await outcome;

      expect(error).toBeInstanceOf(RpcException);
      expect((error as RpcException).getError()).toEqual(
        expect.objectContaining({
          statusCode: 503,
          message: DELETE_UNAVAILABLE,
        }),
      );
      expect(h.repo.save).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['data yo‘q', { statusCode: 200 }],
    ['reasons yo‘q', { statusCode: 200, data: { can_transfer: true } }],
    [
      'reasons massiv emas',
      { statusCode: 200, data: { reasons: "kuryer qo'lida pul bor" } },
    ],
    [
      'reasons ichida satr bo‘lmagan qiymat',
      { statusCode: 200, data: { reasons: ['sabab', 42] } },
    ],
    ['javob null', null],
  ])('buzuq javob (%s) → 503, user o‘chirilmaydi', async (_label, reply) => {
    const h = makeService({
      rows: [courierRow()],
      branchSend: () => of(reply),
    });

    const err = await rpcErrorOf(h.service.deleteUser('263', superadmin));

    expect(err).toEqual(
      expect.objectContaining({ statusCode: 503, message: DELETE_UNAVAILABLE }),
    );
    expect(h.repo.save).not.toHaveBeenCalled();
  });

  it("toza kuryer (reasons: []) → avvalgidek soft-delete: isDeleted, inactive, telefon o'zgartiriladi", async () => {
    const h = makeService({
      rows: [courierRow()],
      branchSend: checkReplies({ reasons: [], can_transfer: true }),
    });

    const res = await h.service.deleteUser('263', superadmin);

    expect(res).toEqual({
      statusCode: 200,
      message: 'User o‘chirildi',
      data: { id: '263' },
    });
    expect(h.repo.save).toHaveBeenCalledTimes(1);
    expect(h.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '263',
        isDeleted: true,
        status: Status.INACTIVE,
        phone_number: expect.stringMatching(/^\+998900009911-d\d+$/),
      }),
    );
    // branch_users qatori identity tomonidan o'zgartirilmaydi.
    expect(sentCmds(h.branchClient)).toEqual([CHECK_CMD]);
    expect(h.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: '263',
        action: ActivityAction.DELETED,
      }),
    );
  });

  // fix3b (CODE-07): menejer/registrator o'chirilganda faqat uning faol
  // branch_users qatori qidiriladi (bu yerda yo'q — remove chaqirilmaydi);
  // kuryer tekshiruvi hech kimga chaqirilmaydi.
  it.each([
    [Roles.MARKET, []],
    [Roles.MANAGER, ['branch.user.find_by_user']],
    [Roles.REGISTRATOR, ['branch.user.find_by_user']],
    [Roles.ADMIN, []],
  ])(
    "%s o'chirilganda filial tekshiruvi chaqirilmaydi",
    async (role, expectedCmds) => {
      const h = makeService({
        rows: [courierRow({ id: '77', role, phone_number: '+998900000777' })],
      });

      const res = await h.service.deleteUser('77', superadmin);

      expect(res.statusCode).toBe(200);
      expect(sentCmds(h.branchClient)).not.toContain(CHECK_CMD);
      expect(sentCmds(h.branchClient)).toEqual(expectedCmds);
      expect(h.repo.save).toHaveBeenCalledTimes(1);
    },
  );
});

describe("kuryerni bloklash (status → inactive) tekshiruvsiz — qaror: bloklash qo'riqlanmaydi", () => {
  it('setUserStatus(inactive): filial tekshiruvi yo‘q, status saqlanadi', async () => {
    const h = makeService({ rows: [courierRow()] });

    const res = await h.service.setUserStatus(
      '263',
      Status.INACTIVE,
      superadmin,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual(
      expect.objectContaining({ id: '263', status: Status.INACTIVE }),
    );
    expect(h.branchClient.send).not.toHaveBeenCalled();
    expect(h.repo.save).toHaveBeenCalledTimes(1);
  });

  it('updateUser({ status: inactive }) ham tekshiruvsiz', async () => {
    const h = makeService({ rows: [courierRow()] });

    const res = await h.service.updateUser(
      '263',
      { status: Status.INACTIVE } as never,
      superadmin,
    );

    expect(res.data).toEqual(
      expect.objectContaining({ id: '263', status: Status.INACTIVE }),
    );
    expect(h.branchClient.send).not.toHaveBeenCalled();
  });
});

describe('setCourierRegion — identity.courier.set_region (lokal)', () => {
  it('yangi hudud: region_id saqlanadi, district_id tozalanadi; logistics/branch chaqirilmaydi', async () => {
    const h = makeService({ rows: [courierRow()] });

    const res = await h.service.setCourierRegion('263', '7', superadmin);

    expect(res).toEqual({
      statusCode: 200,
      message: 'Kuryer hududi yangilandi',
      data: {
        id: '263',
        region_id: '7',
        previous_region_id: '13',
        district_id: null,
      },
    });
    expect(h.repo.save).toHaveBeenCalledTimes(1);
    expect(h.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '263', region_id: '7', district_id: null }),
    );
    // validateRegionExists YO'Q: logistics'ga hech narsa ketmaydi.
    expect(h.logisticsClient.send).not.toHaveBeenCalled();
    expect(h.branchClient.send).not.toHaveBeenCalled();
    expect(h.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'User',
        entity_id: '263',
        action: ActivityAction.UPDATED,
        old_value: { region_id: '13', district_id: '101' },
        new_value: { region_id: '7', district_id: null },
        metadata: { reason: 'courier_transfer' },
        user_id: '1',
        user_role: 'superadmin',
      }),
    );
    expect(h.searchClient.send).toHaveBeenCalledWith(
      { cmd: 'search.index.upsert' },
      expect.objectContaining({
        sourceId: '263',
        metadata: expect.objectContaining({ region_id: '7' }),
      }),
    );
  });

  it('region_id null (HQ hududsiz): region_id va district_id null bo‘ladi', async () => {
    const h = makeService({ rows: [courierRow()] });

    const res = await h.service.setCourierRegion('263', null, admin);

    expect(res.data).toEqual({
      id: '263',
      region_id: null,
      previous_region_id: '13',
      district_id: null,
    });
    expect(h.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ region_id: null, district_id: null }),
    );
    expect(h.logisticsClient.send).not.toHaveBeenCalled();
  });

  it("o'zgarmagan qiymat (tuman ham bo'sh) → saqlamasdan 200 (idempotent), log yo'q", async () => {
    const h = makeService({
      rows: [courierRow({ region_id: '7', district_id: null })],
    });

    const res = await h.service.setCourierRegion('263', '7', superadmin);

    expect(res).toEqual({
      statusCode: 200,
      message: 'Kuryer hududi yangilandi',
      data: {
        id: '263',
        region_id: '7',
        previous_region_id: '7',
        district_id: null,
      },
    });
    expect(h.repo.save).not.toHaveBeenCalled();
    expect(h.activityLog.logChange).not.toHaveBeenCalled();
    expect(h.searchClient.send).not.toHaveBeenCalled();
  });

  it('HQ → HQ (ikkalasi null) ham idempotent', async () => {
    const h = makeService({
      rows: [courierRow({ region_id: null, district_id: null })],
    });

    const res = await h.service.setCourierRegion('263', null, superadmin);

    expect(res.data).toEqual(
      expect.objectContaining({ region_id: null, previous_region_id: null }),
    );
    expect(h.repo.save).not.toHaveBeenCalled();
  });

  it("hudud o'zgarmagan, lekin tuman bor → faqat district_id tozalanadi", async () => {
    const h = makeService({
      rows: [courierRow({ region_id: '7', district_id: '55' })],
    });

    await h.service.setCourierRegion('263', '7', superadmin);

    expect(h.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ region_id: '7', district_id: null }),
    );
    expect(h.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: { region_id: '7', district_id: '55' },
        new_value: { region_id: '7', district_id: null },
      }),
    );
  });

  it("kanonik ko'rinish: '007' ≡ '7' (bigint) — idempotent", async () => {
    const h = makeService({
      rows: [courierRow({ region_id: '7', district_id: null })],
    });

    const res = await h.service.setCourierRegion('263', '007', superadmin);

    expect(res.data).toEqual(expect.objectContaining({ region_id: '7' }));
    expect(h.repo.save).not.toHaveBeenCalled();
  });

  it.each([['abc'], ['1.5'], ['-1'], [' 7 '], [''], ['7a'], ['0x7'], ['1e3']])(
    "region_id %p → 400 \"region_id noto'g'ri\"; DB'ga murojaat yo‘q",
    async (regionId) => {
      const h = makeService({ rows: [courierRow()] });

      const err = await rpcErrorOf(
        h.service.setCourierRegion('263', regionId, superadmin),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: "region_id noto'g'ri",
        }),
      );
      expect(h.repo.findOne).not.toHaveBeenCalled();
      expect(h.repo.save).not.toHaveBeenCalled();
    },
  );

  it.each([[Roles.MANAGER], [Roles.REGISTRATOR], [Roles.COURIER]])(
    '%s so‘rovchi → 403',
    async (role) => {
      const h = makeService({ rows: [courierRow()] });

      const err = await rpcErrorOf(
        h.service.setCourierRegion('263', '7', { id: '19', roles: [role] }),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 403,
          message:
            "Kuryer hududini faqat superadmin yoki admin o'zgartira oladi",
        }),
      );
      expect(h.repo.save).not.toHaveBeenCalled();
    },
  );

  it('requester yo‘q (ishonchli ichki chaqiruv) → ruxsat etiladi', async () => {
    const h = makeService({ rows: [courierRow()] });

    const res = await h.service.setCourierRegion('263', '7');

    expect(res.statusCode).toBe(200);
    expect(h.repo.save).toHaveBeenCalledTimes(1);
  });

  it.each([[Roles.MANAGER], [Roles.MARKET], [Roles.REGISTRATOR]])(
    'kuryer bo‘lmagan user (%s) → 400',
    async (role) => {
      const h = makeService({ rows: [courierRow({ role })] });

      const err = await rpcErrorOf(
        h.service.setCourierRegion('263', '7', superadmin),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: "Faqat kuryer hududi shu yo'l bilan o'zgartiriladi",
        }),
      );
      expect(h.repo.save).not.toHaveBeenCalled();
    },
  );

  it("topilmagan yoki o'chirilgan user → 404 'User topilmadi'", async () => {
    const h = makeService({
      rows: [courierRow({ id: '300', isDeleted: true })],
    });

    for (const id of ['300', '999']) {
      const err = await rpcErrorOf(
        h.service.setCourierRegion(id, '7', superadmin),
      );
      expect(err).toEqual(
        expect.objectContaining({ statusCode: 404, message: 'User topilmadi' }),
      );
    }
    expect(h.repo.save).not.toHaveBeenCalled();
  });

  it("raqamli bo'lmagan user id → 404, DB'ga murojaat yo'q", async () => {
    const h = makeService({ rows: [courierRow()] });

    const err = await rpcErrorOf(
      h.service.setCourierRegion('abc', '7', superadmin),
    );

    expect(err.statusCode).toBe(404);
    expect(h.repo.findOne).not.toHaveBeenCalled();
  });

  it('DB xatosi (findOne yoki save) → RpcException 503: xom xato navbatga qayta qo‘yilmaydi', async () => {
    const dbError = Object.assign(new Error('Connection terminated'), {
      code: '57P01',
    });

    const saveFails = makeService({ rows: [courierRow()] });
    saveFails.repo.save.mockRejectedValueOnce(dbError);
    const findFails = makeService({ rows: [courierRow()] });
    findFails.repo.findOne.mockRejectedValueOnce(dbError);

    for (const h of [saveFails, findFails]) {
      const err = await rpcErrorOf(
        h.service.setCourierRegion('263', '7', superadmin),
      );
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 503,
          message:
            "Kuryer hududini saqlashda ma'lumotlar bazasi xatosi — hudud o'zgarmadi. Qayta urinib ko'ring.",
        }),
      );
    }
    expect(saveFails.activityLog.logChange).not.toHaveBeenCalled();
  });

  it('tranzaksiyaning o‘zi ochilmasa (ulanish xatosi) → RpcException 503, yozuv yo‘q', async () => {
    const h = makeService({ rows: [courierRow()] });
    h.repo.manager.transaction.mockRejectedValueOnce(
      Object.assign(new Error('too many clients already'), { code: '53300' }),
    );

    const err = await rpcErrorOf(
      h.service.setCourierRegion('263', '7', superadmin),
    );

    expect(err).toEqual(
      expect.objectContaining({
        statusCode: 503,
        message:
          "Kuryer hududini saqlashda ma'lumotlar bazasi xatosi — hudud o'zgarmadi. Qayta urinib ko'ring.",
      }),
    );
    expect(h.repo.save).not.toHaveBeenCalled();
    expect(h.activityLog.logChange).not.toHaveBeenCalled();
  });
});

describe('setCourierRegion — qator qulfi va deadline_at (kech set_region yozilmaydi)', () => {
  const NOW = 1_800_000_000_000;
  const DEADLINE_PASSED =
    "Kuryer hududini yangilash muddati o'tdi — hudud o'zgarmadi";
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    nowSpy.mockRestore();
  });

  it("o'qish va yozish BITTA tranzaksiyada, findOne FOR UPDATE bilan; audit commit'dan keyin", async () => {
    const h = makeService({ rows: [courierRow()] });

    const res = await h.service.setCourierRegion(
      '263',
      '7',
      superadmin,
      NOW + 5000,
    );

    expect(res.statusCode).toBe(200);
    expect(h.repo.manager.transaction).toHaveBeenCalledTimes(1);
    expect(h.repo.findOne).toHaveBeenCalledWith({
      where: { id: '263', isDeleted: false },
      lock: { mode: 'pessimistic_write' },
    });
    expect(h.events).toEqual([
      'tx:begin',
      'findOne',
      'save',
      'tx:commit',
      'logChange',
    ]);
  });

  it("muddat o'tgan → 409, hech narsa yozilmaydi (save, audit, qidiruv yo'q)", async () => {
    const h = makeService({ rows: [courierRow()] });

    const err = await rpcErrorOf(
      h.service.setCourierRegion('263', '7', superadmin, NOW - 1),
    );

    expect(err).toEqual(
      expect.objectContaining({ statusCode: 409, message: DEADLINE_PASSED }),
    );
    expect(h.repo.save).not.toHaveBeenCalled();
    expect(h.activityLog.logChange).not.toHaveBeenCalled();
    expect(h.searchClient.send).not.toHaveBeenCalled();
    // Qulf olingan (findOne), keyin rollback — yozuvsiz.
    expect(h.events).toEqual(['tx:begin', 'findOne', 'tx:rollback']);
  });

  it("muddat QULF OLINGANDAN keyin tekshiriladi: qulfni kutish paytida o'tib ketsa ham — 409, yozuv yo'q", async () => {
    const h = makeService({ rows: [courierRow()] });
    const deadline = NOW + 5000;
    const lockedRead = h.repo.findOne.getMockImplementation()!;
    // Qatorni boshqa tranzaksiya (tiklash) ushlab turibdi: qulf muddatdan
    // KEYIN beriladi.
    h.repo.findOne.mockImplementationOnce((options) => {
      nowSpy.mockReturnValue(deadline + 1);
      return lockedRead(options);
    });

    const err = await rpcErrorOf(
      h.service.setCourierRegion('263', '7', superadmin, deadline),
    );

    expect(err).toEqual(
      expect.objectContaining({ statusCode: 409, message: DEADLINE_PASSED }),
    );
    expect(h.repo.save).not.toHaveBeenCalled();
  });

  it("muddati o'tgan xabar o'zgarmas qiymatda ham ishlamaydi → 409", async () => {
    const h = makeService({
      rows: [courierRow({ region_id: '7', district_id: null })],
    });

    const err = await rpcErrorOf(
      h.service.setCourierRegion('263', '7', superadmin, NOW - 1),
    );

    expect(err.statusCode).toBe(409);
    expect(h.repo.save).not.toHaveBeenCalled();
  });

  it('muddat hali o‘tmagan (Date.now() === deadline_at) → yoziladi', async () => {
    const h = makeService({ rows: [courierRow()] });

    const res = await h.service.setCourierRegion('263', '7', superadmin, NOW);

    expect(res.data).toEqual(expect.objectContaining({ region_id: '7' }));
    expect(h.repo.save).toHaveBeenCalledTimes(1);
  });

  it("tiklash (deadline_at YO'Q) — vaqt qancha o'tgan bo'lsa ham yoziladi", async () => {
    // O'tkazish set_region(7) yiqilgan; kuryer qatorida 7 qolgan bo'lishi
    // mumkin — tiklash eski hududni (13) muddatsiz yozadi.
    const h = makeService({
      rows: [courierRow({ region_id: '7', district_id: null })],
    });
    nowSpy.mockReturnValue(NOW + 3_600_000);

    const res = await h.service.setCourierRegion('263', '13', superadmin);

    expect(res.data).toEqual({
      id: '263',
      region_id: '13',
      previous_region_id: '7',
      district_id: null,
    });
    expect(h.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '263',
        region_id: '13',
        district_id: null,
      }),
    );
    expect(h.repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it.each([[NaN], [Infinity], ['1700000000000']])(
    'deadline_at chekli son emas (%p) → hisobga olinmaydi, yoziladi',
    async (deadline) => {
      const h = makeService({ rows: [courierRow()] });

      const res = await h.service.setCourierRegion(
        '263',
        '7',
        superadmin,
        deadline as never,
      );

      expect(res.statusCode).toBe(200);
      expect(h.repo.save).toHaveBeenCalledTimes(1);
    },
  );
});

describe('identity.courier.set_region handleri', () => {
  const handler = Object.getOwnPropertyDescriptor(
    IdentityController.prototype,
    'setCourierRegion',
  )?.value as (
    payload: {
      id: string;
      region_id?: string | null;
      requester?: unknown;
      deadline_at?: number;
    },
    context: RmqContext,
  ) => Promise<unknown>;

  it("naqsh AYNAN { cmd: 'identity.courier.set_region' }", () => {
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: 'identity.courier.set_region' },
    ]);
  });

  it("(id, region_id, requester, deadline_at) servisga uzatiladi; region_id yo'q bo'lsa null, deadline_at yo'q bo'lsa undefined", async () => {
    const result = { statusCode: 200 };
    const userService = {
      setCourierRegion: jest.fn().mockResolvedValue(result),
    };
    const executeAndAck = jest.fn(
      (_ctx: RmqContext, fn: () => Promise<unknown>) => fn(),
    );
    const ctx = {} as RmqContext;

    const res = await handler.call(
      { executeAndAck, userService },
      {
        id: '263',
        region_id: '7',
        requester: superadmin,
        deadline_at: 1_800_000_005_000,
      },
      ctx,
    );
    await handler.call(
      { executeAndAck, userService },
      { id: '263', requester: superadmin },
      ctx,
    );

    expect(res).toBe(result);
    expect(executeAndAck).toHaveBeenCalledWith(ctx, expect.any(Function));
    expect(userService.setCourierRegion).toHaveBeenNthCalledWith(
      1,
      '263',
      '7',
      superadmin,
      1_800_000_005_000,
    );
    // Tiklash / qayta moslash: muddatsiz.
    expect(userService.setCourierRegion).toHaveBeenNthCalledWith(
      2,
      '263',
      null,
      superadmin,
      undefined,
    );
  });
});
