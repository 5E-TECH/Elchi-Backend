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
 * deploy.yml «Release preflight» (2026-11-20): Compose versiyasi, AI env
 * qiymatlari va migratsiya daftari — serverga tegilmasdan OLDIN. Blok
 * deploy.yml'dan olinib HAQIQIY bash'da (`set -ex`, serverdagidek) va haqiqiy
 * git repoda ishlatiladi; `docker` soxta (postgres javobi fayldan).
 */
const ROOT = join(__dirname, '..', '..', '..');
const deploy = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const IND = ' '.repeat(12);

function jobScript(job: string): string {
  const lines = deploy.split('\n');
  let i = lines.indexOf(`  ${job}:`);
  expect(i).toBeGreaterThan(0);
  while (!/^ {10}script: \|\s*$/.test(lines[i])) i++;
  const out: string[] = [];
  for (i++; i < lines.length; i++) {
    if (lines[i].trim() !== '' && !lines[i].startsWith(IND)) break;
    out.push(lines[i].slice(IND.length));
  }
  return out.join('\n');
}

const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const START = '# --- Release preflight';
const END = '# --- end release preflight';

const JOBS: Array<[string, string, string]> = [
  ['deploy', '.env.production', '.env.ai-secrets'],
  ['deploy-staging', '.env.staging', '.env.staging.ai-secrets'],
];

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$*" in
  "compose version --short") echo "$FAKE_COMPOSE" ;;
  *" ps --status running --quiet postgres") [ "$FAKE_PG" = running ] && echo pgcid; exit 0 ;;
  *" exec -T postgres sh -c "*)
    shift $(($# - 1)); echo "SH_C $1" >> "$FAKE_LOG"
    [ "$FAKE_PSQL" = fail ] && { echo "psql: connection refused" >&2; exit 2; }
    sql="$(cat)"
    case "$sql" in
      *to_regclass*) case "$FAKE_LEDGER" in none) echo 'f|f' ;; lost) echo 'f|t' ;; *) echo 't|t' ;; esac ;;
      "SELECT name FROM order_schema.migrations;") cat "$FAKE_LEDGER" ;;
      *) echo "unexpected sql: $sql" >&2; exit 3 ;;
    esac ;;
  *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
`;

const KEY = 'sk-ant-api03-' + 'k'.repeat(40);
const mig = (cls: string) =>
  `import { MigrationInterface, QueryRunner } from 'typeorm';\n\nexport class ${cls} implements MigrationInterface {\n  name = '${cls}';\n  async up(_q: QueryRunner): Promise<void> {}\n  async down(_q: QueryRunner): Promise<void> {}\n}\n`;

describe.each(JOBS)('%s: release preflight', (job, envFile, aiFile) => {
  const script = jobScript(job);
  const start = script.indexOf(START);
  const end = script.indexOf(END);
  const preflight = script.slice(start, end);
  let dir: string;
  let oldSha: string;
  let newSha: string;

  const git = (...args: string[]) => {
    const r = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: dir,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };
  const commit = (files: Record<string, string>) => {
    for (const [p, body] of Object.entries(files))
      writeFileSync(join(dir, p), body);
    git('add', '-A', 'migrations');
    git('commit', '-q', '-m', 'c');
    return git('rev-parse', 'HEAD');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-release-preflight-'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'migrations'));
    writeFileSync(join(dir, 'bin', 'docker'), FAKE_DOCKER);
    chmodSync(join(dir, 'bin', 'docker'), 0o755);
    git('init', '-q');
    oldSha = commit({
      'migrations/1712400000000-Base.ts': mig('Base1712400000000'),
      'migrations/1716000000142-Pricing.ts': mig('Pricing1716000000142'),
    });
    newSha = commit({
      'migrations/1716000000142-Pricing.ts':
        mig('Pricing1716000000142') + '// edited\n',
      'migrations/1716000000250-NewThing.ts': mig('NewThing1716000000250'),
    });
    writeFileSync(
      join(dir, 'ledger'),
      'Base1712400000000\nPricing1716000000142\n',
    );
    writeFileSync(
      join(dir, envFile),
      `POSTGRES_PASSWORD=x\nANTHROPIC_API_KEY=${KEY}\nAI_ACK_CHECKS_ENFORCE=off\n`,
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  type Opts = {
    compose?: string;
    pg?: 'running' | 'down';
    psql?: 'ok' | 'fail';
    ledger?: 'file' | 'none' | 'lost';
    old?: string;
    skip?: string;
  };
  const run = (o: Opts = {}) => {
    const old = o.old ?? oldSha;
    writeFileSync(
      join(dir, 'run.sh'),
      `set -ex\nOLD_SHA="${old}"\nNEW_SHA="${newSha}"\n${preflight}\ntouch reached\n`,
    );
    rmSync(join(dir, 'reached'), { force: true });
    rmSync(join(dir, 'docker.log'), { force: true });
    const r = spawnSync('bash', ['run.sh'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
        HOME: dir,
        FAKE_LOG: join(dir, 'docker.log'),
        FAKE_COMPOSE: o.compose ?? '2.29.7',
        FAKE_PG: o.pg ?? 'running',
        FAKE_PSQL: o.psql ?? 'ok',
        FAKE_LEDGER:
          o.ledger === 'none' || o.ledger === 'lost'
            ? o.ledger
            : join(dir, 'ledger'),
        ...(o.skip !== undefined ? { DEPLOY_PREFLIGHT_SKIP: o.skip } : {}),
      },
    });
    return {
      ...r,
      out: r.stdout + r.stderr,
      reached: existsSync(join(dir, 'reached')),
    };
  };
  const dockerLog = () =>
    existsSync(join(dir, 'docker.log'))
      ? readFileSync(join(dir, 'docker.log'), 'utf8')
      : '';

  it('superseded tekshiruvidan keyin, rollback trap / checkout / backup dan oldin; serverga yozmaydi', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(start).toBeGreaterThan(script.indexOf('Superseded:'));
    for (const later of [
      /^trap 'rollback' ERR$/m,
      /^git checkout -f /m,
      /^if ! PRE_DEPLOY_BK=/m,
      /^APP_SERVICES=/m,
    ]) {
      expect(script.search(later)).toBeGreaterThan(end);
    }
    expect(code(preflight)).not.toMatch(
      /docker compose[^\n]* (up|build|pull|rm|stop|run|restart|down|create|start|kill)\b/,
    );
    expect(code(preflight)).not.toMatch(
      /\bdocker (run|rm|stop|kill|pull|build|system|volume|image)\b/,
    );
    expect(code(preflight)).not.toMatch(
      /\bgit (checkout|reset|merge|pull|clean)\b/,
    );
  });

  it('hammasi joyida: o`tadi, faqat shu deploy qo`shgan migratsiya ishlaydi', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.reached).toBe(true);
    expect(r.out).toMatch(
      /3 migrations in the new code, 2 recorded, 1 will run/,
    );
    expect(r.out).toContain('Preflight ok');
    // Faqat o'qish: version, ps, exec psql — boshqa docker chaqiruvi yo'q.
    const calls = dockerLog()
      .split('\n')
      .filter((l) => l.startsWith('docker '));
    expect(
      calls.every((l) =>
        /compose version|ps --status running|exec -T postgres sh -c/.test(l),
      ),
    ).toBe(true);
    // psql konteynerning o'z POSTGRES_USER/POSTGRES_DB bilan (host qiymati emas).
    expect(dockerLog()).toContain(
      'SH_C psql -X -q -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    );
  });

  it.each([
    ['2.20.2', 1],
    ['2.23.99', 1],
    ['0', 1],
    ['2.24.0', 0],
    ['v2.24.4', 0],
    ['2.30.0-desktop.1', 0],
  ])('Compose %s → exit %d', (compose, status) => {
    const r = run({ compose: String(compose) });
    expect(r.status).toBe(status);
    expect(r.reached).toBe(status === 0);
    if (status)
      expect(r.out).toMatch(/!!! Release preflight refused.*Docker Compose/);
  });

  it.each([
    ['qisqa', 'sk-ant-api03-short'],
    ['admin', 'sk-ant-admin01-' + 'a'.repeat(40)],
    ['oauth', 'sk-ant-oat01-' + 'a'.repeat(40)],
    ['ort', 'sk-ant-ort01-' + 'a'.repeat(40)],
    ['begona belgi', 'sk-ant-api03-' + 'a'.repeat(40) + '.x'],
    ['prefikssiz', 'x'.repeat(50)],
    ['juda uzun', 'sk-ant-' + 'a'.repeat(250)],
  ])('ANTHROPIC_API_KEY %s: to`xtaydi, qiymat logda yo`q', (_name, key) => {
    writeFileSync(
      join(dir, envFile),
      `POSTGRES_PASSWORD=x\nANTHROPIC_API_KEY=${key}\n`,
    );
    const r = run();
    expect(r.status).toBe(1);
    expect(r.reached).toBe(false);
    expect(r.out).toMatch(/!!! Release preflight refused.*ANTHROPIC_API_KEY/);
    expect(r.out).not.toContain(key);
  });

  it('ANTHROPIC_API_KEY shakllari: bo`sh, qo`shtirnoq, export, izoh, CRLF — o`tadi; to`g`ri qiymat ham logda yo`q', () => {
    for (const line of [
      'ANTHROPIC_API_KEY=',
      'ANTHROPIC_API_KEY=   ',
      `ANTHROPIC_API_KEY="${KEY}"`,
      `ANTHROPIC_API_KEY='${KEY}'`,
      `export ANTHROPIC_API_KEY=${KEY}`,
      `ANTHROPIC_API_KEY=${KEY} # asosiy kalit`,
      `ANTHROPIC_API_KEY=${KEY}\r`,
      `# ANTHROPIC_API_KEY=sk-ant-bad`,
    ]) {
      writeFileSync(join(dir, envFile), `POSTGRES_PASSWORD=x\n${line}\n`);
      const r = run();
      expect({ line, status: r.status }).toEqual({ line, status: 0 });
      expect(r.out).not.toContain(KEY);
    }
  });

  it('ai-secrets fayli ustun (compose env_file tartibi)', () => {
    writeFileSync(
      join(dir, envFile),
      `POSTGRES_PASSWORD=x\nANTHROPIC_API_KEY=sk-ant-bad\n`,
    );
    writeFileSync(join(dir, aiFile), `ANTHROPIC_API_KEY=${KEY}\n`);
    expect(run().status).toBe(0);
    writeFileSync(
      join(dir, envFile),
      `POSTGRES_PASSWORD=x\nANTHROPIC_API_KEY=${KEY}\n`,
    );
    writeFileSync(
      join(dir, aiFile),
      `ANTHROPIC_API_KEY=sk-ant-admin01-${'a'.repeat(40)}\n`,
    );
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('Admin API key');
    writeFileSync(join(dir, aiFile), 'ANTHROPIC_API_KEY=\n');
    expect(run().status).toBe(0);
  });

  it('AI_ACK_CHECKS_ENFORCE: on/off (registr, bo`shliq) o`tadi, boshqa qiymat to`xtaydi; ai-secrets dagisi gateway o`qimaydi', () => {
    for (const [v, status] of [
      ['on', 0],
      ['OFF', 0],
      [' On ', 0],
      ['"off"', 0],
      ['', 0],
      ['maybe', 1],
      ['true', 1],
    ] as const) {
      writeFileSync(
        join(dir, envFile),
        `POSTGRES_PASSWORD=x\nAI_ACK_CHECKS_ENFORCE=${v}\n`,
      );
      const r = run();
      expect({ v, status: r.status }).toEqual({ v, status });
      if (status) expect(r.out).toContain('AI_ACK_CHECKS_ENFORCE (on or off)');
    }
    writeFileSync(join(dir, envFile), 'POSTGRES_PASSWORD=x\n');
    writeFileSync(join(dir, aiFile), 'AI_ACK_CHECKS_ENFORCE=maybe\n');
    expect(run().status).toBe(0);
  });

  it('ai-secrets fayli bor, lekin o`qib bo`lmaydi: to`xtaydi', () => {
    if (process.getuid?.() === 0) return; // root hamma faylni o'qiydi
    writeFileSync(join(dir, aiFile), `ANTHROPIC_API_KEY=${KEY}\n`);
    chmodSync(join(dir, aiFile), 0o000);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('is not readable');
  });

  it('daftarda ESKI migratsiya yo`q: to`xtaydi va nomini aytadi', () => {
    writeFileSync(join(dir, 'ledger'), 'Base1712400000000\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.reached).toBe(false);
    expect(r.out).toMatch(
      /!!! Release preflight refused.*Pricing1716000000142/,
    );
    expect(r.out).not.toMatch(/refused.*NewThing1716000000250/);
  });

  it('eski migratsiya klassi qayta nomlangan: to`xtaydi (yana ishlab ketardi)', () => {
    newSha = commit({
      'migrations/1716000000142-Pricing.ts': mig('PricingV21716000000142'),
    });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/refused.*PricingV21716000000142/);
  });

  it('daftarda kodda yo`q qo`shimcha yozuvlar — xato emas', () => {
    writeFileSync(
      join(dir, 'ledger'),
      'Base1712400000000\nPricing1716000000142\nNewThing1716000000250\nGone1700000000000\n',
    );
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/0 will run/);
  });

  it('daftar jadvali yo`q (birinchi o`rnatish) / postgres ishlamayapti / OLD_SHA yo`q yoki teng — daftar tekshiruvi o`tkazib yuboriladi', () => {
    let r = run({ ledger: 'none' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('ledger check skipped');
    expect(r.out).toContain('Preflight ok');
    r = run({ pg: 'down' });
    expect(r.status).toBe(0);
    expect(dockerLog()).not.toContain('exec');
    r = run({ old: '' });
    expect(r.status).toBe(0);
    expect(dockerLog()).not.toContain('ps --status');
    r = run({ old: newSha });
    expect(r.status).toBe(0);
    expect(dockerLog()).not.toContain('ps --status');
  });

  it('order_schema da jadvallar bor, daftar yo`q: to`xtaydi (hamma migratsiya qayta ishlardi)', () => {
    const r = run({ ledger: 'lost' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('has tables but no order_schema.migrations ledger');
  });

  it('psql xato: to`xtaydi (daftarni o`qib bo`lmadi)', () => {
    const r = run({ psql: 'fail' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('could not read the migration ledger');
  });

  it('DEPLOY_PREFLIGHT_SKIP=true — hammasini o`tkazib yuboradi (WARN bilan); boshqa qiymat — yo`q', () => {
    let r = run({ compose: '2.10.0', skip: 'true' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('WARN: DEPLOY_PREFLIGHT_SKIP=true');
    expect(dockerLog()).toBe('');
    r = run({ compose: '2.10.0', skip: 'yes' });
    expect(r.status).toBe(1);
  });

  it('bir nechta muammo — hammasi bitta xabarda', () => {
    writeFileSync(join(dir, 'ledger'), 'Base1712400000000\n');
    writeFileSync(
      join(dir, envFile),
      'POSTGRES_PASSWORD=x\nAI_ACK_CHECKS_ENFORCE=maybe\n',
    );
    const r = run({ compose: '2.21.0' });
    expect(r.status).toBe(1);
    const msg =
      r.out
        .split('\n')
        .find((l) => l.startsWith('!!! Release preflight refused')) ?? '';
    expect(msg).toContain('[compose]');
    expect(msg).toContain('[env]');
    expect(msg).toContain('[migrations]');
  });
});

describe('deploy.yml: DEPLOY_PREFLIGHT_SKIP ikkala jobga uzatiladi', () => {
  it('env + envs', () => {
    expect(
      deploy.match(
        /DEPLOY_PREFLIGHT_SKIP: \$\{\{ vars\.DEPLOY_PREFLIGHT_SKIP \}\}/g,
      ),
    ).toHaveLength(2);
    expect(
      deploy.match(/envs: [A-Z_,]*,DEPLOY_PREFLIGHT_SKIP\n/g),
    ).toHaveLength(2);
  });
});
