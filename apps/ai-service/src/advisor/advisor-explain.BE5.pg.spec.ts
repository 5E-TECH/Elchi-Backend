import { DataSource } from 'typeorm';
import { AiAdvisorAlerts1716000000224 } from '../../../../migrations/1716000000224-AiAdvisorAlerts';
import {
  ADVISOR_KB_VERSION,
  AdvisorExplainService,
  cleanExplanation,
  explainInput,
} from './advisor-explain.service';

/**
 * BE-5 §6/§7.4 — AI izohi haqiqiy Postgres'da, Claude MOCK (pullik chaqiruv
 * yo'q): doim 202, kesh, takroriy pending, 409/429/503, fon natijasi faqat
 * ayni navbatga, avtomatik izoh ≤ 5 va eskirgan pending → failed.
 */
const ADMIN_URI = process.env.AI_ADVISOR_PG_TEST_URI;
const describePg = ADMIN_URI ? describe : describe.skip;

const SUPER = { id: '7', roles: ['superadmin'], name: 'S' };

describePg('AdvisorExplainService — real Postgres (BE-5)', () => {
  const dbName = `elchi_ai_explain_${process.pid}_${Date.now()}`;
  let admin: DataSource;
  let ds: DataSource;
  const extractJson = jest.fn();
  const isEnabled = jest.fn(() => true);
  const check = jest.fn();
  const emit = jest.fn();
  const config = new Map<string, string>();
  let svc: AdvisorExplainService;

  beforeAll(async () => {
    const url = new URL(ADMIN_URI as string);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('faqat lokal Postgres');
    admin = new DataSource({ type: 'postgres', url: ADMIN_URI });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    url.pathname = `/${dbName}`;
    ds = new DataSource({ type: 'postgres', url: url.toString() });
    await ds.initialize();
    const qr = ds.createQueryRunner();
    try {
      await qr.query('CREATE SCHEMA IF NOT EXISTS ai_schema');
      await new AiAdvisorAlerts1716000000224().up(qr);
    } finally {
      await qr.release();
    }
    svc = new AdvisorExplainService(
      ds,
      { extractJson, isEnabled } as never,
      { check } as never,
      { get: (k: string) => config.get(k) } as never,
      { emit } as never,
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
    await svc.drain();
    jest.clearAllMocks();
    config.clear();
    isEnabled.mockReturnValue(true);
    check.mockResolvedValue({ ok: true });
    extractJson.mockResolvedValue({
      ok: true,
      data: { explanation_md: '**Nima bo‘ldi:** <b>kassa</b> oshdi.' },
      model: 'claude-test',
    });
    await ds.query(
      'TRUNCATE ai_schema.ai_advisor_alerts RESTART IDENTITY CASCADE',
    );
  });

  const insert = (
    over: Partial<{
      severity: string;
      status: string;
      skipped: string | null;
      expl: string;
      requested: Date | null;
    }> = {},
  ) =>
    ds
      .query<Array<{ id: string }>>(
        `INSERT INTO ai_schema.ai_advisor_alerts
           (rule_key, severity, status, dedup_key, title, notify_skipped, explanation_status, explanation_requested_at, facts, evidence)
         VALUES ('R7', $1, $2, $3, 't', $4, $5, $6, '{"amount":1}',
                 '{"receipt":{"recipient":"Ali Valiyev","payer":"X","reference":"TX1","card_last4":"1234"},"rows":[]}')
         RETURNING id::text AS id`,
        [
          over.severity ?? 'critical',
          over.status ?? 'new',
          `k${Math.random()}`,
          over.skipped ?? null,
          over.expl ?? 'none',
          over.requested ?? null,
        ],
      )
      .then((r) => r[0].id);
  const row = (id: string) =>
    ds
      .query<Array<Record<string, unknown>>>(
        `SELECT explanation_status, explanation_md, explanation_error, explanation_error_scope,
                explanation_retry_at, explanation_model, kb_version
           FROM ai_schema.ai_advisor_alerts WHERE id = $1`,
        [id],
      )
      .then((r) => r[0]);
  const settle = () => svc.drain();

  it('202 pending → fonda ready (HTML tozalangan), realtime explanation; keyin keshdan', async () => {
    const id = await insert();
    const first = await svc.request(SUPER, id);
    expect(first).toEqual({
      alert_id: id,
      explanation_status: 'pending',
      explanation_md: null,
      explained_at: null,
      cached: false,
      poll_after_ms: 2000,
    });
    await settle();
    expect(await row(id)).toMatchObject({
      explanation_status: 'ready',
      explanation_md: '**Nima bo‘ldi:** kassa oshdi.',
      explanation_model: 'claude-test',
      kb_version: ADVISOR_KB_VERSION,
      explanation_error: null,
    });
    const [args] = extractJson.mock.calls[0] as [Record<string, unknown>];
    expect(args.meta).toMatchObject({
      feature: 'advisor_alert',
      requestArea: 'internal',
      userId: '7',
    });
    // PII promptga tushmaydi
    expect(String(args.userText)).not.toMatch(/Ali Valiyev|TX1|"payer"/);
    expect(String(args.userText)).toContain('1234');
    expect(emit).toHaveBeenCalledWith([
      expect.objectContaining({
        alert_id: id,
        change: 'explanation',
        explanation_status: 'ready',
      }),
    ]);

    const second = await svc.request(SUPER, id);
    expect(second).toMatchObject({
      explanation_status: 'ready',
      cached: true,
      poll_after_ms: null,
    });
    expect(extractJson).toHaveBeenCalledTimes(1);
  });

  it('yangi pending — qayta navbat yo‘q (pul ikkinchi marta ketmaydi)', async () => {
    const id = await insert({ expl: 'pending', requested: new Date() });
    expect((await svc.request(SUPER, id)).explanation_status).toBe('pending');
    await settle();
    expect(extractJson).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it('409 yopilgan, 404 yo‘q; 429 budjet va 503 — explanation_status o‘zgarmaydi', async () => {
    const closed = await insert({ status: 'resolved' });
    await expect(svc.request(SUPER, closed)).rejects.toMatchObject({
      error: { statusCode: 409, code: 'AI_ADVISOR_ALERT_CLOSED' },
    });
    await expect(svc.request(SUPER, '999')).rejects.toMatchObject({
      error: { statusCode: 404 },
    });
    await expect(svc.request(SUPER, 'abc')).rejects.toMatchObject({
      error: { statusCode: 404 },
    });

    const id = await insert({ expl: 'failed' });
    const now = new Date('2026-11-14T10:00:00Z');
    check.mockResolvedValueOnce({
      ok: false,
      reason: 'cap_exceeded',
      scope: 'global',
      reset_at: '2026-11-14T19:00:00.000Z',
    });
    await expect(svc.request(SUPER, id, now)).rejects.toMatchObject({
      error: {
        statusCode: 429,
        code: 'AI_ADVISOR_BUDGET_EXCEEDED',
        scope: 'global',
        period: 'day',
        reset_at: '2026-11-14T19:00:00.000Z',
        retry_after_seconds: 32400,
      },
    });
    check.mockRejectedValueOnce(new Error('db'));
    await expect(svc.request(SUPER, id)).rejects.toMatchObject({
      error: {
        statusCode: 503,
        code: 'AI_ADVISOR_AI_DISABLED',
        reason: 'budget_unreadable',
      },
    });
    isEnabled.mockReturnValueOnce(false);
    await expect(svc.request(SUPER, id)).rejects.toMatchObject({
      error: { statusCode: 503, reason: 'ai_disabled' },
    });
    config.set('AI_ADVISOR_EXPLAIN', 'off');
    await expect(svc.request(SUPER, id)).rejects.toMatchObject({
      error: { statusCode: 503, reason: 'feature_disabled' },
    });
    expect((await row(id)).explanation_status).toBe('failed');
    expect(extractJson).not.toHaveBeenCalled();
  });

  it('cap_exceeded fonda → failed budget_exceeded global retry_at; boshqa xato → error', async () => {
    const id = await insert();
    extractJson.mockResolvedValueOnce({
      ok: false,
      reason: 'cap_exceeded',
      scope: 'global',
      reset_at: '2026-11-14T19:00:00.000Z',
    });
    await svc.request(SUPER, id);
    await settle();
    expect(await row(id)).toMatchObject({
      explanation_status: 'failed',
      explanation_error: 'budget_exceeded',
      explanation_error_scope: 'global',
      explanation_retry_at: new Date('2026-11-14T19:00:00.000Z'),
    });
    extractJson.mockResolvedValueOnce({ ok: false, reason: 'api_error' });
    await svc.request(SUPER, id); // failed → qayta navbat
    await settle();
    expect(await row(id)).toMatchObject({
      explanation_status: 'failed',
      explanation_error: 'error',
      explanation_error_scope: null,
      explanation_retry_at: null,
    });
  });

  it('natija eskirgan navbatga yozilmaydi (requested_at o‘zgargan)', async () => {
    const id = await insert();
    let release!: (v: unknown) => void;
    extractJson.mockReturnValueOnce(new Promise((r) => (release = r)));
    await svc.request(SUPER, id);
    while (!extractJson.mock.calls.length)
      await new Promise((r) => setImmediate(r));
    await ds.query(
      `UPDATE ai_schema.ai_advisor_alerts SET explanation_status = 'failed', explanation_error = 'error' WHERE id = $1`,
      [id],
    );
    release({ ok: true, data: { explanation_md: 'kech' }, model: 'm' });
    await settle();
    expect(await row(id)).toMatchObject({
      explanation_status: 'failed',
      explanation_md: null,
    });
    expect(emit.mock.calls).toEqual([]);
  });

  it('autoExplain: ≤ 5 ochiq critical (backfill/warning/yopilgan emas); eskirgan pending → failed', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await insert());
    await insert({ severity: 'warning' });
    await insert({ skipped: 'backfill' });
    await insert({ status: 'dismissed' });
    const stale = await insert({
      severity: 'warning',
      expl: 'pending',
      requested: new Date(Date.now() - 10 * 60_000),
    });
    expect(await svc.autoExplain()).toEqual({ queued: 5, stale: 1 });
    expect((await row(stale)).explanation_error).toBe('error');
    await settle();
    const statuses = await ds.query<
      Array<{ id: string; explanation_status: string }>
    >(
      `SELECT id::text AS id, explanation_status FROM ai_schema.ai_advisor_alerts WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [ids],
    );
    expect(
      statuses.filter((s) => s.explanation_status === 'ready'),
    ).toHaveLength(5);
    expect(statuses[0].explanation_status).toBe('none'); // eng eskisi keyingi tick'ga
    expect(
      extractJson.mock.calls.every(
        (c: unknown[]) =>
          (c[0] as { meta: { userId: unknown } }).meta.userId === null,
      ),
    ).toBe(true);

    check.mockResolvedValueOnce({
      ok: false,
      reason: 'cap_exceeded',
      scope: 'global',
      reset_at: 'x',
    });
    expect(await svc.autoExplain()).toEqual({ queued: 0, stale: 0 });
    expect(statuses[0].explanation_status).toBe('none');
  });
});

describe('advisor explain helpers', () => {
  it('cleanExplanation: HTML yo‘q, ≤ 2000, bo‘sh → null', () => {
    expect(cleanExplanation('<script>x</script>ok')).toBe('xok');
    expect(cleanExplanation('   ')).toBeNull();
    expect(cleanExplanation(5)).toBeNull();
    expect(cleanExplanation('a'.repeat(3000))).toHaveLength(2000);
  });

  it('explainInput: oluvchi/to‘lovchi/reference tashlanadi, dalil qatorlari ≤ 10', () => {
    const input = explainInput({
      id: '1',
      rule_key: 'R2',
      severity: 'critical',
      status: 'new',
      title: 't',
      facts: { a: 1 },
      evidence: {
        rows: Array.from({ length: 30 }, (_, i) => ({ i })),
        receipt: { recipient: 'A', payer: 'B', reference: 'R', x: 1 },
      },
      rule_snapshot: { thresholds: { days: 3 } },
      occurrences: 2,
      explanation_status: 'none',
      explanation_md: null,
      explanation_requested_at: null,
      explained_at: null,
    });
    const ev = input.evidence as {
      rows: unknown[];
      receipt: Record<string, unknown>;
    };
    expect(ev.rows).toHaveLength(10);
    expect(ev.receipt).toEqual({ x: 1 });
    expect(input.thresholds).toEqual({ days: 3 });
  });
});
