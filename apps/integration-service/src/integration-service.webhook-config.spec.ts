import { RpcException } from '@nestjs/microservices';
import { IntegrationServiceService } from './integration-service.service';

/**
 * `webhook_url` SOZLANMAGAN holat.
 *
 * ⚠️ ILGARI bu holat `completed` deb yopilardi — sozlama yo'qligi jimgina
 * "muvaffaqiyat" bo'lib, hodisa BUTUNLAY YO'QOLARDI. Keyinroq `webhook_url`
 * qo'yilganda ham hech narsa yetkazilmasdi va nosozlik hech qaysi ekranda
 * ko'rinmasdi.
 *
 * Jonli holat aynan shunday edi: PCS lokalda turgan, `webhook_url` bo'sh,
 * `elchi_webhook_log` = 0 qator — uchta sotuv hodisasi yo'qolgan.
 */
function makeSvc(opts: {
  partner?: Record<string, unknown> | null;
  row?: Record<string, unknown>;
}) {
  const updates: any[] = [];
  const svc: any = Object.create(IntegrationServiceService.prototype);
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  svc.partnerRepo = {
    findOne: jest.fn().mockResolvedValue(opts.partner ?? null),
  };
  svc.partnerWebhookOutboxRepo = {
    update: jest.fn((where: any, patch: any) => {
      updates.push({ where, patch });
      // Claim faqat `pending` qatorda muvaffaqiyatli bo'ladi.
      const claiming = patch?.status === 'processing';
      return Promise.resolve({ affected: claiming ? 1 : 1 });
    }),
  };
  return { svc, updates };
}

const ROW = {
  id: 'w-1',
  partner_id: '7',
  attempts: 2,
  max_attempts: 4,
  status: 'pending',
  // `external_order_id` haqiqiy qatorda HAR DOIM bor (ustun NOT NULL) va
  // yetkazuvchi uni shakl bo'yicha tekshiradi (F5) — fikstura ham shunday.
  external_order_id: 'ord-9',
  payload: { event: 'shipment.status_changed', external_order_id: 'ord-9' },
};

describe('webhook_url sozlanmagan -> awaiting_config', () => {
  it("TC1: `completed` EMAS, `awaiting_config` bo'ladi", async () => {
    const { svc, updates } = makeSvc({
      partner: { id: '7', webhook_url: null },
    });

    const ok = await svc.deliverPartnerWebhookRow({ ...ROW });

    expect(ok).toBe(false);
    const last = updates.at(-1).patch;
    expect(last.status).toBe('awaiting_config');
    // Hodisa yo'qolmasligi shart — `completed` bo'lsa qaytarib bo'lmasdi.
    expect(last.status).not.toBe('completed');
  });

  it('TC2: urinish HISOBLANMAYDI (qaytariladi)', async () => {
    // Yuborishga harakat ham qilinmadi. Aks holda sozlash kechiksa qator
    // `permanently_failed`ga tushib ketardi.
    const { svc, updates } = makeSvc({ partner: { id: '7', webhook_url: '' } });

    await svc.deliverPartnerWebhookRow({ ...ROW, attempts: 3 });

    const claim = updates.find((u) => u.patch.status === 'processing');
    expect(claim.patch.attempts).toBe(4); // claim ko'targan
    expect(updates.at(-1).patch.attempts).toBe(3); // ...keyin QAYTARILDI
  });

  it('TC3: sabab yozib qoldiriladi va next_retry tozalanadi', async () => {
    const { svc, updates } = makeSvc({
      partner: { id: '7', webhook_url: null },
    });

    await svc.deliverPartnerWebhookRow({ ...ROW });

    const last = updates.at(-1).patch;
    expect(String(last.last_error)).toMatch(/webhook_url/);
    // Ishchi so'rovga tushmasligi uchun — `webhook_url` qo'yilganda
    // `updatePartner` o'zi navbatga qaytaradi.
    expect(last.next_retry_at).toBeNull();
  });

  it("TC4: hamkor umuman topilmasa ham hodisa yo'qolmaydi", async () => {
    const { svc, updates } = makeSvc({ partner: null });

    await svc.deliverPartnerWebhookRow({ ...ROW });

    expect(updates.at(-1).patch.status).toBe('awaiting_config');
  });
});

/**
 * `webhook_secret` SOZLANMAGAN holat — `webhook_url` bor.
 *
 * ⚠️ ILGARI imzo BO'SH kalit bilan qo'yilib yuborilardi (`?? ''`). Qabul
 * qiluvchi 401 qaytarardi, tizim esa buni oddiy tarmoq xatosi deb 4 marta
 * qayta urinib `permanently_failed` qilardi — sabab hech qaysi ekranda
 * ko'rinmasdi. Endi sozlama yo'qligi SOZLAMA xatosi sifatida qaraladi.
 */
describe('webhook_secret sozlanmagan -> awaiting_config', () => {
  function makeSecretlessSvc() {
    const { svc, updates } = makeSvc({
      partner: {
        id: '7',
        webhook_url: 'https://beepost.example.com/api/v1/elchi/webhook',
        webhook_secret: null,
      },
    });
    // SSRF guard tarmoqqa chiqadi — test undan mustaqil bo'lsin.
    svc.assertOutboundUrlSafe = jest.fn().mockResolvedValue(undefined);
    return { svc, updates };
  }

  it('TC7: yuborilmaydi, qator kutish holatiga tushadi', async () => {
    const { svc, updates } = makeSecretlessSvc();
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await svc.deliverPartnerWebhookRow({ ...ROW });

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates.at(-1).patch.status).toBe('awaiting_config');
  });

  it('TC8: sabab AYNAN sekret yo‘qligini ko‘rsatadi', async () => {
    const { svc, updates } = makeSecretlessSvc();
    global.fetch = jest.fn() as unknown as typeof fetch;

    await svc.deliverPartnerWebhookRow({ ...ROW, attempts: 3 });

    const last = updates.at(-1).patch;
    // "HTTP 401" emas — operator sababni o'qiy olsin.
    expect(String(last.last_error)).toMatch(/webhook_secret/);
    // Urinish HISOBLANMAYDI: yuborishga harakat ham qilinmadi.
    expect(last.attempts).toBe(3);
    expect(last.next_retry_at).toBeNull();
  });
});

describe('webhook_url sozlanganda kutayotganlar navbatga qaytadi', () => {
  function makeUpdateSvc(
    webhookUrl: string | null,
    affected: number,
    outbox?: {
      waiting?: Array<{
        id: string;
        order_id: string;
        new_status: string | null;
      }>;
      active?: Array<{ order_id: string; new_status: string | null }>;
    },
  ) {
    const calls: any[] = [];
    // Standart holat: `affected` ta ALOHIDA kalitli awaiting_config qatori
    // (dedup to'qnashuvi yo'q) — eski `affected` semantikasini saqlaydi.
    const waiting =
      outbox?.waiting ??
      Array.from({ length: affected }, (_, i) => ({
        id: `w${i}`,
        order_id: `o${i}`,
        new_status: 'sold',
      }));
    const active = outbox?.active ?? [];
    const svc: any = Object.create(IntegrationServiceService.prototype);
    svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    svc.primaryKey = null;
    svc.previousKey = null;
    svc.partnerRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: '7',
        name: 'BeePost',
        webhook_url: null,
        // Sekret ALLAQACHON sozlangan — aks holda manzil qo'yish
        // "manzil bor, sekret yo'q" holatini yaratib, rad etilardi.
        webhook_secret: 'enc:stored',
        is_active: true,
      }),
      save: jest.fn((x: any) => x),
    };
    svc.partnerWebhookOutboxRepo = {
      // `updatePartner` avval awaiting_config, keyin pending/processing
      // qatorlarni O'QIYDI (dedup uchun), so'ng ID bo'yicha yangilaydi.
      find: jest.fn((opts: any) => {
        const status = opts?.where?.status;
        return Promise.resolve(status === 'awaiting_config' ? waiting : active);
      }),
      update: jest.fn((where: any, patch: any) => {
        calls.push({ where, patch });
        return Promise.resolve({ affected: 1 });
      }),
    };
    svc.activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    svc.processPendingPartnerWebhooks = jest.fn().mockResolvedValue({});
    /**
     * `updatePartner` URLni SSRF guard orqali tekshiradi — u DNS'ga murojaat
     * qiladi. Test tarmoqqa bog'liq bo'lmasligi kerak, shuning uchun mock.
     * (Guard'ning o'zi alohida sinaladi.)
     */
    svc.assertOutboundUrlSafe = jest.fn().mockResolvedValue(undefined);
    return { svc, calls, webhookUrl };
  }

  it("TC5: url qo'yilsa awaiting_config -> pending (ALOHIDA kalitlar)", async () => {
    const { svc, calls } = makeUpdateSvc(null, 3);

    const res: any = await svc.updatePartner('7', {
      webhook_url: 'https://beepost.example.com/api/v1/elchi/webhook',
    });

    // Endi ID bo'yicha ko'tariladi (blind `status='awaiting_config'` UPDATE emas).
    const promote = calls.find((c) => c.patch.status === 'pending');
    expect(promote).toBeDefined();
    expect(res.data.requeued_webhooks).toBe(3);
    // ⚠️ Eski, TO'QNASHADIGAN naqsh ishlatilmasligi SHART: hech qaysi UPDATE
    // `where.status === 'awaiting_config'` bilan pending'ga o'girmaydi.
    expect(
      calls.some(
        (c) =>
          c.where?.status === 'awaiting_config' && c.patch.status === 'pending',
      ),
    ).toBe(false);
    // Operator natijani kutib turadi — scheduler tick'ini kutmaymiz.
    expect(svc.processPendingPartnerWebhooks).toHaveBeenCalled();
  });

  it('TC5b: takroriy (order,new_status) qatorlar 500 BERMAYDI — bittasi pending, qolgani superseded', async () => {
    // Regressiya (iiX3dhHZ): webhook_url null turganda bir xil order+status
    // ikki marta navbatga tushган -> ikkita awaiting_config qator. Ilgari
    // ikkalasi ham BIR VAQTDA pending bo'lib IDX_PWO_DEDUP (partial unique,
    // pending/processing ustida) ni buzardi -> 23505 -> PATCH 500 (lekin save
    // allaqachon bo'lgani uchun o'zgarish qolib ketardi).
    const { svc, calls } = makeUpdateSvc(null, 0, {
      waiting: [
        { id: 'w1', order_id: 'o1', new_status: 'sold' },
        { id: 'w2', order_id: 'o1', new_status: 'sold' }, // TAKROR
        { id: 'w3', order_id: 'o2', new_status: 'cancelled' },
      ],
      active: [],
    });

    const res: any = await svc.updatePartner('7', {
      webhook_url: 'https://beepost.example.com/api/v1/elchi/webhook',
    });

    const promote = calls.find((c) => c.patch.status === 'pending');
    const supersede = calls.find((c) => c.patch.status === 'completed');
    // Faqat ALOHIDA kalitlar pending: w1 (o1/sold) va w3 (o2/cancelled).
    expect(promote.where.id.value.sort()).toEqual(['w1', 'w3']);
    // Takror (w2) terminal 'completed' ga o'tadi — abadiy awaiting_config
    // bo'lib qolib keyingi requeue'da yana to'qnashmaydi.
    expect(supersede.where.id.value).toEqual(['w2']);
    expect(res.data.requeued_webhooks).toBe(2);
  });

  it('TC5c: kaliti allaqachon pending qator awaiting_config qatori ko‘tarilmaydi', async () => {
    // (order, new_status) allaqachon pending -> partial unique index shu kalit
    // ustida. Yana bir pending qo'shsak -> to'qnashuv. Shuning uchun bunday
    // awaiting_config qator superseded qilinadi.
    const { svc, calls } = makeUpdateSvc(null, 0, {
      waiting: [{ id: 'w1', order_id: 'o1', new_status: 'sold' }],
      active: [{ order_id: 'o1', new_status: 'sold' }],
    });

    const res: any = await svc.updatePartner('7', {
      webhook_url: 'https://beepost.example.com/api/v1/elchi/webhook',
    });

    expect(calls.find((c) => c.patch.status === 'pending')).toBeUndefined();
    const supersede = calls.find((c) => c.patch.status === 'completed');
    expect(supersede.where.id.value).toEqual(['w1']);
    expect(res.data.requeued_webhooks).toBe(0);
  });

  it("TC6: url O'CHIRILSA navbatga qaytarilmaydi", async () => {
    const { svc, calls } = makeUpdateSvc(null, 3);

    await svc.updatePartner('7', { webhook_url: null });

    expect(calls).toHaveLength(0);
    expect(svc.processPendingPartnerWebhooks).not.toHaveBeenCalled();
  });

  /**
   * "Manzil bor, sekret yo'q" holati SAQLANMAYDI: bunday hamkor
   * sozlangandek ko'rinadi, amalda esa har hodisa imzosiz qoladi va
   * qabul qiluvchida 401 bo'ladi.
   */
  it('TC9: sekretsiz url QO‘SHIB bo‘lmaydi', async () => {
    const { svc } = makeUpdateSvc(null, 3);
    svc.partnerRepo.findOne.mockResolvedValue({
      id: '7',
      name: 'BeePost',
      webhook_url: null,
      webhook_secret: null,
      is_active: true,
    });

    await expect(
      svc.updatePartner('7', {
        webhook_url: 'https://beepost.example.com/api/v1/elchi/webhook',
      }),
    ).rejects.toBeInstanceOf(RpcException);

    expect(svc.partnerRepo.save).not.toHaveBeenCalled();
  });

  it('TC10: url turganda sekretni O‘CHIRIB bo‘lmaydi', async () => {
    const { svc } = makeUpdateSvc(null, 3);
    svc.partnerRepo.findOne.mockResolvedValue({
      id: '7',
      name: 'BeePost',
      webhook_url: 'https://beepost.example.com/api/v1/elchi/webhook',
      webhook_secret: 'enc:stored',
      is_active: true,
    });

    await expect(
      svc.updatePartner('7', { webhook_secret: null }),
    ).rejects.toBeInstanceOf(RpcException);

    expect(svc.partnerRepo.save).not.toHaveBeenCalled();
  });
});
