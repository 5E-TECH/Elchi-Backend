import { JwtService } from '@nestjs/jwt';
import { RpcException } from '@nestjs/microservices';
import { Roles, Status, signTelegramInitData } from '@app/common';
import { AuthService } from './auth.service';

/**
 * BOT-2 #2 — Telegram tokeni: Mini App faqat kuryerga (403
 * TELEGRAM_COURIER_ONLY), `scope: 'tg_scan'` faqat Mini App'da, `tg_id`
 * har doim, `pwd_change` — `must_change_password` bo'lsa; gateway uchun
 * `telegramTokenState` (faol, rol, Telegram ulanishi).
 */
const BOT_TOKEN = '1234567890:ENV_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = 1_760_000_000;
const initData = () =>
  signTelegramInitData(
    {
      query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
      user: JSON.stringify({ id: 5550007, first_name: 'Ali' }),
      auth_date: String(NOW),
    },
    BOT_TOKEN,
  );

const user = (over: Record<string, unknown> = {}) => ({
  id: '25',
  username: 'u25',
  name: 'Xodim',
  role: Roles.COURIER,
  status: Status.ACTIVE,
  telegram_id: '5550007',
  must_change_password: false,
  ...over,
});

function make(rows: Array<Record<string, unknown>>) {
  const jwtService = new JwtService({ secret: 'k' });
  const svc = Object.create(AuthService.prototype) as AuthService;
  Object.assign(svc, {
    users: {
      find: jest.fn().mockResolvedValue(rows),
      findOne: jest.fn().mockResolvedValue(rows[0] ?? null),
    },
    jwtService,
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    configService: {
      get: (key: string) => ({ TELEGRAM_BOT_TOKEN: BOT_TOKEN })[key],
    },
    resolveBranchId: () => Promise.resolve(null),
  });
  const decode = (token: string) =>
    jwtService.verify<Record<string, unknown>>(token);
  return { svc, decode };
}

describe('BOT-2 #2 — Telegram tokeni (identity)', () => {
  beforeAll(() => {
    jest.useFakeTimers({
      now: NOW * 1000 + 5_000,
      doNotFake: ['nextTick', 'setImmediate'],
    });
  });
  afterAll(() => jest.useRealTimers());

  it.each([Roles.SUPERADMIN, Roles.ADMIN, Roles.MARKET, Roles.MANAGER])(
    '⭐ Mini App: %s → 403 TELEGRAM_COURIER_ONLY',
    async (role) => {
      const { svc } = make([user({ role })]);
      const error = await svc
        .telegramLogin({ init_data: initData() })
        .catch((e: RpcException) => e.getError());
      expect(error).toEqual(
        expect.objectContaining({
          statusCode: 403,
          code: 'TELEGRAM_COURIER_ONLY',
        }),
      );
    },
  );

  it('⭐ Mini App kuryer: scope tg_scan + tg_id; pwd_change yo`q', async () => {
    const { svc, decode } = make([user()]);
    const res = await svc.telegramLogin({ init_data: initData() });
    const claims = decode(res.accessToken);
    expect(claims).toEqual(
      expect.objectContaining({
        auth: 'telegram',
        scope: 'tg_scan',
        tg_id: '5550007',
      }),
    );
    expect(claims).not.toHaveProperty('pwd_change');
  });

  it('bot aktori: boshqa rol ham oladi, scope YO`Q (mavjud endpointlar)', async () => {
    const { svc, decode } = make([user({ role: Roles.MARKET })]);
    const res = await svc.telegramAccessToken('5550007', 'bot');
    const claims = decode(res.accessToken);
    expect(claims.scope).toBeUndefined();
    expect(claims.tg_id).toBe('5550007');
  });

  it('⭐ must_change_password → pwd_change (Mini App va bot)', async () => {
    const { svc, decode } = make([user({ must_change_password: true })]);
    const mini = await svc.telegramLogin({ init_data: initData() });
    const bot = await svc.telegramAccessToken('5550007', 'bot');
    expect(decode(mini.accessToken).pwd_change).toBe(true);
    expect(decode(bot.accessToken).pwd_change).toBe(true);
  });

  describe('telegramTokenState', () => {
    const state = (row: Record<string, unknown> | null, input = {}) => {
      const { svc } = make(row ? [row] : []);
      return svc.telegramTokenState({
        user_id: '25',
        telegram_id: '5550007',
        role: 'courier',
        ...input,
      });
    };

    it('faol, rol mos, shu Telegram → active', async () => {
      await expect(state(user())).resolves.toEqual({ active: true });
      // `tg_id` siz eski token — istalgan ulanish yetadi.
      await expect(state(user(), { telegram_id: null })).resolves.toEqual({
        active: true,
      });
    });

    it.each([
      ['yo`q / o`chirilgan', null, {}],
      ['nofaol', user({ status: Status.INACTIVE }), {}],
      ['roli o`zgargan', user({ role: Roles.MARKET }), {}],
      ['/uzish (telegram_id null)', user({ telegram_id: null }), {}],
      ['boshqa Telegram`ga ulangan', user({ telegram_id: '999' }), {}],
      ['buzuq user_id', user(), { user_id: 'abc' }],
    ])('%s → active: false', async (_label, row, input) => {
      await expect(state(row, input)).resolves.toEqual({ active: false });
    });
  });
});
