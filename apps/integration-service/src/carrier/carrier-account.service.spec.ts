import { createHash } from 'crypto';
import { of, throwError } from 'rxjs';
import { CarrierAccountService } from './carrier-account.service';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Repo = {
  findOne: jest.Mock;
  find: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

const ROW = () => ({
  id: '11',
  name: 'BTS',
  courier_user_id: '55',
  api_key_hash: sha256('old'),
  ip_allowlist: null as string[] | null,
  is_active: true,
  createdAt: new Date('2026-11-10T00:00:00Z'),
  updatedAt: new Date('2026-11-10T00:00:00Z'),
});

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    findOne: jest.fn(() => Promise.resolve(null)),
    find: jest.fn(() => Promise.resolve([])),
    create: jest.fn((v: Record<string, unknown>) => ({ ...v })),
    save: jest.fn((v: Record<string, unknown>) =>
      Promise.resolve({ ...ROW(), ...v }),
    ),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    ...overrides,
  };
}

const ACTIVE_COURIER = {
  id: '55',
  name: 'BTS kuryer',
  role: 'courier',
  status: 'active',
};

function makeService(
  repo: Repo,
  identityUsers: unknown[] | Error = [ACTIVE_COURIER],
) {
  const identityClient = {
    send: jest.fn(() =>
      identityUsers instanceof Error
        ? throwError(() => identityUsers)
        : of({ success: true, data: identityUsers }),
    ),
  };
  const activityLog = { log: jest.fn(() => Promise.resolve()) };
  const svc = new CarrierAccountService(
    repo as never,
    activityLog as never,
    identityClient as never,
  );
  return { svc, identityClient, activityLog };
}

const rpcStatus = async (p: Promise<unknown>): Promise<number | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { getError?: () => { statusCode?: number } }).getError?.()
      ?.statusCode;
  }
};

describe('CarrierAccountService.validateKey', () => {
  const keyRow = (over: Record<string, unknown> = {}) => ({
    id: '3',
    name: 'BTS',
    is_active: true,
    ip_allowlist: ['1.2.3.4'],
    courier_user_id: '55',
    ...over,
  });

  it('sha256 hash bo‘yicha qidiradi; faol kurier -> courier_active: true', async () => {
    const repo = makeRepo({
      findOne: jest.fn(() => Promise.resolve(keyRow())),
    });
    const { svc } = makeService(repo);

    await expect(svc.validateKey('elc_secret')).resolves.toEqual({
      id: '3',
      name: 'BTS',
      is_active: true,
      ip_allowlist: ['1.2.3.4'],
      courier_user_id: '55',
      courier_active: true,
    });
    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { api_key_hash: sha256('elc_secret'), isDeleted: false },
      }),
    );
  });

  it('⭐ bloklangan / o‘chirilgan / kurier emas user -> courier_active: false', async () => {
    for (const users of [
      [{ ...ACTIVE_COURIER, status: 'inactive' }],
      [], // identity o'chirilgan userni qaytarmaydi
      [{ ...ACTIVE_COURIER, role: 'manager' }],
    ]) {
      const repo = makeRepo({
        findOne: jest.fn(() => Promise.resolve(keyRow())),
      });
      const { svc } = makeService(repo, users);
      await expect(svc.validateKey('k')).resolves.toMatchObject({
        courier_active: false,
      });
    }
  });

  it('kurier holati 30 s keshlanadi (har so‘rovda identity’ga bormaydi)', async () => {
    const repo = makeRepo({
      findOne: jest.fn(() => Promise.resolve(keyRow())),
    });
    const { svc, identityClient } = makeService(repo);
    await svc.validateKey('k');
    await svc.validateKey('k');
    await svc.validateKey('k');
    expect(identityClient.send).toHaveBeenCalledTimes(1);
  });

  it('⭐ identity javob bermasa -> 503 (yopiq), kesh yozilmaydi', async () => {
    const repo = makeRepo({
      findOne: jest.fn(() => Promise.resolve(keyRow())),
    });
    const { svc } = makeService(repo, new Error('down'));
    expect(await rpcStatus(svc.validateKey('k'))).toBe(503);
  });

  it('faol emas akkaunt — identity’ga bormaydi, courier_active: false', async () => {
    const repo = makeRepo({
      findOne: jest.fn(() => Promise.resolve(keyRow({ is_active: false }))),
    });
    const { svc, identityClient } = makeService(repo);
    await expect(svc.validateKey('k')).resolves.toMatchObject({
      is_active: false,
      courier_active: false,
    });
    expect(identityClient.send).not.toHaveBeenCalled();
  });

  it('bo‘sh kalit -> null, bazaga bormaydi', async () => {
    const repo = makeRepo();
    const { svc } = makeService(repo);
    await expect(svc.validateKey('  ')).resolves.toBeNull();
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});

describe('CarrierAccountService.create', () => {
  it('kurierni tekshiradi, hash saqlaydi, kalitni bir marta qaytaradi', async () => {
    const repo = makeRepo();
    const { svc, identityClient, activityLog } = makeService(repo);

    const res = (await svc.create({
      name: ' BTS Express ',
      courier_id: '55',
      ip_allowlist: [' 1.2.3.4 ', '', '2001:0DB8::0001', '10.0.0.0/8'],
      requester: { id: '1', roles: ['superadmin'] },
    })) as { statusCode: number; data: Record<string, unknown> };

    expect(res.statusCode).toBe(201);
    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_ids' },
      expect.objectContaining({ ids: ['55'] }),
    );
    const apiKey = String(res.data.api_key);
    expect(apiKey).toMatch(/^elc_[0-9a-f]{64}$/);

    const saved = repo.save.mock.calls[0][0] as Record<string, unknown>;
    expect(saved).toMatchObject({
      name: 'BTS Express',
      courier_user_id: '55',
      api_key_hash: sha256(apiKey),
      // IPv6 kanonik shaklga keltiriladi.
      ip_allowlist: ['1.2.3.4', '2001:db8::1', '10.0.0.0/8'],
      is_active: true,
    });
    expect(saved).not.toHaveProperty('api_key');
    expect(res.data).toMatchObject({
      courier_user_id: '55',
      courier_name: 'BTS kuryer',
    });
    expect(JSON.stringify(activityLog.log.mock.calls)).not.toContain(apiKey);
  });

  it('⭐ tushunilmagan IP yozuvi -> 400 (jimgina saqlanmaydi)', async () => {
    for (const bad of [
      ['1.2.3.4,5.6.7.8'],
      ['2001:db8::/32'],
      ['10.0.0.0/33'],
      ['not-an-ip'],
      ['01.2.3.4'],
    ]) {
      const repo = makeRepo();
      const { svc } = makeService(repo);
      expect(
        await rpcStatus(
          svc.create({ name: 'X', courier_id: '55', ip_allowlist: bad }),
        ),
      ).toBe(400);
      expect(repo.save).not.toHaveBeenCalled();
    }
  });

  it('kurier emas / faol emas -> 400, topilmagan -> 404, identity yo‘q -> 503', async () => {
    const cases: Array<[unknown[] | Error, number]> = [
      [[{ ...ACTIVE_COURIER, role: 'manager' }], 400],
      [[{ ...ACTIVE_COURIER, status: 'inactive' }], 400],
      [[], 404],
      [new Error('down'), 503],
    ];
    for (const [users, status] of cases) {
      const { svc } = makeService(makeRepo(), users);
      expect(await rpcStatus(svc.create({ name: 'X', courier_id: '55' }))).toBe(
        status,
      );
    }
  });

  it('kurier allaqachon boshqa akkauntda -> 409 (rotate-key yo‘li aytiladi)', async () => {
    const repo = makeRepo({
      findOne: jest.fn(() => Promise.resolve({ id: '2', name: 'Eski' })),
    });
    const { svc } = makeService(repo);
    let message = '';
    try {
      await svc.create({ name: 'X', courier_id: '55' });
    } catch (e) {
      const err = (
        e as { getError: () => { statusCode: number; message: string } }
      ).getError();
      expect(err.statusCode).toBe(409);
      message = err.message;
    }
    expect(message).toContain('/admin/carriers/2/rotate-key');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('parallel yaratish (unique violation) -> 409', async () => {
    const repo = makeRepo({
      save: jest.fn(() =>
        Promise.reject(
          Object.assign(new Error('duplicate'), { code: '23505' }),
        ),
      ),
    });
    const { svc } = makeService(repo);
    expect(await rpcStatus(svc.create({ name: 'X', courier_id: '55' }))).toBe(
      409,
    );
  });

  it('⭐ id chegaralari: yetakchi nol / BIGINT’dan katta / nomsiz -> 400 (500 emas)', async () => {
    const { svc } = makeService(makeRepo());
    expect(await rpcStatus(svc.create({ courier_id: '55' }))).toBe(400);
    for (const bad of ['055', '9223372036854775808', 'abc', '0']) {
      expect(await rpcStatus(svc.create({ name: 'X', courier_id: bad }))).toBe(
        400,
      );
    }
    expect(await rpcStatus(svc.rotateKey('99999999999999999999'))).toBe(400);
  });
});

describe('CarrierAccountService.rotateKey / setActive / update', () => {
  it('rotateKey: faqat api_key_hash yoziladi (to‘liq save emas), kurier tekshiriladi', async () => {
    const repo = makeRepo({ findOne: jest.fn(() => Promise.resolve(ROW())) });
    const { svc, identityClient } = makeService(repo);

    const res = (await svc.rotateKey('11')) as {
      data: { api_key: string };
    };
    expect(res.data.api_key).toMatch(/^elc_/);
    expect(repo.update).toHaveBeenCalledWith(
      { id: '11', isDeleted: false },
      { api_key_hash: sha256(res.data.api_key) },
    );
    expect(repo.save).not.toHaveBeenCalled();
    expect(identityClient.send).toHaveBeenCalled();
  });

  it('⭐ bloklangan kurierga yangi kalit chiqmaydi / akkaunt yoqilmaydi', async () => {
    const blocked = [{ ...ACTIVE_COURIER, status: 'inactive' }];
    for (const run of [
      (svc: CarrierAccountService) => svc.rotateKey('11'),
      (svc: CarrierAccountService) => svc.setActive('11', true),
    ]) {
      const repo = makeRepo({ findOne: jest.fn(() => Promise.resolve(ROW())) });
      const { svc } = makeService(repo, blocked);
      expect(await rpcStatus(run(svc))).toBe(400);
      expect(repo.update).not.toHaveBeenCalled();
    }
  });

  it('setActive(false): kurier tekshirilmaydi, faqat is_active yoziladi', async () => {
    const repo = makeRepo({
      findOne: jest.fn(() => Promise.resolve({ ...ROW(), is_active: false })),
    });
    const { svc, identityClient } = makeService(repo);
    await svc.setActive('11', false);
    expect(identityClient.send).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith(
      { id: '11', isDeleted: false },
      { is_active: false },
    );
  });

  it('setActive: boolean bo‘lmasa 400, topilmasa 404', async () => {
    const { svc } = makeService(makeRepo());
    expect(await rpcStatus(svc.setActive('11', 'yes' as never))).toBe(400);
    expect(await rpcStatus(svc.setActive('11', false))).toBe(404);
  });

  it('update: faqat o‘zgargan ustunlar; bo‘sh ro‘yxat — null; maydonsiz 400; affected 0 — 404', async () => {
    const repo = makeRepo({ findOne: jest.fn(() => Promise.resolve(ROW())) });
    const { svc } = makeService(repo);

    await svc.update('11', { ip_allowlist: [] });
    expect(repo.update).toHaveBeenCalledWith(
      { id: '11', isDeleted: false },
      { ip_allowlist: null },
    );
    expect(await rpcStatus(svc.update('11', {}))).toBe(400);

    const gone = makeRepo({
      update: jest.fn(() => Promise.resolve({ affected: 0 })),
    });
    const { svc: svc2 } = makeService(gone);
    expect(await rpcStatus(svc2.update('11', { name: 'Y' }))).toBe(404);
  });
});
