import {
  IntegrationServiceService,
  PartnerWebhookPermanentError,
} from './integration-service.service';

/**
 * vy9gakYq — hamkor webhook outbox'i `permanently_failed` bo'lganda HECH KIM
 * xabardor qilinmasdi, `awaiting_config` esa faqat `logger.warn` edi.
 */
function makeSvc(
  over: { awaitingRows?: Array<{ partner_id: string; count: string }> } = {},
) {
  const svc: any = Object.create(IntegrationServiceService.prototype);
  const updates: any[] = [];
  svc.partnerWebhookOutboxRepo = {
    update: jest.fn((_where: unknown, patch: unknown) => {
      updates.push(patch);
      return Promise.resolve({ affected: 1 });
    }),
    createQueryBuilder: jest.fn(() => {
      const qb: any = {
        select: jest.fn(() => qb),
        addSelect: jest.fn(() => qb),
        where: jest.fn(() => qb),
        andWhere: jest.fn(() => qb),
        groupBy: jest.fn(() => qb),
        getRawMany: jest.fn(() => Promise.resolve(over.awaitingRows ?? [])),
      };
      return qb;
    }),
  };
  svc.partnerRepo = {
    findOne: jest.fn(() => Promise.resolve({ id: '7', name: 'BeePost' })),
  };
  const queryRunner = {
    connect: jest.fn(() => Promise.resolve()),
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('pg_try_advisory_lock') ? [{ acquired: true }] : [],
      ),
    ),
    release: jest.fn(() => Promise.resolve()),
  };
  svc.integrationRepo = {
    manager: { connection: { createQueryRunner: () => queryRunner } },
  };
  svc.notificationClient = {};
  svc.rmqRequest = jest.fn(() => Promise.resolve({ ok: true }));
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  return { svc, updates, queryRunner };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: '11',
  partner_id: '7',
  order_id: '900',
  external_order_id: 'ord-9',
  new_status: 'sold',
  attempts: 3,
  max_attempts: 4,
  payload: { event: 'shipment.status_changed' },
  ...over,
});

const sentMessages = (svc: any): string[] =>
  svc.rmqRequest.mock.calls
    .filter((c: any[]) => c[1]?.cmd === 'notification.send')
    .map((c: any[]) => String(c[2]?.message));

describe('vy9gakYq — hamkor webhooki yo`qolganda ogohlantirish', () => {
  const prevGroup = process.env.NOTIFICATION_ADMIN_GROUP_ID;
  const prevTg = process.env.TELEGRAM_ADMIN_GROUP_ID;
  beforeEach(() => {
    process.env.NOTIFICATION_ADMIN_GROUP_ID = '-100777';
    delete process.env.TELEGRAM_ADMIN_GROUP_ID;
  });
  afterAll(() => {
    if (prevGroup === undefined) delete process.env.NOTIFICATION_ADMIN_GROUP_ID;
    else process.env.NOTIFICATION_ADMIN_GROUP_ID = prevGroup;
    if (prevTg !== undefined) process.env.TELEGRAM_ADMIN_GROUP_ID = prevTg;
  });

  it('⭐ TC1: 4-urinishdan keyin permanently_failed + admin guruhiga xabar', async () => {
    const { svc, updates } = makeSvc();
    svc.dispatchPartnerWebhook = jest.fn(() =>
      Promise.reject(new Error('HTTP 500 Internal Server Error')),
    );

    const ok = await svc.deliverPartnerWebhookRow(row());

    expect(ok).toBe(false);
    expect(updates.at(-1).status).toBe('permanently_failed');
    const msgs = sentMessages(svc);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/BeePost \(#7\)/);
    expect(msgs[0]).toMatch(/order_id: 900/);
    expect(msgs[0]).toMatch(/new_status: sold/);
    expect(msgs[0]).toMatch(/attempts: 4/);
    expect(msgs[0]).toMatch(/HTTP 500/);
    expect(svc.rmqRequest.mock.calls[0][2].group_id).toBe('-100777');
  });

  it('oraliq urinish (2/4) — xabar YO`Q, qayta urinishga qo`yiladi', async () => {
    const { svc, updates } = makeSvc();
    svc.dispatchPartnerWebhook = jest.fn(() =>
      Promise.reject(new Error('timeout')),
    );

    await svc.deliverPartnerWebhookRow(row({ attempts: 1 }));

    expect(updates.at(-1).status).toBe('pending');
    expect(sentMessages(svc)).toHaveLength(0);
  });

  it('doimiy xato (4xx) — darhol permanently_failed + xabar', async () => {
    const { svc, updates } = makeSvc();
    svc.dispatchPartnerWebhook = jest.fn(() =>
      Promise.reject(new PartnerWebhookPermanentError('HTTP 404 Not Found')),
    );

    await svc.deliverPartnerWebhookRow(row({ attempts: 0 }));

    expect(updates.at(-1).status).toBe('permanently_failed');
    expect(sentMessages(svc)[0]).toMatch(/HTTP 404/);
  });

  it('⭐ TC3: NOTIFICATION_ADMIN_GROUP_ID bo`sh — yiqilmaydi, xabar yuborilmaydi', async () => {
    delete process.env.NOTIFICATION_ADMIN_GROUP_ID;
    const { svc, updates } = makeSvc();
    svc.dispatchPartnerWebhook = jest.fn(() =>
      Promise.reject(new Error('HTTP 500')),
    );

    await expect(svc.deliverPartnerWebhookRow(row())).resolves.toBe(false);

    expect(updates.at(-1).status).toBe('permanently_failed');
    expect(sentMessages(svc)).toHaveLength(0);
  });

  it('xabar yuborish xatosi yetkazish oqimini to`xtatmaydi', async () => {
    const { svc } = makeSvc();
    svc.rmqRequest = jest.fn(() =>
      Promise.reject(new Error('notification down')),
    );
    svc.dispatchPartnerWebhook = jest.fn(() =>
      Promise.reject(new Error('HTTP 500')),
    );

    await expect(svc.deliverPartnerWebhookRow(row())).resolves.toBe(false);
  });

  it('⭐ TC2: awaiting_config — kunlik yig`ma xabar (hamkor va son bilan)', async () => {
    const { svc } = makeSvc({
      awaitingRows: [{ partner_id: '7', count: '2' }],
    });

    const res = await svc.digestAwaitingConfigPartnerWebhooks();

    expect(res).toMatchObject({
      total: 2,
      notified: true,
      partners: [{ partner_id: '7', name: 'BeePost', count: 2 }],
    });
    const msg = sentMessages(svc)[0];
    expect(msg).toMatch(/jami 2 ta/);
    expect(msg).toMatch(
      /BeePost \(#7\): 2 ta hodisa webhook_url yo'qligi sababli kutmoqda/,
    );
  });

  it('awaiting_config yo`q — xabar yuborilmaydi', async () => {
    const { svc } = makeSvc({ awaitingRows: [] });
    const res = await svc.digestAwaitingConfigPartnerWebhooks();
    expect(res).toMatchObject({ total: 0, notified: false });
    expect(sentMessages(svc)).toHaveLength(0);
  });

  it('awaiting_config, guruh sozlanmagan — warn log, yiqilmaydi', async () => {
    delete process.env.NOTIFICATION_ADMIN_GROUP_ID;
    const { svc } = makeSvc({
      awaitingRows: [{ partner_id: '7', count: '5' }],
    });
    const res = await svc.digestAwaitingConfigPartnerWebhooks();
    expect(res).toMatchObject({ total: 5, notified: false });
    expect(svc.logger.warn).toHaveBeenCalled();
  });

  it('ikki replika: qulf band bo`lsa o`tkazib yuboriladi', async () => {
    const { svc, queryRunner } = makeSvc({
      awaitingRows: [{ partner_id: '7', count: '1' }],
    });
    queryRunner.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('pg_try_advisory_lock') ? [{ acquired: false }] : [],
      ),
    );
    const res = await svc.digestAwaitingConfigPartnerWebhooks();
    expect(res.skipped).toBe('locked');
    expect(sentMessages(svc)).toHaveLength(0);
    expect(queryRunner.release).toHaveBeenCalled();
  });
});
