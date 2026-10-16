import { RpcException } from '@nestjs/microservices';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * ysBqD9Nx (EGA QARORI 2026-09-20) — `tg_group_show_customer_pii`: market
 * Telegram guruhi kartasida mijoz ismi/telefoni. Sukut TRUE (ega tanlovi);
 * market o'chirishni so'rasa — kodsiz (`identity.market.update`), audit
 * izida; boolean bo'lmagan qiymat — 400.
 */
type Row = Record<string, unknown>;

function makeService(existing: Row) {
  const saved: Row[] = [];
  const users = {
    findOne: jest.fn(() => Promise.resolve({ ...existing })),
    save: jest.fn((row: Row) => {
      saved.push(row);
      return Promise.resolve(row);
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
  });
  return { service, saved, activityLog };
}

const market = (): Row => ({
  id: '37',
  role: Roles.MARKET,
  name: 'TEST Claude Market',
  phone_number: '+998900000037',
  status: Status.ACTIVE,
  isDeleted: false,
  tg_group_show_customer_pii: true,
});

describe('ysBqD9Nx — tg_group_show_customer_pii', () => {
  it('⭐ market o‘chiradi — saqlanadi, audit (oldin → keyin), javobda bor', async () => {
    const { service, saved, activityLog } = makeService(market());
    const res = (await service.updateMarket(
      '37',
      { tg_group_show_customer_pii: false } as never,
      { id: '37', roles: [Roles.MARKET] },
    )) as { data: Row };
    expect(saved[0].tg_group_show_customer_pii).toBe(false);
    expect(res.data.tg_group_show_customer_pii).toBe(false);
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: expect.objectContaining({
          tg_group_show_customer_pii: true,
        }),
        new_value: expect.objectContaining({
          tg_group_show_customer_pii: false,
        }),
      }),
    );
  });

  it('boolean bo‘lmagan qiymat — 400 (RMQ’da ValidationPipe yo‘q)', async () => {
    const { service, saved } = makeService(market());
    const error = await service
      .updateMarket('37', { tg_group_show_customer_pii: 'no' } as never)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toEqual(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(saved).toHaveLength(0);
  });

  it('berilmasa — o‘zgarmaydi (sukut TRUE saqlanadi)', async () => {
    const { service, saved } = makeService(market());
    await service.updateMarket('37', { name: 'Yangi nom' } as never);
    expect(saved[0].tg_group_show_customer_pii).toBe(true);
  });
});
