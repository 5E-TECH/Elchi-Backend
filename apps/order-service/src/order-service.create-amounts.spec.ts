import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

/**
 * IDG1z5y9 — `create` ichidagi ikkilamchi himoya. HTTP'dan tashqari
 * yo'llar (AI tasdig'i, hamkor posilkasi, telegram bot, ichki RPC)
 * ValidationPipe'dan o'tmaydi — manfiy summa/miqdor shu yerda to'xtaydi.
 */
describe('OrderLifecycleService.assertCreateAmounts (IDG1z5y9)', () => {
  const svc = Object.create(OrderLifecycleService.prototype);
  const check = (dto: Record<string, unknown>) => () =>
    svc.assertCreateAmounts(dto);
  const statusOf = (fn: () => void): number | undefined => {
    try {
      fn();
      return undefined;
    } catch (e: any) {
      return e?.getError?.()?.statusCode ?? e?.statusCode;
    }
  };

  it.each([-1, -1000, Number.NaN])('total_price=%p → 400', (total_price) => {
    expect(statusOf(check({ total_price }))).toBe(400);
  });

  it.each([0, -5, 1.5])('quantity=%p → 400', (quantity) => {
    expect(statusOf(check({ total_price: 100, items: [{ quantity }] }))).toBe(
      400,
    );
  });

  it('total_price=0 (bepul) va quantity berilmagan — o`tadi', () => {
    expect(statusOf(check({ total_price: 0, items: [{}] }))).toBeUndefined();
  });

  it('total_price berilmagan ichki chaqiruv — avvalgidek (sukut 0)', () => {
    expect(statusOf(check({ items: [{ quantity: 2 }] }))).toBeUndefined();
  });
});
