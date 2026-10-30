import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Roles, Status } from '@app/common';
import { ContactsService } from './contacts.service';

/**
 * T7 (QPq2C1co) — identity `ContactsService` (mock repozitoriylar; to'liq
 * DB xulqi — `contacts.pg.spec.ts`).
 */
type Row = Record<string, unknown>;

const user = (over: Row) => ({
  isDeleted: false,
  status: Status.ACTIVE,
  name: 'Xodim',
  phone_number: '+998900000000',
  ...over,
});

function build(opts: {
  users?: Row[];
  settings?: { support?: string[]; defaultId?: string | null };
  regions?: Row[];
  districts?: Row[];
}) {
  const all = opts.users ?? [];
  const usersRepo = {
    find: jest.fn(({ where }: { where: { id: { _value: string[] } } }) =>
      Promise.resolve(
        all.filter(
          (u) => where.id._value.includes(String(u.id)) && !u.isDeleted,
        ),
      ),
    ),
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        all.find(
          (u) =>
            String(u.id) === String(where.id) &&
            (where.role === undefined || u.role === where.role),
        ) ?? null,
      ),
    ),
    manager: { getRepository: () => usersRepo },
  };
  const settingsRows = [
    {
      key: 'contacts.support_phones',
      value: opts.settings?.support ?? [],
      updated_at: new Date('2026-10-30T09:00:00Z'),
      updated_by: null,
    },
    {
      key: 'contacts.default_market_responsible_id',
      value: opts.settings?.defaultId ?? null,
      updated_at: new Date('2026-10-30T08:00:00Z'),
      updated_by: null,
    },
  ];
  const settingsRepo = { find: jest.fn(() => Promise.resolve(settingsRows)) };
  const settings = {
    manager: { getRepository: () => settingsRepo },
  };
  const logistics = {
    send: jest.fn((pattern: { cmd: string }, payload: { ids: string[] }) =>
      of({
        data: (pattern.cmd === 'logistics.region.find_by_ids'
          ? (opts.regions ?? [])
          : (opts.districts ?? [])
        ).filter((row) => payload.ids.includes(String(row.id))),
      }),
    ),
  };
  const service = new ContactsService(
    usersRepo as never,
    settings as never,
    { find: jest.fn(() => Promise.resolve([])) } as never,
    logistics as never,
    { send: jest.fn(() => of({ data: null })) } as never,
    { log: jest.fn() } as never,
  );
  return { service, usersRepo, logistics };
}

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode?: number;
      code?: string;
    };
  }
  throw new Error('RpcException kutilgandi');
}

describe('T7 — ContactsService (identity)', () => {
  it('⭐ QM5: registrator / menejer → 403 (sozlamalar, mas`ullar, biriktirish)', async () => {
    const { service } = build({});
    for (const requester of [
      { id: '5', roles: ['registrator'] },
      { id: '6', roles: ['manager'] },
      undefined,
    ]) {
      expect(await rpcError(service.getSettings(requester))).toEqual(
        expect.objectContaining({ statusCode: 403 }),
      );
      expect(await rpcError(service.listResponsibles('', requester))).toEqual(
        expect.objectContaining({ statusCode: 403 }),
      );
      expect(
        await rpcError(
          service.bulkAssign(
            { responsible_id: null, market_ids: ['1'] },
            requester,
          ),
        ),
      ).toEqual(expect.objectContaining({ statusCode: 403 }));
      expect(await rpcError(service.assignOne('1', null, requester))).toEqual(
        expect.objectContaining({ statusCode: 403 }),
      );
    }
  });

  it('⭐ QM6: support_phones ["123"] / 3 ta → SUPPORT_PHONES_INVALID; kuryer → RESPONSIBLE_ROLE_INVALID', async () => {
    const { service } = build({
      users: [user({ id: '7', role: Roles.COURIER })],
    });
    const sa = { id: '1', roles: ['superadmin'] };
    expect(
      await rpcError(service.updateSettings({ support_phones: ['123'] }, sa)),
    ).toEqual({
      statusCode: 400,
      message: expect.any(String),
      data: null,
      code: 'SUPPORT_PHONES_INVALID',
    });
    expect(
      await rpcError(
        service.updateSettings(
          {
            support_phones: ['+998901112233', '+998901112234', '+998901112235'],
          },
          sa,
        ),
      ),
    ).toEqual(expect.objectContaining({ code: 'SUPPORT_PHONES_INVALID' }));
    expect(
      await rpcError(
        service.updateSettings({ default_market_responsible_id: '7' }, sa),
      ),
    ).toEqual(
      expect.objectContaining({
        statusCode: 400,
        code: 'RESPONSIBLE_ROLE_INVALID',
      }),
    );
    expect(await rpcError(service.updateSettings({}, sa))).toEqual(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('rezolver: faol biriktirilgan → faol sukut → none; nofaol o`tkazib yuboriladi', async () => {
    const { service } = build({
      users: [
        user({ id: '10', role: Roles.REGISTRATOR }),
        user({ id: '11', role: Roles.ADMIN, status: Status.INACTIVE }),
        user({ id: '12', role: Roles.LOGIST }),
      ],
      settings: { defaultId: '12' },
    });
    const views = await service.resolveMarketResponsibles([
      { id: '1', market_responsible_id: '10' },
      { id: '2', market_responsible_id: '11' },
      { id: '3', market_responsible_id: null },
    ] as never);
    expect(views.get('1')).toEqual({
      responsible: {
        id: '10',
        name: 'Xodim',
        phone_number: '+998900000000',
        role: 'registrator',
      },
      responsible_source: 'assigned',
    });
    expect(views.get('2')?.responsible_source).toBe('default');
    expect(views.get('2')?.responsible?.id).toBe('12');
    expect(views.get('3')?.responsible_source).toBe('default');

    const noDefault = build({
      users: [user({ id: '11', role: Roles.ADMIN, status: Status.INACTIVE })],
    });
    const none = await noDefault.service.resolveMarketResponsibles([
      { id: '2', market_responsible_id: '11' },
    ] as never);
    expect(none.get('2')).toEqual({
      responsible: null,
      responsible_source: 'none',
    });
  });

  it('⭐ QM1/QM2 + N+1 yo`q: ko`p viloyat — 1 ta logistics RPC + 1 ta users IN so`rovi', async () => {
    const { service, usersRepo, logistics } = build({
      users: [
        user({ id: '50', role: Roles.LOGIST, phone_number: '+998901112233' }),
        user({ id: '51', role: Roles.LOGIST, status: Status.INACTIVE }),
      ],
      settings: { support: ['+998712001122'] },
      regions: [
        { id: '1', name: 'Andijon', logist_id: '50' },
        { id: '2', name: 'Namangan', logist_id: '51' },
        { id: '3', name: 'Farg`ona', logist_id: null },
      ],
    });
    const res: any = await service.problemContacts({
      region_ids: ['1', '2', '3', '1'],
    });
    expect(res.data.regions).toEqual({
      '1': [{ name: 'Xodim', phone: '+998901112233', source: 'logist' }],
      '2': [{ name: null, phone: '+998712001122', source: 'support' }],
      '3': [{ name: null, phone: '+998712001122', source: 'support' }],
    });
    expect(res.data.fallback).toEqual([
      { name: null, phone: '+998712001122', source: 'support' },
    ]);
    // Tuman yo'q — district RPC chaqirilmaydi; viloyatlar bitta RPC'da.
    expect(logistics.send).toHaveBeenCalledTimes(1);
    expect(usersRepo.find).toHaveBeenCalledTimes(1);
  });

  it('zaxira ham bo`sh — problem_contacts []', async () => {
    const { service } = build({
      regions: [{ id: '3', name: 'X', logist_id: null }],
    });
    const res: any = await service.problemContacts({ region_ids: ['3'] });
    expect(res.data.regions['3']).toEqual([]);
    expect(res.data.fallback).toEqual([]);
  });

  it('⭐ QM4: admin → kind none; boshqa noma`lum foydalanuvchi → 404', async () => {
    const { service } = build({
      users: [user({ id: '9', role: Roles.ADMIN })],
    });
    expect(((await service.myContacts('9')) as any).data).toEqual({
      kind: 'none',
      source: null,
      regions: [],
      contacts: [],
    });
    expect(await rpcError(service.myContacts('404'))).toEqual(
      expect.objectContaining({ statusCode: 404 }),
    );
  });
});

/**
 * T7 #10 — mas'ul yozuv tranzaksiyasi ICHIDA `FOR SHARE` bilan qayta
 * tekshiriladi: oldindan tekshiruvdan keyin o'chirilgan / roli o'zgargan
 * xodim biriktirilmaydi va hech narsa yozilmaydi.
 */
describe('T7 — tranzaksiya ichidagi qayta tekshiruv (FOR SHARE)', () => {
  const SA = { id: '1', roles: ['superadmin'] };
  const market = { id: '37', role: Roles.MARKET, isDeleted: false };
  const before = user({ id: '15', role: Roles.ADMIN });

  /** Tranzaksiyadagi (lock bilan) o'qish `inTx` ni qaytaradi. */
  function racing(inTx: Row | null) {
    const writes: string[] = [];
    const lockedReads: Row[] = [];
    const findOne = jest.fn(
      ({ where, lock }: { where: Row; lock?: { mode: string } }) => {
        if (lock) {
          lockedReads.push(lock);
          return Promise.resolve(inTx);
        }
        if (String(where.id) === '37') return Promise.resolve(market);
        return Promise.resolve(before);
      },
    );
    const userRepo = {
      findOne,
      find: jest.fn(() => Promise.resolve([before])),
      update: jest.fn(() => {
        writes.push('admins');
        return Promise.resolve();
      }),
    };
    const settingRepo = { find: jest.fn(() => Promise.resolve([])) };
    const tx = {
      getRepository: (entity: { name: string }) =>
        entity.name === 'AppSetting' ? settingRepo : userRepo,
      query: jest.fn((sql: string) => {
        writes.push(sql.includes('app_settings') ? 'app_settings' : 'admins');
        return Promise.resolve([{ id: '37', role: 'market' }]);
      }),
    };
    const manager = {
      getRepository: tx.getRepository,
      transaction: (cb: (m: typeof tx) => Promise<unknown>) => cb(tx),
    };
    const service = new ContactsService(
      { ...userRepo, manager } as never,
      { manager } as never,
      { find: jest.fn() } as never,
      { send: jest.fn() } as never,
      { send: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    return { service, writes, lockedReads };
  }

  it.each([
    ['o`chirilgan', null, 404, undefined],
    [
      'roli menejerga o`zgargan',
      user({ id: '15', role: Roles.MANAGER }),
      400,
      'RESPONSIBLE_ROLE_INVALID',
    ],
  ])(
    'assignOne / updateSettings / bulkAssign: %s → xato, yozuv yo`q',
    async (_label, inTx, statusCode, code) => {
      for (const call of [
        (s: ContactsService) => s.assignOne('37', '15', SA),
        (s: ContactsService) =>
          s.updateSettings({ default_market_responsible_id: '15' }, SA),
        (s: ContactsService) =>
          s.bulkAssign({ responsible_id: '15', market_ids: ['37'] }, SA),
      ]) {
        const { service, writes, lockedReads } = racing(inTx);
        const error = await rpcError(call(service));
        expect(error.statusCode).toBe(statusCode);
        expect(error.code).toBe(code);
        expect(lockedReads).toEqual([{ mode: 'pessimistic_read' }]);
        expect(writes).toEqual([]);
      }
    },
  );
});
