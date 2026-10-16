import { RpcException } from '@nestjs/microservices';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * w2bDrE3i — market bo'yicha qo'shimcha xarajat sozlamasi va VRyloH62 —
 * operator raqami sozlamasi (identity tomoni):
 *   - YANGI market sukuti: extra_cost_enabled=false,
 *     extra_cost_requires_approval=true, require_operator_phone=false;
 *   - extra_cost_* ni faqat admin/superadmin o'zgartiradi (market — 403);
 *   - boolean bo'lmagan qiymat — 400 (RMQ'da ValidationPipe yo'q);
 *   - default_operator_phone `+998XXXXXXXXX` ga keltiriladi, '' → null,
 *     noto'g'ri → 400.
 */
type Row = Record<string, unknown>;

const SUPERADMIN = { id: '1', roles: [Roles.SUPERADMIN] };
const ADMIN = { id: '2', roles: [Roles.ADMIN] };
const MARKET = { id: '37', roles: [Roles.MARKET] };

function makeService(existing?: Row) {
  const saved: Row[] = [];
  const users = {
    findOne: jest.fn(() => Promise.resolve(existing ? { ...existing } : null)),
    create: jest.fn((row: Row) => ({ ...row })),
    save: jest.fn((row: Row) => {
      const out = { id: (row.id as string) ?? '900', ...row };
      saved.push(out);
      return Promise.resolve(out);
    }),
  };
  const service = Object.create(UserServiceService.prototype) as Row &
    UserServiceService;
  Object.assign(service, {
    users,
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    activityLog: {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    },
    bcryptEncryption: { encrypt: jest.fn().mockResolvedValue('hash') },
    ensurePhoneUnique: jest.fn().mockResolvedValue(undefined),
    ensureUsernameUnique: jest.fn().mockResolvedValue(undefined),
    ensureCreatedUserCashboxOrCompensate: jest
      .fn()
      .mockResolvedValue(undefined),
    syncUserToSearch: jest.fn().mockResolvedValue(undefined),
    assertRequesterCanCreateMarket: jest.fn(),
  });
  return { service, users, saved };
}

const existingMarket = (): Row => ({
  id: '37',
  role: Roles.MARKET,
  name: 'TEST Claude Market',
  phone_number: '+998900000037',
  status: Status.ACTIVE,
  isDeleted: false,
  extra_cost_enabled: true,
  extra_cost_requires_approval: true,
  require_operator_phone: false,
  default_operator_phone: null,
});

const rpcError = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as { statusCode?: number };
};

const baseCreate = {
  name: 'Yangi market',
  phone_number: '+998901112233',
  username: 'yangi',
  password: 'secret123',
  tariff_home: 30000,
  tariff_center: 20000,
};

describe('w2bDrE3i / VRyloH62 — market sozlamalari (identity)', () => {
  it('⭐ w2bDrE3i TC1: YANGI market sukuti — qo`shimcha xarajat yopiq, tasdiq talab qilinadi', async () => {
    const { service, users } = makeService();
    await service.createMarket(baseCreate as never, SUPERADMIN as never);
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        extra_cost_enabled: false,
        extra_cost_requires_approval: true,
        require_operator_phone: false,
        default_operator_phone: null,
      }),
    );
  });

  it('⭐ w2bDrE3i TC2: admin yaratishda ochib qo`yishi mumkin', async () => {
    const { service, users } = makeService();
    await service.createMarket(
      {
        ...baseCreate,
        extra_cost_enabled: true,
        extra_cost_requires_approval: false,
      } as never,
      ADMIN as never,
    );
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        extra_cost_enabled: true,
        extra_cost_requires_approval: false,
      }),
    );
  });

  it('⭐ w2bDrE3i TC2: admin PATCH bilan yopadi/ochadi, tasdiq talabini o`zgartiradi', async () => {
    const { service, saved } = makeService(existingMarket());
    await service.updateMarket(
      '37',
      { extra_cost_enabled: false, extra_cost_requires_approval: false },
      ADMIN as never,
    );
    expect(saved.at(-1)).toMatchObject({
      extra_cost_enabled: false,
      extra_cost_requires_approval: false,
    });
  });

  it('w2bDrE3i: market o`zi qo`shimcha xarajat sozlamasini o`zgartira olmaydi → 403, saqlanmaydi', async () => {
    const { service, users } = makeService(existingMarket());
    expect(
      await rpcError(
        service.updateMarket(
          '37',
          { extra_cost_enabled: true },
          MARKET as never,
        ),
      ),
    ).toMatchObject({ statusCode: 403 });
    expect(users.save).not.toHaveBeenCalled();
  });

  it('w2bDrE3i: boolean bo`lmagan qiymat → 400', async () => {
    const { service, users } = makeService(existingMarket());
    expect(
      await rpcError(
        service.updateMarket(
          '37',
          { extra_cost_enabled: 'ha' as never },
          SUPERADMIN as never,
        ),
      ),
    ).toMatchObject({ statusCode: 400 });
    expect(users.save).not.toHaveBeenCalled();
  });

  it('⭐ VRyloH62: market o`z operator raqami sozlamasini o`zgartiradi; raqam kanonik shaklga keladi', async () => {
    const { service, saved } = makeService(existingMarket());
    await service.updateMarket(
      '37',
      { require_operator_phone: true, default_operator_phone: '90 123 45 67' },
      MARKET as never,
    );
    expect(saved.at(-1)).toMatchObject({
      require_operator_phone: true,
      default_operator_phone: '+998901234567',
    });
  });

  it("VRyloH62: bo'sh satr — raqam o'chiriladi (null); noto'g'ri raqam → 400", async () => {
    const { service, saved } = makeService({
      ...existingMarket(),
      default_operator_phone: '+998901234567',
    });
    await service.updateMarket(
      '37',
      { default_operator_phone: '' },
      MARKET as never,
    );
    expect(saved.at(-1)).toMatchObject({ default_operator_phone: null });

    const other = makeService(existingMarket());
    expect(
      await rpcError(
        other.service.updateMarket(
          '37',
          { default_operator_phone: 'abc' },
          MARKET as never,
        ),
      ),
    ).toMatchObject({ statusCode: 400 });
    expect(other.users.save).not.toHaveBeenCalled();
  });
});
