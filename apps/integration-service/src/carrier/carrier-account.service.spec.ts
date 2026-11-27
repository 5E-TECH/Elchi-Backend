import { createHash } from 'crypto';
import { of, throwError } from 'rxjs';
import {
  CarrierAccountService,
  carrierTokenFingerprint,
} from './carrier-account.service';

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
  rollback_enabled: false,
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

/** branch-service `branch.user.find_by_user` javobi: HQ kuryeri (sukut). */
const HQ_ASSIGNMENT = {
  user_id: '55',
  branch_id: '1',
  role: 'COURIER',
  branch: { id: '1', type: 'HQ', name: 'Markaziy ombor' },
};

type BranchReplies = {
  assignment?: unknown;
  hq?: unknown;
  error?: Error;
  hqError?: Error;
};

function makeService(
  repo: Repo,
  identityUsers: unknown[] | Error = [ACTIVE_COURIER],
  branch: BranchReplies = {},
) {
  const identityClient = {
    send: jest.fn(() =>
      identityUsers instanceof Error
        ? throwError(() => identityUsers)
        : of({ success: true, data: identityUsers }),
    ),
  };
  const branchClient = {
    send: jest.fn((pattern: { cmd: string }) => {
      if (pattern.cmd === 'branch.find_hq') {
        return branch.hqError
          ? throwError(() => branch.hqError)
          : of({ statusCode: 200, data: branch.hq ?? { id: '1' } });
      }
      return branch.error
        ? throwError(() => branch.error)
        : of({
            statusCode: 200,
            data: 'assignment' in branch ? branch.assignment : HQ_ASSIGNMENT,
          });
    }),
  };
  const activityLog = { log: jest.fn(() => Promise.resolve()) };
  const svc = new CarrierAccountService(
    repo as never,
    activityLog as never,
    identityClient as never,
    branchClient as never,
  );
  return { svc, identityClient, branchClient, activityLog };
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
    api_key_hash: sha256('elc_secret'),
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
      // Ustun yo'q / null — yopiq.
      rollback_enabled: false,
      // Olcha uslubidagi token uchun — hash'ning o'zi emas, barmoq izi.
      token_fp: carrierTokenFingerprint(sha256('elc_secret')),
    });
    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { api_key_hash: sha256('elc_secret'), isDeleted: false },
      }),
    );
  });

  it('⭐ rollback_enabled — har so‘rovda qatordan (kesh yo‘q), faqat aniq true', async () => {
    let flag: unknown = true;
    const repo = makeRepo({
      findOne: jest.fn(() =>
        Promise.resolve(keyRow({ rollback_enabled: flag })),
      ),
    });
    const { svc } = makeService(repo);
    await expect(svc.validateKey('k')).resolves.toMatchObject({
      rollback_enabled: true,
    });
    flag = false;
    await expect(svc.validateKey('k')).resolves.toMatchObject({
      rollback_enabled: false,
    });
    flag = 'true';
    await expect(svc.validateKey('k')).resolves.toMatchObject({
      rollback_enabled: false,
    });
    expect(repo.findOne).toHaveBeenCalledTimes(3);
    expect(repo.findOne).toHaveBeenLastCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ rollback_enabled: true }) as unknown,
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

describe('CarrierAccountService.validateToken (Olcha uslubidagi Bearer)', () => {
  const tokenRow = (over: Record<string, unknown> = {}) => ({
    id: '3',
    name: 'BTS',
    is_active: true,
    ip_allowlist: null,
    courier_user_id: '55',
    rollback_enabled: false,
    api_key_hash: sha256('elc_current'),
    ...over,
  });
  const FP = carrierTokenFingerprint(sha256('elc_current'));

  it('barmoq izi 32 hex, kalit yoki hash’ni o‘z ichiga olmaydi', () => {
    expect(FP).toMatch(/^[0-9a-f]{32}$/);
    expect(FP).not.toContain(sha256('elc_current').slice(0, 16));
    expect(carrierTokenFingerprint(sha256('elc_other'))).not.toBe(FP);
  });

  it('id + joriy kalit izi -> validate_key bilan bir xil javob', async () => {
    const repo = makeRepo({
      findOne: jest.fn(() => Promise.resolve(tokenRow())),
    });
    const { svc } = makeService(repo);
    await expect(svc.validateToken({ id: '3', token_fp: FP })).resolves.toEqual(
      {
        id: '3',
        name: 'BTS',
        is_active: true,
        ip_allowlist: null,
        courier_user_id: '55',
        courier_active: true,
        rollback_enabled: false,
        token_fp: FP,
      },
    );
    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: '3', isDeleted: false } }),
    );
  });

  it('⭐ kalit almashtirilgan (rotate) -> eski token izi mos emas -> null', async () => {
    const repo = makeRepo({
      findOne: jest.fn(() =>
        Promise.resolve(tokenRow({ api_key_hash: sha256('elc_rotated') })),
      ),
    });
    const { svc, identityClient } = makeService(repo);
    await expect(
      svc.validateToken({ id: '3', token_fp: FP }),
    ).resolves.toBeNull();
    expect(identityClient.send).not.toHaveBeenCalled();
  });

  it('o‘chirilgan / topilmagan akkaunt -> null', async () => {
    const repo = makeRepo();
    const { svc } = makeService(repo);
    await expect(
      svc.validateToken({ id: '3', token_fp: FP }),
    ).resolves.toBeNull();
  });

  it('yaroqsiz id yoki iz -> null, bazaga bormaydi', async () => {
    const repo = makeRepo();
    const { svc } = makeService(repo);
    for (const input of [
      { id: 'abc', token_fp: FP },
      { id: '0', token_fp: FP },
      { id: '3', token_fp: 'short' },
      { id: '3', token_fp: FP.toUpperCase() },
      { id: '3' },
      {},
    ]) {
      await expect(svc.validateToken(input)).resolves.toBeNull();
    }
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('faol emas akkaunt — null EMAS (guard 403 qaytarsin), kurier tekshirilmaydi', async () => {
    const repo = makeRepo({
      findOne: jest.fn(() => Promise.resolve(tokenRow({ is_active: false }))),
    });
    const { svc, identityClient } = makeService(repo);
    await expect(
      svc.validateToken({ id: '3', token_fp: FP }),
    ).resolves.toMatchObject({ is_active: false, courier_active: false });
    expect(identityClient.send).not.toHaveBeenCalled();
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
      rollback_enabled: false,
    });
    expect(saved).not.toHaveProperty('api_key');
    expect(res.data).toMatchObject({
      courier_user_id: '55',
      courier_name: 'BTS kuryer',
      rollback_enabled: false,
    });
    expect(JSON.stringify(activityLog.log.mock.calls)).not.toContain(apiKey);
  });

  it('⭐ yangi akkaunt — rollback DOIM o‘chiq (payload’da true kelsa ham)', async () => {
    const repo = makeRepo();
    const { svc, activityLog } = makeService(repo);
    const res = (await svc.create({
      name: 'BTS',
      courier_id: '55',
      rollback_enabled: true,
    } as never)) as { data: Record<string, unknown> };
    const [createdRow] = repo.create.mock.calls[0] as unknown[];
    expect(createdRow).toMatchObject({ rollback_enabled: false });
    expect(res.data.rollback_enabled).toBe(false);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        new_value: expect.objectContaining({
          rollback_enabled: false,
        }) as unknown,
      }),
    );
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

describe('CarrierAccountService — rollback toggle (admin)', () => {
  it('⭐ update { rollback_enabled: true } yolg‘iz: faqat shu ustun, audit eski → yangi, javobda bor', async () => {
    let row = ROW();
    const repo = makeRepo({
      findOne: jest.fn(() => Promise.resolve({ ...row })),
      update: jest.fn((_where: unknown, changes: Record<string, unknown>) => {
        row = { ...row, ...changes };
        return Promise.resolve({ affected: 1 });
      }),
    });
    const { svc, activityLog } = makeService(repo);

    const res = (await svc.update(
      '11',
      { rollback_enabled: true },
      { id: '1', roles: ['superadmin'] },
    )) as { statusCode: number; data: Record<string, unknown> };

    expect(repo.update).toHaveBeenCalledWith(
      { id: '11', isDeleted: false },
      { rollback_enabled: true },
    );
    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({ id: '11', rollback_enabled: true });
    expect(activityLog.log).toHaveBeenCalledWith({
      entity_type: 'CarrierAccount',
      entity_id: '11',
      action: 'updated',
      old_value: { rollback_enabled: false },
      new_value: { rollback_enabled: true },
      user_id: '1',
      user_role: 'superadmin',
    });

    // Qaytarib o'chirish — round-trip.
    activityLog.log.mockClear();
    const off = (await svc.update(
      '11',
      { rollback_enabled: false },
      { id: '2', roles: ['admin'] },
    )) as { data: Record<string, unknown> };
    expect(off.data.rollback_enabled).toBe(false);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: { rollback_enabled: true },
        new_value: { rollback_enabled: false },
        user_id: '2',
      }),
    );
  });

  it('update: rollback_enabled + name birga; eski qiymatlar audit’da', async () => {
    const repo = makeRepo({ findOne: jest.fn(() => Promise.resolve(ROW())) });
    const { svc, activityLog } = makeService(repo);
    await svc.update('11', { name: ' Yangi ', rollback_enabled: true });
    expect(repo.update).toHaveBeenCalledWith(
      { id: '11', isDeleted: false },
      { name: 'Yangi', rollback_enabled: true },
    );
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: { name: 'BTS', rollback_enabled: false },
        new_value: { name: 'Yangi', rollback_enabled: true },
      }),
    );
  });

  it('update: rollback_enabled boolean bo‘lmasa -> 400, bazaga yozilmaydi', async () => {
    for (const bad of ['true', 1, null]) {
      const repo = makeRepo({ findOne: jest.fn(() => Promise.resolve(ROW())) });
      const { svc } = makeService(repo);
      expect(
        await rpcStatus(svc.update('11', { rollback_enabled: bad as never })),
      ).toBe(400);
      expect(repo.update).not.toHaveBeenCalled();
    }
  });

  it('list / rotate-key / status javoblarida rollback_enabled bor', async () => {
    let enabled = { ...ROW(), rollback_enabled: true };
    const repo = makeRepo({
      find: jest.fn(() => Promise.resolve([enabled, { ...ROW(), id: '12' }])),
      findOne: jest.fn(() => Promise.resolve({ ...enabled })),
      update: jest.fn((_where: unknown, changes: Record<string, unknown>) => {
        enabled = { ...enabled, ...changes };
        return Promise.resolve({ affected: 1 });
      }),
    });
    const { svc } = makeService(repo);

    const list = (await svc.list()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(list.data.map((r) => r.rollback_enabled)).toEqual([true, false]);
    expect(JSON.stringify(list.data)).not.toContain('api_key_hash');

    const rotated = (await svc.rotateKey('11')) as {
      data: Record<string, unknown>;
    };
    expect(rotated.data).toMatchObject({ id: '11', rollback_enabled: true });

    const status = (await svc.setActive('11', false)) as {
      data: Record<string, unknown>;
    };
    expect(status.data).toEqual({
      id: '11',
      is_active: false,
      rollback_enabled: true,
    });
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

/**
 * EGA QARORI (2026-11-15): «faqat integratsiya qilingan tashqi yetkazib
 * beruvchiga faqat HQ ga ochilgan o'z kurieri bo'lsagina biriktirish mumkin
 * bo'lishi kerak». Tekshiruv faqat `create` da; eski akkauntlar
 * (rotate-key / status / validate_key) avvalgidek.
 */
describe('CarrierAccountService.create — faqat HQ kuryeri (courier_not_hq)', () => {
  const rpcError = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return (
        e as {
          getError: () => {
            statusCode: number;
            message: string;
            data: unknown;
          };
        }
      ).getError();
    }
    throw new Error('RpcException kutilgan edi');
  };

  it('⭐ HQ kuryeri — yaratiladi; filial tizim so‘rovchisi bilan so‘raladi', async () => {
    const repo = makeRepo();
    const { svc, branchClient } = makeService(repo);

    const res = (await svc.create({ name: 'BTS', courier_id: '55' })) as {
      statusCode: number;
    };

    expect(res.statusCode).toBe(201);
    expect(branchClient.send).toHaveBeenCalledWith(
      { cmd: 'branch.user.find_by_user' },
      expect.objectContaining({
        user_id: '55',
        requester: { id: 'system', roles: ['superadmin'] },
      }),
    );
    // Filial turi javobda bor — branch.find_hq ga bormaydi.
    expect(branchClient.send).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'boshqa filial kuryeri',
      {
        ...HQ_ASSIGNMENT,
        branch_id: '10',
        branch: { id: '10', type: 'REGIONAL' },
      },
      '10',
    ],
    ['filialga biriktirilmagan', null, null],
    ['HQ’da, lekin roli MANAGER', { ...HQ_ASSIGNMENT, role: 'MANAGER' }, '1'],
  ])(
    '⭐ %s — 400 courier_not_hq, hech narsa saqlanmaydi',
    async (_label, assignment, branchId) => {
      const repo = makeRepo();
      const { svc, activityLog } = makeService(repo, [ACTIVE_COURIER], {
        assignment,
      });

      const error = await rpcError(svc.create({ name: 'X', courier_id: '55' }));

      expect(error.statusCode).toBe(400);
      expect(error.message).toBe(
        "Tashqi yetkazuvchiga faqat HQ'da ochilgan kuryer bog'lanadi — bu kuryer HQ'da emas",
      );
      expect(error.data).toEqual({
        reason: 'courier_not_hq',
        details: { courier_id: '55', branch_id: branchId },
      });
      expect(repo.save).not.toHaveBeenCalled();
      expect(activityLog.log).not.toHaveBeenCalled();
    },
  );

  it('HQ tekshiruvi mavjud akkaunt 409 dan OLDIN (HQ’dan tashqari kuryer — aniq sabab)', async () => {
    const repo = makeRepo({
      findOne: jest.fn(() => Promise.resolve({ id: '2', name: 'Eski' })),
    });
    const { svc } = makeService(repo, [ACTIVE_COURIER], {
      assignment: { ...HQ_ASSIGNMENT, branch: { id: '1', type: 'REGIONAL' } },
    });

    expect(await rpcStatus(svc.create({ name: 'X', courier_id: '55' }))).toBe(
      400,
    );
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('filial turi javobda yo‘q — branch.find_hq bilan solishtiriladi', async () => {
    const noType = { ...HQ_ASSIGNMENT, branch: null };

    const ok = makeService(makeRepo(), [ACTIVE_COURIER], {
      assignment: noType,
      hq: { id: '1' },
    });
    await expect(
      ok.svc.create({ name: 'X', courier_id: '55' }),
    ).resolves.toMatchObject({ statusCode: 201 });
    expect(ok.branchClient.send).toHaveBeenCalledWith(
      { cmd: 'branch.find_hq' },
      expect.anything(),
    );

    const other = makeService(makeRepo(), [ACTIVE_COURIER], {
      assignment: noType,
      hq: { id: '7' },
    });
    expect(
      await rpcStatus(other.svc.create({ name: 'X', courier_id: '55' })),
    ).toBe(400);

    const hqDown = makeService(makeRepo(), [ACTIVE_COURIER], {
      assignment: noType,
      hqError: new Error('timeout'),
    });
    expect(
      await rpcStatus(hqDown.svc.create({ name: 'X', courier_id: '55' })),
    ).toBe(503);
  });

  it('⭐ branch-service javob bermadi — 503 (400 EMAS), hech narsa saqlanmaydi', async () => {
    const repo = makeRepo();
    const { svc } = makeService(repo, [ACTIVE_COURIER], {
      error: new Error('connection closed'),
    });

    const error = await rpcError(svc.create({ name: 'X', courier_id: '55' }));

    expect(error.statusCode).toBe(503);
    expect(error.message).toBe(
      "Filial xizmati javob bermadi — kuryer HQ'da ekanini tekshirib bo'lmadi. Birozdan so'ng qayta urinib ko'ring",
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('identity rad etgan kuryer uchun filialga bormaydi (ketma-ket)', async () => {
    const { svc, branchClient } = makeService(makeRepo(), [
      { ...ACTIVE_COURIER, role: 'manager' },
    ]);
    expect(await rpcStatus(svc.create({ name: 'X', courier_id: '55' }))).toBe(
      400,
    );
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it('⭐ eski (HQ’dan tashqari) akkaunt: rotateKey / setActive / validateKey avvalgidek — filial tekshirilmaydi', async () => {
    const legacy = {
      assignment: { ...HQ_ASSIGNMENT, branch: { id: '10', type: 'REGIONAL' } },
    };
    const repo = makeRepo({ findOne: jest.fn(() => Promise.resolve(ROW())) });
    const { svc, branchClient } = makeService(repo, [ACTIVE_COURIER], legacy);

    await expect(svc.rotateKey('11')).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(svc.setActive('11', true)).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(svc.setActive('11', false)).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(svc.validateKey('elc_k')).resolves.toMatchObject({
      courier_active: true,
    });
    expect(branchClient.send).not.toHaveBeenCalled();
  });
});

describe('CarrierAccountService.findByCourierIds (integration.carrier.find_by_courier_ids)', () => {
  it('⭐ faqat {courier_user_id, name, is_active}; o‘chirilmaganlar; id’lar takrorsiz', async () => {
    const repo = makeRepo({
      find: jest.fn(() =>
        Promise.resolve([
          {
            ...ROW(),
            courier_user_id: '55',
            is_active: true,
          },
          {
            ...ROW(),
            id: '12',
            name: 'Kargo',
            courier_user_id: '77',
            is_active: false,
          },
        ]),
      ),
    });
    const { svc } = makeService(repo);

    const res = (await svc.findByCourierIds(['55', 77, '55'])) as {
      statusCode: number;
      data: unknown[];
    };

    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual([
      { courier_user_id: '55', name: 'BTS', is_active: true },
      { courier_user_id: '77', name: 'Kargo', is_active: false },
    ]);
    // Kalit hash'i, IP, akkaunt id'si, yashirin ruxsat — javobda YO'Q.
    for (const row of res.data) {
      expect(Object.keys(row as object).sort()).toEqual([
        'courier_user_id',
        'is_active',
        'name',
      ]);
    }
    const [query] = repo.find.mock.calls[0] as [
      { where: Record<string, unknown>; select: Record<string, unknown> },
    ];
    expect(query.where.isDeleted).toBe(false);
    expect(query.select).toEqual({
      courier_user_id: true,
      name: true,
      is_active: true,
    });
    const inOperator = query.where.courier_user_id as { value: unknown };
    expect(inOperator.value).toEqual(['55', '77']);
  });

  it('bo‘sh ro‘yxat — bazaga bormaydi; massiv emas / yaroqsiz id / 500 dan ko‘p — 400', async () => {
    const repo = makeRepo();
    const { svc } = makeService(repo);

    await expect(svc.findByCourierIds([])).resolves.toMatchObject({
      data: [],
    });
    expect(repo.find).not.toHaveBeenCalled();
    expect(await rpcStatus(svc.findByCourierIds('55'))).toBe(400);
    expect(await rpcStatus(svc.findByCourierIds(['abc']))).toBe(400);
    expect(await rpcStatus(svc.findByCourierIds(['0']))).toBe(400);
    expect(
      await rpcStatus(
        svc.findByCourierIds(
          Array.from({ length: 501 }, (_, i) => String(i + 1)),
        ),
      ),
    ).toBe(400);
    expect(repo.find).not.toHaveBeenCalled();
  });
});
