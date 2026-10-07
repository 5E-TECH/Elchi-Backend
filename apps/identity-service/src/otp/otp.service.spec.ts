import { RpcException } from '@nestjs/microservices';
import { OtpService } from './otp.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

const KEY = 'f0e1d2c3b4a5968778695a4b3c2d1e0f1a2b3c4d';

describe('OtpService', () => {
  let rows: any[];
  let codes: any;
  let users: any;
  let auth: any;
  let activityLog: any;
  let service: OtpService;
  const now = new Date('2026-10-06T10:00:00Z');

  beforeEach(() => {
    rows = [];
    let nextId = 1;
    const matches = (row: any, where: any) =>
      row.phone === where.phone &&
      row.purpose === where.purpose &&
      (where.consumed_at === undefined || row.consumed_at === null) &&
      (where.created_at === undefined ||
        row.created_at >= where.created_at.value);
    codes = {
      find: jest.fn(({ where }: any) =>
        Promise.resolve(
          rows
            .filter((r) => matches(r, where))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, 1),
        ),
      ),
      count: jest.fn(({ where }: any) =>
        Promise.resolve(rows.filter((r) => matches(r, where)).length),
      ),
      create: jest.fn((v: any) => v),
      save: jest.fn((v: any) => {
        const row = { id: String(nextId++), created_at: new Date(now), ...v };
        rows.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn((where: any, patch: any) => {
        const row = rows.find(
          (r) =>
            r.id === where.id &&
            (where.consumed_at === undefined || r.consumed_at === null),
        );
        if (row) Object.assign(row, patch);
        return Promise.resolve({ affected: row ? 1 : 0 });
      }),
      delete: jest.fn(),
    };
    users = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: '9', role: 'customer', language: 'ru' }),
    };
    auth = {
      sessionForUser: jest
        .fn()
        .mockResolvedValue({ statusCode: 200, accessToken: 'jwt' }),
      phoneForAudit: (phone: string) => ({
        phone_masked: `***${phone.slice(-4)}`,
        phone_hash: 'h',
      }),
    };
    activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    rmqSendMock.mockReset().mockResolvedValue({ queued: true });
    const config = { get: (k: string) => ({ OTP_HASH_SECRET: KEY })[k] };
    service = new OtpService(
      codes,
      users,
      {} as never,
      config as never,
      auth,
      activityLog,
    );
  });

  const sentCode = () => rmqSendMock.mock.calls.at(-1)[2].code as string;
  const err = async (p: Promise<unknown>) => {
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcException);
    return (e as RpcException).getError() as any;
  };

  it('request: stores only a hash, sends the code via notification (security path), same answer', async () => {
    const res = await service.request(
      { phone_number: '90 123 45 67', ip: '1.2.3.4' },
      now,
    );
    expect(res.message).toMatch(/Agar raqam ro'yxatdan o'tgan bo'lsa/);
    expect(rmqSendMock.mock.calls[0][1]).toEqual({
      cmd: 'notification.sms.send_otp',
    });
    const payload = rmqSendMock.mock.calls[0][2];
    expect(payload).toMatchObject({
      phone: '+998901234567',
      otp_id: '1',
      lang: 'ru',
    });
    expect(rows[0].code_hash).not.toContain(payload.code);
    expect(JSON.stringify(rows[0])).not.toContain(`"${payload.code}"`);
    expect(JSON.stringify(activityLog.log.mock.calls)).not.toContain(
      '901234567',
    );
  });

  it('different formats of one number normalise to the same phone', async () => {
    await service.request({ phone_number: '998901234567' }, now);
    await err(service.request({ phone_number: '+998 (90) 123-45-67' }, now)); // 60 s limit on the SAME number
    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toBe('+998901234567');
  });

  it('per-number limits: 60 s, then 5 per hour', async () => {
    await service.request({ phone_number: '901234567' }, now);
    expect(
      (
        await err(
          service.request(
            { phone_number: '901234567' },
            new Date(now.getTime() + 30_000),
          ),
        )
      ).statusCode,
    ).toBe(429);
    for (let i = 1; i <= 4; i += 1) {
      await service.request(
        { phone_number: '901234567' },
        new Date(now.getTime() + i * 61_000),
      );
    }
    const sixth = await err(
      service.request(
        { phone_number: '901234567' },
        new Date(now.getTime() + 6 * 61_000),
      ),
    );
    expect(sixth.statusCode).toBe(429);
  });

  it('unknown number: SAME answer, row written (limits identical), but no SMS', async () => {
    users.findOne.mockResolvedValue(null);
    const res = await service.request({ phone_number: '909999999' }, now);
    expect(res.message).toMatch(/Agar raqam ro'yxatdan o'tgan bo'lsa/);
    expect(rows).toHaveLength(1);
    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(
      (
        await err(
          service.request(
            { phone_number: '909999999' },
            new Date(now.getTime() + 1000),
          ),
        )
      ).statusCode,
    ).toBe(429);
  });

  it('verify: right code → session (customer), consumed at once, the same code does not work again', async () => {
    await service.request({ phone_number: '901234567' }, now);
    const code = sentCode();
    const later = new Date(now.getTime() + 60_000);
    await expect(
      service.verify({ phone_number: '901234567', code }, later),
    ).resolves.toMatchObject({ accessToken: 'jwt' });
    expect(auth.sessionForUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: '9' }),
      'otp',
    );
    expect(rows[0].consumed_at).toEqual(later);
    expect(
      (await err(service.verify({ phone_number: '901234567', code }, later)))
        .statusCode,
    ).toBe(400);
  });

  it('5 wrong codes cancel the code; the 6th try needs a new code even with the right one', async () => {
    await service.request({ phone_number: '901234567' }, now);
    const code = sentCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1)
      await err(
        service.verify({ phone_number: '901234567', code: wrong }, now),
      );
    expect(rows[0].consumed_at).not.toBeNull();
    expect(
      (await err(service.verify({ phone_number: '901234567', code }, now)))
        .statusCode,
    ).toBe(400);
  });

  it('expires after 5 minutes', async () => {
    await service.request({ phone_number: '901234567' }, now);
    const code = sentCode();
    expect(
      (
        await err(
          service.verify(
            { phone_number: '901234567', code },
            new Date(now.getTime() + 301_000),
          ),
        )
      ).statusCode,
    ).toBe(400);
  });

  it('OTP login is for customers only', async () => {
    await service.request({ phone_number: '901234567' }, now);
    const code = sentCode();
    users.findOne.mockResolvedValue(null); // staff/unknown → no customer
    expect(
      (await err(service.verify({ phone_number: '901234567', code }, now)))
        .statusCode,
    ).toBe(401);
    expect(auth.sessionForUser).not.toHaveBeenCalled();
  });

  it('cleanup deletes expired rows in batches', async () => {
    codes.find = jest
      .fn()
      .mockResolvedValueOnce([{ id: '1' }, { id: '2' }])
      .mockResolvedValueOnce([]);
    codes.delete = jest.fn().mockResolvedValue({ affected: 2 });
    expect(await service.cleanup(now)).toBe(2);
    expect(codes.delete).toHaveBeenCalledWith(['1', '2']);
  });
});

describe('AuthService.logAuthFailure — no full phone in the audit log (rkz0yBxr #8)', () => {
  it('stores a mask + stable hash only', async () => {
    const { AuthService } = jest.requireActual('../auth/auth.service');
    const log = jest.fn().mockResolvedValue(undefined);
    const service = new AuthService(
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      { get: (k: string) => ({ OTP_HASH_SECRET: KEY })[k] } as never,
      {} as never,
      {} as never,
      { log } as never,
    );
    await service
      .login({ phone_number: '+998901237434', password: 'x' })
      .catch(() => undefined);
    const entry = log.mock.calls[0][0];
    expect(JSON.stringify(entry)).not.toContain('901237434');
    expect(entry.metadata).toMatchObject({
      phone_masked: '***7434',
      reason: 'user_not_found',
    });
    expect(entry.metadata.phone_hash).toHaveLength(32);
    expect(service.phoneForAudit('90 123 74 34').phone_hash).toBe(
      entry.metadata.phone_hash,
    );
  });
});
