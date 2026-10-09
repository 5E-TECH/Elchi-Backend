import { createHmac } from 'node:crypto';
import { of } from 'rxjs';
import { ActivityLogService, requestContext } from '@app/common';
import { AuthService } from './auth.service';

/**
 * f2Ud5tju #5 — kirish urinishlari jurnalida telefon MASKALANGAN, entity_id da
 * raqam yo'q, normallashtirilgan raqamdan barqaror HMAC hash. 2WRzdWpZ —
 * login/auth_failure qatorlarida o'zbekcha gap.
 */
const KEY = 'f0e1d2c3b4a5968778695a4b3c2d1e0f1a2b3c4d';

type Row = Record<string, any>;

function makeService(opts: { user?: Row | null; key?: string | null } = {}) {
  const saved: Row[] = [];
  const activityLog = new ActivityLogService(
    {
      create: (row: Row) => row,
      save: (row: Row) => {
        saved.push(row);
        return Promise.resolve(row);
      },
    } as never,
    'identity-service',
  );
  const env: Record<string, string | undefined> = {
    OTP_HASH_SECRET: opts.key === undefined ? KEY : (opts.key ?? undefined),
    REFRESH_TOKEN_KEY: 'r'.repeat(40),
  };
  const users = {
    findOne: jest.fn().mockResolvedValue(opts.user ?? null),
    update: jest.fn().mockResolvedValue({}),
  };
  const bcrypt = { compare: jest.fn().mockResolvedValue(false) };
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
    { get: (k: string) => env[k] } as never,
    bcrypt as never,
    branchClient as never,
    activityLog,
  );
  return { service, saved, bcrypt };
}

const HTTP = {
  traceId: 't-auth',
  ip: '203.0.113.7',
  user_agent: 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile',
  device_name: 'Telefon · Android · Chrome',
};

describe('AuthService — auth_failure jurnali (f2Ud5tju #5)', () => {
  it('TC7 noto`g`ri parol: faqat ***7434, to`liq raqam YO`Q; IP konteksti yoziladi', async () => {
    const { service, saved } = makeService({
      user: { id: '42', status: 'active', password: 'h', name: 'Ali' },
    });
    await requestContext
      .run(HTTP, () =>
        service.login({ phone_number: '+998 90 123 74 34', password: 'xxxx' }),
      )
      .catch(() => undefined);

    expect(saved).toHaveLength(1);
    const row = saved[0];
    const dump = JSON.stringify(row);
    for (const leak of ['901237434', '90 123 74 34', '998901237434']) {
      expect(dump).not.toContain(leak);
    }
    expect(row.metadata).toMatchObject({
      phone_masked: '***7434',
      reason: 'bad_password',
      ip: '203.0.113.7',
      device_name: 'Telefon · Android · Chrome',
    });
    expect(row.metadata.phone_number).toBeUndefined();
    expect(row.entity_id).toBe('42');
    expect(row.description).toBe(
      "Kirish urinishi muvaffaqiyatsiz: noto'g'ri parol",
    );
  });

  it('TC8 bir raqamning turli yozilishi BITTA HMAC hash beradi', () => {
    const { service } = makeService();
    const variants = [
      '900000000',
      '90 000 00 00',
      '998900000000',
      '+998 90 000 00 00',
      '+998 (90) 000-00-00',
      '8 90 000 00 00',
    ];
    const hashes = new Set(
      variants.map((v) => service.phoneForAudit(v).phone_hash),
    );
    expect(hashes.size).toBe(1);
    const [hash] = [...hashes];
    expect(hash).toHaveLength(32);
    // Avvalgi formula bilan AYNI qiymat — mavjud qatorlardagi hash'lar
    // o'zgarmaydi (guruhlash uzilmaydi).
    expect(hash).toBe(
      createHmac('sha256', KEY)
        .update('phone:+998900000000')
        .digest('hex')
        .slice(0, 32),
    );
    expect(service.phoneForAudit('90 000 00 00').phone_masked).toBe('***0000');
    // Boshqa raqam — boshqa hash.
    expect(service.phoneForAudit('901234567').phone_hash).not.toBe(hash);
  });

  it('TC9 noma`lum raqam: entity_id da raqam emas, hash; search=raqam topmaydi', async () => {
    const { service, saved } = makeService({ user: null });
    await service
      .login({ phone_number: '90 000 00 00', password: 'xxxx' })
      .catch(() => undefined);
    const row = saved[0];
    expect(row.entity_id).toBe(service.phoneForAudit('900000000').phone_hash);
    // Gateway qidiruvi qamraydigan ustunlarning hech birida raqam yo'q
    // (entity_type / entity_id / action / user_name / description).
    for (const col of [
      'entity_type',
      'entity_id',
      'action',
      'user_name',
      'description',
    ]) {
      const value = String(row[col] ?? '');
      expect(value.replace(/\D/g, '')).not.toContain('900000000');
    }
    expect(row.description).toBe(
      'Kirish urinishi muvaffaqiyatsiz: foydalanuvchi topilmadi',
    );
  });

  it('kalit yo`q bo`lsa hash null, entity_id `unknown` (qattiq kodlangan kalit YO`Q)', async () => {
    const { service, saved } = makeService({ user: null, key: null });
    expect(service.phoneForAudit('901234567').phone_hash).toBeNull();
    await service
      .login({ phone_number: '901234567', password: 'xxxx' })
      .catch(() => undefined);
    expect(saved[0].entity_id).toBe('unknown');
  });
});

describe('AuthService — login gapi (2WRzdWpZ TC5)', () => {
  it('TC5 xodim: "<Ism> tizimga kirdi"', async () => {
    const { service, saved } = makeService();
    await service.sessionForUser({
      id: '7',
      name: 'Ali Valiyev',
      role: 'admin',
      username: 'ali',
    } as never);
    expect(saved[0]).toMatchObject({
      action: 'login',
      description: 'Ali Valiyev tizimga kirdi',
      user_name: 'Ali Valiyev',
    });
  });

  it('TC6 mijoz OTP bilan kirsa ismi gapga tushmaydi', async () => {
    const { service, saved } = makeService();
    await service.sessionForUser(
      { id: '9', name: 'Dilnoza Karimova', role: 'customer' } as never,
      'otp',
    );
    expect(saved[0].description).toBe('Mijoz tizimga kirdi (SMS kod)');
  });
});
