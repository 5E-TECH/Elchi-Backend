import { Test, TestingModule } from '@nestjs/testing';
import { of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';

/**
 * FIX3 (A7) — CODE-08 / C11: GET /markets rolga qarab qisqaradi.
 * Faqat SUPERADMIN/ADMIN to'liq market qatorini va kassa balansini oladi;
 * filial xodimi tanlash ro'yxati uchun {id, name, phone_number, status},
 * kuryer esa {id, name, status} oladi.
 */
describe('FIX3 A7 — GET /markets maydonlari rolga qarab', () => {
  let controller: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let financeClient: { send: jest.Mock };

  const fullMarket = (id: string) => ({
    id,
    name: `Market ${id}`,
    phone_number: `+99890000000${id}`,
    username: `market_${id}`,
    address: 'Toshkent',
    tariff_home: 30000,
    tariff_center: 20000,
    default_tariff: 'center',
    telegram_id: '1234',
    settings: { theme: 'dark' },
    status: 'active',
    role: 'market',
  });

  const listResponse = () => ({
    statusCode: 200,
    data: {
      items: [fullMarket('5'), fullMarket('7')],
      meta: { total: 2, page: 1, limit: 100, totalPages: 1 },
    },
  });

  const user = (roles: string[]) => ({
    user: { sub: '99', username: 'u', roles },
  });

  beforeEach(async () => {
    identityClient = { send: jest.fn(() => of(listResponse())) };
    financeClient = {
      send: jest.fn(() => of({ data: { id: 'cb', balance: 125000 } })),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: identityClient },
        { provide: 'FINANCE', useValue: financeClient },
        { provide: 'BRANCH', useValue: { send: jest.fn(() => of({})) } },
      ],
    }).compile();

    controller = app.get(ApiGatewayController);
  });

  it.each([['superadmin'], ['admin']])(
    '%s: to‘liq qator va kassa (o‘zgarmagan)',
    async (role) => {
      const res = await controller.getMarkets(
        user([role]),
        undefined,
        'active',
      );

      expect(res.data.items).toHaveLength(2);
      expect(res.data.items[0]).toEqual(
        expect.objectContaining({
          ...fullMarket('5'),
          cashbox: expect.anything(),
        }),
      );
      expect(financeClient.send).toHaveBeenCalledTimes(2);
    },
  );

  it.each([['manager'], ['registrator'], ['branch']])(
    "%s: {id, name, status, phone_number} + tariflar (yiFTzkzH) — login, kassa yo'q",
    async (role) => {
      const res = await controller.getMarkets(
        user([role]),
        'mar',
        'active',
        '1',
        '20',
      );

      const tariffs = {
        tariff_home: 30000,
        tariff_center: 20000,
        default_tariff: 'center',
      };
      expect(res.data.items).toEqual([
        {
          id: '5',
          name: 'Market 5',
          status: 'active',
          phone_number: '+998900000005',
          ...tariffs,
        },
        {
          id: '7',
          name: 'Market 7',
          status: 'active',
          phone_number: '+998900000007',
          ...tariffs,
        },
      ]);
      expect(JSON.stringify(res.data.items)).not.toMatch(
        /username|telegram_id|settings|cashbox|address/,
      );
      expect(res.data.meta).toEqual({
        total: 2,
        page: 1,
        limit: 100,
        totalPages: 1,
      });
      expect(financeClient.send).not.toHaveBeenCalled();
      // Filtrlar identity'ga o'zgarishsiz boradi.
      expect(identityClient.send).toHaveBeenCalledWith(
        { cmd: 'identity.market.find_all' },
        { query: { search: 'mar', status: 'active', page: 1, limit: 20 } },
      );
    },
  );

  it("yiFTzkzH: filial xodimi — tarif maydoni yo'q market'da null (undefined emas)", async () => {
    identityClient.send.mockReturnValueOnce(
      of({
        statusCode: 200,
        data: {
          items: [{ id: '9', name: 'Yangi', status: 'active' }],
          meta: { total: 1 },
        },
      }),
    );

    const res = await controller.getMarkets(user(['manager']));

    expect(res.data.items).toEqual([
      {
        id: '9',
        name: 'Yangi',
        status: 'active',
        phone_number: null,
        tariff_home: null,
        tariff_center: null,
        default_tariff: null,
      },
    ]);
  });

  it("courier: faqat {id, name, status} — telefon ham yo'q", async () => {
    const res = await controller.getMarkets(
      user(['courier']),
      undefined,
      'active',
    );

    expect(res.data.items).toEqual([
      { id: '5', name: 'Market 5', status: 'active' },
      { id: '7', name: 'Market 7', status: 'active' },
    ]);
    // yiFTzkzH: tariflar faqat filial xodimiga — kuryerga emas.
    expect(JSON.stringify(res.data.items)).not.toMatch(/tariff/);
    expect(financeClient.send).not.toHaveBeenCalled();
  });

  it("noma'lum/bo'sh rol — eng qisqa ko'rinish (fail-closed)", async () => {
    const res = await controller.getMarkets(user([]), undefined, undefined);

    expect(Object.keys(res.data.items[0]).sort()).toEqual([
      'id',
      'name',
      'status',
    ]);
  });

  it("bo'sh ro'yxat — javob o'zgarishsiz", async () => {
    const empty = { statusCode: 200, data: { items: [], meta: { total: 0 } } };
    identityClient.send.mockReturnValueOnce(of(empty));

    const res = await controller.getMarkets(user(['courier']));

    expect(res).toBe(empty);
  });
});
