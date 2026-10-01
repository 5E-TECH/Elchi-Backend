import { of } from 'rxjs';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * Item 4 — market_tg_token (marketning Telegram bot/guruh kaliti) umumiy RPC
 * javoblariga kirmaydi.
 *
 * Ilgari sanitize() faqat password va refresh_token'ni olib tashlardi, shuning
 * uchun market qatori tokeni bilan order/analytics/finance/catalog/branch
 * javoblariga ulanib, menejer, registrator, kuryer va boshqa marketlarga
 * yetib borardi. Endi token faqat identity.user.find_by_id'da, aniq
 * `includeTgToken: true` bilan va faqat market qatorida qaytadi (gateway uni
 * faqat SUPERADMIN/ADMIN GET /users/:id so'rovida yuboradi).
 */
const TOKEN = 'group_token-0123456789abcdef0123456789abcdef';
const SECRET_KEYS = ['password', 'refresh_token', 'market_tg_token'] as const;

type Row = Record<string, unknown> & { id: string; role: Roles };

const marketRow = (): Row => ({
  id: '3',
  role: Roles.MARKET,
  name: 'Yandex',
  phone_number: '+998900000001',
  username: 'yandex',
  region_id: null,
  district_id: null,
  password: '$2b$10$x',
  refresh_token: 'a'.repeat(64),
  market_tg_token: TOKEN,
  tariff_home: 25000,
  tariff_center: 20000,
  cancelled_handover_qr_required: true,
  status: Status.ACTIVE,
  isDeleted: false,
});

const courierRow = (): Row => ({
  id: '9',
  role: Roles.COURIER,
  name: 'Kuryer',
  phone_number: '+998900009911',
  username: null,
  region_id: null,
  district_id: null,
  password: '$2b$10$y',
  refresh_token: 'b'.repeat(64),
  // Xodim qatorida qolib ketgan eski qiymat — flag bilan ham chiqmasligi kerak.
  market_tg_token: 'group_token-ffffffffffffffffffffffffffffffff',
  status: Status.ACTIVE,
  isDeleted: false,
});

const customerRow = (): Row => ({
  id: '5',
  role: Roles.CUSTOMER,
  name: 'Ali',
  phone_number: '+998901234567',
  username: null,
  password: '$2b$10$z',
  refresh_token: null,
  market_tg_token: null,
  status: Status.ACTIVE,
  isDeleted: false,
});

function makeService() {
  const rows: Row[] = [marketRow(), courierRow(), customerRow()];

  // Ro'yxat so'rovlari: findAllMarkets/findAllAdmins market qatorini,
  // searchCustomers mijoz qatorini oladi.
  const qb: Record<string, unknown> = {};
  Object.assign(qb, {
    where: () => qb,
    andWhere: () => qb,
    orderBy: () => qb,
    skip: () => qb,
    take: () => qb,
    clone: () => qb,
    getManyAndCount: () => Promise.resolve([[marketRow()], 1]),
    getCount: () => Promise.resolve(1),
    getMany: () => Promise.resolve([customerRow()]),
  });

  const repo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      // Telefon/username noyobligi tekshiruvlari (id ham, token ham yo'q) —
      // hech narsa topilmaydi, yaratish yo'li davom etadi.
      if (where.id === undefined && where.market_tg_token === undefined) {
        return Promise.resolve(null);
      }
      const row = rows.find(
        (candidate) =>
          (where.id === undefined || candidate.id === where.id) &&
          (where.market_tg_token === undefined ||
            candidate.market_tg_token === where.market_tg_token) &&
          (where.role === undefined || candidate.role === where.role) &&
          candidate.isDeleted === false,
      );
      return Promise.resolve(row ?? null);
    }),
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.filter((row) => row.role === where.role)),
    ),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn((value: Record<string, unknown>) =>
      Promise.resolve({ id: '3', ...value }),
    ),
    createQueryBuilder: jest.fn(() => qb),
  };

  const makeClient = () => ({
    send: jest.fn(() => of({ data: {} })),
    emit: jest.fn(),
  });
  const searchClient = makeClient();
  const branchClient = makeClient();
  const financeClient = makeClient();
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  const service = new UserServiceService(
    repo as never,
    searchClient as never, // search
    makeClient() as never, // catalog
    makeClient() as never, // order
    makeClient() as never, // logistics
    financeClient as never, // finance
    branchClient as never, // branch
    {
      encrypt: jest.fn().mockResolvedValue('hashed'),
      compare: jest.fn(),
    } as never,
    { get: jest.fn() } as never,
    activityLog as never,
  );
  return { service, repo, searchClient, branchClient, financeClient };
}

/** Obyektda sir maydonlarning birortasi ham (kalit sifatida ham) yo'q. */
function expectNoSecrets(value: unknown) {
  for (const key of SECRET_KEYS) {
    expect(value).not.toHaveProperty(key);
  }
}

/** Butun javobda (ichma-ich obyektlarda ham) token va hash matni yo'q. */
function expectNoSecretValues(response: unknown) {
  const json = JSON.stringify(response);
  expect(json).not.toContain('group_token-');
  expect(json).not.toContain('$2b$10$');
}

describe('UserServiceService — market_tg_token va boshqa sirlar javobda yo‘q', () => {
  it('findMarketsByIds: sirlar yo‘q, order-service kerak qiladigan maydonlar joyida', async () => {
    const { service } = makeService();

    const res = await service.findMarketsByIds(['3']);

    expect(res.data).toHaveLength(1);
    expectNoSecrets(res.data[0]);
    expect(res.data[0]).toEqual(
      expect.objectContaining({
        id: '3',
        name: 'Yandex',
        tariff_home: 25000,
        cancelled_handover_qr_required: true,
      }),
    );
    expectNoSecretValues(res);
  });

  it('findMarketById: success, sirlar yo‘q', async () => {
    const { service } = makeService();

    const res = await service.findMarketById('3');

    expect(res.success).toBe(true);
    expectNoSecrets(res.data);
    expectNoSecretValues(res);
  });

  it('findAllMarkets: items[0] da sirlar yo‘q', async () => {
    const { service } = makeService();

    const res = await service.findAllMarkets({});

    expectNoSecrets(res.data.items[0]);
    expect(res.data.items[0]).toEqual(expect.objectContaining({ id: '3' }));
    expectNoSecretValues(res);
  });

  it('findAllAdmins (GET /users, superadmin ro‘yxati ham): items[0] da sirlar yo‘q', async () => {
    const { service } = makeService();

    const res = await service.findAllAdmins({});

    expectNoSecrets(res.data.items[0]);
    expectNoSecretValues(res);
  });

  it('findUserById (flagsiz): sirlar yo‘q, region null', async () => {
    const { service } = makeService();

    const res = await service.findUserById('3');

    expectNoSecrets(res.data);
    expect(res.data.region).toBeNull();
    expectNoSecretValues(res);
  });

  it('findUserById(includeTgToken: true) market uchun: token bor, password/refresh_token yo‘q', async () => {
    const { service } = makeService();

    const res = await service.findUserById('3', { includeTgToken: true });

    expect(res.data.market_tg_token).toBe(TOKEN);
    expect(res.data).not.toHaveProperty('password');
    expect(res.data).not.toHaveProperty('refresh_token');
  });

  it('findUserById(includeTgToken: true) kuryer uchun: eski token qiymati ham chiqmaydi (flag faqat market qatoriga)', async () => {
    const { service } = makeService();

    const res = await service.findUserById('9', { includeTgToken: true });

    expectNoSecrets(res.data);
    expectNoSecretValues(res);
  });

  it("findUserById: flag qat'iy — 'true' satri tokenni ochmaydi", async () => {
    const { service } = makeService();

    const res = await service.findUserById('3', {
      includeTgToken: 'true' as never,
    });

    expectNoSecrets(res.data);
  });

  it('findAdminById (sukut: flagsiz) tokenni qaytarmaydi', async () => {
    const { service } = makeService();

    const res = await service.findAdminById('3');

    expectNoSecrets(res.data);
  });

  it('findOwnProfile (market o‘z profili ham): sirlar yo‘q, branch null, branch RPC yo‘q', async () => {
    const { service, branchClient } = makeService();

    const res = await service.findOwnProfile('3');

    expectNoSecrets(res.data);
    expect(res.data.branch).toBeNull();
    expect(branchClient.send).not.toHaveBeenCalled();
    expectNoSecretValues(res);
  });

  it('findMarketByTelegramToken: market topiladi (id), javobda token yo‘q', async () => {
    const { service } = makeService();

    const res = await service.findMarketByTelegramToken(TOKEN);

    expect(res.data.id).toBe('3');
    expectNoSecrets(res.data);
    expectNoSecretValues(res);
  });

  it("rotateMarketTelegramToken: ichki kontrakt o'zgarmagan — yangi token qaytadi", async () => {
    const { service } = makeService();

    const res = await service.rotateMarketTelegramToken('3');

    expect(res.data.id).toBe('3');
    expect(res.data.market_tg_token).toMatch(/^group_token-[a-f0-9]{32}$/);
    expect(res.data.market_tg_token).not.toBe(TOKEN);
  });

  it("createMarket (HYBRID menejer, POST /markets): token yaratiladi, lekin javobda ham, search indeksida ham yo'q", async () => {
    const { service, repo, searchClient } = makeService();

    const res = await service.createMarket(
      {
        name: 'M',
        phone_number: '+998900000777',
        username: 'm777',
        password: 'x',
        tariff_home: 1,
        tariff_center: 1,
      } as never,
      { id: '19', roles: ['manager'] },
    );

    expect(res.statusCode).toBe(201);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        market_tg_token: expect.stringMatching(/^group_token-[a-f0-9]{32}$/),
      }),
    );
    expectNoSecrets(res.data);
    expectNoSecretValues(res);
    expect(searchClient.send).toHaveBeenCalledWith(
      { cmd: 'search.index.upsert' },
      expect.anything(),
    );
    expect(JSON.stringify(searchClient.send.mock.calls)).not.toContain(
      'group_token-',
    );
  });

  it('updateMarket: javobda sirlar yo‘q', async () => {
    const { service } = makeService();

    const res = await service.updateMarket('3', { add_order: true } as never);

    expectNoSecrets(res.data);
    expectNoSecretValues(res);
  });

  it('setUserStatus: javobda sirlar yo‘q', async () => {
    const { service } = makeService();

    const res = await service.setUserStatus('3', Status.INACTIVE, {
      id: '1',
      roles: ['superadmin'],
    });

    expectNoSecrets(res.data);
    expectNoSecretValues(res);
  });

  it('findCouriersByIds / findCustomersByIds / searchCustomers: sirlar yo‘q (regressiya)', async () => {
    const { service } = makeService();

    const couriers = await service.findCouriersByIds(['9']);
    const customers = await service.findCustomersByIds(['5']);
    const searched = await service.searchCustomers('Ali');

    expect(couriers.data).toHaveLength(1);
    expect(customers.data).toHaveLength(1);
    expect(searched.data).toHaveLength(1);
    for (const row of [couriers.data[0], customers.data[0], searched.data[0]]) {
      expectNoSecrets(row);
    }
    expectNoSecretValues([couriers, customers, searched]);
  });
});
