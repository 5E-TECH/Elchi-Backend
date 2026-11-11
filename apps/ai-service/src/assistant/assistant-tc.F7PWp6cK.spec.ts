import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AI_ASSISTANT_TOOL_NAMES } from '@app/common';
import {
  DEFAULT_OUT,
  QUESTIONS,
  SseParser,
  TcConfigError,
  applyEvent,
  buildContext,
  buildPeriods,
  decideVerdict,
  diffTruth,
  evaluateItem,
  evaluateQuestion,
  formatAmount,
  isValidYmd,
  newRun,
  numbersMatch,
  parseNumeric,
  parseTcConfig,
  prepareAnswer,
  previousMonth,
  previousWeek,
  renderMarkdown,
  structuralChecks,
  tashkentToday,
  type AssistantRun,
  type ExpectedItem,
  type QuestionReport,
  type QuestionSpec,
} from '../../../../scripts/ai/assistant-tc.lib';

/**
 * F7PWp6cK (BE-D) — 10 savollik qabul TC runner'i
 * (`scripts/ai/assistant-tc.mjs` + `assistant-tc.lib.ts`,
 * hujjat `docs/ai/ASSISTANT_TC_F7PWp6cK.md`):
 *  - sof yordamchilar: davrlar (Toshkent), SSE parser, javobdan raqam
 *    ajratish, dopusk bilan taqqoslash, verdikt;
 *  - savollar ta'rifi: 10 tool'ning hammasi qamrab olingan, haqiqat
 *    endpointlari va query kalitlari openapi'da bor (forbidNonWhitelisted);
 *  - `.mjs` qobig'i: env'siz — tarmoqqa chiqmasdan exit 2; soxta server bilan
 *    to'liq yo'l (login → access/me → haqiqat → SSE → audit) va parol/token
 *    hech qayerga chiqmasligi.
 */

const REPO = join(__dirname, '../../../..');
const RUNNER = join(REPO, 'scripts/ai/assistant-tc.mjs');

function q(n: number): QuestionSpec {
  return QUESTIONS.find((x) => x.n === n)!;
}

function money(
  key: string,
  value: number,
  labels: ExpectedItem['labels'],
  extra: Partial<ExpectedItem> = {},
): ExpectedItem {
  return { key, label: key, kind: 'money', value, labels, ...extra };
}

function count(
  key: string,
  value: number,
  labels: ExpectedItem['labels'],
  extra: Partial<ExpectedItem> = {},
): ExpectedItem {
  return { key, label: key, kind: 'count', value, labels, ...extra };
}

function sse(events: Array<Record<string, unknown>>): string {
  return events
    .map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
}

function runFrom(events: Array<Record<string, unknown>>): AssistantRun {
  const run = newRun();
  const parser = new SseParser();
  for (const ev of parser.feed(sse(events))) applyEvent(run, ev);
  return run;
}

// ─── Q1 fixture (hujjatdagi retsept bilan) ─────────────────────────────────

const FB = {
  statusCode: 200,
  message: 'Financial balance infos',
  data: {
    currentSituation: 45_000_000,
    main: {
      balance: 12_345_678,
      balance_cash: 10_000_000,
      balance_card: 2_345_678,
    },
    chain: { chainReceivable: 40_000_000, providerReceivable: 2_654_322 },
    markets: { marketPayable: 10_000_000 },
    couriers: { couriersTotalBalanse: 0, allCourierCashboxes: [] },
    branches: { branchReceivable: 0, items: [], cashExceedingPayable: [] },
  },
};
const CARDS = {
  statusCode: 200,
  data: {
    cards: [
      {
        name: 'Asosiy karta',
        last4: null,
        balance: 1_345_678,
        is_default: true,
      },
      { name: 'Humo biznes', last4: '4417', balance: 1_000_000 },
    ],
    total_card: 2_345_678,
    in_sync: true,
  },
};
const Q1_ANSWER = [
  "Asosiy kassada hozir **12 345 678 so'm** bor: naqd — 10 000 000 so'm, kartada — 2 345 678 so'm.",
  '',
  '| Karta | Qoldiq |',
  '|---|---|',
  "| Asosiy karta | 1 345 678 so'm |",
  "| Humo biznes (•••• 4417) | 1 000 000 so'm |",
  '',
  "Kompaniyaning umumiy holati: 45 000 000 so'm.",
  '',
  'Manba: get_cash_position (joriy holat, 3 yozuv).',
].join('\n');

function q1Events(answer: string) {
  return [
    {
      type: 'meta',
      conversation_id: '77',
      message_id: '501',
      model: 'm',
      max_steps: 6,
    },
    { type: 'step', step: 1 },
    {
      type: 'tool_call',
      step: 1,
      id: 't1',
      tool: 'get_cash_position',
      input: {},
    },
    {
      type: 'tool_result',
      step: 1,
      id: 't1',
      tool: 'get_cash_position',
      ok: true,
      records: 3,
      period: null,
      truncated: false,
    },
    {
      type: 'done',
      conversation_id: '77',
      message_id: '502',
      answer,
      stop: 'end_turn',
      steps: 2,
      sources: [
        {
          tool: 'get_cash_position',
          period: null,
          records: 3,
          truncated: false,
          ok: true,
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: 0.0123,
      },
      limits: { daily_limit: 100, used_today: 1, remaining_today: 99 },
    },
  ];
}

describe('F7PWp6cK TC — sanalar (Asia/Tashkent)', () => {
  it('Toshkent sanasi UTC+5 bo‘yicha (yarim tun chegarasi)', () => {
    expect(tashkentToday(new Date('2026-11-10T18:59:59Z'))).toBe('2026-11-10');
    expect(tashkentToday(new Date('2026-11-10T19:00:00Z'))).toBe('2026-11-11');
  });

  it('T=2026-11-11 (chorshanba): hujjatdagi ishlangan misol', () => {
    expect(buildPeriods('2026-11-11')).toEqual({
      today: '2026-11-11',
      m1: { from: '2026-10-01', to: '2026-10-31' },
      m0: { from: '2026-09-01', to: '2026-09-30' },
      m0m1: { from: '2026-09-01', to: '2026-10-31' },
      week: { from: '2026-11-02', to: '2026-11-08' },
      weekBefore: { from: '2026-10-26', to: '2026-11-01' },
      currentMonth: { from: '2026-11-01', to: '2026-11-11' },
    });
  });

  it('o‘tgan hafta: dushanba va yakshanba chetlari; o‘tgan oy: yanvar va kabisa fevral', () => {
    expect(previousWeek('2026-11-09')).toEqual({
      from: '2026-11-02',
      to: '2026-11-08',
    });
    expect(previousWeek('2026-11-08')).toEqual({
      from: '2026-10-26',
      to: '2026-11-01',
    });
    expect(previousMonth('2027-01-15')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(previousMonth('2028-03-01')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(isValidYmd('2026-02-29')).toBe(false);
    expect(isValidYmd('2028-02-29')).toBe(true);
  });
});

describe('F7PWp6cK TC — SSE parser', () => {
  it('bo‘lak chegarasida bo‘lingan qatorlar, CRLF, `: ping`, ko‘p qatorli data', () => {
    const p = new SseParser();
    const out = [
      ...p.feed('event: meta\r'),
      ...p.feed(
        '\ndata: {"type":"meta","conversation_id":"5"}\r\n\r\n: ping\n\n',
      ),
      ...p.feed('event: delta\ndata: {"type":"delta",\ndata: "text":"a"}\n'),
      ...p.feed('\nevent: step\n\n'),
    ];
    expect(out.map((e) => e.event)).toEqual(['meta', 'delta']);
    expect(out[0].json).toEqual({ type: 'meta', conversation_id: '5' });
    expect(out[1].data).toBe('{"type":"delta",\n"text":"a"}');
  });

  it('tugallanmagan oxirgi hodisa tashlanadi; done/error — yakuniy', () => {
    const p = new SseParser();
    expect(p.feed('event: done\ndata: {"type":"done","answer":"x"')).toEqual(
      [],
    );
    const run = newRun();
    const [err] = new SseParser().feed(
      'event: error\ndata: {"type":"error","code":"busy","message":"band"}\n\n',
    );
    expect(applyEvent(run, err)).toBe(true);
    expect(run.error).toEqual({ code: 'busy', message: 'band' });
  });

  it('meta → tool_call → tool_result → done yig‘iladi', () => {
    const run = runFrom(q1Events('Javob'));
    expect(run.conversationId).toBe('77');
    expect(run.toolCalls).toEqual([
      { step: 1, id: 't1', tool: 'get_cash_position', input: {} },
    ]);
    expect(run.toolResults[0]).toMatchObject({
      tool: 'get_cash_position',
      ok: true,
      records: 3,
      period: null,
    });
    expect(run.done).toMatchObject({
      answer: 'Javob',
      stop: 'end_turn',
      steps: 2,
    });
    expect(run.done!.sources).toHaveLength(1);
  });
});

describe('F7PWp6cK TC — javobdan raqam ajratish', () => {
  it("so'm formatlari: bo'shliq/NBSP, vergul, nuqta, foiz, mln/ming, «ta»", () => {
    const p = prepareAnswer(
      "A 1 250 000 so'm; B 1\u00A0250\u202F000; C 1,250,000; D 1.250.000 so'm; E 12,5%; F -3,4 %; G 1,2 mln so'm; H 450 ming; I 45 ta; J 1 250 000,50",
    );
    expect(p.tokens.map((t) => t.value)).toEqual([
      1_250_000, 1_250_000, 1_250_000, 1_250_000, 12.5, -3.4, 1_200_000,
      450_000, 45, 1_250_000.5,
    ]);
    const [a, , , , e, , g, , i] = p.tokens;
    expect(a.currency).toBe(true);
    expect(e.percent).toBe(true);
    expect(g).toMatchObject({ approx: true, precision: 50_000 });
    expect(i.countUnit).toBe(true);
  });

  it('sana, vaqt, ro‘yxat raqami, id va karta oxiri raqam deb olinmaydi', () => {
    const p = prepareAnswer(
      [
        '1. Davr 2026-10-01 — 2026-10-31 (01.10.2026, 10.2026, 2026-10)',
        '2) 1-oktabr, oktabr 2026, 2026-yil, 05:00, 02.11–08.11',
        'Kategoriya #12, karta •••• 4417, top-3, **** 5521',
      ].join('\n'),
    );
    expect(p.tokens).toEqual([]);
  });

  it('parseNumeric va numbersMatch (dopusk, ishorasiz, aniqlik)', () => {
    expect(parseNumeric('1 250 000,5')).toEqual({
      value: 1_250_000.5,
      decimals: 1,
    });
    expect(parseNumeric('12,5')).toEqual({ value: 12.5, decimals: 1 });
    expect(numbersMatch(100, 101, { kind: 'money' })).toBe(true);
    expect(numbersMatch(100, 102, { kind: 'money' })).toBe(false);
    expect(numbersMatch(45, 46, { kind: 'count' })).toBe(false);
    expect(numbersMatch(12.46, 12.5, { kind: 'percent' })).toBe(true);
    expect(
      numbersMatch(-250_000, 250_000, { kind: 'money', absOk: true }),
    ).toBe(true);
    expect(
      numbersMatch(1_234_567, 1_200_000, { kind: 'money', precision: 50_000 }),
    ).toBe(true);
    expect(formatAmount(-1_250_000.5)).toBe('-1 250 000,5');
  });
});

describe('F7PWp6cK TC — kutilgan qiymatni baholash', () => {
  const line =
    "Kirim: 12 000 000 so'm (45 ta), chiqim: 8 000 000 so'm (30 ta). Sof farq: 4 000 000 so'm.";

  it('yorliq yonidagi eng yaqin raqam (gap bo‘lagi ichida) — match', () => {
    const p = prepareAnswer(line);
    expect(evaluateItem(p, money('E1', 12_000_000, [/kirim/])).status).toBe(
      'match',
    );
    expect(evaluateItem(p, money('E2', 8_000_000, [/chiqim/])).status).toBe(
      'match',
    );
    expect(evaluateItem(p, count('E4', 45, [/kirim/])).status).toBe('match');
    expect(evaluateItem(p, count('E5', 30, [/chiqim/])).status).toBe('match');
    expect(evaluateItem(p, money('E3', 4_000_000, [/\bsof\b/])).status).toBe(
      'match',
    );
  });

  it('noto‘g‘ri raqam va qiymat javobda yo‘q — mismatch (tuzoq izohi bilan)', () => {
    const p = prepareAnswer("Qo'lda xarajatlar jami: 9 000 000 so'm.");
    const r = evaluateItem(
      p,
      money('M', 3_000_000, [/qo'lda/], {
        traps: [{ value: 9_000_000, note: 'BARCHA chiqim' }],
      }),
    );
    expect(r).toMatchObject({
      status: 'mismatch',
      assistant: 9_000_000,
      note: 'BARCHA chiqim',
    });
  });

  it('qiymat bor, lekin yorliqsiz — unlabeled; umuman yo‘q — missing; yonida boshqasi — ambiguous', () => {
    const p = prepareAnswer(
      "Natija: 5 000 000 so'm. Kuryerlar: 7 000 000 so'm, 5 000 000 so'm emas.",
    );
    expect(evaluateItem(p, money('X', 5_000_000, [/filial/])).status).toBe(
      'unlabeled',
    );
    expect(evaluateItem(p, money('Y', 1_000, [/filial/])).status).toBe(
      'missing',
    );
    expect(
      evaluateItem(
        prepareAnswer("Kuryerlar 7 000 000 so'm va 5 000 000 so'm"),
        money('K', 5_000_000, [/kuryer/]),
      ).status,
    ).toBe('ambiguous');
  });

  it('nol so‘z bilan («bo‘lmagan»), ishorasiz kamomad, jadval katagi, qisqartirilgan yozuv', () => {
    expect(
      evaluateItem(
        prepareAnswer("Kartada kamomad bo'lmagan."),
        money('SK', 0, [[/kamomad/, /karta/]], { absOk: true }),
      ).status,
    ).toBe('match');
    expect(
      evaluateItem(
        prepareAnswer("Naqd kamomad: −250 000 so'm."),
        money('SC', -250_000, [/naqd/], { absOk: true }),
      ).status,
    ).toBe('match');
    const table = prepareAnswer(
      [
        '| Kuryer | Jami | Naqd | Karta |',
        '|---|---|---|---|',
        '| Ali Valiyev | 1 500 000 | 1 000 000 | 500 000 |',
      ].join('\n'),
    );
    expect(
      evaluateItem(
        table,
        money('c', 500_000, [], {
          table: [{ row: /ali valiyev/, col: /karta/ }],
        }),
      ).status,
    ).toBe('match');
    expect(
      evaluateItem(
        prepareAnswer("Foyda 1,2 mln so'm."),
        money('P', 1_234_567, [/foyda/]),
      ).status,
    ).toBe('approx');
  });

  it('ha/yo‘q, «yo‘lda» raqamsiz rad etish, nom va tartib', () => {
    const yes: ExpectedItem = {
      key: 'y',
      label: 'y',
      kind: 'yesno',
      value: false,
      yes: [/\byetadi\b/, /\byetarli\b/],
      no: [/yetmaydi/, /yetarli emas/],
    };
    expect(
      evaluateItem(
        prepareAnswer('Kassa yetarli emas, 2 000 000 so‘m yetmaydi.'),
        yes,
      ).status,
    ).toBe('match');
    expect(evaluateItem(prepareAnswer('Kassa yetadi.'), yes).status).toBe(
      'mismatch',
    );
    const transit: ExpectedItem = {
      key: 't',
      label: 't',
      kind: 'absent',
      value: null,
      labels: [/yo'l(?:da|dagi)/],
      refusal: [/yo'q/],
      allowed: [120],
    };
    expect(
      evaluateItem(
        prepareAnswer(
          "Hozir yo'ldagi buyurtmalar soni bo'yicha ma'lumot yo'q.",
        ),
        transit,
      ).status,
    ).toBe('match');
    expect(
      evaluateItem(
        prepareAnswer("Hozir yo'lda taxminan 37 ta buyurtma bor."),
        transit,
      ),
    ).toMatchObject({ status: 'mismatch', assistant: 37 });
    expect(
      evaluateItem(
        prepareAnswer("Yo'ldagi ma'lumot yo'q, 120 ta qabul qilingan."),
        transit,
      ).status,
    ).toBe('match');
    const p = prepareAnswer('1) «Ali  Valiyev» 2) Vali Aliyev');
    expect(
      evaluateItem(p, {
        key: 'n',
        label: 'n',
        kind: 'name',
        value: 'Ali Valiyev',
      }).status,
    ).toBe('match');
    expect(
      evaluateItem(p, {
        key: 'o',
        label: 'o',
        kind: 'order',
        value: ['Ali Valiyev', 'Vali Aliyev'],
      }).status,
    ).toBe('match');
    expect(
      evaluateItem(p, {
        key: 'o',
        label: 'o',
        kind: 'order',
        value: ['Vali Aliyev', 'Ali Valiyev'],
      }).status,
    ).toBe('ambiguous');
  });

  it('verdikt: mismatch → FAIL; review → NEEDS_REVIEW; drift/blocked/error ustun', () => {
    const ok = {
      key: 'a',
      label: 'a',
      kind: 'money' as const,
      expected: 1,
      assistant: 1,
      status: 'match' as const,
    };
    expect(decideVerdict({ items: [ok], checks: [] })).toBe('PASS');
    expect(
      decideVerdict({ items: [{ ...ok, status: 'mismatch' }], checks: [] }),
    ).toBe('FAIL');
    expect(
      decideVerdict({ items: [{ ...ok, status: 'unlabeled' }], checks: [] }),
    ).toBe('NEEDS_REVIEW');
    expect(
      decideVerdict({
        items: [{ ...ok, status: 'mismatch', optional: true }, ok],
        checks: [],
      }),
    ).toBe('PASS');
    expect(
      decideVerdict({
        items: [ok],
        checks: [{ id: 'm', ok: false, severity: 'review', note: '' }],
      }),
    ).toBe('NEEDS_REVIEW');
    expect(
      decideVerdict({ items: [ok], checks: [], drift: ['A: 1 → 2'] }),
    ).toBe('DRIFT');
    expect(decideVerdict({ items: [ok], checks: [], blocked: 'x' })).toBe(
      'BLOCKED',
    );
    expect(decideVerdict({ items: [ok], checks: [], error: 'x' })).toBe(
      'ERROR',
    );
  });
});

describe('F7PWp6cK TC — savollar ta’rifi', () => {
  const openapi = JSON.parse(
    readFileSync(join(REPO, 'docs/frontend/openapi.json'), 'utf8'),
  ) as {
    paths: Record<
      string,
      Record<string, { parameters?: Array<{ name: string; in: string }> }>
    >;
  };
  const ctx = buildContext('2026-11-11', false);

  it('10 savol, 10 tool ning hammasi qamrab olingan', () => {
    expect(QUESTIONS.map((x) => x.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const used = new Set(QUESTIONS.flatMap((x) => x.requiredTools));
    expect([...used].sort()).toEqual([...AI_ASSISTANT_TOOL_NAMES].sort());
  });

  it('savol matnlari TC hujjatidagi bilan aynan bir xil', () => {
    const flat = (s: string) => s.replace(/\s+/g, ' ');
    const doc = flat(
      readFileSync(join(REPO, 'docs/ai/ASSISTANT_TC_F7PWp6cK.md'), 'utf8'),
    );
    for (const spec of QUESTIONS) {
      expect([spec.n, doc.includes(`«${flat(spec.text(ctx))}»`)]).toEqual([
        spec.n,
        true,
      ]);
    }
  });

  it('haqiqat endpointlari GET sifatida openapi’da bor, query kalitlari ruxsat etilgan', () => {
    for (const spec of QUESTIONS) {
      for (const req of spec.reads(ctx, spec.defaultPeriod(ctx))) {
        const op = openapi.paths[req.path]?.get;
        expect([spec.n, req.path, !!op]).toEqual([spec.n, req.path, true]);
        const names = new Set(
          (op.parameters ?? [])
            .filter((p) => p.in === 'query')
            .map((p) => p.name),
        );
        for (const key of Object.keys(req.query ?? {})) {
          expect([spec.n, req.path, key, names.has(key)]).toEqual([
            spec.n,
            req.path,
            key,
            true,
          ]);
        }
      }
    }
  });

  it('Q1: to‘g‘ri javob — PASS; boshqa «umumiy holat» — FAIL; holat o‘zgarsa — DRIFT', () => {
    const truth = q(1).truth({ fb: FB, cards: CARDS }, ctx, null);
    expect(truth.notes).toEqual([]);
    const pass = evaluateQuestion(
      q(1),
      ctx,
      runFrom(q1Events(Q1_ANSWER)),
      truth,
      null,
    );
    expect(pass.items.filter((i) => i.status !== 'match')).toEqual([]);
    expect(pass.verdict).toBe('PASS');
    const wrong = evaluateQuestion(
      q(1),
      ctx,
      runFrom(
        q1Events(Q1_ANSWER.replace("45 000 000 so'm", "44 000 000 so'm")),
      ),
      truth,
      null,
    );
    expect(wrong.verdict).toBe('FAIL');
    expect(wrong.items.find((i) => i.key === 'S')).toMatchObject({
      status: 'mismatch',
      assistant: 44_000_000,
    });
    const moved = q(1).truth(
      {
        fb: { data: { ...FB.data, currentSituation: 45_000_100 } },
        cards: CARDS,
      },
      ctx,
      null,
    );
    const drift = diffTruth(truth, moved);
    expect(drift).toEqual(['S: 45 000 000 → 45 000 100']);
    expect(
      evaluateQuestion(q(1), ctx, runFrom(q1Events(Q1_ANSWER)), moved, drift)
        .verdict,
    ).toBe('DRIFT');
  });

  it('davr tekshiruvi: tool boshqa davr ishlatsa — fail; «Manba:» yo‘q — review', () => {
    const events = [
      {
        type: 'tool_result',
        step: 1,
        id: 'a',
        tool: 'get_cashbox_history',
        ok: true,
        records: 3,
        period: { from: '2026-10-05', to: '2026-11-04' },
        truncated: false,
      },
      {
        type: 'done',
        answer: 'Kirim 1 so‘m',
        stop: 'end_turn',
        steps: 1,
        sources: [
          {
            tool: 'get_cashbox_history',
            period: { from: '2026-10-05', to: '2026-11-04' },
            records: 3,
            truncated: false,
            ok: true,
          },
        ],
        usage: {},
        limits: {},
      },
    ];
    const checks = structuralChecks(
      q(5),
      ctx,
      runFrom(events),
      prepareAnswer('Kirim 1 so‘m'),
    );
    expect(
      checks.find((c) => c.id === 'period:get_cashbox_history'),
    ).toMatchObject({ ok: false, severity: 'fail' });
    expect(checks.find((c) => c.id === 'manba')).toMatchObject({
      ok: false,
      severity: 'review',
    });
  });

  it('Q6: D1 tuzatishi serverda yo‘q bo‘lsa (YYYY-MM-DD ≠ ISO chegaralar) — BLOCKED', () => {
    const p = q(6).defaultPeriod(ctx)!;
    expect(q(6).reads(ctx, p)[1].query).toMatchObject({
      from_date: '2026-11-02T00:00:00.000+05:00',
      to_date: '2026-11-08T23:59:59.999+05:00',
    });
    const rows = [
      {
        status: 'closed',
        discrepancy_cash: -1000,
        discrepancy_card: 0,
        close_reason: 'auto',
      },
      {
        status: 'closed',
        discrepancy_cash: 0,
        discrepancy_card: -500,
        close_reason: null,
      },
      {
        status: 'open',
        discrepancy_cash: null,
        discrepancy_card: null,
        close_reason: null,
      },
    ];
    const shifts = { data: { items: rows, pagination: { total: 3 } } };
    const fixed = q(6).truth(
      { shifts, shiftsIso: { data: { items: [], pagination: { total: 3 } } } },
      ctx,
      p,
    );
    expect(fixed.blocked).toBeUndefined();
    expect(
      Object.fromEntries(fixed.items.map((i) => [i.key, i.value])),
    ).toEqual({ N: 3, SC: -1000, SK: -500, D: 2, AUTO: 1 });
    const legacy = q(6).truth(
      { shifts, shiftsIso: { data: { items: [], pagination: { total: 5 } } } },
      ctx,
      p,
    );
    expect(legacy.blocked).toMatch(/D1/);
  });

  it('Q8: oylar bandi, foiz va yo‘nalish; Q9: «yo‘lda» uchun raqam — FAIL', () => {
    const t8 = q(8).truth(
      {
        revenue: {
          data: {
            data: [
              {
                period: 'M:2026-09',
                ordersCount: 400,
                revenue: 50_000_000,
                profit: 8_000_000,
              },
              {
                period: 'M:2026-10',
                ordersCount: 450,
                revenue: 60_000_000,
                profit: 9_000_000,
              },
            ],
            summary: { totalRevenue: 110_000_000 },
          },
        },
      },
      ctx,
      null,
    );
    const v8 = Object.fromEntries(t8.items.map((i) => [i.key, i.value]));
    expect(v8).toMatchObject({
      R0: 50_000_000,
      P0: 8_000_000,
      O0: 400,
      R1: 60_000_000,
      P1: 9_000_000,
      O1: 450,
      dP: 12.5,
      dP_dir: true,
    });
    const answer8 = [
      '| Oy | Tushum | Sof foyda | Sotilgan buyurtmalar |',
      '|---|---|---|---|',
      "| Sentabr | 50 000 000 so'm | 8 000 000 so'm | 400 |",
      "| Oktabr | 60 000 000 so'm | 9 000 000 so'm | 450 |",
      '',
      "Oktabr foydasi sentabrga nisbatan 12,5% ga o'sdi.",
      '',
      'Manba: get_revenue_profit (2026-09-01 — 2026-10-31, monthly).',
    ].join('\n');
    const period = { from: '2026-09-01', to: '2026-10-31' };
    const run8 = runFrom([
      {
        type: 'tool_result',
        step: 1,
        id: 'a',
        tool: 'get_revenue_profit',
        ok: true,
        records: 2,
        period,
        truncated: false,
      },
      {
        type: 'done',
        answer: answer8,
        stop: 'end_turn',
        steps: 2,
        sources: [
          {
            tool: 'get_revenue_profit',
            period,
            records: 2,
            truncated: false,
            ok: true,
          },
        ],
        usage: {},
        limits: {},
      },
    ]);
    expect(evaluateQuestion(q(8), ctx, run8, t8, null).verdict).toBe('PASS');

    const week = ctx.periods.week;
    const t9 = q(9).truth(
      {
        dash: {
          data: {
            orders: { acceptedCount: 120, soldAndPaid: 90, cancelled: 10 },
            previous: {
              from: '2026-10-26',
              to: '2026-11-01',
              acceptedCount: 100,
              soldAndPaid: 80,
              cancelled: 12,
            },
            topMarkets: [
              {
                market_id: '5',
                market_name: 'Bahor Savdo',
                total_orders: 40,
                successful_orders: 38,
                success_rate: 95,
              },
            ],
          },
        },
        dashPrev: {
          data: {
            orders: { acceptedCount: 100, soldAndPaid: 80, cancelled: 12 },
          },
        },
      },
      ctx,
      week,
    );
    expect(t9.notes).toEqual([]);
    const base9 =
      "O'tgan hafta 120 ta buyurtma qabul qilindi (oldingi haftada 100 ta, +20), 90 tasi sotildi (oldingi haftada 80 ta, +10), 10 tasi bekor qilindi (oldingi haftada 12 ta, -2).\n" +
      "Muvaffaqiyat ulushi bo'yicha eng yaxshi market — «Bahor Savdo» (95%).\n";
    const run9 = (text: string) =>
      runFrom([
        {
          type: 'tool_result',
          step: 1,
          id: 'a',
          tool: 'get_order_flow',
          ok: true,
          records: 120,
          period: week,
          truncated: false,
        },
        {
          type: 'done',
          answer: text,
          stop: 'end_turn',
          steps: 2,
          sources: [
            {
              tool: 'get_order_flow',
              period: week,
              records: 120,
              truncated: false,
              ok: true,
            },
          ],
          usage: {},
          limits: {},
        },
      ]);
    const refused = evaluateQuestion(
      q(9),
      ctx,
      run9(
        `${base9}Hozir yo'ldagi buyurtmalar soni bo'yicha ma'lumot yo'q.\n\nManba: get_order_flow.`,
      ),
      t9,
      null,
    );
    expect(refused.items.filter((i) => i.status !== 'match')).toEqual([]);
    expect(refused.verdict).toBe('PASS');
    const fabricated = evaluateQuestion(
      q(9),
      ctx,
      run9(
        `${base9}Hozir yo'lda 20 ta buyurtma bor.\n\nManba: get_order_flow.`,
      ),
      t9,
      null,
    );
    expect(fabricated.verdict).toBe('FAIL');
    expect(fabricated.items.find((i) => i.key === 'in_transit')).toMatchObject({
      status: 'mismatch',
      assistant: 20,
    });
  });

  it('done kelmasa — ERROR; hisobot Markdown jadvali', () => {
    const run = newRun();
    run.error = { code: 'network', message: 'uzildi' };
    const ev = evaluateQuestion(
      q(10),
      ctx,
      run,
      { items: [], notes: [] },
      null,
    );
    expect(ev).toMatchObject({ verdict: 'ERROR', reason: 'network: uzildi' });
    const report: QuestionReport = {
      n: 10,
      title: 'Cheklar',
      question: 'savol',
      verdict: 'ERROR',
      reason: ev.reason,
      conversation_id: '9',
      message_id: null,
      audit_path: '/ai/assistant/conversations/9',
      expected_period: ctx.periods.currentMonth,
      tool_period: null,
      tool_calls: [],
      tool_results: [],
      sources: [],
      answer: null,
      stop: null,
      cost_usd: 0.01,
      items: [],
      checks: [],
      notes: [],
      drift: null,
    };
    const md = renderMarkdown(
      { baseUrl: 'https://x', startedAt: 's', today: '2026-11-11' },
      [report],
    );
    expect(md).toContain(
      '| # | Savol | Kutilgan | Assistent | Verdikt | Izoh |',
    );
    expect(md).toContain('| 10 | Cheklar | ');
    expect(md).toContain('`GET /ai/assistant/conversations/9`');
  });
});

// ─── Review topilmalari (F1–F13): har biri tuzatishsiz yiqiladi ───────────

/** Bitta tool natijasi + `done` (davr va truncated bilan). */
function periodRun(
  tool: string,
  period: { from: string; to: string } | null,
  answer: string,
  opts: {
    records?: number;
    truncated?: boolean;
    calls?: Array<Record<string, unknown>>;
  } = {},
): AssistantRun {
  const records = opts.records ?? 10;
  const truncated = opts.truncated ?? false;
  return runFrom([
    ...(opts.calls ?? [{}]).map((input, i) => ({
      type: 'tool_call',
      step: 1,
      id: `c${i}`,
      tool,
      input,
    })),
    {
      type: 'tool_result',
      step: 1,
      id: 'c0',
      tool,
      ok: true,
      records,
      period,
      truncated,
    },
    {
      type: 'done',
      answer,
      stop: 'end_turn',
      steps: 2,
      sources: [{ tool, period, records, truncated, ok: true }],
      usage: {},
      limits: {},
    },
  ]);
}

describe('F7PWp6cK TC — review topilmalari', () => {
  const ctx = buildContext('2026-11-11', false);
  const m1 = ctx.periods.m1;
  const week = ctx.periods.week;

  // Q5 haqiqati: sof farq +25 000 000.
  const q5Truth = () =>
    q(5).truth(
      {
        all: {
          data: {
            totals: {
              income: 40_000_000,
              expense: 15_000_000,
              net: 25_000_000,
              income_count: 450,
              expense_count: 120,
            },
          },
        },
        courier: {
          data: { totals: { income: 30_000_000, income_count: 380 } },
        },
      },
      ctx,
      m1,
    );
  const q5Answer = (net: string) =>
    "O'tgan oyda asosiy kassaga kirim: 40 000 000 so'm (450 ta), chiqim: 15 000 000 so'm (120 ta). " +
    `Sof farq: ${net} so'm. Kuryerlar topshirgan to'lovlar: 30 000 000 so'm (380 ta).\n\n` +
    'Manba: get_cashbox_history (2026-10-01 — 2026-10-31).';

  // Q9 haqiqati (C1 − C0 = −2, A0 − S0 − C0 = 8).
  const t9 = () =>
    q(9).truth(
      {
        dash: {
          data: {
            orders: { acceptedCount: 120, soldAndPaid: 90, cancelled: 10 },
            previous: {
              from: '2026-10-26',
              to: '2026-11-01',
              acceptedCount: 100,
              soldAndPaid: 80,
              cancelled: 12,
            },
            topMarkets: [
              {
                market_id: '5',
                market_name: 'Bahor Savdo',
                total_orders: 40,
                successful_orders: 38,
                success_rate: 95,
              },
            ],
          },
        },
        dashPrev: {
          data: {
            orders: { acceptedCount: 100, soldAndPaid: 80, cancelled: 12 },
          },
        },
      },
      ctx,
      week,
    );
  const base9 = (dc = '-2') =>
    "O'tgan hafta 120 ta buyurtma qabul qilindi (oldingi haftada 100 ta, +20), 90 tasi sotildi (oldingi haftada 80 ta, +10), " +
    `10 tasi bekor qilindi (oldingi haftada 12 ta, ${dc}).\n` +
    "Muvaffaqiyat ulushi bo'yicha eng yaxshi market — «Bahor Savdo» (95%).\n";
  const ask9 = (text: string) =>
    evaluateQuestion(
      q(9),
      ctx,
      periodRun('get_order_flow', week, `${text}\n\nManba: get_order_flow.`, {
        records: 120,
      }),
      t9(),
      null,
    );

  it('F1: Q7 da «Shu oy» yo‘q — P&L davri o‘tgan oy deb aniq aytiladi (Q10 «shu oy» = joriy oy)', () => {
    const text = q(7).text(ctx);
    // Q10 period_stated shu iboralarni JORIY oy deb o'qiydi.
    expect(text).not.toMatch(/shu oy|joriy oy|bu oy/i);
    expect(text).toContain("O'tgan oy uchun moliyaviy daftar (P&L)");
    expect(q(7).text(buildContext('2026-10-15', true))).toContain(
      'Shu davrda moliyaviy daftar (P&L)',
    );
  });

  it('F8: ishorali farq (Q5 E3, Q9 dC) — ishora yozilgan bo‘lsa kutilganga teng bo‘lishi shart', () => {
    const truth = q5Truth();
    const ask5 = (net: string) =>
      evaluateQuestion(
        q(5),
        ctx,
        periodRun('get_cashbox_history', m1, q5Answer(net), { records: 570 }),
        truth,
        null,
      );
    expect(ask5('25 000 000').verdict).toBe('PASS');
    expect(ask5('+25 000 000').verdict).toBe('PASS');
    const reversed = ask5('-25 000 000');
    expect(reversed.verdict).toBe('FAIL');
    expect(reversed.items.find((i) => i.key === 'E3')).toMatchObject({
      status: 'mismatch',
    });
    // Q9: bekor qilinganlar 12 → 10 (−2); «+2» — yo'nalish teskari.
    const refuse9 = "Hozir yo'ldagi buyurtmalar soni bo'yicha ma'lumot yo'q.";
    expect(ask9(`${base9('-2')}${refuse9}`).verdict).toBe('PASS');
    const up = ask9(`${base9('+2')}${refuse9}`);
    expect(up.verdict).toBe('FAIL');
    expect(up.items.find((i) => i.key === 'dC')).toMatchObject({
      status: 'mismatch',
    });
    // Q7 L3: daftar sof o'zgarishi −3 000 000 — «+3 000 000» teskari.
    const L3 = q(7)
      .truth(
        {
          manualRows: {
            data: { items: [{ expense_category_id: '1', amount: 100 }] },
          },
          categories: { data: { items: [{ id: '1', name: 'Ijara' }] } },
          manualDaily: { data: { totals: { expense: 100, expense_count: 1 } } },
          allDaily: { data: { totals: { expense: 500 } } },
          ledger: {
            data: {
              summary: {
                totalPositive: 10_000_000,
                totalNegative: -13_000_000,
                netChange: -3_000_000,
              },
            },
          },
        },
        ctx,
        m1,
      )
      .items.find((i) => i.key === 'L3')!;
    const l3 = (text: string) => evaluateItem(prepareAnswer(text), L3).status;
    expect(l3("Sof o'zgarish: -3 000 000 so'm.")).toBe('match');
    expect(l3("Sof o'zgarish: 3 000 000 so'mga kamaydi.")).toBe('match');
    expect(l3("Sof o'zgarish: +3 000 000 so'm.")).toBe('mismatch');
    // Ishorasiz yozuv («2 taga kam») — absOk saqlanadi.
    expect(
      evaluateItem(
        prepareAnswer('Bekor qilinganlar: 2 taga kam.'),
        count('dC', -2, [[/bekor/, /kam/]], {
          absOk: true,
          signedIfExplicit: true,
        }),
      ).status,
    ).toBe('match');
  });

  it('F10: tool davri xato + shu davr haqiqati BLOCKED (N > 200) — FAIL ustun, sabab izohda', () => {
    const truth = q(6).truth(
      {
        shifts: { data: { items: [], pagination: { total: 250 } } },
        shiftsIso: { data: { items: [], pagination: { total: 250 } } },
      },
      ctx,
      m1,
    );
    expect(truth.blocked).toMatch(/250 ta \(> 200\)/);
    const ev = evaluateQuestion(
      q(6),
      ctx,
      periodRun('get_shift_summaries', m1, 'Smenalar: 250 ta.\n\nManba: x'),
      truth,
      null,
    );
    expect(ev.verdict).toBe('FAIL');
    expect(
      ev.checks.find((c) => c.id === 'period:get_shift_summaries'),
    ).toMatchObject({ ok: false, severity: 'fail' });
    expect(ev.notes.join('\n')).toMatch(/250 ta \(> 200\)/);
    // Davr to'g'ri bo'lsa — BLOCKED o'z kuchida.
    const ok = evaluateQuestion(
      q(6),
      ctx,
      periodRun('get_shift_summaries', week, 'Smenalar: 250 ta.\n\nManba: x'),
      truth,
      null,
    );
    expect(ok.verdict).toBe('BLOCKED');
  });

  it('F11: 9b — rad etishdan keyingi boshqa raqam NEEDS_REVIEW; yorliq bilan rad etish orasidagi yoki hosila raqam FAIL', () => {
    for (const tail of [
      "Hozir yo'ldagi buyurtmalar soni haqida ma'lumot yo'q: dashboard faqat 7 kunlik oyna bo'yicha qabul/sotilgan/bekor sonlarini beradi.",
      "Hozir yo'lda nechta buyurtma borligini bera olmayman — tool faqat 3 ta ko'rsatkichni beradi.",
    ]) {
      const ev = ask9(`${base9()}${tail}`);
      expect([tail, ev.verdict]).toEqual([tail, 'NEEDS_REVIEW']);
      expect(ev.items.find((i) => i.key === 'in_transit')).toMatchObject({
        status: 'ambiguous',
      });
    }
    const between = ask9(
      `${base9()}Yo'ldagi buyurtmalar: taxminan 37 ta (aniq ma'lumot yo'q).`,
    );
    expect(between.verdict).toBe('FAIL');
    expect(between.items.find((i) => i.key === 'in_transit')).toMatchObject({
      status: 'mismatch',
      assistant: 37,
    });
    // Hosila qiymat (A0 − S0 − C0 = 8) rad etishdan keyin ham — FAIL.
    const derived = ask9(
      `${base9()}Yo'ldagi buyurtmalar ma'lumoti yo'q (hisob bo'yicha 8 ta).`,
    );
    expect(derived.verdict).toBe('FAIL');
    expect(derived.items.find((i) => i.key === 'in_transit')).toMatchObject({
      status: 'mismatch',
      assistant: 8,
    });
    // Rad etishsiz bo'lak: yorliqdan OLDINGI raqam ham o'ylab topilgan.
    expect(
      ask9(`${base9()}Hozir 37 ta buyurtma yo'lda.`).items.find(
        (i) => i.key === 'in_transit',
      ),
    ).toMatchObject({ status: 'mismatch', assistant: 37 });
  });

  it('F12: tool natijasi truncated=true — javob aytmasa NEEDS_REVIEW (qoida 6), aytsa PASS', () => {
    const truth = q(1).truth({ fb: FB, cards: CARDS }, ctx, null);
    const truncatedEvents = (answer: string) =>
      q1Events(answer).map((e) =>
        e.type === 'tool_result'
          ? { ...e, truncated: true }
          : e.type === 'done'
            ? {
                ...e,
                sources: (e.sources as Array<Record<string, unknown>>).map(
                  (s) => ({ ...s, truncated: true }),
                ),
              }
            : e,
      );
    const hidden = evaluateQuestion(
      q(1),
      ctx,
      runFrom(truncatedEvents(Q1_ANSWER)),
      truth,
      null,
    );
    expect(hidden.verdict).toBe('NEEDS_REVIEW');
    expect(
      hidden.checks.find((c) => c.id === 'truncated_stated'),
    ).toMatchObject({ ok: false, severity: 'review' });
    const said = evaluateQuestion(
      q(1),
      ctx,
      runFrom(
        truncatedEvents(
          Q1_ANSWER.replace(
            '3 yozuv).',
            '3 yozuv; kartalar ro‘yxati qisqartirilgan).',
          ),
        ),
      ),
      truth,
      null,
    );
    expect(said.verdict).toBe('PASS');
    // truncated=false bo'lsa tekshiruv qo'shilmaydi.
    expect(
      evaluateQuestion(
        q(1),
        ctx,
        runFrom(q1Events(Q1_ANSWER)),
        truth,
        null,
      ).checks.some((c) => c.id === 'truncated_stated'),
    ).toBe(false);
  });

  it('F13: zanjirda oldingi davr qiymati yorliqdan KEYIN; «so‘mni» — pul (son emas)', () => {
    const bullets = [
      "O'tgan hafta (2026-11-02 — 2026-11-08):",
      '- Qabul qilingan: 120 ta (oldingi haftada 100 ta, +20)',
      '- Sotilgan: 90 ta (oldingi haftada 80 ta, +10)',
      '- Bekor qilingan: 10 ta (oldingi haftada 12 ta, -2)',
      "Muvaffaqiyat ulushi bo'yicha eng yaxshi market — «Bahor Savdo» (95%).",
      "Hozir yo'ldagi buyurtmalar soni bo'yicha ma'lumot yo'q.",
    ].join('\n');
    const ev = ask9(bullets);
    expect(ev.items.filter((i) => i.status !== 'match')).toEqual([]);
    expect(ev.verdict).toBe('PASS');
    expect(
      evaluateItem(
        prepareAnswer(
          "Kirim 120 000 000 so'mni tashkil qildi (450 ta operatsiya).",
        ),
        count('E4', 450, [/kirim/]),
      ).status,
    ).toBe('match');
    // Boshqa zanjirlar o'zgarmaydi: Q8 O1 — «buyurtma» dan OLDINGI raqam.
    const t8 = q(8).truth(
      {
        revenue: {
          data: {
            data: [
              { period: 'M:2026-09', ordersCount: 15, revenue: 1, profit: 1 },
              { period: 'M:2026-10', ordersCount: 120, revenue: 2, profit: 2 },
            ],
            summary: { totalRevenue: 3 },
          },
        },
      },
      ctx,
      null,
    );
    expect(
      evaluateItem(
        prepareAnswer(
          'Oktabr oyida 120 ta buyurtma sotildi va 15 tasi qaytarildi.',
        ),
        t8.items.find((i) => i.key === 'O1')!,
      ).status,
    ).toBe('match');
  });

  it('F4: Q5 — davr > 1000 qator va kuryer qismi filtrli chaqiruvsiz — tekshiruv izohi', () => {
    const truth = q5Truth();
    const answer = q5Answer('25 000 000');
    const partial = evaluateQuestion(
      q(5),
      ctx,
      periodRun('get_cashbox_history', m1, answer, { records: 1600 }),
      truth,
      null,
    );
    expect(
      partial.checks.find((c) => c.id === 'courier_filtered'),
    ).toMatchObject({ ok: false });
    expect(partial.verdict).not.toBe('PASS');
    const filtered = evaluateQuestion(
      q(5),
      ctx,
      periodRun('get_cashbox_history', m1, answer, {
        records: 1600,
        calls: [
          {},
          { operation_type: 'income', source_type: 'courier_payment' },
        ],
      }),
      truth,
      null,
    );
    expect(
      filtered.checks.find((c) => c.id === 'courier_filtered'),
    ).toMatchObject({ ok: true });
    expect(filtered.verdict).toBe('PASS');
    // ≤ 1000 qator — by_source to'liq, tekshiruv yo'q.
    expect(
      evaluateQuestion(
        q(5),
        ctx,
        periodRun('get_cashbox_history', m1, answer, { records: 570 }),
        truth,
        null,
      ).checks.some((c) => c.id === 'courier_filtered'),
    ).toBe(false);
  });

  it('F6/F14: natija JSON (sukut va hujjatdagi misol) .gitignore da — jonli moliyaviy ma’lumot commit qilinmaydi', () => {
    const ignored = (path: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', path], {
          cwd: REPO,
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    };
    const doc = readFileSync(
      join(REPO, 'docs/ai/ASSISTANT_TC_F7PWp6cK.md'),
      'utf8',
    );
    const examples = [...doc.matchAll(/ELCHI_TC_OUT=(\S+)/g)].map((m) => m[1]);
    expect(examples.length).toBeGreaterThan(0);
    for (const path of [DEFAULT_OUT, ...examples]) {
      expect([path, ignored(path)]).toEqual([path, true]);
    }
  });
});

describe('F7PWp6cK TC — sozlama (env)', () => {
  const now = new Date('2026-11-11T07:00:00Z');
  const base = { ELCHI_TC_PHONE: 'p', ELCHI_TC_PASSWORD: 'w' };

  it('sukutlar va to‘g‘ri qiymatlar', () => {
    expect(parseTcConfig(base, now)).toEqual({
      baseUrl: 'https://test-api.elchipochta.uz',
      today: null,
      only: null,
      out: './assistant-tc-results.json',
    });
    expect(
      parseTcConfig(
        {
          ...base,
          ELCHI_TC_BASE_URL: 'http://127.0.0.1:9/',
          ELCHI_TC_TODAY: '2026-10-15',
          ELCHI_TC_ONLY: '9, 1,9',
        },
        now,
      ),
    ).toMatchObject({
      baseUrl: 'http://127.0.0.1:9',
      today: '2026-10-15',
      only: [1, 9],
    });
  });

  it('yaroqsiz env — TcConfigError (qiymat xabarga chiqmaydi)', () => {
    const bad = (env: Record<string, string>) => () => parseTcConfig(env, now);
    expect(bad({})).toThrow(TcConfigError);
    expect(bad({ ELCHI_TC_PASSWORD: 'w' })).toThrow(/ELCHI_TC_PHONE/);
    expect(bad({ ...base, ELCHI_TC_BASE_URL: 'http://example.com' })).toThrow(
      /https/,
    );
    expect(bad({ ...base, ELCHI_TC_TODAY: '2026-11-31' })).toThrow(
      /YYYY-MM-DD/,
    );
    expect(bad({ ...base, ELCHI_TC_TODAY: '2026-11-12' })).toThrow(/kelajakda/);
    expect(bad({ ...base, ELCHI_TC_ONLY: '0,11' })).toThrow(/1\.\.10/);
    try {
      parseTcConfig({ ELCHI_TC_PHONE: 'secret-phone' }, now);
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-phone');
    }
  });
});

describe('F7PWp6cK TC — `.mjs` runner (soxta server bilan)', () => {
  const SENTINEL_PASSWORD = 'tc-sentinel-not-a-secret';
  const SENTINEL_PHONE = 'tc-sentinel-phone';
  const SENTINEL_TOKEN = 'tc-sentinel-token';
  let server: Server;
  let port: number;
  let hits: string[];
  let authOk: boolean;
  let dir: string;
  /**
   * `POST /ai/assistant/messages` SSE'dan OLDINGI xatosi (429 limit, 503
   * funksiya o'chiq) — haqiqiy gateway filtri kabi `code`SIZ.
   */
  let messagesError: 429 | 503 | null;
  /** true — `POST /auth/login` 308 bilan ikkinchi (http) listener'ga yo'naltiradi. */
  let redirectLogin: boolean;
  /** Yo'naltirish nishoni (http://127.0.0.1) — so'rov kelmasligi shart. */
  let sink: Server;
  let sinkPort: number;
  let sinkHits: string[];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://x');
        hits.push(`${req.method} ${url.pathname}`);
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (url.pathname === '/auth/login') {
          if (redirectLogin) {
            res.writeHead(308, {
              Location: `http://127.0.0.1:${sinkPort}/auth/login`,
            });
            return res.end();
          }
          const b = JSON.parse(body) as Record<string, string>;
          const ok =
            b.phone_number === SENTINEL_PHONE &&
            b.password === SENTINEL_PASSWORD;
          return ok
            ? json(201, {
                accessToken: SENTINEL_TOKEN,
                must_change_password: false,
              })
            : json(401, { message: 'bad' });
        }
        if (req.headers.authorization !== `Bearer ${SENTINEL_TOKEN}`)
          authOk = false;
        switch (url.pathname) {
          case '/ai/assistant/access/me':
            return json(200, {
              data: {
                allowed: true,
                reason: null,
                feature_enabled: true,
                daily_limit: 100,
                used_today: 0,
                remaining_today: 100,
              },
            });
          case '/finance/cashbox/financial-balanse':
            return json(200, FB);
          case '/finance/cashbox/cards':
            return json(200, CARDS);
          case '/ai/assistant/conversations/77':
            return json(200, {
              data: {
                id: '77',
                messages: [
                  { role: 'user', text: 'q' },
                  { role: 'assistant', text: Q1_ANSWER },
                ],
              },
            });
          case '/ai/assistant/messages': {
            // AllExceptionsFilter `code`ni olib tashlaydi (PUBLIC_ERROR_CODES
            // da yo'q) — javob aynan shu shaklda keladi.
            if (messagesError === 429) {
              return json(429, {
                statusCode: 429,
                message: 'Bugungi savollar limiti tugadi',
              });
            }
            if (messagesError === 503) {
              return json(503, {
                statusCode: 503,
                message: "AI yordamchi hozircha o'chirilgan",
              });
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const text = `: ping\n\n${sse(q1Events(Q1_ANSWER))}`;
            // Bo'laklab yuboriladi — parser chegaralarni to'g'ri yig'ishi kerak.
            res.write(text.slice(0, 50));
            setTimeout(() => res.end(text.slice(50)), 20);
            return undefined;
          }
          default:
            return json(404, { message: 'not found' });
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
    sink = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        sinkHits.push(`${req.method} ${req.url} ${body}`);
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', () => r()));
    sinkPort = (sink.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => sink.close(() => r()));
  });

  beforeEach(() => {
    hits = [];
    authOk = true;
    messagesError = null;
    redirectLogin = false;
    sinkHits = [];
    dir = mkdtempSync(join(tmpdir(), 'assistant-tc-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function runRunner(env: Record<string, string>) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(process.execPath, [RUNNER], {
          cwd: dir,
          env: { PATH: process.env.PATH ?? '', ...env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      },
    );
  }

  it('env’siz — exit 2, aniq xabar, tarmoqqa chiqmaydi', async () => {
    const r = await runRunner({
      ELCHI_TC_BASE_URL: `http://127.0.0.1:${port}`,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ELCHI_TC_PHONE, ELCHI_TC_PASSWORD berilmagan');
    expect(r.stdout).toBe('');
    expect(hits).toEqual([]);
  }, 30_000);

  it('to‘liq yo‘l: login → access/me → haqiqat (oldin/keyin) → SSE → audit; PASS va sirlar chiqmaydi', async () => {
    const out = join(dir, 'res.json');
    const r = await runRunner({
      ELCHI_TC_BASE_URL: `http://127.0.0.1:${port}`,
      ELCHI_TC_PHONE: SENTINEL_PHONE,
      ELCHI_TC_PASSWORD: SENTINEL_PASSWORD,
      ELCHI_TC_ONLY: '1',
      ELCHI_TC_OUT: out,
    });
    expect(r.stderr).not.toMatch(/kutilmagan xato/);
    expect(r.code).toBe(0);
    expect(authOk).toBe(true);
    expect(hits).toEqual([
      'POST /auth/login',
      'GET /ai/assistant/access/me',
      'GET /finance/cashbox/financial-balanse',
      'GET /finance/cashbox/cards',
      'POST /ai/assistant/messages',
      'GET /finance/cashbox/financial-balanse',
      'GET /finance/cashbox/cards',
      'GET /ai/assistant/conversations/77',
      'GET /ai/assistant/access/me',
    ]);
    expect(r.stdout).toContain('| 1 | Asosiy kassa, kartalar, umumiy holat |');
    expect(r.stdout).toContain('**PASS**');
    const saved = readFileSync(out, 'utf8');
    const json = JSON.parse(saved) as {
      verdicts: Record<string, number>;
      results: Array<Record<string, unknown>>;
    };
    expect(json.verdicts).toEqual({ PASS: 1 });
    expect(json.results[0]).toMatchObject({
      n: 1,
      verdict: 'PASS',
      conversation_id: '77',
      audit_path: '/ai/assistant/conversations/77',
      cost_usd: 0.0123,
    });
    for (const text of [r.stdout, r.stderr, saved]) {
      expect(text).not.toContain(SENTINEL_PASSWORD);
      expect(text).not.toContain(SENTINEL_PHONE);
      expect(text).not.toContain(SENTINEL_TOKEN);
    }
  }, 30_000);

  it('limit tugasa (429, gateway `code`siz) — BLOCKED, qolgan savollar yuborilmaydi, exit 3', async () => {
    messagesError = 429;
    const out = join(dir, 'res.json');
    const r = await runRunner({
      ELCHI_TC_BASE_URL: `http://127.0.0.1:${port}`,
      ELCHI_TC_PHONE: SENTINEL_PHONE,
      ELCHI_TC_PASSWORD: SENTINEL_PASSWORD,
      ELCHI_TC_ONLY: '1,2',
      ELCHI_TC_OUT: out,
    });
    expect(r.code).toBe(3);
    expect(
      hits.filter((h) => h === 'POST /ai/assistant/messages'),
    ).toHaveLength(1);
    const json = JSON.parse(readFileSync(out, 'utf8')) as {
      results: Array<{ n: number; verdict: string; reason: string }>;
    };
    expect(json.results.map((x) => [x.n, x.verdict])).toEqual([
      [1, 'BLOCKED'],
      [2, 'BLOCKED'],
    ]);
    expect(json.results[0].reason).toMatch(/^(daily_limit|http_429)/);
    expect(json.results[1].reason).toMatch(/yuborilmadi/);
  }, 30_000);

  it('F9: funksiya o‘chiq (503, `code`siz) — BLOCKED, bitta POST, exit 3', async () => {
    messagesError = 503;
    const out = join(dir, 'res.json');
    const r = await runRunner({
      ELCHI_TC_BASE_URL: `http://127.0.0.1:${port}`,
      ELCHI_TC_PHONE: SENTINEL_PHONE,
      ELCHI_TC_PASSWORD: SENTINEL_PASSWORD,
      ELCHI_TC_ONLY: '1,2',
      ELCHI_TC_OUT: out,
    });
    expect(r.code).toBe(3);
    expect(
      hits.filter((h) => h === 'POST /ai/assistant/messages'),
    ).toHaveLength(1);
    const json = JSON.parse(readFileSync(out, 'utf8')) as {
      results: Array<{ n: number; verdict: string; reason: string }>;
    };
    expect(json.results.map((x) => x.verdict)).toEqual(['BLOCKED', 'BLOCKED']);
    expect(json.results[0].reason).toMatch(/^http_503/);
  }, 30_000);

  it('F5: login 308 → http:// — redirect kuzatilmaydi (parol qayta yuborilmaydi), exit 2', async () => {
    redirectLogin = true;
    const r = await runRunner({
      ELCHI_TC_BASE_URL: `http://127.0.0.1:${port}`,
      ELCHI_TC_PHONE: SENTINEL_PHONE,
      ELCHI_TC_PASSWORD: SENTINEL_PASSWORD,
      ELCHI_TC_ONLY: '1',
      ELCHI_TC_OUT: join(dir, 'res.json'),
    });
    expect(r.code).toBe(2);
    expect(hits).toEqual(['POST /auth/login']);
    expect(sinkHits).toEqual([]);
    expect(r.stderr).toMatch(/login so'rovi yuborilmadi/);
    expect(r.stderr).toMatch(/redirect/);
    for (const text of [r.stdout, r.stderr]) {
      expect(text).not.toContain(SENTINEL_PASSWORD);
      expect(text).not.toContain(SENTINEL_PHONE);
    }
  }, 30_000);

  it('F6: natija JSON faqat egasi o‘qiydigan ruxsat bilan yoziladi (0600)', async () => {
    const out = join(dir, 'res.json');
    const r = await runRunner({
      ELCHI_TC_BASE_URL: `http://127.0.0.1:${port}`,
      ELCHI_TC_PHONE: SENTINEL_PHONE,
      ELCHI_TC_PASSWORD: SENTINEL_PASSWORD,
      ELCHI_TC_ONLY: '1',
      ELCHI_TC_OUT: out,
    });
    expect(r.code).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  }, 30_000);
});
