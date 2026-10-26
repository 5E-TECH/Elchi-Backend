import { of } from 'rxjs';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import type { RequesterContext } from './contracts/user.payloads';

/**
 * (Elchi Pochta #3) Ilgari `refresh_token = null` bo'lgan HAR joy endi
 * foydalanuvchining BARCHA sessiyalarini yopadi: `session_epoch` AYNI
 * `users.save()` da oshadi (atomar), eski ustun ham tozalanadi. Epoch'ni
 * refresh va ro'yxat qanday ishlatishi — `auth/auth.sessions.spec.ts`.
 *
 * Qo'shimcha: bloklash (status → inactive) va o'chirish ham sessiyalarni
 * yopadi (blokdan chiqarilganda eski qurilma o'z-o'zidan qaytib kirmaydi).
 * Sessiyaga aloqasi yo'q tahrir epoch'ga tegmaydi.
 */

type Row = Record<string, unknown> & { id: string };

const OLD_HASH = 'f'.repeat(64);

function makeHarness(rows: Row[]) {
  const store = new Map<string, Row>(rows.map((row) => [row.id, { ...row }]));
  const saves: Row[] = [];
  const repo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      if (typeof where.id === 'string') {
        const row = store.get(where.id);
        if (!row || row.isDeleted !== false) return Promise.resolve(null);
        if (where.role && row.role !== where.role) return Promise.resolve(null);
        return Promise.resolve(row);
      }
      // ensurePhoneUnique — band emas.
      return Promise.resolve(null);
    }),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn((value: Row) => {
      saves.push({ ...value });
      store.set(value.id, { ...value });
      return Promise.resolve({ ...value });
    }),
  };
  const client = {
    send: jest.fn(() => of({ statusCode: 200, data: null })),
    emit: jest.fn(),
  };
  const service = new UserServiceService(
    repo as never,
    client as never, // search
    client as never, // catalog
    client as never, // order
    client as never, // logistics
    client as never, // finance
    client as never, // branch
    {
      encrypt: jest.fn((value: string) => Promise.resolve(`hashed:${value}`)),
      compare: jest.fn(),
    } as never,
    { get: jest.fn() } as never,
    {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    } as never,
  );
  return { service, saves, store };
}

const row = (id: string, role: Roles, extra: Partial<Row> = {}): Row => ({
  id,
  role,
  name: `TEST ${id}`,
  phone_number: `+9989000000${id}`,
  username: null,
  password: 'old-hash',
  refresh_token: OLD_HASH,
  session_epoch: 4,
  status: Status.ACTIVE,
  isDeleted: false,
  ...extra,
});

const SUPERADMIN: RequesterContext = { id: '1', roles: ['superadmin'] };

const revokedAll = { refresh_token: null, session_epoch: 5 };
const untouched = { refresh_token: OLD_HASH, session_epoch: 4 };

describe('Elchi Pochta #3 — xavfsizlik hodisasi BARCHA sessiyalarni yopadi', () => {
  it.each([
    ['admin parolni tiklaydi', { password: 'Yangi-Parol-2026' }],
    ['telefon (login) almashadi', { phone_number: '+998901112233' }],
    ['bloklash (status inactive)', { status: Status.INACTIVE }],
  ])('⭐ updateUser — %s', async (_label, dto) => {
    const h = makeHarness([row('25', Roles.COURIER)]);
    await h.service.updateUser('25', dto as never, SUPERADMIN);
    expect(h.saves.at(-1)).toEqual(expect.objectContaining(revokedAll));
  });

  // (2026-10-23) Sessiyalar servisi (AuthSessionService) BO'LMASA — zaxira
  // xulq: epoch oshadi, joriy qurilma ham qayta kiradi. Servis bilan o'z
  // paroli joriy sessiyani saqlaydi, qolganlarini darhol yopadi —
  // `auth/auth.sessions.spec.ts` («parol almashtirish …» bloki).
  it('o‘z parolini almashtirish, sessiyalar servisisiz (zaxira) — hammasi, joriy ham', async () => {
    const h = makeHarness([row('10', Roles.ADMIN)]);
    await h.service.updateUser(
      '10',
      { password: 'Yangi-Parol-2026' } as never,
      {
        id: '10',
        roles: ['admin'],
      },
    );
    expect(h.saves.at(-1)).toEqual(expect.objectContaining(revokedAll));
  });

  it('sessiyaga aloqasi yo‘q tahrir (ism, o‘sha telefon, status active) — epoch o‘zgarmaydi', async () => {
    const h = makeHarness([row('25', Roles.COURIER)]);
    await h.service.updateUser(
      '25',
      {
        name: 'Boshqa ism',
        phone_number: '+998900000025',
        status: Status.ACTIVE,
      } as never,
      SUPERADMIN,
    );
    expect(h.saves.at(-1)).toEqual(expect.objectContaining(untouched));
  });

  it('setUserStatus inactive — yopadi; active — tegmaydi', async () => {
    const h = makeHarness([row('25', Roles.COURIER)]);
    await h.service.setUserStatus('25', Status.INACTIVE, SUPERADMIN);
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ status: Status.INACTIVE, ...revokedAll }),
    );

    await h.service.setUserStatus('25', Status.ACTIVE, SUPERADMIN);
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ status: Status.ACTIVE, session_epoch: 5 }),
    );
  });

  it('rol almashadi (changeUserRole) — yopadi', async () => {
    const h = makeHarness([row('10', Roles.REGISTRATOR)]);
    await h.service.changeUserRole('10', 'manager', SUPERADMIN);
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ role: Roles.MANAGER, ...revokedAll }),
    );
  });

  it('deleteUser — yopadi', async () => {
    const h = makeHarness([row('11', Roles.ADMIN)]);
    await h.service.deleteUser('11', SUPERADMIN);
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ isDeleted: true, ...revokedAll }),
    );
  });

  it.each([
    ['parol', { password: 'Yangi-Parol-2026' }],
    ['telefon', { phone_number: '+998901112244' }],
    ['bloklash', { status: Status.INACTIVE }],
  ])('updateMarket — %s yopadi', async (_label, dto) => {
    const h = makeHarness([row('37', Roles.MARKET)]);
    await h.service.updateMarket('37', dto as never, SUPERADMIN);
    expect(h.saves.at(-1)).toEqual(expect.objectContaining(revokedAll));
  });

  it('updateMarket — sozlama (add_order) sessiyaga tegmaydi', async () => {
    const h = makeHarness([row('37', Roles.MARKET)]);
    await h.service.updateMarket(
      '37',
      { add_order: true } as never,
      SUPERADMIN,
    );
    expect(h.saves.at(-1)).toEqual(expect.objectContaining(untouched));
  });

  it('deleteMarket — yopadi', async () => {
    const h = makeHarness([row('37', Roles.MARKET)]);
    await h.service.deleteMarket('37');
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ isDeleted: true, ...revokedAll }),
    );
  });

  it('deleteMarketOperator — yopadi', async () => {
    const h = makeHarness([
      row('40', Roles.MARKET_OPERATOR, { market_id: '37' }),
    ]);
    await h.service.deleteMarketOperator('40', '37', {
      id: '37',
      roles: ['market'],
    });
    expect(h.saves.at(-1)).toEqual(
      expect.objectContaining({ isDeleted: true, ...revokedAll }),
    );
  });

  it('javoblarda session_epoch (va refresh_token) chiqmaydi', async () => {
    const h = makeHarness([row('25', Roles.COURIER)]);
    const res = (await h.service.updateUser(
      '25',
      { name: 'X' } as never,
      SUPERADMIN,
    )) as { data: Record<string, unknown> };
    expect(res.data).not.toHaveProperty('session_epoch');
    expect(res.data).not.toHaveProperty('refresh_token');
    expect(res.data).not.toHaveProperty('password');
  });
});
