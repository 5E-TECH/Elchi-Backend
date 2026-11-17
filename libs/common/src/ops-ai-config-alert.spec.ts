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
 * scripts/ai-config-alert.sh (be-brief §10): soxta `docker` (psql) va `curl`
 * bilan — tarmoq va Docker yo'q. Kursor faqat kanal qabul qilgach suriladi;
 * sir (alert bot tokeni, webhook URL) argv/logga tushmaydi; rad etilgan
 * urinishlar soatiga bitta yig'ma xabar.
 */
const ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'ai-config-alert.sh');
const ALERT_TOKEN = '333333:AI-ALERT-TOKEN-never-in-argv';
const HOOK = 'https://ntfy.example/secret-topic-never-in-argv';
const US = '\\x1f';
const RS = '\\x1e';
const row = (...f: string[]) => f.join(US) + RS;

// docker exec … psql … -c "<sql>": MAX → $FAKE_MAX, count → $FAKE_COUNT, aks holda $FAKE_ROWS.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
[ "\${FAKE_PSQL_FAIL:-}" = 1 ] && exit 2
sql="\${@: -1}"
case "$sql" in
  *"MAX(id)"*) printf '%s' "\${FAKE_MAX:-0}" ;;
  *"count(*)"*) printf '%s' "\${FAKE_COUNT:-0}" ;;
  *) printf '%b' "\${FAKE_ROWS:-}" ;;
esac
`;
const FAKE_CURL = `#!/usr/bin/env bash
a="$*"; echo "curl \${a//$'\\n'/ | }" >> "$FAKE_LOG"
cat >> "$FAKE_LOG.stdin"
[ "\${FAKE_SEND_FAIL:-}" = 1 ] && exit 22
echo -n 200
`;

describe('ai-config-alert.sh', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-config-alert-'));
    for (const d of ['bin', 'app', 'ops']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'bin', 'docker'), FAKE_DOCKER);
    writeFileSync(join(dir, 'bin', 'curl'), FAKE_CURL);
    chmodSync(join(dir, 'bin', 'docker'), 0o755);
    chmodSync(join(dir, 'bin', 'curl'), 0o755);
    writeFileSync(
      join(dir, 'app', '.env.staging'),
      'POSTGRES_USER=elchi\nPOSTGRES_DB=elchi\n',
    );
    writeFileSync(
      join(dir, 'ops', 'bot-alert.env'),
      `BOT_ALERT_TELEGRAM_CHAT_ID=42\nBOT_ALERT_TELEGRAM_BOT_TOKEN=${ALERT_TOKEN}\nBOT_ALERT_WEBHOOK_URL=${HOOK}\nBOT_ALERT_HOST_LABEL=staging\n`,
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
        ELCHI_ENV_FILE: join(dir, 'app', '.env.staging'),
        ELCHI_OPS_DIR: join(dir, 'ops'),
        FAKE_LOG: join(dir, 'calls.log'),
        ...env,
      },
    });
  const calls = () =>
    existsSync(join(dir, 'calls.log'))
      ? readFileSync(join(dir, 'calls.log'), 'utf8')
      : '';
  const cursor = () =>
    readFileSync(
      join(dir, 'ops', 'state', 'ai-config-alert.cursor'),
      'utf8',
    ).trim();
  const sentTexts = () =>
    calls()
      .split('\n')
      .filter((l) => l.includes('chat_id='));
  const setCursor = (v: string) => {
    mkdirSync(join(dir, 'ops', 'state'), { recursive: true });
    writeFileSync(
      join(dir, 'ops', 'state', 'ai-config-alert.cursor'),
      `${v}\n`,
    );
  };

  const ROWS =
    row(
      '101',
      'ai.key.replace',
      '2026-11-15 10:00',
      'Ega Admin',
      'sk-ant-…abcd',
      '3f9a c21b 07de',
      'Staging',
      '203.0.113.7',
      '',
      '',
    ) +
    row(
      '102',
      'ai.key.runtime_failure',
      '2026-11-15 10:05',
      '',
      'sk-ant-…abcd',
      '3f9a c21b 07de',
      '',
      '',
      'AI_KEY_BILLING',
      '',
    );

  it('birinchi yugurish: kursor MAX(id) ga, hech narsa yuborilmaydi', () => {
    const r = run({ FAKE_MAX: '57' });
    expect(r.status).toBe(0);
    expect(cursor()).toBe('57');
    expect(sentTexts()).toEqual([]);
  });

  it('yangi qatorlar: bitta xabar, o‘zbekcha amal, aktyor, hint, iz, IP; kursor suriladi', () => {
    setCursor('100');
    const r = run({ FAKE_ROWS: ROWS });
    expect(r.status).toBe(0);
    const tg = sentTexts();
    expect(tg).toHaveLength(1);
    expect(tg[0]).toContain('staging');
    expect(tg[0]).toContain(
      'AI kaliti almashtirildi — Ega Admin; kalit sk-ant-…abcd (iz 3f9a c21b 07de) «Staging»; IP 203.0.113.7',
    );
    expect(tg[0]).toContain(
      "AI kaliti ishlamay qoldi — AI to'xtagan; kalit sk-ant-…abcd",
    );
    expect(tg[0]).toContain('AI_KEY_BILLING');
    expect(tg[0]).not.toContain('parse_mode');
    expect(cursor()).toBe('102');
    // SQL faqat o'qish.
    expect(calls()).toContain('BEGIN READ ONLY;');
    expect(calls()).toContain('a.id > 100');
  });

  it('sirlar argv va logda yo‘q (curl -K -)', () => {
    setCursor('100');
    run({ FAKE_ROWS: ROWS });
    const log = readFileSync(
      join(dir, 'ops', 'logs', 'ai-config-alert.log'),
      'utf8',
    );
    for (const s of [ALERT_TOKEN, HOOK]) {
      expect(calls()).not.toContain(s);
      expect(log).not.toContain(s);
    }
    expect(readFileSync(join(dir, 'calls.log.stdin'), 'utf8')).toContain(
      ALERT_TOKEN,
    );
  });

  it('kanal qabul qilmasa — kursor surilmaydi, keyingi yugurish qayta yuboradi', () => {
    setCursor('100');
    const r = run({ FAKE_ROWS: ROWS, FAKE_SEND_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(cursor()).toBe('100');
    expect(run({ FAKE_ROWS: ROWS }).status).toBe(0);
    expect(cursor()).toBe('102');
  });

  it('psql xatosi — kursor o‘zgarmaydi, chiqish 1', () => {
    setCursor('100');
    expect(run({ FAKE_PSQL_FAIL: '1' }).status).toBe(1);
    expect(cursor()).toBe('100');
  });

  it('nom/aktyorda boshqaruv belgisi va sk-ant- qiymat tozalanadi', () => {
    setCursor('100');
    const evil = row(
      '103',
      'ai.key.add',
      '2026-11-15 11:00',
      'Ega\\nFake line',
      'sk-ant-…zzzz',
      'aaaa bbbb cccc',
      'x sk-ant-api03-LEAKEDVALUE123',
      '',
      '',
      '',
    );
    run({ FAKE_ROWS: evil });
    const tg = sentTexts()[0];
    expect(tg).not.toContain('LEAKEDVALUE');
    expect(tg).toContain('sk-ant-[REDACTED]');
    expect(tg).toContain('Ega Fake line');
  });

  it('rad etilgan urinishlar: ≥3 — bitta yig‘ma xabar, soat ichida takrorlanmaydi', () => {
    setCursor('100');
    expect(
      run({ FAKE_COUNT: '4', AI_CONFIG_ALERT_NOW: '1800000000' }).status,
    ).toBe(0);
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('4 ta rad etilgan urinish');
    run({ FAKE_COUNT: '5', AI_CONFIG_ALERT_NOW: '1800001000' });
    expect(sentTexts()).toHaveLength(1);
    run({ FAKE_COUNT: '5', AI_CONFIG_ALERT_NOW: '1800003700' });
    expect(sentTexts()).toHaveLength(2);
    run({ FAKE_COUNT: '2', AI_CONFIG_ALERT_NOW: '1800008000' });
    expect(sentTexts()).toHaveLength(2);
  });

  it('--dry-run: matn chiqadi, hech narsa yuborilmaydi va kursor o‘zgarmaydi; --test', () => {
    setCursor('100');
    const r = run({ FAKE_ROWS: ROWS }, ['--dry-run']);
    expect(r.stdout).toContain('AI kaliti almashtirildi');
    expect(sentTexts()).toEqual([]);
    expect(cursor()).toBe('100');
    const t = run({}, ['--test']);
    expect(t.status).toBe(0);
    expect(sentTexts()[0]).toContain('test xabar');
  });
});
