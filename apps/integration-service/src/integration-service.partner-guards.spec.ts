import { IntegrationServiceService } from './integration-service.service';
import { Order_status } from '@app/common';

/**
 * 1-BOSQICH: HAMKOR YO'LINING IKKI QO'RIQCHISI.
 *
 * F3 — MARKET EGALIGI (IDOR). Ilgari `elchi_market_id` faqat MAVJUDLIGI
 * tekshirilardi. Har hamkor so'rovi ichkarida `Roles.SUPERADMIN` bilan
 * bajariladi, ya'ni tekshiruvsiz market id = to'liq huquqli IDOR: hamkor B
 * boshqa hamkorning yoki ichki marketning id'sini yozib, o'sha marketga
 * buyurtma va pul harakati yaratardi.
 *
 * F4 — BEKOR QILISH. `order.cancel` `WAITING` + pochta talab qiladi. Hamkor
 * posilkasi esa `NEW` da turadi va mijoz aynan shu oynada bekor qiladi.
 * Ilgari shu holatda `order.cancel` chaqirilib, xatosi yutilib hamkorga
 * 502 qaytardi.
 */

function svcWith(over: Record<string, unknown> = {}) {
  const svc = Object.create(
    IntegrationServiceService.prototype,
  ) as IntegrationServiceService & Record<string, any>;
  Object.assign(
    svc,
    {
      partnerMarketRefRepo: { findOne: jest.fn().mockResolvedValue(null) },
      partnerShipmentRefRepo: { findOne: jest.fn().mockResolvedValue(null) },
      identityClient: {},
      orderClient: {},
      activityLog: { log: jest.fn().mockResolvedValue(undefined) },
      rmqRequest: jest.fn().mockResolvedValue(null),
      rmqRequestStrict: jest.fn().mockResolvedValue({ data: { id: '1' } }),
      pluck: (o: any, k: string) => o?.data?.[k] ?? o?.[k],
      pluckId: (o: any) => o?.data?.id ?? o?.id ?? null,
    },
    over,
  );
  return svc;
}

const baseShipment = {
  partner_id: '7',
  external_order_id: 'EXT-1',
  elchi_market_id: '500',
  customer: { name: 'Ali', phone: '+998901234567' },
  district_id: '12',
  cod_amount: 100000,
};

describe("F3 — market egaligi (IDOR qo'riqchisi)", () => {
  it("⭐ bog'lanish YO'Q bo'lsa 403 — buyurtma YARATILMAYDI", async () => {
    const svc = svcWith();
    await expect(
      (svc as any).createPartnerShipment({ ...baseShipment }),
    ).rejects.toMatchObject({ error: { statusCode: 403 } });
    // Mijoz ham yaratilmasligi kerak — tekshiruv eng boshida turadi.
    expect(svc.rmqRequest).not.toHaveBeenCalled();
  });

  it('⭐ boshqa hamkorning marketi ham 403 — "yo\'q" bilan bir xil javob', async () => {
    /**
     * Ataylab: "mavjud emas" va "sizning emas" BIR XIL javob beradi. Aks
     * holda hamkor id'larni sanab chiqib qaysi market mavjudligini
     * aniqlay olardi.
     */
    const svc = svcWith({
      partnerMarketRefRepo: {
        // Repo `partner_id` bo'yicha filtrlaydi → boshqa hamkorda null.
        findOne: jest.fn().mockResolvedValue(null),
      },
    });
    await expect(
      (svc as any).createPartnerShipment({
        ...baseShipment,
        elchi_market_id: '999',
      }),
    ).rejects.toMatchObject({ error: { statusCode: 403 } });
  });

  it("egalik tekshiruvi `partner_id` VA `elchi_market_id` bo'yicha", async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const svc = svcWith({ partnerMarketRefRepo: { findOne } });
    await expect(
      (svc as any).createPartnerShipment({ ...baseShipment }),
    ).rejects.toBeDefined();

    expect(findOne).toHaveBeenCalledWith({
      where: {
        partner_id: '7',
        elchi_market_id: '500',
        isDeleted: false,
      },
    });
  });

  it("bog'lanish BOR bo'lsa tekshiruvdan o'tadi", async () => {
    const svc = svcWith({
      partnerMarketRefRepo: {
        findOne: jest.fn().mockResolvedValue({ id: '1' }),
      },
      // Keyingi qadam (customer) `null` qaytarsa boshqa xato chiqadi —
      // bizga faqat 403 BO'LMAGANI muhim.
      rmqRequest: jest.fn().mockResolvedValue(null),
    });
    await expect(
      (svc as any).createPartnerShipment({ ...baseShipment }),
    ).rejects.not.toMatchObject({ error: { statusCode: 403 } });
  });
});

describe("F4 — bekor qilish holatga qarab yo'l tanlaydi", () => {
  const cancelSvc = (status: Order_status) =>
    svcWith({
      partnerShipmentRefRepo: {
        findOne: jest.fn().mockResolvedValue({
          order_id: '1001',
          partner_id: '7',
        }),
      },
      rmqRequest: jest.fn().mockResolvedValue({ data: { status } }),
      rmqRequestStrict: jest.fn().mockResolvedValue({ data: { id: '1001' } }),
    });

  it('⭐ NEW holatda `order.cancel_pre_delivery` chaqiriladi', async () => {
    const svc = cancelSvc(Order_status.NEW);
    await (svc as any).cancelPartnerShipment({
      partner_id: '7',
      shipment_id: '1001',
    });
    expect(svc.rmqRequestStrict).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.cancel_pre_delivery' },
      expect.objectContaining({ order_id: '1001' }),
      expect.any(Number),
    );
  });

  it("CREATED holatda ham yetkazishdan oldingi yo'l", async () => {
    const svc = cancelSvc(Order_status.CREATED);
    await (svc as any).cancelPartnerShipment({
      partner_id: '7',
      shipment_id: '1001',
    });
    expect(svc.rmqRequestStrict).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.cancel_pre_delivery' },
      expect.anything(),
      expect.any(Number),
    );
  });

  it("⭐ WAITING holatda ESKI yo'l (pochta/kassa qaytarishi bilan)", async () => {
    const svc = cancelSvc(Order_status.WAITING);
    await (svc as any).cancelPartnerShipment({
      partner_id: '7',
      shipment_id: '1001',
    });
    expect(svc.rmqRequestStrict).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.cancel' },
      expect.objectContaining({ id: '1001' }),
      expect.any(Number),
    );
  });

  it('SOLD holatda umuman chaqirilmaydi — 409', async () => {
    const svc = cancelSvc(Order_status.SOLD);
    await expect(
      (svc as any).cancelPartnerShipment({
        partner_id: '7',
        shipment_id: '1001',
      }),
    ).rejects.toMatchObject({ error: { statusCode: 409 } });
    expect(svc.rmqRequestStrict).not.toHaveBeenCalled();
  });

  it("allaqachon bekor qilingan — idempotent, chaqiruv yo'q", async () => {
    const svc = cancelSvc(Order_status.CANCELLED);
    const res = (await (svc as any).cancelPartnerShipment({
      partner_id: '7',
      shipment_id: '1001',
    })) as { data: { idempotent?: boolean } };
    expect(res.data.idempotent).toBe(true);
    expect(svc.rmqRequestStrict).not.toHaveBeenCalled();
  });
});

describe('K3 — yorliq tokeni', () => {
  const shipSvc = (over: Record<string, unknown> = {}) =>
    svcWith({
      partnerMarketRefRepo: {
        findOne: jest.fn().mockResolvedValue({ id: '1' }),
      },
      partnerShipmentRefRepo: {
        findOne: jest.fn().mockResolvedValue(null),
        create: (x: unknown) => x,
        save: jest.fn().mockResolvedValue({}),
      },
      resolvePartnerOrderItems: jest.fn().mockResolvedValue([]),
      shipmentItemsComment: () => null,
      ...over,
    });

  /** `order.find_by_qr` → null (band emas), `identity.customer.create` → id. */
  const routed = (overrides: Record<string, unknown> = {}) =>
    jest.fn((_c: unknown, pattern: { cmd: string }) => {
      if (pattern.cmd === 'order.find_by_qr') {
        return Promise.resolve(overrides['order.find_by_qr'] ?? null);
      }
      if (pattern.cmd === 'identity.customer.create') {
        return Promise.resolve({ data: { id: 'c1' } });
      }
      if (pattern.cmd === 'order.create') {
        return Promise.resolve({ data: { id: '1001', status: 'new' } });
      }
      return Promise.resolve(null);
    });

  it("⭐ `label_token` berilsa `order.create` ga `qr_code_token` bo'lib ketadi", async () => {
    const rmqRequest = routed();
    const svc = shipSvc({ rmqRequest });

    await (svc as any).createPartnerShipment({
      ...baseShipment,
      label_token: 'abc12345',
    });

    const createCall = rmqRequest.mock.calls.find(
      (c: unknown[]) => (c[1] as { cmd: string }).cmd === 'order.create',
    );
    expect((createCall![2] as any).dto.qr_code_token).toBe('abc12345');
  });

  it("berilmasa `undefined` ketadi — Elchi o'z tokenini yaratadi", async () => {
    const rmqRequest = routed();
    const svc = shipSvc({ rmqRequest });

    await (svc as any).createPartnerShipment({ ...baseShipment });

    const createCall = rmqRequest.mock.calls.find(
      (c: unknown[]) => (c[1] as { cmd: string }).cmd === 'order.create',
    );
    expect((createCall![2] as any).dto.qr_code_token).toBeUndefined();
  });

  it("⭐ token BAND bo'lsa 409 — buyurtma yaratilmaydi", async () => {
    /**
     * `qr_code_token` bazada noyob EMAS. Ikki buyurtmada bir xil token
     * bo'lsa skan NOTO'G'RI posilkani topadi va operator boshqa buyurtmani
     * qabul qilib yuboradi.
     */
    const rmqRequest = routed({
      'order.find_by_qr': { data: { id: '777' } },
    });
    const svc = shipSvc({ rmqRequest });

    await expect(
      (svc as any).createPartnerShipment({
        ...baseShipment,
        label_token: 'band-token',
      }),
    ).rejects.toMatchObject({ error: { statusCode: 409 } });

    const createCall = rmqRequest.mock.calls.find(
      (c: unknown[]) => (c[1] as { cmd: string }).cmd === 'order.create',
    );
    expect(createCall).toBeUndefined();
  });

  it("⭐ to'qnashuv so'rovi `token` kaliti bilan ketadi", async () => {
    /**
     * `order.find_by_qr` payloadi `{ token }` — `{ qr_code_token }` EMAS
     * (`order-service.controller.ts:170`). Noto'g'ri nom bersak `data.token`
     * undefined bo'lib qo'riqchi JIMGINA ishlamasdi.
     */
    const rmqRequest = routed();
    const svc = shipSvc({ rmqRequest });

    await (svc as any).createPartnerShipment({
      ...baseShipment,
      label_token: 'abc12345',
    });

    const qrCall = rmqRequest.mock.calls.find(
      (c: unknown[]) => (c[1] as { cmd: string }).cmd === 'order.find_by_qr',
    );
    expect(qrCall![2]).toEqual({ token: 'abc12345' });
  });

  it("token bo'sh satr bo'lsa tekshiruv umuman qilinmaydi", async () => {
    const rmqRequest = routed();
    const svc = shipSvc({ rmqRequest });

    await (svc as any).createPartnerShipment({
      ...baseShipment,
      label_token: '   ',
    });

    const qrCall = rmqRequest.mock.calls.find(
      (c: unknown[]) => (c[1] as { cmd: string }).cmd === 'order.find_by_qr',
    );
    expect(qrCall).toBeUndefined();
  });
});
