import { RpcException } from '@nestjs/microservices';
import { In } from 'typeorm';
import { defer, of, throwError, type Observable } from 'rxjs';
import { ActivityAction, Roles, Status } from '@app/common';
import {
  LOGIST_DELETE_RELEASE_FAILED,
  UserServiceService,
} from './user-service.service';
import { IdentityController } from './identity.controller';
import type { RequesterContext } from './contracts/user.payloads';

/**
 * (dzyVftBx) Identity tomonida LOGIST roli:
 *
 * - `identity.logist.create` (POST /logists) — admin naqshi, faqat
 *   SUPERADMIN/ADMIN;
 * - `identity.logist.find_by_ids` — logistics viloyatga biriktirishdan oldin
 *   (faqat o'chirilmagan LOGIST qatorlari);
 * - TC4: logist o'chirilganda AVVAL `logistics.region.clear_logist`
 *   (regions.logist_id = NULL), keyin soft-delete. Bo'shatib bo'lmasa —
 *   503, logist o'chirilmaydi (fail-closed).
 */
type Row = Record<string, unknown> & { id: string; role: Roles };
type SendHandler = (
  pattern: { cmd: string },
  payload: unknown,
) => Observable<unknown>;

const userRow = (
  role: Roles,
  overrides: Record<string, unknown> = {},
): Row => ({
  id: '42',
  role,
  name: 'Shaxriyor',
  phone_number: '+998903333334',
  username: null,
  password: 'hash',
  refresh_token: 'rt',
  status: Status.ACTIVE,
  isDeleted: false,
  ...overrides,
});

function makeService(
  rows: Row[] = [],
  logisticsSend: SendHandler = () => of({ statusCode: 200 }),
) {
  const byId = new Map<string, Row>(rows.map((row) => [row.id, { ...row }]));
  const events: string[] = [];
  const repo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      if ('phone_number' in where) {
        return Promise.resolve(null);
      }
      const row = byId.get(String(where.id));
      return Promise.resolve(row && row.isDeleted === false ? row : null);
    }),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn((value: Record<string, unknown>) => {
      events.push('user:save');
      const saved = { id: '501', ...value } as Row;
      byId.set(saved.id, { ...saved });
      return Promise.resolve({ ...saved });
    }),
  };
  const makeClient = (reply: unknown) => ({
    send: jest.fn(() => of(reply)),
    emit: jest.fn(),
  });
  const logisticsClient = {
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      events.push(`logistics:${pattern.cmd}`);
      return logisticsSend(pattern, payload);
    }),
    emit: jest.fn(),
  };
  const branchClient = makeClient({ data: null });
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const service = new UserServiceService(
    repo as never,
    makeClient({ ok: true }) as never, // search
    makeClient({ statusCode: 200 }) as never, // catalog
    makeClient({ data: null }) as never, // order
    logisticsClient as never, // logistics
    makeClient({ data: null }) as never, // finance
    branchClient as never, // branch
    {
      encrypt: jest.fn().mockResolvedValue('hashed-pw'),
      compare: jest.fn(),
    } as never,
    { get: jest.fn() } as never,
    activityLog as never,
  );
  return {
    service,
    repo,
    byId,
    events,
    logisticsClient,
    branchClient,
    activityLog,
  };
}

async function expectRpcStatus(promise: Promise<unknown>, status: number) {
  try {
    await promise;
    throw new Error('Expected RpcException');
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    const payload = (error as RpcException).getError() as {
      statusCode?: number;
      message?: string;
    };
    expect(payload.statusCode).toBe(status);
    return payload;
  }
}

const superadmin: RequesterContext = { id: '1', roles: ['superadmin'] };
const admin: RequesterContext = { id: '2', roles: ['admin'] };

const createDto = {
  name: 'Shaxriyor',
  phone_number: '+998903333334',
  password: 'secret1',
  salary: 4_000_000,
  payment_day: 10,
};

describe('(dzyVftBx) Roles.LOGIST', () => {
  it("enum qiymati 'logist' (DB enum'i 1716000000060 migratsiyasida)", () => {
    expect(Roles.LOGIST).toBe('logist');
  });

  it('GET /logists filtri: role=logist 400 bermaydi (enum filtrida bor)', async () => {
    const { service } = makeService();
    const qb: Record<string, jest.Mock> = {};
    for (const method of ['where', 'andWhere', 'orderBy', 'skip', 'take']) {
      qb[method] = jest.fn(() => qb);
    }
    qb.clone = jest.fn(() => qb);
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
    qb.getCount = jest.fn().mockResolvedValue(0);
    (service as any).users.createQueryBuilder = jest.fn(() => qb);

    const res: any = await service.findAllAdmins({ role: 'logist' });

    expect(res.statusCode).toBe(200);
    expect(qb.andWhere).toHaveBeenCalledWith('admin.role = :role', {
      role: Roles.LOGIST,
    });
  });
});

describe('(dzyVftBx) identity.logist.create — POST /logists', () => {
  it.each([
    ['superadmin', superadmin],
    ['admin', admin],
  ])(
    '%s — logist yaratiladi (role logist, faol, created_by)',
    async (_l, requester) => {
      const ctx = makeService();

      const res: any = await ctx.service.createLogist(
        { ...createDto },
        requester,
      );

      expect(res.statusCode).toBe(201);
      expect(res.message).toBe('Logist yaratildi');
      expect(ctx.repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Shaxriyor',
          phone_number: '+998903333334',
          password: 'hashed-pw',
          salary: 4_000_000,
          payment_day: 10,
          role: Roles.LOGIST,
          status: Status.ACTIVE,
          created_by: requester.id,
          isDeleted: false,
        }),
      );
      // Parol hash'i va refresh token javobga chiqmaydi.
      expect(res.data.password).toBeUndefined();
      expect(res.data.refresh_token).toBeUndefined();
      expect(ctx.activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'User',
          action: ActivityAction.CREATED,
          new_value: expect.objectContaining({ role: Roles.LOGIST }),
        }),
      );
    },
  );

  it('logist filial xodimi emas: branch_id bo‘lsa ham filialga biriktirilmaydi', async () => {
    const ctx = makeService();

    await ctx.service.createLogist(
      { ...createDto, branch_id: '3' },
      superadmin,
    );

    expect(ctx.branchClient.send).not.toHaveBeenCalled();
  });

  it.each([
    ['manager', { id: '7', roles: ['manager'] }],
    ['registrator', { id: '8', roles: ['registrator'] }],
    ['logist', { id: '9', roles: ['logist'] }],
    ['market', { id: '10', roles: ['market'] }],
  ])('%s — 403, user yaratilmaydi', async (_l, requester) => {
    const ctx = makeService();

    await expectRpcStatus(
      ctx.service.createLogist({ ...createDto }, requester),
      403,
    );
    expect(ctx.repo.save).not.toHaveBeenCalled();
  });

  it('band telefon raqam — 409', async () => {
    const ctx = makeService();
    ctx.repo.findOne.mockResolvedValueOnce({ id: '77' });

    await expectRpcStatus(
      ctx.service.createLogist({ ...createDto }, superadmin),
      409,
    );
    expect(ctx.repo.save).not.toHaveBeenCalled();
  });
});

describe('(dzyVftBx) identity.logist.find_by_ids', () => {
  it('faqat o‘chirilmagan LOGIST qatorlari, sanitize qilingan', async () => {
    const ctx = makeService();
    ctx.repo.find.mockResolvedValueOnce([userRow(Roles.LOGIST)]);

    const res: any = await ctx.service.findLogistsByIds(['42', 42, '42']);

    expect(ctx.repo.find).toHaveBeenCalledWith({
      where: { id: In(['42']), role: Roles.LOGIST, isDeleted: false },
    });
    expect(res.data).toEqual([
      expect.objectContaining({
        id: '42',
        role: Roles.LOGIST,
        status: 'active',
      }),
    ]);
    expect(res.data[0].password).toBeUndefined();
  });

  it.each([
    ['bo‘sh', []],
    ['massiv emas', '42'],
    ['buzuq id lar', ['abc', '1.5', '99999999999999999999', null]],
  ])('%s — DB so‘rovi yo‘q, bo‘sh ro‘yxat', async (_l, ids) => {
    const ctx = makeService();

    const res: any = await ctx.service.findLogistsByIds(ids);

    expect(res.data).toEqual([]);
    expect(ctx.repo.find).not.toHaveBeenCalled();
  });

  it('RPC controller find_by_ids va create ni servisga uzatadi', async () => {
    const userService = {
      findLogistsByIds: jest.fn().mockResolvedValue({ data: [] }),
      createLogist: jest.fn().mockResolvedValue({ statusCode: 201 }),
    };
    const controller = new IdentityController(
      { ack: jest.fn(), nackForError: jest.fn() } as any,
      userService as any,
      {} as any,
      {} as any,
    );
    const context = { getPattern: () => 'x' } as any;

    await controller.getLogistsByIds({ ids: ['42'] }, context);
    await controller.createLogist(
      { dto: createDto as any, requester: admin },
      context,
    );

    expect(userService.findLogistsByIds).toHaveBeenCalledWith(['42']);
    expect(userService.createLogist).toHaveBeenCalledWith(createDto, admin);
  });
});

describe('(dzyVftBx) TC4 — logist o‘chirilganda viloyatlari bo‘shatiladi', () => {
  it('⭐ clear_logist soft-delete dan OLDIN chaqiriladi; logist soft-delete bo‘ladi', async () => {
    const ctx = makeService([userRow(Roles.LOGIST)]);

    const res: any = await ctx.service.deleteUser('42', superadmin);

    expect(res.statusCode).toBe(200);
    expect(ctx.logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.region.clear_logist' },
      { logist_id: '42', requester: superadmin },
    );
    expect(ctx.events).toEqual([
      'logistics:logistics.region.clear_logist',
      'user:save',
    ]);
    expect(ctx.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '42',
        isDeleted: true,
        status: Status.INACTIVE,
      }),
    );
  });

  it('logistics rad etsa / xato bersa → 503, logist O‘CHIRILMAYDI', async () => {
    const ctx = makeService([userRow(Roles.LOGIST)], () =>
      throwError(() => ({ statusCode: 500, message: 'db down' })),
    );

    const err = await expectRpcStatus(
      ctx.service.deleteUser('42', superadmin),
      503,
    );

    expect(err.message).toBe(LOGIST_DELETE_RELEASE_FAILED);
    expect(ctx.repo.save).not.toHaveBeenCalled();
    expect(ctx.byId.get('42')?.isDeleted).toBe(false);
    expect(ctx.activityLog.log).not.toHaveBeenCalled();
  });

  it('vaqtinchalik xato — bitta qayta urinish (qadam idempotent)', async () => {
    let attempt = 0;
    // ClientProxy.send sovuq observable: rmqSend qayta obuna bo'lganda xabar
    // qayta yuboriladi — `defer` shuni takrorlaydi.
    const ctx = makeService([userRow(Roles.LOGIST)], () =>
      defer(() => {
        attempt += 1;
        return attempt === 1
          ? throwError(() => new Error('transient'))
          : of({ statusCode: 200 });
      }),
    );

    const res: any = await ctx.service.deleteUser('42', admin);

    expect(res.statusCode).toBe(200);
    expect(attempt).toBe(2);
    expect(ctx.repo.save).toHaveBeenCalledTimes(1);
  });

  it.each([Roles.ADMIN, Roles.REGISTRATOR, Roles.MARKET])(
    '%s o‘chirilganda clear_logist chaqirilmaydi',
    async (role) => {
      const ctx = makeService([userRow(role)]);

      await ctx.service.deleteUser('42', superadmin);

      expect(ctx.logisticsClient.send).not.toHaveBeenCalledWith(
        { cmd: 'logistics.region.clear_logist' },
        expect.anything(),
      );
    },
  );

  it('logist bloklansa (status inactive) viloyatlari saqlanadi — faqat o‘chirish bo‘shatadi', async () => {
    const ctx = makeService([userRow(Roles.LOGIST)]);

    await ctx.service.setUserStatus('42', Status.INACTIVE, superadmin);

    expect(ctx.logisticsClient.send).not.toHaveBeenCalled();
  });
});
