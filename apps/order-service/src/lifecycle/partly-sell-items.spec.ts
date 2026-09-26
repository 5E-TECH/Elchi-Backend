import { RpcException } from '@nestjs/microservices';
import { matchPartlySellItems } from './partly-sell-items';

/**
 * QISMAN SOTUV — qatorlarni moslash.
 *
 * ⚠️ Ilgari faqat `product_id` bo'yicha moslanardi: hamkor (BeePost)
 * posilkalarida `product_id = null` bo'lgani uchun ularni qisman sotib
 * bo'lmasdi, bekor qilingan qismga esa bigint ustunga "null" matni yozilardi.
 */

type Item = {
  id: string;
  product_id: string | null;
  product_name: string | null;
  quantity: number;
};

const item = (
  id: string,
  product_id: string | null,
  quantity: number,
  product_name: string | null = null,
): Item => ({ id, product_id, product_name, quantity });

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
  }
  throw new Error('xato kutilgan edi');
};

describe('matchPartlySellItems — katalogsiz (hamkor) qatorlar', () => {
  it('BeePost #120 shakli: product_id null, 2 dona — 1 tasi sotiladi, 1 tasi bekor qismga (nomi bilan)', () => {
    const tv = item('5501', null, 2, 'tv');

    const res = matchPartlySellItems(
      [tv],
      [{ order_item_id: '5501', quantity: 1 }],
    );

    expect(res.matches).toEqual([{ item: tv, quantity: 1 }]);
    expect(res.cancelledItems).toEqual([
      { product_id: null, product_name: 'tv', quantity: 1 },
    ]);
  });

  it('ikkita katalogsiz qator — har biri o`z qatori bo`yicha kamayadi', () => {
    const a = item('10', null, 3, 'kurtka');
    const b = item('11', null, 2, 'shim');

    const res = matchPartlySellItems(
      [a, b],
      [
        { order_item_id: '11', quantity: 2 },
        { order_item_id: '10', quantity: 1 },
      ],
    );

    expect(res.matches).toEqual([
      { item: a, quantity: 1 },
      { item: b, quantity: 2 },
    ]);
    expect(res.cancelledItems).toEqual([
      { product_id: null, product_name: 'kurtka', quantity: 2 },
    ]);
  });

  it('katalogsiz qator order_item_id siz yuborilsa — 404 (avvalgidek)', () => {
    expect(
      errorOf(() =>
        matchPartlySellItems(
          [item('5501', null, 2, 'tv')],
          [{ product_id: null, quantity: 1 }],
        ),
      ),
    ).toEqual({
      statusCode: 404,
      message: 'Product not found in request: null',
    });
  });
});

describe('matchPartlySellItems — katalog qatorlari (regressiya)', () => {
  it('faqat product_id — eski usul avvalgidek ishlaydi', () => {
    const p4 = item('1', '4', 10, 'Telefon');
    const p5 = item('2', '5', 1);

    const res = matchPartlySellItems(
      [p4, p5],
      [
        { product_id: '4', quantity: 3 },
        { product_id: '5', quantity: 1 },
      ],
    );

    expect(res.matches).toEqual([
      { item: p4, quantity: 3 },
      { item: p5, quantity: 1 },
    ]);
    expect(res.cancelledItems).toEqual([
      { product_id: '4', product_name: null, quantity: 7 },
    ]);
  });

  it('avval order_item_id, keyin product_id — aralash so`rov', () => {
    const p4 = item('1', '4', 2);
    const tv = item('2', null, 2, 'tv');

    const res = matchPartlySellItems(
      [p4, tv],
      [
        { product_id: '4', quantity: 2 },
        { order_item_id: '2', quantity: 1 },
      ],
    );

    expect(res.matches).toEqual([
      { item: p4, quantity: 2 },
      { item: tv, quantity: 1 },
    ]);
  });
});

describe('matchPartlySellItems — rad etiladigan so`rovlar (xabarlar avvalgidek)', () => {
  const rows = [item('1', '4', 2), item('2', null, 1, 'tv')];

  it.each([
    [
      "katalog qatori so'rovda yo'q",
      [{ order_item_id: '2', quantity: 1 }],
      404,
      'Product not found in request: 4',
    ],
    [
      "noma'lum order_item_id",
      [
        { product_id: '4', quantity: 1 },
        { order_item_id: '2', quantity: 1 },
        { order_item_id: '999', quantity: 1 },
      ],
      404,
      'Order item not found in order: 999',
    ],
    [
      "noma'lum product_id",
      [
        { product_id: '4', quantity: 1 },
        { order_item_id: '2', quantity: 1 },
        { product_id: '77', quantity: 1 },
      ],
      404,
      'Product not found in order: 77',
    ],
    [
      'asl sondan ko`p',
      [
        { product_id: '4', quantity: 3 },
        { order_item_id: '2', quantity: 1 },
      ],
      400,
      'Quantity cannot exceed original amount for product 4',
    ],
  ])('%s', (_name, request, statusCode, message) => {
    expect(errorOf(() => matchPartlySellItems(rows, request))).toEqual({
      statusCode,
      message,
    });
  });
});
