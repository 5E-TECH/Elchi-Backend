import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { LOGIN_LOCKED, Roles, Status, requestContext } from '@app/common';
import { BcryptEncryption } from '../../../../libs/common/helpers/bcrypt';
import { AuthService } from './auth.service';
import type { LoginThrottleService } from './login-throttle.service';

/**
 * (NDmZMzCP, 2026-10-26) Parol login'i xavfsizligi:
 *  - noma'lum telefon / nofaol foydalanuvchida ham bcrypt (soxta xesh);
 *  - telefon (+IP) qulfi: 429 LOGIN_LOCKED, parol tekshirilmaydi; tanish
 *    qurilma telefonning umumiy qulfini chetlab o'tadi;
 *  - zaif mavjud parol — login MUVAFFAQIYATLI + must_change_password;
 *  - eski bcrypt narxi — qayta xesh + sessiyalar parol izi ko'chiriladi.
 */

const ACCESS_KEY = 'a'.repeat(48);
const REFRESH_KEY = 'r'.repeat(48);
const CTX = { ip: '203.0.113.7', device_id: 'dev-0123456789abcdef' };
const SID = '0d6f1b1e-7c1a-4c55-9a51-111111111111';

interface UserRow {
  id: string;
  name: string;
  username: string;
  phone_number: string;
  password: string;
  role: string;
  status: string;
  isDeleted: boolean;
  refresh_token: string | null;
  session_epoch: number;
  must_change_password: boolean;
}

function setup(row: UserRow | null) {
  const user = row ? { ...row } : null;
  const managerUpdate = jest.fn(
    (_entity: unknown, where: { password?: string }) =>
      Promise.resolve({
        affected: user && where.password === user.password ? 1 : 0,
      }),
  );
  const users = {
    findOne: jest.fn(() => Promise.resolve(user ? { ...user } : null)),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    manager: {
      transaction: jest.fn(
        (cb: (manager: { update: typeof managerUpdate }) => unknown) =>
          cb({ update: managerUpdate }),
      ),
    },
  };
  const sessions = {
    open: jest.fn(() => Promise.resolve({ id: SID })),
    isKnownDevice: jest.fn(() => Promise.resolve(false)),
    repointPasswordFingerprint: jest.fn(() => Promise.resolve(1)),
  };
  const throttle = {
    activeLock: jest.fn(() => Promise.resolve(null)),
    recordFailure: jest.fn(() => Promise.resolve({ locked: [] })),
    reset: jest.fn(() => Promise.resolve()),
  };
  const activityLog = { log: jest.fn(() => Promise.resolve()) };
  const bcryptService = new BcryptEncryption();
  const compare = jest.spyOn(bcryptService, 'compare');
  const compareDummy = jest.spyOn(bcryptService, 'compareDummy');
  const env: Record<string, string> = {
    ACCESS_TOKEN_KEY: ACCESS_KEY,
    REFRESH_TOKEN_KEY: REFRESH_KEY,
    OTP_HASH_SECRET: 'h'.repeat(32),
  };
  const jwt = new JwtService({
    secret: ACCESS_KEY,
    signOptions: { expiresIn: '1h' },
  });
  const service = new AuthService(
    users as never,
    jwt,
    { get: (key: string) => env[key] } as never,
    bcryptService,
    { send: jest.fn(() => of({ data: { branch_id: null } })) } as never,
    activityLog as never,
    sessions as never,
    undefined,
    throttle as unknown as LoginThrottleService,
  );
  const logger = (service as unknown as { logger: { warn: () => void } })
    .logger;
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const login = (phone: string, password: string) =>
    requestContext.run({ traceId: 't', ...CTX }, () =>
      service.login({ phone_number: phone, password }),
    );
  return {
    service,
    users,
    sessions,
    throttle,
    activityLog,
    compare,
    compareDummy,
    managerUpdate,
    jwt,
    warn,
    login,
  };
}

const baseUser = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: '25',
  name: 'TEST menejer',
  username: 'test-manager',
  phone_number: '+998935557711',
  password: bcrypt.hashSync('Kuchli-Parol-2026', 12),
  role: Roles.MANAGER,
  status: Status.ACTIVE,
  isDeleted: false,
  refresh_token: null,
  session_epoch: 0,
  must_change_password: false,
  ...overrides,
});

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as Record<string, unknown>;
  }
  throw new Error('xato kutilgan edi');
}

jest.setTimeout(30_000);

describe('NDmZMzCP — login: timing, qulf, zaif parol, rehash', () => {
  it('noma’lum telefon — soxta xesh bilan bcrypt, 401, xato hisoblanadi', async () => {
    const t = setup(null);
    const error = await rpcError(t.login('+998935550000', 'nimadir-123'));
    expect(error).toMatchObject({ statusCode: 401 });
    expect(t.compareDummy).toHaveBeenCalledTimes(1);
    expect(t.compare).not.toHaveBeenCalled();
    expect(t.throttle.recordFailure).toHaveBeenCalledTimes(1);
    const keys = (
      t.throttle.recordFailure.mock.calls[0] as unknown as [
        { phone: string; phone_ip: string },
      ]
    )[0];
    expect(keys.phone).toMatch(/^p:[0-9a-f]{32}$/);
    expect(keys.phone_ip).toBe(`pi:${keys.phone.slice(2)}:203.0.113.7`);
    // Raqam kalitga yozilmaydi.
    expect(JSON.stringify(keys)).not.toContain('935550000');
  });

  it('nofaol foydalanuvchi — ham soxta bcrypt, haqiqiy xesh solishtirilmaydi', async () => {
    const t = setup(baseUser({ status: Status.INACTIVE }));
    const error = await rpcError(t.login('+998935557711', 'Kuchli-Parol-2026'));
    expect(error).toMatchObject({ statusCode: 401 });
    expect(t.compareDummy).toHaveBeenCalledTimes(1);
    expect(t.compare).not.toHaveBeenCalled();
  });

  it('noto‘g‘ri parol — 401, xato hisoblanadi, reset yo‘q', async () => {
    const t = setup(baseUser());
    await rpcError(t.login('+998935557711', 'Notogri-Parol-1'));
    expect(t.throttle.recordFailure).toHaveBeenCalledTimes(1);
    expect(t.throttle.reset).not.toHaveBeenCalled();
  });

  it('qulf amalda — 429 LOGIN_LOCKED + retry_after_seconds, parol TEKSHIRILMAYDI va hisob oshmaydi', async () => {
    const t = setup(baseUser());
    const now = Date.now();
    t.throttle.activeLock.mockResolvedValue({
      scope: 'phone_ip',
      locked_until: new Date(now + 120_000),
    } as never);
    const error = await rpcError(t.login('+998935557711', 'Kuchli-Parol-2026'));
    expect(error).toMatchObject({ statusCode: 429, code: LOGIN_LOCKED });
    expect(Number(error.retry_after_seconds)).toBeGreaterThan(100);
    expect(Number(error.retry_after_seconds)).toBeLessThanOrEqual(120);
    expect(String(error.message)).toContain('2 daqiqadan keyin');
    expect(t.compare).not.toHaveBeenCalled();
    expect(t.compareDummy).not.toHaveBeenCalled();
    expect(t.throttle.recordFailure).not.toHaveBeenCalled();
  });

  it('telefonning UMUMIY qulfi — tanish qurilma o‘tadi (superadmin chiqarib qo‘yilmaydi)', async () => {
    const t = setup(baseUser({ role: Roles.SUPERADMIN, id: '1' }));
    t.throttle.activeLock.mockImplementation(((
      _keys: unknown,
      _now: Date,
      options?: { ignorePhoneScope?: boolean },
    ) =>
      Promise.resolve(
        options?.ignorePhoneScope
          ? null
          : { scope: 'phone', locked_until: new Date(Date.now() + 600_000) },
      )) as never);
    t.sessions.isKnownDevice.mockResolvedValue(true);
    const res = await t.login('+998935557711', 'Kuchli-Parol-2026');
    expect(res.statusCode).toBe(200);
    expect(t.sessions.isKnownDevice).toHaveBeenCalledWith('1', {
      deviceId: CTX.device_id,
      ip: CTX.ip,
    });
    expect(t.throttle.reset).toHaveBeenCalledTimes(1);
  });

  it('telefonning umumiy qulfi — notanish qurilma 429', async () => {
    const t = setup(baseUser());
    t.throttle.activeLock.mockResolvedValue({
      scope: 'phone',
      locked_until: new Date(Date.now() + 600_000),
    } as never);
    const error = await rpcError(t.login('+998935557711', 'Kuchli-Parol-2026'));
    expect(error).toMatchObject({ statusCode: 429, code: LOGIN_LOCKED });
    expect(t.compare).not.toHaveBeenCalled();
  });

  it('qulf yangi boshlansa — ogohlantirish (warn + jurnal login_locked_*), telefon faqat maskada', async () => {
    const t = setup(baseUser());
    t.throttle.recordFailure.mockResolvedValue({
      locked: [
        {
          scope: 'phone_ip',
          fail_count: 5,
          locked_until: new Date(Date.now() + 60_000),
        },
      ],
    } as never);
    await rpcError(t.login('+998935557711', 'Notogri-Parol-1'));
    expect(t.warn).toHaveBeenCalledWith(
      expect.stringContaining('Login qulfi: ***7711 — 5 ta xato (phone_ip)'),
    );
    const reasons = t.activityLog.log.mock.calls.map(
      (call) =>
        (call as unknown as [{ metadata?: { reason?: string } }])[0].metadata
          ?.reason ?? '',
    );
    expect(reasons).toEqual(['bad_password', 'login_locked_phone_ip']);
    expect(JSON.stringify(t.activityLog.log.mock.calls)).not.toContain(
      '935557711',
    );
  });

  it('⭐ zaif mavjud parol (4 belgi) — login MUVAFFAQIYATLI, must_change_password + pwd_change', async () => {
    const t = setup(baseUser({ password: bcrypt.hashSync('0990', 12) }));
    const res = await t.login('+998935557711', '0990');
    expect(res.statusCode).toBe(200);
    expect(res.must_change_password).toBe(true);
    expect(res.user.must_change_password).toBe(true);
    expect(t.users.update).toHaveBeenCalledWith(
      { id: '25' },
      { must_change_password: true },
    );
    const claims = t.jwt.decode<Record<string, unknown>>(res.accessToken);
    expect(claims.pwd_change).toBe(true);
    expect(claims.sid).toBe(SID);
    expect(t.throttle.reset).toHaveBeenCalledTimes(1);
  });

  it('kuchli parol — bayroq yo‘q, token avvalgidek (pwd_change yo‘q), rehash yo‘q', async () => {
    const t = setup(baseUser());
    const res = await t.login('+998935557711', 'Kuchli-Parol-2026');
    expect(res.must_change_password).toBe(false);
    expect(
      t.jwt.decode<Record<string, unknown>>(res.accessToken),
    ).not.toHaveProperty('pwd_change');
    expect(t.users.manager.transaction).not.toHaveBeenCalled();
    expect(t.users.update).not.toHaveBeenCalledWith(
      { id: '25' },
      { must_change_password: true },
    );
  });

  it('bayroq allaqachon true — login uni tushirmaydi (faqat o‘zi parol almashtirsa)', async () => {
    const t = setup(baseUser({ must_change_password: true }));
    const res = await t.login('+998935557711', 'Kuchli-Parol-2026');
    expect(res.must_change_password).toBe(true);
    expect(t.users.update).not.toHaveBeenCalledWith(
      { id: '25' },
      expect.objectContaining({ must_change_password: false }),
    );
  });

  it('eski bcrypt narxi — 12 bilan qayta xesh, sessiyalar parol izi AYNI tranzaksiyada ko‘chadi', async () => {
    const oldHash = bcrypt.hashSync('Kuchli-Parol-2026', 4);
    const t = setup(baseUser({ password: oldHash }));
    const res = await t.login('+998935557711', 'Kuchli-Parol-2026');
    expect(res.statusCode).toBe(200);
    expect(t.users.manager.transaction).toHaveBeenCalledTimes(1);
    const [, where, patch] = t.managerUpdate.mock.calls[0] as unknown as [
      unknown,
      { id: string; password: string },
      { password: string },
    ];
    expect(where).toEqual({ id: '25', password: oldHash });
    expect(bcrypt.getRounds(patch.password)).toBe(12);
    expect(bcrypt.compareSync('Kuchli-Parol-2026', patch.password)).toBe(true);
    expect(t.sessions.repointPasswordFingerprint).toHaveBeenCalledWith(
      expect.anything(),
      '25',
      oldHash,
      patch.password,
    );
    // Yangi sessiya ham yangi xeshning izi bilan ochiladi.
    const opened = (
      t.sessions.open.mock.calls[0] as unknown as [{ user: UserRow }]
    )[0];
    expect(opened.user.password).toBe(patch.password);
  });

  it('qayta xeshlash xatosi login’ni to‘xtatmaydi', async () => {
    const t = setup(
      baseUser({ password: bcrypt.hashSync('Kuchli-Parol-2026', 4) }),
    );
    (t.users.manager.transaction as jest.Mock).mockRejectedValue(
      new Error('db down'),
    );
    const res = await t.login('+998935557711', 'Kuchli-Parol-2026');
    expect(res.statusCode).toBe(200);
    expect(t.warn).toHaveBeenCalledWith(
      expect.stringContaining('Parol qayta xeshlanmadi'),
    );
  });
});
