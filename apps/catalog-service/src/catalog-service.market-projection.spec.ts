import { of } from 'rxjs';
import { CatalogServiceService } from './catalog-service.service';

/**
 * 5hfCZgu5 — mahsulot javobiga yopishtiriladigan `market` faqat oq ro'yxat:
 * {id, name, phone_number, status}. Ilgari identity'ning to'liq obyekti
 * (telegram tokeni, username, maosh, tariflar, komissiya) ketardi.
 */
const FULL_MARKET = {
  id: '3',
  name: 'Mobimax',
  phone_number: '+998998940999',
  status: 'active',
  role: 'market',
  username: 'mp1_3fb5e9554aba464e86292b337fbfaf61',
  salary: 0,
  payment_day: null,
  market_tg_token: 'group_token-secret',
  tariff_home: 25000,
  tariff_center: 15000,
  add_order: true,
  commission_type: 'percent',
  commission_value: 5,
  settings: { theme: 'dark' },
};
const SECRET =
  /market_tg_token|salary|commission_value|username|tariff_home|tariff_center|settings/;

const make = () => {
  const svc = Object.create(CatalogServiceService.prototype);
  svc.identityClient = {
    send: jest.fn((pattern: { cmd: string }) =>
      of(
        pattern.cmd === 'identity.market.find_by_ids'
          ? { data: [FULL_MARKET] }
          : { data: FULL_MARKET },
      ),
    ),
  };
  return svc;
};

describe('Mahsulot javobidagi market proyeksiyasi (5hfCZgu5)', () => {
  it('⭐ TC3/TC4: ro`yxat (attachMarkets) — faqat {id,name,phone_number,status}', async () => {
    const svc = make();
    const rows = await svc.attachMarkets([
      { id: '7', user_id: '3', name: 'Telefon' },
    ]);
    expect(rows[0].market).toEqual({
      id: '3',
      name: 'Mobimax',
      phone_number: '+998998940999',
      status: 'active',
    });
    expect(JSON.stringify(rows)).not.toMatch(SECRET);
  });

  it('⭐ TC4/TC5: bitta mahsulot (attachMarket) — sir maydonlar yo`q', async () => {
    const svc = make();
    const row = await svc.attachMarket({
      id: '7',
      user_id: '3',
      name: 'Telefon',
    });
    expect(Object.keys(row.market).sort()).toEqual([
      'id',
      'name',
      'phone_number',
      'status',
    ]);
    expect(JSON.stringify(row)).not.toMatch(SECRET);
  });

  it('identity javob bermasa — market null, mahsulot qaytadi', async () => {
    const svc = Object.create(CatalogServiceService.prototype);
    svc.identityClient = { send: jest.fn(() => of({ data: null })) };
    const row = await svc.attachMarket({ id: '7', user_id: '3' });
    expect(row.market).toBeNull();
  });
});
