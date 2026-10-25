import { of, throwError, NEVER } from 'rxjs';
import {
  fetchScanOrderSummaries,
  SCAN_ORDER_SUMMARY_CHUNK,
  toScanOrderSummaryRef,
} from './scan-order-summary';

/** dwJX3NjT — skaner buyurtma xulosasi (paket/pochta skani uchun umumiy). */
describe('toScanOrderSummaryRef', () => {
  it('order.summary_by_ids qatori → oq ro`yxat (customer obyekt)', () => {
    expect(
      toScanOrderSummaryRef({
        id: 700,
        order_number: 'EL-100700',
        status: 'on the road',
        total_price: '65000',
        customer_name: ' Ali ',
        customer_phone: '+998901234567',
        region_name: 'Buxoro viloyati',
        district_name: null,
        market_tariff: 20000,
      }),
    ).toEqual({
      id: '700',
      order_number: 'EL-100700',
      status: 'on the road',
      total_price: 65000,
      region: 'Buxoro viloyati',
      district: null,
      customer: { name: 'Ali', phone_number: '+998901234567' },
    });
  });

  it('mijoz ismi ham, telefoni ham yo`q — customer null; id`siz qator — null', () => {
    expect(toScanOrderSummaryRef({ id: '1' })?.customer).toBeNull();
    expect(toScanOrderSummaryRef({ status: 'new' })).toBeNull();
    expect(toScanOrderSummaryRef(null)).toBeNull();
    expect(toScanOrderSummaryRef([])).toBeNull();
  });
});

describe('fetchScanOrderSummaries', () => {
  const client = (impl: (payload: { ids: string[] }) => unknown) => ({
    send: jest.fn((_pattern: unknown, payload: { ids: string[] }) =>
      impl(payload),
    ),
  });

  it('id`lar takrorsiz, 100 talik bo`laklarda so`raladi', async () => {
    const c = client((payload) =>
      of({ data: payload.ids.map((id) => ({ id })) }),
    );
    const ids = Array.from({ length: 205 }, (_, i) => String(i + 1));
    const map = await fetchScanOrderSummaries(c as never, [
      ...ids,
      '1',
      '',
      ' ',
    ]);

    expect(SCAN_ORDER_SUMMARY_CHUNK).toBe(100);
    expect(c.send.mock.calls.map(([, p]) => p.ids.length)).toEqual([
      100, 100, 5,
    ]);
    expect(map.size).toBe(205);
  });

  it('bo`sh ro`yxat — so`rov yo`q', async () => {
    const c = client(() => of({ data: [] }));
    expect((await fetchScanOrderSummaries(c as never, [])).size).toBe(0);
    expect(c.send).not.toHaveBeenCalled();
  });

  it('xato va timeout — fail-soft (Map bo`sh, onError chaqiriladi)', async () => {
    const onError = jest.fn();
    const failing = client(() => throwError(() => new Error('down')));
    expect(
      (await fetchScanOrderSummaries(failing as never, ['1'], { onError }))
        .size,
    ).toBe(0);

    const hanging = client(() => NEVER);
    expect(
      (
        await fetchScanOrderSummaries(hanging as never, ['2'], {
          onError,
          timeoutMs: 10,
        })
      ).size,
    ).toBe(0);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[1][1]).toEqual(['2']);
  });
});
