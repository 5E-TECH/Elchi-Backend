import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order_status } from '@app/common';

/**
 * 7-BOSQICH: ONLAYN TO'LOVNI BUYURTMAGA QAYD ETISH.
 *
 * ⚠️ BU METOD PULNI KASSAGA KO'CHIRMAYDI. Foydalanuvchi qarori
 * (2026-09-13): onlayn pul hozircha kassaga yozilmaydi, faqat daftarga va
 * buyurtmaning to'lov maydonlariga.
 *
 * ⚠️ ENG XAVFLI UCH HOLAT VA NEGA:
 *
 *  1. `pending` ni "to'langan" deb belgilash — to'lov tizimi tranzaksiyani
 *     BAND qilgan, lekin pul hali kelmagan. Belgilasak kuryer naqd
 *     yig'masdi, pul esa kelmasdi.
 *  2. YOPILGAN buyurtmaga qo'llash — kuryer naqd pulni yig'ib bo'lgan.
 *     Ustiga onlayn to'lovni qo'shsak, mijoz IKKI MARTA to'lagan bo'lib
 *     chiqadi va tizim buni "hammasi joyida" deb ko'rsatardi.
 *  3. ORTIQCHA to'lovni qabul qilish — summa narxdan oshsa, eng ehtimolli
 *     sabab to'lovning NOTO'G'RI buyurtmaga moslashtirilgani. Qabul
 *     qilsak, to'lanmagan buyurtma "to'langan" bo'lib qolardi.
 */

/**
 * Yozish ATOMIK: qiymat SQL ichida oshiriladi va chegara `WHERE` ichida
 * tekshiriladi. Shu bois tayanch `update()` emas, `createQueryBuilder()` ni
 * taqlid qiladi va bajarilgan SQL bilan parametrlarni yozib oladi.
 *
 * ⚠️ Natijadagi `payment_status` ni SQL hisoblaydi, ya'ni testda uni
 * to'g'ridan-to'g'ri o'qib bo'lmaydi. Javobdagi `payment_status` esa
 * `derivePaymentState` dan keladi va AYNI qoidaga tayanadi — shuning
 * uchun tekshiruv javob orqali qilinadi.
 */
function svc(
  order: Record<string, unknown> | null,
  opts: { affected?: number; matches?: Record<string, unknown>[] } = {},
) {
  const updates: Array<{ sql: string[]; params: Record<string, unknown> }> = [];
  const logs: Record<string, unknown>[] = [];
  const s = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService & Record<string, any>;

  const rows = opts.matches ?? (order ? [order] : []);

  const makeQb = () => {
    const state = { sql: [] as string[], params: {} as Record<string, unknown> };
    const qb: any = {
      update: () => qb,
      set: (values: Record<string, () => string>) => {
        for (const fn of Object.values(values)) {
          if (typeof fn === 'function') state.sql.push(fn());
        }
        return qb;
      },
      where: (w: string, p?: Record<string, unknown>) => {
        state.sql.push(w);
        Object.assign(state.params, p ?? {});
        return qb;
      },
      andWhere: (w: string, p?: Record<string, unknown>) => {
        state.sql.push(w);
        Object.assign(state.params, p ?? {});
        return qb;
      },
      setParameter: (k: string, v: unknown) => {
        state.params[k] = v;
        return qb;
      },
      execute: () => {
        updates.push(state);
        return Promise.resolve({ affected: opts.affected ?? 1 });
      },
    };
    return qb;
  };

  Object.assign(s, {
    orderRepo: {
      find: jest.fn().mockResolvedValue(rows),
      createQueryBuilder: jest.fn(makeQb),
    },
    activityLog: {
      log: jest.fn((entry: Record<string, unknown>) => {
        logs.push(entry);
        return Promise.resolve(undefined);
      }),
    },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  });
  return { s, updates, logs };
}

const ORDER = {
  id: '4021',
  status: Order_status.RECEIVED,
  total_price: 250000,
  paid_online_amount: 0,
  payment_status: null,
};

const call = (s: any, over: Record<string, unknown> = {}) =>
  s.recordOnlinePayment({
    integration_slug: 'uzum',
    provider_transaction_id: 'TXN-1',
    order_ref: '4021',
    order_ref_field: 'id',
    amount: 250000,
    currency: 'UZS',
    status: 'succeeded',
    ...over,
  });

describe("Onlayn to'lovni qayd etish", () => {
  describe('⭐ FAQAT tasdiqlangan to`lov qo`llanadi', () => {
    it('`pending` QO`LLANMAYDI', async () => {
      /**
       * To'lov tizimi tranzaksiyani band qilgan, pul hali kelmagan.
       * "To'langan" deb belgilash eng xavfli xato: kuryer naqd yig'masdi.
       */
      const { s, updates } = svc(ORDER);
      const res: any = await call(s, { status: 'pending' });

      expect(res.data.outcome).toBe('ignored_status');
      expect(updates).toHaveLength(0);
    });

    it('`failed` QO`LLANMAYDI', async () => {
      const { s, updates } = svc(ORDER);
      const res: any = await call(s, { status: 'failed' });
      expect(res.data.outcome).toBe('ignored_status');
      expect(updates).toHaveLength(0);
    });

    it('`succeeded` qo`llanadi', async () => {
      const { s, updates } = svc(ORDER);
      const res: any = await call(s);

      expect(res.data.outcome).toBe('recorded');
      expect(res.data.payment_status).toBe('paid');
      expect(res.data.paid_online_amount).toBe(250000);
      // Summa SQL ichida oshiriladi — yo'qolgan yangilanish bo'lmaydi.
      expect(updates[0].sql.join(' ')).toContain('"paid_online_amount" + :amt');
      expect(updates[0].params.amt).toBe(250000);
    });
  });

  describe('⭐ SUMMA tekshiruvi', () => {
    it('son bo`lmagan summa rad etiladi', async () => {
      const { s, updates } = svc(ORDER);
      const res: any = await call(s, { amount: '250 000' });

      expect(res.data.outcome).toBe('amount_invalid');
      expect(updates).toHaveLength(0);
    });

    it('nol va manfiy summa rad etiladi', async () => {
      for (const amount of [0, -100]) {
        const { s, updates } = svc(ORDER);
        const res: any = await call(s, { amount });
        expect(res.data.outcome).toBe('amount_invalid');
        expect(updates).toHaveLength(0);
      }
    });

    it('⭐ ORTIQCHA to`lov RAD ETILADI', async () => {
      /**
       * Summa narxdan oshsa, eng ehtimolli sabab — to'lov NOTO'G'RI
       * buyurtmaga moslashtirilgani (havola takrorlangan yoki provayder
       * boshqa raqam yubordi). Qabul qilsak, to'lanmagan buyurtma
       * "to'langan" bo'lib qolardi va kuryer puldan qaytardi.
       */
      const { s, updates, logs } = svc(ORDER);
      const res: any = await call(s, { amount: 300000 });

      expect(res.data.outcome).toBe('amount_exceeds_total');
      expect(updates).toHaveLength(0);
      // Sabab jurnalga tushishi shart — pul kelgan, ko'rinmasligi mumkin emas.
      expect(logs[0].new_value).toMatchObject({
        outcome: 'amount_exceeds_total',
        total_price: 250000,
      });
    });

    it('avvalgi to`lov ustiga qo`shilganda ham chegara ishlaydi', async () => {
      const { s, updates } = svc({ ...ORDER, paid_online_amount: 200000 });
      const res: any = await call(s, { amount: 100000 });

      expect(res.data.outcome).toBe('amount_exceeds_total');
      expect(updates).toHaveLength(0);
    });

    it('QISMAN to`lov `partly` bo`ladi', async () => {
      const { s, updates } = svc(ORDER);
      const res: any = await call(s, { amount: 100000 });

      expect(res.data.outcome).toBe('recorded');
      expect(res.data.payment_status).toBe('partly');
      expect(res.data.paid_online_amount).toBe(100000);
    });

    it('ikki qismiy to`lov `paid` ga yetadi', async () => {
      const { s } = svc({ ...ORDER, paid_online_amount: 150000 });
      const res: any = await call(s, { amount: 100000 });
      expect(res.data.payment_status).toBe('paid');
      expect(res.data.paid_online_amount).toBe(250000);
    });

    it('tiyin yumaloqlanishi uchun 1 so`m bag`rikenglik', async () => {
      // 249 999.50 → "paid" hisoblanishi kerak, aks holda posilka
      // "to'liq to'lanmagan" bo'lib qolardi.
      const { s } = svc(ORDER);
      const res: any = await call(s, { amount: 249999.5 });
      expect(res.data.payment_status).toBe('paid');
    });
  });

  describe('⭐ YOPILGAN buyurtmaga qo`llanmaydi', () => {
    /**
     * Buyurtma sotilgan bo'lsa, kuryer naqd pulni YIG'IB BO'LGAN. Ustiga
     * onlayn to'lovni qo'shsak, mijoz ikki marta to'lagan bo'lib chiqadi.
     * Bu holat qaytarish talab qiladi — ODAM qarori.
     */
    const CLOSED = [
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
      Order_status.RETURNED_TO_MARKET,
      Order_status.CLOSED,
    ];

    it.each(CLOSED)('%s holatida rad etiladi', async (status) => {
      const { s, updates } = svc({ ...ORDER, status });
      const res: any = await call(s);

      expect(res.data.outcome).toBe('order_already_closed');
      expect(updates).toHaveLength(0);
    });

    it('rad etish JURNALGA yoziladi', async () => {
      const { s, logs } = svc({ ...ORDER, status: Order_status.SOLD });
      await call(s);

      expect(logs[0].new_value).toMatchObject({
        outcome: 'order_already_closed',
        order_status: Order_status.SOLD,
      });
    });

    it('ochiq holatlarda qo`llanadi', async () => {
      for (const status of [
        Order_status.NEW,
        Order_status.RECEIVED,
        Order_status.ON_THE_ROAD,
        Order_status.WAITING,
      ]) {
        const { s, updates } = svc({ ...ORDER, status });
        await call(s);
        expect(updates).toHaveLength(1);
      }
    });
  });

  describe('BUYURTMANI topish', () => {
    it('havola yo`q bo`lsa aniq natija', async () => {
      const { s } = svc(ORDER);
      const res: any = await call(s, { order_ref: '  ' });
      expect(res.data.outcome).toBe('order_ref_missing');
    });

    it('topilmasa aniq natija', async () => {
      const { s, updates } = svc(null);
      const res: any = await call(s);
      expect(res.data.outcome).toBe('order_not_found');
      expect(updates).toHaveLength(0);
    });

    it('⭐ `id` son bo`lmasa 500 BERMAYDI', async () => {
      /**
       * `id` — bigint. Son bo'lmagan havolani `where` ga qo'ysak Postgres
       * `22P02` tip xatosi beradi va webhook 500 bilan yiqilardi; to'lov
       * tizimi esa qayta-qayta yuborishni boshlardi.
       */
      const { s } = svc(ORDER);
      const res: any = await call(s, { order_ref: 'ORD-abc' });
      expect(res.data.outcome).toBe('order_not_found');
    });

    it('`external_id` bo`yicha izlaydi', async () => {
      const { s } = svc(ORDER);
      await call(s, { order_ref: 'EXT-9', order_ref_field: 'external_id' });
      expect((s as any).orderRepo.find).toHaveBeenCalledWith({
        where: { isDeleted: false, external_id: 'EXT-9' },
        take: 2,
      });
    });

    it('`qr_code_token` bo`yicha izlaydi', async () => {
      const { s } = svc(ORDER);
      await call(s, { order_ref: 'TOK-9', order_ref_field: 'qr_code_token' });
      expect((s as any).orderRepo.find).toHaveBeenCalledWith({
        where: { isDeleted: false, qr_code_token: 'TOK-9' },
        take: 2,
      });
    });

    it('⭐ noma`lum maydon nomi `where` ga TUSHMAYDI', async () => {
      /**
       * Maydon nomi foydalanuvchi sozlamasidan keladi — oq ro'yxatdan
       * tashqarisi `id` deb qabul qilinadi, to'g'ridan-to'g'ri `where` ga
       * qo'yilmaydi.
       */
      const { s } = svc(ORDER);
      await call(s, { order_ref_field: 'market_id; DROP TABLE' } as never);
      expect((s as any).orderRepo.find).toHaveBeenCalledWith({
        where: { isDeleted: false, id: '4021' },
        take: 2,
      });
    });
  });

  describe('QAYTARISH (refund)', () => {
    it('summa kamayadi va holat yangilanadi', async () => {
      const { s, updates } = svc({
        ...ORDER,
        paid_online_amount: 250000,
        payment_status: 'paid',
      });
      const res: any = await call(s, { status: 'refunded', amount: 100000 });

      expect(res.data.outcome).toBe('recorded');
      expect(res.data.paid_online_amount).toBe(150000);
      expect(res.data.payment_status).toBe('partly');
      // Qaytarish `GREATEST` bilan — 0 dan pastga tushmaydi.
      expect(updates[0].sql.join(' ')).toContain('GREATEST');
    });

    it('⭐ 0 dan pastga TUSHMAYDI', async () => {
      /**
       * Manfiy qoldiq "biz mijozga qarzdormiz" degan BOSHQA ma'noni
       * bildiradi va bu maydonda ifodalanmasligi kerak.
       */
      const { s } = svc({ ...ORDER, paid_online_amount: 50000 });
      const res: any = await call(s, { status: 'refunded', amount: 200000 });

      expect(res.data.paid_online_amount).toBe(0);
      expect(res.data.payment_status).toBeNull();
    });

    it('qaytarishda ORTIQCHA chegarasi qo`llanmaydi', async () => {
      // Qaytarish summani KAMAYTIRADI — narx chegarasi bu yerda ma'nosiz.
      const { s, updates } = svc({ ...ORDER, paid_online_amount: 250000 });
      const res: any = await call(s, { status: 'refunded', amount: 250000 });
      expect(res.data.outcome).toBe('recorded');
      expect(res.data.paid_online_amount).toBe(0);
      // Narx chegarasi qaytarishda QO'YILMAYDI — aks holda bloklardi.
      expect(updates[0].sql.join(' ')).not.toContain('<= "total_price" + 1');
    });
  });
});

describe('⭐ ADVERSARIAL TEKSHIRUVDAN kelgan tuzatishlar', () => {
  it('⭐ havola BIR NECHTA buyurtmaga mos kelsa RAD ETILADI', async () => {
    /**
     * `external_id` va `qr_code_token` ustunlari UNIQUE EMAS (indeks
     * ataylab unique qilinmagan — eski ma'lumotda dublikat bor). `findOne`
     * tartibsiz BITTASINI olardi, ya'ni to'lov BOSHQA mijozning
     * buyurtmasiga yozilishi mumkin edi.
     */
    const { s, updates } = svc(null, {
      matches: [
        { ...ORDER, id: '1' },
        { ...ORDER, id: '2' },
      ],
    });
    const res: any = await call(s, {
      order_ref: 'EXT-9',
      order_ref_field: 'external_id',
    });

    expect(res.data.outcome).toBe('order_ref_ambiguous');
    expect(res.data.matches).toBe(2);
    expect(updates).toHaveLength(0);
  });

  it('⭐ BOSHQA marketning buyurtmasiga yozilmaydi', async () => {
    /**
     * Ulanish marketga bog'langan bo'lsa, to'lov faqat o'sha marketning
     * buyurtmasiga yozilishi mumkin. Busiz bir marketning to'lov tizimi
     * (yoki kaliti qo'lga tushgan odam) ISTALGAN buyurtmani "to'langan"
     * deb belgilab, kuryerni naqd yig'ishdan to'sib qo'yardi.
     */
    const { s, updates, logs } = svc({ ...ORDER, market_id: '500' });
    const res: any = await call(s, { integration_market_id: '999' });

    expect(res.data.outcome).toBe('market_mismatch');
    expect(updates).toHaveLength(0);
    expect(logs[0].new_value).toMatchObject({ outcome: 'market_mismatch' });
  });

  it('o`z marketining buyurtmasiga yoziladi', async () => {
    const { s, updates } = svc({ ...ORDER, market_id: '500' });
    const res: any = await call(s, { integration_market_id: '500' });

    expect(res.data.outcome).toBe('recorded');
    expect(updates).toHaveLength(1);
  });

  it('ulanishda market bog`lanmagan bo`lsa tekshiruv o`tkazib yuboriladi', async () => {
    // Kompaniya umumiy merchant akkaunti — qonuniy holat.
    const { s } = svc({ ...ORDER, market_id: '500' });
    const res: any = await call(s, { integration_market_id: null });
    expect(res.data.outcome).toBe('recorded');
  });

  it('⭐ QAYTARISH yopilgan buyurtmada HAM qayd etiladi', async () => {
    /**
     * Ilgari "yopilgan" darvozasi qaytarishdan OLDIN turardi, ya'ni bekor
     * qilingan buyurtmaning qaytarilgan puli STRUKTURAVIY ravishda yozib
     * bo'lmasdi — aynan eng kerakli holat. Qaytarish majburiyat
     * yaratmaydi, u summani kamaytiradi.
     */
    const { s, updates } = svc({
      ...ORDER,
      status: Order_status.CANCELLED,
      paid_online_amount: 250000,
    });
    const res: any = await call(s, { status: 'refunded', amount: 250000 });

    expect(res.data.outcome).toBe('recorded');
    expect(updates).toHaveLength(1);
  });

  it('⭐ POYGADA chegara buzilsa to`lov qo`llanmaydi', async () => {
    /**
     * Atomik `WHERE` sharti bir vaqtda kelgan ikkinchi to'lovni to'sadi:
     * `affected === 0` → summa sig'maydi. Ilgari "o'qi → hisobla → yoz"
     * edi va bir to'lov ikkinchisini ustiga yozib, JIMGINA yo'qolardi.
     */
    const { s } = svc(ORDER, { affected: 0 });
    const res: any = await call(s, { amount: 100000 });

    expect(res.data.outcome).toBe('amount_exceeds_total');
    expect(res.data.race).toBe(true);
  });
});

describe("⭐ SOTUV OQIMI onlayn to'langan buyurtmani RAD ETADI", () => {
  /**
   * Butun kassa matematikasi kuryer MIJOZDAN NAQD YIG'GANIGA tayanadi:
   *
   *   courierIncome = total_price − courierShare   ← topshiriladigan naqd
   *   market        = total_price − market_tariff
   *   branchNet     = total_price − courierShare − branchShare
   *
   * Mijoz onlayn to'lagan bo'lsa naqd YO'Q, lekin formulalar o'zgarmaydi —
   * kuryer yig'MAGAN pulni topshirgandek yozilardi va kassa balansi
   * JIMGINA buzilardi. Bu turdagi xato eng qimmat: xato chiqmaydi, faqat
   * raqamlar noto'g'ri bo'ladi.
   *
   * Shu bois to'xtatiladi. Bugun holat yuzaga kelmaydi (provayder
   * ulanmagan), darvoza esa provayder ulangan KUNI ishlaydi.
   */
  const sellSvc = (order: Record<string, unknown>) => {
    const s = Object.create(
      OrderLifecycleService.prototype,
    ) as OrderLifecycleService & Record<string, any>;
    Object.assign(s, {
      findById: jest.fn().mockResolvedValue(order),
      hasRole: () => false,
      badRequest: (m: string) => {
        throw Object.assign(new Error(m), { statusCode: 400 });
      },
    });
    return s;
  };

  const WAITING = {
    id: '4021',
    status: Order_status.WAITING,
    post_id: '7',
    total_price: 250000,
  };

  it('`paid` holatida sotuv to`xtaydi', async () => {
    const s = sellSvc({
      ...WAITING,
      payment_status: 'paid',
      paid_online_amount: 250000,
    });

    await expect(
      s.sellOrder({ id: 'u1' }, '4021', {}),
    ).rejects.toThrow(/onlayn to‘langan/);
  });

  it('⭐ QISMAN to`lovda ham to`xtaydi', async () => {
    /**
     * Qisman to'lov eng chalkash holat: kuryer qolgan qismini yig'adi,
     * lekin oyoqlar to'liq narxdan hisoblanadi. Ya'ni bu ham buziladi.
     */
    const s = sellSvc({
      ...WAITING,
      payment_status: 'partly',
      paid_online_amount: 100000,
    });

    await expect(s.sellOrder({ id: 'u1' }, '4021', {})).rejects.toThrow(
      /onlayn to‘langan/,
    );
  });

  it('xabar SABABNI va summani aytadi', async () => {
    // Operator "nega sotib bo'lmayapti?" degan savolga javob olishi kerak.
    const s = sellSvc({
      ...WAITING,
      payment_status: 'paid',
      paid_online_amount: 250000,
    });

    await expect(s.sellOrder({ id: 'u1' }, '4021', {})).rejects.toThrow(
      /250000 so‘m/,
    );
  });

  it('⭐ QISMAN SOTUV ham to`xtaydi', async () => {
    /**
     * ADVERSARIAL TOPILMA (kritik). Darvoza faqat `sellOrder` da bor edi,
     * `partlySellOrder` esa AYNI kassa matematikasini bajaradi — ya'ni
     * darvozani chetlab o'tishning tayyor yo'li qolgan edi.
     */
    const s = sellSvc({
      ...WAITING,
      payment_status: 'paid',
      paid_online_amount: 250000,
    });

    await expect(
      s.partlySellOrder({ id: 'u1' }, '4021', {
        order_item_info: [],
        totalPrice: 100000,
      }),
    ).rejects.toThrow(/onlayn to‘langan/);
  });

  it('⭐ BO`SH SATR "to`lov yo`q" deb qabul qilinadi', async () => {
    /**
     * Bo'sh satrni "to'langan" deb o'qish BARCHA oddiy buyurtmalarni to'sib
     * qo'yardi — ya'ni tizim ishdan chiqardi.
     */
    const s = sellSvc({ ...WAITING, payment_status: '   ' });
    await expect(s.sellOrder({ id: 'u1' }, '4021', {})).rejects.not.toThrow(
      /onlayn to‘langan/,
    );
  });

  it('⭐ ODDIY (COD) buyurtma ta`sirlanmaydi', async () => {
    /**
     * Eng muhim tekshiruv: darvoza mavjud oqimga tegmasligi kerak.
     * `payment_status: null` → sotuv davom etadi (keyingi qadamda post
     * izlaydi, bu test uni u yergacha olib boradi).
     */
    const s = sellSvc({ ...WAITING, payment_status: null });
    await expect(s.sellOrder({ id: 'u1' }, '4021', {})).rejects.not.toThrow(
      /onlayn to‘langan/,
    );
  });
});
