import { of } from 'rxjs';
import { OrderServiceService } from './order-service.service';
import {
  computeSaleMarketPaidMax,
  computeSaleMarketPaymentLimit,
} from './domain/order-money';

/**
 * uguUEhin — kuryer sotish oynasidagi «Marketga to'langan summa» chegarasi.
 *
 * 2026-10-19 prod testi: kutilayotgan buyurtmada `to_be_paid` 0 (u sotuvda
 * hisoblanadi), kuryer ro'yxatida market tarifi ham yo'q — oyna doim
 * «0 so'mdan oshmasin» deb, to'g'ri summani (№73: 5 000, haqiqiy chegara
 * 30 000) xato deb ko'rsatardi. Endi buyurtma javobida `sale_market_paid_max`
 * — sotuv formulasi bilan AYNI chegara (qo'shimcha xarajatdan oldin).
 */
describe('computeSaleMarketPaidMax (uguUEhin)', () => {
  const base = {
    totalPrice: 50000,
    paidOnlineAmount: 0,
    paidAmount: 0,
    marketTariffSnapshot: null,
    isCenter: true,
    centerTariff: 20000,
    homeTariff: 25000,
  };

  it('⭐ №73 holati: 50 000 − markaz tarifi 20 000 = 30 000', () => {
    expect(computeSaleMarketPaidMax(base)).toBe(30000);
  });

  it('uyga yetkazish — uy tarifi', () => {
    expect(computeSaleMarketPaidMax({ ...base, isCenter: false })).toBe(25000);
  });

  it('buyurtmadagi tarif snapshot`i profildan ustun', () => {
    expect(
      computeSaleMarketPaidMax({ ...base, marketTariffSnapshot: 15000 }),
    ).toBe(35000);
  });

  it('onlayn to`langan qism naqddan ayiriladi; naqd tarifdan kam — 0', () => {
    expect(computeSaleMarketPaidMax({ ...base, paidOnlineAmount: 20000 })).toBe(
      10000,
    );
    expect(computeSaleMarketPaidMax({ ...base, paidOnlineAmount: 50000 })).toBe(
      0,
    );
  });

  it('allaqachon to`langan qism ayiriladi va manfiy bo`lmaydi', () => {
    expect(computeSaleMarketPaidMax({ ...base, paidAmount: 10000 })).toBe(
      20000,
    );
    expect(computeSaleMarketPaidMax({ ...base, paidAmount: 999999 })).toBe(0);
  });

  it('tarifni aniqlab bo`lmasa (snapshot ham, profil ham yo`q) — null', () => {
    expect(
      computeSaleMarketPaidMax({
        ...base,
        centerTariff: null,
        homeTariff: undefined,
      }),
    ).toBeNull();
  });

  it('sotuvning o`z chegarasi bilan AYNI (qo`shimcha xarajat 0, kassa cheklamaganda)', () => {
    for (const [total, online, paid, tariff] of [
      [50000, 0, 0, 20000],
      [120000, 30000, 5000, 25000],
      [10000, 0, 0, 20000],
    ]) {
      const preview = computeSaleMarketPaidMax({
        ...base,
        totalPrice: total,
        paidOnlineAmount: online,
        paidAmount: paid,
        marketTariffSnapshot: tariff,
      });
      const collectible = total - online;
      const net = Math.max(collectible - tariff, 0);
      const atSale = computeSaleMarketPaymentLimit({
        collectible,
        marketTariff: tariff,
        extraCost: 0,
        currentPaid: Math.min(paid, net),
        marketBalanceBefore: 1_000_000_000,
      });
      expect(preview).toBe(atSale);
    }
  });
});

describe('enrichOrders — sale_market_paid_max (uguUEhin)', () => {
  type Pattern = { cmd: string };
  const ROWS = [
    // Kutilayotgan, markaz — profil tarifi (20 000).
    {
      id: '73',
      market_id: '37',
      status: 'waiting',
      where_deliver: 'center',
      total_price: 50000,
      paid_online_amount: 0,
      paid_amount: 0,
      market_tariff: null,
    },
    // Kutilayotgan, uy — snapshot tarif ustun.
    {
      id: '74',
      market_id: '37',
      status: 'waiting',
      where_deliver: 'address',
      total_price: 40000,
      paid_online_amount: 0,
      paid_amount: 0,
      market_tariff: 15000,
    },
    // Sotilgan — maydon kerak emas (haqiqiy to_be_paid bor).
    {
      id: '72',
      market_id: '37',
      status: 'sold',
      where_deliver: 'center',
      total_price: 50000,
      paid_online_amount: 0,
      paid_amount: 0,
      market_tariff: 20000,
      to_be_paid: 30000,
    },
    // Kutilayotgan, market profili topilmadi va snapshot yo'q — null.
    {
      id: '90',
      market_id: '999',
      status: 'waiting',
      where_deliver: 'center',
      total_price: 50000,
      paid_online_amount: 0,
      paid_amount: 0,
      market_tariff: null,
    },
  ].map((row) => ({
    customer_id: null,
    district_id: null,
    region_id: null,
    courier_id: null,
    post_id: null,
    items: [],
    ...row,
  }));

  const build = () => {
    const respond = (pattern: Pattern, payload: { ids?: string[] }) => {
      const ids = payload?.ids ?? [];
      if (pattern.cmd === 'identity.market.find_by_ids') {
        return of({
          data: ids
            .filter((id) => id === '37')
            .map((id) => ({
              id,
              name: 'TEST Claude Market',
              tariff_center: 20000,
              tariff_home: 25000,
            })),
        });
      }
      return of({ data: [] });
    };
    const client = () => ({ send: jest.fn(respond) });
    const service = Object.create(
      OrderServiceService.prototype,
    ) as OrderServiceService;
    Object.assign(service, {
      identityClient: client(),
      logisticsClient: client(),
      catalogClient: client(),
      dataSource: { query: jest.fn().mockResolvedValue([]) },
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    });
    jest.spyOn(service, 'findAll').mockResolvedValue({
      data: ROWS,
      total: ROWS.length,
      page: 1,
      limit: 20,
      total_pages: 1,
      totalPages: 1,
    } as never);
    return service;
  };

  it('⭐ kutilayotgan buyurtmada sotuv chegarasi, boshqa holatlarda null', async () => {
    const res = await build().findAllEnriched({});
    const byId = new Map(
      (res.data as unknown as Array<Record<string, unknown>>).map((row) => [
        String(row.id),
        row.sale_market_paid_max,
      ]),
    );
    expect(byId.get('73')).toBe(30000);
    expect(byId.get('74')).toBe(25000);
    expect(byId.get('72')).toBeNull();
    expect(byId.get('90')).toBeNull();
  });
});
