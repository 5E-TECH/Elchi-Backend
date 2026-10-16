import { In } from 'typeorm';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * TgYRqaTk #1 — bildirishnoma qabul qiluvchisi → shaxsiy chat:
 * `identity.telegram.resolve_many { user_ids }` → { [user_id]: chat | null }.
 * FAIL-CLOSED: faol emas / ulanmagan / bitta chat bir nechta akkauntda → null.
 */
describe('identity.telegram.resolve_many (user_ids → chat_id)', () => {
  const make = (
    byId: Array<Record<string, unknown>>,
    byChat: Array<Record<string, unknown>> = byId,
  ) => {
    const users = {
      find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve('telegram_id' in where ? byChat : byId),
      ),
    };
    const svc = Object.create(
      UserServiceService.prototype,
    ) as UserServiceService;
    Object.assign(svc, { users, logger: { warn: jest.fn() } });
    return { svc, users };
  };
  const user = (overrides: Record<string, unknown> = {}) => ({
    id: '25',
    role: Roles.MARKET,
    status: Status.ACTIVE,
    telegram_id: '5550025',
    ...overrides,
  });

  it('⭐ ulangan faol foydalanuvchi → chat id; ulanmagan / nofaol → null', async () => {
    const { svc, users } = make([
      user(),
      user({ id: '26', telegram_id: null }),
      user({ id: '27', status: Status.INACTIVE, telegram_id: '5550027' }),
    ]);
    const res = await svc.telegramResolveMany({
      user_ids: ['25', 26, '27', '28', 'x; DROP'],
    });
    expect(res.data).toEqual({
      '25': '5550025',
      '26': null,
      '27': null,
      '28': null,
    });
    expect(users.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: In(['25', '26', '27', '28']), isDeleted: false },
      }),
    );
  });

  it('bitta chat ikki akkauntda (meros noaniqlik) — hech biriga yuborilmaydi', async () => {
    const { svc } = make(
      [user()],
      [user(), user({ id: '99', telegram_id: '5550025' })],
    );
    expect((await svc.telegramResolveMany({ user_ids: ['25'] })).data).toEqual({
      '25': null,
    });
  });

  it('telegram_ids (bot aktori yo‘nalishi) avvalgidek ishlaydi', async () => {
    const { svc } = make([
      user({ role: Roles.COURIER, market_id: null, region_id: '3' }),
    ]);
    const res = await svc.telegramResolveMany({ telegram_ids: ['5550025'] });
    expect(res.data).toEqual({
      '5550025': expect.objectContaining({
        user_id: '25',
        role: Roles.COURIER,
      }),
    });
  });

  it('bo‘sh ro‘yxat — so‘rovsiz bo‘sh javob', async () => {
    const { svc, users } = make([]);
    expect((await svc.telegramResolveMany({ user_ids: [] })).data).toEqual({});
    expect(users.find).not.toHaveBeenCalled();
  });
});
