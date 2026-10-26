import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Roles, Status } from '@app/common';
import { RequesterContext } from './contracts/user.payloads';
import { UserServiceService } from './user-service.service';

/**
 * (NDmZMzCP) Parol siyosati identity-service ICHIDA ham (RMQ'da
 * ValidationPipe yo'q): yaratish / tahrirlash / o'z profili — min 8, xodim 10,
 * oddiy parollar taqiqlangan; rad etilsa xeshlanmaydi va saqlanmaydi.
 * O'zi parolni almashtirsa `must_change_password` tushadi.
 */
type Row = Record<string, unknown>;

function makeService(existing: Row | null = null) {
  const saves: Row[] = [];
  const repo = {
    findOne: jest.fn(() => Promise.resolve(existing ? { ...existing } : null)),
    find: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => Promise.resolve(0)),
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((value: Row) => {
      saves.push({ ...value });
      return Promise.resolve({ id: '700', ...value });
    }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const ok = {
    send: jest.fn(() => of({ statusCode: 200, data: { id: '3' } })),
    emit: jest.fn(),
  };
  const encrypt = jest.fn((value: string) =>
    Promise.resolve(`hashed:${value}`),
  );
  const service = new UserServiceService(
    repo as never,
    ok as never, // search
    ok as never, // catalog
    ok as never, // order
    ok as never, // logistics
    ok as never, // finance
    ok as never, // branch
    { encrypt, compare: jest.fn() } as never,
    { get: jest.fn() } as never,
    {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    } as never,
  );
  return { service, saves, encrypt, repo };
}

const superadmin: RequesterContext = { id: '1', roles: ['superadmin'] };

async function rpcErrorOf(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
}

describe('NDmZMzCP — parol siyosati identity-service ichida', () => {
  it.each([
    ['createAdmin', '123456789'],
    ['createRegistrator', 'Qisqa-123'],
    ['createLogist', '0990'],
    ['createManager', '1234567890'],
  ] as const)(
    '%s: xodim paroli (%s) — 400, xeshlanmaydi va saqlanmaydi',
    async (method, password) => {
      const t = makeService();
      const error = await rpcErrorOf(
        (
          t.service[method] as unknown as (
            dto: Row,
            requester: RequesterContext,
          ) => Promise<unknown>
        ).call(
          t.service,
          {
            name: 'TEST xodim',
            phone_number: '+998935557711',
            password,
            salary: 0,
          },
          superadmin,
        ),
      );
      expect(error.statusCode).toBe(400);
      expect(error.message).toMatch(/Parol/);
      expect(t.encrypt).not.toHaveBeenCalled();
      expect(t.saves).toEqual([]);
    },
  );

  it('createCourier: 9 belgi — 400 (kuryer xodim, kamida 10)', async () => {
    const t = makeService();
    const error = await rpcErrorOf(
      t.service.createCourier(
        {
          name: 'TEST Kuryer',
          phone_number: '+998935557711',
          password: 'Kuryer-12',
          tariff_home: 1,
          tariff_center: 1,
        } as never,
        superadmin,
      ),
    );
    expect(error).toMatchObject({
      statusCode: 400,
      message: "Parol kamida 10 belgidan iborat bo'lishi kerak",
    });
    expect(t.encrypt).not.toHaveBeenCalled();
  });

  it('createUserForAuth (mijoz): oddiy parol — 400', async () => {
    const t = makeService();
    const error = await rpcErrorOf(
      t.service.createUserForAuth('mijoz', 'password', '+998935557711'),
    );
    expect(error).toMatchObject({
      statusCode: 400,
      message: 'Parol juda oddiy — boshqa parol tanlang',
    });
  });

  it('updateUser: admin kuryerga qisqa parol o‘rnata olmaydi (rol bo‘yicha 10)', async () => {
    const t = makeService({
      id: '26',
      role: Roles.COURIER,
      phone_number: '+998935557711',
      password: 'hashed:old',
      status: Status.ACTIVE,
      isDeleted: false,
      session_epoch: 0,
      must_change_password: false,
    });
    const error = await rpcErrorOf(
      t.service.updateUser(
        '26',
        { password: 'Yangi-123' } as never,
        superadmin,
      ),
    );
    expect(error.statusCode).toBe(400);
    expect(t.saves).toEqual([]);
  });

  it('updateUser: O‘ZI parolni almashtirsa must_change_password = false; admin o‘rnatsa o‘zgarmaydi', async () => {
    const row = {
      id: '25',
      role: Roles.MANAGER,
      phone_number: '+998935557711',
      password: 'hashed:0990',
      status: Status.ACTIVE,
      isDeleted: false,
      session_epoch: 0,
      must_change_password: true,
    };
    const self = makeService(row);
    await self.service.updateUser(
      '25',
      { password: 'Yangi-Parol-2026' } as never,
      { id: '25', roles: ['manager'] },
    );
    expect(self.saves[0]).toMatchObject({
      password: 'hashed:Yangi-Parol-2026',
      must_change_password: false,
    });

    const admin = makeService(row);
    await admin.service.updateUser(
      '25',
      { password: 'Admin-Bergan-2026' } as never,
      superadmin,
    );
    expect(admin.saves[0]).toMatchObject({
      password: 'hashed:Admin-Bergan-2026',
      must_change_password: true,
    });
  });
});
