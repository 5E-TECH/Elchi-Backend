import {
  computeDeliveryQuote,
  computePickupFee,
  DeliveryPricingInputError,
} from './delivery-pricing';

/**
 * B824gOu5 — pickup tashrifi haqi: 1–9 posilka → umumiy `pickup_fee`,
 * `pickup_free_from_count` va undan ko'p → 0. Summa va chegara faqat
 * sozlamadan (kodda 20 000 / 10 yo'q).
 */
describe('computePickupFee (B824gOu5)', () => {
  const settings = { pickupFee: 20000, pickupFreeFromCount: 10 };

  it.each([
    [1, 20000, false],
    [9, 20000, false],
    [10, 0, true],
    [11, 0, true],
  ])('%i posilka → fee %i (is_free %s)', (parcelCount, fee, isFree) => {
    expect(computePickupFee({ ...settings, parcelCount })).toEqual({
      fee,
      isFree,
    });
  });

  it('summa va chegara sozlamadan keladi (kodga qotirilmagan)', () => {
    expect(
      computePickupFee({
        parcelCount: 4,
        pickupFee: 35000,
        pickupFreeFromCount: 5,
      }),
    ).toEqual({ fee: 35000, isFree: false });
    expect(
      computePickupFee({
        parcelCount: 5,
        pickupFee: 35000,
        pickupFreeFromCount: 5,
      }),
    ).toEqual({ fee: 0, isFree: true });
  });

  it('chegara NULL — hech qachon tekin emas (sozlama izohi bilan bir xil)', () => {
    expect(
      computePickupFee({
        parcelCount: 500,
        pickupFee: 20000,
        pickupFreeFromCount: null,
      }),
    ).toEqual({ fee: 20000, isFree: false });
  });

  it('numeric ustun satr bo`lib kelsa ham aniq', () => {
    expect(
      computePickupFee({
        parcelCount: '9',
        pickupFee: '20000.00',
        pickupFreeFromCount: '10',
      }),
    ).toEqual({ fee: 20000, isFree: false });
  });

  it('`pickup_fee` 0 — haq olinmaydi, holat tekin deb ko`rinadi', () => {
    expect(
      computePickupFee({
        parcelCount: 1,
        pickupFee: 0,
        pickupFreeFromCount: 10,
      }),
    ).toEqual({ fee: 0, isFree: true });
  });

  it.each([[0], [-1], [1.5], ['abc'], [null]])(
    'yaroqsiz posilka soni %s — xato (jimgina 0 emas)',
    (parcelCount) => {
      expect(() => computePickupFee({ ...settings, parcelCount })).toThrow(
        DeliveryPricingInputError,
      );
    },
  );

  it('sozlama yo`q — xato (kodda zaxira summa yo`q)', () => {
    expect(() =>
      computePickupFee({
        parcelCount: 1,
        pickupFee: null,
        pickupFreeFromCount: 10,
      }),
    ).toThrow(DeliveryPricingInputError);
  });

  it('kalkulyator (`computeDeliveryQuote`) AYNI qoidani ishlatadi', () => {
    const quote = (pickupCount: number) =>
      computeDeliveryQuote({
        items: [{ weight_kg: 1 }],
        tariff: {
          tariff_id: 'center',
          base_price: 30000,
          extra_per_kg: 5000,
        },
        settings: {
          volumetric_divisor: 5000,
          first_kg_included: 1,
          min_billable_kg: 0.1,
          billable_step_kg: 0.1,
          round_to: 500,
          pickup_fee: 20000,
          pickup_free_from_count: 10,
          express_multiplier: 1.4,
        },
        pickupCount,
      }).pickupFee;
    expect(quote(0)).toBe(0);
    expect(quote(9)).toBe(20000);
    expect(quote(10)).toBe(0);
  });
});
