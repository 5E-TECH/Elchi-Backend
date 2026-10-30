import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * YEThmZBn — kuryerning filiali va tumani:
 *   (a) GET /users/:id (gateway `include_branch`) kuryer/menejer filialini
 *       `branch: { id, name } | null` bilan qaytaradi (ilgari faqat `region`);
 *       ichki `identity.user.find_by_id` (flagsiz) o'zgarmagan.
 *   (b) PATCH /users/:id `district_id` qabul qilinadi: mavjud tuman, foydalanuvchi
 *       viloyatiga tegishli; boshqa viloyat / yo'q tuman — 400; `null` — tozalash.
 */
type Row = Record<string, unknown>;

const SUPERADMIN = { id: '1', roles: [Roles.SUPERADMIN] };

const courierRow = (over: Row = {}): Row => ({
  id: '26',
  role: Roles.COURIER,
  name: 'TEST Claude Kuryer',
  phone_number: '+998887009102',
  status: Status.ACTIVE,
  isDeleted: false,
  region_id: '3',
  district_id: null,
  created_by: null,
  password: 'hash',
  refresh_token: 'rt',
  ...over,
});

type Reply = (payload: Row) => unknown;

function makeService(
  target: Row,
  replies: { branch?: Reply; district?: Reply } = {},
) {
  const saved: Row[] = [];
  const calls: Array<{ cmd: string; payload: Row }> = [];
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const send = (pattern: { cmd: string }, payload: Row) => {
    calls.push({ cmd: pattern.cmd, payload });
    const reply =
      pattern.cmd === 'branch.user.find_by_user'
        ? replies.branch
        : pattern.cmd === 'logistics.district.find_by_id'
          ? replies.district
          : pattern.cmd === 'logistics.region.find_by_id'
            ? () => ({ data: { id: '3', name: 'Andijon' } })
            : undefined;
    if (!reply) {
      return of({ data: null });
    }
    try {
      return of(reply(payload));
    } catch (error: unknown) {
      return throwError(() => error);
    }
  };
  const service = Object.create(UserServiceService.prototype) as Row &
    UserServiceService;
  Object.assign(service, {
    users: {
      findOne: jest.fn(() => Promise.resolve({ ...target })),
      save: jest.fn((row: Row) => {
        saved.push({ ...row });
        return Promise.resolve(row);
      }),
    },
    branchClient: { send: jest.fn(send) },
    logisticsClient: { send: jest.fn(send) },
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    activityLog,
    syncUserToSearch: jest.fn().mockResolvedValue(undefined),
  });
  return { service, saved, calls, activityLog };
}

const rpcError = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
};

const assignment = (branch: Row | null) => ({
  data: {
    id: '900',
    user_id: '26',
    branch_id: '15',
    role: 'COURIER',
    branch,
  },
});

describe('YEThmZBn (a) — GET /users/:id kuryer filiali', () => {
  it('⭐ include_branch: kuryer javobida branch { id, name } (va region)', async () => {
    const { service, calls } = makeService(courierRow(), {
      branch: () =>
        assignment({ id: '15', name: 'Samarqand filiali', type: 'REGIONAL' }),
    });

    const res = (await service.findUserById('26', {
      includeBranch: true,
    })) as { data: Row };

    expect(res.data).toMatchObject({
      id: '26',
      region: { id: '3', name: 'Andijon' },
      branch: { id: '15', name: 'Samarqand filiali' },
    });
    expect(res.data.branch).toStrictEqual({
      id: '15',
      name: 'Samarqand filiali',
    });
    expect(res.data).not.toHaveProperty('password');
    // Filial kuryerning o'z nomidan so'raladi (branch-service self-scope).
    expect(calls).toContainEqual({
      cmd: 'branch.user.find_by_user',
      payload: {
        user_id: '26',
        requester: { id: '26', roles: ['courier'] },
      },
    });
  });

  it('biriktirish yo`q yoki filial o`chirilgan — branch: null', async () => {
    const none = makeService(courierRow(), { branch: () => ({ data: null }) });
    const deleted = makeService(courierRow(), {
      branch: () => assignment(null),
    });

    const a = (await none.service.findUserById('26', {
      includeBranch: true,
    })) as { data: Row };
    const b = (await deleted.service.findUserById('26', {
      includeBranch: true,
    })) as { data: Row };

    expect(a.data.branch).toBeNull();
    expect(b.data.branch).toBeNull();
  });

  it('filial xizmati javob bermasa ham 200 — branch: null', async () => {
    const { service } = makeService(courierRow(), {
      branch: () => {
        throw new Error('timeout');
      },
    });

    const res = (await service.findUserById('26', {
      includeBranch: true,
    })) as { statusCode: number; data: Row };

    expect(res.statusCode).toBe(200);
    expect(res.data.branch).toBeNull();
  });

  it('market — filial so`ralmaydi, branch: null', async () => {
    const { service, calls } = makeService(
      courierRow({ role: Roles.MARKET, region_id: null }),
    );

    const res = (await service.findUserById('26', {
      includeBranch: true,
    })) as { data: Row };

    expect(res.data.branch).toBeNull();
    expect(calls.map((c) => c.cmd)).not.toContain('branch.user.find_by_user');
  });

  it('ichki chaqiruv (flagsiz) o`zgarmagan: branch kaliti va filial so`rovi yo`q', async () => {
    const { service, calls } = makeService(courierRow(), {
      branch: () => assignment({ id: '15', name: 'Samarqand filiali' }),
    });

    const res = (await service.findUserById('26')) as { data: Row };

    expect(res.data).not.toHaveProperty('branch');
    expect(calls.map((c) => c.cmd)).not.toContain('branch.user.find_by_user');
  });
});

describe('YEThmZBn (b) — PATCH /users/:id district_id', () => {
  const andijonDistrict = () => ({
    data: { id: '41', name: 'Asaka', region_id: '3' },
  });

  it('⭐ viloyatdagi mavjud tuman saqlanadi (200), audit izida eski/yangi', async () => {
    const { service, saved, calls, activityLog } = makeService(courierRow(), {
      district: andijonDistrict,
    });

    const res = (await service.updateUser(
      '26',
      { district_id: '41' },
      SUPERADMIN as never,
    )) as { statusCode: number; data: Row };

    expect(res.statusCode).toBe(200);
    expect(res.data.district_id).toBe('41');
    expect(saved[0]).toMatchObject({ district_id: '41', region_id: '3' });
    expect(calls).toContainEqual({
      cmd: 'logistics.district.find_by_id',
      payload: { id: '41' },
    });
    const [[change]] = activityLog.logChange.mock.calls as Array<
      [{ old_value: Row; new_value: Row }]
    >;
    expect(change.old_value.district_id).toBeNull();
    expect(change.new_value.district_id).toBe('41');
  });

  it('boshqa viloyat tumani — 400, saqlanmaydi', async () => {
    const { service, saved } = makeService(courierRow(), {
      district: () => ({
        data: { id: '77', name: 'Chilonzor', region_id: '1' },
      }),
    });

    const err = await rpcError(
      service.updateUser('26', { district_id: '77' }, SUPERADMIN as never),
    );

    expect(err).toMatchObject({
      statusCode: 400,
      message: 'Tuman foydalanuvchining viloyatiga tegishli emas',
    });
    expect(saved).toEqual([]);
  });

  it('yo`q tuman (logistics 404) — 400 «Tuman topilmadi»', async () => {
    const { service, saved } = makeService(courierRow(), {
      district: () => {
        // RMQ klienti xatoni `{ statusCode, message }` shaklida qaytaradi.
        throw Object.assign(new Error('Tuman topilmadi'), {
          statusCode: 404,
        });
      },
    });

    const err = await rpcError(
      service.updateUser('26', { district_id: '999' }, SUPERADMIN as never),
    );

    expect(err).toMatchObject({ statusCode: 400, message: 'Tuman topilmadi' });
    expect(saved).toEqual([]);
  });

  it('logistika javob bermasa — 503, saqlanmaydi', async () => {
    const { service, saved } = makeService(courierRow(), {
      district: () => {
        throw new Error('Timeout has occurred');
      },
    });

    const err = await rpcError(
      service.updateUser('26', { district_id: '41' }, SUPERADMIN as never),
    );

    expect(err.statusCode).toBe(503);
    expect(saved).toEqual([]);
  });

  it('raqamli bo`lmagan id — 400 (RMQ da ValidationPipe yo`q)', async () => {
    const { service, calls } = makeService(courierRow());

    const err = await rpcError(
      service.updateUser(
        '26',
        { district_id: 'abc' } as never,
        SUPERADMIN as never,
      ),
    );

    expect(err.statusCode).toBe(400);
    expect(calls.map((c) => c.cmd)).not.toContain(
      'logistics.district.find_by_id',
    );
  });

  it('null — tuman tozalanadi (logistics so`ralmaydi)', async () => {
    const { service, saved, calls } = makeService(
      courierRow({ district_id: '41' }),
    );

    await service.updateUser('26', { district_id: null }, SUPERADMIN as never);

    expect(saved[0]).toMatchObject({ district_id: null });
    expect(calls.map((c) => c.cmd)).not.toContain(
      'logistics.district.find_by_id',
    );
  });

  it('viloyati yo`q foydalanuvchi (mijoz) — faqat mavjudligi tekshiriladi', async () => {
    const { service, saved } = makeService(
      courierRow({ role: Roles.CUSTOMER, region_id: null }),
      { district: () => ({ data: { id: '77', region_id: '1' } }) },
    );

    await service.updateUser('26', { district_id: '77' }, SUPERADMIN as never);

    expect(saved[0]).toMatchObject({ district_id: '77', region_id: null });
  });

  it('district_id yuborilmasa tuman o`zgarmaydi', async () => {
    const { service, saved, calls } = makeService(
      courierRow({ district_id: '41' }),
    );

    await service.updateUser('26', { name: 'Yangi ism' }, SUPERADMIN as never);

    expect(saved[0]).toMatchObject({ name: 'Yangi ism', district_id: '41' });
    expect(calls.map((c) => c.cmd)).not.toContain(
      'logistics.district.find_by_id',
    );
  });
});
