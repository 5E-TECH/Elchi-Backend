import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * zDUUxyH2 — scripts/bot-alert.sh (cron, har 5 daqiqa): soxta `docker` va
 * `curl` bilan (tarmoq va Docker yo'q). Har tekshiruv soxta javob bilan;
 * sir (bot tokenlari) argv'ga ham, logga ham tushmaydi.
 */
const ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'bot-alert.sh');
const MAIN_TOKEN = '111111:MAIN-BOT-TOKEN-never-in-argv';
const ALERT_TOKEN = '222222:ALERT-BOT-TOKEN-never-in-argv';
const OK_WEBHOOK =
  '{"ok":true,"result":{"url":"https://api.elchi.test/telegram/webhook/elchi","pending_update_count":0}}';

// docker ps -q --filter … -> $FAKE_NS_ID; docker inspect … <name> -> $FAKE_<name>;
// docker exec … psql … -> $FAKE_PSQL (two lines: overdue age s, dead count) or fail.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  ps) echo "\${FAKE_NS_ID:-}" ;;
  inspect) name="\${@: -1}"; v="FAKE_\${name//-/_}"; [ -n "\${!v:-}" ] || exit 1; echo "\${!v}" ;;
  exec) [ -n "\${FAKE_PSQL:-}" ] || exit 2; printf '%b\\n' "$FAKE_PSQL" ;;
esac
`;
// curl -K - : URL (with the token) comes on stdin. getMe / getWebhookInfo -> fake JSON.
const FAKE_CURL = `#!/usr/bin/env bash
a="$*"; echo "curl \${a//$'\\n'/ | }" >> "$FAKE_LOG"
cfg="$(cat)"; echo "$cfg" >> "$FAKE_LOG.stdin"
case "$cfg" in
  *getMe*) printf '%s' "\${FAKE_GETME:-{\\"ok\\":true}}" ;;
  *getWebhookInfo*) printf '%s' "$FAKE_WEBHOOK" ;;
  *) echo -n 200 ;;
esac
`;

describe('bot-alert.sh (zDUUxyH2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bot-alert-'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'app'));
    mkdirSync(join(dir, 'ops'));
    writeFileSync(join(dir, 'bin', 'docker'), FAKE_DOCKER);
    writeFileSync(join(dir, 'bin', 'curl'), FAKE_CURL);
    chmodSync(join(dir, 'bin', 'docker'), 0o755);
    chmodSync(join(dir, 'bin', 'curl'), 0o755);
    writeFileSync(
      join(dir, 'app', '.env.production'),
      `TELEGRAM_BOT_TOKEN=${MAIN_TOKEN}\nPOSTGRES_USER=elchi\nPOSTGRES_DB=elchi\n`,
    );
    writeFileSync(
      join(dir, 'ops', 'bot-alert.env'),
      `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${ALERT_TOKEN}\n`,
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const now = Math.floor(Date.now() / 1000);
  const healthy: Record<string, string> = {
    FAKE_NS_ID: 'ns1',
    FAKE_ns1: 'running healthy',
    FAKE_PSQL: '0\\n0',
    FAKE_WEBHOOK: OK_WEBHOOK,
  };
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
  const sends = () =>
    existsSync(join(dir, 'calls.log'))
      ? readFileSync(join(dir, 'calls.log'), 'utf8')
          .split('\n')
          .filter((line) => line.includes('chat_id='))
      : [];
  const dry = (env: Record<string, string>) => run(env, ['--dry-run']).stdout;

  it('⭐ hammasi joyida — xabar yo‘q, chiqish kodi 0', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(sends()).toEqual([]);
  });

  it('⭐ token buzuq (getMe ok:false) — muammo', () => {
    expect(
      dry({ FAKE_GETME: '{"ok":false,"description":"Unauthorized"}' }),
    ).toMatch(/Token: getMe xato \(Unauthorized\)/);
  });

  it('⭐ webhook boshqa manzilda / o‘rnatilmagan / navbat to‘lgan / yaqinda xato', () => {
    expect(
      dry({
        FAKE_WEBHOOK:
          '{"ok":true,"result":{"url":"https://evil.test/hook","pending_update_count":0}}',
      }),
    ).toMatch(/Webhook: boshqa manzil/);
    expect(
      dry({
        FAKE_WEBHOOK:
          '{"ok":true,"result":{"url":"","pending_update_count":0}}',
      }),
    ).toMatch(/Webhook: o'rnatilmagan/);
    expect(
      dry({
        FAKE_WEBHOOK:
          '{"ok":true,"result":{"url":"https://api.elchi.test/telegram/webhook/elchi","pending_update_count":250}}',
      }),
    ).toMatch(/Webhook: navbatda 250 ta update/);
    expect(
      dry({
        FAKE_WEBHOOK: `{"ok":true,"result":{"url":"https://api.elchi.test/telegram/webhook/elchi","pending_update_count":3,"last_error_date":${now - 120},"last_error_message":"Wrong response from the webhook: 503"}}`,
      }),
    ).toMatch(/Webhook: Telegram yetkaza olmadi \(Wrong response/);
    // Eski xato (chegaradan oldin) — muammo emas.
    expect(
      dry({
        FAKE_WEBHOOK: `{"ok":true,"result":{"url":"https://api.elchi.test/telegram/webhook/elchi","pending_update_count":0,"last_error_date":${now - 3600},"last_error_message":"old"}}`,
      }),
    ).toMatch(/state=ok/);
  });

  it('polling rejimida webhook tekshirilmaydi', () => {
    writeFileSync(
      join(dir, 'app', '.env.production'),
      `TELEGRAM_BOT_TOKEN=${MAIN_TOKEN}\nTELEGRAM_BOT_MODE=polling\n`,
    );
    expect(dry({ FAKE_WEBHOOK: '{"ok":true,"result":{"url":""}}' })).toMatch(
      /state=ok/,
    );
  });

  it('⭐ outbox: 10 daqiqadan eski pending, ko‘p dead, SQL bajarilmadi — muammo; SQL faqat o‘qiydi', () => {
    expect(dry({ FAKE_PSQL: '900\\n0' })).toMatch(
      /Outbox: eng eski kutilayotgan xabar 15 daq/,
    );
    expect(dry({ FAKE_PSQL: '0\\n35' })).toMatch(
      /Outbox: oxirgi soatda 35 ta dead/,
    );
    expect(dry({ FAKE_PSQL: '' })).toMatch(/Outbox: so'rov bajarilmadi/);
    const log = readFileSync(join(dir, 'calls.log'), 'utf8');
    expect(log).toMatch(/BEGIN READ ONLY; SELECT/);
    expect(log).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/);
  });

  it('⭐ notification-service konteyneri o‘chiq / topilmadi — muammo', () => {
    expect(dry({ FAKE_ns1: 'exited no-healthcheck' })).toMatch(
      /notification-service: exited no-healthcheck/,
    );
    expect(dry({ FAKE_NS_ID: '' })).toMatch(/notification-service: missing/);
  });

  it('⭐ takrorsiz: muammo → 1 xabar (alohida bot, token faqat stdin); 6 soatgacha jim; keyin eslatma; tiklanganda «tiklandi»', () => {
    expect(run().status).toBe(0);
    const bad = { FAKE_ns1: 'running unhealthy' };
    expect(run({ ...bad, BOT_ALERT_NOW: String(now + 60) }).status).toBe(1);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatch(/-K -/);
    expect(sends()[0]).toMatch(/notification-service: running unhealthy/);
    const argv = readFileSync(join(dir, 'calls.log'), 'utf8');
    expect(argv).not.toContain(MAIN_TOKEN);
    expect(argv).not.toContain(ALERT_TOKEN);
    expect(readFileSync(join(dir, 'calls.log.stdin'), 'utf8')).toContain(
      `bot${ALERT_TOKEN}/sendMessage`,
    );

    expect(run({ ...bad, BOT_ALERT_NOW: String(now + 900) }).status).toBe(1);
    expect(sends()).toHaveLength(1);
    expect(run({ ...bad, BOT_ALERT_NOW: String(now + 7 * 3600) }).status).toBe(
      1,
    );
    expect(sends()).toHaveLength(2);

    expect(run({ BOT_ALERT_NOW: String(now + 7 * 3600 + 60) }).status).toBe(0);
    expect(sends()).toHaveLength(3);
    expect(sends()[2]).toMatch(/tiklandi/);
    const log = readFileSync(join(dir, 'ops', 'logs', 'bot-alert.log'), 'utf8');
    expect(log).not.toContain(MAIN_TOKEN);
    expect(log).not.toContain(ALERT_TOKEN);
  });

  it('⭐ alert boti asosiy bot bilan bir xil — rad etiladi (bot buzilsa alert ham yetmasdi)', () => {
    writeFileSync(
      join(dir, 'ops', 'bot-alert.env'),
      `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${MAIN_TOKEN}\n`,
    );
    expect(run({ FAKE_ns1: 'exited' }).status).toBe(1);
    expect(sends()).toEqual([]);
    expect(
      readFileSync(join(dir, 'ops', 'logs', 'bot-alert.log'), 'utf8'),
    ).toMatch(/asosiy bot bilan bir xil — rad etildi/);
  });

  it('webhook kanali (ntfy) va heartbeat: ok → GET url, muammo → GET url/fail', () => {
    writeFileSync(
      join(dir, 'ops', 'bot-alert.env'),
      'BOT_ALERT_WEBHOOK_URL=https://ntfy.test/elchi-bot\nBOT_ALERT_HEARTBEAT_URL=https://hc.test/ping/abc\n',
    );
    expect(run().status).toBe(0);
    expect(
      run({ FAKE_ns1: 'exited', BOT_ALERT_NOW: String(now + 60) }).status,
    ).toBe(1);
    const stdin = readFileSync(join(dir, 'calls.log.stdin'), 'utf8');
    expect(stdin).toContain('url = "https://hc.test/ping/abc"');
    expect(stdin).toContain('url = "https://hc.test/ping/abc/fail"');
    expect(stdin).toContain('url = "https://ntfy.test/elchi-bot"');
    const argv = readFileSync(join(dir, 'calls.log'), 'utf8');
    expect(argv).not.toContain('ntfy.test');
    expect(argv).not.toContain('hc.test');
  });

  it('--test bitta test xabar yuboradi; --dry-run hech narsa yubormaydi va holatni o‘zgartirmaydi', () => {
    run({}, ['--test']);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatch(/test xabar/);
    const r = run({ FAKE_ns1: 'exited' }, ['--dry-run']);
    expect(r.stdout).toMatch(/send=problem/);
    expect(sends()).toHaveLength(1);
    expect(existsSync(join(dir, 'ops', 'state', 'bot-alert.state'))).toBe(
      false,
    );
  });

  it('kanal sozlanmagan — faqat log satri', () => {
    rmSync(join(dir, 'ops', 'bot-alert.env'));
    expect(run({ FAKE_ns1: 'exited' }).status).toBe(1);
    expect(sends()).toEqual([]);
    expect(
      readFileSync(join(dir, 'ops', 'logs', 'bot-alert.log'), 'utf8'),
    ).toMatch(/kanal sozlanmagan/);
  });
});
