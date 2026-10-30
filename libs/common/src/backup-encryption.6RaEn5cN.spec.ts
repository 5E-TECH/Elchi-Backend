import { spawnSync } from 'node:child_process';
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
 * 6RaEn5cN: off-site nusxalarni client-side shifrlash (rclone crypt, sukut
 * o'chiq) va oylik tiklash mashqi. Haqiqiy skriptlar soxta `rclone` bilan
 * ishlaydi (`r2:` / `r2crypt:` / `minio:` temp papkalarga), haqiqiy rclone 1.68.2
 * bilan to'liq yo'l lokal tekshirilgan (docs/ops/db-backups.md §6.7).
 */
const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const DB_SCRIPT = join(ROOT, 'scripts', 'backup-offsite.sh');
const MINIO_SCRIPT = join(ROOT, 'scripts', 'backup-minio-offsite.sh');
const KEY = 'k3y0123456789abcdef0123456789abcdef-never-printed';

const FAKE_RCLONE = `#!/usr/bin/env bash
echo "rclone $*" >> "$FAKE_LOG"
map() {
  case "$1" in
    r2crypt:*) echo "$FAKE_R2/$FAKE_BUCKET/\${1#r2crypt:}" ;;
    r2:*) echo "$FAKE_R2/\${1#r2:}" ;;
    minio:*) echo "$FAKE_MINIO/\${1#minio:}" ;;
    *) echo "$1" ;;
  esac
}
cmd="$1"; shift
if [ "$cmd" = obscure ]; then
  cat > "$FAKE_DIR/obscure.stdin"
  [ "\${FAKE_RCLONE:-}" = fail-obscure ] && exit 1
  echo OBSCURED
  exit 0
fi
env | grep '^RCLONE_CONFIG' | sort > "$FAKE_DIR/rclone.env"
pos=(); list=""; min=""
while [ $# -gt 0 ]; do
  case "$1" in
    --files-from-raw) list="$2"; shift 2 ;;
    --min-age) min=1; shift 2 ;;
    --backup-dir|--exclude|--max-delete|--transfers|--checkers|--stats|--max-depth|--include|--max-age) shift 2 ;;
    --dirs-only) dirs=1; shift ;;
    --*|-v) shift ;;
    *) pos+=("$1"); shift ;;
  esac
done
case "$cmd" in
  lsf)
    d=$(map "\${pos[0]}")
    [ -d "$d" ] || exit 3
    if [ -n "$min" ]; then find "$d" -maxdepth 1 -name '*.sql.gz' -mtime +30 -printf '%f\\n'
    else (cd "$d" && find . -type f | sed 's#^\\./##' | sort); fi ;;
  copy)
    s=$(map "\${pos[0]}"); t=$(map "\${pos[1]}"); mkdir -p "$t"
    while IFS= read -r n; do cp "$s/$n" "$t/$n"; done < "$list" ;;
  sync)
    s=$(map "\${pos[0]}"); t=$(map "\${pos[1]}"); mkdir -p "$t"
    (cd "$s" && find . -type f | sed 's#^\\./##') | while IFS= read -r f; do
      mkdir -p "$t/$(dirname "$f")"; cp "$s/$f" "$t/$f"; echo "INFO  : $f: Copied (new)" >&2
    done ;;
  delete) d=$(map "\${pos[0]}"); find "$d" -maxdepth 1 -name '*.sql.gz' -mtime +30 -delete ;;
  check|cryptcheck) if [ "\${FAKE_RCLONE:-}" = fail-verify ]; then echo "ERROR : differ" >&2; exit 1; fi ;;
  size) echo '{"count":1,"bytes":4,"sizeless":0}' ;;
  *) echo "fake rclone $cmd \${pos[*]}" ;;
esac
`;

interface Box {
  dir: string;
  src: string;
  r2: string;
  state: string;
  log: string;
}

function box(): Box {
  const dir = mkdtempSync(join(tmpdir(), 'backup-crypt-'));
  const b: Box = {
    dir,
    src: join(dir, 'backups'),
    r2: join(dir, 'r2'),
    state: join(dir, 'state'),
    log: join(dir, 'rclone.log'),
  };
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'rclone'), FAKE_RCLONE);
  chmodSync(join(dir, 'bin', 'rclone'), 0o755);
  writeFileSync(b.log, '');
  mkdirSync(join(b.src, 'daily'), { recursive: true });
  mkdirSync(join(b.r2, 'bkt'), { recursive: true });
  mkdirSync(join(dir, 'minio', 'elchi-files'), { recursive: true });
  writeFileSync(join(b.src, 'daily', 'elchi-daily-1.sql.gz'), 'dump');
  writeFileSync(join(dir, 'minio', 'elchi-files', 'a.jpg'), 'AAAA');
  return b;
}

const baseEnv = (b: Box, extra: Record<string, string>) => ({
  PATH: `${join(b.dir, 'bin')}:/usr/bin:/bin`,
  HOME: b.dir,
  FAKE_LOG: b.log,
  FAKE_DIR: b.dir,
  FAKE_R2: b.r2,
  FAKE_MINIO: join(b.dir, 'minio'),
  FAKE_BUCKET: 'bkt',
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_ACCESS_KEY_ID: 'ak',
  R2_SECRET_ACCESS_KEY: 'r2-secret-value',
  R2_BUCKET: 'bkt',
  ...extra,
});

const runDb = (
  b: Box,
  extra: Record<string, string> = {},
  args: string[] = [],
) =>
  spawnSync('sh', [DB_SCRIPT, ...args], {
    encoding: 'utf8',
    env: baseEnv(b, {
      OFFSITE_SRC_ROOT: b.src,
      OFFSITE_STATE_DIR: b.state,
      OFFSITE_MAX_CYCLES: '1',
      ...extra,
    }),
  });

const runMinio = (b: Box, extra: Record<string, string> = {}) =>
  spawnSync('sh', [MINIO_SCRIPT], {
    encoding: 'utf8',
    env: baseEnv(b, {
      MINIO_OFFSITE_STATE_DIR: b.state,
      MINIO_BACKUP_ACCESS_KEY: 'ro',
      MINIO_BACKUP_SECRET_KEY: 'ro-secret-value',
      MINIO_BUCKET: 'elchi-files',
      ...extra,
    }),
  });

const calls = (b: Box) => readFileSync(b.log, 'utf8');
const rcloneEnv = (b: Box) => readFileSync(join(b.dir, 'rclone.env'), 'utf8');
const status = (b: Box) => readFileSync(join(b.state, 'status'), 'utf8');

describe('backup-offsite.sh: shifrlash (6RaEn5cN)', () => {
  let b: Box;
  beforeEach(() => (b = box()));
  afterEach(() => rmSync(b.dir, { recursive: true, force: true }));

  it('kalit yo`q: eski yo`l o`zgarmagan (r2:, rclone check, crypt yo`q)', () => {
    const r = runDb(b);
    expect(r.status).toBe(0);
    expect(calls(b)).toMatch(/rclone copy \S+\/daily r2:bkt\/daily /);
    expect(calls(b)).toMatch(/rclone check \S+\/daily r2:bkt\/daily /);
    expect(calls(b)).not.toMatch(/r2crypt|cryptcheck|obscure/);
    expect(rcloneEnv(b)).not.toContain('R2CRYPT');
    expect(existsSync(join(b.r2, 'bkt', 'daily', 'elchi-daily-1.sql.gz'))).toBe(
      true,
    );
  });

  it.each(['__REPLACE_WITH_A_KEY__', ''])(
    'kalit %j: o`chiq (shablon qiymati shifrlash emas)',
    (OFFSITE_ENCRYPTION_KEY) => {
      expect(runDb(b, { OFFSITE_ENCRYPTION_KEY }).status).toBe(0);
      expect(calls(b)).not.toMatch(/r2crypt/);
    },
  );

  it('kalit bor: faqat crypt remote`ga, cryptcheck bilan, kalit hech qayerda ko`rinmaydi', () => {
    const r = runDb(b, { OFFSITE_ENCRYPTION_KEY: KEY });
    expect(r.status).toBe(0);
    expect(calls(b)).toMatch(
      /rclone copy \S+\/daily r2crypt:encrypted\/daily /,
    );
    expect(calls(b)).toMatch(
      /rclone cryptcheck \S+\/daily r2crypt:encrypted\/daily --one-way/,
    );
    expect(calls(b)).not.toMatch(/rclone check /);
    expect(calls(b)).not.toMatch(/rclone copy \S+ r2:/);
    expect(existsSync(join(b.r2, 'bkt', 'daily'))).toBe(false);
    expect(status(b)).toMatch(/^remote=r2crypt:encrypted$/m);

    const env = rcloneEnv(b);
    expect(env).toContain('RCLONE_CONFIG_R2CRYPT_TYPE=crypt');
    expect(env).toContain('RCLONE_CONFIG_R2CRYPT_REMOTE=r2:bkt');
    expect(env).toContain('RCLONE_CONFIG_R2CRYPT_FILENAME_ENCRYPTION=off');
    expect(env).toContain(
      'RCLONE_CONFIG_R2CRYPT_DIRECTORY_NAME_ENCRYPTION=false',
    );
    expect(env).toContain('RCLONE_CONFIG_R2CRYPT_PASSWORD=OBSCURED');
    // Kalit `rclone obscure -` ga faqat stdin orqali.
    expect(readFileSync(join(b.dir, 'obscure.stdin'), 'utf8').trim()).toBe(KEY);
    for (const out of [r.stdout, r.stderr, calls(b), env, status(b)]) {
      expect(out).not.toContain(KEY);
    }
  });

  it.each([
    ['qisqa kalit', { OFFSITE_ENCRYPTION_KEY: 'short' }, undefined],
    ['obscure ishlamadi', { OFFSITE_ENCRYPTION_KEY: KEY }, 'fail-obscure'],
  ])('%s: ochiq nusxaga qaytmaydi, hech narsa yuklanmaydi', (_n, env, fake) => {
    const r = runDb(b, { ...env, ...(fake ? { FAKE_RCLONE: fake } : {}) });
    expect(calls(b)).not.toMatch(/rclone copy/);
    expect(readdirSync(join(b.r2, 'bkt'))).toEqual([]);
    expect(status(b)).toMatch(/^state=error$/m);
    expect(r.stderr).toMatch(/ERROR/);
  });

  it('cryptcheck yiqilsa run xato, hech narsa o`chirilmaydi', () => {
    const r = runDb(b, {
      OFFSITE_ENCRYPTION_KEY: KEY,
      FAKE_RCLONE: 'fail-verify',
    });
    expect(status(b)).toMatch(/^state=error$/m);
    expect(calls(b)).not.toMatch(/rclone delete/);
    expect(r.stderr).toMatch(/verify/);
  });

  it('eski ochiq nusxalar ham muddat bilan o`chadi, yangi shifrli nusxa bo`lgandagina', () => {
    const old = join(b.r2, 'bkt', 'daily', 'elchi-daily-0.sql.gz');
    mkdirSync(join(b.r2, 'bkt', 'daily'), { recursive: true });
    writeFileSync(old, 'old');
    const oldCrypt = join(b.r2, 'bkt', 'encrypted', 'daily', 'old.sql.gz');
    mkdirSync(join(b.r2, 'bkt', 'encrypted', 'daily'), { recursive: true });
    writeFileSync(oldCrypt, 'old');
    const t = Date.now() / 1000 - 60 * 86400;
    utimesSync(old, t, t);
    utimesSync(oldCrypt, t, t);
    expect(runDb(b, { OFFSITE_ENCRYPTION_KEY: KEY }).status).toBe(0);
    expect(calls(b)).toMatch(/rclone delete r2crypt:encrypted\/daily /);
    expect(calls(b)).toMatch(/rclone delete r2:bkt\/daily /);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldCrypt)).toBe(false);
  });

  it('`rclone` o`rami tiklash uchun crypt remote`ni ham beradi', () => {
    const r = runDb(b, { OFFSITE_ENCRYPTION_KEY: KEY }, ['rclone', 'version']);
    expect(r.status).toBe(0);
    expect(rcloneEnv(b)).toContain('RCLONE_CONFIG_R2CRYPT_PASSWORD=OBSCURED');
  });
});

describe('backup-minio-offsite.sh: shifrlash (6RaEn5cN)', () => {
  let b: Box;
  beforeEach(() => (b = box()));
  afterEach(() => rmSync(b.dir, { recursive: true, force: true }));

  it('kalit yo`q: eski yo`l o`zgarmagan (--checksum, rclone check)', () => {
    expect(runMinio(b).status).toBe(0);
    expect(calls(b)).toMatch(
      /rclone sync minio:elchi-files r2:bkt\/minio\/elchi-files\/current --backup-dir r2:bkt\/minio\/elchi-files\/versions\/\d{8}T\d{6}Z --checksum/,
    );
    expect(calls(b)).toMatch(/rclone check minio:elchi-files r2:bkt\/minio/);
    expect(calls(b)).not.toMatch(/r2crypt|cryptcheck|obscure/);
  });

  it('kalit bor: crypt remote, --checksum yo`q (umumiy hash yo`q), cryptcheck', () => {
    const r = runMinio(b, { OFFSITE_ENCRYPTION_KEY: KEY });
    expect(r.status).toBe(0);
    expect(calls(b)).toMatch(
      /rclone sync minio:elchi-files r2crypt:encrypted\/minio\/elchi-files\/current --backup-dir r2crypt:encrypted\/minio\/elchi-files\/versions\/\d{8}T\d{6}Z /,
    );
    expect(calls(b)).not.toMatch(/--checksum/);
    expect(calls(b)).toMatch(
      /rclone cryptcheck minio:elchi-files r2crypt:encrypted\/minio\/elchi-files\/current --one-way/,
    );
    expect(calls(b)).toMatch(/cryptcheck [^\n]*--exclude \/ai-tmp\/\*\*/);
    expect(calls(b)).not.toMatch(/rclone check /);
    expect(existsSync(join(b.r2, 'bkt', 'minio'))).toBe(false);
    for (const out of [r.stdout, r.stderr, calls(b), status(b)]) {
      expect(out).not.toContain(KEY);
    }
  });

  it('qisqa kalit: hech narsa ko`chmaydi', () => {
    const r = runMinio(b, { OFFSITE_ENCRYPTION_KEY: 'short' });
    expect(r.status).toBe(1);
    expect(calls(b)).not.toMatch(/rclone sync/);
    expect(status(b)).toMatch(/^state=error$/m);
  });

  it('cron wrapper kalitni konteynerga beradi', () => {
    expect(read('scripts/backup-minio-offsite-cron.sh')).toMatch(
      /grep -E '\^\([^']*\|OFFSITE_ENCRYPTION_KEY\)='/,
    );
  });
});

describe('oylik tiklash mashqi (6RaEn5cN)', () => {
  const drill = read('scripts/restore-drill.sh');
  const workflow = read('.github/workflows/restore-drill.yml');

  it('skript shifrli nusxani ham, MinIO`ni ham ko`taradi, kalit argv`ga chiqmaydi', () => {
    expect(
      spawnSync('bash', ['-n', join(ROOT, 'scripts/restore-drill.sh')]).status,
    ).toBe(0);
    expect(drill).toContain('r2crypt:encrypted');
    expect(drill).toMatch(/\| docker run --rm -i "\$RCLONE_IMG" obscure -/);
    expect(drill).toMatch(/-e RCLONE_CONFIG_R2CRYPT_PASSWORD\b(?!=)/);
    expect(drill).toContain('RESTORE_DRILL_MINIO_BUCKET');
  });

  it('kalitsiz va MinIO`siz eski yo`l saqlangan', () => {
    expect(drill).toMatch(/SRC_ROOT="r2:\$R2_BUCKET"/);
    expect(drill).toMatch(/\[ -n "\$\{OFFSITE_ENCRYPTION_KEY:-\}" \]/);
    expect(drill).toMatch(/\[ -n "\$\{RESTORE_DRILL_MINIO_BUCKET:-\}" \]/);
  });

  it('workflow: oyiga bir marta, sukut o`chiq, tashqi trigger yo`q, Telegram alert', () => {
    expect(workflow).toMatch(/cron: '\d+ \d+ 1 \* \*'/);
    expect(workflow).toMatch(
      /^ {4}if: vars\.RESTORE_DRILL_ENABLED == 'true'$/m,
    );
    expect(workflow).not.toMatch(/pull_request|^\s+push:/m);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(workflow).toContain('bash scripts/restore-drill.sh');
    expect(workflow).toMatch(/if: failure\(\)/);
    expect(workflow).toContain('scripts/ci-telegram-alert.sh');
  });

  it('ci-telegram-alert.sh: sir yo`q bo`lsa xato, token argv`ga chiqmaydi', () => {
    const script = join(ROOT, 'scripts', 'ci-telegram-alert.sh');
    const dir = mkdtempSync(join(tmpdir(), 'ci-tg-'));
    try {
      mkdirSync(join(dir, 'bin'));
      writeFileSync(
        join(dir, 'bin', 'curl'),
        '#!/usr/bin/env bash\necho "curl $*" >> "$LOG"\ncat >> "$LOG.stdin"\necho -n 200\n',
      );
      chmodSync(join(dir, 'bin', 'curl'), 0o755);
      const env = {
        PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
        LOG: join(dir, 'curl.log'),
      };
      const missing = spawnSync('bash', [script, 'matn'], {
        encoding: 'utf8',
        env,
      });
      expect(missing.status).toBe(1);
      expect(missing.stdout + missing.stderr).toContain(
        'BACKUP_ALERT_TELEGRAM_BOT_TOKEN',
      );
      const ok = spawnSync('bash', [script, 'matn'], {
        encoding: 'utf8',
        env: {
          ...env,
          BACKUP_ALERT_TELEGRAM_BOT_TOKEN: '123:TOKEN',
          BACKUP_ALERT_TELEGRAM_CHAT_ID: '42',
        },
      });
      expect(ok.status).toBe(0);
      expect(readFileSync(join(dir, 'curl.log'), 'utf8')).not.toContain(
        'TOKEN',
      );
      expect(readFileSync(join(dir, 'curl.log'), 'utf8')).toContain(
        'chat_id=42',
      );
      expect(readFileSync(join(dir, 'curl.log.stdin'), 'utf8')).toContain(
        'bot123:TOKEN/sendMessage',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
