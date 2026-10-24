import {
  computeDeliveryQuote,
  DeliveryPricingInputError,
  DeliveryPricingItem,
  DeliveryPricingSettingsValues,
  DeliveryTariffRate,
  resolveDeliveryTariffId,
} from './delivery-pricing';

/**
 * DAqXPeSy — yetkazish narxi dvigateli.
 *
 * 1-QISM — OLTIN VEKTORLAR: elchipochta.uz `lib/pricing.test.ts`
 * (elchi_landing_page_front origin/main 3697d84, :24-188) AYNAN ko'chirilgan —
 * kirishlar, kutilgan sonlar va matcher'lar o'zgarmagan. Landing kirishi
 * (`from`/`to` landing hudud kodi, `delivery`, bitta posilka o'lchovi,
 * `pickup: boolean`) quyidagi `landingQuote` adapteri orqali dvigatelga
 * beriladi; tarif va sozlamalar — landing `config/site.ts` dagi qiymatlar
 * (TARIFFS :79-86, EXTRAS :98-106, VOLUMETRIC_DIVISOR :110).
 *
 * Maydonlar xaritasi (landing `Quote` → dvigatel `DeliveryQuote`):
 *   volumetric → volumetricKg, billable → billableKg, days → [daysMin, daysMax],
 *   total → totalWithPickup (pickup yo'q bo'lsa `total` bilan AYNI — har
 *   vektorda tekshiriladi). Pickup buyurtma narxiga (`total`) KIRMAYDI
 *   (Shodiyor, 2026-10-15) — u faqat kalkulyator jamiga qo'shiladi.
 *
 * 2-QISM — Elchi qo'shimchalari: ko'p elementli yig'ish, toggle o'chirilgan
 * element, o'lchovsiz element, pickup tashrifi qoidasi, sozlamalardan o'qish,
 * numeric satrlar, kirish xatolari.
 */

/** Landing `config/site.ts` TARIFFS (08.10.2026 tasdiqlangan). */
const LANDING_TARIFFS: Record<string, DeliveryTariffRate> = {
  city: {
    tariff_id: 'city',
    base_price: 35_000,
    extra_per_kg: 4_000,
    days_min: 1,
    days_max: 1,
  },
  center: {
    tariff_id: 'center',
    base_price: 40_000,
    extra_per_kg: 4_000,
    days_min: 1,
    days_max: 2,
  },
  address: {
    tariff_id: 'address',
    base_price: 60_000,
    extra_per_kg: 5_000,
    days_min: 2,
    days_max: 3,
  },
};

/** Landing `config/site.ts` EXTRAS + VOLUMETRIC_DIVISOR + `quote()` konstantalari. */
const LANDING_SETTINGS: DeliveryPricingSettingsValues = {
  volumetric_divisor: 5_000,
  first_kg_included: 1,
  min_billable_kg: 0.1,
  billable_step_kg: 0.1,
  round_to: 500,
  pickup_fee: 8_000,
  pickup_free_from_count: null,
  express_multiplier: 1.4,
};

/** Migratsiya 142 seed'i (ega qarori: pickup 20 000, 10+ posilka — tekin). */
const SEED_SETTINGS: DeliveryPricingSettingsValues = {
  ...LANDING_SETTINGS,
  pickup_fee: 20_000,
  pickup_free_from_count: 10,
};

/** Landing hudud kodi: `tsh` — Toshkent shahri (CITY_REGION), qolgani — boshqa. */
const CITY_REGION = 'tsh';

interface LandingInput {
  from: string;
  to: string;
  delivery: 'center' | 'address';
  weight: number;
  length: number;
  width: number;
  height: number;
  express: boolean;
  pickup: boolean;
}

const isCityRoute = (from: string, to: string) =>
  resolveDeliveryTariffId({
    fromCityZone: from === CITY_REGION,
    toCityZone: to === CITY_REGION,
    whereDeliver: 'center',
  }) === 'city';

const resolveTariff = (from: string, to: string, delivery: string) =>
  resolveDeliveryTariffId({
    fromCityZone: from === CITY_REGION,
    toCityZone: to === CITY_REGION,
    whereDeliver: delivery,
  });

/** Landing `quote(input)` → dvigatel (landing `Quote` maydon nomlari bilan). */
function quote(input: LandingInput) {
  const tariffId = resolveTariff(input.from, input.to, input.delivery);
  const q = computeDeliveryQuote({
    items: [
      {
        weight_kg: input.weight,
        length_cm: input.length,
        width_cm: input.width,
        height_cm: input.height,
      },
    ],
    tariff: LANDING_TARIFFS[tariffId],
    settings: LANDING_SETTINGS,
    express: input.express,
    pickupCount: input.pickup ? 1 : 0,
  });
  if (!input.pickup) {
    // Pickup yo'q — buyurtma narxi va kalkulyator jami bir xil.
    expect(q.total).toBe(q.totalWithPickup);
  }
  return {
    tariff: q.tariffId,
    base: q.base,
    perExtraKg: q.perExtraKg,
    days: [q.daysMin, q.daysMax],
    volumetric: q.volumetricKg,
    billable: q.billableKg,
    extra: q.extra,
    expressFee: q.expressFee,
    pickupFee: q.pickupFee,
    total: q.totalWithPickup,
    orderTotal: q.total,
  };
}

const BASE = {
  from: 'tsh',
  to: 'sam',
  delivery: 'center',
  weight: 1.2,
  length: 30,
  width: 22,
  height: 15,
  express: false,
  pickup: false,
} as const;

describe('OLTIN VEKTORLAR — landing lib/pricing.test.ts (AYNAN)', () => {
  describe('resolveTariff', () => {
    it('Toshkent shahri ichida — har doim shahar tarifi', () => {
      // Shahar ichida tanlov yo'q: kuryer mijoz manziligacha yetkazadi.
      expect(resolveTariff('tsh', 'tsh', 'center')).toBe('city');
      expect(resolveTariff('tsh', 'tsh', 'address')).toBe('city');
      expect(isCityRoute('tsh', 'tsh')).toBe(true);
    });

    it("Toshkent viloyati 'boshqa viloyat' hisoblanadi", () => {
      // Chirchiq/Nurafshon shahar tarifiga kirmaydi — 08.10.2026 qarori.
      expect(isCityRoute('tsh', 'tshv')).toBe(false);
      expect(resolveTariff('tsh', 'tshv', 'center')).toBe('center');
      expect(resolveTariff('tsh', 'tshv', 'address')).toBe('address');
    });

    it('shahar tashqarisida narxni yetkazish turi belgilaydi', () => {
      expect(resolveTariff('tsh', 'sam', 'center')).toBe('center');
      expect(resolveTariff('tsh', 'sam', 'address')).toBe('address');
      // Teskari yo'nalishda ham xuddi shunday — masofa narxga ta'sir qilmaydi.
      expect(resolveTariff('qqr', 'tsh', 'address')).toBe('address');
      expect(resolveTariff('sur', 'far', 'center')).toBe('center');
    });
  });

  describe('quote', () => {
    it('viloyat markazigacha standart holat', () => {
      const q = quote(BASE);

      expect(q.tariff).toBe('center');
      expect(q.volumetric).toBeCloseTo(1.98, 5);
      expect(q.billable).toBe(2);
      expect(q.base).toBe(40_000);
      expect(q.perExtraKg).toBe(4_000);
      expect(q.extra).toBe(4_000);
      expect(q.total).toBe(44_000);
      expect(q.days).toEqual([1, 2]);
    });

    it('manzilgacha tarifi 60 000 dan va har kg uchun 5 000', () => {
      const q = quote({ ...BASE, delivery: 'address' });

      expect(q.tariff).toBe('address');
      expect(q.base).toBe(60_000);
      expect(q.perExtraKg).toBe(5_000);
      expect(q.extra).toBe(5_000);
      expect(q.total).toBe(65_000);
    });

    it("Toshkent shahri 35 000 dan, har qo'shimcha kg 4 000", () => {
      const q = quote({
        ...BASE,
        from: 'tsh',
        to: 'tsh',
        weight: 3,
        length: 10,
        width: 10,
        height: 10,
      });

      expect(q.tariff).toBe('city');
      expect(q.base).toBe(35_000);
      // 1 kg bazada, qolgan 2 kg × 4 000
      expect(q.perExtraKg).toBe(4_000);
      expect(q.extra).toBe(8_000);
      expect(q.total).toBe(43_000);
    });

    it("hajmli vazn haqiqiy vazndan katta bo'lsa, o'sha hisoblanadi", () => {
      // 60x40x30 = 72000/5000 = 14.4 kg hajmli, haqiqiy atigi 2 kg
      const q = quote({
        ...BASE,
        weight: 2,
        length: 60,
        width: 40,
        height: 30,
      });
      expect(q.volumetric).toBeCloseTo(14.4, 5);
      expect(q.billable).toBe(14.4);
      // 1 kg asosiy narxda, qolgan 13.4 -> yuqoriga 14 kg
      expect(q.extra).toBe(14 * 4_000);
    });

    it("haqiqiy vazn kattaroq bo'lsa, hajmli vazn e'tiborga olinmaydi", () => {
      const q = quote({
        ...BASE,
        weight: 9,
        length: 10,
        width: 10,
        height: 10,
      });
      expect(q.volumetric).toBeCloseTo(0.2, 5);
      expect(q.billable).toBe(9);
    });

    it("1 kg gacha jo'natmada ustama yo'q", () => {
      const q = quote({
        ...BASE,
        from: 'tsh',
        to: 'tsh',
        weight: 0.4,
        length: 10,
        width: 10,
        height: 10,
      });
      expect(q.billable).toBe(0.4);
      expect(q.extra).toBe(0);
      expect(q.total).toBe(35_000);
    });

    it("aniq 1.0 kg da suzuvchi nuqta xatosi qo'shimcha kg qo'shmaydi", () => {
      const q = quote({
        ...BASE,
        from: 'tsh',
        to: 'tsh',
        weight: 1,
        length: 10,
        width: 10,
        height: 10,
      });
      expect(q.billable).toBe(1);
      expect(q.extra).toBe(0);
    });

    it('eng kichik hisoblanadigan vazn — 0.1 kg', () => {
      const q = quote({
        ...BASE,
        weight: 0.01,
        length: 1,
        width: 1,
        height: 1,
      });
      expect(q.billable).toBe(0.1);
    });

    it('tezkor yetkazish asosiy summaga 1.4 koeffitsient qo`llaydi', () => {
      const q = quote({ ...BASE, express: true });
      // subtotal 44 000 -> express ustamasi 44 000 * 0.4 = 17 600
      expect(q.expressFee).toBeCloseTo(17_600, 5);
      expect(q.total).toBe(61_500); // 61 600 -> 500 gacha yaxlitlanadi
    });

    it('pickup haqi qo`shiladi', () => {
      const q = quote({ ...BASE, pickup: true });
      expect(q.pickupFee).toBe(8_000);
      expect(q.total).toBe(52_000);
      // Elchi: buyurtmaga yoziladigan narxga pickup KIRMAYDI.
      expect(q.orderTotal).toBe(44_000);
    });

    it('yakuniy summa har doim 500 ga karrali', () => {
      for (const weight of [0.3, 1.7, 2.4, 5.5, 12.9]) {
        for (const express of [false, true]) {
          for (const delivery of ['center', 'address'] as const) {
            const q = quote({
              ...BASE,
              weight,
              express,
              delivery,
              pickup: true,
            });
            expect(q.total % 500).toBe(0);
            expect(q.orderTotal % 500).toBe(0);
          }
        }
      }
    });

    it('manzilgacha narxi markazgacha narxidan har doim qimmat', () => {
      for (const weight of [0.5, 1, 4.2, 11]) {
        const center = quote({ ...BASE, weight, delivery: 'center' }).total;
        const address = quote({ ...BASE, weight, delivery: 'address' }).total;
        expect(address).toBeGreaterThan(center);
      }
    });
  });
});

const item = (overrides: Partial<DeliveryPricingItem> = {}) => ({
  weight_kg: 1.2,
  length_cm: 30,
  width_cm: 22,
  height_cm: 15,
  volumetric_enabled: true,
  quantity: 1,
  ...overrides,
});

const center = LANDING_TARIFFS.center;

describe('Elchi qo`shimchalari — ko`p elementli buyurtma = BITTA jo`natma', () => {
  it('og`irliklar va hajmlar QO`SHILADI (× quantity), baza BIR MARTA', () => {
    // 2 × (1.2 kg, 9 900 sm³) + 1 × (0.5 kg, 10×10×10)
    // haqiqiy 2.9 kg; hajm (19 800 + 1 000) / 5000 = 4.16 kg → 4.2 kg
    const q = computeDeliveryQuote({
      items: [
        item({ quantity: 2 }),
        item({ weight_kg: 0.5, length_cm: 10, width_cm: 10, height_cm: 10 }),
      ],
      tariff: center,
      settings: SEED_SETTINGS,
    });
    expect(q.actualKg).toBe(2.9);
    expect(q.volumetricKg).toBeCloseTo(4.16, 5);
    expect(q.billableKg).toBe(4.2);
    expect(q.basis).toBe('volume');
    expect(q.extraKg).toBe(4);
    expect(q.base).toBe(40_000);
    expect(q.total).toBe(40_000 + 4 * 4_000);
  });

  it('har bir elementga alohida baza QO`SHILMAYDI (3 ta yengil element — bitta baza)', () => {
    const q = computeDeliveryQuote({
      items: [
        item({ weight_kg: 0.2, length_cm: 5, width_cm: 5, height_cm: 5 }),
        item({ weight_kg: 0.2, length_cm: 5, width_cm: 5, height_cm: 5 }),
        item({ weight_kg: 0.2, length_cm: 5, width_cm: 5, height_cm: 5 }),
      ],
      tariff: center,
      settings: SEED_SETTINGS,
    });
    expect(q.billableKg).toBe(0.6);
    expect(q.total).toBe(40_000);
  });

  it('⭐ yig`indidagi suzuvchi nuqta chiqindisi ortiqcha kg QO`SHMAYDI (0.1 + 2.7 + 0.2 = 3.0)', () => {
    // Oddiy JS: 0.1 + 2.7 + 0.2 = 3.0000000000000004 → ceil(30.000…04)/10 =
    // 3.1 kg → 3 qo'shimcha kg. To'g'risi: 3.0 kg → 2 qo'shimcha kg.
    const q = computeDeliveryQuote({
      items: [0.1, 2.7, 0.2].map((w) =>
        item({ weight_kg: w, length_cm: 1, width_cm: 1, height_cm: 1 }),
      ),
      tariff: center,
      settings: SEED_SETTINGS,
    });
    expect(q.billableKg).toBe(3);
    expect(q.extraKg).toBe(2);
    expect(q.total).toBe(48_000);
  });
});

describe('Elchi qo`shimchalari — toggle va o`lchovsiz element', () => {
  it('volumetric_enabled = false — hajm yig`indiga KIRMAYDI, og`irligi kiradi', () => {
    const big = { weight_kg: 2, length_cm: 60, width_cm: 40, height_cm: 30 };
    const on = computeDeliveryQuote({
      items: [item(big)],
      tariff: center,
      settings: SEED_SETTINGS,
    });
    const off = computeDeliveryQuote({
      items: [item({ ...big, volumetric_enabled: false })],
      tariff: center,
      settings: SEED_SETTINGS,
    });
    expect(on.billableKg).toBe(14.4);
    expect(off.volumetricKg).toBe(0);
    expect(off.billableKg).toBe(2);
    expect(off.basis).toBe('weight');
    expect(off.total).toBe(44_000);
    expect(off.estimated).toBe(false);
  });

  it('aralash: o`chirilgan elementning faqat og`irligi, yoqiqning hajmi ham', () => {
    const q = computeDeliveryQuote({
      items: [
        item({
          weight_kg: 2,
          length_cm: 60,
          width_cm: 40,
          height_cm: 30,
          volumetric_enabled: false,
        }),
        item(), // 1.2 kg, 1.98 kg hajm
      ],
      tariff: center,
      settings: SEED_SETTINGS,
    });
    expect(q.actualKg).toBe(3.2);
    expect(q.volumetricKg).toBeCloseTo(1.98, 5);
    expect(q.billableKg).toBe(3.2);
  });

  it('og`irligi NULL element — unmeasuredItems, narx jimgina 0 EMAS (baza)', () => {
    const q = computeDeliveryQuote({
      items: [
        item({
          weight_kg: null,
          length_cm: null,
          width_cm: null,
          height_cm: null,
        }),
      ],
      tariff: center,
      settings: SEED_SETTINGS,
    });
    expect(q.unmeasuredItems).toBe(1);
    expect(q.estimated).toBe(true);
    expect(q.basis).toBeNull();
    expect(q.actualKg).toBe(0);
    expect(q.billableKg).toBe(0.1);
    expect(q.total).toBe(40_000);
    expect(q.total).toBeGreaterThan(0);
  });

  it('o`lchovsiz element boshqa o`lchovli elementlarni 0 ga tushirmaydi', () => {
    const q = computeDeliveryQuote({
      items: [
        item({ weight_kg: 3, volumetric_enabled: false }),
        item({ weight_kg: undefined, quantity: 4 }),
      ],
      tariff: center,
      settings: SEED_SETTINGS,
    });
    expect(q.unmeasuredItems).toBe(1);
    // Og'irligi yo'q, lekin o'lchami bor — hajmi hisobga olinadi (4 × 1.98).
    expect(q.volumetricKg).toBeCloseTo(7.92, 5);
    expect(q.billableKg).toBe(8);
    expect(q.total).toBe(40_000 + 7 * 4_000);
    expect(q.estimated).toBe(true);
  });

  it('og`irligi bor, o`lchami yo`q (hajm yoqiq) — hajm 0, missingDimensionItems', () => {
    const q = computeDeliveryQuote({
      items: [
        item({ length_cm: null, width_cm: null, height_cm: null }),
        item({
          length_cm: 10,
          width_cm: null,
          height_cm: 10,
        }),
      ],
      tariff: center,
      settings: SEED_SETTINGS,
    });
    expect(q.unmeasuredItems).toBe(0);
    expect(q.missingDimensionItems).toBe(2);
    expect(q.volumetricKg).toBe(0);
    expect(q.billableKg).toBe(2.4);
    expect(q.estimated).toBe(true);
  });

  it('o`lchami yo`q, lekin hajm hisobi o`chiq — taxminiy emas', () => {
    const q = computeDeliveryQuote({
      items: [
        item({
          length_cm: null,
          width_cm: null,
          height_cm: null,
          volumetric_enabled: false,
        }),
      ],
      tariff: center,
      settings: SEED_SETTINGS,
    });
    expect(q.missingDimensionItems).toBe(0);
    expect(q.estimated).toBe(false);
  });
});

describe('Elchi qo`shimchalari — pickup tashrifi (buyurtma narxiga kirmaydi)', () => {
  const run = (pickupCount?: number) =>
    computeDeliveryQuote({
      items: [item()],
      tariff: center,
      settings: SEED_SETTINGS,
      pickupCount,
    });

  it.each([
    [undefined, 0],
    [0, 0],
    [1, 20_000],
    [9, 20_000],
    [10, 0],
    [25, 0],
  ])('pickupCount=%p → pickupFee %p, total o`zgarmaydi', (count, fee) => {
    const q = run(count);
    expect(q.pickupFee).toBe(fee);
    expect(q.total).toBe(44_000);
    expect(q.totalWithPickup).toBe(44_000 + fee);
  });

  it('pickup_free_from_count = NULL — hech qachon tekin emas', () => {
    const q = computeDeliveryQuote({
      items: [item()],
      tariff: center,
      settings: { ...SEED_SETTINGS, pickup_free_from_count: null },
      pickupCount: 50,
    });
    expect(q.pickupFee).toBe(20_000);
  });
});

describe('Elchi qo`shimchalari — hech qanday son kodga qotirilmagan', () => {
  const base = { items: [item()], tariff: center };

  it.each<[string, Partial<DeliveryPricingSettingsValues>, number, number]>([
    // [nom, sozlama o'zgarishi, kutilgan billableKg, kutilgan total]
    ['volumetric_divisor 6000', { volumetric_divisor: 6_000 }, 1.7, 44_000],
    ['first_kg_included 2', { first_kg_included: 2 }, 2, 40_000],
    ['min_billable_kg 3', { min_billable_kg: 3 }, 3, 48_000],
    ['billable_step_kg 0.5', { billable_step_kg: 0.5 }, 2, 44_000],
    ['round_to 1000', { round_to: 1_000 }, 2, 44_000],
  ])('%s', (_name, patch, billable, total) => {
    const q = computeDeliveryQuote({
      ...base,
      settings: { ...SEED_SETTINGS, ...patch },
    });
    expect(q.billableKg).toBe(billable);
    expect(q.total).toBe(total);
  });

  it('express_multiplier va round_to jadvaldan: 1.5 × 44 000 = 66 000; round_to 1000', () => {
    const q = computeDeliveryQuote({
      ...base,
      settings: { ...SEED_SETTINGS, express_multiplier: 1.5, round_to: 1_000 },
      express: true,
    });
    expect(q.expressFee).toBe(22_000);
    expect(q.total).toBe(66_000);
    const q2 = computeDeliveryQuote({
      ...base,
      settings: { ...SEED_SETTINGS, express_multiplier: 1.33, round_to: 1_000 },
      express: true,
    });
    // 44 000 × 0.33 = 14 520 → 58 520 → 1000 ga: 59 000
    expect(q2.expressFee).toBe(14_520);
    expect(q2.total).toBe(59_000);
  });

  it('tarif qiymati o`zgarsa natija darhol o`zgaradi (kesh yo`q — sof funksiya)', () => {
    const before = computeDeliveryQuote({ ...base, settings: SEED_SETTINGS });
    const after = computeDeliveryQuote({
      ...base,
      tariff: { ...center, base_price: 42_000, extra_per_kg: 4_500 },
      settings: SEED_SETTINGS,
    });
    expect(before.total).toBe(44_000);
    expect(after.total).toBe(46_500);
  });
});

describe('Elchi qo`shimchalari — numeric satrlar va kirish xatolari', () => {
  it('Postgres numeric satrlari SON sifatida qo`shiladi (konkatenatsiya yo`q)', () => {
    const q = computeDeliveryQuote({
      items: [
        {
          weight_kg: '1.200',
          length_cm: '30',
          width_cm: '22',
          height_cm: '15',
          quantity: '2',
        },
      ],
      tariff: {
        tariff_id: 'center',
        base_price: '40000.00',
        extra_per_kg: '4000.00',
        days_min: 1,
        days_max: 2,
      },
      settings: {
        volumetric_divisor: 5000,
        first_kg_included: '1.000',
        min_billable_kg: '0.100',
        billable_step_kg: '0.100',
        round_to: 500,
        pickup_fee: '20000.00',
        pickup_free_from_count: 10,
        express_multiplier: '1.400',
      },
    });
    expect(typeof q.total).toBe('number');
    expect(q.billableKg).toBe(4);
    expect(q.total).toBe(52_000);
    expect(q.base).toBe(40_000);
  });

  it('bo`sh items — baza tarif (minimum vazn), 0 emas', () => {
    const q = computeDeliveryQuote({
      items: [],
      tariff: center,
      settings: SEED_SETTINGS,
    });
    expect(q.billableKg).toBe(0.1);
    expect(q.total).toBe(40_000);
  });

  it.each<[string, () => unknown]>([
    [
      'manfiy og`irlik',
      () =>
        computeDeliveryQuote({
          items: [item({ weight_kg: -1 })],
          tariff: center,
          settings: SEED_SETTINGS,
        }),
    ],
    [
      'quantity 0',
      () =>
        computeDeliveryQuote({
          items: [item({ quantity: 0 })],
          tariff: center,
          settings: SEED_SETTINGS,
        }),
    ],
    [
      'quantity kasr',
      () =>
        computeDeliveryQuote({
          items: [item({ quantity: 1.5 })],
          tariff: center,
          settings: SEED_SETTINGS,
        }),
    ],
    [
      'volumetric_divisor 0',
      () =>
        computeDeliveryQuote({
          items: [item()],
          tariff: center,
          settings: { ...SEED_SETTINGS, volumetric_divisor: 0 },
        }),
    ],
    [
      'round_to yo`q',
      () =>
        computeDeliveryQuote({
          items: [item()],
          tariff: center,
          settings: { ...SEED_SETTINGS, round_to: null },
        }),
    ],
    [
      'express_multiplier < 1',
      () =>
        computeDeliveryQuote({
          items: [item()],
          tariff: center,
          settings: { ...SEED_SETTINGS, express_multiplier: 0.9 },
        }),
    ],
    [
      'base_price son emas',
      () =>
        computeDeliveryQuote({
          items: [item()],
          tariff: { ...center, base_price: 'abc' },
          settings: SEED_SETTINGS,
        }),
    ],
    [
      'pickupCount manfiy',
      () =>
        computeDeliveryQuote({
          items: [item()],
          tariff: center,
          settings: SEED_SETTINGS,
          pickupCount: -1,
        }),
    ],
    [
      'where_deliver noto`g`ri',
      () =>
        resolveDeliveryTariffId({
          fromCityZone: false,
          toCityZone: false,
          whereDeliver: 'city',
        }),
    ],
  ])('%s → DeliveryPricingInputError', (_name, run) => {
    expect(run).toThrow(DeliveryPricingInputError);
  });
});
