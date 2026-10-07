import { SmsConsentService } from './sms-consent.service';
import { SmsConfigService } from './sms-config.service';

const SECRET = 'a3f9c1e7b2d4085f6e9a1c3b5d7f0e2a4c6b8d0f';
const DAY = 24 * 60 * 60 * 1000;

describe('SmsConsentService', () => {
  let repo: {
    find: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  const make = (env: Record<string, unknown> = {}) => {
    const all = {
      SMS_DLR_SECRET: SECRET,
      SMS_OPT_OUT_BASE_URL: 'https://api.elchipochta.uz/sms/stop',
      ...env,
    };
    const get = (key: string) => all[key as keyof typeof all];
    return new SmsConsentService(
      repo as never,
      new SmsConfigService({ get } as never),
      { get } as never,
    );
  };
  const now = new Date('2026-10-06T10:00:00Z');
  const row = (extra: Record<string, unknown>) => ({
    phone: '+998901111111',
    customer_id: '7',
    granted: true,
    revoked_at: null,
    granted_at: new Date(now.getTime() - DAY),
    ...extra,
  });

  beforeEach(() => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn((v) => Promise.resolve(v)),
      create: jest.fn((v) => v),
    };
  });

  const check = async (
    rows: unknown[],
    recipient = { phone: '+998901111111', customer_id: '7' },
  ) => {
    repo.find.mockResolvedValue(rows);
    return make().partition([recipient], now);
  };

  it('no consent row (unknown) → BLOCKED (fail-closed, not fail-open)', async () => {
    expect((await check([])).blocked).toHaveLength(1);
  });

  it('valid consent → allowed', async () => {
    expect((await check([row({})])).allowed).toHaveLength(1);
  });

  it('revoked consent → blocked', async () => {
    expect((await check([row({ revoked_at: now })])).blocked).toHaveLength(1);
  });

  it('consent older than SMS_CONSENT_TTL_DAYS (365) → blocked', async () => {
    expect(
      (await check([row({ granted_at: new Date(now.getTime() - 400 * DAY) })]))
        .blocked,
    ).toHaveLength(1);
  });

  it('number re-issued to another customer → the old consent does not carry over', async () => {
    expect(
      (
        await check([row({ customer_id: '7' })], {
          phone: '+998901111111',
          customer_id: '99',
        })
      ).blocked,
    ).toHaveLength(1);
  });

  it('the LATEST record decides (a later revoke wins over an older grant)', async () => {
    const rows = [
      row({ revoked_at: now, granted_at: new Date(now.getTime() - 1000) }),
      row({}),
    ];
    expect((await check(rows)).blocked).toHaveLength(1);
  });

  it('opt-out link: appended to the text, token round-trips, tampering is rejected', () => {
    const service = make();
    const text = service.appendOptOut('Chegirma 20%', '+998901111111');
    expect(text).toMatch(
      /^Chegirma 20%\nRad etish: https:\/\/api\.elchipochta\.uz\/sms\/stop\/998901111111\./,
    );
    const token = text!.split('/').pop()!;
    expect(service.verifyOptOutToken(token)).toBe('+998901111111');
    expect(
      service.verifyOptOutToken(token.replace('998901111111', '998902222222')),
    ).toBeNull();
    expect(service.verifyOptOutToken(`${token}x`)).toBeNull();
  });

  it('opt-out not configured → null (caller blocks promo)', () => {
    expect(
      make({ SMS_OPT_OUT_BASE_URL: '' }).appendOptOut('x', '+998901111111'),
    ).toBeNull();
  });

  it('revoke normalises the number', async () => {
    await make().revoke('90 111 11 11');
    expect(repo.update.mock.calls[0][0]).toMatchObject({
      phone: '+998901111111',
      channel: 'sms',
    });
  });
});
