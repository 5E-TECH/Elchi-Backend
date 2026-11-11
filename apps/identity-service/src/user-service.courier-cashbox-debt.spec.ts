import { RpcException } from '@nestjs/microservices';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * (2026-11-11) KURYER kassasi qarzga ishlaydi (`cashbox_debt_enabled`) —
 * marketniki bilan bir xil ustun (migratsiya 1716000000207). Yoqilsa finance
 * kuryerdan qoldig'idan ortiq (oldindan) pul qabul qiladi.
 *   - `PATCH /users/:id` (`identity.user.update`) orqali, faqat
 *     SUPERADMIN/ADMIN (menejer — 403);
 *   - faqat KURYER yozuvida (market — o'z yo'li, boshqa rol — 400);
 *   - boolean bo'lmasa — 400; audit izida eski va yangi qiymat.
 */
type Row = Record<string, unknown>;

const SUPERADMIN = { id: '1', roles: [Roles.SUPERADMIN] };
const ADMIN = { id: '2', roles: [Roles.ADMIN] };
const MANAGER = { id: '208', roles: [Roles.MANAGER] };

const courierRow = (): Row => ({
  id: '209',
  role: Roles.COURIER,
  name: 'Ali Valiyev',
  phone_number: '+998900000209',
  status: Status.ACTIVE,
  isDeleted: false,
  cashbox_debt_enabled: false,
  created_by: '208',
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

describe('Kuryer kassasi qarzga ishlaydi (identity)', () => {
  it.each([[SUPERADMIN], [ADMIN]])(
    '⭐ %p yoqadi va o`chiradi; audit izida eski va yangi qiymat',
    async (requester) => {
      const { service, saved, activityLog } = makeService(courierRow());
      await service.updateUser(
        '209',
        { cashbox_debt_enabled: true },
        requester,
      );
      expect(saved.at(-1)).toMatchObject({ cashbox_debt_enabled: true });
      expect(activityLog.logChange).toHaveBeenCalledWith(
        expect.objectContaining({
          old_value: expect.objectContaining({ cashbox_debt_enabled: false }),
          new_value: expect.objectContaining({ cashbox_debt_enabled: true }),
        }),
      );

      const off = makeService({ ...courierRow(), cashbox_debt_enabled: true });
      await off.service.updateUser(
        '209',
        { cashbox_debt_enabled: false },
        requester,
      );
      expect(off.saved.at(-1)).toMatchObject({ cashbox_debt_enabled: false });
    },
  );

  it('menejer (o`zi yaratgan kuryer bo`lsa ham) → 403, saqlanmaydi', async () => {
    const { service, saved } = makeService(courierRow());
    expect(
      await rpcError(
        service.updateUser(
          '209',
          { cashbox_debt_enabled: true },
          MANAGER as never,
        ),
      ),
    ).toMatchObject({ statusCode: 403 });
    expect(saved).toHaveLength(0);
  });

  it.each([[Roles.MARKET], [Roles.MANAGER], [Roles.OPERATOR]])(
    'kuryer bo`lmagan yozuv (%s) → 400',
    async (role) => {
      const { service, saved } = makeService({ ...courierRow(), role });
      expect(
        await rpcError(
          service.updateUser(
            '209',
            { cashbox_debt_enabled: true },
            ADMIN as never,
          ),
        ),
      ).toMatchObject({ statusCode: 400 });
      expect(saved).toHaveLength(0);
    },
  );

  it('boolean bo`lmasa → 400', async () => {
    const { service, saved } = makeService(courierRow());
    expect(
      await rpcError(
        service.updateUser(
          '209',
          { cashbox_debt_enabled: 'ha' as unknown as boolean },
          ADMIN as never,
        ),
      ),
    ).toMatchObject({ statusCode: 400 });
    expect(saved).toHaveLength(0);
  });

  it('maydon berilmasa — o`zgarmaydi', async () => {
    const { service, saved } = makeService({
      ...courierRow(),
      cashbox_debt_enabled: true,
    });
    await service.updateUser('209', { name: 'Ali Valiyev' }, ADMIN);
    expect(saved.at(-1)).toMatchObject({ cashbox_debt_enabled: true });
  });
});
