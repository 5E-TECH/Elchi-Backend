import { RpcException } from '@nestjs/microservices';
import { IntegrationServiceService } from './integration-service.service';

/**
 * P5d — hamkor webhook outbox monitori (admin).
 *
 * Qulflanadigan invariantlar:
 *   - qayta navbatga qo'yish `max_attempts` ni KO'TARADI — aks holda tugma
 *     "ishlagandek" ko'rinib, qator birinchi xatodayoq yana yopilardi;
 *   - allaqachon yetkazilgan qator QAYTA yuborilmaydi;
 *   - qisman unique indeks urilsa bu XATO emas — yangi urinish navbatda;
 *   - hamkorlar ro'yxati bitta GURUHLANGAN so'rov bilan xulosa oladi
 *     (hamkor sonicha so'rov emas).
 */

type Row = Record<string, any>;

function makeService(over: {
  row?: Row | null;
  partners?: Row[];
  summaryRows?: Row[];
  updateImpl?: jest.Mock;
} = {}) {
  const updates: Row[] = [];
  const logs: Row[] = [];
  const svc: any = Object.create(IntegrationServiceService.prototype);

  const qb: any = {
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    groupBy: jest.fn(() => qb),
    addGroupBy: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    skip: jest.fn(() => qb),
    take: jest.fn(() => qb),
    getRawMany: jest.fn(() => Promise.resolve(over.summaryRows ?? [])),
    getManyAndCount: jest.fn(() => Promise.resolve([[], 0])),
  };

  svc.partnerRepo = {
    find: jest.fn(() => Promise.resolve(over.partners ?? [])),
  };
  svc.partnerWebhookOutboxRepo = {
    findOne: jest.fn(() => Promise.resolve(over.row ?? null)),
    createQueryBuilder: jest.fn(() => qb),
    update:
      over.updateImpl ??
      jest.fn((_where: Row, patch: Row) => {
        updates.push(patch);
        return Promise.resolve({ affected: 1 });
      }),
    find: jest.fn(() => Promise.resolve([])),
  };
  svc.activityLog = {
    log: jest.fn((p: Row) => {
      logs.push(p);
      return Promise.resolve();
    }),
  };
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };

  return { svc: svc as IntegrationServiceService, updates, logs, qb };
}

describe('IntegrationServiceService — hamkorni tahrirlash', () => {
  function makeEditSvc(partner: Row | null) {
    const saved: Row[] = [];
    const logs: Row[] = [];
    const svc: any = Object.create(IntegrationServiceService.prototype);
    svc.partnerRepo = {
      findOne: jest.fn(() => Promise.resolve(partner)),
      save: jest.fn((x: Row) => {
        saved.push({ ...x });
        return Promise.resolve(x);
      }),
    };
    svc.activityLog = {
      log: jest.fn((p: Row) => {
        logs.push(p);
        return Promise.resolve();
      }),
    };
    svc.primaryKey = require('crypto')
      .createHash('sha256')
      .update('x'.repeat(40))
      .digest();
    svc.previousKey = null;
    svc.allowPrivateHosts = false;
    svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    /**
     * `webhook_url` qo'yilganda `updatePartner` sozlama yo'qligi tufayli
     * kutib turgan (`awaiting_config`) hodisalarni navbatga qaytaradi —
     * shuning uchun outbox repo ham kerak.
     */
    const requeued: Row[] = [];
    svc.partnerWebhookOutboxRepo = {
      update: jest.fn((where: Row, patch: Row) => {
        requeued.push({ where, patch });
        return Promise.resolve({ affected: 0 });
      }),
    };
    svc.processPendingPartnerWebhooks = jest.fn().mockResolvedValue({});
    return {
      svc: svc as IntegrationServiceService,
      saved,
      logs,
      partner,
      requeued,
    };
  }

  const base = (): Row => ({
    id: '1',
    name: 'BeePost',
    webhook_url: 'https://old.example.uz/hook',
    webhook_secret: 'enc:eski',
    ip_allowlist: ['1.2.3.4'],
    is_active: true,
  });

  it('berilmagan maydonga TEGMAYDI', async () => {
    const { svc, saved } = makeEditSvc(base());
    await svc.updatePartner('1', { name: 'BeePost UZ' });
    expect(saved[0].name).toBe('BeePost UZ');
    // Qolgani o'z holicha — bo'sh forma maydoni webhookni uzib qo'ymasin.
    expect(saved[0].webhook_url).toBe('https://old.example.uz/hook');
    expect(saved[0].webhook_secret).toBe('enc:eski');
    expect(saved[0].ip_allowlist).toEqual(['1.2.3.4']);
  });

  it("BO'SH SATR — tozalash (undefined dan farq qiladi)", async () => {
    const { svc, saved } = makeEditSvc(base());
    await svc.updatePartner('1', { webhook_url: '', webhook_secret: '' });
    expect(saved[0].webhook_url).toBeNull();
    expect(saved[0].webhook_secret).toBeNull();
  });

  it('yangi webhook manzili SSRF guardidan o\'tadi', async () => {
    const { svc, saved } = makeEditSvc(base());
    const spy = jest
      .spyOn(svc as any, 'assertOutboundUrlSafe')
      .mockResolvedValue(undefined);
    await svc.updatePartner('1', {
      webhook_url: 'https://yangi.example.uz/hook',
    });
    expect(spy).toHaveBeenCalledWith('https://yangi.example.uz/hook');
    expect(saved[0].webhook_url).toBe('https://yangi.example.uz/hook');
  });

  it('SSRF bloklasa hamkor SAQLANMAYDI', async () => {
    const { svc, saved } = makeEditSvc(base());
    jest
      .spyOn(svc as any, 'assertOutboundUrlSafe')
      .mockRejectedValue(new RpcException('blocked'));
    await expect(
      svc.updatePartner('1', { webhook_url: 'http://169.254.169.254/' }),
    ).rejects.toBeInstanceOf(RpcException);
    expect(saved).toHaveLength(0);
  });

  it('sekret QIYMATI auditga sizmaydi', async () => {
    const { svc, logs } = makeEditSvc(base());
    await svc.updatePartner('1', { webhook_secret: 'juda-maxfiy' });
    const logged = JSON.stringify(logs[0]);
    expect(logged).not.toContain('juda-maxfiy');
    expect(logs[0].new_value.webhook_secret_changed).toBe(true);
  });

  it('sekret AES bilan shifrlanadi (ochiq saqlanmaydi)', async () => {
    const { svc, saved } = makeEditSvc(base());
    await svc.updatePartner('1', { webhook_secret: 'juda-maxfiy' });
    expect(saved[0].webhook_secret).toMatch(/^enc:/);
    expect(saved[0].webhook_secret).not.toContain('juda-maxfiy');
  });

  it("bo'sh nom RAD ETILADI", async () => {
    const { svc } = makeEditSvc(base());
    await expect(svc.updatePartner('1', { name: '   ' })).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('hech qanday maydon berilmasa RAD ETILADI', async () => {
    const { svc, saved } = makeEditSvc(base());
    await expect(svc.updatePartner('1', {})).rejects.toBeInstanceOf(
      RpcException,
    );
    expect(saved).toHaveLength(0);
  });

  it('topilmagan hamkor RAD ETILADI', async () => {
    const { svc } = makeEditSvc(null);
    await expect(
      svc.updatePartner('yo\'q', { name: 'X' }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('API kalit bu yerda O\'ZGARMAYDI', async () => {
    const p = base();
    p.api_key_hash = 'eski-hash';
    const { svc, saved } = makeEditSvc(p);
    await svc.updatePartner('1', { name: 'Yangi nom' });
    expect(saved[0].api_key_hash).toBe('eski-hash');
  });
});

describe('IntegrationServiceService — partner webhook outbox (P5d)', () => {
  it("qayta navbat: `max_attempts` KO'TARILADI va status `pending` bo'ladi", async () => {
    const { svc, updates } = makeService({
      row: {
        id: '7',
        status: 'permanently_failed',
        attempts: 4,
        max_attempts: 4,
      },
    });

    const res: any = await svc.retryPartnerWebhook('7', { id: 'admin1' });

    expect(updates[0].status).toBe('pending');
    // Eng muhimi: chegara oshirilmasa yetkazuvchi qatorni darhol yana yopardi.
    expect(updates[0].max_attempts).toBe(5);
    expect(updates[0].next_retry_at).toBeInstanceOf(Date);
    expect(res.statusCode).toBe(200);
  });

  it('darhol yuborishga urinadi — scheduler tick kutilmaydi', async () => {
    const { svc } = makeService({
      row: { id: '7', status: 'permanently_failed', attempts: 4 },
    });
    const spy = jest
      .spyOn(svc as any, 'processPendingPartnerWebhooks')
      .mockResolvedValue({ processed: 1, delivered: 1, failed: 0 });

    await svc.retryPartnerWebhook('7');

    expect(spy).toHaveBeenCalledWith(1);
  });

  it('allaqachon yetkazilgan qator QAYTA yuborilmaydi', async () => {
    const { svc, updates } = makeService({
      row: { id: '7', status: 'completed', attempts: 1 },
    });

    const res: any = await svc.retryPartnerWebhook('7');

    expect(updates).toHaveLength(0);
    expect(res.message ?? res.msg).toBeDefined();
  });

  it("qisman unique indeks urilsa — XATO emas, 'allaqachon navbatda'", async () => {
    const { svc } = makeService({
      row: { id: '7', status: 'permanently_failed', attempts: 4 },
      updateImpl: jest.fn(() => Promise.reject({ code: '23505' })),
    });

    const res: any = await svc.retryPartnerWebhook('7');

    expect(res.statusCode).toBe(200);
    expect(res.data.skipped).toBe('already_queued');
  });

  it("unique bo'lmagan DB xatosi YUTILMAYDI", async () => {
    const { svc } = makeService({
      row: { id: '7', status: 'permanently_failed', attempts: 4 },
      updateImpl: jest.fn(() => Promise.reject(new Error('disk to\'la'))),
    });

    await expect(svc.retryPartnerWebhook('7')).rejects.toThrow("disk to'la");
  });

  it('topilmagan yozuv rad etiladi', async () => {
    const { svc } = makeService({ row: null });
    await expect(svc.retryPartnerWebhook('yo\'q')).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it("hamkorlar ro'yxati webhook xulosasini BITTA so'rov bilan oladi", async () => {
    const { svc, qb } = makeService({
      partners: [
        { id: '1', name: 'BeePost', is_active: true },
        { id: '2', name: 'Acme', is_active: false },
      ],
      summaryRows: [
        { partner_id: '1', status: 'completed', cnt: '10', last_delivered_at: new Date(5) },
        { partner_id: '1', status: 'pending', cnt: '2', last_delivered_at: null },
        { partner_id: '1', status: 'permanently_failed', cnt: '1', last_delivered_at: null },
      ],
    });

    const res: any = await svc.listPartners();

    expect(qb.getRawMany).toHaveBeenCalledTimes(1); // hamkor sonicha EMAS
    const bee = res.data.find((p: Row) => p.id === '1');
    expect(bee.webhooks).toEqual({
      pending: 2,
      failed: 1,
      completed: 10,
      last_delivered_at: new Date(5),
    });
    // Yozuvi yo'q hamkor ham nol bilan keladi — UI `undefined` ko'rmasin.
    const acme = res.data.find((p: Row) => p.id === '2');
    expect(acme.webhooks.pending).toBe(0);
    expect(acme.webhooks.last_delivered_at).toBeNull();
  });

  it("`processing` ham 'kutilmoqda' deb sanaladi", async () => {
    const { svc } = makeService({
      partners: [{ id: '1', name: 'BeePost' }],
      summaryRows: [
        { partner_id: '1', status: 'pending', cnt: '1', last_delivered_at: null },
        { partner_id: '1', status: 'processing', cnt: '3', last_delivered_at: null },
      ],
    });

    const res: any = await svc.listPartners();

    expect(res.data[0].webhooks.pending).toBe(4);
  });

  it("hamkor yo'q bo'lsa qo'shimcha so'rov qilinmaydi", async () => {
    const { svc, qb } = makeService({ partners: [] });
    const res: any = await svc.listPartners();
    expect(res.data).toEqual([]);
    expect(qb.getRawMany).not.toHaveBeenCalled();
  });
});

/**
 * TARIF MOSLASHUVCHANLIGI — foydalanuvchi talabi (2026-09-11):
 * "tarif moslashuvchan bo'lsin, bir marta ulangan integratsiyaga tegmasdan
 * o'zgartirilsin; kelajakda har viloyat uchun alohida bo'lishi mumkin".
 *
 * Avval takroriy `provisionPartnerMarket` faqat mavjud id'ni qaytarardi va
 * tarifga TEGMASDI — ya'ni tarifni o'zgartirishning yagona yo'li yangi market
 * ochish bo'lardi. Bu jimgina pul xatosi: ikki tomon turli tarifda qolardi.
 */
describe('IntegrationServiceService — market tarifi yangilanishi', () => {
  function makeSvc(existing: Row | null, current: Row | null) {
    const svc: any = Object.create(IntegrationServiceService.prototype);
    const calls: Row[] = [];
    const logs: Row[] = [];

    svc.partnerMarketRefRepo = {
      findOne: jest.fn(() => Promise.resolve(existing)),
      create: jest.fn((x: Row) => x),
      save: jest.fn((x: Row) => Promise.resolve(x)),
    };
    svc.identityClient = {};
    svc.rmqRequest = jest.fn((_c: unknown, pattern: Row, payload: Row) => {
      calls.push({ cmd: pattern.cmd, payload });
      if (pattern.cmd === 'identity.market.find_by_id') {
        return Promise.resolve({ data: current });
      }
      return Promise.resolve({ data: { id: 'new-market' } });
    });
    svc.activityLog = {
      log: jest.fn((p: Row) => {
        logs.push(p);
        return Promise.resolve();
      }),
    };
    svc.logger = { warn: jest.fn(), error: jest.fn() };
    return { svc: svc as IntegrationServiceService, calls, logs };
  }

  const dto = (home: number, center: number) => ({
    partner_id: '1',
    external_seller_id: 'seller-1',
    name: 'BeePost',
    phone: '+998900000000',
    tariff_home: home,
    tariff_center: center,
  });

  it('tarif FARQ QILSA — identity yangilanadi, market qayta yaratilmaydi', async () => {
    const { svc, calls, logs } = makeSvc(
      { elchi_market_id: 'm-1' },
      { tariff_home: 25000, tariff_center: 15000 },
    );

    const res: any = await svc.provisionPartnerMarket(dto(30000, 20000));

    const update = calls.find((c) => c.cmd === 'identity.market.update');
    expect(update).toBeDefined();
    expect(update!.payload.dto).toEqual({
      tariff_home: 30000,
      tariff_center: 20000,
    });
    // Yangi market OCHILMAYDI.
    expect(calls.find((c) => c.cmd === 'identity.market.create')).toBeUndefined();
    expect(res.data.elchi_market_id).toBe('m-1');
    expect(res.data.tariff_updated).toBe(true);
    // O'zgarish auditda eski/yangi qiymat bilan qoladi.
    expect(logs[0].old_value).toEqual({ tariff_home: 25000, tariff_center: 15000 });
  });

  it('tarif BIR XIL bo\'lsa — ortiqcha yozuv qilinmaydi', async () => {
    const { svc, calls, logs } = makeSvc(
      { elchi_market_id: 'm-1' },
      { tariff_home: 25000, tariff_center: 15000 },
    );

    const res: any = await svc.provisionPartnerMarket(dto(25000, 15000));

    expect(calls.find((c) => c.cmd === 'identity.market.update')).toBeUndefined();
    expect(res.data.tariff_updated).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it('tarif berilmasa — mavjud tarif SAQLANADI (nolga tushirilmaydi)', async () => {
    const { svc, calls } = makeSvc(
      { elchi_market_id: 'm-1' },
      { tariff_home: 25000, tariff_center: 15000 },
    );

    await svc.provisionPartnerMarket({
      partner_id: '1',
      external_seller_id: 'seller-1',
      name: 'BeePost',
      phone: '+998900000000',
    });

    // Eng muhimi: tasodifan 0 yozib, Elchi'ni bepul yetkazuvchiga
    // aylantirib qo'ymaslik.
    expect(calls.find((c) => c.cmd === 'identity.market.update')).toBeUndefined();
  });
});
