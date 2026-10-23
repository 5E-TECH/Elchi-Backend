import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Off-site copies of the DB dumps -> Cloudflare R2 (`backup-offsite` service,
 * scripts/backup-offsite.sh).
 *
 * Runs the REAL POSIX-sh script (dash as `sh`; one run also under busybox sh,
 * what the rclone/rclone image has) with a fake `rclone` first in PATH that
 * maps `r2:<bucket>/…` onto a temp directory — no Docker, no network. Then
 * checks the compose / deploy.yml wiring statically.
 */
const ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'backup-offsite.sh');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const DAY = 86400;
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const SECRET = 'test-secret-Zq9v-never-printed';
const R2_ENV = {
  R2_ACCOUNT_ID: ACCOUNT,
  R2_ACCESS_KEY_ID: 'test-access-key-id',
  R2_SECRET_ACCESS_KEY: SECRET,
};

// FAKE_RCLONE: ok | fail-list (R2 listing denied) | corrupt (upload differs) | fail-delete
const FAKE_RCLONE = `#!/usr/bin/env bash
echo "rclone $*" >> "$FAKE_LOG"
env | grep '^RCLONE_CONFIG' | sort > "$FAKE_ENV"
map() { case "$1" in r2:*) echo "$FAKE_R2/\${1#r2:}" ;; *) echo "$1" ;; esac; }
bucket_ok() {
  case "$1" in
    r2:*) b="\${1#r2:}"; b="\${b%%/*}"; [ -d "$FAKE_R2/$b" ] ;;
    *) return 0 ;;
  esac
}
cmd="$1"; shift
pos=(); list=""; maxage=""; minage=""
while [ $# -gt 0 ]; do
  case "$1" in
    --files-from-raw) list="$2"; shift 2 ;;
    --max-age) maxage="\${2%d}"; shift 2 ;;
    --min-age) minage="\${2%d}"; shift 2 ;;
    --include|--max-depth|--transfers|--stats) shift 2 ;;
    --*) shift ;;
    *) pos+=("$1"); shift ;;
  esac
done
now=$(date +%s)
fresh() {
  m=$(stat -c %Y "$1")
  [ -z "$maxage" ] || [ $((now - m)) -lt $((maxage * 86400)) ] || return 1
  [ -z "$minage" ] || [ $((now - m)) -gt $((minage * 86400)) ] || return 1
}
case "$cmd" in
  lsf)
    if [ "\${FAKE_RCLONE:-}" = fail-list ] && [[ "\${pos[0]}" == r2:* ]]; then
      echo "ERROR : : error listing: api error SignatureDoesNotMatch" >&2; exit 1
    fi
    bucket_ok "\${pos[0]}" || { echo "ERROR : : error listing: directory not found" >&2; exit 3; }
    d=$(map "\${pos[0]}")
    [ -d "$d" ] || { echo "ERROR : : error listing: directory not found" >&2; exit 3; }
    for f in "$d"/*.sql.gz; do [ -f "$f" ] && fresh "$f" && basename "$f"; done | sort
    ;;
  copy)
    bucket_ok "\${pos[1]}" || { echo "ERROR : x: Failed to copy: api error NoSuchBucket" >&2; exit 1; }
    s=$(map "\${pos[0]}"); t=$(map "\${pos[1]}"); mkdir -p "$t"
    while IFS= read -r n; do
      [ -f "$s/$n" ] || continue
      [ -e "$t/$n" ] && continue
      cp -p "$s/$n" "$t/$n"
      if [ "\${FAKE_RCLONE:-}" = corrupt ]; then printf x >> "$t/$n"; fi
    done < "$list"
    exit 0
    ;;
  check)
    s=$(map "\${pos[0]}"); t=$(map "\${pos[1]}"); rc=0
    while IFS= read -r n; do
      [ -f "$s/$n" ] || continue
      cmp -s "$s/$n" "$t/$n" || { echo "ERROR : $n: md5 differ" >&2; rc=1; }
    done < "$list"
    exit $rc
    ;;
  delete)
    [ "\${FAKE_RCLONE:-}" = fail-delete ] && { echo "ERROR : delete failed" >&2; exit 1; }
    d=$(map "\${pos[0]}")
    for f in "$d"/*.sql.gz; do [ -f "$f" ] && fresh "$f" && rm -f "$f"; done
    exit 0
    ;;
  *) echo "fake rclone $cmd \${pos[*]}" ;;
esac
`;

const SLEEP = `#!/usr/bin/env bash
echo "$1" >> "$SLEEP_LOG"
`;

const isLinux = process.platform === 'linux';
const hasBusybox =
  isLinux && spawnSync('busybox', ['sh', '-c', 'exit 0']).status === 0;
const describeLinux = isLinux ? describe : describe.skip;

describeLinux('backup-offsite.sh — R2 off-site copies (fake rclone)', () => {
  let tmp: string;
  let bin: string;
  let work: string;
  let src: string;
  let r2: string;
  let state: string;
  let fakeLog: string;
  let fakeEnv: string;
  let sleepLog: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'elchi-offsite-spec-'));
    bin = join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'rclone'), FAKE_RCLONE);
    writeFileSync(join(bin, 'sleep'), SLEEP);
    chmodSync(join(bin, 'rclone'), 0o755);
    chmodSync(join(bin, 'sleep'), 0o755);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    work = mkdtempSync(join(tmp, 'case-'));
    src = join(work, 'backups');
    r2 = join(work, 'r2');
    state = join(work, 'state');
    fakeLog = join(work, 'rclone.log');
    fakeEnv = join(work, 'rclone.env');
    sleepLog = join(work, 'sleep.log');
    for (const d of ['daily', 'pre-deploy', 'pre-migration']) {
      mkdirSync(join(src, d), { recursive: true });
    }
    mkdirSync(join(r2, 'elchi-db-backups'), { recursive: true });
    writeFileSync(fakeLog, '');
    writeFileSync(sleepLog, '');
  });

  /** A clean env: never inherit R2_* / OFFSITE_* from the developer's shell. */
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: tmp,
    OFFSITE_SRC_ROOT: src,
    OFFSITE_STATE_DIR: state,
    OFFSITE_MAX_CYCLES: '1',
    FAKE_R2: r2,
    FAKE_LOG: fakeLog,
    FAKE_ENV: fakeEnv,
    SLEEP_LOG: sleepLog,
    ...extra,
  });
  const run = (
    args: string[] = [],
    extra: Record<string, string> = {},
    shell: string[] = ['sh'],
  ): SpawnSyncReturns<string> =>
    spawnSync(shell[0], [...shell.slice(1), SCRIPT, ...args], {
      env: env(extra),
      encoding: 'utf8',
      cwd: work,
      timeout: 15000,
      killSignal: 'SIGKILL',
    });

  const nowS = () => Math.floor(Date.now() / 1000);
  /** A dump file whose mtime is `ageDays` old (rclone ages by mtime). */
  const put = (path: string, ageDays = 0, body = `dump ${path}`) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
    const t = nowS() - Math.round(ageDays * DAY);
    utimesSync(path, t, t);
  };
  const ls = (d: string) => {
    try {
      return readdirSync(d).sort();
    } catch {
      return [];
    }
  };
  const remote = (sub: string) => ls(join(r2, 'elchi-db-backups', sub));
  const status = () => {
    const out: Record<string, string> = {};
    for (const line of readFileSync(join(state, 'status'), 'utf8').split(
      '\n',
    )) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
  };
  const rcloneCalls = () =>
    readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean);
  const sleeps = () =>
    readFileSync(sleepLog, 'utf8').split('\n').filter(Boolean).map(Number);

  const seed = () => {
    put(join(src, 'daily', 'elchi-daily-20261021T000001Z.sql.gz'), 2);
    put(join(src, 'daily', 'elchi-daily-20261022T000001Z.sql.gz'), 1);
    put(join(src, 'daily', 'elchi-daily-20261023T000001Z.sql.gz'), 0);
    // a dump being written right now, and an unrelated file
    put(join(src, 'daily', '.elchi-daily-20261024T000001Z.sql.gz.partial.42'));
    put(join(src, 'daily', 'notes.txt'));
    put(
      join(
        src,
        'pre-deploy',
        'pre-deploy-20261022T100000Z-1111111-to-2222222.sql.gz',
      ),
      1,
    );
    // older than the 30-day retention: never uploaded (would be pruned at once)
    put(join(src, 'pre-migration', 'pre-migration-20260901-101010.sql.gz'), 45);
    put(join(src, 'pre-migration', 'pre-migration-20261019-101010.sql.gz'), 4);
  };

  describe('without R2 keys: warns, stays up, healthy', () => {
    it('logs «R2 sozlanmagan» every interval, never calls rclone, status disabled', () => {
      seed();
      const r = run([], { OFFSITE_MAX_CYCLES: '2' });
      expect(r.status).toBe(0);
      const warnings = r.stderr
        .split('\n')
        .filter((l) => l.includes("R2 sozlanmagan — off-site nusxa o'chiq"));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain(
        'R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY',
      );
      expect(sleeps()).toEqual([3600]); // keeps looping (no crash loop)
      expect(rcloneCalls()).toEqual([]);
      expect(status().state).toBe('disabled');
      expect(remote('daily')).toEqual([]);

      const check = run(['--check']);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('disabled by config');
    });

    it('template placeholders count as missing', () => {
      const r = run([], {
        R2_ACCOUNT_ID: ACCOUNT,
        R2_ACCESS_KEY_ID: '__REPLACE_WITH_R2_ACCESS_KEY_ID__',
        R2_SECRET_ACCESS_KEY: '',
      });
      expect(r.stderr).toContain(
        "(.env.production da yo'q: R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY)",
      );
      expect(rcloneCalls()).toEqual([]);
    });

    it('the `rclone` wrapper refuses to run unconfigured', () => {
      const r = run(['rclone', 'lsl', 'r2:elchi-db-backups']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('R2 sozlanmagan');
      expect(rcloneCalls()).toEqual([]);
    });
  });

  describe('configured', () => {
    const shells: [string, string[]][] = [['sh', ['sh']]];
    if (hasBusybox) shells.push(['busybox sh', ['busybox', 'sh']]);

    it.each(shells)(
      '[%s] first run uploads every fresh *.sql.gz of daily/pre-deploy/pre-migration, verifies, one log line',
      (_name, shell) => {
        seed();
        const r = run([], R2_ENV, shell);
        expect(r.status).toBe(0);
        expect(remote('daily')).toEqual([
          'elchi-daily-20261021T000001Z.sql.gz',
          'elchi-daily-20261022T000001Z.sql.gz',
          'elchi-daily-20261023T000001Z.sql.gz',
        ]);
        expect(remote('pre-deploy')).toEqual([
          'pre-deploy-20261022T100000Z-1111111-to-2222222.sql.gz',
        ]);
        expect(remote('pre-migration')).toEqual([
          'pre-migration-20261019-101010.sql.gz',
        ]);
        const okLines = r.stdout
          .split('\n')
          .filter((l) => l.startsWith('[backup-offsite] ok @'));
        expect(okLines).toHaveLength(1);
        expect(okLines[0]).toContain(
          'uploaded 5 (daily=3 pre-deploy=1 pre-migration=1), pruned 0 older than 30d -> r2:elchi-db-backups',
        );
        const s = status();
        expect(s.state).toBe('ok');
        expect(s.last_uploaded).toBe('5');
        expect(Number(s.last_success_at)).toBeGreaterThan(nowS() - 60);

        // never-overwrite flags + explicit size/MD5 check of the new uploads
        const calls = rcloneCalls();
        const copies = calls.filter((c) => c.startsWith('rclone copy'));
        expect(copies).toHaveLength(3);
        for (const c of copies) {
          expect(c).toContain('--ignore-existing');
          expect(c).toContain('--immutable');
          expect(c).toContain('--files-from-raw');
        }
        expect(calls.filter((c) => c.startsWith('rclone check'))).toHaveLength(
          3,
        );

        // rclone configured purely via env, no config file
        const rcloneEnv = readFileSync(fakeEnv, 'utf8');
        for (const line of [
          'RCLONE_CONFIG=',
          'RCLONE_CONFIG_R2_TYPE=s3',
          'RCLONE_CONFIG_R2_PROVIDER=Cloudflare',
          `RCLONE_CONFIG_R2_ENDPOINT=https://${ACCOUNT}.r2.cloudflarestorage.com`,
          'RCLONE_CONFIG_R2_REGION=auto',
          'RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true',
          'RCLONE_CONFIG_R2_ACCESS_KEY_ID=test-access-key-id',
          `RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=${SECRET}`,
        ]) {
          expect(rcloneEnv.split('\n')).toContain(line);
        }
        // … and the secret never reaches the log or the status file
        expect(r.stdout + r.stderr).not.toContain(SECRET);
        expect(readFileSync(join(state, 'status'), 'utf8')).not.toContain(
          SECRET,
        );
      },
    );

    it('nothing new -> no upload; an existing R2 object is never overwritten', () => {
      seed();
      const name = 'elchi-daily-20261023T000001Z.sql.gz';
      const existing = join(r2, 'elchi-db-backups', 'daily', name);
      put(existing, 0, 'the copy already in R2');
      expect(run([], R2_ENV).status).toBe(0);
      expect(readFileSync(existing, 'utf8')).toBe('the copy already in R2');

      writeFileSync(fakeLog, '');
      const r = run([], R2_ENV);
      expect(r.stdout).toContain(
        'uploaded 0 (daily=0 pre-deploy=0 pre-migration=0)',
      );
      expect(rcloneCalls().filter((c) => c.startsWith('rclone copy'))).toEqual(
        [],
      );
    });

    it('prunes R2 copies older than OFFSITE_RETENTION_DAYS, only *.sql.gz in its own prefixes', () => {
      seed();
      const bucket = join(r2, 'elchi-db-backups');
      put(join(bucket, 'daily', 'elchi-daily-20260901T000001Z.sql.gz'), 40);
      put(
        join(bucket, 'pre-deploy', 'pre-deploy-20260901T000000Z-a-to-b.sql.gz'),
        31,
      );
      put(
        join(bucket, 'pre-deploy', 'pre-deploy-20261001T000000Z-c-to-d.sql.gz'),
        20,
      );
      put(join(bucket, 'daily', 'README.txt'), 90);
      put(join(bucket, 'manual', 'manual-20260101.sql.gz'), 300);

      const r = run([], R2_ENV);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('pruned 2 older than 30d');
      expect(remote('daily')).not.toContain(
        'elchi-daily-20260901T000001Z.sql.gz',
      );
      expect(remote('daily')).toContain('README.txt');
      expect(remote('pre-deploy')).toEqual([
        'pre-deploy-20261001T000000Z-c-to-d.sql.gz',
        'pre-deploy-20261022T100000Z-1111111-to-2222222.sql.gz',
      ]);
      expect(remote('manual')).toEqual(['manual-20260101.sql.gz']);
      expect(
        rcloneCalls()
          .filter((c) => c.startsWith('rclone delete'))
          .every((c) => c.includes('--min-age 30d')),
      ).toBe(true);
    });

    it('OFFSITE_RETENTION_DAYS is configurable', () => {
      put(join(src, 'daily', 'elchi-daily-20261023T000001Z.sql.gz'), 0);
      put(
        join(
          r2,
          'elchi-db-backups',
          'daily',
          'elchi-daily-20261010T000001Z.sql.gz',
        ),
        13,
      );
      expect(run([], { ...R2_ENV, OFFSITE_RETENTION_DAYS: '7' }).status).toBe(
        0,
      );
      expect(remote('daily')).toEqual(['elchi-daily-20261023T000001Z.sql.gz']);
    });

    it('daily dumps stopped (no fresh daily copy in R2) -> nothing is pruned, with a warning', () => {
      const bucket = join(r2, 'elchi-db-backups');
      put(join(bucket, 'daily', 'elchi-daily-20260901T000001Z.sql.gz'), 40);
      put(
        join(bucket, 'pre-deploy', 'pre-deploy-20260901T000000Z-a-to-b.sql.gz'),
        40,
      );
      const r = run([], R2_ENV);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("eski nusxalar O'CHIRILMADI");
      expect(r.stdout).toContain('prune skipped');
      expect(remote('daily')).toEqual(['elchi-daily-20260901T000001Z.sql.gz']);
      expect(remote('pre-deploy')).toEqual([
        'pre-deploy-20260901T000000Z-a-to-b.sql.gz',
      ]);
      expect(
        rcloneCalls().filter((c) => c.startsWith('rclone delete')),
      ).toEqual([]);
    });

    it.each([
      ['R2 listing denied (bad key)', { FAKE_RCLONE: 'fail-list' }, 'list R2'],
      [
        'upload differs from the local file',
        { FAKE_RCLONE: 'corrupt' },
        'verify (size+md5)',
      ],
      ['the bucket does not exist', { R2_BUCKET: 'no-such-bucket' }, 'upload'],
    ])(
      'a failed run (%s) deletes nothing, is logged, and stays unhealthy',
      (_c, extra, step) => {
        seed();
        const old = join(
          r2,
          'elchi-db-backups',
          'daily',
          'elchi-daily-20260901T000001Z.sql.gz',
        );
        put(old, 40);
        const r = run([], { ...R2_ENV, ...extra });
        expect(r.status).toBe(0); // the loop survives
        expect(r.stderr).toContain('[backup-offsite] ERROR: sync failed');
        expect(r.stderr).toContain(step);
        expect(r.stderr).toContain('nothing pruned');
        expect(r.stderr).toMatch(/\[backup-offsite\] {3}rclone: .*ERROR/);
        expect(existsSync(old)).toBe(true);
        expect(status().state).toBe('error');
        expect(status().last_success_at).toBe('');
        const check = run(['--check'], { ...R2_ENV, ...extra });
        expect(check.status).toBe(1);
        expect(check.stderr).toContain('no successful sync yet');
      },
    );

    it('a failed prune is an error too', () => {
      seed();
      put(
        join(
          r2,
          'elchi-db-backups',
          'daily',
          'elchi-daily-20260901T000001Z.sql.gz',
        ),
        40,
      );
      const r = run([], { ...R2_ENV, FAKE_RCLONE: 'fail-delete' });
      expect(r.stderr).toContain('the retention prune failed');
      expect(status().state).toBe('error');
    });

    it('an invalid R2_BUCKET is rejected before any rclone call', () => {
      const r = run([], { ...R2_ENV, R2_BUCKET: 'Bad/../bucket' });
      expect(r.stderr).toContain(
        "R2_BUCKET='Bad/../bucket' is not a valid bucket name",
      );
      expect(rcloneCalls()).toEqual([]);
      expect(status().state).toBe('error');
    });

    it('a restart keeps the last success; bad interval values fall back', () => {
      seed();
      expect(run([], R2_ENV).status).toBe(0);
      const first = status().last_success_at;
      const r = run([], {
        ...R2_ENV,
        FAKE_RCLONE: 'fail-list',
        OFFSITE_MAX_CYCLES: '2',
        OFFSITE_INTERVAL_SECONDS: 'hourly',
      });
      expect(r.stderr).toContain(
        "OFFSITE_INTERVAL_SECONDS='hourly' is not a positive integer — using 3600",
      );
      expect(sleeps()).toEqual([3600]);
      expect(status().last_success_at).toBe(first);

      writeFileSync(sleepLog, '');
      run([], { OFFSITE_MAX_CYCLES: '2', OFFSITE_INTERVAL_SECONDS: '5' });
      expect(sleeps()).toEqual([60]); // minimum 60s
    });

    it('`rclone` wrapper runs rclone with the r2: remote configured from R2_*', () => {
      const r = run(['rclone', 'lsl', 'r2:elchi-db-backups/daily'], R2_ENV);
      expect(r.status).toBe(0);
      expect(rcloneCalls()).toEqual(['rclone lsl r2:elchi-db-backups/daily']);
      expect(readFileSync(fakeEnv, 'utf8')).toContain(
        `RCLONE_CONFIG_R2_ENDPOINT=https://${ACCOUNT}.r2.cloudflarestorage.com`,
      );
    });

    it('R2_ENDPOINT overrides the account-derived endpoint', () => {
      run(['rclone', 'version'], {
        R2_ENDPOINT: 'https://acc.eu.r2.cloudflarestorage.com',
        R2_ACCESS_KEY_ID: 'k',
        R2_SECRET_ACCESS_KEY: 's',
      });
      expect(readFileSync(fakeEnv, 'utf8')).toContain(
        'RCLONE_CONFIG_R2_ENDPOINT=https://acc.eu.r2.cloudflarestorage.com',
      );
    });
  });

  describe('--check (container healthcheck)', () => {
    const writeStatus = (fields: Record<string, string | number>) => {
      mkdirSync(state, { recursive: true });
      writeFileSync(
        join(state, 'status'),
        Object.entries(fields)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n') + '\n',
      );
    };
    const check = (now: number) =>
      run(['--check'], { ...R2_ENV, OFFSITE_NOW: String(now) });
    const T = 1792540800;

    it('healthy while the last successful sync is < 26h old, unhealthy after', () => {
      writeStatus({ state: 'ok', started_at: T, last_success_at: T });
      expect(check(T + 26 * 3600).status).toBe(0);
      expect(check(T + 26 * 3600 + 1).status).toBe(1);
      // a later failure does not flip it while the last success is fresh
      writeStatus({ state: 'error', started_at: T, last_success_at: T });
      expect(check(T + 3600).status).toBe(0);
    });

    it('first sync in progress is healthy; a first run that failed is not', () => {
      writeStatus({ state: 'starting', started_at: T, last_success_at: '' });
      expect(check(T + 600).status).toBe(0);
      writeStatus({ state: 'error', started_at: T, last_success_at: '' });
      expect(check(T + 600).status).toBe(1);
    });

    it('configured but no status file -> unhealthy', () => {
      expect(check(T).status).toBe(1);
    });
  });
});

describe('backup-offsite — script is POSIX sh (rclone image has busybox, no bash)', () => {
  const script = read('scripts/backup-offsite.sh');
  const code = script
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('has a /bin/sh shebang and no bash-isms', () => {
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    for (const bashism of [
      /\[\[/,
      /^\s*local\s/m,
      /BASH_SOURCE|BASH_REMATCH|shopt|pipefail/,
      /^\s*function\s/m,
      /\w+=\(/,
      /\$\{!/,
      /<<</,
    ]) {
      expect(code).not.toMatch(bashism);
    }
  });

  const parsers: [string, string[]][] = [['sh', ['sh']]];
  if (hasBusybox) parsers.push(['busybox sh', ['busybox', 'sh']]);
  it.each(parsers)('`%s -n` parses it', (_name, shell) => {
    const r = spawnSync(shell[0], [...shell.slice(1), '-n', SCRIPT], {
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('never writes an rclone config file, never traces or prints the env', () => {
    expect(code).not.toMatch(/rclone\s+config\b/);
    expect(code).not.toMatch(/rclone\.conf/);
    expect(code).not.toMatch(/set\s+-\w*x/);
    expect(code).not.toMatch(/^\s*(env|printenv|export -p|set)\s*$/m);
    // the secret is expanded exactly twice: the "is it set" test and the
    // copy into rclone's env var — never in an echo / log / status line
    const expansions = code
      .split('\n')
      .filter((l) =>
        /\$\{?(R2_SECRET_ACCESS_KEY|RCLONE_CONFIG_R2_SECRET_ACCESS_KEY)\b/.test(
          l,
        ),
      )
      .map((l) => l.trim());
    expect(expansions).toEqual([
      'offsite_unset "${R2_SECRET_ACCESS_KEY:-}" && _om="$_om R2_SECRET_ACCESS_KEY"',
      'RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"',
    ]);
  });
});

describe('backup-offsite — wiring (docker-compose.prod.yml + deploy.yml)', () => {
  const compose = read('docker-compose.prod.yml');
  const deploy = read('.github/workflows/deploy.yml');
  const svc = compose.slice(
    compose.indexOf('\n  backup-offsite:'),
    compose.indexOf('\n  db-reconcile:'),
  );

  it('compose: pinned rclone image, read-only backups mount, entrypoint, healthcheck, limits', () => {
    expect(svc.length).toBeGreaterThan(50);
    expect(svc).toMatch(/^ {4}image: rclone\/rclone:\d+\.\d+\.\d+$/m);
    expect(svc).toContain('image: rclone/rclone:1.68.2');
    expect(svc).not.toMatch(/latest/);
    expect(svc).toContain('env_file: .env.production');
    expect(svc).toContain('- ./backups:/backups:ro');
    expect(svc).toContain('- ./scripts:/scripts:ro');
    expect(svc).not.toMatch(/- \.\/backups:\/backups\s*$/m); // never writable
    expect(svc).toContain("entrypoint: ['sh', '/scripts/backup-offsite.sh']");
    expect(svc).toContain(
      "test: ['CMD', 'sh', '/scripts/backup-offsite.sh', '--check']",
    );
    expect(svc).toContain('restart: unless-stopped');
    expect(svc).toMatch(/mem_limit: \d+m/);
  });

  it('compose: no secrets, no rclone config, no masking OFFSITE_* defaults', () => {
    // keys come only from .env.production (env_file); comments may name them
    expect(svc).not.toMatch(/^\s*-?\s*(R2_|RCLONE_|OFFSITE_)\w*\s*[:=]/m);
    expect(svc).not.toMatch(/^\s*environment:/m);
    expect(compose).not.toMatch(/R2_SECRET_ACCESS_KEY\s*[:=]\s*\S/);
    expect(compose).not.toMatch(/RCLONE_CONFIG_R2_SECRET_ACCESS_KEY/);
  });

  it('no other service depends on it (only its own definition names it)', () => {
    const refs = compose
      .split('\n')
      .filter((l) => /^\s+-?\s*backup-offsite:?\s*$/.test(l));
    expect(refs).toEqual(['  backup-offsite:']);
  });

  it('deploy: started on every deploy (created on the first), recreated when its script changes', () => {
    expect(deploy).toContain('BACKUP_OFFSITE_RECREATE=false');
    expect(deploy).toMatch(
      /grep -Eq '\^scripts\/backup-offsite\\\.sh\$' \/tmp\/elchi-changed-files; then\s+BACKUP_OFFSITE_RECREATE=true/,
    );
    expect(deploy).toContain(
      'up -d --no-deps --force-recreate backup-offsite ||',
    );
    expect(deploy).toMatch(/up -d --no-deps backup-offsite \|\|/);
    // top level of the script (not nested under a "changed files" branch),
    // after db-backup is up and before the final cleanup
    const start = deploy.indexOf(
      '\n            if [ "$BACKUP_OFFSITE_RECREATE" = true ]; then\n',
    );
    expect(start).toBeGreaterThan(deploy.indexOf('up -d --no-deps db-backup'));
    expect(start).toBeLessThan(deploy.indexOf('bash scripts/docker-gc.sh'));
  });

  it('deploy: never waits for or gates on backup-offsite', () => {
    expect(deploy).not.toMatch(/--wait\b/);
    const lines = deploy
      .split('\n')
      .filter((l) => l.includes('backup-offsite'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      if (/docker compose .* up -d/.test(l)) {
        // a failed start only warns — `||` keeps it out of `set -e` / the ERR trap
        expect(l).toMatch(/\|\| echo "WARNING: backup-offsite/);
      }
      expect(l).not.toMatch(/inspect|Health|exit 1|SIDECAR_OK=false/);
    }
    // the rollback never touches it
    const rollback = deploy.slice(
      deploy.indexOf('rollback() {'),
      deploy.indexOf("trap 'rollback' ERR"),
    );
    expect(rollback).not.toContain('backup-offsite');
  });

  it('.env.example: R2 keys are empty (no real credentials in the repo)', () => {
    const env = read('.env.example');
    for (const key of [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ]) {
      const line = env.split('\n').find((l) => l.startsWith(`${key}=`));
      expect(line).toBeDefined();
      const value = (line as string).slice(key.length + 1).trim();
      expect(
        value === '' || /^__REPLACE_WITH[A-Za-z0-9_]*__$/.test(value),
      ).toBe(true);
    }
  });
});
