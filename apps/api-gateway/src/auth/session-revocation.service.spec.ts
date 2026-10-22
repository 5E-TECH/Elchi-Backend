import { NEVER, from, of, throwError } from 'rxjs';
import {
  SESSION_ACTIVE_RECHECK_MS,
  SESSION_CACHE_MAX,
  SESSION_STATE_PATTERN,
  SESSION_UNKNOWN_TTL_MS,
  SessionRevocationService,
  accessTokenTtlMs,
} from './session-revocation.service';

/**
 * (Elchi Pochta #3) Gateway: yopilgan sessiya tokenini darhol to'xtatish keshi.
 *  - ochiq sessiya 30 s dan keyin qayta so'raladi, yopilgani ACCESS_TOKEN_TIME
 *    saqlanadi, kesh hajmi chegaralangan;
 *  - identity javob bermasa / xato — FAIL OPEN (ruxsat), ogohlantirish
 *    daqiqasiga bir marta, natija 5 s;
 *  - revoke/logout `markRevoked` — identity'siz darhol «yopilgan».
 */
const SID = '3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d';
const SID2 = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const HOUR = 3600_000;

function build(
  reply: (payload: { userId: string; sessionId: string }) => unknown = () =>
    of({ active: true }),
  accessTokenTime: string | undefined = '1h',
) {
  const send = jest.fn((_pattern: unknown, payload: unknown) =>
    reply(payload as { userId: string; sessionId: string }),
  );
  const service = new SessionRevocationService(
    { send } as never,
    { get: () => accessTokenTime } as never,
  );
  let clock = 1_000_000;
  service.now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const warn = jest
    .spyOn(
      (service as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    )
    .mockImplementation(() => undefined);
  return { service, send, advance, warn };
}

describe('SessionRevocationService (Elchi Pochta #3)', () => {
  it('⭐ ochiq sessiya: identity.auth.session_state so‘raladi, 30 s kesh, keyin qayta tekshiriladi', async () => {
    const { service, send, advance } = build();

    await expect(service.isRevoked('25', SID.toUpperCase())).resolves.toBe(
      false,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(SESSION_STATE_PATTERN, {
      userId: '25',
      sessionId: SID,
    });

    advance(SESSION_ACTIVE_RECHECK_MS - 1);
    await service.isRevoked('25', SID);
    expect(send).toHaveBeenCalledTimes(1);

    advance(2);
    await service.isRevoked('25', SID);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('⭐ yopilgan sessiya: true, ACCESS_TOKEN_TIME davomida identity qayta so‘ralmaydi, keyin chiqariladi', async () => {
    const { service, send, advance } = build(() => of({ active: false }));

    await expect(service.isRevoked('25', SID)).resolves.toBe(true);
    advance(HOUR - 1);
    await expect(service.isRevoked('25', SID)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);

    advance(2);
    expect(service.size).toBe(1);
    await expect(service.isRevoked('25', SID)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('bir vaqtdagi bir xil sid so‘rovlari — bitta RMQ chaqiruvi', async () => {
    let resolveReply: (value: { active: boolean }) => void = () => undefined;
    const pending = new Promise<{ active: boolean }>((resolve) => {
      resolveReply = resolve;
    });
    const { service, send } = build(() => from(pending));

    const calls = Promise.all([
      service.isRevoked('25', SID),
      service.isRevoked('25', SID),
      service.isRevoked('25', SID),
    ]);
    resolveReply({ active: false });
    await expect(calls).resolves.toEqual([true, true, true]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('⭐ identity xatosi — FAIL OPEN: ruxsat, 5 s kesh, ogohlantirish daqiqasiga bir marta', async () => {
    const { service, send, advance, warn } = build(() =>
      throwError(() => ({ statusCode: 500, message: 'db down' })),
    );

    await expect(service.isRevoked('25', SID)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('fail open');
    expect(warn.mock.calls[0][0]).toContain('db down');

    // 5 s ichida — identity qayta so'ralmaydi.
    advance(SESSION_UNKNOWN_TTL_MS - 1);
    await service.isRevoked('25', SID);
    expect(send).toHaveBeenCalledTimes(1);

    // Keyin — qayta so'raladi, lekin ogohlantirish daqiqada bir marta.
    advance(2);
    await service.isRevoked('25', SID);
    await service.isRevoked('25', SID2);
    expect(send).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);

    advance(60_000);
    await service.isRevoked('25', SID);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain('yana 2 marta');
  });

  it('identity javob bermasa (timeout 1,5 s) — ruxsat', async () => {
    const { service, warn } = build(() => NEVER);
    const startedAt = Date.now();
    await expect(service.isRevoked('25', SID)).resolves.toBe(false);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(3_000);
    expect(warn.mock.calls[0][0]).toContain('TimeoutError');
  });

  it('kutilmagan javob shakli — ruxsat (fail open), qulflanmaydi', async () => {
    const { service, warn } = build(() => of({ statusCode: 200, data: {} }));
    await expect(service.isRevoked('25', SID)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('⭐ markRevoked — identity’siz darhol true; katta harf / noto‘g‘ri qiymatlar xavfsiz', async () => {
    const { service, send } = build();
    service.markRevoked([SID.toUpperCase(), null, 42, '']);
    await expect(service.isRevoked('25', SID)).resolves.toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(service.size).toBe(1);
    service.markRevoked(undefined);
    expect(service.size).toBe(1);
  });

  it('ochiq deb keshlangan sessiya markRevoked dan keyin darhol true', async () => {
    const { service } = build();
    await expect(service.isRevoked('25', SID)).resolves.toBe(false);
    service.markRevoked([SID]);
    await expect(service.isRevoked('25', SID)).resolves.toBe(true);
  });

  it('so‘rov davomida markRevoked bo‘lsa — kechikkan «active» javobi uni bosib ketmaydi', async () => {
    let resolveReply: (value: { active: boolean }) => void = () => undefined;
    const { service } = build(() =>
      from(
        new Promise<{ active: boolean }>((resolve) => {
          resolveReply = resolve;
        }),
      ),
    );
    const first = service.isRevoked('25', SID);
    service.markRevoked([SID]);
    resolveReply({ active: true });
    await expect(first).resolves.toBe(true);
    await expect(service.isRevoked('25', SID)).resolves.toBe(true);
  });

  it('kesh hajmi chegaralangan — eng eskisi chiqadi (keyin identity’dan qayta olinadi)', async () => {
    const { service, send } = build(() => of({ active: false }));
    const ids = Array.from(
      { length: SESSION_CACHE_MAX + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    service.markRevoked(ids);
    expect(service.size).toBe(SESSION_CACHE_MAX);

    // Eng oxirgisi keshda (identity'siz), birinchisi chiqarilgan — qayta
    // so'raladi va baribir «yopilgan».
    await expect(service.isRevoked('25', ids[SESSION_CACHE_MAX])).resolves.toBe(
      true,
    );
    expect(send).not.toHaveBeenCalled();
    await expect(service.isRevoked('25', ids[0])).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(service.size).toBe(SESSION_CACHE_MAX);
  });

  it('accessTokenTtlMs: 1h / 30m / 3600 (soniya) / noto‘g‘ri → 1 soat', () => {
    expect(accessTokenTtlMs('1h')).toBe(HOUR);
    expect(accessTokenTtlMs('30m')).toBe(30 * 60_000);
    expect(accessTokenTtlMs('3600')).toBe(HOUR);
    expect(accessTokenTtlMs('2d')).toBe(2 * 24 * HOUR);
    expect(accessTokenTtlMs(900)).toBe(900_000);
    expect(accessTokenTtlMs(undefined)).toBe(HOUR);
    expect(accessTokenTtlMs('soon')).toBe(HOUR);
    expect(accessTokenTtlMs('0')).toBe(HOUR);
  });

  it('yopilgan yozuv muddati ACCESS_TOKEN_TIME dan olinadi (30m)', async () => {
    const { service, send, advance } = build(
      () => of({ active: false }),
      '30m',
    );
    await service.isRevoked('25', SID);
    advance(30 * 60_000 + 1);
    await service.isRevoked('25', SID);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
