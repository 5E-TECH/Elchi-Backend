import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ZfI9nERJ: image'lar CI'da, tashqi uptime monitor, rotatsiyada gateway swap.
 * deploy.yml skriptining o'zi (prod va staging) to'liq, HAQIQIY bash'da soxta
 * `docker` / `git` bilan ishlatiladi: o'chiq holatda serverda bajariladigan
 * buyruqlar ro'yxati aynan tekshiriladi.
 */
const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const deploy = read('.github/workflows/deploy.yml');
const IND = ' '.repeat(12);
const SHA = 'a'.repeat(40);
const TOKEN = 'ghs_never_in_the_log_0123456789';

function jobScript(job: string): string {
  const lines = deploy.split('\n');
  let i = lines.indexOf(`  ${job}:`);
  while (!/^ {10}script: \|\s*$/.test(lines[i])) i++;
  const out: string[] = [];
  for (i++; i < lines.length; i++) {
    if (lines[i].trim() !== '' && !lines[i].startsWith(IND)) break;
    out.push(lines[i].slice(IND.length));
  }
  return out.join('\n');
}

/** Job bloki: `  name:` dan keyingi job'gacha. */
function job(name: string): string {
  const start = deploy.indexOf(`\n  ${name}:\n`);
  const rest = deploy.slice(start + 1);
  const end = rest.slice(3).search(/\n {2}\S|\n\S/);
  return end < 0 ? rest : rest.slice(0, end + 3);
}

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
if [ "$1" = compose ]; then
  shift
  [ "$1" = version ] && { echo 2.30.0; exit 0; }
  while [ "$1" = -f ]; do shift 2; done
  case "$1" in
    ps)
      case "$*" in
        *"api-gateway"*) cat "$FAKE_DIR/gw" ;;
        *"db-backup"*) echo cid-backup ;;
        *"db-reconcile"*) [ -z "\${FAKE_SIDECAR:-}" ] || echo cid-reconcile ;;
      esac ;;
    up)
      case "$*" in *"--scale api-gateway=2"*) echo new >> "$FAKE_DIR/gw" ;; esac ;;
    config)
      s="\${@: -1}"
      if [ "$s" = --services ]; then printf '%s\\n' api-gateway identity-service; exit 0; fi
      # Haqiqiy compose bog'liqliklarni ham chiqaradi, tartibi kafolatsiz.
      echo "rabbitmq:3.13.7"; echo "postgres:15"; echo "proj-migration-runner"; echo "proj-$s" ;;
  esac
  exit 0
fi
case "$1" in
  inspect)
    case "$*" in
      *RestartCount*State* | *State*RestartCount*) echo "running 0" ;;
      *RestartCount*) echo 0 ;;
      *Config.Image*) cat "$FAKE_DIR/pin" ;;
      *) echo healthy ;;
    esac ;;
  exec) [ -z "\${FAKE_NOT_READY:-}" ] || { echo "503 IDENTITY:timeout"; exit 1; } ;;
  login) cat > "$FAKE_DIR/login.stdin"; [ "\${FAKE_PULL:-}" != fail-login ] || exit 1 ;;
  pull) [ "\${FAKE_PULL:-}" != fail ] || exit 1 ;;
  rm) printf 'new\\n' > "$FAKE_DIR/gw" ;;
esac
exit 0
`;

const FAKE_GIT = `#!/usr/bin/env bash
case "$*" in
  "rev-parse HEAD") echo "$FAKE_OLD" ;;
  "rev-parse origin/"*) echo "$FAKE_NEW" ;;
  "diff --name-only"*) printf '%s\\n' $FAKE_CHANGED ;;
esac
exit 0
`;

interface Run {
  status: number | null;
  out: string;
  calls: string[];
}

function deployRun(
  name: 'deploy' | 'deploy-staging',
  env: Record<string, string> = {},
): Run {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-run-'));
  try {
    const app = join(dir, 'app');
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(app, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'docker'), FAKE_DOCKER);
    writeFileSync(join(dir, 'bin', 'git'), FAKE_GIT);
    writeFileSync(join(dir, 'bin', 'sleep'), '#!/usr/bin/env bash\n');
    for (const f of ['docker', 'git', 'sleep']) {
      chmodSync(join(dir, 'bin', f), 0o755);
    }
    const compose = read('docker-compose.prod.yml');
    writeFileSync(join(app, 'docker-compose.prod.yml'), compose);
    writeFileSync(
      join(dir, 'pin'),
      /^ {2}image: (cloudflare\/cloudflared:\S+)$/m.exec(compose)![1],
    );
    writeFileSync(join(dir, 'gw'), 'old\n');
    writeFileSync(
      join(app, name === 'deploy' ? '.env.production' : '.env.staging'),
      `POSTGRES_PASSWORD=${'p'.repeat(48)}\nSUPERADMIN_PASSWORD=${'s'.repeat(16)}\n`,
    );
    writeFileSync(
      join(app, 'scripts', 'pre-deploy-backup.sh'),
      'echo /backups/pre-deploy/x.sql.gz\n',
    );
    writeFileSync(join(app, 'scripts', 'docker-gc.sh'), 'exit 0\n');
    const script = jobScript(name)
      .split('${{ secrets.SERVER_APP_PATH }}')
      .join(app)
      .split('${{ github.sha }}')
      .join(SHA)
      .split('${{ github.repository }}')
      .join('5E-TECH/Elchi-Backend');
    expect(script).not.toContain('${{');
    writeFileSync(join(dir, 'run.sh'), script);
    const r = spawnSync('bash', ['run.sh'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
        HOME: dir,
        FAKE_LOG: join(dir, 'calls.log'),
        FAKE_DIR: dir,
        FAKE_OLD: 'b'.repeat(40),
        FAKE_NEW: SHA,
        FAKE_CHANGED:
          'apps/order-service/src/a.ts apps/api-gateway/src/b.ts migrations/1.ts',
        ...env,
      },
    });
    return {
      status: r.status,
      out: r.stdout + r.stderr,
      calls: readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Serverda image/konteyner yaratadigan buyruqlar, compose fayl qismisiz. */
const mutating = (run: Run) =>
  run.calls
    .filter((c) => / (up|build) /.test(c) || / (pull|tag|login) /.test(c))
    .filter((c) => !c.includes(' cloudflared'))
    .map((c) =>
      c
        .replace(/docker compose( -f \S+)+ /, 'dc ')
        .replace(/ docker-compose\.\S+/g, ''),
    );

const SERVER_BUILD = [
  'dc pull rabbitmq postgres minio',
  'dc up -d --no-recreate --remove-orphans rabbitmq',
  'dc up -d --remove-orphans postgres minio',
  'dc up --build --force-recreate --abort-on-container-exit migration-runner',
  'dc up -d --no-deps --build --remove-orphans order-service',
  'dc build api-gateway',
  'dc up -d --no-deps --no-recreate --scale api-gateway=2 api-gateway',
  'dc up -d --no-deps --no-recreate --scale api-gateway=1 api-gateway',
  'dc up -d --no-deps db-backup',
  'dc up -d --no-deps backup-offsite',
];

describe.each(['deploy', 'deploy-staging'] as const)(
  '%s: image yo`li',
  (name) => {
    it('o`chiq (sukut): serverdagi buyruqlar eskisi bilan aynan bir xil', () => {
      const r = deployRun(name);
      expect(r.status).toBe(0);
      expect(mutating(r)).toEqual(SERVER_BUILD);
      expect(r.out).not.toContain('ghcr.io');
    });

    it('CI_IMAGES bo`sh yoki boshqa qiymat ham o`chiq', () => {
      for (const CI_IMAGES of ['', 'false', 'yes']) {
        expect(mutating(deployRun(name, { CI_IMAGES }))).toEqual(SERVER_BUILD);
      }
    });

    it('ishlayotgan ops sidecar o`chiq holatda avvalgidek --build', () => {
      const calls = mutating(deployRun(name, { FAKE_SIDECAR: '1' }));
      expect(calls).toContain('dc up -d --no-deps --build db-reconcile');
    });

    it('yoqiq: hech narsa serverda build qilinmaydi, sha bilan olinadi', () => {
      const r = deployRun(name, {
        CI_IMAGES: 'true',
        GHCR_TOKEN: TOKEN,
        GHCR_USER: 'bot',
        FAKE_SIDECAR: '1',
      });
      expect(r.status).toBe(0);
      const calls = mutating(r);
      const repo = 'ghcr.io/5e-tech/elchi-backend';
      expect(calls).toContain('docker login ghcr.io -u bot --password-stdin');
      expect(calls).toContain(`docker pull -q ${repo}/order-service:${SHA}`);
      expect(calls).toContain(`docker pull -q ${repo}/api-gateway:${SHA}`);
      expect(calls).toContain(`docker pull -q ${repo}/ops:${SHA}`);
      expect(calls).toContain(
        `docker tag ${repo}/order-service:${SHA} proj-order-service`,
      );
      // config --images bog'liqliklarni ham beradi: to'g'ri qator tanlanadi.
      expect(calls).toContain(
        `docker tag ${repo}/ops:${SHA} proj-migration-runner`,
      );
      expect(calls).toContain(
        `docker tag ${repo}/ops:${SHA} proj-db-reconcile`,
      );
      expect(calls).toContain(
        'dc up --no-build --force-recreate --abort-on-container-exit migration-runner',
      );
      expect(calls).toContain(
        'dc up -d --no-deps --no-build --remove-orphans order-service',
      );
      expect(calls).toContain('dc up -d --no-deps --no-build db-reconcile');
      expect(calls.filter((c) => /--build|^dc build/.test(c))).toEqual([]);
      expect(calls).toContain(
        'dc up -d --no-deps --no-recreate --scale api-gateway=2 api-gateway',
      );
    });

    it('token logga tushmaydi, u faqat docker login stdin`ida', () => {
      const r = deployRun(name, {
        CI_IMAGES: 'true',
        GHCR_TOKEN: TOKEN,
        GHCR_USER: 'bot',
      });
      expect(r.out).not.toContain(TOKEN);
      expect(r.calls.join('\n')).not.toContain(TOKEN);
    });

    it.each(['fail', 'fail-login'])(
      'GHCR %s: server avvalgidek o`zi build qiladi, deploy yashil',
      (FAKE_PULL) => {
        const r = deployRun(name, {
          CI_IMAGES: 'true',
          GHCR_TOKEN: TOKEN,
          FAKE_PULL,
        });
        expect(r.status).toBe(0);
        expect(r.out).toContain('building on this server');
        expect(
          mutating(r).filter(
            (c) => !/ (pull|tag|login) /.test(` ${c} `) || c.startsWith('dc '),
          ),
        ).toEqual(SERVER_BUILD);
      },
    );

    it('rollback har doim serverda build qiladi (eski commit image`i registry`da bo`lmasligi mumkin)', () => {
      const r = deployRun(name, {
        CI_IMAGES: 'true',
        GHCR_TOKEN: TOKEN,
        FAKE_NOT_READY: '1',
      });
      expect(r.status).toBe(1);
      expect(r.out).toContain('DEPLOY FAILED');
      expect(r.calls.join('\n')).toMatch(
        /up -d --no-deps --build api-gateway identity-service/,
      );
    });
  },
);

describe('deploy.yml: CI build wiring', () => {
  const prod = job('deploy');
  const staging = job('deploy-staging');

  it('sukut o`chiq: build qadami va token faqat o`zgaruvchi bilan', () => {
    expect(prod).toMatch(
      /- name: Build and push images[^\n]*\n {8}if: vars\.CI_IMAGES_ENABLED == 'true'\n/,
    );
    expect(staging).toMatch(
      /- name: Build and push images[^\n]*\n {8}if: vars\.CI_IMAGES_ENABLED == 'true' \|\| vars\.CI_IMAGES_ENABLED == 'staging'\n/,
    );
    expect(prod).toContain(
      "GHCR_TOKEN: ${{ vars.CI_IMAGES_ENABLED == 'true' && github.token || '' }}",
    );
    expect(staging).toContain(
      "GHCR_TOKEN: ${{ (vars.CI_IMAGES_ENABLED == 'true' || vars.CI_IMAGES_ENABLED == 'staging') && github.token || '' }}",
    );
  });

  it('job darvozalari tegilmagan: needs va if', () => {
    expect(prod).toContain('needs: [test, unit-tests]');
    expect(prod).toContain("if: github.ref == 'refs/heads/main'");
    expect(staging).toContain('needs: [test, unit-tests]');
    expect(staging).toContain(
      "if: github.ref == 'refs/heads/test' && vars.STAGING_ENABLED == 'true'",
    );
  });

  it('packages: write ikkala deploy job`ida, build staging darvozasidan keyin', () => {
    for (const j of [prod, staging]) {
      expect(j).toMatch(
        /permissions:\n(?: {6}[a-z]+: \w+\n)* {6}packages: write/,
      );
      expect(j).toContain('envs: CI_IMAGES,GHCR_TOKEN,GHCR_USER');
      expect(j.indexOf('Build and push images')).toBeLessThan(
        j.indexOf('Deploy via SSH'),
      );
    }
    expect(prod.indexOf('Staging gate')).toBeLessThan(
      prod.indexOf('Build and push images'),
    );
  });

  it('prod skriptida o`zgaruvchi ifodasi yo`q: staging bilan bir xil generatsiya', () => {
    expect(jobScript('deploy')).not.toContain('vars.');
    expect(jobScript('deploy')).not.toContain('github.token');
  });
});

describe('scripts/ci-build-images.sh', () => {
  const SCRIPT = join(ROOT, 'scripts', 'ci-build-images.sh');
  const fake = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  login) cat > "$FAKE_LOG.stdin" ;;
  manifest) case "$*" in *"\${FAKE_EXISTS:-none}"*) exit 0 ;; *) exit 1 ;; esac ;;
  build) [ "\${FAKE_BUILD:-}" != fail ] ;;
esac
`;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-build-'));
    writeFileSync(join(dir, 'docker'), fake);
    chmodSync(join(dir, 'docker'), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        FAKE_LOG: join(dir, 'log'),
        GHCR_TOKEN: TOKEN,
        IMAGE_TAG: SHA,
        GITHUB_ACTOR: 'bot',
        GITHUB_REPOSITORY: '5E-TECH/Elchi-Backend',
        ...env,
      },
    });
  const log = () => readFileSync(join(dir, 'log'), 'utf8');

  it('15 servis + ops: kichik harfli repo, sha tag, push', () => {
    const r = run();
    expect(r.status).toBe(0);
    const repo = 'ghcr.io/5e-tech/elchi-backend';
    const apps = readdirSync(join(ROOT, 'apps'));
    expect(apps).toHaveLength(15);
    for (const s of [...apps, 'ops']) {
      expect(log()).toContain(`docker push ${repo}/${s}:${SHA}`);
    }
    expect(log()).toMatch(
      new RegExp(`docker build .*-f Dockerfile\\.ops .*-t ${repo}/ops:${SHA}`),
    );
    expect(log()).toMatch(
      new RegExp(
        `docker build .*-f apps/api-gateway/Dockerfile .*-t ${repo}/api-gateway:${SHA}`,
      ),
    );
    expect(log()).not.toContain(TOKEN);
    expect(readFileSync(join(dir, 'log.stdin'), 'utf8')).toBe(TOKEN);
  });

  it('staging uchun qurilgan image qayta build qilinmaydi', () => {
    expect(run({ FAKE_EXISTS: `/api-gateway:${SHA}` }).status).toBe(0);
    expect(log()).not.toMatch(/docker build .*api-gateway\/Dockerfile/);
    expect(log()).not.toMatch(/docker push \S+\/api-gateway:/);
    expect(log()).toMatch(/docker build .*order-service\/Dockerfile/);
  });

  it('build yiqilsa job qizil, keyingi image`ga o`tilmaydi', () => {
    const r = run({ FAKE_BUILD: 'fail' });
    expect(r.status).not.toBe(0);
    expect(log().match(/docker build/g)).toHaveLength(1);
  });

  it('majburiy env yo`q bo`lsa aniq xato', () => {
    expect(run({ IMAGE_TAG: '' }).status).not.toBe(0);
  });
});

describe('uptime monitor', () => {
  const SCRIPT = join(ROOT, 'scripts', 'uptime-check.sh');
  const workflow = read('.github/workflows/uptime-monitor.yml');
  const BOT = '123:BOT-TOKEN-not-in-argv';
  // FAKE_DOWN ga kirgan URL 502 qaytaradi; FAKE_BLIP — birinchi urinishda.
  const fake = `#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
cat >> "$FAKE_LOG.stdin" 2>/dev/null
url="\${@: -1}"
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
case "$url" in *api.telegram*|https://x*) ;; esac
if grep -q "api.telegram" "$FAKE_LOG.stdin" 2>/dev/null && [ -z "$out" -o "$out" = /dev/null ]; then echo -n 200; exit 0; fi
n=$(cat "$FAKE_LOG.n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_LOG.n"
if [ -n "\${FAKE_DOWN:-}" ] || { [ -n "\${FAKE_BLIP:-}" ] && [ "$n" = 1 ]; }; then
  echo '<html>502</html>' > "$out"; echo -n 502
else
  echo '{"status":"ok","service":"api-gateway"}' > "$out"; echo -n 200
fi
`;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uptime-'));
    writeFileSync(join(dir, 'curl'), fake);
    writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\n');
    chmodSync(join(dir, 'curl'), 0o755);
    chmodSync(join(dir, 'sleep'), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const secrets = {
    BACKUP_ALERT_TELEGRAM_BOT_TOKEN: BOT,
    BACKUP_ALERT_TELEGRAM_CHAT_ID: '42',
  };
  const run = (env: Record<string, string> = {}) =>
    spawnSync(
      'bash',
      [SCRIPT, 'https://a.test/health', 'https://b.test/health'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          PATH: `${dir}:/usr/bin:/bin`,
          FAKE_LOG: join(dir, 'log'),
          ...env,
        },
      },
    );
  const curl = () =>
    existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '';

  it('hammasi sog`lom va sirlar bor: yashil, xabar yo`q', () => {
    const r = run(secrets);
    expect(r.status).toBe(0);
    expect(curl()).not.toContain('chat_id');
  });

  it('bir martalik uzilish alert bermaydi (qayta urinish)', () => {
    const r = run({ ...secrets, FAKE_BLIP: '1' });
    expect(r.status).toBe(0);
    expect(curl()).not.toContain('chat_id');
  });

  it('yiqilsa: Telegram xabar va job qizil, token argv`da yo`q', () => {
    const r = run({ ...secrets, FAKE_DOWN: '1' });
    expect(r.status).toBe(1);
    expect(curl()).toMatch(/chat_id=42/);
    expect(curl()).toMatch(/a\.test\/health/);
    expect(curl()).toMatch(/text=[^\n]*b\.test\/health/);
    expect(curl()).toMatch(/HTTP 502/);
    expect(curl()).not.toContain(BOT);
    expect(r.stdout + r.stderr).not.toContain(BOT);
  });

  it('sir yo`q va sog`lom: job yashil, faqat ogohlantirish', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain('BACKUP_ALERT_TELEGRAM_BOT_TOKEN');
  });

  it('sir yo`q va yiqilgan: job qizil', () => {
    const r = run({ FAKE_DOWN: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('DOWN');
  });

  it('workflow: har 5 daqiqa, prod va test, faqat o`qish', () => {
    expect(workflow).toMatch(/cron: '\*\/5 \* \* \* \*'/);
    expect(workflow).toContain('https://api.elchipochta.uz/health');
    expect(workflow).toContain('https://test-api.elchipochta.uz/health');
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(workflow).not.toMatch(/pull_request|^\s+push:/m);
    expect(workflow).toContain(
      'BACKUP_ALERT_TELEGRAM_BOT_TOKEN: ${{ secrets.BACKUP_ALERT_TELEGRAM_BOT_TOKEN }}',
    );
  });
});

describe('sir rotatsiyasi: gateway swap, rabbitmq tegilmaydi', () => {
  const ROT = join(ROOT, 'scripts', 'rotate-datastore-secrets.sh');
  const SECRETS = join(ROOT, 'scripts', 'rotate-secrets.sh');
  const fake = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
if [ "$1" = compose ]; then
  case "$*" in
    *"ps -q api-gateway"*) cat "$FAKE_DIR/gw" ;;
    *"--scale api-gateway=2"*) echo new >> "$FAKE_DIR/gw" ;;
  esac
  exit 0
fi
case "$1" in
  inspect) echo "\${FAKE_HEALTH:-healthy}" ;;
  rm) printf 'new\\n' > "$FAKE_DIR/gw" ;;
esac
exit 0
`;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rotate-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'docker'), fake);
    writeFileSync(join(dir, 'bin', 'sleep'), '#!/usr/bin/env bash\n');
    chmodSync(join(dir, 'bin', 'docker'), 0o755);
    chmodSync(join(dir, 'bin', 'sleep'), 0o755);
    writeFileSync(join(dir, 'gw'), 'old\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rot = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [ROT, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
        HOME: dir,
        FAKE_LOG: join(dir, 'log'),
        FAKE_DIR: dir,
        ROT_DIR: join(dir, 'rot'),
        ELCHI_APP_DIR: dir,
        ...env,
      },
    });
  const log = () =>
    existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '';

  it('gateway-swap --execute: 2 ga scale, healthy, eskisi to`xtatiladi, recreate yo`q', () => {
    const r = rot(['gateway-swap', '--execute']);
    expect(r.status).toBe(0);
    const calls = log().split('\n');
    const at = (re: RegExp) => calls.findIndex((c) => re.test(c));
    expect(
      at(/--no-recreate --scale api-gateway=2 api-gateway/),
    ).toBeGreaterThan(-1);
    expect(at(/docker stop -t 30 old/)).toBeGreaterThan(
      at(/--scale api-gateway=2/),
    );
    expect(at(/--scale api-gateway=1 api-gateway/)).toBeGreaterThan(
      at(/docker rm -f old/),
    );
    expect(log()).not.toMatch(/--force-recreate/);
  });

  it('yangi gateway sog`lom bo`lmasa eskisi ishlab qoladi, skript xato bilan to`xtaydi', () => {
    const r = rot(['gateway-swap', '--execute'], { FAKE_HEALTH: 'unhealthy' });
    expect(r.status).toBe(1);
    expect(log()).toMatch(/docker rm -f new/);
    expect(log()).not.toMatch(/docker stop -t 30 old/);
  });

  it('dry-run: hech narsa qilmaydi', () => {
    const r = rot(['gateway-swap']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dry-run');
    expect(log()).not.toMatch(/scale api-gateway/);
  });

  it('postgres va rabbitmq qadamlari gateway`ni recreate qilmaydi', () => {
    const script = readFileSync(ROT, 'utf8');
    expect(script).not.toMatch(/^\s*recreate \$(APP|DB)_SERVICES$/m);
    expect(
      script.match(/^\s*recreate_app \$(APP|DB)_SERVICES$/gm),
    ).toHaveLength(4);
    const fn = script.slice(script.indexOf('recreate_app() {'));
    expect(fn.indexOf('recreate $rest')).toBeLessThan(
      fn.indexOf('gateway_swap'),
    );
    for (const r of [rot(['postgres']), rot(['rabbitmq'])]) {
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/recreating: (?!.*api-gateway)/);
      expect(r.stdout).toMatch(/would swap api-gateway/);
    }
  });

  it('rotate-secrets.sh: rabbitmq`ga tegmaydigan buyruqlar, swap', () => {
    writeFileSync(
      join(dir, '.env.production'),
      'POSTGRES_PASSWORD=x\nRABBITMQ_URI=amqp://u:p@rabbitmq:5672\n',
    );
    const r = spawnSync('bash', [SECRETS], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/up -d --force-recreate/);
    const line = r.stdout
      .split('\n')
      .find((l) => l.includes('--force-recreate'))!;
    expect(line).toContain('up -d --no-deps --force-recreate');
    expect(line).not.toMatch(/rabbitmq|api-gateway/);
    expect(r.stdout).toContain(
      'rotate-datastore-secrets.sh gateway-swap --execute',
    );
  });

  it.each([
    'docs/audit/SECRET_ROTATION_RUNBOOK.md',
    'docs/audit/PENDING_ACTIONS.md',
    'docs/ops/secret-rotation.md',
  ])('%s: yalang `up -d --force-recreate` yo`q', (doc) => {
    const text = read(doc);
    expect(text).not.toMatch(/up -d --force-recreate/);
    expect(text).not.toMatch(/--force-recreate [^\n]*\bapi-gateway\b/);
  });
});
