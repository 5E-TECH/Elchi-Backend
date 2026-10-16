import { RpcException } from '@nestjs/microservices';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * NFiXfmq6 — market AI buyurtma narxi (`ai_price_per_order`) identity'da:
 *   - faqat SUPERADMIN/ADMIN o'zgartiradi (market o'zi — 403);
 *   - faqat MARKET yozuvida (boshqa rol — 400);
 *   - `null` — global narxga qaytish, 0 — bepul, manfiy/katta — 400;
 *   - audit izida eski va yangi narx (kim qachon qanday narx qo'ygani).
 */
type Row = Record<string, unknown>;

const SUPERADMIN = { id: '1', roles: [Roles.SUPERADMIN] };
const ADMIN = { id: '2', roles: [Roles.ADMIN] };

const marketRow = (): Row => ({
  id: '37',
  role: Roles.MARKET,
  name: 'TEST Claude Market',
  phone_number: '+998900000037',
  status: Status.ACTIVE,
  isDeleted: false,
  ai_price_per_order: null,
  created_by: null,
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
      save: jest.fn((row: Row) => {
        saved.push(row);
        return Promise.resolve(row);
      }),
    },
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    activityLog,
    syncUserToSearch: jest.fn().mockResolvedValue(undefined),
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

describe('NFiXfmq6 — market AI buyurtma narxi (identity)', () => {
  it('⭐ admin market narxini saqlaydi; audit izida eski va yangi qiymat', async () => {
    const { service, saved, activityLog } = makeService(marketRow());
    await service.updateUser('37', { ai_price_per_order: 450 }, ADMIN as never);
    expect(saved.at(-1)).toMatchObject({ ai_price_per_order: 450 });
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: expect.objectContaining({ ai_price_per_order: null }),
        new_value: expect.objectContaining({ ai_price_per_order: 450 }),
      }),
    );
  });

  it('⭐ 0 — bepul; null — global narxga qaytish', async () => {
    const first = makeService(marketRow());
    await first.service.updateUser(
      '37',
      { ai_price_per_order: 0 },
      SUPERADMIN as never,
    );
    expect(first.saved.at(-1)).toMatchObject({ ai_price_per_order: 0 });

    const second = makeService({ ...marketRow(), ai_price_per_order: 500 });
    await second.service.updateUser(
      '37',
      { ai_price_per_order: null },
      SUPERADMIN as never,
    );
    expect(second.saved.at(-1)).toMatchObject({ ai_price_per_order: null });
  });

  it('market o`z narxini o`zgartira olmaydi → 403', async () => {
    const { service, saved } = makeService(marketRow());
    expect(
      await rpcError(
        service.updateUser('37', { ai_price_per_order: 0 }, {
          id: '37',
          roles: [Roles.MARKET],
        } as never),
      ),
    ).toMatchObject({ statusCode: 403 });
    expect(saved).toHaveLength(0);
  });

  it('market bo`lmagan foydalanuvchi → 400', async () => {
    const { service } = makeService({ ...marketRow(), role: Roles.COURIER });
    expect(
      await rpcError(
        service.updateUser('37', { ai_price_per_order: 300 }, ADMIN as never),
      ),
    ).toMatchObject({ statusCode: 400 });
  });

  it.each([[-1], [1_000_001], ['300' as unknown as number]])(
    'noto`g`ri narx %p → 400',
    async (value) => {
      const { service, saved } = makeService(marketRow());
      expect(
        await rpcError(
          service.updateUser(
            '37',
            { ai_price_per_order: value },
            ADMIN as never,
          ),
        ),
      ).toMatchObject({ statusCode: 400 });
      expect(saved).toHaveLength(0);
    },
  );
});
