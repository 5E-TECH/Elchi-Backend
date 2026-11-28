import { of, throwError } from 'rxjs';
import {
  canonicalMarketId,
  EMPTY_OPERATOR_MARKET_SCOPE,
  isOperatorMarket,
  operatorBelongsToMarket,
  operatorMarketScopeFromProfile,
  pickOperatorMarket,
  resolveOperatorMarketScope,
} from './market-operator-market';

/**
 * Bitta operator — bir nechta market, 2-bosqich: gateway'dagi YAGONA
 * operator doirasi (ilgari 7 joyda `user.market_id`).
 *
 * Talablar:
 *  - doira faqat FAOL a'zoliklardan (`pending` taklif, `inactive` — yo'q);
 *  - `operator_markets` bo'lsa — faqat u (bo'sh ro'yxat = market yo'q,
 *    `market_id` ga QAYTILMAYDI); yo'q bo'lsa (o'tish davri) — `market_id`;
 *  - so'rovdagi `market_id` faqat doira ichidan tanlov, hech qachon manba;
 *  - 1 faol market — avvalgi xatti-harakat; 2+ — tanlov majburiy.
 */
const membership = (
  market_id: string,
  status = 'active',
  extra: Record<string, unknown> = {},
) => ({ market_id, status, is_primary: false, ...extra });

describe('operator doirasi (auth/market-operator-market)', () => {
  it('a`zoliklardan: faqat faol, takrorsiz, tartib saqlanadi; ombor kaliti har market bo`yicha', () => {
    const scope = operatorMarketScopeFromProfile({
      data: {
        market_id: '99',
        operator_markets: [
          membership('20', 'active', { can_view_warehouse_stock: true }),
          membership('10', 'active'),
          membership('30', 'pending', { can_view_warehouse_stock: true }),
          membership('40', 'inactive'),
          membership('020', 'active'),
          membership('abc', 'active'),
        ],
      },
    });
    expect(scope.active).toEqual(['20', '10']);
    expect(scope.warehouseStock.get('20')).toBe(true);
    expect(scope.warehouseStock.get('10')).toBe(false);
    expect(scope.warehouseStock.has('30')).toBe(false);
    // `market_id` (99) a'zoliklar berilganda HECH QACHON doiraga kirmaydi.
    expect(isOperatorMarket(scope, '99')).toBe(false);
  });

  it('bo`sh `operator_markets` — market yo`q (eski `market_id` ga qaytilmaydi)', () => {
    const scope = operatorMarketScopeFromProfile({
      data: { market_id: '37', operator_markets: [] },
    });
    expect(scope.active).toEqual([]);
    expect(pickOperatorMarket(scope)).toEqual({
      ok: false,
      reason: 'unassigned',
    });
  });

  it('o`tish davri: `operator_markets` yo`q — `market_id` va yuqori darajadagi ombor kaliti', () => {
    const scope = operatorMarketScopeFromProfile({
      data: { market_id: 37, can_view_warehouse_stock: true },
    });
    expect(scope.active).toEqual(['37']);
    expect(scope.warehouseStock.get('37')).toBe(true);
    // o'ramsiz profil ham
    expect(operatorMarketScopeFromProfile({ market_id: '5' }).active).toEqual([
      '5',
    ]);
    for (const empty of [null, undefined, 'x', { data: null }, { data: {} }]) {
      expect(operatorMarketScopeFromProfile(empty).active).toEqual([]);
    }
  });

  it('pickOperatorMarket: 1 faol market — so`ralmasa ham o`sha; begona so`rov — foreign; id kanonik', () => {
    const single = operatorMarketScopeFromProfile({ market_id: '37' });
    expect(pickOperatorMarket(single)).toEqual({ ok: true, marketId: '37' });
    expect(pickOperatorMarket(single, '037')).toEqual({
      ok: true,
      marketId: '37',
    });
    expect(pickOperatorMarket(single, ' 37 ')).toEqual({
      ok: true,
      marketId: '37',
    });
    expect(pickOperatorMarket(single, '16')).toEqual({
      ok: false,
      reason: 'foreign',
    });
    expect(pickOperatorMarket(single, 'abc')).toEqual({
      ok: false,
      reason: 'foreign',
    });
    // Bo'sh qiymat — «berilmagan».
    expect(pickOperatorMarket(single, '')).toEqual({
      ok: true,
      marketId: '37',
    });
  });

  it('pickOperatorMarket `ignoreRequestedWhenSingle`: 1 marketda so`rov e`tiborsiz (avvalgidek), 2+ da majburiy va doirada', () => {
    const single = operatorMarketScopeFromProfile({ market_id: '37' });
    expect(
      pickOperatorMarket(single, '16', { ignoreRequestedWhenSingle: true }),
    ).toEqual({ ok: true, marketId: '37' });

    const multi = operatorMarketScopeFromProfile({
      operator_markets: [membership('20'), membership('10')],
    });
    const opts = { ignoreRequestedWhenSingle: true };
    expect(pickOperatorMarket(multi, undefined, opts)).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
    expect(pickOperatorMarket(multi, '10', opts)).toEqual({
      ok: true,
      marketId: '10',
    });
    expect(pickOperatorMarket(multi, '16', opts)).toEqual({
      ok: false,
      reason: 'foreign',
    });
  });

  it('pickOperatorMarket: faol market yo`q — so`rov berilsa ham unassigned', () => {
    expect(pickOperatorMarket(EMPTY_OPERATOR_MARKET_SCOPE, '37')).toEqual({
      ok: false,
      reason: 'unassigned',
    });
  });

  it('operatorBelongsToMarket (market tomoni): faol yoki nofaol a`zolik — ha; taklif, begona — yo`q; o`tish davri — `market_id`', () => {
    const profile = {
      data: {
        market_id: '99',
        operator_markets: [
          membership('20', 'active'),
          membership('10', 'inactive'),
          membership('30', 'pending'),
        ],
      },
    };
    expect(operatorBelongsToMarket(profile, '20')).toBe(true);
    expect(operatorBelongsToMarket(profile, 10)).toBe(true);
    expect(operatorBelongsToMarket(profile, '30')).toBe(false);
    expect(operatorBelongsToMarket(profile, '99')).toBe(false);
    expect(operatorBelongsToMarket({ market_id: '37' }, '37')).toBe(true);
    expect(operatorBelongsToMarket({ market_id: '37' }, '16')).toBe(false);
    expect(operatorBelongsToMarket(null, '37')).toBe(false);
    expect(operatorBelongsToMarket(profile, '')).toBe(false);
  });

  it('resolveOperatorMarketScope: identity `find_by_id` dan; javob bermasa — bo`sh (fail-closed)', async () => {
    const identity = {
      send: jest.fn(() =>
        of({
          data: { market_id: '37', operator_markets: [membership('20')] },
        }),
      ),
    };
    const scope = await resolveOperatorMarketScope(identity, '55');
    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      { id: '55' },
    );
    expect(scope.active).toEqual(['20']);

    const down = { send: jest.fn(() => throwError(() => new Error('down'))) };
    expect((await resolveOperatorMarketScope(down, '55')).active).toEqual([]);
  });

  it('canonicalMarketId', () => {
    expect(canonicalMarketId('007')).toBe('7');
    expect(canonicalMarketId(12)).toBe('12');
    expect(canonicalMarketId('1a')).toBe('');
    expect(canonicalMarketId(null)).toBe('');
    expect(canonicalMarketId('99999999999999999999')).toBe('');
  });
});
