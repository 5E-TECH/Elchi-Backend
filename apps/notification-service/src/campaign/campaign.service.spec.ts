import { RpcException } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { CampaignService } from './campaign.service';
import { CampaignController } from './campaign.controller';
import { CAMPAIGN_BATCH_PATTERN } from './campaign-limits';
import { DispatchAbortedError } from './dispatch-hooks';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  };
});

/** (xHPdpj0W) Kampaniya navbati — yaratish, idempotentlik, bekor qilish. */
describe('xHPdpj0W — CampaignService', () => {
  let service: CampaignService;
  let repo: any;
  let campaigns: any;
  let manager: any;
  let inbox: any;
  let outbox: any;
  let activityLog: any;
  let updates: Array<{ set: any; where: string[]; params: any }>;
  let updateResult: any;

  const identityTotal = (total: number) => ({
    data: { items: total ? [{ id: '1', role: 'courier' }] : [], total },
  });

  const baseInput = (over: Record<string, unknown> = {}) => ({
    type: 'system.manual',
    title: "Yangi e'lon",
    body: 'Matn',
    roles: ['courier'],
    idempotency_key: 'key-1',
    requester: { id: '25', roles: ['admin'] },
    ...over,
  });

  const errorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof RpcException) return error.getError() as any;
      throw error;
    }
    throw new Error('expected RpcException');
  };

  beforeEach(() => {
    rmqSendMock.mockReset();
    updates = [];
    updateResult = { affected: 1, raw: [] };
    campaigns = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn((v) => Promise.resolve({ id: '7', ...v })),
    };
    manager = { getRepository: jest.fn(() => campaigns) };
    const qb = () => {
      const entry = { set: null as any, where: [] as string[], params: {} };
      const q: any = {
        update: jest.fn(() => q),
        set: jest.fn((v) => {
          entry.set = v;
          return q;
        }),
        where: jest.fn((sql: string, p?: any) => {
          entry.where.push(sql);
          Object.assign(entry.params, p ?? {});
          return q;
        }),
        andWhere: jest.fn((sql: string, p?: any) => {
          entry.where.push(sql);
          Object.assign(entry.params, p ?? {});
          return q;
        }),
        setParameter: jest.fn(() => q),
        returning: jest.fn(() => q),
        execute: jest.fn(() => {
          updates.push(entry);
          return Promise.resolve(updateResult);
        }),
      };
      return q;
    };
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      createQueryBuilder: jest.fn(qb),
      manager: {
        transaction: jest.fn((work: (m: any) => Promise<unknown>) =>
          work(manager),
        ),
      },
    };
    inbox = { dispatch: jest.fn() };
    outbox = { enqueue: jest.fn().mockResolvedValue({ id: '1' }) };
    activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    service = new CampaignService(
      repo,
      { send: jest.fn() } as never,
      inbox,
      outbox,
      activityLog,
      { get: jest.fn(() => undefined) } as never,
    );
  });

  describe('create', () => {
    it('TC2: darhol 202 + campaign_id; yuborish fonda (dispatch chaqirilmaydi), 0-partiya outbox’ga SHU tranzaksiyada', async () => {
      rmqSendMock.mockResolvedValueOnce(identityTotal(5000));
      const res: any = await service.create(baseInput());

      expect(res.statusCode).toBe(202);
      expect(res.data).toEqual(
        expect.objectContaining({
          campaign_id: '7',
          status: 'queued',
          total: 5000,
          duplicate: false,
        }),
      );
      expect(inbox.dispatch).not.toHaveBeenCalled();
      // identity'ga faqat COUNT (limit 1) — 5000 qator yig'ilmaydi
      expect(rmqSendMock.mock.calls[0][2]).toEqual(
        expect.objectContaining({
          roles: ['courier'],
          limit: 1,
          with_total: true,
        }),
      );
      expect(outbox.enqueue).toHaveBeenCalledWith(
        'NOTIFICATION',
        CAMPAIGN_BATCH_PATTERN,
        { campaign_id: '7', batch_no: 0, limit: 200 },
        expect.objectContaining({ manager, requestId: 'campaign:7:b0' }),
      );
      expect(outbox.enqueue.mock.calls[0][3]).not.toHaveProperty('scheduledAt');
    });

    it('TC12: yuboruvchi (created_by) va auditoriya sharti saqlanadi + audit', async () => {
      rmqSendMock.mockResolvedValueOnce(identityTotal(3));
      await service.create(
        baseInput({
          roles: ['customer'],
          include_customers: true,
          segment: { region_id: '5', market_id: '' },
        }),
      );
      const saved = campaigns.save.mock.calls[0][0];
      expect(saved).toEqual(
        expect.objectContaining({
          created_by: '25',
          audience: {
            roles: ['customer'],
            include_customers: true,
            segment: { region_id: '5' },
          },
          channels: ['in_app', 'realtime'],
          idempotency_key: 'key-1',
          status: 'queued',
        }),
      );
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'NotificationCampaign',
          action: 'notification.campaign.created',
          user_id: '25',
        }),
      );
    });

    it('TC7: scheduled_at — outbox `scheduledAt` orqali (alohida scheduler yo‘q)', async () => {
      rmqSendMock.mockResolvedValueOnce(identityTotal(10));
      const at = new Date(Date.now() + 3_600_000);
      const res: any = await service.create(
        baseInput({ scheduled_at: at.toISOString() }),
      );
      expect(res.message).toBe('Campaign scheduled');
      expect(outbox.enqueue.mock.calls[0][3].scheduledAt.getTime()).toBe(
        at.getTime(),
      );
      expect(campaigns.save.mock.calls[0][0].scheduled_at.getTime()).toBe(
        at.getTime(),
      );
    });

    it('TC5: bir xil idempotency_key — ikkinchi kampaniya YARATILMAYDI, mavjudi qaytadi', async () => {
      rmqSendMock.mockResolvedValueOnce(identityTotal(10));
      await service.create(baseInput());
      const hash = campaigns.save.mock.calls[0][0].request_hash;
      repo.findOne.mockResolvedValueOnce({
        id: '7',
        status: 'running',
        total: 10,
        scheduled_at: null,
        request_hash: hash,
      });

      const again: any = await service.create(baseInput());
      expect(again.data).toEqual(
        expect.objectContaining({ campaign_id: '7', duplicate: true }),
      );
      expect(campaigns.save).toHaveBeenCalledTimes(1);
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    });

    it('TC5: shu kalit, boshqa mazmun — 409', async () => {
      repo.findOne.mockResolvedValueOnce({ id: '7', request_hash: 'other' });
      const err = await errorOf(service.create(baseInput({ title: 'Boshqa' })));
      expect(err.statusCode).toBe(409);
      expect(campaigns.save).not.toHaveBeenCalled();
    });

    it('TC5: parallel bosish (UNIQUE 23505) — mavjud kampaniya qaytadi', async () => {
      rmqSendMock.mockResolvedValueOnce(identityTotal(10));
      let hash = '';
      campaigns.save.mockImplementationOnce((v: any) => {
        hash = v.request_hash;
        return Promise.reject(
          Object.assign(new Error('dup'), { code: '23505' }),
        );
      });
      repo.findOne
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(() =>
          Promise.resolve({ id: '9', status: 'queued', request_hash: hash }),
        );
      const res: any = await service.create(baseInput());
      expect(res.data).toEqual(
        expect.objectContaining({ campaign_id: '9', duplicate: true }),
      );
    });

    it.each([
      ['Idempotency-Key yo‘q', { idempotency_key: '' }],
      ['SMS kanali (real pul, alohida epik)', { channels: ['in_app', 'sms'] }],
      ['telegram kanali', { channels: ['telegram'] }],
      ['katalogda yo‘q tur', { type: 'promo.blast' }],
      ['mijoz bayroqsiz (W8aerwL6 TC7)', { roles: ['customer'] }],
      ['recipient_ids + roles birga', { recipient_ids: ['1'] }],
      ['scheduled_at noto‘g‘ri', { scheduled_at: 'ertaga' }],
    ])('400: %s', async (_name, over) => {
      const err = await errorOf(service.create(baseInput(over)));
      expect(err.statusCode).toBe(400);
      expect(campaigns.save).not.toHaveBeenCalled();
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('chegaradan katta auditoriya — 400 (jimgina kesilmaydi); bo‘sh — 400', async () => {
      rmqSendMock.mockResolvedValueOnce(identityTotal(20_001));
      const err = await errorOf(service.create(baseInput()));
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('20000');
      rmqSendMock.mockResolvedValueOnce(identityTotal(0));
      expect((await errorOf(service.create(baseInput()))).statusCode).toBe(400);
      expect(campaigns.save).not.toHaveBeenCalled();
    });
  });

  describe('runBatch', () => {
    const campaign = (over: Record<string, unknown> = {}) => ({
      id: '7',
      status: 'running',
      batch_no: 0,
      batch_size: 200,
      cursor_after_id: null,
      sent: 0,
      failed: 0,
      total: 3,
      audience: { roles: ['courier'] },
      type: 'system.manual',
      category: 'system',
      priority: 'normal',
      title: 'T',
      body: null,
      data: null,
      link: null,
      channels: ['in_app', 'realtime'],
      created_by: '25',
      scheduled_at: null,
      ...over,
    });

    it('TC6: cancelled — keyingi partiya boshlanmaydi (identity ham, dispatch ham yo‘q)', async () => {
      repo.findOne.mockResolvedValueOnce(campaign({ status: 'cancelled' }));
      const res = await service.runBatch({ campaign_id: '7', batch_no: 1 });
      expect(res).toEqual(expect.objectContaining({ skipped: 'cancelled' }));
      expect(rmqSendMock).not.toHaveBeenCalled();
      expect(inbox.dispatch).not.toHaveBeenCalled();
    });

    it('eskirgan/qayta yetkazilgan partiya (batch_no mos emas) — e’tiborsiz', async () => {
      repo.findOne.mockResolvedValueOnce(campaign({ batch_no: 3 }));
      const res = await service.runBatch({ campaign_id: '7', batch_no: 2 });
      expect(res).toEqual(expect.objectContaining({ skipped: 'stale_batch' }));
      expect(inbox.dispatch).not.toHaveBeenCalled();
    });

    it('TC7: vaqti kelmagan partiya (erta yetib kelgan) — yuborilmaydi, scheduled_at ga qayta qo‘yiladi', async () => {
      const at = new Date(Date.now() + 600_000);
      repo.findOne.mockResolvedValueOnce(
        campaign({ status: 'queued', scheduled_at: at }),
      );
      const res = await service.runBatch({ campaign_id: '7', batch_no: 0 });
      expect(res).toEqual(expect.objectContaining({ skipped: 'not_due' }));
      expect(inbox.dispatch).not.toHaveBeenCalled();
      expect(outbox.enqueue.mock.calls[0][3].scheduledAt).toEqual(at);
    });

    it('partiya — mavjud dispatch mantiqi tayyor qabul qiluvchilar va tranzaksiya ilgaklari bilan', async () => {
      repo.findOne.mockResolvedValueOnce(campaign());
      rmqSendMock.mockResolvedValueOnce({
        data: {
          items: [
            { id: '11', role: 'courier' },
            { id: '12', role: 'courier' },
          ],
          next_after_id: null,
        },
      });
      inbox.dispatch.mockImplementation(async (_dto: any, internal: any) => {
        await internal.beforePersist(manager);
        await internal.afterPersist(manager, [{ id: 'a' }, { id: 'b' }]);
        return { data: { dispatched: 2 } };
      });
      manager.createQueryBuilder = repo.createQueryBuilder;

      const res = await service.runBatch({ campaign_id: '7', batch_no: 0 });
      expect(res).toEqual(expect.objectContaining({ status: 'done', sent: 2 }));
      const [dto, internal] = inbox.dispatch.mock.calls[0];
      expect(internal.recipients).toEqual([
        { id: '11', role: 'courier' },
        { id: '12', role: 'courier' },
      ]);
      expect(dto).toEqual(
        expect.objectContaining({
          type: 'system.manual',
          group_key: 'campaign:7',
          request_id: 'campaign:7:b0',
          data: { campaign_id: '7' },
        }),
      );
      // identity keyset: kursor kampaniya qatoridan, PII minimal
      expect(rmqSendMock.mock.calls[0][2]).toEqual(
        expect.objectContaining({
          roles: ['courier'],
          after_id: null,
          limit: 200,
          fields: 'minimal',
        }),
      );
      // da'vo: status=running AND batch_no=0; advance: sent + n, oxirgi — done
      expect(updates[0].where).toEqual(
        expect.arrayContaining(['status = :running', 'batch_no = :batchNo']),
      );
      expect(updates[1].set.status).toBe('done');
      expect(updates[1].set.cursor_after_id).toBe('12');
      // oxirgi partiya — keyingisi navbatga qo'yilmaydi
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('da’vo yutqazildi (bekor qilindi / allaqachon bajarildi) — hech narsa yozilmaydi', async () => {
      repo.findOne.mockResolvedValueOnce(campaign());
      rmqSendMock.mockResolvedValueOnce({
        data: { items: [{ id: '11', role: 'courier' }] },
      });
      inbox.dispatch.mockRejectedValueOnce(
        new DispatchAbortedError('claim_lost'),
      );
      const res = await service.runBatch({ campaign_id: '7', batch_no: 0 });
      expect(res).toEqual(expect.objectContaining({ skipped: 'claim_lost' }));
    });

    it('partiya xatosi: chegaragacha RpcException (outbox qayta uradi), 3-urinishda kampaniya failed', async () => {
      repo.findOne.mockResolvedValue(campaign());
      rmqSendMock.mockRejectedValue(new Error('identity down'));
      updateResult = { affected: 1, raw: [{ batch_attempts: 1 }] };
      const err = await errorOf(
        service.runBatch({ campaign_id: '7', batch_no: 0 }),
      );
      expect(err.statusCode).toBe(503);

      updateResult = { affected: 1, raw: [{ batch_attempts: 3 }] };
      const res = await service.runBatch({ campaign_id: '7', batch_no: 0 });
      expect(res).toEqual(expect.objectContaining({ status: 'failed' }));
      const failUpdate = updates[updates.length - 1];
      expect(failUpdate.set.status).toBe('failed');
      expect(failUpdate.set.last_error).toContain('3 marta');
    });
  });

  describe('cancel / get', () => {
    it('TC6: cancel — faol kampaniya cancelled; yakunlangan — 409; yo‘q — 404', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: '7',
        status: 'cancelled',
        sent: 400,
        total: 1000,
        failed: 0,
        skipped: 600,
        batch_no: 2,
      });
      const res: any = await service.cancel({
        id: '7',
        requester: { id: '25', roles: ['admin'] },
      });
      expect(res.data.status).toBe('cancelled');
      expect(updates[0].set).toEqual(
        expect.objectContaining({ status: 'cancelled', cancelled_by: '25' }),
      );
      expect(updates[0].params.active).toEqual(['draft', 'queued', 'running']);

      updateResult = { affected: 0 };
      repo.findOne.mockResolvedValueOnce({ id: '7', status: 'done' });
      expect((await errorOf(service.cancel({ id: '7' }))).statusCode).toBe(409);
      repo.findOne.mockResolvedValueOnce(null);
      expect((await errorOf(service.cancel({ id: '8' }))).statusCode).toBe(404);
    });

    it('TC4: get — total/sent/failed/skipped va progress_pct', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: '7',
        status: 'running',
        total: 5000,
        sent: 1200,
        failed: 0,
        skipped: 0,
        batch_no: 6,
        batch_size: 200,
        audience: { roles: ['courier'] },
        created_by: '25',
      });
      const res: any = await service.get({ id: '7' });
      expect(res.data).toEqual(
        expect.objectContaining({
          total: 5000,
          sent: 1200,
          failed: 0,
          skipped: 0,
          progress_pct: 24,
          batches_done: 6,
          created_by: '25',
          audience: { roles: ['courier'] },
        }),
      );
      expect((await errorOf(service.get({ id: 'x' }))).statusCode).toBe(400);
    });
  });

  it('RMQ patternlari CampaignController da (create/list/get/cancel/batch + audience.preview)', () => {
    const proto = CampaignController.prototype as any;
    const cmds = Object.getOwnPropertyNames(proto)
      .map((name) => Reflect.getMetadata(PATTERN_METADATA, proto[name]))
      .filter(Boolean)
      .flat()
      .map((p: any) => p.cmd);
    expect(cmds.sort()).toEqual(
      [
        'notification.audience.preview',
        'notification.campaign.batch',
        'notification.campaign.cancel',
        'notification.campaign.create',
        'notification.campaign.get',
        'notification.campaign.list',
        // (WIsb9Ytq) rejalashtirish qoidasi / vaqt tekshiruvi.
        'notification.campaign.schedule_policy',
      ].sort(),
    );
  });
});
