import { RpcException } from '@nestjs/microservices';
import { Observable, of, throwError } from 'rxjs';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import type { RequesterContext } from './contracts/user.payloads';

/**
 * KQINMdeQ (ega, 2026-11-17) — menejer o'z filiali xodimlarini boshqaradi:
 * huquq nishonning HOZIRGI filiali bo'yicha (branch-service `branch_users`,
 * so'rov paytida `branch.user.find_by_user_ids`), `created_by` bo'yicha emas.
 *  - o'z filialidagi kuryer / ro'yxatchi — kim yaratganidan qat'i nazar
 *    (admin yaratgan, `created_by = NULL` eski yozuv ham) — ruxsat;
 *  - boshqa menejer (shu filialdagisi ham), admin, superadmin, market (o'zi
 *    yaratgani ham), operator, investor, logist — 403;
 *  - boshqa filialga o'tkazilgan xodim (menejer o'zi yaratgan bo'lsa ham) va
 *    boshqa filial foydalanuvchisi (IDOR) — 403;
 *  - filialga biriktirilmagan menejer va branch-service xatosi — 403
 *    (fail-closed);
 *  - o'chirish va holat oqimlari menejerga baribir 403.
 * Bu servis darajasi — `identity.user.update` RPC'si gateway'siz chaqirilsa
 * ham himoya ishlaydi (gateway'dagi tekshiruvning ikkinchi qavati).
 */

type Row = Record<string, unknown> & { id: string };

const MANAGER: RequesterContext = { id: '25', roles: ['manager'] };
const OWN_BRANCH = '3';
const OTHER_BRANCH = '4';

interface HarnessOptions {
  rows: Row[];
  /** user_id → hozirgi filial; funksiya — branch-service javobi (xato ham). */
  branches?: Record<string, string> | (() => Observable<unknown>);
}

function makeHarness(options: HarnessOptions) {
  const rows = new Map<string, Row>(
    options.rows.map((row) => [row.id, { ...row }]),
  );
  const saves: Record<string, unknown>[] = [];
  const repo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      if (typeof where.id === 'string') {
        const row = rows.get(where.id);
        if (!row || row.isDeleted !== false) return Promise.resolve(null);
        return Promise.resolve({ ...row });
      }
      return Promise.resolve(null);
    }),
    find: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => Promise.resolve(0)),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn((value: Record<string, unknown>) => {
      saves.push({ ...value });
      return Promise.resolve({ ...value });
    }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };

  const branchClient = {
    send: jest.fn(
      ({ cmd }: { cmd: string }, payload: { user_ids?: string[] }) => {
        if (cmd !== 'branch.user.find_by_user_ids') {
          return of({ data: null });
        }
        const branches = options.branches;
        if (typeof branches === 'function') return branches();
        return of({
          statusCode: 200,
          data: (payload.user_ids ?? []).map((id) => ({
            user_id: id,
            branch: branches?.[id] ? { id: branches[id], name: 'F' } : null,
          })),
        });
      },
    ),
    emit: jest.fn(),
  };
  const noopClient = { send: jest.fn(() => of({})), emit: jest.fn() };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  const service = new UserServiceService(
    repo as never,
    noopClient as never, // search
    noopClient as never, // catalog
    noopClient as never, // order
    noopClient as never, // logistics
    noopClient as never, // finance
    branchClient as never, // branch
    {
      encrypt: jest.fn((value: string) => Promise.resolve(`hashed:${value}`)),
      compare: jest.fn(),
    } as never,
    { get: jest.fn() } as never,
    activityLog as never,
  );
  jest
    .spyOn(
      (service as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    )
    .mockImplementation(() => undefined);

  return {
    service,
    saves,
    branchClient,
    activityLog,
    branchCalls: () =>
      branchClient.send.mock.calls.filter(
        ([p]) => p.cmd === 'branch.user.find_by_user_ids',
      ),
  };
}

async function rpcErrorOf(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
}

const user = (
  id: string,
  role: Roles,
  createdBy: string | null = null,
): Row => ({
  id,
  role,
  name: `User ${id}`,
  phone_number: `+99890000${id.padStart(4, '0')}`,
  password: 'old-hash',
  status: Status.ACTIVE,
  salary: 1_000_000,
  created_by: createdBy,
  isDeleted: false,
});

/** Menejer (25) va nishon bir filialda. */
const sameBranch = (targetId: string) => ({
  [MANAGER.id]: OWN_BRANCH,
  [targetId]: OWN_BRANCH,
});

describe('KQINMdeQ — identity updateUser: menejer huquqi hozirgi filial bo`yicha', () => {
  it('⭐ admin yaratgan kuryer menejer filialida — tahrirlanadi (maosh, holat, ism)', async () => {
    const h = makeHarness({
      rows: [user('101', Roles.COURIER, '1')],
      branches: sameBranch('101'),
    });

    const res = await h.service.updateUser(
      '101',
      { name: 'Yangi Ism', salary: 2_000_000 },
      MANAGER,
    );

    expect(res.statusCode).toBe(200);
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ name: 'Yangi Ism', salary: 2_000_000 }),
    );
    // Filial so'rov paytida, ikkala foydalanuvchi uchun bitta so'rov.
    expect(h.branchCalls()).toHaveLength(1);
    expect(h.branchCalls()[0][1]).toMatchObject({
      user_ids: ['25', '101'],
      requester: { id: '25', roles: ['manager'] },
    });
    // Faoliyat jurnali — menejer muallif sifatida.
    expect(h.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({ entity_id: '101' }),
    );
  });

  it.each([
    ['kuryer', Roles.COURIER],
    ['ro`yxatchi', Roles.REGISTRATOR],
  ])(
    '⭐ created_by = NULL eski %s menejer filialida — tahrirlanadi',
    async (_label, role) => {
      const h = makeHarness({
        rows: [user('102', role, null)],
        branches: sameBranch('102'),
      });

      const res = await h.service.updateUser(
        '102',
        { name: 'Eski Xodim' },
        MANAGER,
      );

      expect(res.statusCode).toBe(200);
      expect(h.saves).toHaveLength(1);
    },
  );

  it('boshqa menejer yaratgan ro`yxatchi shu filialda — tahrirlanadi', async () => {
    const h = makeHarness({
      rows: [user('103', Roles.REGISTRATOR, '26')],
      branches: sameBranch('103'),
    });

    await expect(
      h.service.updateUser('103', { name: 'Ro`yxatchi' }, MANAGER),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it('⭐ shu filialdagi boshqa menejer — 403, yozuv yo`q', async () => {
    const h = makeHarness({
      rows: [user('26', Roles.MANAGER, '1')],
      branches: sameBranch('26'),
    });

    const err = await rpcErrorOf(
      h.service.updateUser('26', { name: 'X' }, MANAGER),
    );

    expect(err.statusCode).toBe(403);
    expect(h.saves).toHaveLength(0);
  });

  it('⭐ menejer o`zi yaratib, boshqa filialga o`tkazilgan kuryer — 403', async () => {
    const h = makeHarness({
      rows: [user('263', Roles.COURIER, MANAGER.id)],
      branches: { [MANAGER.id]: OWN_BRANCH, '263': OTHER_BRANCH },
    });

    const err = await rpcErrorOf(
      h.service.updateUser(
        '263',
        { password: 'Yangi-Parol-2026' },
        {
          ...MANAGER,
        },
      ),
    );

    expect(err).toEqual(
      expect.objectContaining({
        statusCode: 403,
        message: 'Siz bu foydalanuvchini boshqara olmaysiz',
      }),
    );
    expect(h.saves).toHaveLength(0);
  });

  it('⭐ boshqa filial foydalanuvchisi (IDOR, filialsiz ham) — 403', async () => {
    const other = makeHarness({
      rows: [user('500', Roles.COURIER, '1')],
      branches: { [MANAGER.id]: OWN_BRANCH, '500': OTHER_BRANCH },
    });
    const unassigned = makeHarness({
      rows: [user('501', Roles.REGISTRATOR, MANAGER.id)],
      branches: { [MANAGER.id]: OWN_BRANCH },
    });

    expect(
      (
        await rpcErrorOf(
          other.service.updateUser('500', { name: 'X' }, MANAGER),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await rpcErrorOf(
          unassigned.service.updateUser('501', { name: 'X' }, MANAGER),
        )
      ).statusCode,
    ).toBe(403);
    expect(other.saves).toHaveLength(0);
    expect(unassigned.saves).toHaveLength(0);
  });

  it.each([
    ['admin', Roles.ADMIN],
    ['superadmin', Roles.SUPERADMIN],
    ['market (o`zi yaratgan)', Roles.MARKET],
    ['market operatori', Roles.MARKET_OPERATOR],
    ['investor', Roles.INVESTOR],
    ['logist', Roles.LOGIST],
  ])('%s — 403, filial so`ralmaydi', async (_label, role) => {
    const h = makeHarness({
      rows: [user('600', role, MANAGER.id)],
      branches: sameBranch('600'),
    });

    const err = await rpcErrorOf(
      h.service.updateUser('600', { name: 'X' }, MANAGER),
    );

    expect(err.statusCode).toBe(403);
    expect(h.saves).toHaveLength(0);
    expect(h.branchCalls()).toHaveLength(0);
  });

  it('filialga biriktirilmagan menejer — 403', async () => {
    const h = makeHarness({
      rows: [user('101', Roles.COURIER, MANAGER.id)],
      branches: { '101': OWN_BRANCH },
    });

    const err = await rpcErrorOf(
      h.service.updateUser('101', { name: 'X' }, MANAGER),
    );

    expect(err).toEqual(
      expect.objectContaining({
        statusCode: 403,
        message: 'Manager hech qaysi filialga biriktirilmagan',
      }),
    );
    expect(h.saves).toHaveLength(0);
  });

  it.each([
    ['xato (timeout)', () => throwError(() => new Error('timeout'))],
    ['RPC 403', () => throwError(() => new RpcException({ statusCode: 403 }))],
    ['data massiv emas', () => of({ statusCode: 200, data: null })],
  ])(
    '⭐ branch-service %s — fail-closed 403 (500 emas), yozuv yo`q',
    async (_label, reply) => {
      const h = makeHarness({
        rows: [user('101', Roles.COURIER, MANAGER.id)],
        branches: reply,
      });

      const err = await rpcErrorOf(
        h.service.updateUser('101', { name: 'X' }, MANAGER),
      );

      expect(err.statusCode).toBe(403);
      expect(h.saves).toHaveLength(0);
    },
  );

  it('menejer o`zini tahrirlaydi — filial so`ralmaydi', async () => {
    const h = makeHarness({ rows: [user(MANAGER.id, Roles.MANAGER, '1')] });

    await expect(
      h.service.updateUser(MANAGER.id, { name: 'Shodiyor' }, MANAGER),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(h.branchCalls()).toHaveLength(0);
  });

  it.each([
    ['superadmin', { id: '1', roles: ['superadmin'] }],
    ['admin', { id: '2', roles: ['admin'] }],
  ])(
    '%s — filial tekshiruvisiz (qoida o`zgarmagan)',
    async (_label, requester) => {
      const h = makeHarness({ rows: [user('101', Roles.COURIER, null)] });

      await expect(
        h.service.updateUser('101', { name: 'X' }, requester),
      ).resolves.toMatchObject({ statusCode: 200 });
      expect(h.branchCalls()).toHaveLength(0);
    },
  );

  it('o`chirish va holat oqimlari — o`z filiali kuryeri bo`lsa ham menejerga 403', async () => {
    const h = makeHarness({
      rows: [user('101', Roles.COURIER, MANAGER.id)],
      branches: sameBranch('101'),
    });

    const del = await rpcErrorOf(h.service.deleteUser('101', MANAGER));
    const status = await rpcErrorOf(
      h.service.setUserStatus('101', Status.INACTIVE, MANAGER),
    );

    expect(del.statusCode).toBe(403);
    expect(status.statusCode).toBe(403);
    expect(h.saves).toHaveLength(0);
  });
});

describe('KQINMdeQ — parol SMS (holat / qayta yuborish): tahrirlash bilan bir xil qoida', () => {
  it.each([
    ['admin yaratgan kuryer', Roles.COURIER],
    ['ro`yxatchi (4-savol sukuti)', Roles.REGISTRATOR],
  ])('⭐ o`z filialidagi %s — 200', async (_label, role) => {
    const h = makeHarness({
      rows: [user('101', role, '1')],
      branches: sameBranch('101'),
    });

    await expect(
      h.service.tempPasswordSmsStatus('101', MANAGER),
    ).resolves.toMatchObject({
      statusCode: 200,
      data: { user_id: '101' },
    });
  });

  it('⭐ o`zi yaratib, boshqa filialga o`tkazilgan kuryer — holat ham, qayta yuborish ham 403', async () => {
    const h = makeHarness({
      rows: [user('263', Roles.COURIER, MANAGER.id)],
      branches: { [MANAGER.id]: OWN_BRANCH, '263': OTHER_BRANCH },
    });

    expect(
      (await rpcErrorOf(h.service.tempPasswordSmsStatus('263', MANAGER)))
        .statusCode,
    ).toBe(403);
    expect(
      (await rpcErrorOf(h.service.resendTempPasswordSms('263', MANAGER)))
        .statusCode,
    ).toBe(403);
    expect(h.saves).toHaveLength(0);
  });

  it.each([
    ['boshqa menejer', Roles.MANAGER],
    ['admin', Roles.ADMIN],
    ['market', Roles.MARKET],
    ['logist', Roles.LOGIST],
  ])('%s — 403', async (_label, role) => {
    const h = makeHarness({
      rows: [user('600', role, MANAGER.id)],
      branches: sameBranch('600'),
    });

    expect(
      (await rpcErrorOf(h.service.tempPasswordSmsStatus('600', MANAGER)))
        .statusCode,
    ).toBe(403);
  });

  it('branch-service xatosi — 403', async () => {
    const h = makeHarness({
      rows: [user('101', Roles.COURIER, MANAGER.id)],
      branches: () => throwError(() => new Error('timeout')),
    });

    expect(
      (await rpcErrorOf(h.service.tempPasswordSmsStatus('101', MANAGER)))
        .statusCode,
    ).toBe(403);
  });
});
