#!/usr/bin/env node
/**
 * `npm run ai:tc` — F7PWp6cK AI moliyaviy yordamchi QABUL TC'si (10 savol)
 * runner'i. Hujjat: docs/ai/ASSISTANT_TC_F7PWp6cK.md.
 *
 * Har savol uchun: haqiqatni hujjatdagi endpointlardan O'QIYDI (savoldan
 * oldin; jonli savollarda keyin ham — DRIFT), savolni yangi suhbatda
 * `POST /ai/assistant/messages` ga yuboradi, SSE'ni `done`/`error` gacha
 * o'qiydi, `done.answer` dan raqamlarni ajratib dopusk bilan solishtiradi.
 * Natija: Markdown jadval (stdout) + JSON (ELCHI_TC_OUT). Har savolning
 * `conversation_id` si saqlanadi — audit:
 * `GET /ai/assistant/conversations/:id`.
 *
 * Bu fayl — yupqa qobiq (env, HTTP, SSE oqimi, fayl). Sof mantiq
 * (SSE parser, raqam ajratish, davrlar, dopusk, savollar) —
 * `assistant-tc.lib.ts`; u `typescript.transpileModule` bilan yuklanadi
 * (repo'dagi mavjud `typescript` paketi; yangi bog'liqlik YO'Q, Node 20+).
 *
 * Env:
 *   ELCHI_TC_PHONE, ELCHI_TC_PASSWORD  — SUPERADMIN login (MAJBURIY). Qiymatlar
 *                     faqat login so'roviga ketadi: hech qachon chiqarilmaydi,
 *                     logga yoki faylga yozilmaydi.
 *   ELCHI_TC_BASE_URL — sukut https://test-api.elchipochta.uz (http:// faqat
 *                     localhost uchun).
 *   ELCHI_TC_TODAY    — YYYY-MM-DD (sukut — har savolda Toshkent bugungi
 *                     sanasi). Bugundan farq qilsa savollarda nisbiy so'z
 *                     («o'tgan oy») o'rniga aniq sanalar yoziladi.
 *   ELCHI_TC_ONLY     — faqat shu savollar: «1,5,9».
 *   ELCHI_TC_OUT      — JSON natija yo'li (sukut ./assistant-tc-results.json;
 *                     repo ildizida `.gitignore`da — jonli moliyaviy ma'lumot).
 *
 * Exit: 0 — hammasi PASS; 1 — FAIL yoki ERROR bor; 2 — sozlanmagan /
 *       login / pre-flight xatosi (savol yuborilmagan); 3 — FAIL yo'q, lekin
 *       NEEDS_REVIEW / DRIFT / BLOCKED bor.
 *
 * Token faqat xotirada turadi: diskka, stdout/stderr'ga yozilmaydi.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASK_TIMEOUT_MS = 240_000;
const READ_TIMEOUT_MS = 60_000;
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 20_000;
/** Bu kodlar kelganda qolgan savollar yuborilmaydi (limit/budjet/ruxsat). */
const FATAL_CODES = new Set([
  'daily_limit',
  'assistant_usd_cap',
  'cap_exceeded',
  'feature_disabled',
  'ai_disabled',
  'access_disabled',
  'role_forbidden',
]);
/**
 * `POST /ai/assistant/messages` SSE ochilishidan OLDINGI javoblari: 403
 * (rol/ruxsat), 429 (kunlik limit), 503 (funksiya/AI o'chiq). Gateway filtri
 * `code`ni olib tashlaydi (PUBLIC_ERROR_CODES da yo'q) — statusga qaraladi.
 */
const FATAL_HTTP_STATUSES = new Set([403, 429, 503]);

function log(msg) {
  process.stderr.write(`[assistant-tc] ${msg}\n`);
}

/** Runner'ni to'xtatadi: xabar stderr'ga, exit kodi bilan (oxirida). */
class TcExit extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

function die(code, msg) {
  throw new TcExit(code, msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadLib() {
  const require = createRequire(import.meta.url);
  let ts;
  try {
    ts = require('typescript');
  } catch {
    die(
      2,
      "`typescript` paketi topilmadi — repo ildizida `npm ci` bajaring (yangi bog'liqlik kerak emas)",
    );
  }
  const file = fileURLToPath(new URL('./assistant-tc.lib.ts', import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
  );
}

class HttpError extends Error {
  constructor(status, path, detail) {
    super(`HTTP ${status} ${path}${detail ? ` — ${detail}` : ''}`);
    this.status = status;
  }
}

/** Xato javobidan qisqa, xavfsiz matn (token/parol bo'lmaydi). */
function errorDetail(json) {
  if (!json || typeof json !== 'object') return '';
  const m = json.message;
  const msg =
    typeof m === 'string'
      ? m
      : m && typeof m === 'object' && typeof m.message === 'string'
        ? m.message
        : '';
  const code = json.code ?? (m && typeof m === 'object' ? m.code : undefined);
  return [code, msg].filter(Boolean).join(': ').slice(0, 200);
}

function errorCode(json) {
  if (!json || typeof json !== 'object') return null;
  const m = json.message;
  return json.code ?? (m && typeof m === 'object' ? m.code : undefined) ?? null;
}

/**
 * Tarmoq xatosi matni: Node fetch `fetch failed` ning sababi (`cause`) bilan —
 * masalan «unexpected redirect». Sabab matnida so'rov tanasi bo'lmaydi.
 */
function fetchErrorMessage(err) {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : '';
  return cause ? `${err.message} (${cause})` : err.message;
}

function makeClient(baseUrl) {
  let token = null;
  const url = (path, query) => {
    const u = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      u.searchParams.set(k, String(v));
    }
    return u;
  };
  const headers = (accept, json) => ({
    Accept: accept,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });
  const readJson = async (res) => {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  // redirect kuzatilmaydi: 307/308 login tanasini (parolni) http:// yoki
  // boshqa hostga qayta yuborishi mumkin (https tekshiruvi faqat boshlang'ich
  // URL'da) — har qanday 3xx xato bo'ladi.
  return {
    setToken(t) {
      token = t;
    },
    async getJson(path, query) {
      const res = await fetch(url(path, query), {
        headers: headers('application/json', false),
        redirect: 'error',
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      const json = await readJson(res);
      if (!res.ok) throw new HttpError(res.status, path, errorDetail(json));
      return json;
    },
    async postJson(path, body) {
      const res = await fetch(url(path), {
        method: 'POST',
        headers: headers('application/json', true),
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      return { status: res.status, ok: res.ok, json: await readJson(res) };
    },
    /** SSE so'rovi: `onEvent` true qaytarsa oqim yopiladi. */
    async stream(path, body, onEvent, parser) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ASK_TIMEOUT_MS);
      try {
        const res = await fetch(url(path), {
          method: 'POST',
          headers: headers('text/event-stream', true),
          body: JSON.stringify(body),
          redirect: 'error',
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const json = await readJson(res);
          return {
            httpError: {
              status: res.status,
              code: errorCode(json) ?? `http_${res.status}`,
              message: errorDetail(json),
            },
          };
        }
        const decoder = new TextDecoder();
        for await (const chunk of res.body) {
          const text = decoder.decode(chunk, { stream: true });
          for (const ev of parser.feed(text)) {
            if (onEvent(ev)) return { ended: true };
          }
        }
        // Tugallanmagan oxirgi hodisa (uzilgan oqim) TASHLANADI — chala
        // `done` javob sifatida baholanmaydi.
        for (const ev of parser.feed(decoder.decode())) {
          if (onEvent(ev)) return { ended: true };
        }
        return { ended: false };
      } catch (err) {
        return {
          networkError: ctrl.signal.aborted
            ? 'timeout'
            : fetchErrorMessage(err),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function readTruth(client, spec, ctx, period) {
  const out = {};
  for (const req of spec.reads(ctx, period)) {
    out[req.id] = await client.getJson(req.path, req.query);
  }
  return out;
}

async function ask(lib, client, text) {
  for (let attempt = 0; ; attempt += 1) {
    const run = lib.newRun();
    const parser = new lib.SseParser();
    const r = await client.stream(
      '/ai/assistant/messages',
      { message: text },
      (ev) => lib.applyEvent(run, ev),
      parser,
    );
    if (r.httpError) {
      run.error = {
        code: r.httpError.code,
        message: r.httpError.message,
        http: r.httpError.status,
      };
    } else if (r.networkError) {
      run.error = { code: 'network', message: r.networkError };
    } else if (!r.ended) {
      run.error = { code: 'stream_ended', message: 'done/error kelmadi' };
    }
    if (run.error?.code === 'busy' && attempt < BUSY_RETRIES) {
      log(`busy — ${BUSY_WAIT_MS / 1000} s kutib qayta yuboriladi`);
      await sleep(BUSY_WAIT_MS);
      continue;
    }
    return run;
  }
}

function baseReport(lib, spec, ctx, text) {
  return {
    n: spec.n,
    title: spec.title,
    question: text,
    verdict: 'ERROR',
    reason: null,
    conversation_id: null,
    message_id: null,
    audit_path: null,
    expected_period: spec.defaultPeriod(ctx),
    tool_period: null,
    tool_calls: [],
    tool_results: [],
    sources: [],
    answer: null,
    stop: null,
    cost_usd: null,
    items: [],
    checks: [],
    notes: [],
    drift: null,
  };
}

async function runQuestion(lib, client, cfg, spec) {
  const today = cfg.today ?? lib.tashkentToday();
  const explicit = cfg.today !== null && cfg.today !== lib.tashkentToday();
  const ctx = lib.buildContext(today, explicit);
  const text = spec.text(ctx);
  const report = baseReport(lib, spec, ctx, text);
  const expected = spec.defaultPeriod(ctx);
  log(`Q${spec.n}: ${spec.title} (T=${today})`);

  let before;
  try {
    before = spec.truth(
      await readTruth(client, spec, ctx, expected),
      ctx,
      expected,
    );
  } catch (err) {
    report.reason = `haqiqatni o'qib bo'lmadi: ${fetchErrorMessage(err)}`;
    return report;
  }
  if (before.blocked) {
    // Savol yuborilmaydi (budjet tejaladi): davr/ma'lumot yaroqsiz.
    report.verdict = 'BLOCKED';
    report.reason = before.blocked;
    report.items = before.items.map((i) => ({
      key: i.key,
      label: i.label,
      kind: i.kind,
      expected: i.value,
      assistant: null,
      status: 'skipped',
    }));
    report.notes = before.notes;
    return report;
  }

  const run = await ask(lib, client, text);
  report.conversation_id = run.conversationId;
  report.message_id = run.messageId;
  report.audit_path = run.conversationId
    ? `/ai/assistant/conversations/${run.conversationId}`
    : null;
  report.tool_calls = run.toolCalls;
  report.tool_results = run.toolResults;
  if (run.error || !run.done) {
    const fatal =
      FATAL_CODES.has(run.error?.code) ||
      FATAL_HTTP_STATUSES.has(run.error?.http);
    report.verdict = fatal ? 'BLOCKED' : 'ERROR';
    report.reason = run.error
      ? `${run.error.code}${run.error.message ? `: ${run.error.message}` : ''}`
      : 'done kelmadi';
    report.fatal = fatal;
    return report;
  }
  report.sources = run.done.sources;
  report.answer = run.done.answer;
  report.stop = run.done.stop;
  report.cost_usd =
    typeof run.done.usage.cost_usd === 'number'
      ? run.done.usage.cost_usd
      : null;

  const effective = lib.effectivePeriod(spec, run, expected);
  report.tool_period = effective;
  let truth = before;
  let drift = null;
  const samePeriod = lib.samePeriod(effective, expected);
  if (spec.live || !samePeriod) {
    try {
      const after = spec.truth(
        await readTruth(client, spec, ctx, effective),
        ctx,
        effective,
      );
      if (spec.live && samePeriod) drift = lib.diffTruth(before, after);
      truth = after;
    } catch (err) {
      report.reason = `keyingi o'qish xatosi: ${fetchErrorMessage(err)}`;
      return report;
    }
  }
  const ev = lib.evaluateQuestion(spec, ctx, run, truth, drift);
  Object.assign(report, {
    verdict: ev.verdict,
    reason: ev.reason,
    items: ev.items,
    checks: ev.checks,
    notes: ev.notes,
    drift: drift && drift.length ? drift : null,
  });

  // Audit nusxasi: saqlangan oxirgi assistent xabari = done.answer.
  if (run.conversationId) {
    try {
      const conv = await client.getJson(report.audit_path);
      const msgs = conv?.data?.messages ?? [];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      const same = !!last && last.text === run.done.answer;
      report.checks.push({
        id: 'audit',
        ok: same,
        severity: 'review',
        note: same
          ? 'suhbat tarixida saqlangan'
          : 'saqlangan javob done.answer bilan bir xil emas',
      });
      if (!same && report.verdict === 'PASS') report.verdict = 'NEEDS_REVIEW';
    } catch (err) {
      report.notes.push(`audit o'qilmadi: ${fetchErrorMessage(err)}`);
    }
  }
  return report;
}

async function main() {
  // 1) Majburiy env — tarmoqdan va kutubxonadan OLDIN.
  const missing = ['ELCHI_TC_PHONE', 'ELCHI_TC_PASSWORD'].filter(
    (k) => !(process.env[k] ?? '').trim(),
  );
  if (missing.length) {
    die(
      2,
      `${missing.join(', ')} berilmagan — SUPERADMIN login faqat env orqali beriladi ` +
        '(qiymatlar hech qayerga yozilmaydi). Masalan: ELCHI_TC_PHONE=… ELCHI_TC_PASSWORD=… npm run ai:tc',
    );
  }
  const lib = await loadLib();
  let cfg;
  try {
    cfg = lib.parseTcConfig(process.env);
  } catch (err) {
    die(2, err.message);
  }
  const specs = lib.QUESTIONS.filter(
    (q) => !cfg.only || cfg.only.includes(q.n),
  );
  const client = makeClient(cfg.baseUrl);
  const startedAt = new Date().toISOString();

  // 2) Login (POST /auth/login) — javobdan faqat accessToken olinadi.
  let login;
  try {
    login = await client.postJson('/auth/login', {
      phone_number: process.env.ELCHI_TC_PHONE.trim(),
      password: process.env.ELCHI_TC_PASSWORD,
    });
  } catch (err) {
    die(2, `login so'rovi yuborilmadi: ${fetchErrorMessage(err)}`);
  }
  const token = login.json?.accessToken ?? login.json?.data?.accessToken;
  if (!login.ok || typeof token !== 'string' || !token) {
    die(
      2,
      `login muvaffaqiyatsiz: HTTP ${login.status} ${errorDetail(login.json)}`,
    );
  }
  client.setToken(token);
  if (
    (login.json?.must_change_password ??
      login.json?.data?.must_change_password) === true
  ) {
    log(
      "⚠️ must_change_password=true — boshqa route'lar 403 PASSWORD_CHANGE_REQUIRED qaytarishi mumkin",
    );
  }

  // 3) Pre-flight: GET /ai/assistant/access/me.
  let access;
  try {
    access = (await client.getJson('/ai/assistant/access/me'))?.data ?? {};
  } catch (err) {
    die(2, `access/me: ${fetchErrorMessage(err)}`);
  }
  if (access.allowed !== true || access.reason) {
    die(
      2,
      `yordamchi yopiq: allowed=${access.allowed}, reason=${access.reason} ` +
        '(feature_disabled → AI_ASSISTANT_ENABLED; ai_disabled → kalit / STAGING_AI_ENABLED; hujjat §2)',
    );
  }
  if (
    typeof access.remaining_today === 'number' &&
    access.remaining_today < specs.length
  ) {
    die(
      2,
      `bugungi limit yetmaydi: remaining_today=${access.remaining_today} < ${specs.length}`,
    );
  }
  log(
    `pre-flight OK: daily_limit=${access.daily_limit}, used_today=${access.used_today}, remaining_today=${access.remaining_today}`,
  );

  // 4) Savollar (ketma-ket, har biri yangi suhbat).
  const reports = [];
  let stopped = null;
  for (const spec of specs) {
    if (stopped) {
      const r = baseReport(
        lib,
        spec,
        lib.buildContext(cfg.today ?? lib.tashkentToday(), false),
        null,
      );
      r.verdict = 'BLOCKED';
      r.reason = `yuborilmadi — oldingi xato: ${stopped}`;
      reports.push(r);
      continue;
    }
    const r = await runQuestion(lib, client, cfg, spec);
    if (r.fatal) stopped = r.reason;
    delete r.fatal;
    log(`Q${spec.n}: ${r.verdict}${r.reason ? ` — ${r.reason}` : ''}`);
    reports.push(r);
  }

  let accessAfter = null;
  try {
    accessAfter =
      (await client.getJson('/ai/assistant/access/me'))?.data ?? null;
  } catch {
    accessAfter = null;
  }

  // 5) Natija: JSON (token/parol/telefon YO'Q) + Markdown.
  const today = cfg.today ?? lib.tashkentToday();
  const out = resolve(cfg.out);
  const verdicts = reports.reduce(
    (acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }),
    {},
  );
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        tc: 'F7PWp6cK',
        doc: 'docs/ai/ASSISTANT_TC_F7PWp6cK.md',
        base_url: cfg.baseUrl,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        today,
        explicit_dates: cfg.today !== null && cfg.today !== lib.tashkentToday(),
        only: cfg.only,
        access_before: pickAccess(access),
        access_after: accessAfter ? pickAccess(accessAfter) : null,
        verdicts,
        cost_usd: reports.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
        results: reports,
      },
      null,
      2,
    )}\n`,
    // Jonli moliyaviy ma'lumot — faqat egasi o'qiydi (yangi faylga qo'llanadi).
    { mode: 0o600 },
  );
  await new Promise((done) =>
    process.stdout.write(
      `${lib.renderMarkdown({ baseUrl: cfg.baseUrl, startedAt, today }, reports)}\n`,
      done,
    ),
  );
  log(`JSON: ${out}`);
  const all = Object.keys(verdicts);
  if (all.includes('FAIL') || all.includes('ERROR')) return 1;
  return all.some((v) => v !== 'PASS') ? 3 : 0;
}

function pickAccess(a) {
  return {
    allowed: a.allowed ?? null,
    reason: a.reason ?? null,
    daily_limit: a.daily_limit ?? null,
    used_today: a.used_today ?? null,
    remaining_today: a.remaining_today ?? null,
  };
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const code = err instanceof TcExit ? err.exitCode : 1;
    const msg =
      err instanceof TcExit
        ? err.message
        : `kutilmagan xato: ${err instanceof Error ? err.message : String(err)}`;
    // stderr bo'shatilgach chiqiladi (pipe'da xabar yo'qolmasin).
    process.stderr.write(`assistant-tc: ${msg}\n`, () => process.exit(code));
  },
);
