import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { RpcException } from '@nestjs/microservices';
import { CampaignService } from './campaign.service';
import { CAMPAIGN_BATCH_PATTERN } from './campaign-limits';
import {
  PROMO_QUIET_RELEASE_SQL,
  campaignDisplayStatus,
  parseZonedInstant,
  promoReleaseAt,
  toTashkentIso,
} from './campaign-schedule';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  };
});

/**
 * WIsb9Ytq — kampaniyani rejalashtirish va tungi taqiq darvozasi (backend
 * TC'lari). SQL'ning o'zi (AT TIME ZONE) haqiqiy Postgres'da —
 * campaign-schedule.pg.spec.ts.
 */
describe('WIsb9Ytq — rejalashtirish va tungi taqiq darvozasi', () => {
  let service: CampaignService;
  let repo: any;
  let campaigns: any;
  let manager: any;
  let inbox: any;
  let outbox: any;
  let config: Record<string, string | undefined>;
  let updates: Array<{ set: any; where: string[]; params: any }>;
  let updateResult: any;
  /** SQL darvozasi javobi (haqiqiy hisob — pg spec). */
  let releaseAt: (at: Date) => Date;

  // 2026-10-20 19:00 Toshkent = 14:00Z (taqiq ichida), ertangi 09:00 = 04:00Z.
  const NIGHT = new Date('2026-10-20T14:00:00.000Z');
  const NEXT_MORNING = new Date('2026-10-21T04:00:00.000Z');
  const DAY = new Date('2026-10-20T05:00:00.000Z'); // 10:00 Toshkent

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

  const promoInput = (over: Record<string, unknown> = {}) =>
    baseInput({ type: 'marketing.manual', title: 'Aksiya', ...over });

  const errorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof RpcException) return error.getError() as any;
      throw error;
    }
    throw new Error('expected RpcException');
  };

  const useClock = (now: Date) =>
    jest.useFakeTimers({
      now,
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
      ],
    });

  beforeEach(() => {
    rmqSendMock.mockReset();
    updates = [];
    updateResult = { affected: 1, raw: [] };
    config = {};
    releaseAt = (at) => at;
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
        query: jest.fn((_sql: string, params: unknown[]) =>
          Promise.resolve([
            { release_at: releaseAt(new Date(params[0] as string)) },
          ]),
        ),
      },
    };
    inbox = { dispatch: jest.fn() };
    outbox = { enqueue: jest.fn().mockResolvedValue({ id: '1' }) };
    service = new CampaignService(
      repo,
      { send: jest.fn() } as never,
      inbox,
      outbox,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { get: jest.fn((key: string) => config[key]) } as never,
    );
  });

  afterEach(() => jest.useRealTimers());

  describe('TC5: scheduled_at — ISO + zona, Asia/Tashkent', () => {
    it('zonali ISO qabul qilinadi; zonasiz/sanasiz satr — 400 (brauzer mahalliy vaqti emas)', () => {
      expect(parseZonedInstant('2026-10-20T09:00:00+05:00').toISOString()).toBe(
        '2026-10-20T04:00:00.000Z',
      );
      expect(parseZonedInstant('2026-10-20T04:00:00.000Z').toISOString()).toBe(
        '2026-10-20T04:00:00.000Z',
      );
      for (const bad of [
        '2026-10-20T09:00:00',
        '2026-10-20 09:00',
        '2026-10-20',
        '20.10.2026 09:00',
      ]) {
        expect(() => parseZonedInstant(bad)).toThrow(/zona/);
      }
      expect(toTashkentIso(new Date('2026-10-20T04:00:00.000Z'))).toBe(
        '2026-10-20T09:00:00+05:00',
      );
    });

    it('create: zonasiz scheduled_at → 400, hech narsa yaratilmaydi', async () => {
      useClock(DAY);
      const err = await errorOf(
        service.create(baseInput({ scheduled_at: '2026-10-21T09:00:00' })),
      );
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/zona/);
      expect(campaigns.save).not.toHaveBeenCalled();
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('create: +05:00 bilan — aynan o’sha lahza (UTC 04:00), javobda Toshkent ko’rinishi', async () => {
      useClock(DAY);
      rmqSendMock.mockResolvedValueOnce(identityTotal(10));
      const res: any = await service.create(
        baseInput({ scheduled_at: '2026-10-21T09:00:00+05:00' }),
      );
      const at = new Date('2026-10-21T04:00:00.000Z');
      expect(res.statusCode).toBe(202);
      expect(res.data).toEqual(
        expect.objectContaining({
          display_status: 'scheduled',
          quiet_hours_shifted: false,
          timezone: 'Asia/Tashkent',
          scheduled_at_tashkent: '2026-10-21T09:00:00+05:00',
        }),
      );
      expect(campaigns.save.mock.calls[0][0].scheduled_at).toEqual(at);
      expect(outbox.enqueue.mock.calls[0][3].scheduledAt).toEqual(at);
    });

    it('TC1: “Darhol” — scheduled_at yo’q: darhol navbat (scheduledAt yo’q), holat sending', async () => {
      useClock(DAY);
      rmqSendMock.mockResolvedValueOnce(identityTotal(3));
      const res: any = await service.create(baseInput());
      expect(res.message).toBe('Campaign queued');
      expect(res.data).toEqual(
        expect.objectContaining({
          scheduled_at: null,
          display_status: 'sending',
          quiet_hours_shifted: false,
        }),
      );
      expect(outbox.enqueue.mock.calls[0][3]).not.toHaveProperty('scheduledAt');
    });
  });

  describe('tungi taqiq darvozasi (reklama surilsin, tashlanmasin)', () => {
    it('reklama 19:00 da “darhol” — ertangi 09:00 ga suriladi (tashlanmaydi), SQL darvozasi sozlamadan', async () => {
      useClock(NIGHT);
      releaseAt = () => NEXT_MORNING;
      rmqSendMock.mockResolvedValueOnce(identityTotal(50));
      const res: any = await service.create(promoInput());
      expect(res.statusCode).toBe(202);
      expect(res.message).toBe('Campaign scheduled');
      expect(res.data).toEqual(
        expect.objectContaining({
          status: 'queued',
          display_status: 'scheduled',
          requested_scheduled_at: null,
          quiet_hours_shifted: true,
          scheduled_at_tashkent: '2026-10-21T09:00:00+05:00',
        }),
      );
      expect(campaigns.save.mock.calls[0][0].scheduled_at).toEqual(
        NEXT_MORNING,
      );
      expect(outbox.enqueue.mock.calls[0][3].scheduledAt).toEqual(NEXT_MORNING);
      // Darvoza: bitta SQL, lahza + oyna (18:00 = 1080, 09:00 = 540 daqiqa)
      expect(repo.manager.query).toHaveBeenCalledWith(PROMO_QUIET_RELEASE_SQL, [
        NIGHT.toISOString(),
        1080,
        540,
      ]);
    });

    it('reklama belgilangan vaqti taqiqda (ertaga 20:00) — o’sha kechadan keyingi 09:00 ga; so’ralgan vaqt javobda', async () => {
      useClock(DAY);
      const requested = new Date('2026-10-21T15:00:00.000Z'); // 20:00 Toshkent
      const release = new Date('2026-10-22T04:00:00.000Z');
      releaseAt = () => release;
      rmqSendMock.mockResolvedValueOnce(identityTotal(5));
      const res: any = await service.create(
        promoInput({ scheduled_at: '2026-10-21T20:00:00+05:00' }),
      );
      expect(res.data.requested_scheduled_at).toEqual(requested);
      expect(res.data.quiet_hours_shifted).toBe(true);
      expect(res.data.scheduled_at).toEqual(release);
      expect(outbox.enqueue.mock.calls[0][3].scheduledAt).toEqual(release);
    });

    it('taqiq oynasi sozlanadi (NOTIF_PROMO_QUIET_HOURS), kodga qotirilmagan', async () => {
      useClock(DAY);
      config.NOTIF_PROMO_QUIET_HOURS = '20:00-08:30';
      rmqSendMock.mockResolvedValueOnce(identityTotal(5));
      await service.create(promoInput());
      expect(repo.manager.query.mock.calls[0][1]).toEqual([
        DAY.toISOString(),
        1200,
        510,
      ]);
    });

    it('reklama kunduzi (10:00) — darhol navbatga (surilmaydi)', async () => {
      useClock(DAY);
      rmqSendMock.mockResolvedValueOnce(identityTotal(5));
      const res: any = await service.create(promoInput());
      expect(res.data.scheduled_at).toBeNull();
      expect(res.data.quiet_hours_shifted).toBe(false);
      expect(outbox.enqueue.mock.calls[0][3]).not.toHaveProperty('scheduledAt');
    });

    it('TC11: tranzaksion (promo emas) xabar 19:00 da ham BLOKLANMAYDI — darvoza umuman chaqirilmaydi', async () => {
      useClock(NIGHT);
      releaseAt = () => NEXT_MORNING;
      rmqSendMock.mockResolvedValueOnce(identityTotal(5));
      const res: any = await service.create(baseInput());
      expect(res.data.scheduled_at).toBeNull();
      expect(res.data.quiet_hours_shifted).toBe(false);
      expect(repo.manager.query).not.toHaveBeenCalled();
      expect(outbox.enqueue.mock.calls[0][3]).not.toHaveProperty('scheduledAt');
    });

    it('darvoza javobini o’qib bo’lmasa — XATO (fail-closed), kampaniya yaratilmaydi', async () => {
      useClock(NIGHT);
      repo.manager.query.mockResolvedValueOnce([{ release_at: null }]);
      rmqSendMock.mockResolvedValueOnce(identityTotal(5));
      const err = await errorOf(service.create(promoInput()));
      expect(err.statusCode).toBe(500);
      expect(campaigns.save).not.toHaveBeenCalled();
    });
  });

  describe('runBatch — har partiya oldidan darvoza', () => {
    const campaign = (over: Record<string, unknown> = {}) => ({
      id: '7',
      status: 'running',
      batch_no: 3,
      batch_size: 200,
      cursor_after_id: '600',
      sent: 600,
      failed: 0,
      total: 5000,
      audience: { roles: ['customer'], include_customers: true },
      type: 'marketing.manual',
      category: 'marketing',
      priority: 'normal',
      title: 'Aksiya',
      body: null,
      data: null,
      link: null,
      channels: ['in_app', 'push'],
      created_by: '25',
      scheduled_at: null,
      paused_until: null,
      ...over,
    });

    it('17:59 da boshlangan reklama — 18:00 dan keyingi partiya ertangi 09:00 ga suriladi (o’sha partiya raqami bilan), hech kim olmaydi', async () => {
      useClock(NIGHT);
      releaseAt = () => NEXT_MORNING;
      repo.findOne.mockResolvedValueOnce(campaign());
      const res: any = await service.runBatch({
        campaign_id: '7',
        batch_no: 3,
      });
      expect(res).toEqual(
        expect.objectContaining({
          skipped: 'quiet_hours',
          resume_at: NEXT_MORNING,
        }),
      );
      expect(rmqSendMock).not.toHaveBeenCalled();
      expect(inbox.dispatch).not.toHaveBeenCalled();
      expect(updates[0].set).toEqual({ paused_until: NEXT_MORNING });
      expect(updates[0].params).toEqual(
        expect.objectContaining({
          batchNo: 3,
          active: ['draft', 'queued', 'running'],
        }),
      );
      expect(outbox.enqueue).toHaveBeenCalledWith(
        'NOTIFICATION',
        CAMPAIGN_BATCH_PATTERN,
        { campaign_id: '7', batch_no: 3, limit: 200 },
        expect.objectContaining({
          requestId: 'campaign:7:b3',
          scheduledAt: NEXT_MORNING,
        }),
      );
    });

    it('boshlanmagan reklama (queued, vaqti kelgan) tunda — boshlanmaydi, 09:00 ga suriladi', async () => {
      useClock(NIGHT);
      releaseAt = () => NEXT_MORNING;
      repo.findOne.mockResolvedValueOnce(
        campaign({ status: 'queued', batch_no: 0, sent: 0 }),
      );
      const res: any = await service.runBatch({
        campaign_id: '7',
        batch_no: 0,
      });
      expect(res.skipped).toBe('quiet_hours');
      // start() (queued → running) chaqirilmadi: faqat paused_until UPDATE
      expect(updates).toHaveLength(1);
      expect(updates[0].set).toEqual({ paused_until: NEXT_MORNING });
    });

    it('surish paytida bekor qilingan — qayta navbatga qo’yilmaydi', async () => {
      useClock(NIGHT);
      releaseAt = () => NEXT_MORNING;
      updateResult = { affected: 0 };
      repo.findOne.mockResolvedValueOnce(campaign());
      const res: any = await service.runBatch({
        campaign_id: '7',
        batch_no: 3,
      });
      expect(res.skipped).toBe('not_active');
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('09:00 dan keyin (oyna tugagan) — partiya odatdagidek ketadi, paused_until tozalanadi', async () => {
      useClock(DAY);
      repo.findOne.mockResolvedValueOnce(campaign());
      rmqSendMock.mockResolvedValueOnce({
        data: { items: [{ id: '601', role: 'customer' }] },
      });
      inbox.dispatch.mockImplementation(async (_dto: any, internal: any) => {
        await internal.beforePersist(manager);
        await internal.afterPersist(manager, [{ id: 'a' }]);
        return { data: { dispatched: 1 } };
      });
      manager.createQueryBuilder = repo.createQueryBuilder;
      const res: any = await service.runBatch({
        campaign_id: '7',
        batch_no: 3,
      });
      expect(res).toEqual(expect.objectContaining({ status: 'done', sent: 1 }));
      expect(inbox.dispatch).toHaveBeenCalledTimes(1);
      const advance = updates.find((u) => u.set && 'sent' in u.set);
      expect(advance?.set.paused_until).toBeNull();
    });

    it('TC11: tranzaksion kampaniya partiyasi tunda ham ketadi (darvoza chaqirilmaydi)', async () => {
      useClock(NIGHT);
      releaseAt = () => NEXT_MORNING;
      repo.findOne.mockResolvedValueOnce(
        campaign({ type: 'system.manual', category: 'system' }),
      );
      rmqSendMock.mockResolvedValueOnce({
        data: { items: [{ id: '601', role: 'courier' }] },
      });
      inbox.dispatch.mockResolvedValueOnce({ data: { dispatched: 1 } });
      const res: any = await service.runBatch({
        campaign_id: '7',
        batch_no: 3,
      });
      expect(res.skipped).toBeUndefined();
      expect(inbox.dispatch).toHaveBeenCalledTimes(1);
      expect(repo.manager.query).not.toHaveBeenCalled();
    });
  });

  describe('TC6–TC8: ro’yxat holati va bekor qilish', () => {
    const at = (iso: string) => new Date(iso);

    it('display_status: rejalashtirilgan / yuborilmoqda / yuborilgan / bekor qilingan / xato', () => {
      const now = DAY.getTime();
      const future = at('2026-10-21T04:00:00.000Z');
      const past = at('2026-10-19T04:00:00.000Z');
      const cases: Array<[any, string]> = [
        [{ status: 'queued', scheduled_at: future }, 'scheduled'],
        [
          { status: 'queued', scheduled_at: null, paused_until: future },
          'scheduled',
        ],
        [{ status: 'queued', scheduled_at: past }, 'sending'],
        [{ status: 'queued', scheduled_at: null }, 'sending'],
        [
          { status: 'running', scheduled_at: past, paused_until: future },
          'sending',
        ],
        [{ status: 'done', scheduled_at: future }, 'sent'],
        [{ status: 'cancelled', scheduled_at: future }, 'cancelled'],
        [{ status: 'failed', scheduled_at: null }, 'failed'],
      ];
      for (const [row, expected] of cases) {
        expect([row, campaignDisplayStatus(row, now)]).toEqual([row, expected]);
      }
    });

    it('get: rejalashtirilgan — “rejalashtirilgan” + Bekor qilish bor; yuborilgan — tugma YO’Q', async () => {
      useClock(DAY);
      repo.findOne.mockResolvedValueOnce({
        id: '7',
        status: 'queued',
        category: 'marketing',
        total: 10,
        sent: 0,
        failed: 0,
        skipped: 0,
        batch_no: 0,
        scheduled_at: at('2026-10-21T04:00:00.000Z'),
        paused_until: null,
      });
      const scheduled: any = await service.get({ id: '7' });
      expect(scheduled.data).toEqual(
        expect.objectContaining({
          display_status: 'scheduled',
          can_cancel: true,
          is_promo: true,
          timezone: 'Asia/Tashkent',
          scheduled_at_tashkent: '2026-10-21T09:00:00+05:00',
        }),
      );

      repo.findOne.mockResolvedValueOnce({
        id: '8',
        status: 'done',
        category: 'system',
        total: 10,
        sent: 10,
        failed: 0,
        skipped: 0,
        batch_no: 1,
        scheduled_at: null,
      });
      const sent: any = await service.get({ id: '8' });
      expect(sent.data).toEqual(
        expect.objectContaining({ display_status: 'sent', can_cancel: false }),
      );
    });

    it('TC7/TC8: yuborilmagan (rejalashtirilgan) — bekor qilinadi; yuborilgan — 409', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: '7',
        status: 'cancelled',
        category: 'marketing',
        total: 10,
        sent: 0,
        failed: 0,
        skipped: 10,
        batch_no: 0,
        scheduled_at: at('2026-10-21T04:00:00.000Z'),
      });
      const res: any = await service.cancel({
        id: '7',
        requester: { id: '25', roles: ['admin'] },
      });
      expect(res.data).toEqual(
        expect.objectContaining({
          status: 'cancelled',
          display_status: 'cancelled',
          can_cancel: false,
        }),
      );
      expect(updates[0].params.active).toEqual(['draft', 'queued', 'running']);

      updateResult = { affected: 0 };
      repo.findOne.mockResolvedValueOnce({ id: '8', status: 'done' });
      const err = await errorOf(service.cancel({ id: '8' }));
      expect(err.statusCode).toBe(409);
    });

    it('list ?state=scheduled — faqat kelajakdagi (yoki tungi taqiqda turgan) navbatdagilar; state+status — 400', async () => {
      useClock(DAY);
      await service.list({ state: 'scheduled' });
      const where = repo.findAndCount.mock.calls[0][0].where;
      expect(Array.isArray(where)).toBe(true);
      expect(where).toHaveLength(2);
      for (const clause of where) {
        expect(clause.isDeleted).toBe(false);
        expect(clause.status.value).toEqual(['queued', 'draft']);
      }
      expect(where[0].scheduled_at.type).toBe('moreThan');
      expect(where[0].scheduled_at.value).toEqual(DAY);
      expect(where[1].paused_until.type).toBe('moreThan');

      await service.list({ state: 'sent' });
      expect(repo.findAndCount.mock.calls[1][0].where).toEqual([
        { isDeleted: false, status: 'done' },
      ]);
      await service.list({ state: 'sending' });
      expect(repo.findAndCount.mock.calls[2][0].where).toHaveLength(5);

      expect((await errorOf(service.list({ state: 'bogus' }))).statusCode).toBe(
        400,
      );
      expect(
        (await errorOf(service.list({ state: 'sent', status: 'done' })))
          .statusCode,
      ).toBe(400);
    });
  });

  describe('(fb4qy6bd) requested_at + quiet_hours_shifted saqlanadi va GET da qaytadi', () => {
    type Saved = {
      requested_at: Date | null;
      quiet_hours_shifted: boolean;
      scheduled_at: Date | null;
    };
    const savedRow = () =>
      (
        (campaigns as { save: jest.Mock }).save.mock.calls as unknown[][]
      )[0][0] as Saved;
    const dataOf = (res: unknown) =>
      (res as { data: Record<string, unknown> }).data;

    it('reklama 19:00 da darhol — requested_at = hozir, surilgan; qatorga yoziladi', async () => {
      useClock(NIGHT);
      releaseAt = () => NEXT_MORNING;
      rmqSendMock.mockResolvedValueOnce(identityTotal(50));
      const res: unknown = await service.create(promoInput());
      const saved = savedRow();
      expect(saved.requested_at).toEqual(NIGHT);
      expect(saved.quiet_hours_shifted).toBe(true);
      expect(saved.scheduled_at).toEqual(NEXT_MORNING);
      expect(dataOf(res).requested_at).toEqual(NIGHT);
    });

    it('belgilangan vaqt (ertaga 20:00) — requested_at = so‘ralgan, scheduled_at = surilgan', async () => {
      useClock(DAY);
      const requested = new Date('2026-10-21T15:00:00.000Z');
      const release = new Date('2026-10-22T04:00:00.000Z');
      releaseAt = () => release;
      rmqSendMock.mockResolvedValueOnce(identityTotal(5));
      await service.create(
        promoInput({ scheduled_at: '2026-10-21T20:00:00+05:00' }),
      );
      const saved = savedRow();
      expect(saved.requested_at).toEqual(requested);
      expect(saved.quiet_hours_shifted).toBe(true);
      expect(saved.scheduled_at).toEqual(release);
    });

    it('tranzaksion darhol — requested_at = hozir, surilmagan', async () => {
      useClock(NIGHT);
      rmqSendMock.mockResolvedValueOnce(identityTotal(5));
      await service.create(baseInput());
      const saved = savedRow();
      expect(saved.requested_at).toEqual(NIGHT);
      expect(saved.quiet_hours_shifted).toBe(false);
    });

    it('GET campaigns (get / list) — requested_at, requested_at_tashkent, quiet_hours_shifted; eski qator — null / false', async () => {
      const row = {
        id: '7',
        status: 'queued',
        category: 'marketing',
        total: 10,
        sent: 0,
        failed: 0,
        skipped: 0,
        batch_no: 0,
        scheduled_at: NEXT_MORNING,
        paused_until: null,
        requested_at: NIGHT,
        quiet_hours_shifted: true,
      };
      (repo as { findOne: jest.Mock }).findOne.mockResolvedValueOnce(row);
      const one: unknown = await service.get({ id: '7' });
      expect(dataOf(one)).toMatchObject({
        requested_at: NIGHT,
        requested_at_tashkent: '2026-10-20T19:00:00+05:00',
        quiet_hours_shifted: true,
        scheduled_at_tashkent: '2026-10-21T09:00:00+05:00',
      });

      const legacy = { ...row, id: '6' } as Record<string, unknown>;
      delete legacy.requested_at;
      delete legacy.quiet_hours_shifted;
      (repo as { findAndCount: jest.Mock }).findAndCount.mockResolvedValueOnce([
        [row, legacy],
        2,
      ]);
      const list: unknown = await service.list({});
      const items = dataOf(list).items as Array<Record<string, unknown>>;
      expect(items[0].quiet_hours_shifted).toBe(true);
      expect(items[1]).toMatchObject({
        requested_at: null,
        requested_at_tashkent: null,
        quiet_hours_shifted: false,
      });
    });
  });

  describe('schedule_policy — DatePicker uchun qoida va “09:00 ga suriladi” taklifi', () => {
    it('zona, taqiq oynasi (sozlamadan), reklama vaqti taqiqda — surilgan lahza va matn', async () => {
      useClock(DAY);
      releaseAt = () => NEXT_MORNING;
      const res: any = await service.schedulePolicy({
        type: 'marketing.promo',
        scheduled_at: '2026-10-20T19:00:00+05:00',
      });
      expect(res.data).toEqual(
        expect.objectContaining({
          timezone: 'Asia/Tashkent',
          utc_offset: '+05:00',
          promo_quiet_hours: {
            start: '18:00',
            end: '09:00',
            enabled: true,
            env: 'NOTIF_PROMO_QUIET_HOURS',
          },
          is_promo: true,
        }),
      );
      expect(res.data.check).toEqual(
        expect.objectContaining({
          requested_at_tashkent: '2026-10-20T19:00:00+05:00',
          effective_at: NEXT_MORNING,
          effective_at_tashkent: '2026-10-21T09:00:00+05:00',
          shifted: true,
          reason: 'promo_quiet_hours',
        }),
      );
      expect(res.data.check.message).toContain('2026-10-21 09:00');
    });

    it('tranzaksion tur — surilmaydi, darvoza chaqirilmaydi; zonasiz vaqt — 400', async () => {
      useClock(DAY);
      const res: any = await service.schedulePolicy({
        type: 'system.manual',
        scheduled_at: '2026-10-20T23:00:00+05:00',
      });
      expect(res.data.is_promo).toBe(false);
      expect(res.data.check.shifted).toBe(false);
      expect(repo.manager.query).not.toHaveBeenCalled();
      const err = await errorOf(
        service.schedulePolicy({ scheduled_at: '2026-10-20T23:00' }),
      );
      expect(err.statusCode).toBe(400);
    });
  });

  describe('statik o’zgarmaslar (review punktlari)', () => {
    const REPO = join(__dirname, '..', '..', '..', '..');
    const code = (path: string) =>
      readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

    it('AT TIME ZONE kampaniya modulida ATIGI BIR joyda, faqat Asia/Tashkent (qo’shaloq konversiya yo’q)', () => {
      const hits = readdirSync(__dirname)
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
        .flatMap((name) =>
          [
            ...code(join(__dirname, name)).matchAll(
              /AT TIME ZONE\s+'([^']+)'/gi,
            ),
          ].map((match) => ({ file: name, zone: match[1] })),
        );
      expect(hits).toEqual([
        { file: 'campaign-schedule.ts', zone: 'Asia/Tashkent' },
      ]);
    });

    it('outbox.service getDuePending o’zgarmagan (JS Date bilan), RMQ_RPC_TTL_MS / navbat argumentlari kampaniya kodida yo’q', () => {
      const outboxCode = code(
        join(REPO, 'libs/common/src/outbox/outbox.service.ts'),
      );
      expect(outboxCode).toContain(
        "where: { status: 'pending', scheduled_at: LessThanOrEqual(new Date()) }",
      );
      expect(outboxCode).not.toMatch(/AT TIME ZONE/i);
      for (const name of readdirSync(__dirname).filter((n) =>
        n.endsWith('.ts'),
      )) {
        if (name.endsWith('.spec.ts')) continue;
        expect({
          name,
          hit: /RMQ_RPC_TTL_MS|x-message-ttl|queueOptions|x-dead-letter/.test(
            code(join(__dirname, name)),
          ),
        }).toEqual({ name, hit: false });
      }
    });
  });

  it('promoReleaseAt: oyna o’chiq (start = end) — SQL chaqirilmaydi', async () => {
    const runner = { query: jest.fn() };
    const at = new Date();
    expect(await promoReleaseAt(runner, at, { start: 0, end: 0 })).toBe(at);
    expect(runner.query).not.toHaveBeenCalled();
  });
});
