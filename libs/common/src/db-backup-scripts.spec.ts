import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Avtomatik backup tizimi (Elchi Pochta):
 *   - har kuni 05:00 (Asia/Tashkent) backup, oxirgi 7 tasi saqlanadi;
 *   - har bir deploydan oldin backup, oxirgi 5 tasi saqlanadi.
 *
 * Runs the REAL bash scripts (scripts/backup-cron.sh, backup-db.sh,
 * pre-deploy-backup.sh) with fake `pg_dump` / `docker` / `sleep` shims first
 * in PATH, a temp BACKUP_DIR and the clock pinned through BACKUP_NOW — no
 * Docker, no Postgres. The host zone is pinned to Europe/Berlin (what the prod
 * server runs) to prove the schedule only follows BACKUP_TZ.
 *
 * Needs GNU date (Linux: CI, the server, the postgres:15 image); skipped elsewhere.
 */
const ROOT = join(__dirname, '..', '..', '..');
const CRON = join(ROOT, 'scripts', 'backup-cron.sh');
const DUMP = join(ROOT, 'scripts', 'backup-db.sh');
const PRE_DEPLOY = join(ROOT, 'scripts', 'pre-deploy-backup.sh');

/** Epoch seconds of a Tashkent wall-clock time (fixed UTC+05:00, no DST). */
const tashkent = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) =>
  Date.UTC(y, mo - 1, d, h - 5, mi, s) / 1000;

/** The UTC stamp the scripts put in file names: 20261021T000000Z. */
const stamp = (epoch: number) =>
  new Date(epoch * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

const SHIMS: Record<string, string> = {
  // FAKE_PG: ok | fail (dies mid-dump) | truncated (exit 0, no trailer) | tiny
  pg_dump: `#!/usr/bin/env bash
case "\${FAKE_PG:-ok}" in
  fail) head -c 3000 /dev/urandom | base64; echo "fake pg_dump: connection lost" >&2; exit 1 ;;
  truncated) head -c 3000 /dev/urandom | base64; exit 0 ;;
  tiny) printf -- '--\\n-- PostgreSQL database dump complete\\n--\\n'; exit 0 ;;
esac
head -c 3000 /dev/urandom | base64
printf -- '--\\n-- PostgreSQL database dump complete\\n--\\n\\n\\\\unrestrict fake\\n'
`,
  // FAKE_PG_CONTAINER: running | stopped | none
  docker: `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$*" in
  *"ps --all --quiet postgres"*) [ "\${FAKE_PG_CONTAINER:-running}" = none ] || echo pgcid ;;
  "inspect -f {{.State.Running}} pgcid") [ "\${FAKE_PG_CONTAINER:-running}" = running ] && echo true || echo false ;;
  *"exec -T postgres"*) exec pg_dump ;;
  *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
`,
  sleep: `#!/usr/bin/env bash
echo "$1" >> "$SLEEP_LOG"
`,
};

const gnuDate = (
  spawnSync('date', ['--version'], { encoding: 'utf8' }).stdout ?? ''
).includes('GNU');
const describeGnu = gnuDate ? describe : describe.skip;

describeGnu(
  'db backups — daily 05:00 Tashkent keep 7, pre-deploy keep 5',
  () => {
    let tmp: string;
    let bin: string;
    let work: string;
    let dir: string;
    let sleepLog: string;
    let fakeLog: string;

    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), 'elchi-backup-spec-'));
      bin = join(tmp, 'bin');
      mkdirSync(bin);
      for (const [name, body] of Object.entries(SHIMS)) {
        writeFileSync(join(bin, name), body);
        chmodSync(join(bin, name), 0o755);
      }
    });
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    beforeEach(() => {
      work = mkdtempSync(join(tmp, 'case-'));
      dir = join(work, 'daily');
      sleepLog = join(work, 'sleep.log');
      fakeLog = join(work, 'docker.log');
      writeFileSync(sleepLog, '');
      writeFileSync(fakeLog, '');
    });

    /** A clean env: never inherit BACKUP_* / TZ from the developer's shell. */
    const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: tmp,
      TZ: 'Europe/Berlin',
      POSTGRES_URI: 'postgres://elchi_app:pw@postgres:5432/elchipochta_db',
      SLEEP_LOG: sleepLog,
      FAKE_LOG: fakeLog,
      ...extra,
    });
    const bash = (
      args: string[],
      extra: Record<string, string> = {},
    ): SpawnSyncReturns<string> =>
      // The timeout turns a scheduler that never yields (e.g. an endless
      // `while true` with the sleep shim) into a failure instead of a hang.
      spawnSync('bash', args, {
        env: env(extra),
        encoding: 'utf8',
        cwd: work,
        timeout: 15000,
        killSignal: 'SIGKILL',
      });

    const files = (d = dir) => {
      try {
        return readdirSync(d).sort();
      } catch {
        return [];
      }
    };
    const dumps = (d = dir) => files(d).filter((f) => f.endsWith('.sql.gz'));
    const sleeps = () =>
      readFileSync(sleepLog, 'utf8').split('\n').filter(Boolean).map(Number);

    /** Calls a backup-cron.sh function after `source`-ing it (main loop stays off). */
    const fn = (
      name: string,
      now: number,
      extra: Record<string, string> = {},
    ) => {
      const r = bash(
        [
          '-c',
          'source "$1"; backup_resolve_config; "$2" "$3"',
          '_',
          CRON,
          name,
          String(now),
        ],
        extra,
      );
      expect(r.status).toBe(0);
      return { epoch: Number(r.stdout.trim()), stderr: r.stderr };
    };
    const nextRun = (now: number, extra: Record<string, string> = {}) =>
      fn('backup_next_run_epoch', now, extra).epoch;

    /** One scheduler cycle at `now` (the `sleep` shim records instead of sleeping). */
    const cronCycle = (now: number, extra: Record<string, string> = {}) =>
      bash([CRON], {
        BACKUP_DIR: dir,
        BACKUP_NOW: String(now),
        BACKUP_CRON_MAX_CYCLES: '1',
        BACKUP_MAX_SLEEP_SECONDS: '999999',
        ...extra,
      });

    describe('schedule: next 05:00 Asia/Tashkent', () => {
      it('before 05:00 Tashkent the next run is today 05:00', () => {
        expect(nextRun(tashkent(2026, 10, 21, 4, 59, 59))).toBe(
          tashkent(2026, 10, 21, 5),
        );
        expect(nextRun(tashkent(2026, 10, 21, 0, 0, 0))).toBe(
          tashkent(2026, 10, 21, 5),
        );
      });

      it('at or after 05:00 (container started late) the next run is tomorrow 05:00', () => {
        for (const now of [
          tashkent(2026, 10, 21, 5, 0, 0),
          tashkent(2026, 10, 21, 5, 0, 1),
          tashkent(2026, 10, 21, 10, 0),
          tashkent(2026, 10, 21, 23, 59, 59),
        ]) {
          expect(nextRun(now)).toBe(tashkent(2026, 10, 22, 5));
        }
      });

      it('05:00 Tashkent is 00:00 UTC / 02:00 Berlin — the server zone does not matter', () => {
        const now = tashkent(2026, 10, 21, 12, 0);
        const expected = Date.UTC(2026, 9, 22, 0, 0, 0) / 1000;
        for (const TZ of [
          'Europe/Berlin',
          'UTC',
          'America/New_York',
          'Asia/Tashkent',
        ]) {
          expect(nextRun(now, { TZ })).toBe(expected);
        }
      });

      it('rolls over month and year ends', () => {
        expect(nextRun(tashkent(2026, 10, 31, 6, 0))).toBe(
          tashkent(2026, 11, 1, 5),
        );
        expect(nextRun(tashkent(2026, 12, 31, 6, 0))).toBe(
          tashkent(2027, 1, 1, 5),
        );
      });

      it('the last due slot is yesterday 05:00 before 05:00, today 05:00 after', () => {
        const last = (now: number) => fn('backup_last_slot_epoch', now).epoch;
        expect(last(tashkent(2026, 10, 21, 4, 59, 59))).toBe(
          tashkent(2026, 10, 20, 5),
        );
        expect(last(tashkent(2026, 10, 21, 5, 0, 0))).toBe(
          tashkent(2026, 10, 21, 5),
        );
        expect(last(tashkent(2026, 10, 21, 18, 0))).toBe(
          tashkent(2026, 10, 21, 5),
        );
      });

      it('BACKUP_DAILY_AT / BACKUP_TZ are configurable', () => {
        const now = Date.UTC(2026, 9, 21, 23, 15, 1) / 1000;
        expect(
          nextRun(now, { BACKUP_DAILY_AT: '23:15', BACKUP_TZ: 'UTC' }),
        ).toBe(Date.UTC(2026, 9, 22, 23, 15, 0) / 1000);
        expect(
          nextRun(tashkent(2026, 10, 21, 1, 0), { BACKUP_DAILY_AT: '3:30' }),
        ).toBe(tashkent(2026, 10, 21, 3, 30));
      });

      it('an unknown zone never silently becomes UTC (falls back to Tashkent, with a warning)', () => {
        const r = fn('backup_next_run_epoch', tashkent(2026, 10, 21, 12, 0), {
          BACKUP_TZ: 'Mars/Olympus_Mons',
        });
        expect(r.epoch).toBe(tashkent(2026, 10, 22, 5));
        expect(r.stderr).toContain("time zone 'Mars/Olympus_Mons' not found");
      });

      it('an invalid BACKUP_DAILY_AT falls back to 05:00 with a warning', () => {
        const r = fn('backup_next_run_epoch', tashkent(2026, 10, 21, 12, 0), {
          BACKUP_DAILY_AT: '25:99',
        });
        expect(r.epoch).toBe(tashkent(2026, 10, 22, 5));
        expect(r.stderr).toContain("BACKUP_DAILY_AT='25:99' is not HH:MM");
      });
    });

    describe('daily scheduler loop (backup-cron.sh)', () => {
      it('first start with no dump takes one at once (catch-up), then sleeps until 05:00', () => {
        const now = tashkent(2026, 10, 21, 10, 0);
        const r = cronCycle(now);
        expect(r.status).toBe(0);
        expect(dumps()).toEqual([`elchi-daily-${stamp(now)}.sql.gz`]);
        expect(sleeps()).toEqual([19 * 3600]);
        expect(r.stdout).toContain(
          'next daily backup at 2026-10-22 05:00:00 +05',
        );
      });

      it("today's dump already there → no second dump, just sleeps until tomorrow 05:00", () => {
        mkdirSync(dir);
        const existing = `elchi-daily-${stamp(tashkent(2026, 10, 21, 5, 0, 2))}.sql.gz`;
        writeFileSync(join(dir, existing), 'x');
        const r = cronCycle(tashkent(2026, 10, 21, 10, 0));
        expect(r.status).toBe(0);
        expect(dumps()).toEqual([existing]);
        expect(sleeps()).toEqual([19 * 3600]);
      });

      it('yesterday is the newest dump and it is past 05:00 → the missed slot is taken now', () => {
        mkdirSync(dir);
        writeFileSync(
          join(
            dir,
            `elchi-daily-${stamp(tashkent(2026, 10, 20, 5, 0, 2))}.sql.gz`,
          ),
          'x',
        );
        const now = tashkent(2026, 10, 21, 5, 0, 1);
        expect(cronCycle(now).status).toBe(0);
        expect(dumps()).toContain(`elchi-daily-${stamp(now)}.sql.gz`);
      });

      it('sleeps at most an hour at a time by default, then re-checks', () => {
        cronCycle(tashkent(2026, 10, 21, 10, 0), {
          BACKUP_MAX_SLEEP_SECONDS: '',
        });
        expect(sleeps()).toEqual([3600]);
      });

      it('8 daily runs → exactly the newest 7 are kept, the oldest is deleted', () => {
        const days = Array.from({ length: 8 }, (_, i) =>
          tashkent(2026, 10, 21 + i, 5, 0, 1),
        );
        for (const now of days) expect(cronCycle(now).status).toBe(0);
        expect(dumps()).toEqual(
          days.slice(1).map((e) => `elchi-daily-${stamp(e)}.sql.gz`),
        );
      }, 30000);

      it('a failed run keeps every older dump, leaves no partial file, retries in 15 min', () => {
        const days = Array.from({ length: 7 }, (_, i) =>
          tashkent(2026, 10, 21 + i, 5, 0, 1),
        );
        for (const now of days) expect(cronCycle(now).status).toBe(0);
        const before = dumps();
        expect(before).toHaveLength(7);

        writeFileSync(sleepLog, '');
        const r = cronCycle(tashkent(2026, 10, 28, 5, 0, 1), {
          FAKE_PG: 'fail',
        });
        expect(r.status).toBe(0); // the loop survives a failed run
        expect(r.stderr).toContain('daily backup FAILED — older dumps kept');
        expect(files()).toEqual(before); // nothing deleted, no `.…partial…` left
        expect(sleeps()).toEqual([900]);
      }, 30000);
    });

    describe('backup-db.sh: one verified dump, rotated by name', () => {
      const dumpOnce = (extra: Record<string, string> = {}) =>
        bash([DUMP], {
          BACKUP_DIR: dir,
          BACKUP_PREFIX: 'elchi-daily',
          BACKUP_RETENTION: '7',
          ...extra,
        });

      it.each([
        ['pg_dump dies mid-dump', 'fail', 'pg_dump failed'],
        [
          'the dump is cut short (no "dump complete" trailer)',
          'truncated',
          'dump complete',
        ],
        ['the dump is suspiciously small', 'tiny', 'bytes'],
      ])(
        'rejects it when %s — nothing written, nothing deleted',
        (_case, mode, message) => {
          mkdirSync(dir);
          const old = 'elchi-daily-20261020T000001Z.sql.gz';
          writeFileSync(join(dir, old), 'previous good dump');
          const r = dumpOnce({ FAKE_PG: mode, BACKUP_RETENTION: '1' });
          expect(r.status).not.toBe(0);
          expect(r.stderr).toContain('[backup-db] ERROR:');
          expect(r.stderr).toContain(message);
          expect(files()).toEqual([old]);
          expect(readFileSync(join(dir, old), 'utf8')).toBe(
            'previous good dump',
          );
        },
      );

      it('a good dump is a valid gzip ending with the pg_dump trailer', () => {
        expect(
          dumpOnce({ BACKUP_NOW: String(tashkent(2026, 10, 21, 5)) }).status,
        ).toBe(0);
        const [file] = dumps();
        const text = spawnSync('gzip', ['-dc', join(dir, file)], {
          encoding: 'utf8',
        }).stdout;
        expect(text).toContain('-- PostgreSQL database dump complete');
      });

      it('rotation only touches files of its own prefix in its own directory', () => {
        mkdirSync(dir);
        const others = [
          'pre-migration-20261017-101010.sql.gz',
          'notes.txt',
          'pre-deploy-20200101T000000Z.sql.gz',
        ];
        for (const o of others) writeFileSync(join(dir, o), 'keep me');
        for (let i = 0; i < 3; i++) {
          expect(
            dumpOnce({
              BACKUP_RETENTION: '1',
              BACKUP_NOW: String(1792540800 + i),
            }).status,
          ).toBe(0);
        }
        expect(files()).toEqual(
          [...others, `elchi-daily-${stamp(1792540802)}.sql.gz`].sort(),
        );
      });

      it('never rotates out the dump it just wrote, even if the clock is behind', () => {
        mkdirSync(dir);
        for (let i = 1; i <= 7; i++)
          writeFileSync(
            join(dir, `elchi-daily-2030010${i}T000000Z.sql.gz`),
            'x',
          );
        const now = tashkent(2026, 10, 21, 5);
        expect(dumpOnce({ BACKUP_NOW: String(now) }).status).toBe(0);
        expect(dumps()).toContain(`elchi-daily-${stamp(now)}.sql.gz`);
      });
    });

    describe('pre-deploy-backup.sh (the deploy gate)', () => {
      const preDeploy = (extra: Record<string, string> = {}) =>
        bash([PRE_DEPLOY, '1111111aaaaaaaa', '2222222bbbbbbbb'], extra);
      const preDir = () => join(work, 'backups', 'pre-deploy');

      it('6 deploys → the newest 5 are kept; dumps go through `docker compose exec postgres`', () => {
        const outs: string[] = [];
        for (let i = 0; i < 6; i++) {
          const r = preDeploy({ BACKUP_NOW: String(1792540800 + i * 3600) });
          expect(r.status).toBe(0);
          outs.push(r.stdout.trim());
        }
        const kept = dumps(preDir());
        expect(kept).toEqual(outs.slice(1).map((p) => basename(p)));
        expect(kept[0]).toMatch(
          /^pre-deploy-\d{8}T\d{6}Z-1111111-to-2222222\.sql\.gz$/,
        );
        expect(outs[5]).toBe(join(preDir(), kept[4])); // absolute path on stdout
        expect(readFileSync(fakeLog, 'utf8')).toContain(
          'compose -f docker-compose.prod.yml exec -T postgres',
        );
      });

      it("staging: BACKUP_COMPOSE_FILE='a:b' → every compose call gets `-f a -f b`", () => {
        const r = preDeploy({
          BACKUP_COMPOSE_FILE:
            'docker-compose.prod.yml:docker-compose.staging.yml',
        });
        expect(r.status).toBe(0);
        expect(dumps(preDir())).toHaveLength(1);
        const calls = readFileSync(fakeLog, 'utf8')
          .split('\n')
          .filter((l) => l.startsWith('docker compose'));
        expect(calls).toEqual([
          'docker compose -f docker-compose.prod.yml -f docker-compose.staging.yml ps --all --quiet postgres',
          expect.stringContaining(
            'docker compose -f docker-compose.prod.yml -f docker-compose.staging.yml exec -T postgres',
          ),
        ]);
      });

      it('a failed dump fails the gate and writes nothing', () => {
        const r = preDeploy({ FAKE_PG: 'fail' });
        expect(r.status).not.toBe(0);
        expect(r.stdout.trim()).toBe('');
        expect(files(preDir())).toEqual([]);
      });

      it('postgres container exists but is stopped → fails (never "nothing to back up")', () => {
        const r = preDeploy({ FAKE_PG_CONTAINER: 'stopped' });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('NOT running');
        expect(readFileSync(fakeLog, 'utf8')).not.toContain('exec');
      });

      it('first install (no postgres container yet) → skipped, exit 0, empty stdout', () => {
        const r = preDeploy({ FAKE_PG_CONTAINER: 'none' });
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe('');
        expect(r.stderr).toContain('first install');
      });
    });

    describe('--check (db-backup container healthcheck)', () => {
      const check = (now: number) =>
        bash([CRON, '--check'], { BACKUP_DIR: dir, BACKUP_NOW: String(now) });

      it('healthy while the newest daily dump is < 26h old, unhealthy after or with none', () => {
        expect(check(tashkent(2026, 10, 21, 10)).status).toBe(1);
        mkdirSync(dir);
        const src = join(work, 'x.sql.gz');
        writeFileSync(src, 'x');
        copyFileSync(
          src,
          join(dir, `elchi-daily-${stamp(tashkent(2026, 10, 21, 5))}.sql.gz`),
        );
        expect(check(tashkent(2026, 10, 22, 6, 59)).status).toBe(0);
        expect(check(tashkent(2026, 10, 22, 7, 1)).status).toBe(1);
      });
    });
  },
);

describe('db backups — wiring (deploy.yml + docker-compose.prod.yml)', () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
  const deploy = read('.github/workflows/deploy.yml');

  it('every deploy takes the gated pre-deploy backup BEFORE any pull / up / migration', () => {
    const gate = deploy.indexOf(
      'if ! PRE_DEPLOY_BK="$(bash scripts/pre-deploy-backup.sh',
    );
    expect(gate).toBeGreaterThan(
      deploy.indexOf('git reset --hard origin/main'),
    );
    for (const step of [
      ' pull rabbitmq',
      ' up -d --remove-orphans rabbitmq',
      '--abort-on-container-exit migration-runner',
      '--build --remove-orphans $DEPLOY_SERVICES',
    ]) {
      expect(deploy.indexOf(step)).toBeGreaterThan(gate);
    }
    // not nested under the RUN_MIGRATIONS branch: it runs on every deploy
    expect(gate).toBeLessThan(
      deploy.indexOf('echo "No migration changes detected."'),
    );
  });

  it('a failed gate resets the code and stops without the rollback rebuild', () => {
    const gate = deploy.slice(deploy.indexOf('if ! PRE_DEPLOY_BK='));
    const block = gate.slice(0, gate.indexOf('\n            fi'));
    expect(block).toContain('trap - ERR');
    expect(block).toContain('git reset --hard "$OLD_SHA"');
    expect(block).toContain('exit 1');
  });

  it('the pre-deploy dump is the migration restore point — no second dump, no pre-migration writes', () => {
    expect(deploy).not.toContain('pre-migration-$(date');
    expect(deploy).not.toMatch(
      /restore the DB from the newest \.\/backups\/pre-migration/,
    );
    expect(deploy).toContain(
      "restore the DB from this deploy's pre-deploy dump: $PRE_DEPLOY_BK",
    );
  });

  it('the deploy starts db-backup and a rollback fails the job', () => {
    expect(deploy).toMatch(/up -d --no-deps( --force-recreate)? db-backup/);
    const rollback = deploy.slice(
      deploy.indexOf('rollback() {'),
      deploy.indexOf("trap 'rollback' ERR"),
    );
    expect(rollback.trimEnd()).toMatch(/exit 1\s*}$/);
  });

  it('compose: daily dir, schedule only from .env.production (no masking env defaults), healthcheck', () => {
    const compose = read('docker-compose.prod.yml');
    const svc = compose.slice(
      compose.indexOf('\n  db-backup:'),
      compose.indexOf('\n  backup-offsite:'),
    );
    expect(svc).toContain("entrypoint: ['bash', '/scripts/backup-cron.sh']");
    expect(svc).toContain('BACKUP_DIR: /backups/daily');
    expect(svc).toContain('- ./backups:/backups');
    expect(svc).toContain("'/scripts/backup-cron.sh', '--check'");
    expect(svc).not.toMatch(
      /^\s+BACKUP_(RETENTION|INTERVAL_SECONDS|DAILY_AT|TZ|DAILY_KEEP):/m,
    );
  });
});
