import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * zDUUxyH2 — scripts/bot-alert.sh (cron, har 5 daqiqa): soxta `docker` va
 * `curl` bilan (tarmoq va Docker yo'q). Har tekshiruv soxta javob bilan;
 * sir (bot tokenlari, URL'lar) argv'ga ham, logga ham tushmaydi. Ogohlantirilgan
 * to'plam tekshiruv kodi bo'yicha «yopishqoq»: kod joriy + oldingi 2 yugurishdan
 * birida yiqilsa qo'shiladi, faqat ketma-ket 2 toza yugurishdan keyin chiqadi;
 * crash-loop darhol, oynada restart turgan ekan saqlanadi. Oxirida — jadvalli
 * stsenariy simulyatsiyasi (har qadam = bitta cron yugurishi, +300 s).
 */
const ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'bot-alert.sh');
const MAIN_TOKEN = '111111:MAIN-BOT-TOKEN-never-in-argv';
const ALERT_TOKEN = '222222:ALERT-BOT-TOKEN-never-in-argv';
const SECRET = 'webhook_secret_abcdefghijklmnop';
const HOOK_URL = 'https://api.elchi.test/telegram/webhook/elchi';
const webhookInfo = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    result: { url: HOOK_URL, pending_update_count: 0, ...extra },
  });

// docker ps … -> $FAKE_NS_IDS (newline list); docker inspect … <id> -> $FAKE_<id>;
// docker exec … psql … -> $FAKE_PSQL (lines) or fail; FAKE_DOCKER_HANG=1 -> sleep.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
[ "\${FAKE_DOCKER_HANG:-}" = 1 ] && sleep 5
case "$1" in
  ps) [ "\${FAKE_PS_FAIL:-}" = 1 ] && exit 1; printf '%b' "\${FAKE_NS_IDS:-}" ;;
  inspect)
    [ -n "\${FAKE_INSPECT_ERR:-}" ] && { echo "$FAKE_INSPECT_ERR" >&2; exit 1; }
    id="\${@: -1}"; v="FAKE_\${id//-/_}"
    [ -n "\${!v:-}" ] || { echo "Error: No such object: $id" >&2; exit 1; }
    echo "\${!v}" ;;
  exec) [ -n "\${FAKE_PSQL:-}" ] || exit 2; printf '%b\\n' "$FAKE_PSQL" ;;
esac
`;
// curl -K - : URL (with the token) comes on stdin. Bot API: body + "\\n<code>" (-w).
const FAKE_CURL = `#!/usr/bin/env bash
a="$*"; echo "curl \${a//$'\\n'/ | }" >> "$FAKE_LOG"
cfg="$(cat)"; echo "$cfg" >> "$FAKE_LOG.stdin"
case "$cfg" in
  *getMe*)
    [ "\${FAKE_GETME_EXIT:-0}" != 0 ] && exit "$FAKE_GETME_EXIT"
    printf '%s\\n%s' "\${FAKE_GETME:-{\\"ok\\":true}}" "\${FAKE_GETME_CODE:-200}" ;;
  *getWebhookInfo*) printf '%s\\n200' "$FAKE_WEBHOOK" ;;
  *) [ "\${FAKE_SEND_FAIL:-}" = 1 ] && exit 22; echo -n 200 ;;
esac
`;

describe('bot-alert.sh (zDUUxyH2)', () => {
  let dir: string;
  const now = Math.floor(Date.now() / 1000);
  const startedLongAgo = new Date((now - 3600) * 1000).toISOString();
  const healthy: Record<string, string> = {
    FAKE_NS_IDS: 'ns1\\n',
    FAKE_ns1: `running healthy 0 ${startedLongAgo}`,
    FAKE_PSQL: '0\\n0\\n0',
    FAKE_WEBHOOK: webhookInfo(),
  };
  const writeEnv = (extra = '') =>
    writeFileSync(
      join(dir, 'app', '.env.production'),
      `TELEGRAM_BOT_TOKEN=${MAIN_TOKEN}\nTELEGRAM_WEBHOOK_SECRET=${SECRET}\nPOSTGRES_USER=elchi\nPOSTGRES_DB=elchi\n${extra}`,
    );
  const writeConf = (body: string) =>
    writeFileSync(join(dir, 'ops', 'bot-alert.env'), body);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bot-alert-'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'app'));
    mkdirSync(join(dir, 'ops'));
    writeFileSync(join(dir, 'bin', 'docker'), FAKE_DOCKER);
    writeFileSync(join(dir, 'bin', 'curl'), FAKE_CURL);
    chmodSync(join(dir, 'bin', 'docker'), 0o755);
    chmodSync(join(dir, 'bin', 'curl'), 0o755);
    writeEnv();
    writeConf(
      `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${ALERT_TOKEN}\n`,
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (env: Record<string, string> = {}, args: string[] = []) =>
    spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
        HOME: dir,
        ELCHI_APP_DIR: join(dir, 'app'),
        ELCHI_OPS_DIR: join(dir, 'ops'),
        FAKE_LOG: join(dir, 'calls.log'),
        BOT_ALERT_NOW: String(now),
        ...healthy,
        ...env,
      },
    });
  const calls = () =>
    existsSync(join(dir, 'calls.log'))
      ? readFileSync(join(dir, 'calls.log'), 'utf8')
      : '';
  const sends = () =>
    calls()
      .split('\n')
      .filter((line) => line.includes('chat_id='));
  /** Ikki ketma-ket yugurish (debounce), ikkinchisining --dry-run natijasi. */
  const twice = (env: Record<string, string>) => {
    run({ ...env, BOT_ALERT_NOW: String(now - 300) });
    return run(env, ['--dry-run']).stdout;
  };
  const logText = () =>
    readFileSync(join(dir, 'ops', 'logs', 'bot-alert.log'), 'utf8');

  it('⭐ hammasi joyida — xabar yo‘q, chiqish kodi 0', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(sends()).toEqual([]);
  });

  it('⭐ debounce: bitta yugurishdagi muammo xabar qilinmaydi, ikkinchisida — xabar', () => {
    const bad = { FAKE_ns1: `exited no-healthcheck 0 ${startedLongAgo}` };
    expect(run(bad).status).toBe(1);
    expect(sends()).toEqual([]);
    expect(run({ ...bad, BOT_ALERT_NOW: String(now + 300) }).status).toBe(1);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatch(/notification-service: exited no-healthcheck/);
  });

  it('⭐ token buzuq (401) va Telegram javob bermadi (curl exit 28 / 5xx) — alohida muammolar', () => {
    expect(
      twice({ FAKE_GETME_CODE: '401', FAKE_GETME: '{"ok":false}' }),
    ).toMatch(/Token: getMe 401/);
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    const unreachable = twice({ FAKE_GETME_EXIT: '28' });
    expect(unreachable).toMatch(/Telegram API javob bermadi \(HTTP 000\)/);
    expect(unreachable).not.toMatch(/Token:/);
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    expect(
      twice({ FAKE_GETME_CODE: '502', FAKE_GETME: 'bad gateway' }),
    ).toMatch(/Telegram API javob bermadi \(HTTP 502\)/);
  });

  it('⭐ qisqa uzilish (1 yugurish) — xabar ham, «tiklandi» ham yo‘q', () => {
    run();
    run({ FAKE_GETME_EXIT: '28', BOT_ALERT_NOW: String(now + 300) });
    run({ BOT_ALERT_NOW: String(now + 600) });
    expect(sends()).toEqual([]);
  });

  it('⭐ webhook: boshqa manzil / o‘rnatilmagan / navbat to‘lgan / yaqinda xato; eski xato — ok', () => {
    expect(
      twice({
        FAKE_WEBHOOK: webhookInfo({ url: 'https://evil.test/hook' }),
      }),
    ).toMatch(/Webhook: boshqa manzil/);
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    expect(twice({ FAKE_WEBHOOK: webhookInfo({ url: '' }) })).toMatch(
      /Webhook: o'rnatilmagan/,
    );
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    expect(
      twice({ FAKE_WEBHOOK: webhookInfo({ pending_update_count: 250 }) }),
    ).toMatch(/Webhook: navbatda 250 ta update/);
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    expect(
      twice({
        FAKE_WEBHOOK: webhookInfo({
          last_error_date: now - 120,
          last_error_message: 'Wrong response from the webhook: 503',
        }),
      }),
    ).toMatch(/Webhook: Telegram yetkaza olmadi \(Wrong response/);
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    expect(
      twice({
        FAKE_WEBHOOK: webhookInfo({
          last_error_date: now - 3600,
          last_error_message: 'old',
        }),
      }),
    ).toMatch(/state=ok/);
  });

  it('⭐ TELEGRAM_WEBHOOK_URL berilsa — aniq tenglik (suffix yetmaydi)', () => {
    writeEnv(`TELEGRAM_WEBHOOK_URL=${HOOK_URL}\n`);
    expect(
      twice({
        FAKE_WEBHOOK: webhookInfo({
          url: 'https://attacker.example/telegram/webhook/elchi',
        }),
      }),
    ).toMatch(/Webhook: boshqa manzil \(TELEGRAM_WEBHOOK_URL kutilgan\)/);
  });

  it('webhook faqat webhook rejimida tekshiriladi (resolveBotConfig kabi): secret yo‘q / polling / off', () => {
    const empty = { FAKE_WEBHOOK: '{"ok":true,"result":{"url":""}}' };
    writeFileSync(
      join(dir, 'app', '.env.production'),
      `TELEGRAM_BOT_TOKEN=${MAIN_TOKEN}\nTELEGRAM_BOT_MODE= Polling \n`,
    );
    expect(twice(empty)).toMatch(/state=ok/);
    writeFileSync(
      join(dir, 'app', '.env.production'),
      `TELEGRAM_BOT_TOKEN=${MAIN_TOKEN}\nTELEGRAM_BOT_MODE=auto\nBOT_POLLING_LEADER=true\n`,
    );
    expect(twice(empty)).toMatch(/state=ok/);
    writeFileSync(
      join(dir, 'app', '.env.production'),
      `TELEGRAM_BOT_TOKEN=${MAIN_TOKEN}\nTELEGRAM_BOT_MODE=off\nTELEGRAM_WEBHOOK_SECRET=${SECRET}\n`,
    );
    expect(twice(empty)).toMatch(/state=ok/);
  });

  it('⭐ outbox: eski pending, ko‘p dead, qotgan sending, SQL bajarilmadi; SQL faqat o‘qiydi, timeout bilan', () => {
    expect(twice({ FAKE_PSQL: '900\\n0\\n0' })).toMatch(
      /Outbox: eng eski kutilayotgan xabar 15 daq/,
    );
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    expect(twice({ FAKE_PSQL: '0\\n35\\n0' })).toMatch(
      /Outbox: oxirgi soatda 35 ta dead/,
    );
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    expect(twice({ FAKE_PSQL: '0\\n0\\n4' })).toMatch(
      /Outbox: 4 ta xabar 'sending' holatida qotgan/,
    );
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    expect(twice({ FAKE_PSQL: '' })).toMatch(/Outbox: tekshirib bo'lmadi/);
    const log = calls();
    expect(log).toMatch(/BEGIN READ ONLY; SELECT/);
    expect(log).toMatch(/psql -X -q -t -A -v ON_ERROR_STOP=1/);
    expect(log).toMatch(
      /PGOPTIONS=-c statement_timeout=10s -c lock_timeout=5s/,
    );
    expect(log).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/);
  });

  it('⭐ docker qotsa — timeout, «tekshirib bo‘lmadi» (jarayon to‘planmaydi)', () => {
    const started = Date.now();
    run({ FAKE_DOCKER_HANG: '1', BOT_ALERT_CMD_TIMEOUT: '1' });
    const out = run(
      {
        FAKE_DOCKER_HANG: '1',
        BOT_ALERT_CMD_TIMEOUT: '1',
        BOT_ALERT_NOW: String(now + 300),
      },
      ['--dry-run'],
    ).stdout;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(out).toMatch(/Outbox: tekshirib bo'lmadi/);
    expect(out).toMatch(/notification-service: tekshirib bo'lmadi/);
  });

  it('⭐ konteyner: o‘chiq, restarting, topilmadi, bir nechta mos — muammo; compose filtrlari', () => {
    expect(
      twice({ FAKE_ns1: `restarting healthy 3 ${startedLongAgo}` }),
    ).toMatch(/notification-service: restarting healthy/);
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    expect(twice({ FAKE_NS_IDS: '' })).toMatch(
      /notification-service: konteyner topilmadi/,
    );
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    expect(twice({ FAKE_NS_IDS: 'ns1\\nns2\\n' })).toMatch(
      /notification-service: 2 ta konteyner mos keldi/,
    );
    writeConf('BOT_ALERT_COMPOSE_PROJECT=elchi\n');
    run({ BOT_ALERT_NOW: String(now + 900) });
    expect(calls()).toMatch(
      /--filter label=com\.docker\.compose\.oneoff=False --filter label=com\.docker\.compose\.project=elchi/,
    );
  });

  it('⭐ healthcheck «starting»: yangi ishga tushgan — ok; grace’dan eski — muammo', () => {
    const fresh = new Date((now - 20) * 1000).toISOString();
    expect(twice({ FAKE_ns1: `running starting 0 ${fresh}` })).toMatch(
      /state=ok/,
    );
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    expect(twice({ FAKE_ns1: `running starting 0 ${startedLongAgo}` })).toMatch(
      /healthcheck 90s dan beri 'starting'/,
    );
  });

  it('⭐ crash-loop: RestartCount o‘ssa — muammo, yolg‘on «tiklandi» yo‘q', () => {
    const fresh = (s: number) => new Date((now + s - 20) * 1000).toISOString();
    run({ FAKE_ns1: `running healthy 1 ${startedLongAgo}` });
    run({
      FAKE_ns1: `running starting 2 ${fresh(300)}`,
      BOT_ALERT_NOW: String(now + 300),
    });
    run({
      FAKE_ns1: `running starting 3 ${fresh(600)}`,
      BOT_ALERT_NOW: String(now + 600),
    });
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatch(
      /qayta ishga tushmoqda \(2 marta 30 daq ichida, RestartCount 3\)/,
    );
    run({
      FAKE_ns1: `running starting 4 ${fresh(900)}`,
      BOT_ALERT_NOW: String(now + 900),
    });
    expect(sends().join('\n')).not.toMatch(/tiklandi/);
  });

  it('⭐ takrorsiz: 1 xabar (alohida bot, token faqat stdin); 6 soatgacha jim; eslatma; «tiklandi»; holat/log 0600', () => {
    const bad = { FAKE_ns1: `exited no-healthcheck 0 ${startedLongAgo}` };
    run(bad);
    expect(run({ ...bad, BOT_ALERT_NOW: String(now + 300) }).status).toBe(1);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatch(/-K -/);
    expect(calls()).not.toContain(MAIN_TOKEN);
    expect(calls()).not.toContain(ALERT_TOKEN);
    expect(readFileSync(join(dir, 'calls.log.stdin'), 'utf8')).toContain(
      `bot${ALERT_TOKEN}/sendMessage`,
    );
    run({ ...bad, BOT_ALERT_NOW: String(now + 900) });
    expect(sends()).toHaveLength(1);
    run({ ...bad, BOT_ALERT_NOW: String(now + 7 * 3600) });
    expect(sends()).toHaveLength(2);
    // Tiklanish ham debounce: 1-toza yugurish — jim, 2-chisi — «tiklandi».
    run({ BOT_ALERT_NOW: String(now + 7 * 3600 + 300) });
    expect(sends()).toHaveLength(2);
    run({ BOT_ALERT_NOW: String(now + 7 * 3600 + 600) });
    expect(sends()).toHaveLength(3);
    expect(sends()[2]).toMatch(/tiklandi/);
    expect(logText()).not.toContain(MAIN_TOKEN);
    expect(logText()).not.toContain(ALERT_TOKEN);
    for (const file of [
      join(dir, 'ops', 'logs', 'bot-alert.log'),
      join(dir, 'ops', 'state', 'bot-alert.state'),
    ]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('signature faqat tekshiruv kodi: son o‘zgarsa (15 → 16 daq) yangi xabar ketmaydi', () => {
    run({ FAKE_PSQL: '900\\n0\\n0' });
    run({ FAKE_PSQL: '960\\n0\\n0', BOT_ALERT_NOW: String(now + 300) });
    run({ FAKE_PSQL: '1020\\n0\\n0', BOT_ALERT_NOW: String(now + 600) });
    expect(sends()).toHaveLength(1);
    expect(
      readFileSync(join(dir, 'ops', 'state', 'bot-alert.state'), 'utf8'),
    ).toMatch(/^sig=outbox_pending$/m);
  });

  it('⭐ yuborish yiqilsa holat oldinga surilmaydi — keyingi yugurish qayta yuboradi', () => {
    const bad = { FAKE_ns1: `exited no-healthcheck 0 ${startedLongAgo}` };
    run(bad);
    run({ ...bad, FAKE_SEND_FAIL: '1', BOT_ALERT_NOW: String(now + 300) });
    expect(
      readFileSync(join(dir, 'ops', 'state', 'bot-alert.state'), 'utf8'),
    ).toMatch(/^state=ok$/m);
    run({ ...bad, BOT_ALERT_NOW: String(now + 600) });
    expect(sends().filter((line) => line.includes('NOSOG'))).toHaveLength(2);
    expect(
      readFileSync(join(dir, 'ops', 'state', 'bot-alert.state'), 'utf8'),
    ).toMatch(/^state=problem$/m);
  });

  it('⭐ alert boti asosiy bot bilan bir xil — rad etiladi', () => {
    writeConf(
      `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${MAIN_TOKEN}\n`,
    );
    const bad = { FAKE_ns1: `exited x 0 ${startedLongAgo}` };
    run(bad);
    run({ ...bad, BOT_ALERT_NOW: String(now + 300) });
    expect(sends()).toEqual([]);
    expect(logText()).toMatch(/asosiy bot bilan bir xil — rad etildi/);
  });

  it('⭐ config: qator oxiridagi izoh, CRLF va qo‘shtirnoq qiymatga qo‘shilmaydi (izohli token ham rad etiladi)', () => {
    writeConf(
      [
        'BOT_ALERT_WEBHOOK_URL="https://ntfy.test/elchi-bot"   # ntfy topic',
        "BOT_ALERT_TELEGRAM_CHAT_ID='42'\r",
        `BOT_ALERT_TELEGRAM_BOT_TOKEN=${MAIN_TOKEN}  # asosiy bilan bir xil`,
        'BOT_ALERT_HEARTBEAT_URL=https://hc.test/ping/abc # dead-man',
        '',
      ].join('\n'),
    );
    const bad = { FAKE_ns1: `exited x 0 ${startedLongAgo}` };
    run(bad);
    run({ ...bad, BOT_ALERT_NOW: String(now + 300) });
    const stdin = readFileSync(join(dir, 'calls.log.stdin'), 'utf8');
    expect(stdin).toContain('url = "https://ntfy.test/elchi-bot"\n');
    expect(stdin).toContain('url = "https://hc.test/ping/abc/fail"\n');
    expect(stdin).not.toContain('#');
    // Izoh olib tashlangach token asosiy bilan bir xil — Telegram kanali rad etiladi.
    expect(sends()).toEqual([]);
    expect(logText()).toMatch(/asosiy bot bilan bir xil — rad etildi/);
  });

  it('webhook kanali (ntfy) va heartbeat: ok → GET url, muammo → GET url/fail; URL’lar argv’da yo‘q', () => {
    writeConf(
      'BOT_ALERT_WEBHOOK_URL=https://ntfy.test/elchi-bot\nBOT_ALERT_HEARTBEAT_URL=https://hc.test/ping/abc\n',
    );
    const bad = { FAKE_ns1: `exited x 0 ${startedLongAgo}` };
    expect(run().status).toBe(0);
    run({ ...bad, BOT_ALERT_NOW: String(now + 300) });
    run({ ...bad, BOT_ALERT_NOW: String(now + 600) });
    const stdin = readFileSync(join(dir, 'calls.log.stdin'), 'utf8');
    expect(stdin).toContain('url = "https://hc.test/ping/abc"');
    expect(stdin).toContain('url = "https://hc.test/ping/abc/fail"');
    expect(stdin).toContain('url = "https://ntfy.test/elchi-bot"');
    expect(calls()).not.toContain('ntfy.test');
    expect(calls()).not.toContain('hc.test');
  });

  it('--test xabar yuboradi va heartbeat’ni tekshiradi; --dry-run hech narsa yubormaydi, holatni o‘zgartirmaydi', () => {
    writeConf(
      `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${ALERT_TOKEN}\nBOT_ALERT_HEARTBEAT_URL=https://hc.test/ping/abc\n`,
    );
    run({}, ['--test']);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatch(/test xabar/);
    expect(logText()).toMatch(/test: heartbeat ok/);
    const r = run({ FAKE_ns1: `exited x 0 ${startedLongAgo}` }, ['--dry-run']);
    expect(r.stdout).toMatch(/send=none raw=ns_unhealthy/);
    expect(sends()).toHaveLength(1);
    expect(existsSync(join(dir, 'ops', 'state', 'bot-alert.state'))).toBe(
      false,
    );
  });

  it('kanal sozlanmagan — faqat log satri', () => {
    rmSync(join(dir, 'ops', 'bot-alert.env'));
    const bad = { FAKE_ns1: `exited x 0 ${startedLongAgo}` };
    run(bad);
    expect(run({ ...bad, BOT_ALERT_NOW: String(now + 300) }).status).toBe(1);
    expect(sends()).toEqual([]);
    expect(logText()).toMatch(/kanal sozlanmagan/);
  });
  it('⭐ to‘plam almashsa yolg‘on «tiklandi» yo‘q: ns tasdiqlangan → ns yaxshi, yangi outbox muammo → jim → outbox tasdiqlanadi', () => {
    const ns = { FAKE_ns1: `exited x 0 ${startedLongAgo}` };
    run(ns);
    run({ ...ns, BOT_ALERT_NOW: String(now + 300) });
    expect(sends()).toHaveLength(1);
    run({ FAKE_PSQL: '900\\n0\\n0', BOT_ALERT_NOW: String(now + 600) });
    expect(sends()).toHaveLength(1);
    run({ FAKE_PSQL: '900\\n0\\n0', BOT_ALERT_NOW: String(now + 900) });
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toMatch(/Outbox: eng eski kutilayotgan xabar/);
    expect(sends().join('\n')).not.toMatch(/tiklandi/);
  });

  it('⭐ sekin crash-loop (~10 daqiqada bir restart) — xabar keladi', () => {
    const at = (s: number, n: number, h = 'healthy') => ({
      FAKE_ns1: `running ${h} ${n} ${new Date((now + s - 400) * 1000).toISOString()}`,
      BOT_ALERT_NOW: String(now + s),
    });
    run(at(0, 0));
    run(at(300, 0));
    run(at(600, 1)); // restart, keyingi tekshiruvda yana healthy
    run(at(900, 1));
    run(at(1200, 2));
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatch(/qayta ishga tushmoqda \(2 marta/);
  });

  it('⭐ problem → «starting» (RestartCount o‘smagan) darhol «tiklandi» bermaydi', () => {
    const bad = { FAKE_ns1: `exited x 0 ${startedLongAgo}` };
    run(bad);
    run({ ...bad, BOT_ALERT_NOW: String(now + 300) });
    expect(sends()).toHaveLength(1);
    const fresh = new Date((now + 600 - 20) * 1000).toISOString();
    run({
      FAKE_ns1: `running starting 0 ${fresh}`,
      BOT_ALERT_NOW: String(now + 600),
    });
    expect(sends()).toHaveLength(1);
    run({ ...bad, BOT_ALERT_NOW: String(now + 900) });
    expect(sends().join('\n')).not.toMatch(/tiklandi/);
  });

  it('⭐ flapping (har ikkinchi yugurishda yiqiladi) — alert keladi, «tiklandi» ketma-ket 2 toza yugurishdan keyin', () => {
    const bad = { FAKE_ns1: `exited x 0 ${startedLongAgo}` };
    run(bad);
    run({ BOT_ALERT_NOW: String(now + 300) });
    run({ ...bad, BOT_ALERT_NOW: String(now + 600) });
    expect(sends()).toHaveLength(1);
    run({ BOT_ALERT_NOW: String(now + 900) });
    run({ ...bad, BOT_ALERT_NOW: String(now + 1200) });
    expect(sends()).toHaveLength(1);
    run({ BOT_ALERT_NOW: String(now + 1500) });
    run({ BOT_ALERT_NOW: String(now + 1800) });
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toMatch(/tiklandi/);
  });

  it('eski state formati (raw= yo‘q, state=problem) — yangilanishdan keyin yolg‘on «tiklandi» yo‘q', () => {
    mkdirSync(join(dir, 'ops', 'state'), { recursive: true });
    writeFileSync(
      join(dir, 'ops', 'state', 'bot-alert.state'),
      `state=problem\nsig=abc\nsince=${now - 600}\nlast_sent=${now - 600}\nchecked_at=${now - 300}\n`,
    );
    run({ FAKE_ns1: `exited x 0 ${startedLongAgo}` });
    run({ BOT_ALERT_NOW: String(now + 300) });
    expect(sends().join('\n')).not.toMatch(/tiklandi/);
  });

  it('⭐ «tiklandi» yuborilmasa — keyingi yugurishda qayta yuboriladi', () => {
    const bad = { FAKE_ns1: `exited x 0 ${startedLongAgo}` };
    run(bad);
    run({ ...bad, BOT_ALERT_NOW: String(now + 300) });
    run({ BOT_ALERT_NOW: String(now + 600) });
    run({ FAKE_SEND_FAIL: '1', BOT_ALERT_NOW: String(now + 900) });
    expect(sends().filter((line) => line.includes('tiklandi'))).toHaveLength(1);
    run({ BOT_ALERT_NOW: String(now + 1200) });
    expect(sends().filter((line) => line.includes('tiklandi'))).toHaveLength(2);
    expect(
      readFileSync(join(dir, 'ops', 'state', 'bot-alert.state'), 'utf8'),
    ).toMatch(/^state=ok$/m);
  });

  it('⭐ flock: bir vaqtda ikkinchi nusxa — cron jim (0), --dry-run aniq xabar bilan (3)', () => {
    mkdirSync(join(dir, 'ops', 'state'), { recursive: true });
    const lock = join(dir, 'ops', 'state', 'bot-alert.lock');
    const holder = (args: string) =>
      spawnSync(
        'bash',
        ['-c', `exec 8>"${lock}"; flock 8; bash "${SCRIPT}" ${args}`],
        {
          encoding: 'utf8',
          env: {
            PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
            HOME: dir,
            ELCHI_APP_DIR: join(dir, 'app'),
            ELCHI_OPS_DIR: join(dir, 'ops'),
            FAKE_LOG: join(dir, 'calls.log'),
            ...healthy,
            FAKE_ns1: `exited x 0 ${startedLongAgo}`,
          },
        },
      );
    expect(holder('').status).toBe(0);
    const dry = holder('--dry-run');
    expect(dry.status).toBe(3);
    expect(dry.stderr).toMatch(/boshqa nusxa ishlayapti/);
    expect(calls()).not.toMatch(/docker/);
  });

  it('docker inspect: «No such object» — topilmadi; boshqa xato — tekshirib bo‘lmadi', () => {
    expect(twice({ FAKE_NS_IDS: 'gone\\n' })).toMatch(
      /notification-service: konteyner topilmadi \(gone\)/,
    );
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    expect(
      twice({ FAKE_INSPECT_ERR: 'Cannot connect to the Docker daemon' }),
    ).toMatch(
      /notification-service: tekshirib bo'lmadi \(docker inspect: kod 1\)/,
    );
  });

  it('config: qo‘shtirnoqli qiymat ichidagi « #» saqlanadi; placeholder token — bot o‘chiq (webhook tekshirilmaydi)', () => {
    writeConf('BOT_ALERT_WEBHOOK_URL="https://ntfy.test/elchi #bot"  # izoh\n');
    const bad = { FAKE_ns1: `exited x 0 ${startedLongAgo}` };
    run(bad);
    run({ ...bad, BOT_ALERT_NOW: String(now + 300) });
    expect(readFileSync(join(dir, 'calls.log.stdin'), 'utf8')).toContain(
      'url = "https://ntfy.test/elchi #bot"\n',
    );
    rmSync(join(dir, 'ops', 'state'), { recursive: true, force: true });
    writeFileSync(
      join(dir, 'app', '.env.production'),
      `TELEGRAM_BOT_TOKEN=123:Your_Token_Here\nTELEGRAM_WEBHOOK_SECRET=${SECRET}\n`,
    );
    expect(
      twice({ FAKE_WEBHOOK: '{"ok":true,"result":{"url":""}}' }),
    ).not.toMatch(/Webhook:/);
  });
  // -------------------------------------------------------------------------
  // Jadvalli stsenariy simulyatsiyasi: har qadam = bitta yugurish (+300 s).
  // Natija qatori: har qadam uchun '.' (xabar yo'q), 'A' (NOSOG'LOM), 'R' (tiklandi).
  // -------------------------------------------------------------------------
  describe('stsenariy simulyatsiyasi (jadval)', () => {
    jest.setTimeout(120_000);
    type Step = Record<string, string>;
    const at = (i: number) => now + i * 300;
    const iso = (t: number) => new Date(t * 1000).toISOString();
    const ns = (
      i: number,
      restarts = 0,
      health = 'healthy',
      startedAgo = 3600,
    ) => ({
      FAKE_ns1: `running ${health} ${restarts} ${iso(at(i) - startedAgo)}`,
    });
    const A = { FAKE_ns1: `exited x 0 ${startedLongAgo}` }; // ns_unhealthy
    const B = { FAKE_PSQL: '900\\n0\\n0' }; // outbox_pending
    const C = { FAKE_PSQL: '0\\n50\\n0' }; // outbox_dead
    const D = { FAKE_WEBHOOK: webhookInfo({ pending_update_count: 500 }) }; // webhook_pending
    const T = () => ({ FAKE_GETME_CODE: '401', FAKE_GETME: '{"ok":false}' }); // token_invalid
    // Satr ko'rinishidagi stsenariy: A ns, e/B outbox, D webhook, T 401, o ok.
    const seq = (ch: string) => () =>
      (({ A, B, e: B, D, T: T(), o: {} }) as Record<string, Step>)[ch];
    const simulate = (steps: Array<(i: number) => Step>, extra: Step = {}) => {
      let seen = 0;
      return steps
        .map((step, i) => {
          run({ ...extra, ...step(i), BOT_ALERT_NOW: String(at(i)) });
          const all = sends();
          const fresh = all.slice(seen);
          seen = all.length;
          if (!fresh.length) return '.';
          return fresh
            .map((line) => (line.includes('tiklandi') ? 'R' : 'A'))
            .join('');
        })
        .join('');
    };
    const ok = () => ({});

    it.each<[string, () => Array<(i: number) => Step>, string, Step]>([
      [
        'A) barqaror A + B flapping (A, AB, A, AB…) — 2 xabar, soatiga 11 emas',
        () =>
          Array.from({ length: 12 }, (_, k) =>
            k % 2 ? () => ({ ...A, ...B }) : () => A,
          ),
        '.A.A........',
        {},
      ],
      [
        'B) 20 daqiqalik crash-loop — 2-restartda bitta alert, sikl ichida «tiklandi» yo‘q; to‘xtagach oyna tugashi (+2 toza) → bitta «tiklandi»',
        () =>
          Array.from({ length: 25 }, (_, k) => (i: number) => {
            const restarts = Math.min(Math.floor((k + 4) / 4), 5);
            const lastRestart = Math.min(Math.floor(k / 4) * 4, 16);
            return ns(i, restarts, 'healthy', (k - lastRestart) * 300 + 60);
          }),
        '........A...............R',
        {},
      ],
      [
        '10 daqiqalik loop + bir marta docker inspect yiqilishi — bitta alert, flapping yo‘q',
        () =>
          Array.from({ length: 10 }, (_, k) =>
            k === 3
              ? () => ({
                  FAKE_INSPECT_ERR: 'Cannot connect to the Docker daemon',
                })
              : (i: number) =>
                  ns(i, Math.floor(k / 2), 'healthy', (k % 2) * 300 + 60),
          ),
        '....A.....',
        {},
      ],
      [
        'D) A, B, C navbatma-navbat (hech biri ketma-ket takrorlanmaydi) — 3-yugurishda bitta «unstable» alert, aylanish qayta xabar bermaydi',
        () => [() => A, () => B, () => C, () => A, () => B, () => C],
        '..A...',
        {},
      ],
      [
        'tg_unreachable → 401 → tiklanish: har yangi kod — bitta xabar, oraliqda «tiklandi» yo‘q; 2 toza yugurishdan keyin «tiklandi»',
        () => [
          () => ({ FAKE_GETME_EXIT: '28' }),
          () => ({ FAKE_GETME_EXIT: '28' }),
          () => ({ FAKE_GETME_CODE: '401', FAKE_GETME: '{"ok":false}' }),
          () => ({ FAKE_GETME_CODE: '401', FAKE_GETME: '{"ok":false}' }),
          ok,
          ok,
          ok,
        ],
        '.A.A.R.',
        {},
      ],
      [
        "'08' config (oktal emas) — skript yiqilmaydi, crash-loop alert",
        () =>
          Array.from(
            { length: 4 },
            (_, k) => (i: number) => ns(i, k, 'healthy', 60),
          ),
        '..A.',
        { BOT_ALERT_RESTART_WINDOW_MIN: '08' },
      ],
      // --- #607 yakuniy tekshiruvi (follow-up) -------------------------------
      [
        '1) AoAoTTTT — hamma narsa yiqilgan holda yolg‘on «tiklandi» yo‘q (yangi kod tasdiqlanguncha jim), keyin 401 alert',
        () => [() => A, ok, () => A, ok, T, T, T, T],
        '..A..A..',
        {},
      ],
      [
        '1) AAAoBooo — tasdiqlanmagan B: tiklanish dumida «unstable» ham, yolg‘on «tiklandi» ham yo‘q; 2 toza yugurishdan keyin «tiklandi»',
        () => [() => A, () => A, () => A, ok, () => B, ok, ok, ok],
        '.A....R.',
        {},
      ],
      [
        '3) AAoTTT — tiklanish paytida yolg‘on «unstable» yo‘q, 401 2-yugurishda alert',
        () => [() => A, () => A, ok, T, T, T],
        '.A..A.',
        {},
      ],
      [
        '2) AAoT sikli 40 yugurish — bitta alert (hodisa bo‘yi alerted to‘plami), 11 emas',
        () =>
          Array.from({ length: 40 }, (_, k) =>
            k % 4 === 3 ? T : k % 4 === 2 ? ok : () => A,
          ),
        '.A' + '.'.repeat(38),
        {},
      ],
      [
        '2) SRSSR tez loop (restarting ↔ starting) 2,5 soat — bitta alert; ns_unhealthy qaytib kelsa qayta xabar yo‘q',
        () =>
          Array.from({ length: 30 }, (_, k) => (i: number) => {
            const restarts = Array.from({ length: k + 1 }, (_, j) => j).filter(
              (j) => j % 5 === 1 || j % 5 === 4,
            ).length;
            return k % 5 === 1 || k % 5 === 4
              ? {
                  FAKE_ns1: `restarting unhealthy ${restarts} ${iso(at(i) - 30)}`,
                }
              : ns(i, restarts, 'starting', 30);
          }),
        '....A' + '.'.repeat(25),
        {},
      ],
      [
        '2) «doim restarting» — ns_unhealthy va ns_restart bitta sabab: 5 daqiqa farq bilan ikkinchi alert yo‘q',
        () =>
          Array.from({ length: 6 }, (_, k) => (i: number) => ({
            FAKE_ns1: `restarting unhealthy ${k} ${iso(at(i) - 30)}`,
          })),
        '.A....',
        {},
      ],
      [
        '4) 10 daqiqalik loop, har 4-yugurishda docker ps yiqiladi (3 soat) — bitta alert, yolg‘on «tiklandi» yo‘q',
        () =>
          Array.from({ length: 36 }, (_, k) =>
            k % 4 === 3
              ? () => ({ FAKE_PS_FAIL: '1' })
              : (i: number) =>
                  ns(i, Math.floor(k / 2), 'healthy', (k % 2) * 300 + 60),
          ),
        '....A' + '.'.repeat(31),
        {},
      ],
      [
        '5) aynan 30 daqiqalik loop (oyna = davr) — StartedAt + 1 interval zaxira bilan ushlanadi',
        () =>
          Array.from({ length: 20 }, () => (i: number) => {
            const since = at(i) - (now + 150);
            const restarts = since < 0 ? 0 : Math.floor(since / 1800) + 1;
            return ns(i, restarts, 'healthy', since < 0 ? 3600 : since % 1800);
          }),
        '.......A............',
        {},
      ],
      [
        '7) ikki shovqinli tekshiruv (A, B, ok, A …) — 2 xil kod «unstable» bermaydi',
        () => {
          const burst = [() => A, () => B, ok, () => A];
          const quiet = Array.from({ length: 8 }, () => ok);
          return [...burst, ...quiet, () => B, () => A, ok, () => B, ...quiet];
        },
        '.'.repeat(24),
        {},
      ],
      [
        '7) A/B/C/D/ok/ok aylanishi — bitta «unstable», «tiklandi», tez qaytgach qayta «unstable» va endi 4 toza yugurish kerak',
        () =>
          Array.from(
            { length: 24 },
            (_, k) => [() => A, () => B, () => C, () => D, ok, ok][k % 6],
          ),
        '..A..R..A' + '.'.repeat(15),
        {},
      ],
      [
        '8) bitta tekshiruv FFPP flapping 2 soat — tiklanishdan 60 daq ichida qaytsa, chiqish uchun 4 toza yugurish (6A+6R emas)',
        () => Array.from({ length: 24 }, (_, k) => (k % 4 < 2 ? () => A : ok)),
        '.A.R.A' + '.'.repeat(18),
        {},
      ],
      // --- #609 tekshiruvi: 4 toza yugurishdan keyin kod ALERTED'dan chiqadi ----------
      [
        'G1) TTAATTTTTTAAAATTTTTT — hodisa ochiq turganda 401 4 toza yugurishdan keyin qaytsa, yana alert',
        () => [...'TTAATTTTTTAAAATTTTTT'].map(seq),
        '.A.A.......A...A....',
        {},
      ],
      [
        'G1) AAAATTTTTTAAAATTTTTT — konteyner 6 yugurishdan keyin yana exit, alert',
        () => [...'AAAATTTTTTAAAATTTTTT'].map(seq),
        '.A...A.....A...A....',
        {},
      ],
      [
        'G1) AAooAAeeooDooTTTTTT — flap hodisasi ichida yangi 401 2-yugurishda alert',
        () => [...'AAooAAeeooDooTTTTTT'].map(seq),
        '.A.R.A.A....R.A....',
        {},
      ],
      [
        'G1) M3: ns_unhealthy alert, hodisa outbox bilan ochiq, 1 soatdan keyin crash-loop — alert',
        () =>
          Array.from({ length: 20 }, (_, k) => (i: number) => {
            if (k < 2) return { ...A, ...B };
            const restarts = k < 14 ? 0 : k - 13;
            return { ...B, ...ns(i, restarts, 'healthy', 60) };
          }),
        '.A.............A....',
        {},
      ],
      [
        'G1/HOLD) AAoDoBoDoBAAAAAAoo — hodisa tasdiqlanmagan shovqin bilan HOLDda, ns ≥ 4 toza yugurishdan keyin yana yiqilsa — alert',
        () => [...'AAoDoBoDoBAAAAAAoo'].map(seq),
        '.A.........A.....R',
        {},
      ],
      [
        'G1/HOLD) AAoDoBAAAAAAoo — aniq 4 toza yugurishdan keyin qayta buzilish — alert',
        () => [...'AAoDoBAAAAAAoo'].map(seq),
        '.A.....A.....R',
        {},
      ],
    ])('%s', (_label, steps, expected, extra) => {
      if (Object.keys(extra).length) {
        writeConf(
          `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${ALERT_TOKEN}\n` +
            Object.entries(extra)
              .map(([k, v]) => `${k}=${v}\n`)
              .join(''),
        );
      }
      expect(simulate(steps())).toBe(expected);
      if (Object.keys(extra).length)
        expect(logText()).not.toMatch(/value too great|syntax error/);
    });

    it('flapping (F, P, F, P…) 6 soatdan ortiq — bitta alert + 6 soatlik eslatma, «tiklandi» yo‘q', () => {
      const steps = Array.from({ length: 80 }, (_, k) =>
        k % 2 ? ok : () => A,
      );
      const result = simulate(steps);
      expect(result.replace(/\./g, '')).toBe('AA');
      expect(result.indexOf('A')).toBe(2);
      expect(
        result.lastIndexOf('A') - result.indexOf('A'),
      ).toBeGreaterThanOrEqual(72);
    });

    const legacyState = (state: 'ok' | 'problem') => {
      mkdirSync(join(dir, 'ops', 'state'), { recursive: true });
      writeFileSync(
        join(dir, 'ops', 'state', 'bot-alert.state'),
        `state=${state}\nsig=abc\nsince=${now - 600}\nlast_sent=${now - 600}\nchecked_at=${now - 300}\n`,
      );
    };
    it('6) eski state (ok) + yangilanish yugurishida blip — darhol alert yo‘q', () => {
      legacyState('ok');
      expect(simulate([() => A, ok, ok])).toBe('...');
    });
    it('6) eski state (problem) + sog‘lom — «tiklandi» 2-toza yugurishda (1-sida emas)', () => {
      legacyState('problem');
      expect(simulate([ok, ok, ok])).toBe('.R.');
    });
    it('#609-2) hold eslatmasi: tiklangan kod «tiklangan, boshqa tekshiruvlar hali beqaror» deb yoziladi', () => {
      mkdirSync(join(dir, 'ops', 'state'), { recursive: true });
      writeFileSync(
        join(dir, 'ops', 'state', 'bot-alert.state'),
        `state=problem\nsig=ns_unhealthy\nraw=outbox_pending\nraw2=\nraw3=\nsince=${now - 8 * 3600}\nlast_sent=${now - 7 * 3600}\nalerted=ns_unhealthy\n`,
      );
      const out = run(T(), ['--dry-run']).stdout;
      expect(out).toMatch(/send=problem/);
      expect(out).toMatch(
        /ns_unhealthy: tiklangan, boshqa tekshiruvlar hali beqaror/,
      );
      expect(out).toMatch(/Hali tasdiqlanmagan: token_invalid/);
    });
    it('#609-3) ulkan qiymat (200000000000000000) — toshib ketmaydi: WARN + sukut', () => {
      writeConf(
        `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${ALERT_TOKEN}\nBOT_ALERT_FLAP_WINDOW_MIN=200000000000000000\nBOT_ALERT_RESTART_WINDOW_MIN=200000000000000000\n`,
      );
      expect(
        simulate(
          Array.from({ length: 12 }, (_, k) => (k % 4 < 2 ? () => A : ok)),
        ),
      ).toBe('.A.R.A......');
      expect(logText()).toMatch(
        /FLAP_WINDOW_MIN=200000000000000000 rad etildi/,
      );
      expect(logText()).toMatch(
        /RESTART_WINDOW_MIN=200000000000000000 rad etildi/,
      );
    });
    it('knob) FLAP_WINDOW_MIN=10 amalda ishlamaydi — rad etiladi (11..10080), 60 ishlatiladi', () => {
      writeConf(
        `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${ALERT_TOKEN}\nBOT_ALERT_FLAP_WINDOW_MIN=10\n`,
      );
      expect(
        simulate(
          Array.from({ length: 12 }, (_, k) => (k % 4 < 2 ? () => A : ok)),
        ),
      ).toBe('.A.R.A......');
      expect(logText()).toMatch(
        /BOT_ALERT_FLAP_WINDOW_MIN=10 rad etildi \(11\.\.10080\) — 60/,
      );
    });
    it('knob) bosh nollar: OUTBOX_PENDING_MIN=0000000000000010 — qiymati 10 (o‘chib qolmaydi), WARN yo‘q', () => {
      writeConf(
        `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${ALERT_TOKEN}\nBOT_ALERT_OUTBOX_PENDING_MIN=0000000000000010\nBOT_ALERT_RESTART_WINDOW_MIN=0000000000000045\n`,
      );
      expect(twice({ FAKE_PSQL: '900\\n0\\n0' })).toMatch(
        /Outbox: eng eski kutilayotgan xabar 15 daq \(chegara 10\)/,
      );
      expect(logText()).not.toMatch(/rad etildi/);
    });
    it('knob) yaroqsiz qiymatlar — xom qiymat bilan WARN + sukut; sog‘ tizimda alert yo‘q', () => {
      writeConf(
        `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${ALERT_TOKEN}\n` +
          'BOT_ALERT_RESTART_WINDOW_MIN=45m\nBOT_ALERT_FLAP_WINDOW_MIN=-5\nBOT_ALERT_REPEAT_HOURS=0\n' +
          'BOT_ALERT_OUTBOX_PENDING_MIN=0\nBOT_ALERT_PENDING_UPDATES_MAX=0\nBOT_ALERT_WEBHOOK_ERROR_MIN=0\n' +
          'BOT_ALERT_CMD_TIMEOUT=1e9\n',
      );
      expect(twice({})).toMatch(/state=ok/);
      expect(sends()).toEqual([]);
      const log = logText();
      for (const re of [
        /RESTART_WINDOW_MIN=45m rad etildi \(1\.\.10080\) — 30/,
        /FLAP_WINDOW_MIN=-5 rad etildi \(11\.\.10080\) — 60/,
        /REPEAT_HOURS=0 rad etildi \(1\.\.720\) — 6/,
        /OUTBOX_PENDING_MIN=0 rad etildi \(1\.\.10080\) — 10/,
        /PENDING_UPDATES_MAX=0 rad etildi \(1\.\.100000000\) — 100/,
        /WEBHOOK_ERROR_MIN=0 rad etildi \(1\.\.10080\) — 15/,
        /CMD_TIMEOUT=1e9 rad etildi \(1\.\.600\) — 30/,
      ])
        expect(log).toMatch(re);
    });
    it('#609-3) BOT_ALERT_FLAP_WINDOW_MIN=0 — rad etiladi (ogohlantirish), 60 ishlatiladi', () => {
      writeConf(
        `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${ALERT_TOKEN}\nBOT_ALERT_FLAP_WINDOW_MIN=0\n`,
      );
      expect(
        simulate(
          Array.from({ length: 24 }, (_, k) => (k % 4 < 2 ? () => A : ok)),
        ),
      ).toBe('.A.R.A' + '.'.repeat(18));
      expect(logText()).toMatch(/FLAP_WINDOW_MIN=0 rad etildi/);
    });
    it('5) BOT_ALERT_RESTART_WINDOW_MIN=0 — rad etiladi (ogohlantirish), crash-loop baribir ushlanadi', () => {
      writeConf(
        `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${ALERT_TOKEN}\nBOT_ALERT_RESTART_WINDOW_MIN=0\n`,
      );
      const steps = Array.from(
        { length: 4 },
        (_, k) => (i: number) => ns(i, k * 2, 'healthy', 60),
      );
      // RestartCount yugurishlar orasida 2 ga o'sdi — 2 restart, darhol crash-loop.
      expect(simulate(steps)).toBe('.A..');
      expect(logText()).toMatch(/RESTART_WINDOW_MIN=0 rad etildi/);
    });

    it('401 da webhook tekshiruvi o‘tkazib yuboriladi (ikkinchi soxta qator yo‘q)', () => {
      const out = twice({ FAKE_GETME_CODE: '401', FAKE_GETME: '{"ok":false}' });
      expect(out).toMatch(/Token: getMe 401/);
      expect(out).not.toMatch(/getWebhookInfo/);
    });
  });
});
