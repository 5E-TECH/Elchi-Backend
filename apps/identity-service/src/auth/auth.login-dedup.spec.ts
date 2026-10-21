import { of } from 'rxjs';
import { ActivityLogService } from '@app/common';
import { AuthService } from './auth.service';

/**
 * i6Nyedea (4-band) — login hajmi: muvaffaqiyatli login jurnali
 * `ActivityLogMaintenanceService.logCoalesced` orqali (AYNI qurilmadan
 * `ACTIVITY_LOG_LOGIN_DEDUP_MINUTES` ichidagi takror — yangi qator emas,
 * `metadata.count`). Haqiqiy Postgres xulqi — libs/common
 * `retention-policy.pg.spec.ts`.
 */
function makeService(maintenance?: { logCoalesced: jest.Mock }) {
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const users = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  };
  const jwt = {
    signAsync: jest.fn().mockResolvedValue('jwt'),
    decode: jest.fn(() => ({ exp: 2_000_000_000 })),
  };
  const branchClient = {
    send: jest.fn(() => of({ data: { branch_id: null } })),
  };
  const service = new AuthService(
    users as never,
    jwt as never,
    {
      get: (k: string) =>
        k === 'REFRESH_TOKEN_KEY' ? 'r'.repeat(40) : undefined,
    } as never,
    {} as never,
    branchClient as never,
    activityLog as unknown as ActivityLogService,
    // (Elchi Pochta #3) sessiya qatori — bu spec'da faqat id kerak.
    { open: jest.fn().mockResolvedValue({ id: 'session-1' }) } as never,
    maintenance as never,
  );
  return { service, activityLog };
}

const USER = {
  id: '25',
  name: 'TEST kuryer',
  role: 'courier',
  status: 'active',
} as never;

describe('AuthService.sessionForUser — login birlashtirish (i6Nyedea)', () => {
  afterEach(() => {
    delete process.env.ACTIVITY_LOG_LOGIN_DEDUP_MINUTES;
  });

  it('⭐ maintenance bor — logCoalesced (sukut 10 daqiqa oyna), oddiy log() emas', async () => {
    const maintenance = {
      logCoalesced: jest.fn().mockResolvedValue(undefined),
    };
    const { service, activityLog } = makeService(maintenance);

    await service.sessionForUser(USER);

    expect(activityLog.log).not.toHaveBeenCalled();
    expect(maintenance.logCoalesced).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Auth',
        entity_id: '25',
        action: 'login',
        user_id: '25',
        user_name: 'TEST kuryer',
        user_role: 'courier',
        description: 'TEST kuryer tizimga kirdi',
      }),
      10 * 60_000,
    );
  });

  it('ACTIVITY_LOG_LOGIN_DEDUP_MINUTES=0 — oyna 0 (har login yangi qator)', async () => {
    process.env.ACTIVITY_LOG_LOGIN_DEDUP_MINUTES = '0';
    const maintenance = {
      logCoalesced: jest.fn().mockResolvedValue(undefined),
    };
    const { service } = makeService(maintenance);
    await service.sessionForUser(USER, 'otp');
    expect(maintenance.logCoalesced).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { method: 'otp' } }),
      0,
    );
  });

  it('maintenance yo`q (eski quruvchi) — avvalgidek log()', async () => {
    const { service, activityLog } = makeService();
    await service.sessionForUser(USER);
    expect(activityLog.log).toHaveBeenCalledTimes(1);
  });
});
