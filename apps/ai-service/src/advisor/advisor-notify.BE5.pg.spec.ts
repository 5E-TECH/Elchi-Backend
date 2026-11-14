import { DataSource } from 'typeorm';
import { of, throwError } from 'rxjs';
import type { ActivityLogService } from '@app/common';
import { AiAdvisorAlerts1716000000224 } from '../../../../migrations/1716000000224-AiAdvisorAlerts';
import { AdvisorNotifier } from './advisor-notify';
import { AdvisorSettingsService } from './advisor-settings.service';

/**
 * BE-5 §9.2 — «bir marta» kafolati haqiqiy Postgres'da: faqat ochiq
 * `critical`, backfill'siz; `notified_at` faqat javobdan keyin; xatoda
 * keyingi tick ayni `client_request_id` bilan qayta yuboradi.
 */
const ADMIN_URI = process.env.AI_ADVISOR_PG_TEST_URI;
const describePg = ADMIN_URI ? describe : describe.skip;

describePg('AdvisorNotifier — real Postgres (BE-5)', () => {
  const dbName = `elchi_ai_notify_${process.pid}_${Date.now()}`;
  let admin: DataSource;
  let ds: DataSource;
  const dispatch = jest.fn<unknown, [unknown, unknown]>();
  const identity = jest.fn(() =>
    of({ data: { items: [{ id: '1' }, { id: 5 }] } }),
  );
  let notifier: AdvisorNotifier;

  beforeAll(async () => {
    const url = new URL(ADMIN_URI as string);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('faqat lokal Postgres');
    admin = new DataSource({ type: 'postgres', url: ADMIN_URI });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    url.pathname = `/${dbName}`;
    ds = new DataSource({
      type: 'postgres',
      url: url.toString(),
      synchronize: false,
    });
    await ds.initialize();
    const qr = ds.createQueryRunner();
    try {
      await qr.query('CREATE SCHEMA IF NOT EXISTS ai_schema');
      await new AiAdvisorAlerts1716000000224().up(qr);
    } finally {
      await qr.release();
    }
    const settings = new AdvisorSettingsService(ds, {
      log: jest.fn(),
    } as unknown as ActivityLogService);
    notifier = new AdvisorNotifier(
      ds,
      settings,
      { send: dispatch } as never,
      { send: identity } as never,
    );
  });

  afterAll(async () => {
    await ds?.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    dispatch.mockReset();
    await ds.query(
      'TRUNCATE ai_schema.ai_advisor_alerts RESTART IDENTITY CASCADE',
    );
  });

  const insert = (
    severity: string,
    status = 'new',
    skipped: string | null = null,
    rule = 'R2',
  ) =>
    ds.query<Array<{ id: string }>>(
      `INSERT INTO ai_schema.ai_advisor_alerts (rule_key, severity, status, dedup_key, title, notify_skipped, facts)
       VALUES ($1, $2, $3, $4, 't', $5, '{"courier":{"name":"Jasur"},"balance":1,"days_without_handover":4}')
       RETURNING id::text AS id`,
      [rule, severity, status, `k${Math.random()}`, skipped],
    );
  const notified = () =>
    ds.query<Array<{ id: string; notified_at: Date | null }>>(
      `SELECT id::text AS id, notified_at FROM ai_schema.ai_advisor_alerts ORDER BY id`,
    );

  it('faqat ochiq critical; backfill/warning/yopilgan — yuborilmaydi; muvaffaqiyatdan keyin qayta ketmaydi', async () => {
    const [{ id: a }] = await insert('critical');
    await insert('warning');
    await insert('critical', 'new', 'backfill');
    await insert('critical', 'resolved');
    const [{ id: seen }] = await insert('critical', 'seen', null, 'R7');
    dispatch.mockReturnValue(of({ statusCode: 201 }));
    expect(await notifier.dispatchPending()).toEqual({ sent: 2, failed: 0 });
    const payloads = dispatch.mock.calls.map(
      (c: unknown[]) =>
        c[1] as {
          data: { alert_id: string };
          channels: string[];
          recipient_ids: string[];
        },
    );
    expect(payloads.map((p) => p.data.alert_id)).toEqual([a, seen]);
    expect(payloads[0]).toMatchObject({
      recipient_ids: ['1', '5'],
      channels: ['in_app', 'realtime', 'telegram'],
    });
    expect(payloads[1].channels).toEqual(['in_app', 'realtime']); // R7
    expect(identity.mock.calls[0]).toEqual([
      { cmd: 'identity.audience.resolve' },
      expect.objectContaining({
        roles: ['superadmin'],
        fields: 'minimal',
        limit: 100,
        with_total: false,
      }),
    ]);
    const rows = await notified();
    expect(rows.filter((r) => r.notified_at).map((r) => r.id)).toEqual([
      a,
      seen,
    ]);

    dispatch.mockClear();
    expect(await notifier.dispatchPending()).toEqual({ sent: 0, failed: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatch xatosi — notified_at bo‘sh qoladi, keyingi tick ayni client_request_id bilan', async () => {
    await insert('critical');
    dispatch.mockReturnValueOnce(
      throwError(() => new Error('notification down')),
    );
    expect(await notifier.dispatchPending()).toEqual({ sent: 0, failed: 1 });
    expect((await notified())[0].notified_at).toBeNull();
    dispatch.mockReturnValueOnce(
      of({ statusCode: 201, data: { duplicate: true } }),
    );
    expect(await notifier.dispatchPending()).toEqual({ sent: 1, failed: 0 });
    const ids = dispatch.mock.calls.map(
      (c: unknown[]) =>
        (c[1] as { client_request_id: string }).client_request_id,
    );
    expect(ids[0]).toBe(ids[1]);
  });

  it('settings.telegram.enabled=false — Telegram yo‘q', async () => {
    await ds.query(
      `INSERT INTO ai_schema.ai_advisor_settings (key, value, version) VALUES ('telegram', '{"enabled": false}', 2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    await insert('critical');
    dispatch.mockReturnValue(of({ statusCode: 201 }));
    await notifier.dispatchPending();
    const [[, first]] = dispatch.mock.calls as Array<
      [unknown, { channels: string[] }]
    >;
    expect(first.channels).toEqual(['in_app', 'realtime']);
    await ds.query(
      `DELETE FROM ai_schema.ai_advisor_settings WHERE key = 'telegram'`,
    );
  });
});
