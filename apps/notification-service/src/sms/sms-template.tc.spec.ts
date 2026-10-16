import { Logger } from '@nestjs/common';
import type { SmsTemplate } from '../entities/sms-template.entity';
import { countSmsSegments, nonGsm7Chars } from './sms-segments.util';
import { SmsOtpService } from './sms-otp.service';
import {
  SmsTemplateError,
  SmsTemplateService,
  isPiiVar,
  previewSmsText,
  renderSmsTemplate,
} from './sms-template.service';

/**
 * nkhURiKX — kartaning "Tekshiruv" TC'lari (backend qismi) bir joyda.
 * Real Postgres (056 users.language, UNIQUE (code, lang)):
 * sms-templates.pg.spec.ts.
 */
const latin = (n: number) => 'a'.repeat(n);
const cyr = (n: number) => 'ж'.repeat(n);

type Row = Partial<SmsTemplate> & { id: string };

/** Xotiradagi soxta repo — `where` ni haqiqatan filtrlaydi (mock zanjiri emas). */
const memoryRepo = (rows: Row[]) => {
  let seq = rows.length;
  const match = (where: Record<string, unknown>) => (row: Row) =>
    Object.entries(where).every(
      ([key, value]) => (row as Record<string, unknown>)[key] === value,
    );
  return {
    rows,
    find: jest.fn(() => Promise.resolve([...rows])),
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.find(match(where)) ?? null),
    ),
    findOneOrFail: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      const found = rows.find(match(where));
      return found ? Promise.resolve(found) : Promise.reject(new Error('404'));
    }),
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((value: Row) => {
      const index = value.id
        ? rows.findIndex((row) => row.id === value.id)
        : -1;
      const saved = { ...value, id: value.id ?? String(++seq) };
      if (index >= 0) rows[index] = saved;
      else rows.push(saved);
      return Promise.resolve(saved);
    }),
    update: jest.fn((where: { id: string }, patch: Partial<Row>) => {
      const row = rows.find((item) => item.id === where.id);
      if (row) Object.assign(row, patch);
      return Promise.resolve({ affected: row ? 1 : 0 });
    }),
    delete: jest.fn(),
  };
};

describe('nkhURiKX — render (fail-closed)', () => {
  it("TC3: required_vars dagi o'zgaruvchi berilmasa render XATO — bo'sh satr qo'yilmaydi", () => {
    // `amount` matnda yo'q, lekin required_vars da — baribir xato.
    let error: unknown;
    try {
      renderSmsTemplate(
        'Buyurtma #{{order_number}} yetkazildi',
        { order_number: 'EL-1' },
        ['order_number', 'amount'],
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SmsTemplateError);
    expect((error as SmsTemplateError).missing).toEqual(['amount']);

    for (const blank of [undefined, null, '', '   ', {}]) {
      expect(() =>
        renderSmsTemplate(
          'Hurmatli mijoz, #{{order_number}} yetkazildi',
          { order_number: blank },
          ['order_number'],
        ),
      ).toThrow(SmsTemplateError);
    }
  });

  it("TC4: barcha o'zgaruvchilar berilganda render to'g'ri matn beradi", () => {
    expect(
      renderSmsTemplate(
        "Buyurtma #{{order_number}}: {{ status }}. Summa: {{amount}} so'm",
        { order_number: 'EL-1042', status: 'yetkazildi', amount: 125000 },
        ['order_number', 'status', 'amount'],
      ),
    ).toBe("Buyurtma #EL-1042: yetkazildi. Summa: 125000 so'm");
  });
});

describe("nkhURiKX — GSM-7/UCS-2 bo'laklari", () => {
  it('TC5: 160 ta lotin belgi → GSM-7, parts=1', () => {
    expect(countSmsSegments(latin(160))).toMatchObject({
      encoding: 'GSM-7',
      parts: 1,
    });
  });

  it('TC6: 161 ta lotin belgi → parts=2 (153 qoidasi)', () => {
    expect(countSmsSegments(latin(161))).toMatchObject({
      encoding: 'GSM-7',
      parts: 2,
      perPart: 153,
    });
  });

  it('TC7: 70 ta kirill belgi → UCS-2, parts=1', () => {
    expect(countSmsSegments(cyr(70))).toMatchObject({
      encoding: 'UCS-2',
      parts: 1,
    });
  });

  it("TC8: lotin matnga bitta 'ё' qo'shilsa UCS-2 ga o'tadi va parts qayta hisoblanadi", () => {
    const before = countSmsSegments(latin(100));
    const after = countSmsSegments(latin(100) + 'ё');
    expect(before).toMatchObject({ encoding: 'GSM-7', parts: 1 });
    expect(after).toMatchObject({ encoding: 'UCS-2', units: 101, parts: 2 });
    // Muharrir qaysi belgi aybdorligini ko'rsata oladi.
    expect(nonGsm7Chars(latin(100) + 'ё')).toEqual(['ё']);
    expect(nonGsm7Chars('Yo‘l 😀 yo‘l')).toEqual(['‘', '😀']);
    expect(nonGsm7Chars('{Buyurtma} €')).toEqual([]);
  });
});

describe('nkhURiKX — mijoz tili', () => {
  const rows = (): Row[] => [
    {
      id: '1',
      code: 'otp.login',
      lang: 'uz',
      message_class: 'security',
      text: 'Elchi kodi: {{code}}',
      required_vars: ['code'],
      is_active: true,
    },
    {
      id: '2',
      code: 'otp.login',
      lang: 'ru',
      message_class: 'security',
      text: 'Код Elchi: {{code}}',
      required_vars: ['code'],
      is_active: true,
    },
  ];
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => warn.mockRestore());

  const otp = (repo: ReturnType<typeof memoryRepo>) => {
    const outbox = {
      enqueue: jest.fn().mockResolvedValue({ queued: [{ id: '1' }] }),
    };
    const service = new SmsOtpService(
      outbox as never,
      { hasAccount: jest.fn().mockResolvedValue(true) } as never,
      new SmsTemplateService(repo as never),
    );
    const sentText = () =>
      (outbox.enqueue.mock.calls[0][0] as Array<{ text: string }>)[0].text;
    return { service, outbox, sentText };
  };

  it("TC9: mijoz tili 'ru' bo'lsa ruscha shablon tanlanadi (OTP: identity users.language → lang)", async () => {
    const { service, sentText } = otp(memoryRepo(rows()));
    await service.send({
      phone: '+998901234567',
      code: '4821',
      otp_id: '7',
      lang: 'ru',
    });
    expect(sentText()).toBe('Код Elchi: 4821');
    expect(warn).not.toHaveBeenCalled();
  });

  it("TC10: ruscha shablon yo'q bo'lsa 'uz' ga fallback va bu LOGDA ko'rinadi", async () => {
    const onlyUz = rows().filter((row) => row.lang === 'uz');
    const { service, sentText } = otp(memoryRepo(onlyUz));
    await service.send({
      phone: '+998901234567',
      code: '4821',
      otp_id: '8',
      lang: 'ru',
    });
    expect(sentText()).toBe('Elchi kodi: 4821');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/otp\.login.*ru.*uz' ga fallback/),
    );
  });

  it("til noma'lum/bo'sh → 'uz' (ogohlantirishsiz); nofaol ruscha shablon tanlanmaydi", async () => {
    const repo = memoryRepo(rows());
    const templates = new SmsTemplateService(repo as never);
    expect((await templates.resolve('otp.login', null))?.lang).toBe('uz');
    expect((await templates.resolve('otp.login', 'de'))?.lang).toBe('uz');
    expect(warn).not.toHaveBeenCalled();
    repo.rows[1].is_active = false;
    expect((await templates.resolve('otp.login', 'ru'))?.lang).toBe('uz');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('OTP shablonining required_vars i ham fail-closed: yetishmasa SMS navbatga TUSHMAYDI', async () => {
    const broken = rows().map((row) => ({
      ...row,
      required_vars: ['code', 'order_number'],
    }));
    const { service, outbox } = otp(memoryRepo(broken));
    await expect(
      service.send({
        phone: '+998901234567',
        code: '4821',
        otp_id: '9',
        lang: 'uz',
      }),
    ).rejects.toBeInstanceOf(SmsTemplateError);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe("nkhURiKX — provayder tasdig'i", () => {
  it("TC12: matn o'zgargach provider_template_id bo'shaydi va tasdiq kerak holati ko'rinadi", async () => {
    const repo = memoryRepo([]);
    const service = new SmsTemplateService(repo as never);
    const created = await service.upsert({
      code: 'order.delivered',
      message_class: 'transactional',
      lang: 'uz',
      text: 'Buyurtma #{{order_number}} yetkazildi',
    });
    expect(created.needs_provider_approval).toBe(true);

    const approved = await service.markApproved(created.id, 'ESKIZ-77');
    expect(approved).toMatchObject({
      provider_template_id: 'ESKIZ-77',
      needs_provider_approval: false,
    });

    // Faqat is_active o'zgarsa — tasdiq saqlanadi.
    const toggled = await service.upsert({
      code: 'order.delivered',
      message_class: 'transactional',
      lang: 'uz',
      text: 'Buyurtma #{{order_number}} yetkazildi',
      is_active: false,
    });
    expect(toggled.provider_template_id).toBe('ESKIZ-77');

    const edited = await service.upsert({
      code: 'order.delivered',
      message_class: 'transactional',
      lang: 'uz',
      text: 'Buyurtma #{{order_number}} topshirildi',
    });
    expect(edited).toMatchObject({
      id: created.id,
      provider_template_id: null,
      needs_provider_approval: true,
    });
    const listed = (await service.list()).map((row) => service.withMeta(row));
    expect(listed).toEqual([
      expect.objectContaining({
        code: 'order.delivered',
        needs_provider_approval: true,
      }),
    ]);
    expect(repo.rows).toHaveLength(1);
  });
});

describe('nkhURiKX — PII minimumi', () => {
  it("TC13: mijoz ismi/manzili/mahsulot ro'yxati o'zgaruvchilari taqiqlangan (naqshlar bilan)", () => {
    for (const key of [
      'name',
      'customer_name',
      'Customer_Full_Name',
      'client_name',
      'receiver_name',
      'recipient_address',
      'mijoz_ism',
      'fio',
      'address',
      'manzil',
      'products',
      'product_list',
      'product_names',
      'items',
      'order_items',
      'mahsulotlar',
      'tovar_royxati',
    ]) {
      expect({ key, pii: isPiiVar(key) }).toEqual({ key, pii: true });
    }
    for (const key of [
      'order_number',
      'status',
      'amount',
      'code',
      'discount',
      'market_name',
      'branch_name',
      'items_count',
      'customer_id',
    ]) {
      expect({ key, pii: isPiiVar(key) }).toEqual({ key, pii: false });
    }
  });

  it("TC13: upsert PII o'zgaruvchili shablonni rad etadi (matnda ham, required_vars da ham) — DB ga yozilmaydi", async () => {
    const repo = memoryRepo([]);
    const service = new SmsTemplateService(repo as never);
    await expect(
      service.upsert({
        code: 'order.x',
        message_class: 'transactional',
        lang: 'uz',
        text: "Hurmatli {{client_name}}, buyurtmangiz yo'lda",
      }),
    ).rejects.toThrow(/PII/);
    await expect(
      service.upsert({
        code: 'order.y',
        message_class: 'transactional',
        lang: 'uz',
        text: "Buyurtma #{{order_number}} yo'lda",
        required_vars: ['product_names'],
      }),
    ).rejects.toThrow(/product_names/);
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('nkhURiKX — muharrir hisoblagichi (preview endpoint backend qismi)', () => {
  const deps = {
    tariff: (cls: string) => (cls === 'promo' ? 175 : 95),
    appendOptOut: (text: string) => `${text}\nRad etish: https://e.uz/s/abc`,
  };

  it("TC11: matn o'zgarganda bo'lak va taxminiy narx shu zahoti qayta hisoblanadi", () => {
    const short = previewSmsText({ text: 'Buyurtma yetkazildi' }, deps);
    expect(short).toMatchObject({
      message_class: 'transactional',
      encoding: 'GSM-7',
      parts: 1,
      per_part: 160,
      non_gsm_chars: [],
      currency: 'UZS',
      tariff: 95,
      estimated_cost: 95,
    });
    const withYo = previewSmsText({ text: 'Buyurtma yetkazildi ё' }, deps);
    expect(withYo).toMatchObject({
      encoding: 'UCS-2',
      per_part: 70,
      non_gsm_chars: ['ё'],
    });
    const longRu = previewSmsText({ text: cyr(71) }, deps);
    expect(longRu).toMatchObject({
      encoding: 'UCS-2',
      parts: 2,
      per_part: 67,
      estimated_cost: 190,
    });
    expect(previewSmsText({ text: latin(160) }, deps).parts).toBe(1);
    expect(previewSmsText({ text: latin(161) }, deps).parts).toBe(2);
    expect(previewSmsText({ text: cyr(70) }, deps)).toMatchObject({
      encoding: 'UCS-2',
      parts: 1,
    });
    expect(previewSmsText({ text: '' }, deps)).toMatchObject({
      parts: 0,
      estimated_cost: 0,
    });
  });

  it('tarif sozlanmagan → narx null (0 emas)', () => {
    expect(previewSmsText({ text: 'x' }, { tariff: () => null })).toMatchObject(
      { tariff: null, estimated_cost: null },
    );
  });

  it("reklama: bekor qilish havolasi bo'lak hisobiga KIRADI (kampaniya prognozi bilan bir xil)", () => {
    const text = latin(150);
    const promo = previewSmsText({ text, message_class: 'promo' }, deps);
    expect(promo).toMatchObject({
      opt_out_included: true,
      parts: 2,
      tariff: 175,
      estimated_cost: 350,
    });
    const tx = previewSmsText({ text, message_class: 'transactional' }, deps);
    expect(tx).toMatchObject({ opt_out_included: false, parts: 1 });
    // Havola sozlanmagan bo'lsa — matnning o'zi sanaladi.
    expect(
      previewSmsText(
        { text, message_class: 'promo' },
        { tariff: deps.tariff, appendOptOut: () => null },
      ),
    ).toMatchObject({ opt_out_included: false, parts: 1 });
  });

  it("namuna qiymatlar bilan to'ldirilgan matn sanaladi; yetishmagani missing_vars; PII pii_vars da", () => {
    const filled = previewSmsText(
      {
        text: 'Заказ #{{order_number}} доставлен',
        vars: { order_number: 'EL-1042' },
      },
      deps,
    );
    expect(filled).toMatchObject({
      rendered: 'Заказ #EL-1042 доставлен',
      vars: ['order_number'],
      missing_vars: [],
      pii_vars: [],
      encoding: 'UCS-2',
    });
    const missing = previewSmsText(
      {
        text: 'Hurmatli {{customer_name}}, #{{order_number}}',
        required_vars: ['amount'],
        vars: { order_number: '1' },
      },
      deps,
    );
    expect(missing).toMatchObject({
      rendered: null,
      missing_vars: ['amount', 'customer_name'],
      pii_vars: ['customer_name'],
    });
  });

  it("noto'g'ri message_class / 1000 dan uzun matn — SmsTemplateError (RPC 400)", () => {
    expect(() =>
      previewSmsText({ text: 'x', message_class: 'spam' }, deps),
    ).toThrow(SmsTemplateError);
    expect(() => previewSmsText({ text: latin(1001) }, deps)).toThrow(
      SmsTemplateError,
    );
  });
});
