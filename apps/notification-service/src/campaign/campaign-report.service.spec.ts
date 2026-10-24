import { RpcException } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { ActivityAction } from '@app/common';
import { CampaignReportController } from './campaign-report.controller';
import {
  CAMPAIGN_EXPORT_RUN_PATTERN,
  CAMPAIGN_EXPORT_SYNC_MAX_ROWS,
  CampaignReportService,
  csvCell,
} from './campaign-report.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  };
});

/**
 * H7kpCman — kampaniya natijasi hisoboti (unit). Haqiqiy SQL (jsonb kanal
 * kesimi, sms_outbox agregatlari, 10 000+ fon eksporti) —
 * campaign-report.pg.spec.ts.
 */
describe('H7kpCman — CampaignReportService', () => {
  let service: CampaignReportService;
  let campaigns: any;
  let smsCampaigns: any;
  let exportsRepo: any;
  let outbox: any;
  let activityLog: any;
  let smsConfig: any;
  /** SQL matni bo'yicha javob (regex → qatorlar). */
  let sql: Array<[RegExp, unknown[] | ((params: unknown[]) => unknown[])]>;
  let updateResult: any;

  const superadmin = { id: '26', roles: ['superadmin'] };
  const admin = { id: '25', roles: ['admin'] };
  const BOM = String.fromCharCode(0xfeff);
  const EOL = String.fromCharCode(13, 10);

  const errorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof RpcException) return error.getError() as any;
      throw error;
    }
    throw new Error('expected RpcException');
  };

  const notificationCampaign = (over: Record<string, unknown> = {}) => ({
    id: '7',
    title: 'Aksiya',
    type: 'marketing.manual',
    category: 'marketing',
    status: 'done',
    channels: ['in_app', 'realtime', 'push'],
    total: 10,
    sent: 8,
    failed: 1,
    skipped: 1,
    created_by: '25',
    createdAt: new Date('2026-10-20T05:00:00Z'),
    scheduled_at: null,
    paused_until: null,
    started_at: null,
    finished_at: null,
    ...over,
  });

  const smsCampaign = (over: Record<string, unknown> = {}) => ({
    id: '9',
    message_class: 'promo',
    template_code: null,
    text: 'Chegirma 20%',
    status: 'queued',
    total: 6,
    queued: 4,
    blocked: 1,
    skipped: 1,
    estimated_cost: '640.00',
    created_by: '25',
    created_at: new Date('2026-10-20T05:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    rmqSendMock.mockReset();
    rmqSendMock.mockImplementation((_c: unknown, pattern: any, data: any) =>
      Promise.resolve({
        data: (data.ids as string[]).map((id) =>
          // (lkQiuyQu) contacts_by_ids — telefon (servis maskalaydi).
          pattern?.cmd === 'identity.user.contacts_by_ids'
            ? { id, phone_number: `+99890123${id.padStart(4, '0')}` }
            : { id, name: `User ${id}`, role: 'customer' },
        ),
      }),
    );
    sql = [];
    updateResult = { affected: 1 };
    campaigns = {
      findOne: jest.fn().mockResolvedValue(notificationCampaign()),
      query: jest.fn((text: string, params: unknown[]) => {
        const hit = sql.find(([re]) => re.test(text));
        if (!hit) return Promise.resolve([]);
        const rows = typeof hit[1] === 'function' ? hit[1](params) : hit[1];
        return Promise.resolve(rows);
      }),
    };
    smsCampaigns = { findOne: jest.fn().mockResolvedValue(smsCampaign()) };
    const qb: any = {
      update: jest.fn(() => qb),
      set: jest.fn(() => qb),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      execute: jest.fn(() => Promise.resolve(updateResult)),
    };
    const jobRepo = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn((v) =>
        Promise.resolve({ id: '5', created_at: new Date(), ...v }),
      ),
    };
    exportsRepo = {
      qb,
      jobRepo,
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qb),
      manager: {
        transaction: jest.fn((work: (m: any) => unknown) =>
          work({ getRepository: () => jobRepo }),
        ),
      },
    };
    outbox = { enqueue: jest.fn().mockResolvedValue({ id: '1' }) };
    activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    smsConfig = { tariff: jest.fn(() => 80) };
    service = new CampaignReportService(
      campaigns,
      smsCampaigns,
      exportsRepo,
      { send: jest.fn() } as never,
      outbox,
      activityLog,
      smsConfig,
    );
  });

  describe('bildirishnoma kampaniyasi', () => {
    beforeEach(() => {
      sql.push(
        [
          /e\.key AS "channel"/,
          [
            { channel: 'in_app', status: 'sent', n: 8 },
            { channel: 'realtime', status: 'emitted', n: 7 },
            { channel: 'realtime', status: 'failed', n: 1 },
            { channel: 'push', status: 'sent', n: 3 },
            { channel: 'push', status: 'no_subscription', n: 4 },
            { channel: 'push', status: 'queued', n: 1 },
          ],
        ],
        [/COUNT\(\*\)::int AS "n"[\s\S]*notifications/, [{ n: 5 }]],
      );
    });

    it('TC1/TC3: auditoriya, yuborildi, xato, skipped + kanal kesimi (sent/failed/skipped)', async () => {
      const res: any = await service.report({
        kind: 'notification',
        id: '7',
        requester: admin,
      });
      expect(res.statusCode).toBe(200);
      expect(res.data.stats).toEqual(
        expect.objectContaining({
          audience: 10,
          sent: 8,
          failed: 1,
          skipped: 1,
          pending: 0,
          undelivered: 5,
        }),
      );
      const byChannel = Object.fromEntries(
        res.data.by_channel.map((row: any) => [row.channel, row]),
      );
      expect(Object.keys(byChannel)).toEqual(['in_app', 'realtime', 'push']);
      // in_app: qatorlar + yozilmay qolganlar (failed) + bekor qoldig'i
      expect(byChannel.in_app).toEqual(
        expect.objectContaining({ sent: 8, failed: 1, skipped: 1 }),
      );
      expect(byChannel.realtime).toEqual(
        expect.objectContaining({ sent: 7, failed: 1, skipped: 0 }),
      );
      expect(byChannel.push).toEqual(
        expect.objectContaining({
          sent: 3,
          failed: 0,
          skipped: 4,
          pending: 1,
          statuses: { sent: 3, no_subscription: 4, queued: 1 },
        }),
      );
      // kampaniya qatorlari group_key + data.campaign_id bo'yicha
      const [, params] = campaigns.query.mock.calls[0];
      expect(params.slice(0, 2)).toEqual(['campaign:7', '7']);
    });

    it('TC2: DLR yo’q kanallar — "Yetkazildi" null (0 EMAS); SMS bloki umuman yo’q; narx taxminiy', async () => {
      const res: any = await service.report({ kind: 'notification', id: '7' });
      expect(res.data.stats.delivered).toBeNull();
      expect(res.data.dlr).toEqual(
        expect.objectContaining({ supported: false, received: null }),
      );
      expect(res.data.sms).toBeNull();
      expect(res.data.cost).toEqual(
        expect.objectContaining({
          estimated: 0,
          is_estimate: true,
          paid_channels: [],
        }),
      );
    });

    it('TC7: can_export faqat superadmin', async () => {
      const asAdmin: any = await service.report({
        kind: 'notification',
        id: '7',
        requester: admin,
      });
      const asSuper: any = await service.report({
        kind: 'notification',
        id: '7',
        requester: superadmin,
      });
      expect(asAdmin.data.permissions.can_export).toBe(false);
      expect(asSuper.data.permissions.can_export).toBe(true);
      expect(asSuper.data.export_sync_limit).toBe(10_000);
    });

    it('yo’q kampaniya — 404; noto’g’ri id/kind — 400', async () => {
      campaigns.findOne.mockResolvedValueOnce(null);
      expect(
        (await errorOf(service.report({ kind: 'notification', id: '8' })))
          .statusCode,
      ).toBe(404);
      expect(
        (await errorOf(service.report({ kind: 'notification', id: 'x' })))
          .statusCode,
      ).toBe(400);
      expect(
        (await errorOf(service.report({ kind: 'email', id: '7' }))).statusCode,
      ).toBe(400);
    });

    it('TC6: Yetkazilmaganlar — ism/rol + kanal va sabab', async () => {
      sql.unshift([
        /SELECT n\."id", n\."recipient_id"/,
        [
          {
            id: '100',
            recipient_id: '42',
            recipient_role: 'courier',
            delivery: {
              in_app: 'sent',
              realtime: 'emitted',
              push: 'failed',
              push_error: '410 Gone',
            },
          },
          {
            id: '101',
            recipient_id: '43',
            recipient_role: null,
            delivery: { in_app: 'sent', push: 'no_subscription' },
          },
        ],
      ]);
      const res: any = await service.undelivered({
        kind: 'notification',
        id: '7',
        page: 1,
        limit: 2,
      });
      expect(res.data.items).toEqual([
        {
          ref_id: '100',
          recipient_id: '42',
          name: 'User 42',
          role: 'courier',
          // (lkQiuyQu) maskalangan telefon + push sabab kodi.
          phone: '***0042',
          failures: [
            {
              channel: 'push',
              status: 'failed',
              reason: '410 Gone',
              reason_code: 'subscription_expired',
            },
          ],
        },
        {
          ref_id: '101',
          recipient_id: '43',
          name: 'User 43',
          role: 'customer',
          phone: '***0043',
          failures: [
            {
              channel: 'push',
              status: 'no_subscription',
              reason: null,
              reason_code: 'no_subscription',
            },
          ],
        },
      ]);
      expect(res.data.meta).toEqual({
        page: 1,
        limit: 2,
        total: 5,
        totalPages: 3,
      });
      expect(res.data.unlisted_failed).toBe(1);
    });
  });

  describe('SMS kampaniyasi', () => {
    const agg = (over: Record<string, unknown> = {}) => ({
      messages: 4,
      sent: 3,
      delivered: 0,
      failed: 1,
      pending: 1,
      dlr_final: 0,
      awaiting_dlr: 3,
      parts_total: 8,
      parts_min: 2,
      parts_max: 2,
      gsm7: 4,
      ucs2: 0,
      cost_of_sent: '480.00',
      untariffed_sent: 0,
      ...over,
    });

    it('TC2: DLR hali kelmagan — Yetkazildi null (0 emas), kutilayotganlar soni bilan', async () => {
      sql.push(
        [/AS "messages"/, [agg()]],
        [
          /SELECT o\."status" AS "status"/,
          [
            { status: 'sent', n: 3 },
            { status: 'pending', n: 1 },
          ],
        ],
      );
      const res: any = await service.report({ kind: 'sms', id: '9' });
      expect(res.data.stats).toEqual(
        expect.objectContaining({
          audience: 6,
          sent: 3,
          delivered: null,
          failed: 1,
          skipped: 2,
          skipped_breakdown: { invalid_phone: 1, no_consent: 1 },
          pending: 1,
        }),
      );
      expect(res.data.dlr).toEqual(
        expect.objectContaining({ supported: true, received: 0, awaiting: 3 }),
      );
      expect(res.data.dlr.note).toContain('0 emas');
    });

    it('DLR kelgach — haqiqiy son (0 ham o’lchangan qiymat)', async () => {
      sql.push([
        /AS "messages"/,
        [agg({ dlr_final: 2, delivered: 0, awaiting_dlr: 1 })],
      ]);
      const res: any = await service.report({ kind: 'sms', id: '9' });
      expect(res.data.stats.delivered).toBe(0);
      expect(res.data.sms.dlr).toEqual({
        final: 2,
        delivered: 0,
        failed: 2,
        awaiting: 1,
      });
    });

    it('TC4/TC5: SMS bloki — bo’laklar, kodlash, taxminiy narx (tarif × bo’lak)', async () => {
      sql.push([/AS "messages"/, [agg({ gsm7: 3, ucs2: 1 })]]);
      const res: any = await service.report({ kind: 'sms', id: '9' });
      expect(res.data.sms).toEqual(
        expect.objectContaining({
          messages: 4,
          parts_total: 8,
          parts_per_message: { min: 2, max: 2 },
          encoding: 'mixed',
          tariff_per_part: 80,
          cost_of_sent: 480,
        }),
      );
      expect(res.data.by_channel).toEqual([
        expect.objectContaining({ channel: 'sms', failed: 1, skipped: 2 }),
      ]);
      expect(res.data.cost).toEqual(
        expect.objectContaining({
          currency: 'UZS',
          estimated: 640,
          cost_of_sent: 480,
          is_estimate: true,
          paid_channels: ['sms'],
        }),
      );
      expect(res.data.cost.note).toMatch(/Taxminiy/);
    });

    it('tarif sozlanmagan — narx null (0 emas); xabar yo’q — bo’laklar matndan', async () => {
      smsCampaigns.findOne.mockResolvedValueOnce(
        smsCampaign({ estimated_cost: null, text: 'Привет' }),
      );
      sql.push([
        /AS "messages"/,
        [agg({ messages: 0, sent: 0, parts_min: null, parts_max: null })],
      ]);
      const empty: any = await service.report({ kind: 'sms', id: '9' });
      expect(empty.data.cost.estimated).toBeNull();
      expect(empty.data.cost.cost_of_sent).toBe(0);
      expect(empty.data.sms).toEqual(
        expect.objectContaining({
          encoding: 'UCS-2',
          parts_per_message: { min: 1, max: 1 },
          source: 'text',
        }),
      );

      sql.length = 0;
      sql.push([/AS "messages"/, [agg({ untariffed_sent: 1 })]]);
      const untariffed: any = await service.report({ kind: 'sms', id: '9' });
      expect(untariffed.data.cost.cost_of_sent).toBeNull();
    });

    it('TC6: yetkazilmagan SMS — telefon MASKALANGAN, sabab bilan', async () => {
      sql.push(
        [
          /SELECT o\."id", o\."customer_id"/,
          [
            {
              id: '55',
              customer_id: '77',
              to_phone: '+998901237434',
              last_error: 'DLR: UNDELIV',
              dlr_status: 'not_delivered',
              status: 'failed',
            },
          ],
        ],
        [/COUNT\(\*\)::int AS "n"[\s\S]*sms_outbox/, [{ n: 1 }]],
      );
      const res: any = await service.undelivered({ kind: 'sms', id: '9' });
      expect(res.data.items).toEqual([
        {
          ref_id: '55',
          recipient_id: '77',
          name: 'User 77',
          role: 'customer',
          phone: '***7434',
          failures: [
            {
              channel: 'sms',
              status: 'not_delivered',
              reason: 'DLR: UNDELIV',
              reason_code: null,
            },
          ],
        },
      ]);
      expect(JSON.stringify(res.data)).not.toContain('901237434');
    });
  });

  describe('CSV eksport', () => {
    const undeliveredRows = [
      {
        id: '100',
        recipient_id: '42',
        recipient_role: 'courier',
        delivery: { push: 'failed', push_error: '=HYPERLINK(1)' },
      },
      {
        id: '101',
        recipient_id: '43',
        recipient_role: 'market',
        delivery: { push: 'no_subscription', realtime: 'failed' },
      },
    ];
    const count = (n: number) => sql.push([/COUNT\(\*\)::int AS "n"/, [{ n }]]);
    const pageRows = () =>
      sql.push([
        /SELECT n\."id", n\."recipient_id"/,
        (params: unknown[]) => (params[4] === '0' ? undeliveredRows : []),
      ]);

    it('TC7: faqat superadmin — admin 403, hech narsa yig’ilmaydi va jurnal yozilmaydi', async () => {
      const err = await errorOf(
        service.exportUndelivered({
          kind: 'notification',
          id: '7',
          requester: admin,
        }),
      );
      expect(err.statusCode).toBe(403);
      expect(campaigns.query).not.toHaveBeenCalled();
      expect(activityLog.log).not.toHaveBeenCalled();
    });

    it('TC8: ≤10 000 — darhol CSV, faoliyat jurnaliga `export` amali', async () => {
      count(2);
      pageRows();
      const res: any = await service.exportUndelivered({
        kind: 'notification',
        id: '7',
        requester: superadmin,
      });
      expect(res.statusCode).toBe(200);
      expect(res.data).toEqual(
        expect.objectContaining({
          mode: 'sync',
          rows: 2,
          content_type: 'text/csv; charset=utf-8',
        }),
      );
      expect(res.data.filename).toMatch(
        /^kampaniya-notification-7-yetkazilmaganlar-\d{8}-\d{4}\.csv$/,
      );
      const lines = res.data.csv.split(EOL);
      expect(lines[0]).toBe(
        BOM + 'recipient_id,name,role,phone,channel,status,reason,ref_id',
      );
      // formula in'ektsiyasi zararsizlantirilgan ('=... → ''=...)
      expect(lines[1]).toBe(
        "42,User 42,courier,***0042,push,failed,'=HYPERLINK(1),100",
      );
      expect(lines[2]).toBe(
        '43,User 43,market,***0043,realtime | push,failed | no_subscription, | ,101',
      );
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'NotificationCampaign',
          entity_id: '7',
          action: ActivityAction.EXPORT,
          user_id: '26',
          user_role: 'superadmin',
          metadata: expect.objectContaining({
            scope: 'campaign_undelivered',
            rows: 2,
            mode: 'sync',
            format: 'csv',
          }),
        }),
      );
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('TC9: 10 000 dan katta — SINXRON EMAS: fon vazifasi (202), CSV bu so’rovda yig’ilmaydi', async () => {
      count(CAMPAIGN_EXPORT_SYNC_MAX_ROWS + 1);
      const res: any = await service.exportUndelivered({
        kind: 'notification',
        id: '7',
        requester: superadmin,
      });
      expect(res.statusCode).toBe(202);
      expect(res.data).toEqual(
        expect.objectContaining({
          mode: 'async',
          export_id: '5',
          status: 'queued',
          rows: 10_001,
          duplicate: false,
        }),
      );
      const listed = campaigns.query.mock.calls.filter((call: string[]) =>
        /SELECT n\."id"/.test(call[0]),
      );
      expect(listed).toHaveLength(0);
      expect(exportsRepo.jobRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          campaign_kind: 'notification',
          campaign_id: '7',
          requested_by: '26',
          status: 'queued',
        }),
      );
      expect(outbox.enqueue).toHaveBeenCalledWith(
        'NOTIFICATION',
        CAMPAIGN_EXPORT_RUN_PATTERN,
        { export_id: '5' },
        expect.objectContaining({ requestId: 'campaign-export:5' }),
      );
      // eksport hali bajarilmadi — jurnal yuklab olishda yoziladi
      expect(activityLog.log).not.toHaveBeenCalled();
    });

    it('qayta bosish — navbatdagi vazifa qaytadi, ikkinchisi ochilmaydi', async () => {
      count(20_000);
      exportsRepo.findOne.mockResolvedValueOnce({
        id: '4',
        campaign_kind: 'notification',
        campaign_id: '7',
        status: 'running',
        row_count: 20_000,
      });
      const res: any = await service.exportUndelivered({
        kind: 'notification',
        id: '7',
        requester: superadmin,
      });
      expect(res.data).toEqual(
        expect.objectContaining({ export_id: '4', duplicate: true }),
      );
      expect(exportsRepo.jobRepo.save).not.toHaveBeenCalled();
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('runExport: da’vo — fonda yig’adi (outbox kutmaydi), qayta yetkazilgan xabar e’tiborsiz', async () => {
      exportsRepo.findOne.mockResolvedValue({
        id: '5',
        campaign_kind: 'notification',
        campaign_id: '7',
        status: 'running',
      });
      pageRows();
      const res = await service.runExport({ export_id: '5' });
      expect(res).toEqual({ export_id: '5', status: 'running' });
      await service.settled('5');
      expect(exportsRepo.update).toHaveBeenCalledWith(
        { id: '5', status: 'running' },
        expect.objectContaining({ status: 'done', row_count: 2 }),
      );
      const done = exportsRepo.update.mock.calls[0][1];
      expect(done.csv.split(EOL)).toHaveLength(4);
      expect(done.expires_at.getTime()).toBeGreaterThan(Date.now());

      updateResult = { affected: 0 };
      expect(await service.runExport({ export_id: '5' })).toEqual({
        export_id: '5',
        skipped: 'not_queued',
      });
    });

    it('yuklab olish: tayyor emas — 409, muddati o’tgan — 410, admin — 403; tayyor — CSV + `export` jurnali', async () => {
      const job = (over: Record<string, unknown> = {}) => ({
        id: '5',
        campaign_kind: 'sms',
        campaign_id: '9',
        status: 'done',
        row_count: 12_000,
        csv: BOM + 'recipient_id',
        filename: 'kampaniya-sms-9.csv',
        started_at: new Date(),
        expires_at: new Date(Date.now() + 60_000),
        ...over,
      });
      const download = (requester: unknown) =>
        errorOf(
          service.downloadExport({
            export_id: '5',
            requester: requester as never,
          }),
        );
      exportsRepo.findOne.mockResolvedValueOnce(job({ status: 'queued' }));
      expect((await download(superadmin)).statusCode).toBe(409);
      exportsRepo.findOne.mockResolvedValueOnce(
        job({ expires_at: new Date(Date.now() - 1000) }),
      );
      expect((await download(superadmin)).statusCode).toBe(410);
      expect((await download(admin)).statusCode).toBe(403);
      expect(activityLog.log).not.toHaveBeenCalled();

      exportsRepo.findOne.mockResolvedValueOnce(job());
      const res: any = await service.downloadExport({
        export_id: '5',
        requester: superadmin,
      });
      expect(res.data).toEqual(
        expect.objectContaining({
          rows: 12_000,
          filename: 'kampaniya-sms-9.csv',
          csv: BOM + 'recipient_id',
        }),
      );
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'SmsCampaign',
          entity_id: '9',
          action: 'export',
          metadata: expect.objectContaining({ mode: 'async', export_id: '5' }),
        }),
      );
    });
  });

  it('csvCell: formula in’ektsiyasi va qo’shtirnoq', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+998')).toBe("'+998");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
  });

  it('RMQ patternlari CampaignReportController da', () => {
    const proto = CampaignReportController.prototype as any;
    const cmds = Object.getOwnPropertyNames(proto)
      .map((name) => Reflect.getMetadata(PATTERN_METADATA, proto[name]))
      .filter(Boolean)
      .flat()
      .map((p: any) => p.cmd);
    expect(cmds.sort()).toEqual(
      [
        'notification.campaign.export',
        'notification.campaign.export.download',
        'notification.campaign.export.get',
        'notification.campaign.export.run',
        'notification.campaign.report',
        'notification.campaign.undelivered',
      ].sort(),
    );
  });
});
