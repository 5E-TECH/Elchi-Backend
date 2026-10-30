import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 6RaEn5cN / ZfI9nERJ / AFiXurLH ops scripts and wiring:
 * - scripts/backup-minio-offsite.sh (POSIX sh) against a fake `rclone` that maps
 *   `minio:<b>` / `r2:<bucket>/…` onto temp dirs — no Docker, no network;
 * - scripts/backup-alert.sh against a fake `docker` + `curl`;
 * - static checks of docker-compose.prod.yml / deploy.yml / rotation script.
 */
const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const MINIO_SCRIPT = join(ROOT, 'scripts', 'backup-minio-offsite.sh');
const ALERT_SCRIPT = join(ROOT, 'scripts', 'backup-alert.sh');
const DAY = 86400;
const SECRET = 'r2-secret-Zq9v-never-printed';
const RO_SECRET = 'minio-ro-secret-never-printed';

const FAKE_RCLONE = `#!/usr/bin/env bash
echo "rclone $*" >> "$FAKE_LOG"
map() { case "$1" in r2:*) echo "$FAKE_R2/\${1#r2:}" ;; minio:*) echo "$FAKE_MINIO/\${1#minio:}" ;; *) echo "$1" ;; esac; }
cmd="$1"; shift
pos=(); bdir=""; dirs=false; json=false; ex=""
while [ $# -gt 0 ]; do
  case "$1" in
    --backup-dir) bdir="$2"; shift 2 ;;
    --exclude) ex="\${2#/}"; ex="\${ex%'**'}"; shift 2 ;;
    --max-delete|--transfers|--checkers|--stats|--max-depth) shift 2 ;;
    --dirs-only) dirs=true; shift ;;
    --json) json=true; shift ;;
    -*) shift ;;
    *) pos+=("$1"); shift ;;
  esac
done
# Files under a dir (relative), minus the --exclude'd root prefix.
files() { (cd "$1" && find . -type f | sed 's#^\\./##' | sort) | { if [ -n "$ex" ]; then grep -v "^$ex" || true; else cat; fi; }; }
case "$cmd" in
  lsf)
    d=$(map "\${pos[0]}")
    [ -d "$d" ] || { echo "ERROR : directory not found" >&2; exit 3; }
    if $dirs; then (cd "$d" && for x in */; do [ -d "$x" ] && echo "$x"; done); else files "$d"; fi ;;
  sync)
    [ "\${FAKE_RCLONE:-}" = fail-sync ] && { echo "ERROR : max delete limit reached" >&2; exit 7; }
    s=$(map "\${pos[0]}"); t=$(map "\${pos[1]}"); b=$(map "$bdir"); mkdir -p "$t"
    files "$t" | while IFS= read -r f; do
      if [ ! -f "$s/$f" ] || ! cmp -s "$s/$f" "$t/$f"; then mkdir -p "$b/$(dirname "$f")"; mv "$t/$f" "$b/$f"; echo "INFO  : $f: Moved (server-side) to: backup" >&2; fi
    done
    files "$s" | while IFS= read -r f; do
      [ -f "$t/$f" ] || { mkdir -p "$t/$(dirname "$f")"; cp "$s/$f" "$t/$f"; echo "INFO  : $f: Copied (new)" >&2; }
    done ;;
  check) x=(); [ -n "$ex" ] && x=(-x "\${ex%/}"); diff -r "\${x[@]}" "$(map "\${pos[0]}")" "$(map "\${pos[1]}")" >/dev/null || { echo "ERROR : 1 differences found" >&2; exit 1; } ;;
  size) d=$(map "\${pos[0]}"); n=$(files "$d" | wc -l); b=$(files "$d" | while IFS= read -r f; do cat "$d/$f"; done | wc -c); echo "{\\"count\\":$n,\\"bytes\\":$b,\\"sizeless\\":0}" ;;
  purge) rm -rf "$(map "\${pos[0]}")" ;;
  *) echo "fake rclone: unsupported $cmd" >&2; exit 9 ;;
esac
`;

interface Sandbox {
  dir: string;
  minio: string;
  r2: string;
  state: string;
  log: string;
}

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'minio-offsite-'));
  const s: Sandbox = {
    dir,
    minio: join(dir, 'minio'),
    r2: join(dir, 'r2'),
    state: join(dir, 'state'),
    log: join(dir, 'rclone.log'),
  };
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(s.minio, 'elchi-files', 'cod'), { recursive: true });
  mkdirSync(join(s.r2, 'bkt'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'rclone'), FAKE_RCLONE);
  chmodSync(join(dir, 'bin', 'rclone'), 0o755);
  writeFileSync(join(s.minio, 'elchi-files', 'cod', 'a.jpg'), 'AAAA');
  writeFileSync(join(s.minio, 'elchi-files', 'b.pdf'), 'BBBBBB');
  return s;
}

function runMinio(
  s: Sandbox,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return spawnSync('sh', [MINIO_SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${join(s.dir, 'bin')}:/usr/bin:/bin`,
      FAKE_LOG: s.log,
      FAKE_R2: s.r2,
      FAKE_MINIO: s.minio,
      MINIO_OFFSITE_STATE_DIR: s.state,
      R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      R2_ACCESS_KEY_ID: 'ak',
      R2_SECRET_ACCESS_KEY: SECRET,
      R2_BUCKET: 'bkt',
      MINIO_BACKUP_ACCESS_KEY: 'elchi-backup-ro',
      MINIO_BACKUP_SECRET_KEY: RO_SECRET,
      MINIO_BUCKET: 'elchi-files',
      ...env,
    },
  });
}

const status = (s: Sandbox) => readFileSync(join(s.state, 'status'), 'utf8');

describe('backup-minio-offsite.sh (6RaEn5cN)', () => {
  let s: Sandbox;
  beforeEach(() => (s = sandbox()));
  afterEach(() => rmSync(s.dir, { recursive: true, force: true }));

  it('mirrors MinIO into current/, versions overwritten/deleted objects, verifies, never prints secrets', () => {
    const r1 = runMinio(s);
    expect(r1.status).toBe(0);
    const cur = join(s.r2, 'bkt', 'minio', 'elchi-files', 'current');
    expect(readFileSync(join(cur, 'cod', 'a.jpg'), 'utf8')).toBe('AAAA');
    expect(status(s)).toMatch(/^state=ok$/m);
    expect(status(s)).toMatch(/^objects=2$/m);
    expect(status(s)).toMatch(/^copied=2$/m);

    // overwrite one object, delete another — both old versions must be kept
    writeFileSync(join(s.minio, 'elchi-files', 'cod', 'a.jpg'), 'NEW');
    rmSync(join(s.minio, 'elchi-files', 'b.pdf'));
    const r2 = runMinio(s, [], { MINIO_OFFSITE_NOW: String(2_000_000_000) });
    expect(r2.status).toBe(0);
    const ver = join(
      s.r2,
      'bkt',
      'minio',
      'elchi-files',
      'versions',
      '20330518T033320Z',
    );
    expect(readFileSync(join(ver, 'cod', 'a.jpg'), 'utf8')).toBe('AAAA');
    expect(readFileSync(join(ver, 'b.pdf'), 'utf8')).toBe('BBBBBB');
    expect(readFileSync(join(cur, 'cod', 'a.jpg'), 'utf8')).toBe('NEW');
    expect(existsSync(join(cur, 'b.pdf'))).toBe(false);
    expect(status(s)).toMatch(/^versioned=2$/m);

    const calls = readFileSync(s.log, 'utf8');
    expect(calls).toMatch(
      /rclone sync minio:elchi-files r2:bkt\/minio\/elchi-files\/current --backup-dir r2:bkt\/minio\/elchi-files\/versions\/\d{8}T\d{6}Z --checksum/,
    );
    expect(calls).toMatch(/--max-delete 50/);
    expect(calls).toMatch(
      /rclone check minio:elchi-files r2:bkt\/minio\/elchi-files\/current --one-way/,
    );
    for (const out of [
      r1.stdout,
      r1.stderr,
      r2.stdout,
      r2.stderr,
      calls,
      status(s),
    ]) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(RO_SECRET);
    }
  });

  it('never copies temporary AI images (ai-tmp/) off-site; verify still passes', () => {
    const tmp = join(
      s.minio,
      'elchi-files',
      'ai-tmp',
      '0b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4',
    );
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, '0.jpg'), 'CUSTOMER-PHOTO');
    const r1 = runMinio(s);
    expect(r1.status).toBe(0);
    const cur = join(s.r2, 'bkt', 'minio', 'elchi-files', 'current');
    expect(readFileSync(join(cur, 'cod', 'a.jpg'), 'utf8')).toBe('AAAA');
    expect(existsSync(join(cur, 'ai-tmp'))).toBe(false);
    expect(status(s)).toMatch(/^objects=2$/m);
    expect(status(s)).toMatch(/^copied=2$/m);
    const calls = readFileSync(s.log, 'utf8');
    // Obyekt sanash (lsf --files-only), sync, check, size — hammasida
    // exclude; versions/ papka ro'yxati (prune) bunga kirmaydi.
    for (const prefix of [
      'rclone lsf ',
      'rclone sync ',
      'rclone check ',
      'rclone size ',
    ]) {
      const lines = calls
        .split('\n')
        .filter(
          (line) =>
            line.startsWith(prefix) &&
            (prefix !== 'rclone lsf ' || line.includes('--files-only')),
        );
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toContain('--exclude /ai-tmp/**');
    }
    expect(calls).toMatch(/rclone sync .*--exclude \/ai-tmp\/\*\*/);

    // ai-tmp TTL bilan o'chdi — off-site nusxada hech narsa ko'chmaydi.
    rmSync(join(s.minio, 'elchi-files', 'ai-tmp'), {
      recursive: true,
      force: true,
    });
    const r2 = runMinio(s, [], { MINIO_OFFSITE_NOW: String(2_000_000_000) });
    expect(r2.status).toBe(0);
    expect(status(s)).toMatch(/^versioned=0$/m);
    expect(
      existsSync(join(s.r2, 'bkt', 'minio', 'elchi-files', 'versions')),
    ).toBe(false);
  });

  it('refuses (nothing moved) when MinIO is empty but the R2 copy is not', () => {
    expect(runMinio(s).status).toBe(0);
    rmSync(join(s.minio, 'elchi-files'), { recursive: true });
    mkdirSync(join(s.minio, 'elchi-files'));
    const r = runMinio(s);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /EMPTY while the R2 copy holds 2 objects — refused/,
    );
    expect(readdirSync(join(s.r2, 'bkt', 'minio', 'elchi-files'))).toEqual([
      'current',
    ]);
    expect(status(s)).toMatch(/^state=error$/m);
  });

  it('prunes versions/<ts>/ older than the retention by folder name only', () => {
    const vroot = join(s.r2, 'bkt', 'minio', 'elchi-files', 'versions');
    for (const d of ['20260101T000000Z', '20261020T000000Z', 'keep-me']) {
      mkdirSync(join(vroot, d), { recursive: true });
      writeFileSync(join(vroot, d, 'x'), 'x');
    }
    const now = Math.floor(Date.parse('2026-10-26T00:00:00Z') / 1000);
    const r = runMinio(s, [], { MINIO_OFFSITE_NOW: String(now) });
    expect(r.status).toBe(0);
    expect(existsSync(join(vroot, '20260101T000000Z'))).toBe(false); // > 90 d
    expect(existsSync(join(vroot, '20261020T000000Z'))).toBe(true);
    expect(existsSync(join(vroot, 'keep-me'))).toBe(true);
    expect(status(s)).toMatch(/^pruned_versions=1$/m);
  });

  it('a failed sync prunes nothing and marks the status error', () => {
    const vroot = join(
      s.r2,
      'bkt',
      'minio',
      'elchi-files',
      'versions',
      '20200101T000000Z',
    );
    mkdirSync(vroot, { recursive: true });
    const r = runMinio(s, [], { FAKE_RCLONE: 'fail-sync' });
    expect(r.status).toBe(1);
    expect(existsSync(vroot)).toBe(true);
    expect(status(s)).toMatch(/^state=error$/m);
    expect(r.stderr).toMatch(/sync \(rclone exit 7/);
  });

  it('without credentials: disabled, exit 1, --check unhealthy', () => {
    const r = runMinio(s, [], { MINIO_BACKUP_SECRET_KEY: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/sozlanmagan .*MINIO_BACKUP_SECRET_KEY/);
    expect(existsSync(s.log)).toBe(false);
    const c = runMinio(s, ['--check']);
    expect(c.status).toBe(1);
    expect(c.stderr).toMatch(/UNHEALTHY: disabled/);
  });

  it('--check: fresh success healthy, > 26h unhealthy', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(runMinio(s, [], { MINIO_OFFSITE_NOW: String(now) }).status).toBe(0);
    expect(
      runMinio(s, ['--check'], { MINIO_OFFSITE_NOW: String(now + 3600) })
        .status,
    ).toBe(0);
    const stale = runMinio(s, ['--check'], {
      MINIO_OFFSITE_NOW: String(now + 27 * 3600),
    });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/UNHEALTHY: last successful run/);
  });
});

// ---------------------------------------------------------------------------
const FAKE_DOCKER = `#!/usr/bin/env bash
# docker inspect -f '…' <name>  ->  "$FAKE_STATE_<name with - as _>" or missing
name="\${@: -1}"; v="FAKE_\${name//-/_}"; [ -n "\${!v:-}" ] || exit 1; echo "\${!v}"
`;
const FAKE_CURL = `#!/usr/bin/env bash
a="$*"; echo "curl \${a//$'\\n'/ | }" >> "$FAKE_CURL_LOG"
cat >> "$FAKE_CURL_LOG.stdin"
echo -n 200
`;

describe('backup-alert.sh (6RaEn5cN)', () => {
  let dir: string;
  const token = '123456:BOT-TOKEN-never-in-argv';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'backup-alert-'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'app'));
    mkdirSync(join(dir, 'ops', 'state', 'minio-offsite'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'docker'), FAKE_DOCKER);
    writeFileSync(join(dir, 'bin', 'curl'), FAKE_CURL);
    chmodSync(join(dir, 'bin', 'docker'), 0o755);
    chmodSync(join(dir, 'bin', 'curl'), 0o755);
    writeFileSync(
      join(dir, 'app', '.env.production'),
      `TELEGRAM_BOT_TOKEN=${token}\n`,
    );
    writeFileSync(
      join(dir, 'ops', 'backup-alert.env'),
      'BACKUP_ALERT_TELEGRAM_CHAT_ID=42\n',
    );
    writeFileSync(
      join(dir, 'ops', 'backup-minio-offsite.sh'),
      readFileSync(MINIO_SCRIPT),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (env: Record<string, string>, args: string[] = []) =>
    spawnSync('bash', [ALERT_SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
        HOME: dir,
        ELCHI_APP_DIR: join(dir, 'app'),
        ELCHI_OPS_DIR: join(dir, 'ops'),
        FAKE_CURL_LOG: join(dir, 'curl.log'),
        FAKE_elchi_db_backup: 'running healthy',
        FAKE_elchi_backup_offsite: 'running healthy',
        ...env,
      },
    });
  const minioOk = (at: number) =>
    writeFileSync(
      join(dir, 'ops', 'state', 'minio-offsite', 'status'),
      `state=ok\nlast_success_at=${at}\nmessage=ok\n`,
    );
  const curlCalls = () =>
    existsSync(join(dir, 'curl.log'))
      ? readFileSync(join(dir, 'curl.log'), 'utf8').trim().split('\n')
      : [];

  it('all healthy -> no message; problem -> one Telegram message (token only via stdin); repeat suppressed; recovery message', () => {
    const now = Math.floor(Date.now() / 1000);
    minioOk(now);
    expect(run({ BACKUP_ALERT_NOW: String(now) }).status).toBe(0);
    expect(curlCalls()).toEqual([]);

    const bad = {
      BACKUP_ALERT_NOW: String(now + 60),
      FAKE_elchi_db_backup: 'running unhealthy',
    };
    expect(run(bad).status).toBe(1);
    expect(curlCalls()).toHaveLength(1);
    expect(curlCalls()[0]).toMatch(/-K -/);
    expect(curlCalls()[0]).toMatch(/chat_id=42/);
    expect(curlCalls()[0]).toMatch(
      /DB kunlik backup: elchi-db-backup = running unhealthy/,
    );
    expect(curlCalls()[0]).not.toContain(token);
    expect(readFileSync(join(dir, 'curl.log.stdin'), 'utf8')).toContain(
      `bot${token}/sendMessage`,
    );

    expect(run({ ...bad, BACKUP_ALERT_NOW: String(now + 900) }).status).toBe(1);
    expect(curlCalls()).toHaveLength(1); // same problem, < 6h: no repeat
    expect(
      run({ ...bad, BACKUP_ALERT_NOW: String(now + 7 * 3600) }).status,
    ).toBe(1);
    expect(curlCalls()).toHaveLength(2); // repeat after 6h

    minioOk(now + 7 * 3600);
    expect(run({ BACKUP_ALERT_NOW: String(now + 7 * 3600 + 60) }).status).toBe(
      0,
    );
    expect(curlCalls()).toHaveLength(3);
    expect(curlCalls()[2]).toMatch(/tiklandi/);
    const log = readFileSync(
      join(dir, 'ops', 'logs', 'backup-alert.log'),
      'utf8',
    );
    expect(log).not.toContain(token);
  });

  it('missing container / stale MinIO copy are problems; --dry-run sends nothing', () => {
    const now = Math.floor(Date.now() / 1000);
    minioOk(now - 2 * DAY);
    const r = run(
      { BACKUP_ALERT_NOW: String(now), FAKE_elchi_backup_offsite: '' },
      ['--dry-run'],
    );
    expect(r.stdout).toMatch(/send=problem/);
    expect(r.stdout).toMatch(
      /DB off-site \(R2\): elchi-backup-offsite = missing/,
    );
    expect(r.stdout).toMatch(
      /MinIO off-site \(R2\): UNHEALTHY: last successful run/,
    );
    expect(curlCalls()).toEqual([]);
  });

  it('no channel configured -> only a log line', () => {
    rmSync(join(dir, 'ops', 'backup-alert.env'));
    const now = Math.floor(Date.now() / 1000);
    minioOk(now);
    expect(
      run({
        BACKUP_ALERT_NOW: String(now),
        FAKE_elchi_db_backup: 'exited no-healthcheck',
      }).status,
    ).toBe(1);
    expect(curlCalls()).toEqual([]);
    expect(
      readFileSync(join(dir, 'ops', 'logs', 'backup-alert.log'), 'utf8'),
    ).toMatch(/kanal sozlanmagan/);
  });
});

// ---------------------------------------------------------------------------
describe('ops wiring — compose / deploy.yml / rotation (ZfI9nERJ, AFiXurLH)', () => {
  const compose = read('docker-compose.prod.yml');
  const deploy = read('.github/workflows/deploy.yml');

  it('cloudflared: pinned tag+digest (never :latest), two replicas, no depends_on gateway, grace period', () => {
    expect(compose).not.toMatch(/cloudflared:latest/);
    expect(compose).toMatch(
      /^ {2}image: cloudflare\/cloudflared:\d{4}\.\d+\.\d+@sha256:[0-9a-f]{64}$/m,
    );
    expect(compose).toMatch(
      /^ {2}cloudflared:\n {4}<<: \*cloudflared\n {4}container_name: elchi-cloudflared$/m,
    );
    expect(compose).toMatch(
      /^ {2}cloudflared-2:\n {4}<<: \*cloudflared\n {4}container_name: elchi-cloudflared-2$/m,
    );
    const block = compose.slice(
      compose.indexOf('x-cloudflared:'),
      compose.indexOf('\nservices:'),
    );
    expect(block).not.toMatch(/depends_on/);
    expect(block).toMatch(/stop_grace_period: 35s/);
  });

  it('deploy: cloudflared is not pulled, never recreated routinely, rolled one at a time when the pin changes', () => {
    expect(deploy).toMatch(/pull rabbitmq postgres minio \|\| true/);
    expect(deploy).not.toMatch(/pull [^\n]*cloudflared/);
    expect(deploy).not.toMatch(/up -d --no-deps cloudflared \|\| true/);
    const fn = deploy.slice(deploy.indexOf('cloudflared_rollout() {'));
    expect(fn).toMatch(/for s in cloudflared-2 cloudflared; do/);
    expect(fn).toMatch(/--no-recreate "\$s"/);
    expect(fn).toMatch(/--force-recreate "\$s"/);
    expect(fn).toMatch(/Registered tunnel connection/);
    expect(deploy).toMatch(/cloudflared_rollout \|\| echo "WARNING/);
  });

  it('deploy: api-gateway is swapped (scale 2, wait healthy, retire old), not recreated in the bulk up', () => {
    expect(deploy).toMatch(/--no-recreate --scale api-gateway=2 api-gateway/);
    expect(deploy).toMatch(/docker stop -t 30 "\$old"/);
    expect(deploy).toMatch(/sed 's\/ api-gateway \/ \/;/);
    const bulk = deploy.indexOf('--build --remove-orphans $DEPLOY_SERVICES');
    expect(bulk).toBeGreaterThan(deploy.indexOf('GATEWAY_SWAP=true'));
    expect(
      deploy.indexOf('            if [ "$GATEWAY_SWAP" = true ]; then'),
    ).toBeGreaterThan(bulk);
  });

  it('deploy: the .env.production safety copy is private and deleted (AFiXurLH)', () => {
    expect(deploy).not.toMatch(
      /cp -f \.env\.production \/tmp\/elchi-env-backup /,
    );
    expect(deploy).toMatch(
      /ENV_BACKUP="\$\(umask 077 && mktemp \/tmp\/elchi-env-backup\.XXXXXXXXXX\)"/,
    );
    expect(deploy).toMatch(/trap 'rm -f "\$ENV_BACKUP"' EXIT/);
    expect(deploy).toMatch(
      /test -f \.env\.production \|\| cp -f "\$ENV_BACKUP" \.env\.production/,
    );
    const rollback = deploy.slice(
      deploy.indexOf('rollback() {'),
      deploy.indexOf("trap 'rollback' ERR"),
    );
    expect(rollback).toContain('cp -f "$ENV_BACKUP" .env.production');
  });

  it('rotation script: dry-run by default, secrets never in argv', () => {
    const rot = read('scripts/rotate-datastore-secrets.sh');
    expect(rot).toMatch(/EXECUTE=false/);
    expect(rot).not.toMatch(/rabbitmqctl[^\n]*add_user "\$u" "\$p"/);
    expect(rot).not.toMatch(/rabbitmqctl[^\n`]*authenticate_user "/);
    expect(rot).toMatch(/-K - "http:\/\/127\.0\.0\.1:15672\/api\/whoami"/);
    const syntax = spawnSync('bash', [
      '-n',
      join(ROOT, 'scripts', 'rotate-datastore-secrets.sh'),
    ]);
    expect(syntax.status).toBe(0);
  });

  it('all new shell scripts parse', () => {
    for (const f of [
      'backup-minio-offsite-cron.sh',
      'backup-alert.sh',
      'restore-drill.sh',
    ]) {
      expect(spawnSync('bash', ['-n', join(ROOT, 'scripts', f)]).status).toBe(
        0,
      );
    }
    expect(spawnSync('sh', ['-n', MINIO_SCRIPT]).status).toBe(0);
  });
});
