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
