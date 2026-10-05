import { RpcException } from '@nestjs/microservices';
import { Observable, defer, of, throwError } from 'rxjs';
import { Cashbox_type, Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import type { RequesterContext } from './contracts/user.payloads';

/**
 * FIX3 (A7) — identity:
 *  - RBAC-19: admin o'z profilini/parolini tahrirlay oladi (o'chirish va
 *    status o'zgarmagan);
 *  - RBAC-09: parol yoki telefon (login) o'zgarsa refresh hashi o'chiriladi;
 *  - CODE-26: user yaratish saga'si — yozilib ulgurgan biriktirish saqlanadi,
 *    kassa yaratilmasa saga orqaga qaytariladi, kompensatsiya xatosi loglanadi.
 */

type Row = Record<string, unknown> & { id: string };

const OLD_HASH = 'f'.repeat(64);

const timeoutError = () =>
  Object.assign(new Error('Timeout has occurred'), { name: 'TimeoutError' });

interface HarnessOptions {
  rows?: Row[];
  assign?: (attempt: number) => Observable<unknown>;
  findByUser?: () => Observable<unknown>;
  remove?: () => Observable<unknown>;
  cashbox?: () => Observable<unknown>;
  failCompensationSave?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  let nextId = 900;
  let assignAttempts = 0;
  const rows = new Map<string, Row>(
    (options.rows ?? []).map((row) => [row.id, { ...row }]),
  );
  const saves: Record<string, unknown>[] = [];

  const repo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      if (typeof where.id === 'string') {
        const row = rows.get(where.id);
        if (!row || row.isDeleted !== false) return Promise.resolve(null);
        if (where.role && row.role !== where.role) return Promise.resolve(null);
        return Promise.resolve(row);
      }
      // ensurePhoneUnique / ensureUsernameUnique — band emas.
      return Promise.resolve(null);
    }),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn((value: Record<string, unknown>) => {
      if (options.failCompensationSave && value.isDeleted === true) {
        return Promise.reject(new Error('db down'));
      }
      saves.push({ ...value });
      const id = typeof value.id === 'string' ? value.id : String(nextId++);
      const row: Row = { ...value, id };
      rows.set(id, row);
      return Promise.resolve(row);
    }),
  };

  const branchClient = {
    send: jest.fn(({ cmd }: { cmd: string }) => {
      switch (cmd) {
        case 'branch.find_hq':
          return of({ statusCode: 200, data: { id: '1', type: 'HQ' } });
        case 'branch.user.assign':
          return defer(() => {
            assignAttempts += 1;
            return options.assign
              ? options.assign(assignAttempts)
              : of({ statusCode: 201, data: { id: 'bu-1' } });
          });
        case 'branch.user.find_by_user':
          return options.findByUser ? options.findByUser() : of({ data: null });
        case 'branch.user.remove':
          return options.remove
            ? options.remove()
            : of({ statusCode: 200, data: {} });
        default:
          return of({ data: null });
      }
    }),
    emit: jest.fn(),
  };
  const financeClient = {
    send: jest.fn(() =>
      options.cashbox ? options.cashbox() : of({ statusCode: 201 }),
    ),
    emit: jest.fn(),
  };
  const logisticsClient = {
    send: jest.fn(() => of({ data: { id: '13' } })),
    emit: jest.fn(),
  };
  const searchClient = {
    send: jest.fn(() => of({ ok: true })),
    emit: jest.fn(),
  };
  const noopClient = { send: jest.fn(() => of({})), emit: jest.fn() };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  const service = new UserServiceService(
    repo as never,
    searchClient as never, // search
    noopClient as never, // catalog
    noopClient as never, // order
    logisticsClient as never, // logistics
    financeClient as never, // finance
    branchClient as never, // branch
    {
      encrypt: jest.fn((value: string) => Promise.resolve(`hashed:${value}`)),
      compare: jest.fn(),
    } as never,
    { get: jest.fn() } as never,
    activityLog as never,
  );
  const loggerError = jest
    .spyOn(
      (service as unknown as { logger: { error: () => void } }).logger,
      'error',
    )
    .mockImplementation(() => undefined);
  jest
    .spyOn(
      (service as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    )
    .mockImplementation(() => undefined);

  return {
    service,
    rows,
    saves,
    branchClient,
    financeClient,
    activityLog,
    loggerError,
    assignAttempts: () => assignAttempts,
    branchCmds: () =>
      branchClient.send.mock.calls.map(([p]) => (p as { cmd: string }).cmd),
    branchPayload: (cmd: string) =>
      branchClient.send.mock.calls.find(
        ([p]) => (p as { cmd: string }).cmd === cmd,
      )?.[1] as Record<string, unknown> | undefined,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('rad etilishi kutilgandi');
    },
    (error: unknown) => error,
  );
}

async function rpcErrorOf(promise: Promise<unknown>) {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
}

const adminRow = (id: string): Row => ({
  id,
  role: Roles.ADMIN,
  name: `Admin ${id}`,
  phone_number: `+99890000000${id}`,
  password: 'old-hash',
  refresh_token: OLD_HASH,
  status: Status.ACTIVE,
  salary: 1_000_000,
  isDeleted: false,
});

const courierRow = (): Row => ({
  id: '9',
  role: Roles.COURIER,
  name: 'Kuryer',
  phone_number: '+998900009911',
  password: 'old-hash',
  refresh_token: OLD_HASH,
  status: Status.ACTIVE,
  isDeleted: false,
});

const marketRow = (): Row => ({
  id: '3',
  role: Roles.MARKET,
  name: 'Yandex',
  phone_number: '+998900000001',
  username: 'yandex',
  password: 'old-hash',
  refresh_token: OLD_HASH,
  status: Status.ACTIVE,
  isDeleted: false,
});

const admin10: RequesterContext = { id: '10', roles: ['admin'] };
const superadmin: RequesterContext = { id: '1', roles: ['superadmin'] };
const manager: RequesterContext = {
  id: '2',
  roles: ['manager'],
  allowed_user_ids: ['9'],
};

describe('RBAC-19: admin o‘z profilini tahrirlaydi', () => {
  it('admin o‘z parolini va ismini almashtira oladi', async () => {
    const h = makeHarness({ rows: [adminRow('10')] });

    const res = await h.service.updateUser(
      '10',
      { password: 'yangi-parol', name: 'Yangi ism' } as never,
      admin10,
    );

    expect(res.statusCode).toBe(200);
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({
        password: 'hashed:yangi-parol',
        name: 'Yangi ism',
      }),
    );
  });

  it('o‘z-o‘zini tahrirlashda status va maosh baribir o‘zgarmaydi', async () => {
    const h = makeHarness({ rows: [adminRow('10')] });

    await h.service.updateUser(
      '10',
      { status: Status.INACTIVE, salary: 99_999_999 } as never,
      admin10,
    );

    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ status: Status.ACTIVE, salary: 1_000_000 }),
    );
  });

  it('admin boshqa adminni hali ham tahrirlay olmaydi (403)', async () => {
    const h = makeHarness({ rows: [adminRow('11')] });

    const err = await rpcErrorOf(
      h.service.updateUser('11', { name: 'X' } as never, admin10),
    );

    expect(err).toEqual(
      expect.objectContaining({
        statusCode: 403,
        message: 'Admin admin yoki superadminni boshqara olmaydi',
      }),
    );
    expect(h.saves).toHaveLength(0);
  });

  it('admin o‘zini o‘chira olmaydi va statusini o‘zgartira olmaydi (o‘zgarmagan)', async () => {
    const h = makeHarness({ rows: [adminRow('10')] });

    const del = await rpcErrorOf(h.service.deleteUser('10', admin10));
    const status = await rpcErrorOf(
      h.service.setUserStatus('10', Status.INACTIVE, admin10),
    );

    expect(del.statusCode).toBe(403);
    expect(status.statusCode).toBe(403);
    expect(h.saves).toHaveLength(0);
  });
});

describe('RBAC-09: parol/telefon o‘zgarsa sessiyalar yopiladi', () => {
  it('menejer kuryer parolini almashtirsa — refresh hashi o‘chiriladi', async () => {
    // #3 — manager faqat O'ZI yaratgan foydalanuvchini tahrirlaydi: courier.created_by = manager.id ('2').
    const h = makeHarness({ rows: [{ ...courierRow(), created_by: '2' }] });

    await h.service.updateUser('9', { password: 'yangi' } as never, manager);

    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({
        password: 'hashed:yangi',
        refresh_token: null,
      }),
    );
  });

  it('telefon (login) o‘zgarsa — refresh hashi o‘chiriladi', async () => {
    const h = makeHarness({ rows: [courierRow()] });

    await h.service.updateUser(
      '9',
      { phone_number: '+998900009999' } as never,
      superadmin,
    );

    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({
        phone_number: '+998900009999',
        refresh_token: null,
      }),
    );
  });

  it('boshqa maydonlar (ism, o‘sha telefon) sessiyaga tegmaydi', async () => {
    const h = makeHarness({ rows: [courierRow()] });

    await h.service.updateUser(
      '9',
      { name: 'Boshqa ism', phone_number: '+998900009911' } as never,
      superadmin,
    );

    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ name: 'Boshqa ism', refresh_token: OLD_HASH }),
    );
  });

  it('market paroli almashtirilsa (updateMarket) — refresh hashi o‘chiriladi', async () => {
    const h = makeHarness({ rows: [marketRow()] });

    await h.service.updateMarket(
      '3',
      { password: 'yangi' } as never,
      superadmin,
    );

    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({
        password: 'hashed:yangi',
        refresh_token: null,
      }),
    );
  });

  it('market sozlamasi (add_order) sessiyaga tegmaydi', async () => {
    const h = makeHarness({ rows: [marketRow()] });

    await h.service.updateMarket('3', { add_order: true } as never, superadmin);

    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ add_order: true, refresh_token: OLD_HASH }),
    );
  });
});

const courierDto = () =>
  ({
    name: 'Yangi kuryer',
    phone_number: '+998903001234',
    password: '0990',
    tariff_home: 15000,
    tariff_center: 10000,
    region_id: '13',
    branch_id: '18',
  }) as never;

const managerDto = () =>
  ({
    name: 'Yangi menejer',
    phone_number: '+998903001235',
    password: '0990',
    branch_id: '15',
  }) as never;

const marketDto = () =>
  ({
    name: 'Yangi market',
    phone_number: '+998903001236',
    username: 'yangi_market',
    password: '0990',
    tariff_home: 30000,
    tariff_center: 20000,
  }) as never;

describe('CODE-26: branch.user.assign yozilib ulgurgan bo‘lsa user saqlanadi', () => {
  it('1-urinish timeout (yozilgan), 2-urinish 409 → biriktirish bor: user o‘chirilmaydi, kassa yaratiladi', async () => {
    const h = makeHarness({
      assign: (attempt) =>
        attempt === 1
          ? throwError(timeoutError)
          : throwError(() => ({
              statusCode: 409,
              message: 'Foydalanuvchi bu filialga allaqachon biriktirilgan',
            })),
      findByUser: () => of({ data: { branch_id: '18' } }),
    });

    const res = await h.service.createCourier(courierDto(), superadmin);

    expect(res).toEqual(
      expect.objectContaining({
        statusCode: 201,
        message: 'Courier yaratildi',
      }),
    );
    expect(h.assignAttempts()).toBe(2);
    expect(h.saves).toHaveLength(1);
    expect(h.financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.create' },
      expect.objectContaining({ cashbox_type: Cashbox_type.FOR_COURIER }),
    );
    expect(h.branchPayload('branch.user.find_by_user')).toEqual(
      expect.objectContaining({ user_id: '900' }),
    );
  });

  it('biriktirish boshqa filialda — 409 qaytadi va user soft-delete', async () => {
    const h = makeHarness({
      assign: () =>
        throwError(() => ({
          statusCode: 409,
          message: 'Foydalanuvchi bu filialga allaqachon biriktirilgan',
        })),
      findByUser: () => of({ data: { branch_id: '77' } }),
    });

    const err = await rpcErrorOf(
      h.service.createCourier(courierDto(), superadmin),
    );

    expect(err.statusCode).toBe(409);
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ isDeleted: true }),
    );
  });

  it('ikkala urinish ham timeout va biriktirish yo‘q — user soft-delete, xato o‘zgarishsiz', async () => {
    const failure = timeoutError();
    const h = makeHarness({
      assign: () => throwError(() => failure),
      findByUser: () => of({ data: null }),
    });

    const error = await rejectionOf(
      h.service.createCourier(courierDto(), superadmin),
    );

    expect(error).toBe(failure);
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ isDeleted: true }),
    );
    expect(h.financeClient.send).not.toHaveBeenCalled();
  });

  it('tekshiruvning o‘zi yiqilsa — avvalgidek kompensatsiya', async () => {
    const failure = timeoutError();
    const h = makeHarness({
      assign: () => throwError(() => failure),
      findByUser: () => throwError(timeoutError),
    });

    const error = await rejectionOf(
      h.service.createCourier(courierDto(), superadmin),
    );

    expect(error).toBe(failure);
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ isDeleted: true }),
    );
  });

  it('403 rad javobi — solishtirish so‘rovi yuborilmaydi (o‘zgarmagan)', async () => {
    const h = makeHarness({
      assign: () =>
        throwError(() => ({
          statusCode: 403,
          message:
            'Courier faqat HQ, REGIONAL yoki HYBRID branchga biriktirilishi mumkin',
        })),
    });

    const err = await rpcErrorOf(
      h.service.createCourier(courierDto(), superadmin),
    );

    expect(err.statusCode).toBe(403);
    expect(h.branchCmds()).toEqual(['branch.user.assign']);
  });
});

describe('CODE-26: kassa yaratilmasa saga orqaga qaytariladi', () => {
  it('kuryer: finance 503 — filial qatori olib tashlanadi, user soft-delete, xato o‘zgarishsiz', async () => {
    const failure = { statusCode: 503, message: 'Finance service unavailable' };
    const h = makeHarness({ cashbox: () => throwError(() => failure) });

    const error = await rejectionOf(
      h.service.createCourier(courierDto(), manager),
    );

    expect(error).toBe(failure);
    expect(h.branchPayload('branch.user.remove')).toEqual({
      requester: manager,
      branch_id: '18',
      user_id: '900',
    });
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({
        id: '900',
        isDeleted: true,
        status: Status.INACTIVE,
        phone_number: expect.stringMatching(/^\+998903001234-d\d+$/),
      }),
    );
    expect(h.activityLog.log).not.toHaveBeenCalled();
    expect(h.loggerError).toHaveBeenCalledWith(
      expect.stringContaining('finance.cashbox.create (couriers) failed'),
    );
  });

  it('kuryer: finance 4xx — aniq status bilan RpcException (qayta navbat yo‘q)', async () => {
    const h = makeHarness({
      cashbox: () =>
        throwError(() => ({ statusCode: 400, message: 'user_id noto‘g‘ri' })),
    });

    const err = await rpcErrorOf(
      h.service.createCourier(courierDto(), superadmin),
    );

    expect(err).toEqual(
      expect.objectContaining({
        statusCode: 400,
        message: 'user_id noto‘g‘ri',
      }),
    );
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ isDeleted: true }),
    );
  });

  it('market: kassa yaratilmasa soft-delete, filial chaqiruvi yo‘q', async () => {
    const failure = timeoutError();
    const h = makeHarness({ cashbox: () => throwError(() => failure) });

    const error = await rejectionOf(
      h.service.createMarket(marketDto(), superadmin),
    );

    expect(error).toBe(failure);
    expect(h.branchCmds()).not.toContain('branch.user.remove');
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ isDeleted: true, role: Roles.MARKET }),
    );
  });

  it('menejer: filial kassasi tekshirilmasa — menejer qatori olib tashlanadi va soft-delete', async () => {
    const failure = { statusCode: 502, message: 'Finance down' };
    const h = makeHarness({ cashbox: () => throwError(() => failure) });

    const error = await rejectionOf(
      h.service.createManager(managerDto(), superadmin),
    );

    expect(error).toBe(failure);
    expect(h.financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.create' },
      expect.objectContaining({
        user_id: '15',
        cashbox_type: Cashbox_type.BRANCH,
      }),
    );
    expect(h.branchPayload('branch.user.remove')).toEqual(
      expect.objectContaining({ branch_id: '15', user_id: '900' }),
    );
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ isDeleted: true }),
    );
  });

  it('filial qatorini olib tashlab bo‘lmasa ham user soft-delete, xato ERROR loglanadi', async () => {
    const failure = { statusCode: 503, message: 'Finance service unavailable' };
    const h = makeHarness({
      cashbox: () => throwError(() => failure),
      remove: () =>
        throwError(() => ({ statusCode: 503, message: 'holdings check down' })),
    });

    const error = await rejectionOf(
      h.service.createCourier(courierDto(), superadmin),
    );

    expect(error).toBe(failure);
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ isDeleted: true }),
    );
    expect(h.loggerError).toHaveBeenCalledWith(
      expect.stringContaining(
        'branch_users row (branch 18, user 900) was NOT removed',
      ),
    );
  });

  it('kompensatsiyaning o‘zi yiqilsa — jimgina yutilmaydi (ERROR log), asl xato qaytadi', async () => {
    const failure = { statusCode: 503, message: 'Finance service unavailable' };
    const h = makeHarness({
      cashbox: () => throwError(() => failure),
      failCompensationSave: true,
    });

    const error = await rejectionOf(
      h.service.createCourier(courierDto(), superadmin),
    );

    expect(error).toBe(failure);
    expect(h.loggerError).toHaveBeenCalledWith(
      expect.stringContaining(
        'Saga compensation failed: user 900 was NOT soft-deleted',
      ),
    );
  });

  it('muvaffaqiyat (nazorat): kompensatsiya chaqiruvlari yo‘q', async () => {
    const h = makeHarness();

    const res = await h.service.createCourier(courierDto(), superadmin);

    expect(res.statusCode).toBe(201);
    expect(h.branchCmds()).toEqual(['branch.user.assign']);
    expect(h.saves).toHaveLength(1);
    expect(h.loggerError).not.toHaveBeenCalled();
  });
});
