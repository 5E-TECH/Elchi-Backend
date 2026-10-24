import { RpcException } from '@nestjs/microservices';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * hY7uacJu — market «Ombordan buyurtma yaratish» kaliti
 * (`can_order_from_warehouse`, sukut false, migratsiya 1716000000143):
 *   - faqat SUPERADMIN/ADMIN o'zgartiradi — `identity.market.update`
 *     (PATCH /markets/:id/warehouse-order) va `identity.user.update`
 *     (PATCH /users/:id, market tahrirlash formasi);
 *   - market o'zi yoki menejer — 403; boolean bo'lmagan qiymat — 400;
 *     market bo'lmagan foydalanuvchi — 400;
 *   - audit izida eski va yangi qiymat.
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
  can_order_from_warehouse: false,
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

describe('hY7uacJu — market can_order_from_warehouse (identity)', () => {
  describe('identity.market.update', () => {
    it('⭐ admin yoqadi va o`chiradi; audit izida eski/yangi qiymat', async () => {
      const { service, saved, activityLog } = makeService(marketRow());
      await service.updateMarket(
        '37',
        { can_order_from_warehouse: true },
        ADMIN as never,
      );
      expect(saved.at(-1)).toMatchObject({ can_order_from_warehouse: true });
      expect(activityLog.logChange).toHaveBeenCalledWith(
        expect.objectContaining({
          old_value: expect.objectContaining({
            can_order_from_warehouse: false,
          }),
          new_value: expect.objectContaining({
            can_order_from_warehouse: true,
          }),
        }),
      );

      const second = makeService({
        ...marketRow(),
        can_order_from_warehouse: true,
      });
      await second.service.updateMarket(
        '37',
        { can_order_from_warehouse: false },
        SUPERADMIN as never,
      );
      expect(second.saved.at(-1)).toMatchObject({
        can_order_from_warehouse: false,
      });
    });

    it('⭐ market o`zi yoki menejer — 403, hech narsa saqlanmaydi', async () => {
      for (const requester of [MARKET, MANAGER, undefined]) {
        const { service, saved } = makeService(marketRow());
        expect(
          await rpcError(
            service.updateMarket(
              '37',
              { can_order_from_warehouse: true },
              requester as never,
            ),
          ),
        ).toMatchObject({ statusCode: 403 });
        expect(saved).toHaveLength(0);
      }
    });

    it('boolean bo`lmagan qiymat — 400', async () => {
      const { service, saved } = makeService(marketRow());
      expect(
        await rpcError(
          service.updateMarket(
            '37',
            { can_order_from_warehouse: 'true' } as never,
            ADMIN as never,
          ),
        ),
      ).toMatchObject({ statusCode: 400 });
      expect(saved).toHaveLength(0);
    });

    it('maydon yuborilmasa — tegilmaydi (boshqa sozlamalar o`zgaradi)', async () => {
      const { service, saved } = makeService({
        ...marketRow(),
        can_order_from_warehouse: true,
      });
      await service.updateMarket('37', { add_order: true }, MARKET as never);
      expect(saved.at(-1)).toMatchObject({
        add_order: true,
        can_order_from_warehouse: true,
      });
    });
  });

  describe('identity.user.update (market tahrirlash formasi)', () => {
    it('⭐ admin saqlaydi', async () => {
      const { service, saved } = makeService(marketRow());
      await service.updateUser(
        '37',
        { can_order_from_warehouse: true },
        ADMIN as never,
      );
      expect(saved.at(-1)).toMatchObject({ can_order_from_warehouse: true });
    });

    it('⭐ menejer (o`zi yaratgan market bo`lsa ham) — 403', async () => {
      const { service, saved } = makeService(marketRow());
      expect(
        await rpcError(
          service.updateUser(
            '37',
            { can_order_from_warehouse: true },
            MANAGER as never,
          ),
        ),
      ).toMatchObject({ statusCode: 403 });
      expect(saved).toHaveLength(0);
    });

    it('market bo`lmagan foydalanuvchi — 400', async () => {
      const { service } = makeService({
        ...marketRow(),
        id: '40',
        role: Roles.COURIER,
      });
      expect(
        await rpcError(
          service.updateUser(
            '40',
            { can_order_from_warehouse: true },
            ADMIN as never,
          ),
        ),
      ).toMatchObject({ statusCode: 400 });
    });
  });
});
