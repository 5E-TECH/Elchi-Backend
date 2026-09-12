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
  payload: { event: 'shipment.status_changed' },
};

describe("webhook_url sozlanmagan -> awaiting_config", () => {
  it("TC1: `completed` EMAS, `awaiting_config` bo'ladi", async () => {
    const { svc, updates } = makeSvc({ partner: { id: '7', webhook_url: null } });

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
    const { svc, updates } = makeSvc({ partner: { id: '7', webhook_url: null } });

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

describe('webhook_url sozlanganda kutayotganlar navbatga qaytadi', () => {
  function makeUpdateSvc(webhookUrl: string | null, affected: number) {
    const calls: any[] = [];
    const svc: any = Object.create(IntegrationServiceService.prototype);
    svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    svc.primaryKey = null;
    svc.previousKey = null;
    svc.partnerRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: '7',
        name: 'BeePost',
        webhook_url: null,
        is_active: true,
      }),
      save: jest.fn(async (x: any) => x),
    };
    svc.partnerWebhookOutboxRepo = {
      update: jest.fn((where: any, patch: any) => {
        calls.push({ where, patch });
        return Promise.resolve({ affected });
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

  it('TC5: url qo\'yilsa awaiting_config -> pending', async () => {
    const { svc, calls } = makeUpdateSvc(null, 3);

    const res: any = await svc.updatePartner('7', {
      webhook_url: 'https://beepost.example.com/api/v1/elchi/webhook',
    });

    expect(calls[0].where).toEqual({
      partner_id: '7',
      status: 'awaiting_config',
    });
    expect(calls[0].patch.status).toBe('pending');
    expect(res.data.requeued_webhooks).toBe(3);
    // Operator natijani kutib turadi — scheduler tick'ini kutmaymiz.
    expect(svc.processPendingPartnerWebhooks).toHaveBeenCalled();
  });

  it("TC6: url O'CHIRILSA navbatga qaytarilmaydi", async () => {
    const { svc, calls } = makeUpdateSvc(null, 3);

    await svc.updatePartner('7', { webhook_url: null });

    expect(calls).toHaveLength(0);
    expect(svc.processPendingPartnerWebhooks).not.toHaveBeenCalled();
  });
});
