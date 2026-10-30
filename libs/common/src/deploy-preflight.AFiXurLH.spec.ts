import { execFile, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * AFiXurLH: deploy.yml env preflight va readiness darvozasi. Skript blok'lari
 * deploy.yml'dan olinib HAQIQIY bash'da ishlatiladi (`set -ex` bilan, ya'ni
 * serverdagidek): Docker kerak emas, `docker` va `sleep` soxta.
 */
const ROOT = join(__dirname, '..', '..', '..');
const deploy = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const IND = ' '.repeat(12);

/** Job'ning `script: |` tanasi, chekinishsiz. */
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

function block(script: string, from: string, to: string): string {
  const start = script.indexOf(from);
  const end = script.indexOf(to);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

const JOBS: Array<[string, string]> = [
  ['deploy', '.env.production'],
  ['deploy-staging', '.env.staging'],
];

const PG_OK = 'Pg0123456789abcdefGHIJKLMNOP'; // 28
const SA_OK = 'Sa0123456789abc'; // 15

describe.each(JOBS)('%s: env preflight', (job, envFile) => {
  const script = jobScript(job);
  const preflight = block(
    script,
    '# --- Env preflight',
    '# --- end env preflight',
  );
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'deploy-preflight-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Blok + keyingi qadam belgisi, serverdagi `set -ex` bilan. */
  const run = (env?: string) => {
    if (env !== undefined) writeFileSync(join(dir, envFile), env);
    writeFileSync(
      join(dir, 'run.sh'),
      `set -ex\n${preflight}\ntouch reached\n`,
    );
    return spawnSync('bash', ['run.sh'], { cwd: dir, encoding: 'utf8' });
  };
  const reached = () => existsSync(join(dir, 'reached'));

  it('hech narsaga tegilmasidan oldin turadi', () => {
    const before = script.slice(0, script.indexOf('# --- Env preflight'));
    expect(before).toMatch(/^set -ex$/m);
    expect(code(before)).not.toMatch(/^\s*git /m);
    expect(code(before)).not.toMatch(/ (up|build|pull|rm|stop) /);
    // Eski kod hali diskda: tekshiruv scripts/ da bo'lsa ishlamasdi.
    expect(code(preflight)).not.toMatch(/scripts\//);
  });

  it('qiymatlar to`g`ri bo`lsa o`tadi', () => {
    const r = run(`POSTGRES_PASSWORD=${PG_OK}\nSUPERADMIN_PASSWORD=${SA_OK}\n`);
    expect(r.status).toBe(0);
    expect(reached()).toBe(true);
  });

  it('chegaralar: POSTGRES 24, SUPERADMIN 12', () => {
    const r = run(
      `POSTGRES_PASSWORD=${'p'.repeat(24)}\nSUPERADMIN_PASSWORD=${'s'.repeat(12)}\n`,
    );
    expect(r.status).toBe(0);
    expect(reached()).toBe(true);
  });

  it.each([
    ['POSTGRES_PASSWORD', 'x'.repeat(23), SA_OK],
    ['SUPERADMIN_PASSWORD', PG_OK, 'y'.repeat(11)],
  ])('%s qisqa: deploy to`xtaydi, qiymat logga tushmaydi', (key, pg, sa) => {
    const r = run(`POSTGRES_PASSWORD=${pg}\nSUPERADMIN_PASSWORD=${sa}\n`);
    expect(r.status).toBe(1);
    expect(reached()).toBe(false);
    const out = r.stdout + r.stderr;
    expect(out).toContain(`${envFile}`);
    expect(out).toMatch(new RegExp(`!!! .*${key}`));
    expect(out).toContain('nothing was touched');
    for (const value of [pg, sa]) expect(out).not.toContain(value);
  });

  it('`set -x` to`g`ri qiymatni ham, uzunlikni ham chiqarmaydi', () => {
    const r = run(`POSTGRES_PASSWORD=${PG_OK}\nSUPERADMIN_PASSWORD=${SA_OK}\n`);
    const out = r.stdout + r.stderr;
    expect(out).not.toContain(PG_OK);
    expect(out).not.toContain(SA_OK);
    expect(out).not.toMatch(/\b28\b/);
  });

  it('kalit yo`q yoki bo`sh: to`xtaydi', () => {
    expect(run(`SUPERADMIN_PASSWORD=${SA_OK}\n`).status).toBe(1);
    expect(reached()).toBe(false);
    expect(
      run(`POSTGRES_PASSWORD=\nSUPERADMIN_PASSWORD=${SA_OK}\n`).status,
    ).toBe(1);
    expect(reached()).toBe(false);
  });

  it('env fayl yo`q: to`xtaydi', () => {
    const r = run();
    expect(r.status).toBe(1);
    expect(reached()).toBe(false);
    expect(r.stderr).toContain(envFile);
  });

  it('env_file o`qiydigan shakllar: qo`shtirnoq, izoh, CRLF, oxirgi qator yutadi', () => {
    // 22 belgi + 2 qo'shtirnoq: compose qo'shtirnoqni olib tashlaydi.
    expect(
      run(
        `POSTGRES_PASSWORD="${'q'.repeat(22)}"\nSUPERADMIN_PASSWORD=${SA_OK}\n`,
      ).status,
    ).toBe(1);
    expect(
      run(
        `POSTGRES_PASSWORD='${'q'.repeat(24)}'\nSUPERADMIN_PASSWORD=${SA_OK}\n`,
      ).status,
    ).toBe(0);
    expect(
      run(
        `POSTGRES_PASSWORD=${'q'.repeat(20)} # bu izoh parol emas\nSUPERADMIN_PASSWORD=${SA_OK}\n`,
      ).status,
    ).toBe(1);
    expect(
      run(
        `POSTGRES_PASSWORD=${'q'.repeat(23)}\r\nSUPERADMIN_PASSWORD=${SA_OK}\r\n`,
      ).status,
    ).toBe(1);
    expect(
      run(
        `POSTGRES_PASSWORD=${PG_OK}\nPOSTGRES_PASSWORD=short\nSUPERADMIN_PASSWORD=${SA_OK}\n`,
      ).status,
    ).toBe(1);
    expect(
      run(`# POSTGRES_PASSWORD=${PG_OK}\nSUPERADMIN_PASSWORD=${SA_OK}\n`)
        .status,
    ).toBe(1);
  });
});

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  compose) [ "$FAKE_GW" = none ] || echo "$FAKE_GW" ;;
  exec)
    n=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_COUNT"
    st=$(echo "$FAKE_PROBES" | cut -d' ' -f"$n")
    [ -n "$st" ] || st=$(echo "$FAKE_PROBES" | awk '{print $NF}')
    [ "$st" = ok ] && exit 0
    echo "503 IDENTITY:timeout"; exit 1 ;;
esac
`;

describe.each(JOBS)('%s: readiness darvozasi', (job) => {
  const script = jobScript(job);
  const gate = block(
    script,
    '# --- Readiness gate',
    '# --- end readiness gate',
  );
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-readiness-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'docker'), FAKE_DOCKER);
    writeFileSync(join(dir, 'bin', 'sleep'), '#!/usr/bin/env bash\n');
    chmodSync(join(dir, 'bin', 'docker'), 0o755);
    chmodSync(join(dir, 'bin', 'sleep'), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Serverdagi kabi: ERR trap rollback'ni ishga tushiradi.
  const run = (probes: string, gw = 'cid1') => {
    writeFileSync(
      join(dir, 'run.sh'),
      `set -ex\nrollback() { set +e; echo ROLLBACK; exit 1; }\ntrap 'rollback' ERR\n${gate}\necho AFTER\n`,
    );
    return spawnSync('bash', ['run.sh'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
        FAKE_LOG: join(dir, 'docker.log'),
        FAKE_COUNT: join(dir, 'count'),
        FAKE_PROBES: probes,
        FAKE_GW: gw,
      },
    });
  };
  const probes = () =>
    readFileSync(join(dir, 'docker.log'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('docker exec')).length;

  it('hamma servis ok: deploy davom etadi', () => {
    const r = run('ok ok');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('AFTER');
    expect(r.stdout).not.toContain('ROLLBACK');
    expect(probes()).toBe(2);
  });

  it('servislar kech ko`tarilsa kutadi (ketma-ket 2 marta ok)', () => {
    const r = run('bad bad ok bad ok ok');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('AFTER');
    expect(probes()).toBe(6);
  });

  it('identity o`lik: deploy yiqiladi va rollback ishlaydi', () => {
    const r = run('bad');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('ROLLBACK');
    expect(r.stdout).not.toContain('AFTER');
    expect(r.stderr).toContain('IDENTITY:timeout');
    expect(probes()).toBeGreaterThan(20);
  });

  it('gateway konteyneri yo`q: deploy yiqiladi', () => {
    const r = run('ok', 'none');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('ROLLBACK');
    expect(r.stdout).not.toContain('AFTER');
  });

  it('compose exec emas, docker exec (swap`dan keyin konteyner #1 bo`lmasligi mumkin)', () => {
    expect(gate).toContain('docker exec "$gw" node -e "$READINESS_PROBE"');
    expect(code(gate)).not.toMatch(/compose[^\n]* exec/);
  });

  it('gateway almashgandan keyin, boshqa bosqichlardan oldin, rollback bilan', () => {
    const swap = script.indexOf('if [ "$GATEWAY_SWAP" = true ]; then');
    const call = script.indexOf('\nreadiness_gate\n');
    expect(swap).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(swap);
    expect(call).toBeLessThan(script.indexOf('cloudflared_rollout() {'));
    expect(script.indexOf("trap 'rollback' ERR")).toBeLessThan(call);
    expect(script).not.toMatch(/readiness_gate \|\|/);
  });
});

describe('readiness probe (haqiqiy /health/readiness javoblari)', () => {
  const gate = block(
    jobScript('deploy'),
    '# --- Readiness gate',
    '# --- end readiness gate',
  );
  const assignment = gate
    .split('\n')
    .find((l) => l.startsWith('READINESS_PROBE='))!;

  const probe = (url: string) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const assign = assignment.replace('http://127.0.0.1:3004', url);
      execFile(
        'bash',
        ['-c', `${assign}\nnode -e "$READINESS_PROBE"`],
        (err, stdout) =>
          resolve({
            code: err ? Number(err.code) : 0,
            out: stdout.trim(),
          }),
      );
    });

  const serve = async (status: number, body: string) => {
    const server = createServer((_req, res) => {
      res.statusCode = status;
      res.end(body);
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address() as AddressInfo;
    return { server, url: `http://127.0.0.1:${port}` };
  };

  it('port gateway healthcheck bilan bir xil', () => {
    expect(assignment).toContain('http://127.0.0.1:3004/health/readiness');
  });

  it('200 -> 0', async () => {
    const { server, url } = await serve(200, '{"status":"ok","services":[]}');
    const r = await probe(url);
    server.close();
    expect(r.code).toBe(0);
  });

  it('503 -> 1, nosog`lom servislar nomi bilan', async () => {
    const { server, url } = await serve(
      503,
      JSON.stringify({
        status: 'degraded',
        services: [
          { service: 'IDENTITY', status: 'down', error_kind: 'timeout' },
          { service: 'ORDER', status: 'ok' },
          { service: 'NOTIFICATION', status: 'down', error_kind: 'reported' },
        ],
      }),
    );
    const r = await probe(url);
    server.close();
    expect(r.code).toBe(1);
    expect(r.out).toBe('503 IDENTITY:timeout NOTIFICATION:reported');
  });

  it('JSON bo`lmagan javob ham muvaffaqiyat emas', async () => {
    const { server, url } = await serve(502, 'Bad Gateway');
    const r = await probe(url);
    server.close();
    expect(r.code).toBe(1);
    expect(r.out).toContain('502');
  });

  it('ulanib bo`lmasa -> 1', async () => {
    const r = await probe('http://127.0.0.1:9');
    expect(r.code).toBe(1);
  });
});
