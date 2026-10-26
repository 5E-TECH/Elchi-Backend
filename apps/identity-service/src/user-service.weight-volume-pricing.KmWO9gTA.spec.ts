import { RpcException } from '@nestjs/microservices';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * KmWO9gTA — market «Vazn va hajm bo'yicha narx» kaliti
 * (`weight_volume_pricing`, sukut TRUE, migratsiya 1716000000182) va market
 * profil tariflarining LEGACY (ixtiyoriy) bo'lishi:
 *   - faqat SUPERADMIN/ADMIN o'zgartiradi — `identity.market.update` va
 *     `identity.user.update`; market o'zi / menejer — 403; boolean emas — 400;
 *     market bo'lmagan foydalanuvchi — 400; audit izida eski/yangi qiymat;
 *   - `identity.market.find_by_ids` (order-service sotuvi) maydonni qaytaradi;
 *   - market yaratishda tarif MAJBURIY EMAS: berilmasa NULL (0 emas — 0
 *     "bepul yetkazish" degani), kalit sukuti TRUE, menejer kalitni bera
 *     olmaydi.
 */
type Row = Record<string, unknown>;

const SUPERADMIN = { id: '1', roles: [Roles.SUPERADMIN] };
const ADMIN = { id: '2', roles: [Roles.ADMIN] };
const MANAGER = { id: '5', roles: [Roles.MANAGER] };
const MARKET = { id: '37', roles: [Roles.MARKET] };

const marketRow = (): Row => ({
  id: '37',
  role: Roles.MARKET,
  name: 'TEST Claude Market',
  phone_number: '+998900000037',
  status: Status.ACTIVE,
  isDeleted: false,
  tariff_home: 70000,
  tariff_center: 45000,
  weight_volume_pricing: true,
  created_by: '5',
});

function makeService(target: Row) {
  const saved: Row[] = [];
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const service = Object.create(UserServiceService.prototype) as Row &
    UserServiceService;
  Object.assign(service, {
    users: {
      findOne: jest.fn(() => Promise.resolve({ ...target })),
      find: jest.fn(() => Promise.resolve([{ ...target }])),
      create: jest.fn((row: Row) => ({ ...row })),
      save: jest.fn((row: Row) => {
        saved.push(row);
        return Promise.resolve({ id: '900', ...row });
      }),
    },
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    activityLog,
    syncUserToSearch: jest.fn().mockResolvedValue(undefined),
    ensurePhoneUnique: jest.fn().mockResolvedValue(undefined),
    ensureUsernameUnique: jest.fn().mockResolvedValue(undefined),
    assertPasswordPolicy: jest.fn(),
    bcryptEncryption: { encrypt: jest.fn().mockResolvedValue('hash') },
    generateGroupToken: jest.fn(() => 'tg-token'),
    ensureCreatedUserCashboxOrCompensate: jest
      .fn()
      .mockResolvedValue(undefined),
  });
  return { service, saved, activityLog };
}

const rpcError = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as { statusCode?: number };
};

const createDto = (over: Row = {}) =>
  ({
    name: 'Yangi market',
    phone_number: '+998901234567',
    username: 'market_new',
    password: 'Str0ng!Passw0rd',
    default_tariff: 'center',
    ...over,
  }) as never;

describe('KmWO9gTA — market weight_volume_pricing (identity)', () => {
  it('⭐ market.update: admin o`chiradi; audit izida eski/yangi qiymat', async () => {
    const { service, saved, activityLog } = makeService(marketRow());
    await service.updateMarket(
      '37',
      { weight_volume_pricing: false } as never,
      ADMIN as never,
    );
    expect(saved.at(-1)).toMatchObject({ weight_volume_pricing: false });
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: expect.objectContaining({ weight_volume_pricing: true }),
        new_value: expect.objectContaining({ weight_volume_pricing: false }),
      }),
    );
  });

  it('⭐ market o`zi yoki menejer — 403; boolean emas — 400; hech narsa saqlanmaydi', async () => {
    for (const requester of [MARKET, MANAGER, undefined]) {
      const { service, saved } = makeService(marketRow());
      expect(
        await rpcError(
          service.updateMarket(
            '37',
            { weight_volume_pricing: false } as never,
            requester as never,
          ),
        ),
      ).toMatchObject({ statusCode: 403 });
      expect(saved).toHaveLength(0);
    }
    const { service, saved } = makeService(marketRow());
    expect(
      await rpcError(
        service.updateMarket(
          '37',
          { weight_volume_pricing: 'false' } as never,
          SUPERADMIN as never,
        ),
      ),
    ).toMatchObject({ statusCode: 400 });
    expect(saved).toHaveLength(0);
  });

  it('user.update: admin saqlaydi; menejer 403; market bo`lmagan — 400', async () => {
    const ok = makeService(marketRow());
    await ok.service.updateUser(
      '37',
      { weight_volume_pricing: false } as never,
      ADMIN as never,
    );
    expect(ok.saved.at(-1)).toMatchObject({ weight_volume_pricing: false });

    const manager = makeService(marketRow());
    expect(
      await rpcError(
        manager.service.updateUser(
          '37',
          { weight_volume_pricing: false } as never,
          MANAGER as never,
        ),
      ),
    ).toMatchObject({ statusCode: 403 });

    const courier = makeService({
      ...marketRow(),
      id: '40',
      role: Roles.COURIER,
    });
    expect(
      await rpcError(
        courier.service.updateUser(
          '40',
          { weight_volume_pricing: false } as never,
          ADMIN as never,
        ),
      ),
    ).toMatchObject({ statusCode: 400 });
  });

  it('identity.market.find_by_ids (order-service sotuvi) maydonni qaytaradi', async () => {
    const { service } = makeService({
      ...marketRow(),
      weight_volume_pricing: false,
    });
    const res = (await service.findMarketsByIds(['37'])) as {
      data: Row[];
    };
    expect(res.data[0]).toMatchObject({
      id: '37',
      weight_volume_pricing: false,
      tariff_center: 45000,
    });
  });
});

describe('KmWO9gTA — TC13: market yaratishda tarif majburiy emas', () => {
  it('⭐ tarifsiz market — NULL (0 emas), kalit sukuti TRUE', async () => {
    const { service, saved } = makeService(marketRow());
    await service.createMarket(createDto(), ADMIN as never);
    expect(saved.at(-1)).toMatchObject({
      tariff_home: null,
      tariff_center: null,
      weight_volume_pricing: true,
      role: Roles.MARKET,
    });
  });

  it('tarif berilsa — o`sha; admin kalitni o`chirib yaratadi', async () => {
    const { service, saved } = makeService(marketRow());
    await service.createMarket(
      createDto({
        tariff_home: 0,
        tariff_center: 30000,
        weight_volume_pricing: false,
      }),
      SUPERADMIN as never,
    );
    expect(saved.at(-1)).toMatchObject({
      tariff_home: 0,
      tariff_center: 30000,
      weight_volume_pricing: false,
    });
  });

  it('menejer kalitni bera olmaydi (403), kalitsiz — yaratadi', async () => {
    const denied = makeService(marketRow());
    expect(
      await rpcError(
        denied.service.createMarket(
          createDto({ weight_volume_pricing: false }),
          MANAGER as never,
        ),
      ),
    ).toMatchObject({ statusCode: 403 });
    expect(denied.saved).toHaveLength(0);

    const ok = makeService(marketRow());
    await ok.service.createMarket(createDto(), MANAGER as never);
    expect(ok.saved.at(-1)).toMatchObject({ weight_volume_pricing: true });
  });
});
