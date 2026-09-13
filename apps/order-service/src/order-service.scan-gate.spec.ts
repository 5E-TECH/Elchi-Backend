import { Order_status } from '@app/common';
import { Order_source } from './entities/order.entity';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

/**
 * 2-BOSQICH: SKAN DARVOZASI SERVERDA.
 *
 * MUAMMO (audit K2). `receiveNewOrders` faqat `status = NEW` va filial
 * doirasini tekshirardi — `source` haqida shart YO'Q edi. Hamkor/sayt
 * posilkalari oddiy "Marketlar" ro'yxatida market buyurtmalari bilan
 * ARALASH turardi va operator ularni bitta tugma bilan OMMAVIY qabul
 * qilardi. Skan darvozasi FAQAT FRONTENDDA edi, ya'ni boshqa ekrandan yoki
 * to'g'ridan-to'g'ri API'dan chetlab o'tish mumkin edi.
 *
 * Oqibati javobgarlik (custody) buzilishi: posilka hali hamkor omborida
 * bo'lishi mumkin, Elchi esa "qabul qildim" deb yozib qo'yadi.
 */

type OrderRow = {
  id: string;
  status: Order_status;
  source: Order_source;
  qr_code_token?: string | null;
  branch_id?: string | null;
};

function makeSvc(rows: OrderRow[]) {
  const svc = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService & Record<string, any>;

  const orderRepo = {
    find: jest.fn((opts: any) => {
      const w = opts?.where ?? {};
      return Promise.resolve(
        rows.filter((r) => {
          if (w.status && r.status !== w.status) return false;
          if (w.source && r.source !== w.source) return false;
          // `In(tokens)` — TypeORM obyektidan qiymatlarni olamiz.
          const tokenFilter = w.qr_code_token?._value ?? w.qr_code_token?.value;
          if (Array.isArray(tokenFilter)) {
            if (!tokenFilter.includes(r.qr_code_token)) return false;
          }
          const idFilter = w.id?._value ?? w.id?.value;
          if (Array.isArray(idFilter) && !idFilter.includes(r.id)) return false;
          return true;
        }),
      );
    }),
    findOne: jest.fn((opts: any) =>
      Promise.resolve(
        rows.find((r) => r.qr_code_token === opts?.where?.qr_code_token) ?? null,
      ),
    ),
  };

  Object.assign(svc, {
    orderRepo,
    resolveReceiveBranchScope: jest.fn().mockResolvedValue(null),
    badRequest: (m: string) => {
      throw Object.assign(new Error(m), { statusCode: 400 });
    },
    notFound: (m: string) => {
      throw Object.assign(new Error(m), { statusCode: 404 });
    },
  });
  return { svc, orderRepo };
}

const row = (over: Partial<OrderRow> = {}): OrderRow => ({
  id: '1',
  status: Order_status.NEW,
  source: Order_source.INTERNAL,
  qr_code_token: 'tok-1',
  branch_id: null,
  ...over,
});

describe('K2 — oddiy qabul TASHQI posilkani rad etadi', () => {
  it('⭐ tashqi manbali buyurtma oddiy yo\'ldan QABUL QILINMAYDI', async () => {
    const { svc } = makeSvc([row({ source: Order_source.EXTERNAL })]);
    await expect(
      (svc as any).receiveNewOrders(['1']),
    ).rejects.toThrow(/skanerlab qabul qilinadi/);
  });

  it('⭐ ARALASH to\'da bo\'lsa BUTUN so\'rov rad etiladi', async () => {
    /**
     * Qolganini jimgina qabul qilmaymiz — aks holda operator hammasini
     * qabul qildim deb o'ylardi va tashqi posilka jimgina qolib ketardi.
     */
    const { svc } = makeSvc([
      row({ id: '1', source: Order_source.INTERNAL }),
      row({ id: '2', source: Order_source.EXTERNAL, qr_code_token: 'tok-2' }),
    ]);
    await expect(
      (svc as any).receiveNewOrders(['1', '2']),
    ).rejects.toThrow(/tashqi manbadan/);
  });

  it('⭐ `scanVerified` bayrog\'i bilan o\'tadi (ichki chaqiruv)', async () => {
    /**
     * Bayroq message payload'idan KELMAYDI — faqat
     * `receiveExternalByScan` beradi, u tokenni allaqachon tekshirgan.
     * Bu yerda tekshiramiz: darvoza bayroqqa qarab ochiladi.
     */
    const { svc } = makeSvc([row({ source: Order_source.EXTERNAL })]);
    // Keyingi qadam (mijoz tekshiruvi) mock qilinmagan → boshqa xato chiqadi,
    // bizga faqat SKAN xatosi BO'LMAGANI muhim.
    await expect(
      (svc as any).receiveNewOrders(['1'], undefined, null, {
        scanVerified: true,
      }),
    ).rejects.not.toThrow(/skanerlab qabul qilinadi/);
  });

  it('ichki buyurtma avvalgidek qabul qilinadi', async () => {
    const { svc } = makeSvc([row({ source: Order_source.INTERNAL })]);
    await expect((svc as any).receiveNewOrders(['1'])).rejects.not.toThrow(
      /skanerlab/,
    );
  });
});

describe('receiveExternalByScan — token qo\'riqchisi', () => {
  it('token bo\'sh bo\'lsa 400', async () => {
    const { svc } = makeSvc([]);
    await expect(
      (svc as any).receiveExternalByScan({ tokens: [] }),
    ).rejects.toThrow(/tokens is required/);
  });

  it('⭐ 200 dan ko\'p token rad etiladi', async () => {
    // Mingtalik so'rov tranzaksiyani uzoq ushlab turardi.
    const { svc } = makeSvc([]);
    const many = Array.from({ length: 201 }, (_, i) => `t${i}`);
    await expect(
      (svc as any).receiveExternalByScan({ tokens: many }),
    ).rejects.toThrow(/200 tadan/);
  });

  it('takroriy token bir marta hisoblanadi', async () => {
    const { svc, orderRepo } = makeSvc([]);
    await (svc as any).receiveExternalByScan({ tokens: ['a', 'a', 'a'] });
    const where = orderRepo.find.mock.calls[0][0].where;
    const vals = where.qr_code_token?._value ?? where.qr_code_token?.value;
    expect(vals).toEqual(['a']);
  });

  it('⭐ topilmagan token SABABI bilan qaytadi — jimgina tashlanmaydi', async () => {
    /**
     * Bitta umumiy "topilmadi" operatorni ko'r qoldirardi: token boshqa
     * manbadan, allaqachon qabul qilingan yoki umuman yo'q bo'lishi mumkin —
     * bular uch xil harakat talab qiladi.
     */
    const { svc } = makeSvc([
      row({ id: '9', source: Order_source.INTERNAL, qr_code_token: 'ichki' }),
      row({
        id: '8',
        source: Order_source.EXTERNAL,
        status: Order_status.RECEIVED,
        qr_code_token: 'allaqachon',
      }),
    ]);

    const res = (await (svc as any).receiveExternalByScan({
      tokens: ['ichki', 'allaqachon', 'yoq'],
    })) as { data: { received: number; unmatched: Array<{ token: string; reason: string }> } };

    expect(res.data.received).toBe(0);
    const byToken = Object.fromEntries(
      res.data.unmatched.map((u) => [u.token, u.reason]),
    );
    expect(byToken['ichki']).toMatch(/tashqi posilka emas/);
    expect(byToken['allaqachon']).toMatch(/received/);
    expect(byToken['yoq']).toMatch(/topilmadi/);
  });

  it('⭐ faqat NEW + EXTERNAL qatorlar so\'raladi', async () => {
    const { svc, orderRepo } = makeSvc([]);
    await (svc as any).receiveExternalByScan({ tokens: ['a'] });
    const where = orderRepo.find.mock.calls[0][0].where;
    expect(where.status).toBe(Order_status.NEW);
    expect(where.source).toBe(Order_source.EXTERNAL);
    expect(where.isDeleted).toBe(false);
  });
});
