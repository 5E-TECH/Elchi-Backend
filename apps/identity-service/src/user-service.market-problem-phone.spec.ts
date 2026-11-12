import { RpcException } from '@nestjs/microservices';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * (Dilshod 2026-11-12) Market «Qo'shimcha raqam» (identity `updateMarket`):
 *  - faqat admin/superadmin (market o'zi — 403);
 *  - raqam `+998XXXXXXXXX` ga keltiriladi, noto'g'ri — 400;
 *  - yoqiq holat raqamsiz — 400 (shu so'rovda yoki avval saqlangan);
 *  - o'chirishda raqam saqlanib qoladi (qayta yoqish — raqamsiz ham bo'ladi);
 *  - audit eski/yangi qiymatlarda.
 */
type Row = Record<string, unknown>;

const ADMIN = { id: '2', roles: [Roles.ADMIN] };
const SUPERADMIN = { id: '1', roles: [Roles.SUPERADMIN] };
const MARKET = { id: '37', roles: [Roles.MARKET] };

const market = (over: Row = {}): Row => ({
  id: '37',
  role: Roles.MARKET,
  name: 'TEST Claude Market',
  phone_number: '+998900000037',
  status: Status.ACTIVE,
  isDeleted: false,
  problem_phone_enabled: false,
  problem_phone: null,
  ...over,
});

function makeService(existing: Row) {
  const saved: Row[] = [];
  const users = {
    findOne: jest.fn(() => Promise.resolve({ ...existing })),
    save: jest.fn((row: Row) => {
      saved.push({ ...row });
      return Promise.resolve({ ...row });
    }),
  };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const service = Object.create(UserServiceService.prototype) as Row &
    UserServiceService;
  Object.assign(service, {
    users,
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    activityLog,
    ensurePhoneUnique: jest.fn().mockResolvedValue(undefined),
    syncUserToSearch: jest.fn().mockResolvedValue(undefined),
    revokeSessionsAfterSecurityChange: jest.fn().mockResolvedValue(undefined),
  });
  return { service, users, saved, activityLog };
}

const rpcError = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
};

describe("Market «Qo'shimcha raqam» — identity updateMarket", () => {
  it('⭐ admin yoqadi + raqam: kanonik +998 shaklda saqlanadi, audit', async () => {
    const { service, saved, activityLog } = makeService(market());
    await service.updateMarket(
      '37',
      { problem_phone_enabled: true, problem_phone: '93 555 00 11' },
      ADMIN,
    );
    expect(saved[0]).toEqual(
      expect.objectContaining({
        problem_phone_enabled: true,
        problem_phone: '+998935550011',
      }),
    );
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: expect.objectContaining({
          problem_phone_enabled: false,
          problem_phone: null,
        }),
        new_value: expect.objectContaining({
          problem_phone_enabled: true,
          problem_phone: '+998935550011',
        }),
      }),
    );
  });

  it('⭐ raqamsiz yoqish — 400, hech narsa saqlanmaydi', async () => {
    const { service, users } = makeService(market());
    const error = await rpcError(
      service.updateMarket('37', { problem_phone_enabled: true }, SUPERADMIN),
    );
    expect(error.statusCode).toBe(400);
    expect(users.save).not.toHaveBeenCalled();
  });

  it('avval saqlangan raqam bilan qayta yoqish — o`tadi', async () => {
    const { service, saved } = makeService(
      market({ problem_phone: '+998935550011' }),
    );
    await service.updateMarket('37', { problem_phone_enabled: true }, ADMIN);
    expect(saved[0]).toEqual(
      expect.objectContaining({
        problem_phone_enabled: true,
        problem_phone: '+998935550011',
      }),
    );
  });

  it('o`chirish — raqam saqlanib qoladi', async () => {
    const { service, saved } = makeService(
      market({ problem_phone_enabled: true, problem_phone: '+998935550011' }),
    );
    await service.updateMarket('37', { problem_phone_enabled: false }, ADMIN);
    expect(saved[0]).toEqual(
      expect.objectContaining({
        problem_phone_enabled: false,
        problem_phone: '+998935550011',
      }),
    );
  });

  it('yoqiq holatda raqamni o`chirish (null / "") — 400', async () => {
    for (const value of [null, '  ']) {
      const { service, users } = makeService(
        market({ problem_phone_enabled: true, problem_phone: '+998935550011' }),
      );
      const error = await rpcError(
        service.updateMarket('37', { problem_phone: value }, ADMIN),
      );
      expect(error.statusCode).toBe(400);
      expect(users.save).not.toHaveBeenCalled();
    }
  });

  it('noto`g`ri raqam — 400; boolean bo`lmagan bayroq — 400', async () => {
    const bad = makeService(market());
    expect(
      (
        await rpcError(
          bad.service.updateMarket(
            '37',
            { problem_phone_enabled: true, problem_phone: '12345' },
            ADMIN as never,
          ),
        )
      ).statusCode,
    ).toBe(400);
    const notBool = makeService(market());
    expect(
      (
        await rpcError(
          notBool.service.updateMarket(
            '37',
            { problem_phone_enabled: 'yes' } as never,
            ADMIN as never,
          ),
        )
      ).statusCode,
    ).toBe(400);
  });

  it('⭐ market o`zi — 403 (faqat admin/superadmin)', async () => {
    const { service, users } = makeService(market());
    const error = await rpcError(
      service.updateMarket(
        '37',
        {
          problem_phone_enabled: true,
          problem_phone: '+998935550011',
        },
        MARKET,
      ),
    );
    expect(error.statusCode).toBe(403);
    expect(users.save).not.toHaveBeenCalled();
  });

  it('boshqa sozlama — «Qo`shimcha raqam» tegilmaydi', async () => {
    const { service, saved } = makeService(
      market({ problem_phone_enabled: true, problem_phone: '+998935550011' }),
    );
    await service.updateMarket('37', { cashbox_debt_enabled: true }, ADMIN);
    expect(saved[0]).toEqual(
      expect.objectContaining({
        problem_phone_enabled: true,
        problem_phone: '+998935550011',
      }),
    );
  });
});
