// Credential key is read at service construction — set before importing.
process.env.INTEGRATION_CREDENTIAL_SECRET =
  process.env.INTEGRATION_CREDENTIAL_SECRET ?? 'x'.repeat(40);

import { of, throwError } from 'rxjs';
import { IntegrationServiceService } from './integration-service.service';
import { computeHmacSignature } from '@app/common';

/**
 * ONLAYN TO'LOV WEBHOOKI (audit P1/P2).
 *
 * MUAMMO. `role='payment'` bazaga yozilardi, lekin undan keyin HECH
 * QAYERDA o'qilmasdi — mavjud yo'llarning hammasi uni AKTIV rad etardi
 * (posilka yo'li `role !== 'carrier'`, buyurtma yo'li `role !== 'source'`).
 * Ya'ni to'lov hodisasi imzo tekshiruvidan o'tib, keyin JIMGINA yo'qolardi.
 *
 * ⚠️ BU YO'L PULNI KASSAGA KO'CHIRMAYDI. Foydalanuvchi qarori
 * (2026-09-13): onlayn pul hozircha faqat daftarga va buyurtmaning to'lov
 * maydonlariga yoziladi.
 *
 * ⚠️ ENG XAVFLI IKKI HOLAT:
 *
 *  1. TAKRORIY QO'LLASH. To'lov tizimlari bir hodisani qayta-qayta
 *     yuboradi — bu ularning NORMAL xatti-harakati. Pulni ikki marta
 *     qo'llash eng qimmat xato bo'lardi, shu bois UNIQUE
 *     `(integration_id, transaction_id)` qo'llashdan OLDIN band qiladi.
 *
 *  2. TIYIN. Payme/Click summani TIYINDA yuboradi: 100 000 so'm →
 *     10 000 000. To'g'ridan-to'g'ri yozsak buyurtma narxidan 100 baravar
 *     oshib, ortiqcha to'lov darvozasiga urilardi — ya'ni HAR BIR to'lov
 *     rad etilardi va sabab uzoq izlanardi.
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

const SECRET = 'payment-shared-secret';

/** Payme naqshidagi payload: summa TIYINDA, holat SON. */
const PAY_BODY = JSON.stringify({
  event: 'transaction.completed',
  data: {
    transaction: { id: 'PX-77123' },
    amount: 25000000, // = 250 000 so'm
    currency: 'UZS',
    state: 2,
    account: { order_id: '4021' },
  },
});

function makeService(opts: {
  integration: Record<string, unknown> | null;
  /** `order.payment.record` javobi; `Error` → RMQ xatosi, `null` → timeout. */
  orderReply?: unknown;
  /** To'lov yozuvini band qilishda otiladigan xato. */
  txnError?: Error;
}) {
  const integrationRepo: any = {
    findOne: jest.fn().mockResolvedValue(opts.integration),
  };
  const webhookLogRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((dto: any) => dto),
    save: jest.fn((e: any) => ({ id: 'log1', ...e })),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const simpleRepo = (): any => ({
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((dto: any) => ({ ...dto })),
    save: jest.fn((e: any) => ({ id: 'x1', ...e })),
  });
  const paymentTxnRepo: any = {
    create: jest.fn((dto: any) => ({ ...dto })),
    save: jest.fn((e: any) => {
      if (opts.txnError) throw opts.txnError;
      return { id: 'ptx1', ...e };
    }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const activityLog: any = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  const orderSend = jest.fn(() =>
    opts.orderReply instanceof Error
      ? throwError(() => opts.orderReply)
      : of(opts.orderReply === undefined ? null : opts.orderReply),
  );
  const orderClient: any = { send: orderSend };
  const noClient: any = {};

  const service = new IntegrationServiceService(
    integrationRepo,
    {} as any,
    {} as any,
    webhookLogRepo,
    simpleRepo(),
    simpleRepo(),
    simpleRepo(),
    simpleRepo(),
    simpleRepo(),
    simpleRepo(),
    simpleRepo(),
    simpleRepo(),
    simpleRepo(),
    paymentTxnRepo,
    activityLog,
    noClient,
    noClient,
    orderClient,
    noClient,
    // FINANCE klienti (audit M5) — kargo hisob-kitobi MAIN kassaga yoziladi.
    noClient,
  );
  return { service, webhookLogRepo, orderSend, paymentTxnRepo, activityLog };
}

const PAY_CONFIG = {
  enabled: true,
  transaction_id_path: 'data.transaction.id',
  amount_path: 'data.amount',
  currency_path: 'data.currency',
  status_path: 'data.state',
  order_ref_path: 'data.account.order_id',
  order_ref_field: 'id',
  status_map: { succeeded: ['2', 'paid'], failed: ['-1'], refunded: ['-2'] },
  amount_in_tiyin: true,
};

function paymentIntegration(cfg: Record<string, unknown> | null) {
  return {
    id: '12',
    slug: 'payme',
    name: 'Payme',
    isDeleted: false,
    is_active: true,
    role: 'payment',
    category: 'payment',
    webhook_secret: SECRET, // plaintext → decryptCredential returns as-is
    webhook_secret_previous: null,
    webhook_signature_header: 'x-signature',
    webhook_signature_prefix: null,
    webhook_algorithm: 'sha256',
    webhook_id_header: null,
    webhook_payload_paths: null,
    inbound_order_config: null,
    payment_config: cfg,
  };
}

function signedInput(body: string, slug = 'payme') {
  return {
    slug,
    raw_body_base64: Buffer.from(body, 'utf8').toString('base64'),
    headers: { 'x-signature': computeHmacSignature(body, SECRET) },
  };
}

const RECORDED = { data: { outcome: 'recorded', order_id: '4021' } };

describe('Onlayn to`lov webhooki', () => {
  describe('⭐ DARVOZALAR', () => {
    it('sozlama o`chirilgan bo`lsa hech narsa qilinmaydi', async () => {
      const { service, orderSend, paymentTxnRepo } = makeService({
        integration: paymentIntegration({ enabled: false }),
        orderReply: RECORDED,
      });

      const res: any = await service.receiveWebhook(signedInput(PAY_BODY));

      expect(res.payment.outcome).toBe('payment_disabled');
      expect(orderSend).not.toHaveBeenCalled();
      expect(paymentTxnRepo.save).not.toHaveBeenCalled();
    });

    it('⭐ o`chirilgan sozlama JURNALDA xato deb belgilanadi', async () => {
      /**
       * To'lov roli ulanishiga hodisa kelgan, lekin sozlama o'chirilgan.
       * Jurnalda "toza" ko'rinsa, operator sozlamani yoqishni unutganini
       * bilmasdi va pul jimgina yo'qolib turardi.
       */
      const { service, webhookLogRepo } = makeService({
        integration: paymentIntegration({ enabled: false }),
        orderReply: RECORDED,
      });

      await service.receiveWebhook(signedInput(PAY_BODY));

      expect(webhookLogRepo.update.mock.calls[0][1].error).toContain(
        'payment_disabled',
      );
    });

    it('tenant: ulanish marketi order-service`ga UZATILADI', async () => {
      const { service, orderSend } = makeService({
        integration: { ...paymentIntegration(PAY_CONFIG), market_id: '500' },
        orderReply: RECORDED,
      });

      await service.receiveWebhook(signedInput(PAY_BODY));

      expect(orderSend.mock.calls[0][1]).toMatchObject({
        integration_market_id: '500',
      });
    });

    it('⭐ `status_map` YO`Q bo`lsa hech bir hodisa qo`llanmaydi', async () => {
      /**
       * Provayderlarning holat qiymatlari butunlay boshqacha ("paid", 2,
       * "CONFIRMED") — taxmin qilib bo'lmaydi. Xaritasiz noma'lum qiymat
       * "to'landi" deb o'qilib ketardi.
       */
      const { service, orderSend, webhookLogRepo } = makeService({
        integration: paymentIntegration({ ...PAY_CONFIG, status_map: {} }),
        orderReply: RECORDED,
      });

      const res: any = await service.receiveWebhook(signedInput(PAY_BODY));

      expect(res.payment.outcome).toBe('payment_no_config');
      expect(orderSend).not.toHaveBeenCalled();
      expect(webhookLogRepo.update.mock.calls[0][1].error).toContain(
        'payment_no_config',
      );
    });

    it('tranzaksiya id yo`q bo`lsa qo`llanmaydi', async () => {
      const { service, orderSend } = makeService({
        integration: paymentIntegration({
          ...PAY_CONFIG,
          transaction_id_path: 'data.txn.id',
        }),
        orderReply: RECORDED,
      });

      const res: any = await service.receiveWebhook(signedInput(PAY_BODY));

      expect(res.payment.outcome).toBe('payment_no_transaction_id');
      expect(orderSend).not.toHaveBeenCalled();
    });

    it('⭐ xaritada YO`Q holat qo`llanmaydi', async () => {
      const body = JSON.stringify({
        data: {
          transaction: { id: 'PX-9' },
          amount: 100,
          state: 'SOMETHING_NEW',
          account: { order_id: '4021' },
        },
      });
      const { service, orderSend } = makeService({
        integration: paymentIntegration(PAY_CONFIG),
        orderReply: RECORDED,
      });

      const res: any = await service.receiveWebhook(signedInput(body));

      expect(res.payment.outcome).toBe('payment_unmapped_status');
      expect(res.payment.reason).toContain('SOMETHING_NEW');
      expect(orderSend).not.toHaveBeenCalled();
    });

    it('holat SON bo`lsa ham xaritaga tushadi', async () => {
      // Payme `state: 2` (son) yuboradi, sozlamada esa "2" (satr).
      const { service, orderSend } = makeService({
        integration: paymentIntegration(PAY_CONFIG),
        orderReply: RECORDED,
      });

      const res: any = await service.receiveWebhook(signedInput(PAY_BODY));

      expect(res.payment.outcome).toBe('payment_recorded');
      expect(orderSend).toHaveBeenCalledTimes(1);
    });

    it('⭐ ROL `payment` bo`lmasa bu shox ISHLAMAYDI', async () => {
      /**
       * Kargo ulanishida to'lov sozlamasi yoqilgan bo'lsa ham, hodisa
       * posilka yo'lidan ketishi kerak — aks holda kargoning status
       * webhooki to'lov deb o'qilardi.
       */
      const { service } = makeService({
        integration: { ...paymentIntegration(PAY_CONFIG), role: 'carrier' },
        orderReply: RECORDED,
      });

      const res: any = await service.receiveWebhook(signedInput(PAY_BODY));

      expect(res.payment).toBeUndefined();
      expect(res.shipment).toBeDefined();
    });
  });

  describe('⭐ TIYIN — 100 baravar xato', () => {
    it('`amount_in_tiyin` bo`lsa 100 ga bo`linadi', async () => {
      /**
       * Payme/Click 100 000 so'mni 10 000 000 qilib yuboradi.
       * To'g'ridan-to'g'ri yozsak buyurtma narxidan 100 baravar oshib,
       * ortiqcha to'lov darvozasiga urilardi — HAR BIR to'lov rad etilardi.
       */
      const { service, orderSend } = makeService({
        integration: paymentIntegration(PAY_CONFIG),
        orderReply: RECORDED,
      });

      await service.receiveWebhook(signedInput(PAY_BODY));

      expect(orderSend.mock.calls[0][1]).toMatchObject({
        amount: 250000,
        order_ref: '4021',
        order_ref_field: 'id',
        status: 'succeeded',
      });
    });

    it('bayroq yo`q bo`lsa summa o`zgarmaydi', async () => {
      const { service, orderSend } = makeService({
        integration: paymentIntegration({
          ...PAY_CONFIG,
          amount_in_tiyin: false,
        }),
        orderReply: RECORDED,
      });

      await service.receiveWebhook(signedInput(PAY_BODY));

      expect(orderSend.mock.calls[0][1]).toMatchObject({ amount: 25000000 });
    });
  });

  describe('⭐ DUBLIKAT — pul ikki marta qo`llanmasin', () => {
    const uniqueViolation = Object.assign(new Error('duplicate key'), {
      code: '23505',
    });

    it('takroriy tranzaksiyada buyurtma CHAQIRILMAYDI', async () => {
      const { service, orderSend } = makeService({
        integration: paymentIntegration(PAY_CONFIG),
        orderReply: RECORDED,
        txnError: uniqueViolation,
      });

      const res: any = await service.receiveWebhook(signedInput(PAY_BODY));

      expect(res.ok).toBe(true);
      expect(res.payment.outcome).toBe('payment_duplicate');
      expect(orderSend).not.toHaveBeenCalled();
    });

    it('band qilish QO`LLASHDAN OLDIN bo`ladi', async () => {
      const { service, orderSend, paymentTxnRepo } = makeService({
        integration: paymentIntegration(PAY_CONFIG),
        orderReply: RECORDED,
      });

      await service.receiveWebhook(signedInput(PAY_BODY));

      expect(paymentTxnRepo.save.mock.invocationCallOrder[0]).toBeLessThan(
        orderSend.mock.invocationCallOrder[0],
      );
    });

    it('⭐ boshqa DB xatosi YUTILMAYDI', async () => {
      /**
       * Faqat unique buzilishi dublikat. Boshqa xatoni dublikat deb yutib
       * yuborsak, to'lov jimgina qo'llanmay qolardi — pul kelib, tizim
       * buni bilmasdi.
       */
      const { service } = makeService({
        integration: paymentIntegration(PAY_CONFIG),
        orderReply: RECORDED,
        txnError: Object.assign(new Error('connection lost'), {
          code: '08006',
        }),
      });

      await expect(
        service.receiveWebhook(signedInput(PAY_BODY)),
      ).rejects.toThrow(/connection lost/);
    });
  });

  describe('⭐ IDEMPOTENTLIK KALITI — holat ham kiradi', () => {
    /**
     * ADVERSARIAL TOPILMA (kritik). To'lov tizimi BITTA tranzaksiya uchun
     * bir nechta hodisa yuboradi va hammasi AYNI id bilan keladi:
     *
     *   CreateTransaction   → pending
     *   PerformTransaction  → succeeded    ← pul aynan shunda keladi
     *   CancelTransaction   → refunded
     *
     * Kalit faqat tranzaksiya id'si bo'lsa, `pending` qatorni band qilib
     * qo'yardi va `succeeded` "dublikat" deb TASHLANARDI — ya'ni pul
     * kelib, buyurtmaga hech qachon yozilmasdi.
     */
    it('band qilinadigan qatorda HOLAT ham bo`ladi', async () => {
      const { service, paymentTxnRepo } = makeService({
        integration: paymentIntegration(PAY_CONFIG),
        orderReply: RECORDED,
      });

      await service.receiveWebhook(signedInput(PAY_BODY));

      expect(paymentTxnRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          integration_id: '12',
          provider_transaction_id: 'PX-77123',
          status: 'succeeded',
        }),
      );
    });

    it('`pending` va `succeeded` BOSHQA-BOSHQA yozuv', async () => {
      const pendingBody = JSON.stringify({
        data: {
          transaction: { id: 'PX-77123' },
          amount: 25000000,
          state: 1,
          account: { order_id: '4021' },
        },
      });
      const { service, paymentTxnRepo, orderSend } = makeService({
        integration: paymentIntegration({
          ...PAY_CONFIG,
          status_map: { ...PAY_CONFIG.status_map, pending: ['1'] },
        }),
        orderReply: { data: { outcome: 'ignored_status' } },
      });

      const res: any = await service.receiveWebhook(signedInput(pendingBody));

      // `pending` ham yozuv yaratadi, lekin buyurtmaga qo'llanmaydi.
      expect(paymentTxnRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending' }),
      );
      expect(res.payment.outcome).toBe('payment_not_applied');
      expect(orderSend.mock.calls[0][1]).toMatchObject({ status: 'pending' });
    });
  });

  describe('⭐ PUL KUZATILISHI SHART', () => {
    it('buyurtma havolasi yo`q bo`lsa ham YOZUV saqlanadi', async () => {
      /**
       * Pul kelgan, lekin kimga tegishli ekani ma'lum emas. Yozuvni
       * saqlamasak — yo'qolgan pul bo'lardi.
       */
      const { service, paymentTxnRepo, orderSend } = makeService({
        integration: paymentIntegration({
          ...PAY_CONFIG,
          order_ref_path: 'data.account.missing',
        }),
        orderReply: RECORDED,
      });

      const res: any = await service.receiveWebhook(signedInput(PAY_BODY));

      expect(res.payment.outcome).toBe('payment_no_order_ref');
      expect(paymentTxnRepo.save).toHaveBeenCalledTimes(1);
      /**
       * ⭐ SUMMA YOZILADI (adversarial topilma). Ilgari `amount: 0` bilan
       * saqlanardi — ya'ni pulni kuzatish uchun yaratilgan YAGONA qator
       * summani YO'QOTARDI. "Pul keldi, lekin qancha ekani noma'lum"
       * kuzatuvning ma'nosini butunlay yo'q qiladi.
       */
      expect(paymentTxnRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 250000, currency: 'UZS' }),
      );
      expect(paymentTxnRepo.update).toHaveBeenCalledWith(
        { id: 'ptx1' },
        { apply_outcome: 'order_ref_missing' },
      );
      expect(orderSend).not.toHaveBeenCalled();
    });

    it('qo`llanmagan to`lov natijasi yozuvga yoziladi', async () => {
      const { service, paymentTxnRepo, webhookLogRepo } = makeService({
        integration: paymentIntegration(PAY_CONFIG),
        orderReply: { data: { outcome: 'order_already_closed' } },
      });

      const res: any = await service.receiveWebhook(signedInput(PAY_BODY));

      expect(res.payment.outcome).toBe('payment_not_applied');
      expect(res.payment.reason).toBe('order_already_closed');
      expect(paymentTxnRepo.update).toHaveBeenCalledWith(
        { id: 'ptx1' },
        { apply_outcome: 'order_already_closed', order_id: null },
      );
      // Jurnalda sabab bilan ko'rinadi.
      expect(webhookLogRepo.update.mock.calls[0][1].error).toContain(
        'order_already_closed',
      );
    });

    it('muvaffaqiyatli to`lov buyurtmaga BOG`LANADI', async () => {
      const { service, paymentTxnRepo } = makeService({
        integration: paymentIntegration(PAY_CONFIG),
        orderReply: RECORDED,
      });

      const res: any = await service.receiveWebhook(signedInput(PAY_BODY));

      expect(res.payment).toMatchObject({
        outcome: 'payment_recorded',
        order_id: '4021',
        amount: 250000,
      });
      expect(paymentTxnRepo.update).toHaveBeenCalledWith(
        { id: 'ptx1' },
        { apply_outcome: 'recorded', order_id: '4021' },
      );
    });

    it('⭐ TIMEOUT da yozuv O`CHIRILMAYDI', async () => {
      /**
       * Buyurtma yangilangan bo'lishi mumkin: order-service ishni tugatgan,
       * javob yetib kelmagan. Yozuvni o'chirsak, keyingi nusxa to'lovni
       * IKKI MARTA qo'llardi.
       */
      const { service, paymentTxnRepo } = makeService({
        integration: paymentIntegration(PAY_CONFIG),
        orderReply: null, // firstValueFrom(of(null)) → timeout bilan bir xil
      });

      const res: any = await service.receiveWebhook(signedInput(PAY_BODY));

      expect(res.payment.outcome).toBe('payment_failed');
      expect(paymentTxnRepo.update).toHaveBeenCalledWith(
        { id: 'ptx1' },
        { apply_outcome: 'timeout' },
      );
    });

    it('order-service xatosida ham yozuv qoladi va 200 qaytadi', async () => {
      const { service, paymentTxnRepo } = makeService({
        integration: paymentIntegration(PAY_CONFIG),
        orderReply: new Error('order service down'),
      });

      const res: any = await service.receiveWebhook(signedInput(PAY_BODY));

      expect(res.ok).toBe(true);
      expect(res.code).toBe(200);
      expect(res.payment.outcome).toBe('payment_failed');
      expect(paymentTxnRepo.update).toHaveBeenCalledWith(
        { id: 'ptx1' },
        { apply_outcome: 'error' },
      );
    });
  });

  describe('imzo va kill-switch o`zgarmadi', () => {
    it('imzo xato bo`lsa to`lov yo`li ISHGA TUSHMAYDI', async () => {
      const { service, paymentTxnRepo } = makeService({
        integration: paymentIntegration(PAY_CONFIG),
        orderReply: RECORDED,
      });

      const res: any = await service.receiveWebhook({
        slug: 'payme',
        raw_body_base64: Buffer.from(PAY_BODY, 'utf8').toString('base64'),
        headers: { 'x-signature': 'yolg`on' },
      });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe('invalid_signature');
      expect(paymentTxnRepo.save).not.toHaveBeenCalled();
    });

    it('o`chirilgan ulanishda to`lov QO`LLANMAYDI', async () => {
      const { service, paymentTxnRepo } = makeService({
        integration: { ...paymentIntegration(PAY_CONFIG), is_active: false },
        orderReply: RECORDED,
      });

      const res: any = await service.receiveWebhook(signedInput(PAY_BODY));

      expect(res.reason).toBe('integration_inactive');
      expect(paymentTxnRepo.save).not.toHaveBeenCalled();
    });
  });
});
