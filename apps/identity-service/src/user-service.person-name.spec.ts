import { of } from 'rxjs';
import { Roles, Status } from '@app/common';
import { RequesterContext } from './contracts/user.payloads';
import { UserServiceService } from './user-service.service';

/**
 * Ega qarori 2026-11-04: «ism so'ragan har qanday joyda birinchi harf katta —
 * kichik kiritsak ham». identity'da odam ismlari SAQLASHDA keltiriladi
 * (`normalizePersonName`): mijoz (POST /orders, bot, ai-confirm, hamkor,
 * import — hammasi `identity.customer.create` ga keladi; «Kartani ham
 * yangilash») va xodimlar (admin, registrator, logist, kuryer, menejer,
 * investor logini, market operatori, PATCH /users/:id). Market (biznes)
 * nomi O'ZGARMAYDI. Eski yozuvlar ko'chirilmaydi: o'zgarmagan ism tegilmaydi.
 */
type Row = Record<string, unknown>;

function makeHarness(rows: Row[] = []) {
  const saves: Row[] = [];
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && '_type' in value) {
        // TypeORM In(...) operatori.
        return (value as { _value: unknown[] })._value.includes(row[key]);
      }
      return row[key] === value;
    });
  const repo = {
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(rows.find((row) => matches(row, where)) ?? null),
    ),
    find: jest.fn(() => Promise.resolve([])),
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((value: Row) => {
      saves.push({ ...value });
      return Promise.resolve({ id: '700', ...value });
    }),
  };
  const ok = {
    send: jest.fn(() => of({ statusCode: 200, data: { id: '3' } })),
    emit: jest.fn(),
  };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const service = new UserServiceService(
    repo as never,
    ok as never, // search
    ok as never, // catalog
    ok as never, // order
    ok as never, // logistics
    ok as never, // finance
    ok as never, // branch
    {
      encrypt: jest.fn(() => Promise.resolve('hashed')),
      compare: jest.fn(() => Promise.resolve(false)),
    } as never,
    { get: jest.fn() } as never,
    activityLog as never,
  );
  return { service, saves, repo, activityLog };
}

const superadmin: RequesterContext = { id: '1', roles: [Roles.SUPERADMIN] };
const manual = { password_mode: 'manual', password: 'Secret123' };

describe('2026-11-04 — xodim ismi: bosh harflar katta', () => {
  it.each([
    ['createAdmin', {}],
    ['createRegistrator', {}],
    ['createLogist', {}],
    ['createManager', {}],
    ['createCourier', { region_id: '1', tariff_home: 1, tariff_center: 1 }],
  ] as const)('%s: «ali valiyev» → «Ali Valiyev»', async (method, extra) => {
    const t = makeHarness();
    await (t.service[method] as (dto: unknown, r: RequesterContext) => unknown)(
      {
        name: '  ali   valiyev ',
        phone_number: '+998935550001',
        ...manual,
        ...extra,
      },
      superadmin,
    );
    expect(t.saves[0]).toMatchObject({ name: 'Ali Valiyev' });
  });

  it('createInvestorUser: «o`tkir abdulla-ugli» → «O`tkir Abdulla-Ugli»', async () => {
    const t = makeHarness();
    await t.service.createInvestorUser(
      {
        name: "o'tkir abdulla-ugli",
        phone_number: '+998935550002',
        password: 'Secret123',
      },
      superadmin,
    );
    expect(t.saves[0]).toMatchObject({
      name: "O'tkir Abdulla-Ugli",
      role: Roles.INVESTOR,
    });
  });

  it('createMarketOperator: kirill «иван петров» → «Иван Петров»', async () => {
    const t = makeHarness([
      {
        id: '50',
        role: Roles.MARKET,
        status: Status.ACTIVE,
        isDeleted: false,
      },
    ]);
    const res = (await t.service.createMarketOperator(
      '50',
      {
        name: ' иван   петров',
        phone_number: '998935550003',
        password: 'Secret123',
      },
      { id: '50', roles: [Roles.MARKET] },
    )) as { data: Row };
    expect(t.saves[0]).toMatchObject({
      name: 'Иван Петров',
      role: Roles.MARKET_OPERATOR,
    });
    expect(res.data).toMatchObject({ name: 'Иван Петров' });
  });

  it('createMarket: market (biznes) nomi O`ZGARMAYDI', async () => {
    const t = makeHarness();
    await t.service.createMarket(
      {
        name: 'elchi market',
        phone_number: '+998935550004',
        username: 'elchi_market_test',
        ...manual,
      } as never,
      superadmin,
    );
    expect(t.saves[0]).toMatchObject({
      name: 'elchi market',
      role: Roles.MARKET,
    });
  });
});

describe('2026-11-04 — PATCH /users/:id (updateUser) ismi', () => {
  const user = (over: Row): Row => ({
    id: '80',
    phone_number: '+998935550010',
    status: Status.ACTIVE,
    isDeleted: false,
    created_by: null,
    session_epoch: 0,
    ...over,
  });

  it('kuryer: «ali valiyev» → «Ali Valiyev»', async () => {
    const t = makeHarness([user({ role: Roles.COURIER, name: 'Eski Ism' })]);
    await t.service.updateUser('80', { name: 'ali valiyev' }, superadmin);
    expect(t.saves[0]).toMatchObject({ name: 'Ali Valiyev' });
    const [change] = t.activityLog.logChange.mock.calls[0] as [
      { old_value: Row; new_value: Row },
    ];
    expect(change.old_value).toMatchObject({ name: 'Eski Ism' });
    expect(change.new_value).toMatchObject({ name: 'Ali Valiyev' });
  });

  it('market operatori ham odam: «vali» → «Vali»', async () => {
    const t = makeHarness([
      user({ role: Roles.MARKET_OPERATOR, name: 'Eski Ism' }),
    ]);
    await t.service.updateUser('80', { name: 'vali' }, superadmin);
    expect(t.saves[0]).toMatchObject({ name: 'Vali' });
  });

  it('market (biznes) nomi O`ZGARMAYDI', async () => {
    const t = makeHarness([user({ role: Roles.MARKET, name: 'Eski Market' })]);
    await t.service.updateUser('80', { name: 'yangi market' }, superadmin);
    expect(t.saves[0]).toMatchObject({ name: 'yangi market' });
  });

  it('eski filial hisobi (Roles.BRANCH) nomi — filial nomi, O`ZGARMAYDI', async () => {
    const t = makeHarness([user({ role: Roles.BRANCH, name: 'Eski Filial' })]);
    await t.service.updateUser('80', { name: 'andijon filiali' }, superadmin);
    expect(t.saves[0]).toMatchObject({ name: 'andijon filiali' });
  });

  it('o`zgarmagan eski (kichik harfli) ism tegilmaydi — ko`chirish yo`q', async () => {
    const t = makeHarness([user({ role: Roles.COURIER, name: 'eski ism' })]);
    await t.service.updateUser(
      '80',
      { name: 'eski ism', salary: 100 },
      superadmin,
    );
    expect(t.saves[0]).toMatchObject({ name: 'eski ism', salary: 100 });
  });
});

describe('2026-11-04 — mijoz ismi (identity.customer.create / update)', () => {
  const customer = (over: Row = {}): Row => ({
    id: '153',
    role: Roles.CUSTOMER,
    name: 'Eski Ism',
    phone_number: '+998901112233',
    district_id: '11',
    address: 'Eski manzil',
    extra_number: null,
    isDeleted: false,
    ...over,
  });

  it('yangi mijoz (forma, bot, ai-confirm, hamkor, import): «ali valiyev» → «Ali Valiyev»', async () => {
    const t = makeHarness();
    const res = (await t.service.createCustomer({
      name: 'ali valiyev',
      phone_number: '901112233',
      district_id: '11',
    })) as { statusCode: number; data: Row };
    expect(res.statusCode).toBe(201);
    expect(t.saves[0]).toMatchObject({
      name: 'Ali Valiyev',
      phone_number: '+998901112233',
    });
  });

  it('mavjud mijoz (sukut — bot / hamkor / import patch): yangi ism keltirib yoziladi', async () => {
    const t = makeHarness([customer()]);
    await t.service.createCustomer({
      name: 'yangi ism',
      phone_number: '+998901112233',
      district_id: '11',
    });
    expect(t.saves).toHaveLength(1);
    expect(t.saves[0]).toMatchObject({ name: 'Yangi Ism' });
  });

  it('mavjud mijoz: faqat harf katta-kichikligi farqi («eski ism» ↔ «Eski Ism») — saqlanmaydi', async () => {
    const t = makeHarness([customer()]);
    const res = (await t.service.createCustomer({
      name: 'eski ism',
      phone_number: '+998901112233',
      district_id: '11',
    })) as { statusCode: number };
    expect(t.saves).toHaveLength(0);
    expect(res.statusCode).toBe(200);
  });

  it('mavjud eski (kichik harfli) karta, ayni ism qayta kelsa — ko`chirilmaydi', async () => {
    const t = makeHarness([customer({ name: 'eski ism' })]);
    await t.service.createCustomer({
      name: 'eski ism',
      phone_number: '+998901112233',
      district_id: '11',
    });
    expect(t.saves).toHaveLength(0);
  });

  it('«Kartani ham yangilash»: «yangi ism» → «Yangi Ism», jurnalda ham keltirilgan', async () => {
    const t = makeHarness([customer()]);
    const res = (await t.service.updateCustomerCard(
      '153',
      { name: 'yangi ism', address: 'Eski manzil' },
      { orderId: '9001', marketId: '50' },
    )) as { data: { changed_fields: string[] } };
    expect(res.data.changed_fields).toEqual(['name']);
    expect(t.saves[0]).toMatchObject({ name: 'Yangi Ism' });
    expect(t.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: { name: 'Eski Ism' },
        new_value: { name: 'Yangi Ism' },
      }),
    );
  });

  it('«Kartani ham yangilash»: faqat keltirish farqi («eski ism») — o`zgarish yo`q', async () => {
    const t = makeHarness([customer()]);
    const res = (await t.service.updateCustomerCard('153', {
      name: 'eski ism',
    })) as { data: { changed_fields: string[] } };
    expect(res.data.changed_fields).toEqual([]);
    expect(t.saves).toHaveLength(0);
  });
});
