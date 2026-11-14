import { RpcException } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import type { ActivityLogService } from '@app/common';
import { AiAdvisorAlerts1716000000224 } from '../../../../migrations/1716000000224-AiAdvisorAlerts';
import { AdvisorAlertsService } from './advisor-alerts.service';

/**
 * BE-5 — ogohlantirishlar REST'i haqiqiy Postgres'da (§5.5, §7.2, §7.3,
 * §7.5): overview, ro'yxat (filtr, segment sonlari, saralash, sahifa),
 * tafsilot (`new → seen` bir marta, boshqa holatga tegmaydi), PATCH
 * (izoh, idempotent, 409, 404, audit). Spec o'z vaqtinchalik bazasida.
 */
const ADMIN_URI = process.env.AI_ADVISOR_PG_TEST_URI;
const describePg = ADMIN_URI ? describe : describe.skip;

const SA = { id: '1', roles: ['superadmin'], name: 'Shodiyor Ergashev' };
const SA2 = { id: '5', roles: ['superadmin'], name: 'Ikkinchi SA' };
const NOW = new Date('2026-10-22T09:30:00.000Z');

function errorOf(err: unknown): Record<string, unknown> {
  expect(err).toBeInstanceOf(RpcException);
  return (err as RpcException).getError() as Record<string, unknown>;
}

describePg('AdvisorAlertsService — real Postgres (BE-5)', () => {
  const dbName = `elchi_ai_alerts_${process.pid}_${Date.now()}`;
  let admin: DataSource;
  let ds: DataSource;
  let svc: AdvisorAlertsService;
  const log = jest.fn<Promise<void>, [Record<string, unknown>]>();

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
    svc = new AdvisorAlertsService(ds, {
      log,
    } as unknown as ActivityLogService);
  });

  afterAll(async () => {
    await ds?.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    log.mockReset();
    await ds.query(
      'TRUNCATE ai_schema.ai_advisor_alerts, ai_schema.ai_advisor_alert_occurrences RESTART IDENTITY CASCADE',
    );
  });

  async function alert(over: Record<string, unknown>): Promise<string> {
    const row = {
      rule_key: 'R1',
      severity: 'warning',
      status: 'new',
      dedup_key: `k${Math.random()}`,
      title: 'Samarqand filiali kassasi: smena kamomadi',
      last_at: '2026-10-22T08:45:00Z',
      ...over,
    };
    const [r] = await ds.query<Array<{ id: string }>>(
      `INSERT INTO ai_schema.ai_advisor_alerts
         (rule_key, severity, status, dedup_key, title, last_at, first_at, occurrences, subject, branch,
          explanation_status, explanation_requested_at, rule_snapshot, resolved_by, resolved_at, links, evidence, facts)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb, $13, $14, '[]', '{"kind":"shifts"}', '{"trigger":"single_shortage"}')
       RETURNING id::text AS id`,
      [
        row.rule_key,
        row.severity,
        row.status,
        row.dedup_key,
        row.title,
        row.last_at,
        row.occurrences ?? 1,
        JSON.stringify(
          row.subject ?? {
            kind: 'cashbox',
            id: '7',
            name: 'Samarqand filiali kassasi',
          },
        ),
        row.branch === undefined
          ? JSON.stringify({ id: '7', name: 'Samarqand filiali' })
          : row.branch,
        row.explanation_status ?? 'none',
        row.explanation_requested_at ?? null,
        JSON.stringify({
          key: row.rule_key,
          severity: row.severity,
          thresholds: { shortage_uzs: 50000, consecutive_negative: 3 },
        }),
        row.resolved_by ?? null,
        row.resolved_at ?? null,
      ],
    );
    return r.id;
  }

  it('overview: new/open/critical, qoida kalitlari MAX(last_at) DESC bo‘yicha, bir to‘plamdan', async () => {
    await alert({
      rule_key: 'R2',
      severity: 'critical',
      last_at: '2026-10-22T08:00:00Z',
    });
    await alert({
      rule_key: 'R7',
      severity: 'critical',
      last_at: '2026-10-22T09:00:00Z',
    });
    await alert({
      rule_key: 'R6',
      severity: 'critical',
      status: 'seen',
      last_at: '2026-10-22T09:10:00Z',
    });
    await alert({ rule_key: 'R1' });
    await alert({ rule_key: 'R1', status: 'resolved' });
    const out = await svc.overview(NOW);
    expect(out).toEqual({
      alerts: {
        new: 3,
        open: 4,
        critical: 2,
        critical_open: 3,
        critical_rule_keys: ['R7', 'R2'],
        critical_open_rule_keys: ['R6', 'R7', 'R2'],
      },
      recommendations: null,
      budget: null,
      usd_uzs_rate: null,
      generated_at: NOW.toISOString(),
    });
  });

  it('ro‘yxat: filtrlar, segment sonlari status’siz, sahifa va id DESC; holatni o‘zgartirmaydi', async () => {
    const a = await alert({ last_at: '2026-10-22T08:00:00Z' });
    const b = await alert({ last_at: '2026-10-22T08:00:00Z' }); // ayni last_at — id DESC
    const c = await alert({
      status: 'seen',
      severity: 'critical',
      rule_key: 'R2',
      last_at: '2026-10-21T08:00:00Z',
    });
    await alert({ status: 'dismissed', last_at: '2026-10-20T08:00:00Z' });
    const all = await svc.list({ limit: 2 }, NOW);
    expect(all.items.map((i) => i.id)).toEqual([b, a]);
    expect(all.meta).toEqual({ page: 1, limit: 2, total: 4, totalPages: 2 });
    expect(all.counts.by_status).toEqual({
      new: 2,
      seen: 1,
      resolved: 0,
      dismissed: 1,
    });
    expect(all.items[0]).toMatchObject({
      status: 'new',
      branch: { id: '7', name: 'Samarqand filiali' },
      subject: { kind: 'cashbox' },
      explanation_status: 'none',
      reopened_from_id: null,
    });

    const open = await svc.list({ status: 'open', severity: 'critical' }, NOW);
    expect(open.items.map((i) => i.id)).toEqual([c]);
    expect(open.counts.by_status).toEqual({
      new: 0,
      seen: 1,
      resolved: 0,
      dismissed: 0,
    });

    // Toshkent kuni: 21.10 (UTC 21.10 08:00 = Toshkent 21.10 13:00).
    const day = await svc.list({ from: '2026-10-21', to: '2026-10-21' }, NOW);
    expect(day.items.map((i) => i.id)).toEqual([c]);

    const sev = await svc.list({ sort_by: 'severity' }, NOW);
    expect(sev.items[0].id).toBe(c);
    expect((await svc.list({ q: 'samarqand' }, NOW)).meta.total).toBe(4);
    expect((await svc.list({ q: '100%_' }, NOW)).meta.total).toBe(0);
    // Holat o'zgarmadi.
    expect((await svc.overview(NOW)).alerts.new).toBe(2);
  });

  it('ro‘yxat: noto‘g‘ri query — 400', async () => {
    for (const q of [
      { limit: 101 },
      { page: 0 },
      { status: 'x' },
      { from: '2026-01-01', to: '2027-02-02' },
      { sort_by: 'id' },
    ]) {
      await expect(svc.list(q as never, NOW)).rejects.toMatchObject({
        status: 400,
      });
    }
  });

  it('tafsilot: new → seen bir marta (seen_by saqlanadi), resolved’ga tegmaydi, mark_seen=false; 404', async () => {
    const id = await alert({});
    const first = await svc.get(SA, id, {}, NOW);
    expect(first).toMatchObject({
      status: 'seen',
      seen_at: NOW.toISOString(),
      seen_by: { id: '1', name: 'Shodiyor Ergashev' },
      rule: {
        key: 'R1',
        severity: 'warning',
        thresholds: { shortage_uzs: 50000, consecutive_negative: 3 },
      },
      evidence: { kind: 'shifts' },
      links: [],
      explanation_md: null,
      explanation_poll_after_ms: null,
      reopened_from: null,
    });
    expect(first).not.toHaveProperty('history');
    expect(first).not.toHaveProperty('explanation_model');
    const again = await svc.get(SA2, id, {}, new Date(NOW.getTime() + 60_000));
    expect(again.seen_by).toEqual({ id: '1', name: 'Shodiyor Ergashev' });

    const closed = await alert({
      status: 'resolved',
      resolved_by: '1',
      resolved_at: '2026-10-22T09:00:00Z',
    });
    expect((await svc.get(SA, closed, {}, NOW)).status).toBe('resolved');
    const fresh = await alert({});
    expect((await svc.get(SA, fresh, { mark_seen: false }, NOW)).status).toBe(
      'new',
    );

    expect(
      errorOf(await svc.get(SA, '999999', {}, NOW).catch((e: unknown) => e)),
    ).toMatchObject({
      statusCode: 404,
      code: 'AI_ADVISOR_ALERT_NOT_FOUND',
    });
    await expect(svc.get(SA, '12a', {}, NOW)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('tafsilot: pending 3 daqiqadan eski — failed + error; yangi — pending + poll 2 s', async () => {
    const stale = await alert({
      explanation_status: 'pending',
      explanation_requested_at: '2026-10-22T09:20:00Z',
    });
    const freshP = await alert({
      explanation_status: 'pending',
      explanation_requested_at: '2026-10-22T09:29:00Z',
    });
    expect(await svc.get(SA, stale, {}, NOW)).toMatchObject({
      explanation_status: 'failed',
      explanation_error: 'error',
      explanation_poll_after_ms: null,
    });
    expect(await svc.get(SA, freshP, {}, NOW)).toMatchObject({
      explanation_status: 'pending',
      explanation_error: null,
      explanation_poll_after_ms: 2000,
    });
    expect(
      (await svc.list({}, NOW)).items.find((i) => i.id === stale)
        ?.explanation_status,
    ).toBe('failed');
  });

  it('PATCH resolved: izoh 3–500, audit, idempotent; boshqa SA → 409; dismissed izohsiz; reopened_from', async () => {
    const id = await alert({});
    for (const [note, reason] of [
      [undefined, 'required'],
      ['   ', 'required'],
      [' ab ', 'too_short'],
      ['x'.repeat(501), 'too_long'],
    ] as const) {
      expect(
        errorOf(
          await svc
            .update(SA, id, 'resolved', note, NOW)
            .catch((e: unknown) => e),
        ),
      ).toEqual({
        statusCode: 400,
        message: expect.any(String) as unknown,
        data: null,
        code: 'AI_ADVISOR_NOTE_INVALID',
        reason,
        min_length: 3,
        max_length: 500,
      });
    }
    const done = await svc.update(SA, id, 'resolved', '  Tekshirildi  ', NOW);
    expect(done).toMatchObject({
      status: 'resolved',
      resolved_at: NOW.toISOString(),
      resolved_by: { id: '1', name: 'Shodiyor Ergashev' },
      resolution_note: 'Tekshirildi',
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      action: 'ai.advisor.alert.resolve',
      entity_type: 'ai_advisor_alert',
      entity_id: id,
      old_value: { status: 'new' },
      new_value: { status: 'resolved', resolution_note: 'Tekshirildi' },
      metadata: { rule_key: 'R1', severity: 'warning', occurrences: 1 },
      description: `AI ogohlantirish #${id} hal qilindi — Smena kamomadi, Samarqand filiali`,
    });

    // Ikki marta bosish — 200, izoh qayta yozilmaydi, audit takrorlanmaydi.
    const twice = await svc.update(SA, id, 'resolved', 'boshqa izoh', NOW);
    expect(twice.resolution_note).toBe('Tekshirildi');
    expect(log).toHaveBeenCalledTimes(1);

    expect(
      errorOf(
        await svc
          .update(SA2, id, 'resolved', 'Mening izohim', NOW)
          .catch((e: unknown) => e),
      ),
    ).toMatchObject({
      statusCode: 409,
      code: 'AI_ADVISOR_ALERT_CLOSED',
      alert_status: 'resolved',
    });
    expect(
      errorOf(
        await svc
          .update(SA, id, 'dismissed', null, NOW)
          .catch((e: unknown) => e),
      ),
    ).toMatchObject({
      statusCode: 409,
      alert_status: 'resolved',
    });

    const other = await alert({
      status: 'seen',
      rule_key: 'R2',
      subject: { kind: 'courier', id: '55', name: 'Jasur' },
      branch: null,
    });
    const dismissed = await svc.update(SA, other, 'dismissed', null, NOW);
    expect(dismissed).toMatchObject({
      status: 'dismissed',
      resolution_note: null,
    });
    expect(log.mock.calls[1][0]).toMatchObject({
      action: 'ai.advisor.alert.dismiss',
      description: `AI ogohlantirish #${other} ahamiyatsiz deb belgilandi — Kuryer qarzi o'smoqda, Jasur`,
    });
    expect(
      errorOf(
        await svc
          .update(SA, other, 'dismissed', 'x'.repeat(501), NOW)
          .catch((e: unknown) => e),
      ),
    ).toMatchObject({
      code: 'AI_ADVISOR_NOTE_INVALID',
      reason: 'too_long',
    });

    const reopened = await alert({});
    await ds.query(
      `UPDATE ai_schema.ai_advisor_alerts SET reopened_from_id = $1 WHERE id = $2`,
      [id, reopened],
    );
    expect(
      (await svc.get(SA, reopened, { include: ['history'] }, NOW))
        .reopened_from,
    ).toEqual({
      id,
      status: 'resolved',
      resolved_at: NOW.toISOString(),
    });
  });

  it('parallel ikki PATCH (ikki SA) — aynan bittasi o‘tadi', async () => {
    const id = await alert({});
    const res = await Promise.allSettled([
      svc.update(SA, id, 'resolved', 'birinchi', NOW),
      svc.update(SA2, id, 'dismissed', null, NOW),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('history: opened, occurred, seen, resolved — eskisi birinchi', async () => {
    const id = await alert({});
    for (const [fact, at] of [
      ['806', '2026-10-20T16:00:00Z'],
      ['812', '2026-10-21T16:00:00Z'],
      ['818', '2026-10-21T16:00:00Z'],
    ]) {
      await ds.query(
        `INSERT INTO ai_schema.ai_advisor_alert_occurrences (alert_id, dedup_key, fact_key, occurred_at) VALUES ($1, 'x', $2, $3)`,
        [id, fact, at],
      );
    }
    await svc.get(SA, id, {}, NOW);
    await svc.update(
      SA,
      id,
      'resolved',
      'Tekshirildi',
      new Date(NOW.getTime() + 60_000),
    );
    const d = await svc.get(SA, id, { include: ['history'] }, NOW);
    expect(d.history?.map((h) => h.event)).toEqual([
      'opened',
      'occurred',
      'seen',
      'resolved',
    ]);
    expect(d.history?.[3]).toMatchObject({
      by: { id: '1' },
      note: 'Tekshirildi',
    });
  });
});
