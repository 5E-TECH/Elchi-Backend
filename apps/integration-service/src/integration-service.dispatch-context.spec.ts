import { IntegrationServiceService } from './integration-service.service';

/**
 * C3 — DISPATCH SHABLONIDAGI `{{...}}` BO'SH SATRGA AYLANARDI.
 *
 * Kontekst FAQAT chaqiruvchidan kelardi, frontend esa faqat `{ order_id }`
 * yuborardi. Ya'ni `{{customer_name}}`, `{{cod_amount}}`, `{{address}}` —
 * hammasi bo'sh.
 *
 * Bu PUL xavfi: kargo `cod_amount` ni bo'sh/0 olsa, kuryer mijozdan HECH
 * NARSA undirmaydi. PCS'da aynan shu turdagi xato bir marta yuz bergan.
 *
 * Endi kontekst BUYURTMADAN yig'iladi, chaqiruvchi faqat ustiga yozadi.
 */

const ORDER = {
  data: {
    id: '1001',
    order_number: 100042,
    total_price: 500000,
    to_be_paid: 450000,
    address: 'Chilonzor 5',
    comment: 'Eshik oldida',
    customer: {
      name: 'Ali Valiyev',
      phone_number: '+998901112233',
      extra_number: '+998939998877',
    },
    district: { name: 'Asaka', sato_code: '1726269' },
    region: { name: 'Andijon' },
    items: [
      { product_name: 'Telefon', quantity: 2 },
      { product_name: 'Quloqchin', quantity: 1 },
    ],
  },
};

function svc(over: Record<string, unknown> = {}) {
  const calls: Record<string, any>[] = [];
  const s = Object.create(
    IntegrationServiceService.prototype,
  ) as IntegrationServiceService & Record<string, any>;
  Object.assign(
    s,
    {
      // ⚠️ `dispatchShipment` `integrationRepo.findOne` ishlatadi,
      // `findActiveBySlug` EMAS.
      integrationRepo: {
        findOne: jest.fn().mockResolvedValue({
          id: '5',
          slug: 'ldg',
          name: 'LDG',
          // Yangi qo'riqchilar: o'chirilgan yoki kargo bo'lmagan ulanishga
          // posilka jo'natilmaydi (audit H1, H2).
          is_active: true,
          role: 'carrier',
          dispatch_config: {
            endpoint: '/v1/orders',
            method: 'POST',
            body_template: {
              receiver: '{{customer_name}}',
              phone: '{{customer_phone}}',
              cod: '{{cod_amount}}',
              addr: '{{address}}',
              note: '{{items}}',
            },
          },
        }),
      },
      orderClient: { send: jest.fn() },
      rmqRequest: jest.fn().mockResolvedValue(ORDER),
      executeExternalRequest: jest.fn((args: Record<string, any>) => {
        calls.push(args);
        return Promise.resolve({ ok: true, status: 200, body: {} });
      }),
      upsertShipment: jest.fn().mockResolvedValue({}),
      activityLog: { log: jest.fn().mockResolvedValue(undefined) },
      auditActor: () => ({}),
      interpolate: IntegrationServiceService.prototype['interpolate'],
      badRequest: (m: string) => {
        throw Object.assign(new Error(m), { statusCode: 400 });
      },
      logger: { warn: jest.fn() },
    },
    over,
  );
  return { s, calls };
}

const dispatch = async (
  over: Record<string, unknown> = {},
  ctx?: Record<string, string>,
) => {
  const { s, calls } = svc(over);
  await (s as any).dispatchShipment({ order_id: '1001', context: ctx });
  return calls[0]?.body as Record<string, unknown>;
};

describe("C3 — kontekst buyurtmadan yig'iladi", () => {
  it('⭐ mijoz ismi va telefoni shablonga tushadi', async () => {
    const body = await dispatch();
    expect(body.receiver).toBe('Ali Valiyev');
    expect(body.phone).toBe('+998901112233');
  });

  it("⭐ `cod_amount` TO'LDIRILADI — eng muhim maydon", async () => {
    /**
     * Bo'sh qolsa kargo mijozdan hech narsa undirmaydi. Jo'natish sotuvdan
     * OLDIN bo'ladi, shu bois `to_be_paid` bu yerda to'g'ri ma'noda.
     */
    const body = await dispatch();
    expect(body.cod).toBe('450000');
  });

  it("manzil va mahsulot ro'yxati ham ketadi", async () => {
    const body = await dispatch();
    expect(body.addr).toBe('Chilonzor 5');
    expect(body.note).toBe('Telefon x2, Quloqchin x1');
  });

  it('⭐ chaqiruvchi kontekst USTIGA yozadi', async () => {
    const body = await dispatch({}, { customer_name: 'Boshqa Ism' });
    expect(body.receiver).toBe('Boshqa Ism');
  });

  it("⭐ to'ldirilmagan o'rin egallari OGOHLANTIRISH bilan yoziladi", async () => {
    /**
     * `interpolate` yo'q kalitni BO'SH SATR qiladi (`:2450`), ya'ni maydon
     * jimgina bo'sh ketadi. Birinchi yozganimda "`{{...}}` o'z holida
     * qoladi" deb izoh yozgan edim — bu YOLG'ON edi va testim shuni tutdi.
     *
     * Jo'natish to'xtamaydi (ba'zi maydon ataylab bo'sh bo'lishi mumkin),
     * lekin ro'yxat logda qoladi.
     */
    const { s, calls } = svc({
      rmqRequest: jest.fn().mockResolvedValue({
        data: { id: '1001', customer: {} },
      }),
    });
    await (s as any).dispatchShipment({ order_id: '1001' });

    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.receiver).toBe('');

    const warned = String(
      (s.logger.warn as jest.Mock).mock.calls[0]?.[0] ?? '',
    );
    expect(warned).toMatch(/to'ldirilmagan o'rin egallari/);
    expect(warned).toMatch(/customer_name/);
    expect(warned).toMatch(/cod_amount/);
  });

  it("buyurtma o'qilmasa ham yiqilmaydi (order_id qoladi)", async () => {
    // `rmqRequest` xatoni yutib null qaytaradi — dispatch to'xtamasligi kerak.
    const body = await dispatch({
      rmqRequest: jest.fn().mockResolvedValue(null),
    });
    expect(body).toBeDefined();
  });

  it("`dispatch_config.endpoint` bo'lmasa 400", async () => {
    await expect(
      dispatch({
        integrationRepo: {
          findOne: jest.fn().mockResolvedValue({
            id: '5',
            slug: 'ldg',
            name: 'LDG',
            is_active: true,
            role: 'carrier',
            dispatch_config: {},
          }),
        },
      }),
    ).rejects.toThrow(/endpoint is required/);
  });
});

describe("H1 / H2 — kill-switch va rol qo'riqchilari", () => {
  const withIntegration = (over: Record<string, unknown>) =>
    dispatch({
      integrationRepo: {
        findOne: jest.fn().mockResolvedValue({
          id: '5',
          slug: 'ldg',
          name: 'LDG',
          is_active: true,
          role: 'carrier',
          dispatch_config: { endpoint: '/v1/orders', method: 'POST' },
          ...over,
        }),
      },
    });

  it("⭐ O'CHIRILGAN ulanishga posilka jo'natilmaydi", async () => {
    /**
     * `is_active` TEKSHIRILMASDI: "to'xtatish" tugmasi jo'natishni to'smasdi
     * va operator ulanish o'chiq deb o'ylab yurardi.
     */
    await expect(withIntegration({ is_active: false })).rejects.toThrow(
      /o'chirilgan/,
    );
  });

  it("⭐ TO'LOV tizimiga posilka jo'natilmaydi", async () => {
    /**
     * Rol tekshirilmasdi. Bu nafaqat ma'nosiz: sotuvda ular uchun COD QARZI
     * yozilardi (`recordProviderReceivable`), ya'ni soxta qarz paydo
     * bo'lardi va hisob-kitob buzilardi.
     */
    await expect(withIntegration({ role: 'payment' })).rejects.toThrow(
      /yetkazuvchi emas/,
    );
  });

  it("KO'ZGU va MANBA ham rad etiladi", async () => {
    await expect(withIntegration({ role: 'mirror' })).rejects.toThrow(
      /yetkazuvchi emas/,
    );
    await expect(withIntegration({ role: 'source' })).rejects.toThrow(
      /yetkazuvchi emas/,
    );
  });

  it("⭐ rol BELGILANMAGAN bo'lsa o'tadi — eski yozuvlar buzilmasin", async () => {
    /**
     * Migratsiyadan oldingi yozuvlarda `role` NULL bo'lishi mumkin. Ularni
     * to'sish ishlab turgan kargoni to'xtatib qo'yardi — xato tuzatish
     * o'rniga yangi xato.
     */
    await expect(withIntegration({ role: null })).resolves.toBeDefined();
  });

  it('faol yetkazuvchi avvalgidek ishlaydi', async () => {
    await expect(
      withIntegration({ is_active: true, role: 'carrier' }),
    ).resolves.toBeDefined();
  });
});
