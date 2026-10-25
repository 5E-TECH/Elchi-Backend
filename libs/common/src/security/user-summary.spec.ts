import { toPublicUserSummary } from './user-summary';

describe('vf4513Zn — toPublicUserSummary', () => {
  it('faqat {id, name, role, phone_number} — tarif/maosh/komissiya/token tashlanadi', () => {
    expect(
      toPublicUserSummary({
        id: 37,
        name: ' TEST Claude Market ',
        role: 'market',
        phone_number: '+998900000037',
        tariff_home: 20_000,
        tariff_center: 20_000,
        default_tariff: 'center',
        salary: 0,
        payment_day: 1,
        commission_type: 'percent',
        commission_value: 5,
        compensation_mode: 'tariff',
        ai_price_per_order: 300,
        market_tg_token: 'secret',
        password: 'hash',
        refresh_token: 'rt',
      }),
    ).toEqual({
      id: '37',
      name: 'TEST Claude Market',
      role: 'market',
      phone_number: '+998900000037',
    });
  });

  it('yetishmagan maydonlar — null; id yozuvda bo`lmasa so`ralgan id', () => {
    expect(toPublicUserSummary({ name: '' }, '26')).toEqual({
      id: '26',
      name: null,
      role: null,
      phone_number: null,
    });
  });

  it.each([[null], [undefined], ['26'], [[{ id: '1' }]], [{ name: 'x' }]])(
    'obyekt bo`lmasa yoki id aniqlanmasa — null (%p)',
    (input) => {
      expect(toPublicUserSummary(input)).toBeNull();
    },
  );
});
