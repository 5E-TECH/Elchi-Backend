import { DataSource } from 'typeorm';
import type {
  ActivityLogService,
  AiAdvisorCandidate,
  AiAdvisorRuleInputsRequest,
  AiAdvisorRuleInputsResponse,
} from '@app/common';
import { AiAdvisorAlerts1716000000224 } from '../../../../migrations/1716000000224-AiAdvisorAlerts';
import { AiAdvisorRuleState1716000000226 } from '../../../../migrations/1716000000226-AiAdvisorRuleState';
import { AdvisorEngineService } from './advisor-engine.service';
import type { AdvisorReader } from './advisor-reader';
import { AdvisorScheduler } from './advisor.scheduler';
import { AdvisorSettingsService } from './advisor-settings.service';

/**
 * BE-5 — qoidalar dvigateli haqiqiy Postgres'da (§4.0, §4.3, §6):
 * ochilish, takror (occurrences+1, holat o'zgarmaydi), ayni fakt — hech
 * narsa, yopilgandan keyin yangi fakt — yangi qator (`reopened_from_id`),
 * yopilgandan keyin ayni fakt — hech narsa, backfill, kursor, enabled=false,
 * advisory lock. Spec o'z vaqtinchalik bazasida.
 */
const ADMIN_URI = process.env.AI_ADVISOR_PG_TEST_URI;
const describePg = ADMIN_URI ? describe : describe.skip;

const NOW = new Date('2026-10-22T09:00:00.000Z');
const SA = { id: '1', roles: ['superadmin'], name: 'SA' };

function r1(
  shiftIds: Array<[string, string]>,
  over: Partial<AiAdvisorCandidate> = {},
): AiAdvisorCandidate {
  return {
    rule_key: 'R1',
    dedup_key: 'R1:cashbox:7',
    fact_keys: shiftIds.map(([fact_key, fact_at]) => ({ fact_key, fact_at })),
    branch: { id: '7', name: 'Samarqand filiali' },
    subject: { kind: 'cashbox', id: '7', name: 'Samarqand filiali kassasi' },
    headline_amount: -120000,
    facts: {
      trigger: 'single_shortage',
      cashbox: {
        type: 'branch',
        owner_id: '7',
        name: 'Samarqand filiali kassasi',
      },
      shifts_count: shiftIds.length,
      total_difference: -120000,
      last_difference: -120000,
      last_shift_id: shiftIds[shiftIds.length - 1]?.[0],
    },
    evidence: {
      kind: 'shifts',
      total_rows: shiftIds.length,
      truncated: false,
      rows: [],
    },
    ...over,
  };
}

describePg('AdvisorEngineService — real Postgres (BE-5)', () => {
  const dbName = `elchi_ai_engine_${process.pid}_${Date.now()}`;
  let admin: DataSource;
  let ds: DataSource;
  let settings: AdvisorSettingsService;
  let engine: AdvisorEngineService;
  let reply: AiAdvisorRuleInputsResponse;
  const requests: AiAdvisorRuleInputsRequest[] = [];
  const reader = {
    ruleInputs: jest.fn((req: AiAdvisorRuleInputsRequest) => {
      requests.push(req);
      return Promise.resolve(reply);
    }),
  };

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
      await new AiAdvisorRuleState1716000000226().up(qr);
      await new AiAdvisorRuleState1716000000226().up(qr); // idempotent
      await new AiAdvisorRuleState1716000000226().down(qr);
      await new AiAdvisorRuleState1716000000226().up(qr);
    } finally {
      await qr.release();
    }
    settings = new AdvisorSettingsService(ds, {
      log: jest.fn(),
    } as unknown as ActivityLogService);
    engine = new AdvisorEngineService(
      ds,
      settings,
      reader as unknown as AdvisorReader,
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
    requests.length = 0;
    reply = { candidates: [], cursors: {} };
    await ds.query(
      'TRUNCATE ai_schema.ai_advisor_alerts, ai_schema.ai_advisor_alert_occurrences, ai_schema.ai_advisor_rule_state, ai_schema.ai_advisor_settings RESTART IDENTITY CASCADE',
    );
  });

  const alerts = () =>
    ds.query<Array<Record<string, unknown>>>(
      `SELECT id::text, status, severity, occurrences, notify_skipped, reopened_from_id::text,
              explanation_status, title, links, rule_snapshot, first_fact_at, last_fact_at
         FROM ai_schema.ai_advisor_alerts ORDER BY id`,
    );
  /** Birinchi ishga tushishni o'tkazish (backfill holatisiz testlar uchun). */
  const warmUp = () =>
    engine.run('frequent', new Date(NOW.getTime() - 3600_000));

  it('birinchi ishga tushish: 24 soatdan eski fakt — backfill (bildirishnomasiz); yangisi — oddiy', async () => {
    reply = {
      candidates: [
        r1([['801', '2026-10-15T10:00:00Z']]),
        r1([['900', '2026-10-22T08:40:00Z']], { dedup_key: 'R1:cashbox:0' }),
      ],
      cursors: { R1: '2026-10-22T08:40:00.000Z' },
    };
    const res = await engine.run('frequent', NOW);
    expect(res).toMatchObject({
      rules: ['R1', 'R2', 'R3', 'R4', 'R5'],
      candidates: 2,
      opened: 2,
    });
    const rows = await alerts();
    expect(rows.map((r) => r.notify_skipped)).toEqual(['backfill', null]);
    expect(rows[1]).toMatchObject({
      status: 'new',
      severity: 'warning',
      occurrences: 1,
      explanation_status: 'none',
      title: "Samarqand filiali kassasida smena kamomadi: −120 000 so'm",
      rule_snapshot: {
        key: 'R1',
        severity: 'warning',
        thresholds: { shortage_uzs: 50000, consecutive_negative: 3 },
      },
    });
    expect(rows[1].links).toEqual([
      {
        kind: 'shift_report',
        href: '/payments/shifts/900',
        entity_id: '900',
        primary: true,
      },
      {
        kind: 'branch_cashbox',
        href: '/payments/cash-detail/7?type=branch',
        entity_id: '7',
        primary: false,
      },
    ]);
    // Birinchi so'rov: kursor yo'q → 7 kunlik orqa oyna (§4.3), chegaralar sozlamadan.
    expect(requests[0].since.R1).toBe('2026-10-15T09:00:00.000Z');
    expect(requests[0].thresholds.R1).toEqual({
      shortage_uzs: 50000,
      consecutive_negative: 3,
    });

    // Ikkinchi tick: kursor − 5 daqiqa; birinchi ishdan keyin backfill yo'q.
    reply = {
      candidates: [
        r1([['802', '2026-10-10T10:00:00Z']], { dedup_key: 'R1:cashbox:9' }),
      ],
      cursors: {},
    };
    await engine.run('frequent', new Date('2026-10-22T09:30:00Z'));
    expect(requests[1].since.R1).toBe('2026-10-22T08:35:00.000Z');
    expect((await alerts())[2].notify_skipped).toBeNull();
  });

  it('takror: yangi fact_key → occurrences+1, seen saqlanadi; ayni fakt — hech narsa', async () => {
    await warmUp();
    reply = {
      candidates: [r1([['806', '2026-10-20T15:50:00Z']])],
      cursors: {},
    };
    await engine.run('frequent', NOW);
    await ds.query(`UPDATE ai_schema.ai_advisor_alerts SET status = 'seen'`);
    reply = {
      candidates: [
        r1([
          ['806', '2026-10-20T15:50:00Z'],
          ['812', '2026-10-21T15:50:00Z'],
        ]),
      ],
      cursors: {},
    };
    const res = await engine.run('frequent', NOW);
    expect(res).toMatchObject({ occurred: 1, opened: 0 });
    const [row] = await alerts();
    expect(row).toMatchObject({ status: 'seen', occurrences: 2 });
    expect(new Date(row.last_fact_at as string).toISOString()).toBe(
      '2026-10-21T15:50:00.000Z',
    );
    expect(new Date(row.first_fact_at as string).toISOString()).toBe(
      '2026-10-20T15:50:00.000Z',
    );

    const again = await engine.run('frequent', NOW);
    expect(again).toMatchObject({ occurred: 0, opened: 0, refreshed: 0 });
    expect((await alerts())[0].occurrences).toBe(2);
  });

  it('yopilgandan keyin: ayni fakt — hech narsa; yangi fakt — yangi qator (reopened_from_id)', async () => {
    await warmUp();
    reply = {
      candidates: [r1([['806', '2026-10-21T15:50:00Z']])],
      cursors: {},
    };
    await engine.run('frequent', NOW);
    await ds.query(
      `UPDATE ai_schema.ai_advisor_alerts SET status = 'resolved', resolved_at = now()`,
    );
    await engine.run('frequent', NOW);
    expect(await alerts()).toHaveLength(1);

    reply = {
      candidates: [
        r1([
          ['806', '2026-10-21T15:50:00Z'],
          ['830', '2026-10-22T08:40:00Z'],
        ]),
      ],
      cursors: {},
    };
    const res = await engine.run('frequent', NOW);
    expect(res.opened).toBe(1);
    const rows = await alerts();
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('resolved');
    expect(rows[1]).toMatchObject({
      status: 'new',
      occurrences: 1,
      reopened_from_id: rows[0].id,
    });
  });

  it('qoida o‘chirilgan → so‘ralmaydi; R2 critical sozlamadan, R6 kunlik guruhda kechagi kun', async () => {
    await settings.update(SA, {
      version: 1,
      rules: Object.fromEntries(
        ['R1', 'R2', 'R3', 'R4', 'R5'].map((k) => [k, { enabled: false }]),
      ),
    });
    const res = await engine.run('frequent', NOW);
    expect(res).toMatchObject({ rules: [], candidates: 0 });
    expect(requests).toHaveLength(0); // hech narsa so'ralmadi

    reply = {
      candidates: [
        {
          rule_key: 'R6',
          dedup_key: 'R6:day:2026-10-25',
          fact_keys: [
            {
              fact_key: 'R6:day:2026-10-25',
              fact_at: '2026-10-25T18:59:59.999Z',
            },
          ],
          branch: null,
          subject: { kind: 'system', id: null, name: null },
          headline_amount: -380000,
          facts: {
            period: 'day',
            from: '2026-10-25',
            to: '2026-10-25',
            income: 1,
            expense: 2,
            net: -380000,
          },
          evidence: {
            kind: 'profit_days',
            rows: [],
            total_rows: 0,
            truncated: false,
          },
        },
      ],
      cursors: {},
    };
    // Dushanba 02:30 Toshkent → kecha + o'tgan hafta.
    const monday = new Date('2026-10-25T21:30:00Z');
    const daily = await engine.run('daily', monday);
    expect(requests[requests.length - 1].periods).toEqual({
      days: ['2026-10-25'],
      weeks: ['2026-10-19'],
    });
    expect(daily.opened).toBe(1);
    const [row] = await alerts();
    expect(row).toMatchObject({
      severity: 'critical',
      title: "25.10.2026 kuni sof foyda −380 000 so'm",
    });
    // round-2: system → «Butun tizim»; R6 kursori — kechagi kun oxiri.
    const [subj] = await ds.query<Array<{ subject: { name: string } }>>(
      `SELECT subject FROM ai_schema.ai_advisor_alerts`,
    );
    expect(subj.subject.name).toBe('Butun tizim');
    const [st] = await ds.query<Array<{ cursor_at: Date }>>(
      `SELECT cursor_at FROM ai_schema.ai_advisor_rule_state WHERE rule_key = 'R6'`,
    );
    expect(st.cursor_at.toISOString()).toBe('2026-10-25T18:59:59.999Z');
    // Seshanba ishi o'tkazilsa — chorshanba ikkala kun so'raladi.
    reply = { candidates: [], cursors: {} };
    await engine.run('daily', new Date('2026-10-27T21:30:00Z'));
    expect(requests[requests.length - 1].periods).toEqual({
      days: ['2026-10-26', '2026-10-27'],
    });
  });

  it('round-2 B1: R1 ikki tick — faktlar va dalil saqlanganlarga qo‘shiladi', async () => {
    await warmUp();
    const shift = (id: string, at: string, diff: number) => ({
      shift_id: id,
      closed_at: at,
      difference: diff,
    });
    reply = {
      candidates: [
        r1([['1', '2026-10-21T08:10:00Z']], {
          fact_keys: [
            { fact_key: '1', fact_at: '2026-10-21T08:10:00Z', amount: -120000 },
          ],
          evidence: {
            kind: 'shifts',
            total_rows: 1,
            truncated: false,
            rows: [shift('1', '2026-10-21T08:10:00.000Z', -120000)],
            totals: { count: 1, difference: -120000 },
          },
        }),
      ],
      cursors: { R1: '2026-10-21T08:10:00Z' },
    };
    await engine.run('frequent', new Date('2026-10-21T08:30:00Z'));
    reply = {
      candidates: [
        r1([['3', '2026-10-22T08:10:00Z']], {
          headline_amount: -80000,
          fact_keys: [
            { fact_key: '3', fact_at: '2026-10-22T08:10:00Z', amount: -80000 },
          ],
          facts: {
            ...r1([['3', '2026-10-22T08:10:00Z']]).facts,
            total_difference: -80000,
            last_difference: -80000,
          },
          evidence: {
            kind: 'shifts',
            total_rows: 1,
            truncated: false,
            rows: [shift('3', '2026-10-22T08:10:00.000Z', -80000)],
            totals: { count: 1, difference: -80000 },
          },
        }),
      ],
      cursors: { R1: '2026-10-22T08:10:00Z' },
    };
    await engine.run('frequent', new Date('2026-10-22T08:30:00Z'));
    const [row] = await ds.query<
      Array<{
        occurrences: number;
        facts: Record<string, unknown>;
        evidence: Record<string, unknown>;
        headline_amount: string;
        title: string;
      }>
    >(
      `SELECT occurrences, facts, evidence, headline_amount, title FROM ai_schema.ai_advisor_alerts`,
    );
    expect(row.occurrences).toBe(2);
    expect(row.facts).toMatchObject({
      shifts_count: 2,
      total_difference: -200000,
      last_difference: -80000,
      last_shift_id: '3',
    });
    expect(row.evidence).toMatchObject({
      total_rows: 2,
      totals: { count: 2, difference: -200000 },
    });
    expect(
      (row.evidence.rows as Array<{ shift_id: string }>).map((r) => r.shift_id),
    ).toEqual(['1', '3']);
    expect(Number(row.headline_amount)).toBe(-80000);
    expect(row.title).toBe(
      "Samarqand filiali kassasida smena kamomadi: −80 000 so'm",
    );
  });

  it('round-2 B2: apply xatosi — kursor ushlanadi (partial), keyingi tick qayta o‘qiydi; 5 urinishdan keyin o‘tkaziladi', async () => {
    await warmUp();
    const a = r1([['10', '2026-10-22T08:00:00Z']]);
    const b = r1([['11', '2026-10-22T08:50:00Z']], {
      dedup_key: 'R1:cashbox:9',
    });
    reply = { candidates: [a, b], cursors: { R1: '2026-10-22T08:50:00Z' } };
    // Spy'siz ikkinchi nusxa — haqiqiy apply (ayni baza).
    const real = new AdvisorEngineService(
      ds,
      settings,
      reader as unknown as AdvisorReader,
    );
    const spy = jest
      .spyOn(engine, 'apply')
      .mockImplementation(
        (c: AiAdvisorCandidate, ...rest: [never, never, never]) =>
          c.dedup_key === 'R1:cashbox:7'
            ? Promise.reject(new Error('Connection terminated unexpectedly'))
            : real.apply(c, ...rest),
      );
    const first = await engine.run('frequent', NOW);
    expect(first).toMatchObject({ opened: 1, failed: 1 });
    const state = () =>
      ds
        .query<
          Array<{
            cursor_at: Date;
            last_status: string;
            last_failed: number;
            failures: Record<string, number>;
          }>
        >(
          `SELECT cursor_at, last_status, last_failed, failures FROM ai_schema.ai_advisor_rule_state WHERE rule_key = 'R1'`,
        )
        .then((r) => r[0]);
    let st = await state();
    expect(st).toMatchObject({
      last_status: 'partial',
      last_failed: 1,
      failures: { 'R1:cashbox:7': 1 },
    });
    expect(st.cursor_at.toISOString()).toBe('2026-10-22T08:00:00.000Z');
    // Keyingi tick: since = 08:00 − 5 daq → nomzod qayta keladi, endi o'tadi.
    spy.mockRestore();
    await engine.run('frequent', new Date(NOW.getTime() + 30 * 60_000));
    expect(requests[requests.length - 1].since.R1).toBe(
      '2026-10-22T07:55:00.000Z',
    );
    st = await state();
    expect(st).toMatchObject({
      last_status: 'ok',
      last_failed: 0,
      failures: {},
    });
    expect((await alerts()).map((r) => r.title)).toHaveLength(2);

    // Doimiy xato: 5 urinishdan keyin o'tkaziladi, kursor oldinga siljiydi.
    const c = r1([['20', '2026-10-22T10:00:00Z']], {
      dedup_key: 'R1:cashbox:20',
    });
    reply = { candidates: [c], cursors: { R1: '2026-10-22T10:00:00Z' } };
    jest.spyOn(engine, 'apply').mockRejectedValue(new Error('bad data'));
    for (let i = 0; i < 6; i++)
      await engine.run(
        'frequent',
        new Date(NOW.getTime() + (2 + i) * 3600_000),
      );
    st = await state();
    expect(st.failures).toEqual({});
    expect(st.cursor_at.toISOString()).toBe('2026-10-22T10:00:00.000Z');
    expect(
      await ds.query(
        `SELECT 1 FROM ai_schema.ai_advisor_alerts WHERE dedup_key = 'R1:cashbox:20'`,
      ),
    ).toEqual([]);
    jest.restoreAllMocks();
  });

  it('round-2: finance qoida xatosi (errors) — faqat o‘sha qoida error, boshqasi ok', async () => {
    await warmUp();
    reply = {
      candidates: [r1([['30', '2026-10-22T08:00:00Z']])],
      cursors: { R1: '2026-10-22T08:00:00Z' },
      errors: { R3: 'canceling statement due to statement timeout' },
    };
    const res = await engine.run('frequent', NOW);
    expect(res.opened).toBe(1);
    const rows = await ds.query<
      Array<{
        rule_key: string;
        last_status: string;
        last_error: string | null;
      }>
    >(
      `SELECT rule_key, last_status, last_error FROM ai_schema.ai_advisor_rule_state WHERE rule_key IN ('R1','R3') ORDER BY rule_key`,
    );
    expect(rows).toEqual([
      { rule_key: 'R1', last_status: 'ok', last_error: null },
      {
        rule_key: 'R3',
        last_status: 'error',
        last_error: 'canceling statement due to statement timeout',
      },
    ]);
  });

  it('nomzod qoidasi so‘ralmagan bo‘lsa e’tiborsiz; reader xatosi — holat error, throw', async () => {
    reply = {
      candidates: [
        {
          ...r1([['1', NOW.toISOString()]]),
          rule_key: 'R7',
          dedup_key: 'R7:receipt:1',
        },
      ],
      cursors: {},
    };
    expect((await engine.run('frequent', NOW)).candidates).toBe(0);

    // Buzuq nomzod (sanasi yo'q) boshqalarni to'xtatmaydi.
    reply = {
      candidates: [
        r1([['bad', 'not-a-date']], { dedup_key: 'R1:cashbox:1' }),
        { ...r1([['2', NOW.toISOString()]]), dedup_key: 'x'.repeat(300) },
        r1([['3', NOW.toISOString()]], { dedup_key: 'R1:cashbox:3' }),
      ],
      cursors: {},
    };
    const mixed = await engine.run('frequent', NOW);
    expect(mixed).toMatchObject({ candidates: 3, opened: 1, failed: 1 });

    reader.ruleInputs.mockRejectedValueOnce(new Error('timeout'));
    await expect(engine.run('frequent', NOW)).rejects.toThrow('timeout');
    const state = await ds.query<
      Array<{ rule_key: string; last_status: string; last_error: string }>
    >(
      `SELECT rule_key, last_status, last_error FROM ai_schema.ai_advisor_rule_state ORDER BY rule_key`,
    );
    expect(state.map((r) => r.rule_key)).toEqual([
      'R1',
      'R2',
      'R3',
      'R4',
      'R5',
    ]);
    expect(
      state.every(
        (r) => r.last_status === 'error' && r.last_error === 'timeout',
      ),
    ).toBe(true);
  });

  it('R2 epizod: ayni epizod — ochiq bo‘lsa yangilanadi, yopilgandan keyin jim (Q23); yangi epizod — yangi qator', async () => {
    await warmUp();
    const r2 = (
      fact: string,
      balance: number,
      days: number,
    ): AiAdvisorCandidate => ({
      rule_key: 'R2',
      dedup_key: 'R2:courier:55',
      fact_keys: [{ fact_key: fact, fact_at: '2026-10-18T19:00:00.000Z' }],
      branch: { id: '1', name: 'Toshkent HQ' },
      subject: { kind: 'courier', id: '55', name: 'Jasur Tursunov' },
      headline_amount: balance,
      facts: {
        trigger: 'no_handover',
        courier: { id: '55', name: 'Jasur Tursunov' },
        balance,
        days_without_handover: days,
      },
      evidence: {
        kind: 'courier_days',
        rows: [],
        total_rows: 0,
        truncated: false,
      },
    });
    reply = { candidates: [r2('ep:h:900', 2840000, 4)], cursors: {} };
    await engine.run('frequent', NOW);
    let [row] = await alerts();
    expect(row).toMatchObject({
      severity: 'critical',
      occurrences: 1,
      title: "Jasur Tursunov: 2 840 000 so'm, 4 kundan beri topshirilmagan",
    });

    // Ayni epizod, keyingi kun: occurrences o'zgarmaydi, faktlar yangilanadi.
    reply = { candidates: [r2('ep:h:900', 3100000, 5)], cursors: {} };
    expect(
      await engine.run('frequent', new Date('2026-10-23T09:00:00Z')),
    ).toMatchObject({ refreshed: 1, occurred: 0 });
    [row] = await alerts();
    expect(row).toMatchObject({
      occurrences: 1,
      title: "Jasur Tursunov: 3 100 000 so'm, 5 kundan beri topshirilmagan",
    });
    expect(new Date(row.last_fact_at as string).toISOString()).toBe(
      '2026-10-23T09:00:00.000Z',
    );

    // «Ahamiyatsiz» — davom etayotgan holat qayta ochilmaydi.
    await ds.query(
      `UPDATE ai_schema.ai_advisor_alerts SET status = 'dismissed'`,
    );
    expect(
      await engine.run('frequent', new Date('2026-10-24T09:00:00Z')),
    ).toMatchObject({ opened: 0, refreshed: 0 });
    expect(await alerts()).toHaveLength(1);

    // Topshirishdan keyin yana shart rost — yangi epizod, yangi ogohlantirish.
    reply = { candidates: [r2('ep:h:950', 2500000, 4)], cursors: {} };
    expect(
      await engine.run('frequent', new Date('2026-10-30T09:00:00Z')),
    ).toMatchObject({ opened: 1 });
    const rows = await alerts();
    expect(rows[1]).toMatchObject({
      status: 'new',
      reopened_from_id: rows[0].id,
    });
  });

  it('scheduler: qulf boshqa ulanishda — tick o‘tkaziladi; bo‘sh — ishlaydi va qulfni ochadi', async () => {
    const scheduler = new AdvisorScheduler(ds, engine);
    const holder = ds.createQueryRunner();
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(716000000224)');
      expect(await scheduler.tick('frequent', NOW)).toBeNull();
      await holder.query('SELECT pg_advisory_unlock(716000000224)');
      expect(await scheduler.tick('frequent', NOW)).toMatchObject({
        group: 'frequent',
      });
      // Qulf ochilgan: boshqa ulanish darhol ola oladi.
      const [row] = (await holder.query(
        'SELECT pg_try_advisory_lock(716000000224) AS ok',
      )) as Array<{ ok: boolean }>;
      expect(row.ok).toBe(true);
      await holder.query('SELECT pg_advisory_unlock(716000000224)');
    } finally {
      await holder.release();
    }
  });
});
