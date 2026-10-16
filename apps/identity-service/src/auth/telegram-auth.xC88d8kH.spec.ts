import { JwtService } from '@nestjs/jwt';
import { RpcException } from '@nestjs/microservices';
import {
  Roles,
  Status,
  signTelegramInitData,
  verifyTelegramInitData,
} from '@app/common';
import { AuthService } from './auth.service';

/**
 * xC88d8kH — `POST /auth/telegram`: initData HMAC (bot tokeni bilan) va
 * `auth_date` ≤ 5 daqiqa; `users.telegram_id` bo'yicha xodim → 30 daqiqalik
 * access JWT, refresh YO'Q. Bot tokeni hech qanday javob/xatoda chiqmaydi.
 */
const BOT_TOKEN = '1234567890:ENV_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = 1_760_000_000;

const initData = (overrides: Record<string, string> = {}) =>
  signTelegramInitData(
    {
      query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
      user: JSON.stringify({ id: 5550007, first_name: 'Ali', username: 'ali' }),
      auth_date: String(NOW),
      ...overrides,
    },
    BOT_TOKEN,
  );

describe('xC88d8kH — verifyTelegramInitData (libs/common)', () => {
  it('⭐ to‘g‘ri initData → ok, user.id', () => {
    const result = verifyTelegramInitData(initData(), BOT_TOKEN, 300, NOW + 10);
    expect(result).toEqual({
      ok: true,
      user: { id: '5550007', username: 'ali', first_name: 'Ali' },
      auth_date: NOW,
    });
  });

  it('⭐ bitta bayti o‘zgartirilgan hash → bad_hash', () => {
    const data = initData();
    const params = new URLSearchParams(data);
    const hash = params.get('hash')!;
    params.set('hash', (hash[0] === 'a' ? 'b' : 'a') + hash.slice(1));
    expect(
      verifyTelegramInitData(params.toString(), BOT_TOKEN, 300, NOW),
    ).toEqual({ ok: false, reason: 'bad_hash' });
    // Maydon o'zgartirilsa ham (masalan boshqa user id).
    const tampered = new URLSearchParams(data);
    tampered.set('user', JSON.stringify({ id: 1 }));
    expect(
      verifyTelegramInitData(tampered.toString(), BOT_TOKEN, 300, NOW),
    ).toEqual({ ok: false, reason: 'bad_hash' });
  });

  it('⭐ auth_date 6 daqiqa oldingi → expired; boshqa bot tokeni → bad_hash', () => {
    expect(
      verifyTelegramInitData(initData(), BOT_TOKEN, 300, NOW + 6 * 60),
    ).toEqual({ ok: false, reason: 'expired' });
    expect(
      verifyTelegramInitData(initData(), `${BOT_TOKEN}x`, 300, NOW),
    ).toEqual({ ok: false, reason: 'bad_hash' });
    expect(verifyTelegramInitData('', BOT_TOKEN)).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(verifyTelegramInitData(initData(), '')).toEqual({
      ok: false,
      reason: 'no_bot_token',
    });
  });
});

describe('xC88d8kH — AuthService.telegramLogin / telegramAccessToken', () => {
  const linkedUser = {
    id: '25',
    username: 'courier25',
    name: 'TEST Kuryer',
    role: Roles.COURIER,
    status: Status.ACTIVE,
    telegram_id: '5550007',
    password: 'hash',
    refresh_token: 'rt',
  };

  const make = (rows: Array<Record<string, unknown>>) => {
    const jwtService = new JwtService({
      secret: 'test-access-key',
      signOptions: { expiresIn: '15m' },
    });
    const users = { find: jest.fn().mockResolvedValue(rows) };
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const svc = Object.create(AuthService.prototype) as AuthService;
    Object.assign(svc, {
      users,
      jwtService,
      activityLog,
      configService: {
        get: (key: string) =>
          ({ TELEGRAM_BOT_TOKEN: BOT_TOKEN })[key] as string | undefined,
      },
      resolveBranchId: () => Promise.resolve(null),
    });
    return { svc, users, jwtService, activityLog };
  };

  const errorOf = (promise: Promise<unknown>) =>
    promise.then(
      () => ({ statusCode: 200, message: 'ok' }),
      (error: unknown) =>
        (error as RpcException).getError() as {
          statusCode: number;
          message: string;
        },
    );

  beforeAll(() => {
    jest.useFakeTimers({ now: NOW * 1000 + 5_000, doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterAll(() => jest.useRealTimers());

  it('⭐ to‘g‘ri initData → 200, ishlaydigan JWT (sub, roles), 30 daqiqa, refresh YO‘Q', async () => {
    const { svc, users, jwtService } = make([linkedUser]);
    const res = await svc.telegramLogin({ init_data: initData() });
    expect(users.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { telegram_id: '5550007', isDeleted: false, status: Status.ACTIVE },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res).not.toHaveProperty('refreshToken');
    const payload = jwtService.verify<{
      sub: string;
      roles: string[];
      auth: string;
      exp: number;
      iat: number;
    }>(res.accessToken);
    expect(payload).toEqual(
      expect.objectContaining({ sub: '25', roles: ['courier'], auth: 'telegram' }),
    );
    expect(payload.exp - payload.iat).toBe(30 * 60);
    expect(res.user).not.toHaveProperty('password');
    expect(JSON.stringify(res)).not.toContain(BOT_TOKEN);
  });

  it('⭐ bazada telegram_id yo‘q → 401 va aniq "avval kabinetdan ulang"', async () => {
    const { svc } = make([]);
    const err = await errorOf(svc.telegramLogin({ init_data: initData() }));
    expect(err).toEqual({
      statusCode: 401,
      message: expect.stringContaining('avval kabinetdan'),
    });
  });

  it('⭐ buzilgan hash → 401; eskirgan → 401; xatoda bot tokeni YO‘Q', async () => {
    const { svc, users } = make([linkedUser]);
    const bad = new URLSearchParams(initData());
    bad.set('hash', '0'.repeat(64));
    const err = await errorOf(svc.telegramLogin({ init_data: bad.toString() }));
    expect(err.statusCode).toBe(401);
    expect(JSON.stringify(err)).not.toContain(BOT_TOKEN);
    const old = await errorOf(
      svc.telegramLogin({ init_data: initData({ auth_date: String(NOW - 6 * 60) }) }),
    );
    expect(old).toEqual({ statusCode: 401, message: expect.stringContaining('eskirgan') });
    expect(users.find).not.toHaveBeenCalled();
  });

  it.each([
    ['mijoz', { ...linkedUser, role: Roles.CUSTOMER }],
    ['investor', { ...linkedUser, role: Roles.INVESTOR }],
  ])('%s — token berilmaydi (401)', async (_label, row) => {
    const { svc } = make([row]);
    expect((await errorOf(svc.telegramAccessToken('5550007', 'bot'))).statusCode).toBe(401);
  });

  it('bir nechta akkauntga bog‘langan id — 401 (fail-closed)', async () => {
    const { svc } = make([linkedUser, { ...linkedUser, id: '26' }]);
    expect((await errorOf(svc.telegramAccessToken('5550007', 'bot'))).statusCode).toBe(401);
  });

  it('bot aktori tokeni (ichki RMQ) — login jurnali yozilmaydi; mini app — yoziladi', async () => {
    const { svc, activityLog } = make([linkedUser]);
    await svc.telegramAccessToken('5550007', 'bot');
    expect(activityLog.log).not.toHaveBeenCalled();
    await svc.telegramLogin({ init_data: initData() });
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { method: 'telegram' } }),
    );
  });
});
