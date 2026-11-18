import { DataSource } from 'typeorm';
import { TimeoutError, from, of, throwError } from 'rxjs';
import type { ActivityLogService } from '@app/common';
import { AiAdvisorAlerts1716000000224 } from '../../../../migrations/1716000000224-AiAdvisorAlerts';
import { AiAdvisorTelegramDue1716000000229 } from '../../../../migrations/1716000000229-AiAdvisorTelegramDue';
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
      await new AiAdvisorTelegramDue1716000000229().up(qr);
      await new AiAdvisorTelegramDue1716000000229().up(qr); // idempotent
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
    // id'lar RESTART IDENTITY bilan qayta ishlatiladi — urinish hisoblagichi ham.
    (
      notifier as unknown as { attempts: Map<string, unknown> }
    ).attempts.clear();
    (
      notifier as unknown as { unreachableAt: Map<string, unknown> }
    ).unreachableAt.clear();
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
        active_only: true,
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
      throwError(() => ({ statusCode: 400, message: 'notification xatosi' })),
    );
    expect(await notifier.dispatchPending()).toEqual({ sent: 0, failed: 1 });
    expect((await notified())[0].notified_at).toBeNull();
    dispatch.mockReturnValueOnce(
      of({ statusCode: 201, data: { duplicate: true } }),
    );
    // round-4 S2: oraliq (30 daq) tugaguncha qayta urinilmaydi.
    expect(await notifier.dispatchPending()).toEqual({ sent: 0, failed: 0 });
    expect(
      await notifier.dispatchPending(new Date(Date.now() + 31 * 60_000)),
    ).toEqual({ sent: 1, failed: 0 });
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

  it('round-2 S1: ikki parallel dispatchPending — har ogohlantirish bir marta yuboriladi (qulf)', async () => {
    await insert('critical');
    await insert('critical');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    dispatch.mockImplementation(() =>
      from(gate.then(() => ({ statusCode: 201 }))),
    );
    const a = notifier.dispatchPending();
    // Birinchisi qulfni olib, dispatch'da kutib turibdi.
    await new Promise((r) => setTimeout(r, 50));
    const b = await notifier.dispatchPending();
    expect(b).toEqual({ sent: 0, failed: 0 });
    release();
    expect(await a).toEqual({ sent: 2, failed: 0 });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('round-2 S2: xatoli qator navbat oxiriga o‘tadi — yangilari to‘silmaydi', async () => {
    const [{ id: bad }] = await insert('critical');
    await ds.query(
      `UPDATE ai_schema.ai_advisor_alerts SET "updatedAt" = now() - INTERVAL '1 hour' WHERE id = $1`,
      [bad],
    );
    const [{ id: good }] = await insert('critical');
    dispatch.mockImplementation((_p: unknown, body: unknown) =>
      (body as { data: { alert_id: string } }).data.alert_id === bad
        ? throwError(() => ({ statusCode: 400, message: 'yaroqsiz' }))
        : of({ statusCode: 201 }),
    );
    expect(await notifier.dispatchPending()).toEqual({ sent: 1, failed: 1 });
    const order = dispatch.mock.calls.map(
      (c: unknown[]) => (c[1] as { data: { alert_id: string } }).data.alert_id,
    );
    expect(order).toEqual([bad, good]);
    const [row] = await ds.query<Array<{ fresh: boolean }>>(
      `SELECT "updatedAt" > now() - INTERVAL '1 minute' AS fresh FROM ai_schema.ai_advisor_alerts WHERE id = $1`,
      [bad],
    );
    expect(row.fresh).toBe(true);
  });

  it('round-4 S2: doimiy xato — oraliq o‘sadi, 5 urinishdan keyin notify_skipped=failed, boshqa yuborilmaydi', async () => {
    const [{ id }] = await insert('critical');
    dispatch.mockImplementation(() =>
      throwError(() => ({ statusCode: 400, message: 'yaroqsiz' })),
    );
    let t = Date.now();
    const calls: number[] = [];
    for (let i = 0; i < 20; i++) {
      await notifier.dispatchPending(new Date(t));
      calls.push(dispatch.mock.calls.length);
      t += 30 * 60_000; // har tick 30 daq
    }
    // 1, 2 (+30m), 3 (+1s), 4 (+2s), 5 (+4s) — jami 5 urinish.
    expect(dispatch).toHaveBeenCalledTimes(5);
    expect(calls.slice(0, 2)).toEqual([1, 2]);
    expect(calls[2]).toBe(2); // 1 soat oraliq — 3-tick o'tkaziladi
    const [row] = await ds.query<Array<{ notify_skipped: string | null }>>(
      `SELECT notify_skipped FROM ai_schema.ai_advisor_alerts WHERE id = $1`,
      [id],
    );
    expect(row.notify_skipped).toBe('failed');
  });

  it('#705 B1: xizmat yetib bo‘lmasa (timeout / transport) — hisoblagich oshmaydi, 8 soatlik uzilishdan keyin ham yetkaziladi', async () => {
    const [{ id }] = await insert('critical');
    await insert('critical');
    let down = true;
    dispatch.mockImplementation(() =>
      down ? throwError(() => new TimeoutError()) : of({ statusCode: 201 }),
    );
    let t = Date.now();
    for (let i = 0; i < 16; i++) {
      // Har tick'da faqat BITTA RPC (partiya to'xtaydi).
      dispatch.mockClear();
      expect(await notifier.dispatchPending(new Date(t))).toEqual({
        sent: 0,
        failed: 1,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      t += 30 * 60_000;
    }
    const [row] = await ds.query<Array<{ notify_skipped: string | null }>>(
      `SELECT notify_skipped FROM ai_schema.ai_advisor_alerts WHERE id = $1`,
      [id],
    );
    expect(row.notify_skipped).toBeNull();
    // Transport xatosi (statusCode yo'q) ham — xuddi shunday.
    dispatch.mockImplementationOnce(() =>
      throwError(() => new Error('Disconnected from RMQ')),
    );
    expect(await notifier.dispatchPending(new Date(t))).toEqual({
      sent: 0,
      failed: 1,
    });
    down = false;
    expect(await notifier.dispatchPending(new Date(t + 30 * 60_000))).toEqual({
      sent: 2,
      failed: 0,
    });
  });

  it('#705 S-d: 5xx (xizmat nosoz) — urinish sanalmaydi, «failed» bo‘lmaydi', async () => {
    const [{ id }] = await insert('critical');
    dispatch.mockImplementation(() =>
      throwError(() => ({ statusCode: 500, message: 'Internal server error' })),
    );
    let t = Date.now();
    for (let i = 0; i < 20; i++) {
      await notifier.dispatchPending(new Date(t));
      t += 30 * 60_000;
    }
    expect(dispatch).toHaveBeenCalledTimes(20);
    const [row] = await ds.query<Array<{ notify_skipped: string | null }>>(
      `SELECT notify_skipped FROM ai_schema.ai_advisor_alerts WHERE id = $1`,
      [id],
    );
    expect(row.notify_skipped).toBeNull();
  });

  it('#705 B1 (S-d regressiya): doim 5xx olayotgan qator (engine har tick yangilaydi) boshqa kritiklarni to‘smaydi', async () => {
    const [{ id: bad }] = await insert('critical');
    const goods = [];
    for (let i = 0; i < 3; i++) goods.push((await insert('critical'))[0].id);
    dispatch.mockImplementation((_p: unknown, body: unknown) =>
      (body as { data: { alert_id: string } }).data.alert_id === bad
        ? throwError(() => ({ statusCode: 500, message: 'x' }))
        : of({ statusCode: 201 }),
    );
    // Engine R2 epizodini har tick yangilaydi (updatedAt = hozir) — yomon
    // qator saralashda birinchi bo'lib qoladi.
    await ds.query(
      `UPDATE ai_schema.ai_advisor_alerts SET "updatedAt" = now() - INTERVAL '1 day' WHERE id = $1`,
      [bad],
    );
    expect(await notifier.dispatchPending()).toEqual({ sent: 3, failed: 1 });
    const rows = await ds.query<
      Array<{ id: string; notified_at: Date | null }>
    >(
      `SELECT id::text AS id, notified_at FROM ai_schema.ai_advisor_alerts WHERE id = ANY($1::bigint[])`,
      [goods],
    );
    expect(rows.every((r) => r.notified_at !== null)).toBe(true);
  });

  it('#705 S1: javobsiz (timeout) qator engine yangilasa ham keyingi tick’da navbat oxiriga — boshqalar ketadi', async () => {
    const [{ id: slow }] = await insert('critical');
    const goods: string[] = [];
    for (let i = 0; i < 2; i++) goods.push((await insert('critical'))[0].id);
    dispatch.mockImplementation((_p: unknown, body: unknown) =>
      (body as { data: { alert_id: string } }).data.alert_id === slow
        ? throwError(() => new TimeoutError())
        : of({ statusCode: 201 }),
    );
    const bump = () =>
      ds.query(
        `UPDATE ai_schema.ai_advisor_alerts SET "updatedAt" = now() - INTERVAL '1 day' WHERE id = $1`,
        [slow],
      );
    await bump();
    // 1-tick: javobsiz qator birinchi — partiya to'xtaydi.
    expect(await notifier.dispatchPending()).toEqual({ sent: 0, failed: 1 });
    // Engine uni yana «eng eski» qiladi — baribir oxirida, yaxshilar ketadi.
    await bump();
    expect(await notifier.dispatchPending()).toEqual({ sent: 2, failed: 1 });
  });

  it('#705 rr12: engine har tick «eng eski» qiladigan 3 ta doimiy 5xx qator — keyingi tick yaxshilar ketadi', async () => {
    const bad: string[] = [];
    for (let i = 0; i < 3; i++) bad.push((await insert('critical'))[0].id);
    for (let i = 0; i < 2; i++) await insert('critical');
    dispatch.mockImplementation((_p: unknown, body: unknown) =>
      bad.includes((body as { data: { alert_id: string } }).data.alert_id)
        ? throwError(() => ({ statusCode: 500, message: 'x' }))
        : of({ statusCode: 201 }),
    );
    const bump = () =>
      ds.query(
        `UPDATE ai_schema.ai_advisor_alerts SET "updatedAt" = now() - INTERVAL '1 day' WHERE id = ANY($1::bigint[])`,
        [bad],
      );
    await bump();
    // 1-tick: ketma-ket 3×5xx — partiya to'xtaydi.
    expect(await notifier.dispatchPending()).toEqual({ sent: 0, failed: 3 });
    await bump();
    expect(await notifier.dispatchPending()).toEqual({ sent: 2, failed: 3 });
  });

  it('#705 rr12: bir marta javobsiz qolgan qator doimiy javobsiz qator ortida abadiy qolmaydi', async () => {
    const [{ id: slow }] = await insert('critical');
    const [{ id: good }] = await insert('critical');
    // 2 tick xizmat butunlay javobsiz: avval `slow`, keyin `good` javobsiz.
    dispatch.mockImplementation(() => throwError(() => new TimeoutError()));
    expect(await notifier.dispatchPending()).toEqual({ sent: 0, failed: 1 });
    expect(await notifier.dispatchPending()).toEqual({ sent: 0, failed: 1 });
    // Xizmat tiklandi, faqat `slow` doim javobsiz; engine uni «eng eski» qiladi.
    dispatch.mockImplementation((_p: unknown, body: unknown) =>
      (body as { data: { alert_id: string } }).data.alert_id === slow
        ? throwError(() => new TimeoutError())
        : of({ statusCode: 201 }),
    );
    let sent = 0;
    for (let i = 0; i < 3; i++) {
      await ds.query(
        `UPDATE ai_schema.ai_advisor_alerts SET "updatedAt" = now() - INTERVAL '1 day' WHERE id = $1`,
        [slow],
      );
      sent += (await notifier.dispatchPending()).sent;
    }
    expect(sent).toBe(1);
    const [row] = await ds.query<Array<{ notified: boolean }>>(
      `SELECT notified_at IS NOT NULL AS notified FROM ai_schema.ai_advisor_alerts WHERE id = $1`,
      [good],
    );
    expect(row.notified).toBe(true);
  });

  it('#705 S4: chop etib bo‘lmaydigan xato obyekti (prototipsiz, getter tashlaydi) — tick to‘xtamaydi; massiv message birlashtiriladi', async () => {
    await insert('critical');
    const warn = jest.spyOn(
      (notifier as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    );
    const weird = Object.create(null) as Record<string, unknown>;
    weird.statusCode = 400;
    Object.defineProperty(weird, 'message', {
      get() {
        throw new Error('getter');
      },
    });
    weird.self = weird;
    dispatch.mockReturnValueOnce(throwError(() => weird));
    expect(await notifier.dispatchPending()).toEqual({ sent: 0, failed: 1 });
    (
      notifier as unknown as { attempts: Map<string, unknown> }
    ).attempts.clear();
    dispatch.mockReturnValueOnce(
      throwError(() => ({ statusCode: 400, message: ['a bad', 'b bad'] })),
    );
    expect(await notifier.dispatchPending()).toEqual({ sent: 0, failed: 1 });
    const logs = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(logs).toEqual([
      expect.stringContaining('unprintable error'),
      expect.stringContaining('400 a bad; b bad'),
    ]);
  });

  it('#705 S3: superadminlar ro‘yxati bo‘sh — urinish sanalmaydi, «failed» bo‘lmaydi', async () => {
    const [{ id }] = await insert('critical');
    (notifier as unknown as { recipientsCache: unknown }).recipientsCache =
      null;
    identity.mockImplementation(() => of({ data: { items: [] } }));
    try {
      let t = Date.now();
      for (let i = 0; i < 12; i++) {
        (notifier as unknown as { recipientsCache: unknown }).recipientsCache =
          null;
        await notifier.dispatchPending(new Date(t));
        t += 60 * 60_000;
      }
      expect(dispatch).not.toHaveBeenCalled();
      const [row] = await ds.query<Array<{ notify_skipped: string | null }>>(
        `SELECT notify_skipped FROM ai_schema.ai_advisor_alerts WHERE id = $1`,
        [id],
      );
      expect(row.notify_skipped).toBeNull();
    } finally {
      identity.mockImplementation(() =>
        of({ data: { items: [{ id: '1' }, { id: 5 }] } }),
      );
      (notifier as unknown as { recipientsCache: unknown }).recipientsCache =
        null;
    }
  });

  it('round-4 S2: oraliqdagi qatorlar partiya joyini olmaydi — yangi critical shu tick yuboriladi', async () => {
    for (let i = 0; i < 20; i++) await insert('critical');
    dispatch.mockImplementation(() =>
      throwError(() => ({ statusCode: 400, message: 'yaroqsiz' })),
    );
    await notifier.dispatchPending();
    expect(dispatch).toHaveBeenCalledTimes(20);
    const [{ id: fresh }] = await insert('critical');
    dispatch.mockReset();
    dispatch.mockImplementation(() => of({ statusCode: 201 }));
    expect(await notifier.dispatchPending()).toEqual({ sent: 1, failed: 0 });
    expect(
      (dispatch.mock.calls[0][1] as { data: { alert_id: string } }).data
        .alert_id,
    ).toBe(fresh);
  });

  it('round-2 S3: 24 soatdan eski ogohlantirish — stale, yuborilmaydi; yangisi yuboriladi', async () => {
    const [{ id: old }] = await insert('critical');
    await ds.query(
      `UPDATE ai_schema.ai_advisor_alerts SET first_at = now() - INTERVAL '25 hours' WHERE id = $1`,
      [old],
    );
    const [{ id: fresh }] = await insert('critical');
    dispatch.mockReturnValue(of({ statusCode: 201 }));
    expect(await notifier.dispatchPending()).toEqual({ sent: 1, failed: 0 });
    expect(
      dispatch.mock.calls.map(
        (c: unknown[]) =>
          (c[1] as { data: { alert_id: string } }).data.alert_id,
      ),
    ).toEqual([fresh]);
    const rows = await ds.query<
      Array<{ id: string; notify_skipped: string | null }>
    >(
      `SELECT id::text AS id, notify_skipped FROM ai_schema.ai_advisor_alerts ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: old, notify_skipped: 'stale' },
      { id: fresh, notify_skipped: null },
    ]);
  });

  describe('R6 Telegram 09:00 Toshkent (ega, 2026-11-15)', () => {
    const night = new Date('2026-10-22T21:30:00.000Z'); // 23.10 02:30
    const nine = new Date('2026-10-23T04:00:00.000Z'); // 23.10 09:00
    const payloads = () =>
      dispatch.mock.calls.map(
        (c: unknown[]) =>
          c[1] as {
            channels: string[];
            client_request_id: string;
            data: { alert_id: string };
          },
      );
    const due = (id: string) =>
      ds
        .query<
          Array<{ telegram_due_at: Date | null; notified_at: Date | null }>
        >(
          `SELECT telegram_due_at, notified_at FROM ai_schema.ai_advisor_alerts WHERE id = $1`,
          [id],
        )
        .then((r) => r[0]);

    it('tunda: ilova darhol, Telegram 09:00 da bir marta (alohida client_request_id)', async () => {
      const [{ id }] = await insert('critical', 'new', null, 'R6');
      dispatch.mockReturnValue(of({ statusCode: 201 }));
      expect(await notifier.dispatchPending(night)).toEqual({
        sent: 1,
        failed: 0,
      });
      expect(payloads()[0].channels).toEqual(['in_app', 'realtime']);
      expect((await due(id)).telegram_due_at?.toISOString()).toBe(
        nine.toISOString(),
      );

      // 08:59 — hali yo'q.
      expect(
        await notifier.dispatchPending(new Date(nine.getTime() - 60_000)),
      ).toEqual({ sent: 0, failed: 0 });
      // 09:00 — faqat Telegram, boshqa client_request_id.
      expect(await notifier.dispatchPending(nine)).toEqual({
        sent: 1,
        failed: 0,
      });
      const [first, tg] = payloads();
      expect(tg.channels).toEqual(['telegram']);
      // N1: ilova ichidagi qator qayta ko'tarilmaydi; ilk dispatch'da bayroq yo'q.
      expect((tg as { delivery_only?: boolean }).delivery_only).toBe(true);
      expect(
        (first as { delivery_only?: boolean }).delivery_only,
      ).toBeUndefined();
      expect(tg.data.alert_id).toBe(id);
      expect(tg.client_request_id).not.toBe(first.client_request_id);
      expect((await due(id)).telegram_due_at).toBeNull();
      // Qayta — hech narsa.
      expect(
        await notifier.dispatchPending(new Date(nine.getTime() + 30 * 60_000)),
      ).toEqual({ sent: 0, failed: 0 });
      expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it('09:00 gacha hal qilingan — Telegram yuborilmaydi; Telegram xatosi — keyingi tick qayta', async () => {
      const [{ id: closed }] = await insert('critical', 'new', null, 'R6');
      const [{ id: retry }] = await insert('critical', 'new', null, 'R6');
      dispatch.mockReturnValue(of({ statusCode: 201 }));
      await notifier.dispatchPending(night);
      await ds.query(
        `UPDATE ai_schema.ai_advisor_alerts SET status = 'resolved' WHERE id = $1`,
        [closed],
      );
      dispatch.mockClear();
      dispatch.mockReturnValueOnce(throwError(() => new Error('down')));
      expect(await notifier.dispatchPending(nine)).toEqual({
        sent: 0,
        failed: 1,
      });
      expect(payloads().map((p) => p.data.alert_id)).toEqual([retry]);
      expect((await due(closed)).telegram_due_at).toBeNull();
      expect((await due(retry)).telegram_due_at).not.toBeNull();
      dispatch.mockReturnValue(
        of({ statusCode: 201, data: { duplicate: false } }),
      );
      expect(
        await notifier.dispatchPending(new Date(nine.getTime() + 30 * 60_000)),
      ).toEqual({ sent: 1, failed: 0 });
      expect((await due(retry)).telegram_due_at).toBeNull();
    });

    it('#705 S5: 09:00 Telegram rad etilsa — 5 urinishdan keyin telegram_due_at tozalanadi; yetib bo‘lmasa — saqlanadi', async () => {
      const [{ id: bad }] = await insert('critical', 'new', null, 'R6');
      dispatch.mockReturnValue(of({ statusCode: 201 }));
      await notifier.dispatchPending(night);
      dispatch.mockReset();
      dispatch.mockImplementation(() => throwError(() => new TimeoutError()));
      let t = nine.getTime();
      for (let i = 0; i < 4; i++) {
        await notifier.dispatchPending(new Date(t));
        t += 30 * 60_000;
      }
      expect((await due(bad)).telegram_due_at).not.toBeNull();
      dispatch.mockImplementation(() =>
        throwError(() => ({ statusCode: 400, message: 'yaroqsiz' })),
      );
      for (let i = 0; i < 20; i++) {
        await notifier.dispatchPending(new Date(t));
        t += 30 * 60_000;
      }
      expect((await due(bad)).telegram_due_at).toBeNull();
      expect(dispatch.mock.calls.length).toBe(4 + 5);
    });

    it('#705 S6: tunda ochilgan R6 ning birinchi urinishi yiqilib, 09:00 dan keyin qayta urinilsa — ilova ichi ayni kalit bilan, Telegram alohida (yo‘qolmaydi)', async () => {
      // `stale` (24 soat) DB soati bilan — vaqtlar BUGUNGI Toshkent kunidan.
      const day = Math.floor((Date.now() + 5 * 3600_000) / 86_400_000);
      const night2 = new Date(day * 86_400_000 - 5 * 3600_000 + 2.5 * 3600_000);
      const nine2 = new Date(day * 86_400_000 - 5 * 3600_000 + 9 * 3600_000);
      const [{ id }] = await insert('critical', 'new', null, 'R6');
      await ds.query(
        `UPDATE ai_schema.ai_advisor_alerts SET first_at = $2 WHERE id = $1`,
        [id, night2],
      );
      dispatch.mockReturnValueOnce(throwError(() => new TimeoutError()));
      await notifier.dispatchPending(night2);
      dispatch.mockReturnValue(of({ statusCode: 201 }));
      const later = new Date(nine2.getTime() + 30 * 60_000);
      expect(await notifier.dispatchPending(later)).toEqual({
        sent: 2,
        failed: 0,
      });
      const [first, retry, tg] = payloads();
      expect(retry.client_request_id).toBe(first.client_request_id);
      expect(retry.channels).toEqual(['in_app', 'realtime']);
      expect(tg.channels).toEqual(['telegram']);
      expect((await due(id)).telegram_due_at).toBeNull();
    });

    // Bugungi Toshkent kunidan (stale DB soati bilan) — 02:30 va ertangi kun.
    const todayAt = (hours: number) => {
      const day = Math.floor((Date.now() + 5 * 3600_000) / 86_400_000);
      return new Date(day * 86_400_000 - 5 * 3600_000 + hours * 3600_000);
    };

    it('#705 S-a: uzilish yarim tundan o‘tsa — Telegram tunda emas, o‘sha kuni 09:00 da', async () => {
      const [{ id }] = await insert('critical', 'new', null, 'R6');
      await ds.query(
        `UPDATE ai_schema.ai_advisor_alerts SET first_at = $2 WHERE id = $1`,
        [id, todayAt(2.5)],
      );
      dispatch.mockReturnValueOnce(throwError(() => new TimeoutError()));
      await notifier.dispatchPending(todayAt(2.5));
      dispatch.mockReturnValue(of({ statusCode: 201 }));
      // Ertasi kuni 00:30 — ilova ichi darhol, Telegram yo'q.
      expect(await notifier.dispatchPending(todayAt(24.5))).toEqual({
        sent: 1,
        failed: 0,
      });
      expect(payloads()[1].channels).toEqual(['in_app', 'realtime']);
      expect((await due(id)).telegram_due_at?.toISOString()).toBe(
        todayAt(33).toISOString(),
      );
      // 09:00 da — faqat Telegram.
      await notifier.dispatchPending(todayAt(33));
      expect(payloads()[2].channels).toEqual(['telegram']);
    });

    it('#705 S1: kunduz ochilgan R6 tunda qayta urinilsa — Telegram tunda emas, ertasi 09:00 da', async () => {
      const [{ id }] = await insert('critical', 'new', null, 'R6');
      await ds.query(
        `UPDATE ai_schema.ai_advisor_alerts SET first_at = $2 WHERE id = $1`,
        [id, todayAt(21)],
      );
      dispatch.mockReturnValueOnce(throwError(() => new TimeoutError()));
      await notifier.dispatchPending(todayAt(21));
      dispatch.mockReturnValue(of({ statusCode: 201 }));
      // 23:00 — ilova ichi darhol, Telegram yo'q.
      expect(await notifier.dispatchPending(todayAt(23))).toEqual({
        sent: 1,
        failed: 0,
      });
      expect(payloads()[1].channels).toEqual(['in_app', 'realtime']);
      expect((await due(id)).telegram_due_at?.toISOString()).toBe(
        todayAt(33).toISOString(),
      );
    });

    it('#705 rr13: kunduz ochilgan R6 — asosiy rejim qayta urinishlarda o‘zgarmaydi; Telegram bir marta, tunda emas', async () => {
      const [{ id }] = await insert('critical', 'new', null, 'R6');
      await ds.query(
        `UPDATE ai_schema.ai_advisor_alerts SET first_at = $2 WHERE id = $1`,
        [id, todayAt(10)],
      );
      // 10:00 — notification-service qabul qildi, javob yo'qoldi (timeout).
      dispatch.mockReturnValueOnce(throwError(() => new TimeoutError()));
      await notifier.dispatchPending(todayAt(10));
      dispatch.mockReturnValue(of({ statusCode: 201 }));
      // 23:00 — qayta urinish (ayni client_request_id); Telegram tunda yo'q.
      await notifier.dispatchPending(todayAt(23));
      expect(
        payloads().filter((x) => x.channels.includes('telegram')),
      ).toHaveLength(0);
      expect((await due(id)).telegram_due_at?.toISOString()).toBe(
        todayAt(33).toISOString(),
      );
      await notifier.dispatchPending(todayAt(33));
      const p = payloads();
      const main = p.filter(
        (x) => !x.channels.includes('telegram') || x.channels.length > 1,
      );
      expect(new Set(main.map((x) => x.client_request_id)).size).toBe(1);
      expect(main.every((x) => !x.channels.includes('telegram'))).toBe(true);
      expect(p.filter((x) => x.channels.includes('telegram'))).toHaveLength(1);
      expect((await due(id)).telegram_due_at).toBeNull();
    });

    it('#705 S-b: 09:00 Telegram — o‘z timeout’i bor qator boshqasini to‘smaydi (navbat oxiriga)', async () => {
      const [{ id: x }] = await insert('critical', 'new', null, 'R6');
      const [{ id: y }] = await insert('critical', 'new', null, 'R6');
      dispatch.mockReturnValue(of({ statusCode: 201 }));
      await notifier.dispatchPending(night);
      dispatch.mockReset();
      dispatch.mockImplementation((_p: unknown, body: unknown) =>
        (body as { data: { alert_id: string } }).data.alert_id === x
          ? throwError(() => new TimeoutError())
          : of({ statusCode: 201 }),
      );
      await ds.query(
        `UPDATE ai_schema.ai_advisor_alerts SET "updatedAt" = now() - INTERVAL '1 hour' WHERE id = $1`,
        [x],
      );
      let t = nine.getTime();
      for (let i = 0; i < 3; i++) {
        await notifier.dispatchPending(new Date(t));
        t += 30 * 60_000;
      }
      expect((await due(y)).telegram_due_at).toBeNull();
      expect((await due(x)).telegram_due_at).not.toBeNull();
    });

    it('#705 S-c: 09:00 da superadminlar olinmasa — qatorlarga urinish yozilmaydi, keyin yetkaziladi', async () => {
      const [{ id }] = await insert('critical', 'new', null, 'R6');
      dispatch.mockReturnValue(of({ statusCode: 201 }));
      await notifier.dispatchPending(night);
      dispatch.mockClear();
      // Superadminlar keshi (real soat bo'yicha 5 daq) — tozalanadi.
      (notifier as unknown as { recipientsCache: unknown }).recipientsCache =
        null;
      identity.mockImplementation(() =>
        throwError(() => ({ statusCode: 500, message: 'identity' })),
      );
      try {
        let t = nine.getTime();
        for (let i = 0; i < 10; i++) {
          await notifier.dispatchPending(new Date(t));
          t += 60 * 60_000;
        }
        expect(dispatch).not.toHaveBeenCalled();
        expect((await due(id)).telegram_due_at).not.toBeNull();
      } finally {
        identity.mockImplementation(() =>
          of({ data: { items: [{ id: '1' }, { id: 5 }] } }),
        );
      }
      await notifier.dispatchPending(new Date(nine.getTime() + 11 * 3600_000));
      expect(payloads().map((p) => p.channels)).toEqual([['telegram']]);
      expect((await due(id)).telegram_due_at).toBeNull();
    });

    it('#705 rr11: 09:00 Telegram uzilishi 22:00 dan o‘tsa — qayta urinish ham tunda yuborilmaydi, ertasi 09:00 da bir marta', async () => {
      const [{ id }] = await insert('critical', 'new', null, 'R6');
      dispatch.mockReturnValue(of({ statusCode: 201 }));
      await notifier.dispatchPending(night);
      expect((await due(id)).telegram_due_at?.toISOString()).toBe(
        nine.toISOString(),
      );
      dispatch.mockReset();
      // 09:00–22:00 notification-service nosoz (5xx) — Telegram ketmadi.
      dispatch.mockImplementation(() =>
        throwError(() => ({ statusCode: 503, message: 'x' })),
      );
      let t = nine.getTime();
      const tenPm = nine.getTime() + 13 * 3600_000;
      for (; t < tenPm; t += 30 * 60_000)
        await notifier.dispatchPending(new Date(t));
      // 22:00 dan tiklandi — 22:00..08:30 tunda Telegram yo'q.
      dispatch.mockReset();
      dispatch.mockReturnValue(of({ statusCode: 201 }));
      for (; t < nine.getTime() + 24 * 3600_000; t += 30 * 60_000)
        await notifier.dispatchPending(new Date(t));
      expect(dispatch).not.toHaveBeenCalled();
      // Ertasi 09:00 — bir marta.
      await notifier.dispatchPending(new Date(nine.getTime() + 24 * 3600_000));
      expect(payloads().map((p) => p.channels)).toEqual([['telegram']]);
      expect((await due(id)).telegram_due_at).toBeNull();
    });

    it('09:00 dan keyin ochilgan R6 — shu tick Telegram (alohida `:tg`); R2 tunda ham darhol', async () => {
      const [{ id: day }] = await insert('critical', 'new', null, 'R6');
      dispatch.mockReturnValue(of({ statusCode: 201 }));
      await notifier.dispatchPending(new Date(nine.getTime() + 3600_000));
      expect(payloads().map((p) => p.channels)).toEqual([
        ['in_app', 'realtime'],
        ['telegram'],
      ]);
      expect((await due(day)).telegram_due_at).toBeNull();

      dispatch.mockClear();
      await insert('critical', 'new', null, 'R2');
      await notifier.dispatchPending(night);
      expect(payloads()[0].channels).toEqual([
        'in_app',
        'realtime',
        'telegram',
      ]);
    });
  });
});
