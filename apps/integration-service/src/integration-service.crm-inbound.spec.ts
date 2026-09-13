// Credential key is read at service construction — set before importing.
process.env.INTEGRATION_CREDENTIAL_SECRET =
  process.env.INTEGRATION_CREDENTIAL_SECRET ?? 'x'.repeat(40);

import { of, throwError } from 'rxjs';
import { IntegrationServiceService } from './integration-service.service';
import { computeHmacSignature } from '@app/common';

/**
 * CRM VORONKASIDAN BUYURTMA (audit P5/P7/EI-10).
 *
 * MUAMMO. Kiruvchi webhook faqat BIZ jo'natgan posilkaning statusini
 * yangilay olardi: `applyWebhookToShipment` posilka topolmasa `no_shipment`
 * qaytarib to'xtardi. CRM esa teskari ishlaydi — bitim voronkada bosqichdan
 * bosqichga o'tadi va KERAKLI bosqichga yetganda buyurtma tug'ilishi kerak.
 * Voronka/bosqich tushunchasi kodda umuman yo'q edi.
 *
 * ENG XAVFLI NUQTA — DARVOZA. CRM bitim hayotining har bir qadamida webhook
 * yuboradi, shu jumladan mijoz manzili va telefoni hali TO'LMAGAN "bitim
 * yaratildi" hodisasida ham. Darvoza bo'lmasa birinchi shu chala hodisa
 * buyurtma yasardi, keyin dublikat tekshiruvi to'g'ri ma'lumot kelganda
 * "allaqachon bor" deb tashlab yuborardi — ya'ni natija CHALA buyurtma
 * bo'lib qotib qolardi. Shu bois darvoza ikki joyda tekshiriladi: sozlama
 * yozilganda va webhook kelganda.
 */

jest.mock('@app/common', () => {
  const hmac = jest.requireActual('@app/common/webhook/hmac');
  return {
    verifyHmacSignature: hmac.verifyHmacSignature,
    computeHmacSignature: hmac.computeHmacSignature,
    ActivityAction: {
      CREATED: 'created',
      UPDATED: 'updated',
      DELETED: 'deleted',
      STATUS_CHANGE: 'status_change',
      PAYMENT: 'payment',
      EXTERNAL_SYNC: 'external_sync',
      WEBHOOK_RECEIVED: 'webhook_received',
    },
    ActivityLogService: class {},
    Order_status: {},
  };
});

jest.mock('./entities/external-integration.entity', () => ({
  ExternalIntegration: class ExternalIntegration {},
}));
jest.mock('./entities/sync-queue.entity', () => ({
  SyncQueue: class SyncQueue {},
}));
jest.mock('./entities/sync-history.entity', () => ({
  SyncHistory: class SyncHistory {},
}));
jest.mock('./entities/provider-webhook-log.entity', () => ({
  ProviderWebhookLog: class ProviderWebhookLog {},
}));
jest.mock('./entities/provider-shipment.entity', () => ({
  ProviderShipment: class ProviderShipment {},
}));
jest.mock('./entities/provider-receivable.entity', () => ({
  ProviderReceivable: class ProviderReceivable {},
  ReceivableStatus: {
    PENDING: 'pending',
    SETTLED: 'settled',
    CANCELLED: 'cancelled',
  },
}));
jest.mock('./entities/provider-remittance.entity', () => ({
  ProviderRemittance: class ProviderRemittance {},
}));
jest.mock('./entities/partner.entity', () => ({
  Partner: class Partner {},
}));
jest.mock('./entities/partner-market-ref.entity', () => ({
  PartnerMarketRef: class PartnerMarketRef {},
}));
jest.mock('./entities/partner-shipment-ref.entity', () => ({
  PartnerShipmentRef: class PartnerShipmentRef {},
}));
jest.mock('./entities/partner-product-ref.entity', () => ({
  PartnerProductRef: class PartnerProductRef {},
}));
jest.mock('./entities/partner-webhook-outbox.entity', () => ({
  PartnerWebhookOutbox: class PartnerWebhookOutbox {},
}));
jest.mock('./entities/inbound-deal-ref.entity', () => ({
  InboundDealRef: class InboundDealRef {},
}));
jest.mock('./entities/payment-transaction.entity', () => ({
  PaymentTransaction: class PaymentTransaction {},
}));

const SECRET = 'crm-shared-secret';

/** Bitim bosqichga o'tdi — amoCRM naqshidagi payload. */
const DEAL_BODY = JSON.stringify({
  event: 'leads.status',
  data: {
    lead: {
      id: 88012,
      pipeline_id: 7482913,
      // ⚠️ RAQAM, satr emas — CRM'lar id'ni raqam qilib yuboradi.
      status_id: 142,
      full_name: 'Dilnoza Karimova',
      phone: '901234567',
      address: 'Chilonzor 7-kvartal',
      district: 'Chilonzor',
      price: 250000,
    },
  },
});

function makeService(opts: {
  integration: Record<string, unknown> | null;
  /** `order.receive_external` javobi; `Error` bo'lsa RMQ xatosi taqlid qiladi. */
  orderReply?: unknown;
  /** Mavjud posilka — kiruvchi yo'l ishlamasligini tekshirish uchun. */
  shipment?: Record<string, unknown> | null;
  /**
   * `save` da otiladigan xato — bitim BAND bo'lgan holatni taqlid qiladi
   * (unique buzilishi `23505`).
   */
  dealRefError?: unknown;
  /** To'lov yozuvini band qilishda otiladigan xato (unique buzilishi). */
  paymentTxnError?: unknown;
}) {
  const integrationRepo: any = {
    findOne: jest.fn().mockResolvedValue(opts.integration),
  };
  const webhookLogRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((dto: any) => dto),
    save: jest.fn(async (e: any) => ({ id: 'log1', ...e })),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const shipmentRepo: any = {
    findOne: jest.fn().mockResolvedValue(opts.shipment ?? null),
    findAndCount: jest.fn(),
    create: jest.fn((dto: any) => ({ ...dto })),
    save: jest.fn(async (e: any) => ({ id: 'shp1', ...e })),
  };
  const simpleRepo = (): any => ({
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((dto: any) => ({ ...dto })),
    save: jest.fn(async (e: any) => ({ id: 'x1', ...e })),
  });
  const activityLog: any = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  const inboundDealRefRepo: any = {
    create: jest.fn((dto: any) => ({ ...dto })),
    save: jest.fn(async (e: any) => {
      if (opts.dealRefError) throw opts.dealRefError;
      return { id: 'idr1', ...e };
    }),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  const paymentTxnRepo: any = {
    create: jest.fn((dto: any) => ({ ...dto })),
    save: jest.fn(async (e: any) => {
      if (opts.paymentTxnError) throw opts.paymentTxnError;
      return { id: 'ptx1', ...e };
    }),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const orderSend = jest.fn(() =>
    opts.orderReply instanceof Error
      ? throwError(() => opts.orderReply)
      : of(opts.orderReply ?? null),
  );
  const orderClient: any = { send: orderSend };
  const noClient: any = {};

  const service = new IntegrationServiceService(
    integrationRepo,
    {} as any,
    {} as any,
    webhookLogRepo,
    shipmentRepo,
    simpleRepo(),
    simpleRepo(),
    simpleRepo(),
    simpleRepo(),
    simpleRepo(),
    simpleRepo(),
    simpleRepo(),
    inboundDealRefRepo,
    paymentTxnRepo,
    activityLog,
    noClient,
    noClient,
    orderClient,
    noClient,
  );
  return {
    service,
    webhookLogRepo,
    orderSend,
    activityLog,
    inboundDealRefRepo,
    paymentTxnRepo,
  };
}

/** CRM ulanishi — `role: 'source'`, `category: 'crm'`. */
function crmIntegration(inbound: Record<string, unknown> | null) {
  return {
    id: '9',
    slug: 'amocrm',
    name: 'amoCRM',
    isDeleted: false,
    is_active: true,
    role: 'source',
    category: 'crm',
    webhook_secret: SECRET, // plaintext → decryptCredential returns as-is
    webhook_secret_previous: null,
    webhook_signature_header: 'x-signature',
    webhook_signature_prefix: null,
    webhook_algorithm: 'sha256',
    // ⚠️ CRM'da posilka kuzatish yo'li YO'Q — faqat buyurtma qabul qiladi.
    webhook_id_header: null,
    webhook_payload_paths: null,
    inbound_order_config: inbound,
  };
}

const GATE = {
  enabled: true,
  deal_path: 'data.lead',
  funnel_path: 'pipeline_id',
  stage_path: 'status_id',
  create_on_stages: ['142'],
};

function signedInput(
  body: string,
  extraHeaders: Record<string, string> = {},
  slug = 'amocrm',
) {
  return {
    slug,
    raw_body_base64: Buffer.from(body, 'utf8').toString('base64'),
    headers: {
      'x-signature': computeHmacSignature(body, SECRET),
      ...extraHeaders,
    },
  };
}

const CREATED_REPLY = {
  data: { created: [{ id: 'ord-1', external_id: '88012' }], skipped: [] },
};

describe('CRM voronkasidan buyurtma yaratish', () => {
  describe('⭐ DARVOZA — eng xavfli nuqta', () => {
    it('darvoza sozlanmagan bo\'lsa buyurtma YARATILMAYDI', async () => {
      /**
       * Yozish validatsiyasi bundan qutqaradi, lekin ishlash vaqtida ham
       * tekshiriladi: eski qator, qo'lda SQL yoki migratsiyadan keyingi
       * holatda darvoza ochiq qolishi mumkin. Ochiq darvoza "bitim
       * yaratildi" hodisasidan chala buyurtma yasardi.
       */
      const { service, orderSend } = makeService({
        integration: crmIntegration({ enabled: true }),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.ok).toBe(true);
      expect(res.inbound_order.outcome).toBe('inbound_no_gate');
      expect(orderSend).not.toHaveBeenCalled();
    });

    it('bitim BOSHQA bosqichda bo\'lsa buyurtma yaratilmaydi', async () => {
      const { service, orderSend } = makeService({
        integration: crmIntegration({ ...GATE, create_on_stages: ['999'] }),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order.outcome).toBe('inbound_stage_skipped');
      expect(res.inbound_order.stage).toBe('142');
      expect(orderSend).not.toHaveBeenCalled();
    });

    it('⭐ bosqich RAQAM bo\'lsa ham mos keladi', async () => {
      /**
       * CRM `status_id` ni 142 (raqam) qilib yuboradi, sozlamada esa "142"
       * (satr) turadi. Solishtirishni satr sifatida qilmasak, darvoza hech
       * qachon ochilmasdi va hech kim sababini topolmasdi.
       */
      const { service, orderSend } = makeService({
        integration: crmIntegration(GATE),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order.outcome).toBe('inbound_created');
      expect(res.inbound_order.order_id).toBe('ord-1');
      expect(orderSend).toHaveBeenCalledTimes(1);
    });

    it('HODISA turi bo\'yicha darvoza — bosqich yo\'lisiz ham ishlaydi', async () => {
      /**
       * Ba'zi CRM'lar bosqich id'sini payload ichida bermaydi, o'rniga
       * alohida hodisa turini yuboradi. Shuning uchun darvozalar OR bilan
       * birlashadi — AND qilsak faqat ikkisini ham yuboradigan CRM ishlardi.
       */
      const { service, orderSend } = makeService({
        integration: crmIntegration({
          enabled: true,
          deal_path: 'data.lead',
          create_on_events: ['leads.status'],
        }),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order.outcome).toBe('inbound_created');
      expect(orderSend).toHaveBeenCalledTimes(1);
    });

    it('⭐ IMZOLANMAGAN sarlavha darvozani OCHMAYDI', async () => {
      /**
       * ADVERSARIAL TOPILMA (kritik). HMAC imzo FAQAT tanani qamraydi
       * (`hmac.ts` — `update(rawBody)`); sarlavhalar imzoga kirmaydi va
       * gateway ularni o'zgarishsiz uzatadi.
       *
       * `extractEventType` esa sarlavhani tanadan USTUN qo'yardi. Ya'ni
       * to'g'ri imzolangan BITTA tanani qo'lga olgan odam uni
       * `x-event: leads.status` sarlavhasi bilan qayta yuborib, BOSQICH
       * darvozasini butunlay chetlab o'tardi — natijada manzili to'lmagan
       * chala bitimdan buyurtma tug'ilardi, keyin dublikat to'sig'i o'sha
       * chala yozuvni abadiy qulflab qo'yardi.
       *
       * Endi darvoza faqat IMZOLANGAN tanadan o'qiydi.
       */
      const body = JSON.stringify({
        // Tanada hodisa turi BOSHQA va bosqich mos KELMAYDI.
        event: 'leads.note',
        data: { lead: { id: 88012, status_id: 1 } },
      });
      const { service, orderSend } = makeService({
        integration: crmIntegration({
          enabled: true,
          deal_path: 'data.lead',
          stage_path: 'status_id',
          create_on_stages: ['142'],
          create_on_events: ['leads.status'],
        }),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(
        signedInput(body, { 'x-event': 'leads.status' }),
      );

      expect(res.inbound_order.outcome).toBe('inbound_stage_skipped');
      expect(orderSend).not.toHaveBeenCalled();
    });

    it('BOSHQA voronkaning bitimi o\'tmaydi', async () => {
      const { service, orderSend } = makeService({
        integration: crmIntegration({ ...GATE, funnel_id: '11111' }),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order.outcome).toBe('inbound_other_funnel');
      expect(orderSend).not.toHaveBeenCalled();
    });

    it('⭐ `funnel_path` XATO bo\'lsa jurnalda KO\'RINADI', async () => {
      /**
       * ADVERSARIAL TOPILMA. Qiymat umuman topilmasa — bu sozlama nuqsoni:
       * darvoza HAR BIR bitimni to'sib turadi, jurnalda esa hech qanday
       * xato ko'rinmasdi ("processed", sababsiz). Operator "nega buyurtma
       * kelmayapti?" degan savolga javob topa olmasdi.
       *
       * Qiymat bor, lekin boshqa bo'lsa — kutilgan holat, jurnal toza.
       */
      const { service, webhookLogRepo } = makeService({
        integration: crmIntegration({
          ...GATE,
          funnel_id: '7482913',
          funnel_path: 'pipeline', // xato yo'l — qiymat yo'q
        }),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order.outcome).toBe('inbound_no_funnel');
      expect(webhookLogRepo.update.mock.calls[0][1].error).toBe(
        'apply: inbound_no_funnel',
      );
    });

    it('boshqa voronka KUTILGAN holat — jurnal toza qoladi', async () => {
      const { service, webhookLogRepo } = makeService({
        integration: crmIntegration({ ...GATE, funnel_id: '11111' }),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order.outcome).toBe('inbound_other_funnel');
      expect(webhookLogRepo.update.mock.calls[0][1].error).toBeNull();
    });

    it('o\'z voronkasi bo\'lsa o\'tadi', async () => {
      const { service } = makeService({
        integration: crmIntegration({ ...GATE, funnel_id: '7482913' }),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order.outcome).toBe('inbound_created');
    });

    it('ROL darvozasi — kargo ulanishi buyurtma yaratmaydi', async () => {
      /**
       * H1 naqshi. Kargo bizga buyurtma bermaydi — biz unga beramiz.
       * Sozlamada yoqilgan bo'lsa, bu xato: jimgina o'tkazib yuborsak
       * kargoning status webhooki buyurtma yasardi.
       */
      const { service, orderSend } = makeService({
        integration: { ...crmIntegration(GATE), role: 'carrier' },
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order.outcome).toBe('inbound_wrong_role');
      expect(orderSend).not.toHaveBeenCalled();
    });
  });

  describe('bitim obyektini topish', () => {
    it('`deal_path` xato bo\'lsa aniq natija qaytadi', async () => {
      const { service, orderSend } = makeService({
        integration: crmIntegration({ ...GATE, deal_path: 'data.deal' }),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order.outcome).toBe('inbound_no_deal');
      expect(orderSend).not.toHaveBeenCalled();
    });

    it('bir elementli MASSIV ochib olinadi', async () => {
      /** Bitrix batch / amoCRM `leads.status[]` shundayin yuboradi. */
      const body = JSON.stringify({
        event: 'leads.status',
        data: { lead: [{ id: 88012, status_id: 142, phone: '901234567' }] },
      });
      const { service, orderSend } = makeService({
        integration: crmIntegration(GATE),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(body));

      expect(res.inbound_order.outcome).toBe('inbound_created');
      expect(orderSend.mock.calls[0][1]).toMatchObject({
        integration_id: '9',
        orders: [{ id: 88012, status_id: 142 }],
      });
    });

    it('⭐ KO\'P elementli massiv RAD ETILADI — birinchisi olinmaydi', async () => {
      /**
       * Birinchisini olib qolsak, qolgan bitimlar JIMGINA yo'qolardi —
       * eng yomon holat, chunki hech kim yo'qotishni sezmaydi. Rad etish
       * jurnalga tushadi va ko'rinadi.
       */
      const body = JSON.stringify({
        event: 'leads.status',
        data: {
          lead: [
            { id: 1, status_id: 142, phone: '901234567' },
            { id: 2, status_id: 142, phone: '901234568' },
          ],
        },
      });
      const { service, orderSend } = makeService({
        integration: crmIntegration(GATE),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(body));

      expect(res.inbound_order.outcome).toBe('inbound_no_deal');
      expect(orderSend).not.toHaveBeenCalled();
    });
  });

  describe('⭐ BITIM ID\'SI — dublikat to\'sig\'ining yagona tayanchi', () => {
    /**
     * `receiveExternalOrders` dublikatni `(external_id, operator)` bo'yicha
     * tekshiradi, LEKIN `external_id` null bo'lsa tekshiruvni BUTUNLAY
     * o'tkazib yuboradi (`order-lifecycle.service.ts` — `if (externalId)`).
     *
     * Tortib olish yo'lida bu chidamli: importni operator qo'lda ishga
     * tushiradi. CRM webhooki esa bitim hayotining HAR qadamida keladi —
     * ya'ni id bo'lmasa bitta bitim o'nlab buyurtma yasardi.
     */
    it('id yo\'q bo\'lsa buyurtma YARATILMAYDI', async () => {
      const body = JSON.stringify({
        event: 'leads.status',
        data: { lead: { status_id: 142, phone: '901234567' } },
      });
      const { service, orderSend, webhookLogRepo } = makeService({
        integration: crmIntegration(GATE),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(body));

      expect(res.inbound_order.outcome).toBe('inbound_no_external_id');
      expect(orderSend).not.toHaveBeenCalled();
      // Sozlama xatosi — jurnalda KO'RINISHI shart.
      expect(webhookLogRepo.update.mock.calls[0][1].error).toBe(
        'apply: inbound_no_external_id',
      );
    });

    it('⭐ `id_field` xaritasi hisobga olinadi', async () => {
      /**
       * Kalit nomi order-service bilan AYNI joydan olinadi
       * (`field_mapping.id_field`, sukut `'id'`). Aks holda bu yerda o'tib
       * ketib, o'sha yerda null bo'lib qolardi — ya'ni darvoza soxta
       * bo'lardi.
       */
      const body = JSON.stringify({
        event: 'leads.status',
        data: { lead: { deal_uid: 'D-77', status_id: 142 } },
      });
      const { service, orderSend } = makeService({
        integration: {
          ...crmIntegration(GATE),
          field_mapping: { id_field: 'deal_uid' },
        },
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(body));

      expect(res.inbound_order.outcome).toBe('inbound_created');
      expect(orderSend).toHaveBeenCalledTimes(1);
    });

    it('id RAQAM bo\'lsa ham qabul qilinadi', async () => {
      const { service } = makeService({
        integration: crmIntegration(GATE),
        orderReply: CREATED_REPLY,
      });
      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));
      expect(res.inbound_order.outcome).toBe('inbound_created');
    });
  });

  describe('takroriy hodisa va xatolar', () => {
    it('⭐ dublikat XATO emas — CRM bitimni qayta-qayta yuboradi', async () => {
      const { service, webhookLogRepo } = makeService({
        integration: crmIntegration(GATE),
        orderReply: {
          data: {
            created: [],
            skipped: [{ external_id: '88012', reason: 'already_exists' }],
          },
        },
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order.outcome).toBe('inbound_duplicate');
      // Jurnalda xato BELGILANMAYDI — bu asosiy oqim, ogohlantirish emas.
      expect(webhookLogRepo.update.mock.calls[0][1].error).toBeNull();
    });

    it('order-service yiqilsa webhook baribir 200 oladi', async () => {
      /**
       * Non-2xx bo'lsa CRM qayta yuborishni boshlaydi, holbuki muammo
       * sozlamada (masalan `market_id` yo'q) va qayta yuborish yordam
       * bermaydi. Sabab jurnalga yoziladi.
       */
      const { service, webhookLogRepo } = makeService({
        integration: crmIntegration(GATE),
        orderReply: new Error('integration.market_id is required'),
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.ok).toBe(true);
      expect(res.code).toBe(200);
      expect(res.inbound_order.outcome).toBe('inbound_failed');
      /**
       * ⭐ SABAB HAM JURNALDA (adversarial topilma). Ilgari faqat
       * `apply: inbound_failed` turardi — "market_id sozlanmagan",
       * "tuman aniqlanmadi" va "telefon yo'q" bir xil ko'rinardi, ya'ni
       * operator nima tuzatishini BILMASDI.
       */
      expect(webhookLogRepo.update.mock.calls[0][1].error).toBe(
        'apply: inbound_failed — integration.market_id is required',
      );
    });

    it('yaratilgan buyurtma JURNALGA yoziladi', async () => {
      const { service, activityLog } = makeService({
        integration: crmIntegration(GATE),
        orderReply: CREATED_REPLY,
      });

      await service.receiveWebhook(signedInput(DEAL_BODY));

      const orderLog = activityLog.log.mock.calls.find(
        ([c]: any[]) => c.entity_type === 'Order',
      );
      expect(orderLog?.[0]).toMatchObject({
        entity_id: 'ord-1',
        new_value: { source: 'crm_webhook', provider: 'amocrm', stage: '142' },
      });
    });
  });

  describe('⭐ POYGA — bitta bitimdan ikki buyurtma bo\'lmasin', () => {
    /**
     * ADVERSARIAL TOPILMA (kritik). `receiveExternalOrders` dublikatni
     * O'QIB tekshiradi, keyin yaratadi; ikkisi orasida tuman aniqlash va
     * mijoz yaratish uchun RMQ borish-kelishlari bor, ya'ni poyga oynasi
     * yuzlab millisekund.
     *
     * CRM bitta harakat uchun bir nechta webhook yuboradi (bosqich +
     * mas'ul + maydon o'zgardi) va hammasi AYNI bosqichni tashiydi — ya'ni
     * hammasi darvozadan o'tadi. Ikkisi bir vaqtda kelsa ikkisi ham "yo'q"
     * deb o'qib, IKKI buyurtma yasardi: ikki `order_number`, ikki COD qarzi.
     *
     * `inbound_deal_refs` dagi UNIQUE indeks buni DB darajasida to'sadi.
     */
    const uniqueViolation = Object.assign(new Error('duplicate key'), {
      code: '23505',
    });

    it('bitim BAND bo\'lsa buyurtma yaratilmaydi', async () => {
      const { service, orderSend } = makeService({
        integration: crmIntegration(GATE),
        orderReply: CREATED_REPLY,
        dealRefError: uniqueViolation,
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.ok).toBe(true);
      expect(res.inbound_order.outcome).toBe('inbound_race');
      // Eng muhimi: yaratish CHAQIRILMAYDI.
      expect(orderSend).not.toHaveBeenCalled();
    });

    it('band qilish YARATISHDAN OLDIN bo\'ladi', async () => {
      /**
       * Tartib teskari bo'lsa to'siq ma'nosiz bo'lardi: ikki webhook ham
       * yaratib bo'lgandan keyin unique'ga urilardi.
       */
      const { service, orderSend, inboundDealRefRepo } = makeService({
        integration: crmIntegration(GATE),
        orderReply: CREATED_REPLY,
      });

      await service.receiveWebhook(signedInput(DEAL_BODY));

      const claimOrder = inboundDealRefRepo.save.mock.invocationCallOrder[0];
      const createOrder = orderSend.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(createOrder);
    });

    it('yaratilgan buyurtma REF ga bog\'lanadi', async () => {
      const { service, inboundDealRefRepo } = makeService({
        integration: crmIntegration(GATE),
        orderReply: CREATED_REPLY,
      });

      await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(inboundDealRefRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ deal_id: '88012', integration_id: '9' }),
      );
      expect(inboundDealRefRepo.update).toHaveBeenCalledWith(
        { id: 'idr1' },
        { order_id: 'ord-1' },
      );
    });

    it('⭐ yaratish YIQILSA band qilish BEKOR qilinadi', async () => {
      /**
       * Aks holda ref qolib, buyurtma esa hech qachon yaratilmasdi: keyingi
       * webhook "dublikat" deb to'silib, muammo ABADIY qotib qolardi.
       * Sozlama tuzatilgach CRM keyingi hodisada qayta urinishi kerak.
       */
      const { service, inboundDealRefRepo } = makeService({
        integration: crmIntegration(GATE),
        orderReply: new Error('integration.market_id is required'),
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order.outcome).toBe('inbound_failed');
      expect(inboundDealRefRepo.delete).toHaveBeenCalledWith({ id: 'idr1' });
    });

    it('⭐ TIMEOUT da band qilish SAQLANADI', async () => {
      /**
       * ADVERSARIAL TOPILMA. `rmqRequestStrict` timeout'da `null` qaytaradi
       * — bu "yaratilmadi" DEGANI EMAS: order-service ishni tugatgan, faqat
       * javob yetib kelmagan bo'lishi mumkin.
       *
       * Ilgari bu `inbound_failed` bo'lib, band qilish BEKOR qilinardi —
       * ya'ni keyingi webhook ikkinchi buyurtma yasashi mumkin edi.
       */
      const { service, inboundDealRefRepo, webhookLogRepo } = makeService({
        integration: crmIntegration(GATE),
        orderReply: null, // firstValueFrom(of(null)) → timeout bilan bir xil
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order.outcome).toBe('inbound_timeout');
      expect(inboundDealRefRepo.delete).not.toHaveBeenCalled();
      expect(webhookLogRepo.update.mock.calls[0][1].error).toContain(
        'inbound_timeout',
      );
    });

    it('band qilish boshqa DB xatosida YUTILMAYDI', async () => {
      /**
       * Faqat unique buzilishi (`23505`) dublikat. Boshqa xatoni dublikat
       * deb yutib yuborsak, buyurtma JIMGINA yaratilmay qolardi — eng yomon
       * holat, chunki hech kim sezmaydi.
       */
      const { service } = makeService({
        integration: crmIntegration(GATE),
        orderReply: CREATED_REPLY,
        dealRefError: Object.assign(new Error('connection lost'), {
          code: '08006',
        }),
      });

      await expect(
        service.receiveWebhook(signedInput(DEAL_BODY)),
      ).rejects.toThrow(/connection lost/);
    });
  });

  describe('mavjud xatti-harakat buzilmaydi', () => {
    it('⭐ posilka TOPILSA kiruvchi yo\'l ishlamaydi', async () => {
      /**
       * Aks holda kargoning har bir status webhooki yangi buyurtma
       * yasardi. Tartib ataylab shunday: avval mavjud posilka, topilmasa
       * buyurtma yaratish.
       */
      const body = JSON.stringify({
        data: { lead: { status_id: 142 }, order_id: 'ext-1', state: 'delivered' },
      });
      const { service, orderSend } = makeService({
        integration: {
          ...crmIntegration(GATE),
          webhook_payload_paths: {
            external_ref: 'data.order_id',
            status: 'data.state',
          },
          inbound_status_mapping: { delivered: { status: 'RECEIVED' } },
        },
        shipment: {
          id: 'shp1',
          order_id: 'ord-existing',
          integration_id: '9',
          internal_status: 'NEW',
        },
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(body));

      expect(res.shipment.outcome).not.toBe('no_shipment');
      expect(res.inbound_order).toBeUndefined();
      // Buyurtma YARATILMAYDI (posilka statusi boshqa yo'ldan yangilanadi).
      const createCalls = orderSend.mock.calls.filter(
        ([p]: any[]) => p?.cmd === 'order.receive_external',
      );
      expect(createCalls).toHaveLength(0);
    });

    it('sozlama YO\'Q bo\'lsa javob va jurnal o\'zgarmaydi', async () => {
      const { service, webhookLogRepo } = makeService({
        integration: crmIntegration(null),
        orderReply: CREATED_REPLY,
      });

      const res: any = await service.receiveWebhook(signedInput(DEAL_BODY));

      expect(res.inbound_order).toBeUndefined();
      expect(webhookLogRepo.update.mock.calls[0][1].error).toBe(
        'apply: no_paths',
      );
    });
  });

  describe('⭐ SOZLAMA validatsiyasi — xato yozish vaqtida qaytadi', () => {
    /**
     * Nega yozish vaqtida: operator formani saqlayotganda tushuntirishni
     * o'qiydi. Webhook vaqtida qaytarilsa, u kechasi kelgan hodisa
     * logidan sababni izlab yurardi.
     */
    const check = async (cfg: Record<string, unknown>) => {
      const { service } = makeService({ integration: null });
      return (service as any).assertInboundOrderConfig({
        inbound_order_config: cfg,
      });
    };

    it('yoqilgan, lekin darvoza yo\'q → 400', async () => {
      await expect(check({ enabled: true })).rejects.toThrow(/darvoza yo/);
    });

    it('`create_on_stages` bor, `stage_path` yo\'q → 400', async () => {
      await expect(
        check({ enabled: true, create_on_stages: ['142'] }),
      ).rejects.toThrow(/stage_path/);
    });

    it('`funnel_id` bor, `funnel_path` yo\'q → 400', async () => {
      await expect(
        check({ ...GATE, funnel_id: '7482913', funnel_path: '' }),
      ).rejects.toThrow(/funnel_path/);
    });

    it('massiv ichida bo\'sh qiymat → 400', async () => {
      /** Bo'sh satr darvozani jimgina keng ochib yuborardi. */
      await expect(
        check({ ...GATE, create_on_stages: ['142', ''] }),
      ).rejects.toThrow(/bo/);
    });

    it('darvoza massiv EMAS → 400', async () => {
      await expect(
        check({ enabled: true, stage_path: 's', create_on_stages: '142' }),
      ).rejects.toThrow(/massiv/);
    });

    it('to\'g\'ri sozlama o\'tadi', async () => {
      await expect(check(GATE)).resolves.toBeUndefined();
    });

    it('o\'chirilgan sozlama tekshirilmaydi', async () => {
      /** `enabled: false` — hech narsa yaratilmaydi, shart ham yo'q. */
      await expect(check({ enabled: false })).resolves.toBeUndefined();
    });

    it('⭐ yo\'l maydoni SATR bo\'lmasa → 400', async () => {
      /**
       * ADVERSARIAL TOPILMA. `@IsObject()` faqat "obyektmi" deb qaraydi,
       * ICHINI tekshirmaydi. `stage_path: 123` bazaga tushsa, webhook
       * vaqtida `extractPath` `path.trim()` chaqirib TypeError bilan
       * yiqilardi — butun webhook 500 beradi va CRM qayta yuborishni
       * boshlaydi.
       */
      await expect(
        check({ ...GATE, stage_path: 123 as never }),
      ).rejects.toThrow(/satr/);
      await expect(
        check({ ...GATE, deal_path: { a: 1 } as never }),
      ).rejects.toThrow(/satr/);
    });
  });

  describe('⭐ SHARTLAR yozish vaqtida tekshiriladi', () => {
    /**
     * ADVERSARIAL TOPILMA. Ikki shart ishlash vaqtida tekshirilardi, ya'ni
     * hodisa JIMGINA tashlanardi va operator formani saqlab "bo'ldi" deb
     * o'ylab yurardi:
     *
     *   rol ≠ source  → har bir hodisa `inbound_wrong_role`
     *   market yo'q   → har bir bitim "market_id is required" bilan yiqiladi
     */
    const prereq = (row: Record<string, unknown>) => {
      const { service } = makeService({ integration: null });
      return (service as any).assertInboundOrderPrereqs(row);
    };

    it('rol `source` bo\'lmasa → 400', () => {
      expect(() =>
        prereq({
          role: 'carrier',
          market_id: '500',
          inbound_order_config: { enabled: true },
        }),
      ).toThrow(/source/);
    });

    it('market bog\'lanishi yo\'q bo\'lsa → 400', () => {
      expect(() =>
        prereq({
          role: 'source',
          market_id: null,
          inbound_order_config: { enabled: true },
        }),
      ).toThrow(/market/);
    });

    it('to\'g\'ri holat o\'tadi', () => {
      expect(() =>
        prereq({
          role: 'source',
          market_id: '500',
          inbound_order_config: { enabled: true },
        }),
      ).not.toThrow();
    });

    it('yo\'l o\'chirilgan bo\'lsa shart qo\'yilmaydi', () => {
      // Kargo ulanishida `inbound_order_config: null` — hech narsa talab
      // qilinmaydi, aks holda mavjud ulanishlarni tahrirlash to'silardi.
      expect(() =>
        prereq({ role: 'carrier', market_id: null, inbound_order_config: null }),
      ).not.toThrow();
    });
  });
});
