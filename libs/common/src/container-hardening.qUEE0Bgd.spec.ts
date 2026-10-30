import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * qUEE0Bgd: konteynerlarni qotirish qoidalari. Docker kerak emas — Dockerfile,
 * docker-compose.prod.yml va deploy.yml statik tekshiriladi (db-backup-*.spec
 * uslubida); haqiqiy image'lar lokal build qilinib tekshirilgan.
 */
const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const compose = read('docker-compose.prod.yml');
const deploy = read('.github/workflows/deploy.yml');

const APP_SERVICES = readdirSync(join(ROOT, 'apps'));
const OPS_SIDECARS = ['migration-runner', 'db-reconcile', 'activity-log-prune'];
const BACKUP_SIDECARS = ['db-backup', 'backup-offsite'];

/** Izohlarsiz bitta compose servisi bloki (`  name:` dan keyingi kalitgacha). */
function service(name: string): string {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`compose: ${name} topilmadi`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^( {2})?\S/.test(l) && !/^ {2}#/.test(l));
  return rest
    .slice(0, end < 0 ? undefined : end)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/** `x-...: &anchor` bloki. */
function anchor(name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`x-${name}:`));
  if (start < 0) throw new Error(`compose: x-${name} topilmadi`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

/** Dockerfile'ning oxirgi (runtime) bosqichi. */
const finalStage = (dockerfile: string) =>
  dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

/** Deploy skriptidagi (izoh bo'lmagan) qatorlar. */
const deployCommands = deploy
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

describe('qUEE0Bgd: image root ostida ishlamaydi', () => {
  it('15 servis bor (ro`yxat eskirmagan)', () => {
    expect(APP_SERVICES).toHaveLength(15);
  });

  it.each(APP_SERVICES)('%s: runtime bosqichi USER node', (svc) => {
    const stage = finalStage(read(`apps/${svc}/Dockerfile`));
    expect(stage).toMatch(/^USER node$/m);
    // USER'dan keyin RUN/COPY bo'lsa ular node nomidan ishlaydi (apk yiqiladi)
    // yoki fayl egasi o'zgaradi — USER oxirida, CMD dan oldin turadi.
    const after = stage.slice(stage.indexOf('\nUSER node'));
    expect(after).not.toMatch(/^(RUN|COPY|ADD) /m);
    expect(after).toMatch(/^CMD \["node", "dist\/apps\//m);
  });

  it.each(APP_SERVICES)(
    '%s: node_modules hamma image uchun umumiy qoladi',
    (svc) => {
      // --chown yoki `chown -R` umumiy qatlamni har image'ga ko'chirardi va kod
      // ilova foydalanuvchisiga yoziladigan bo'lib qolardi.
      const dockerfile = read(`apps/${svc}/Dockerfile`);
      expect(dockerfile).not.toMatch(/--chown|chown -R/);
      // Build bosqichlari root'da qoladi (npm ci, apk add).
      expect(dockerfile.match(/^USER /gm)).toHaveLength(1);
    },
  );
});

describe('qUEE0Bgd: ops sidecar`lari build bosqichida', () => {
  const dockerfile = read('Dockerfile.ops');

  it('Dockerfile.ops: dev deps (ts-node) + kod image ichida, USER node', () => {
    expect(dockerfile).toMatch(/^RUN npm ci$/m);
    expect(dockerfile).toMatch(/^COPY \. \.$/m);
    expect(dockerfile).toMatch(/^USER node$/m);
    const after = dockerfile.slice(dockerfile.indexOf('\nUSER node'));
    expect(after).not.toMatch(/^(RUN|COPY|ADD) /m);
  });

  it('build qatlamlari servis builder bosqichi bilan bir xil (npm ci kesh)', () => {
    const builder = read('apps/ai-service/Dockerfile');
    expect(dockerfile).toContain(
      builder.slice(0, builder.indexOf('COPY . .')).replace(' AS builder', ''),
    );
  });

  it('sirlar image`ga tushmaydi', () => {
    expect(read('.dockerignore')).toMatch(/^\.env\.\*$/m);
    expect(read('.dockerignore')).toMatch(/^\.env$/m);
  });

  it.each(OPS_SIDECARS)('%s: bind-mount yo`q, npm ci yo`q', (name) => {
    const svc = service(name);
    expect(svc).not.toMatch(/npm ci/);
    expect(svc).not.toMatch(/volumes:/);
    expect(svc).not.toMatch(/\.\/:\/app/);
    expect(svc).not.toMatch(/image: node/);
    expect(svc).toMatch(/<<: .*\*ops\b/);
  });

  it('ops anchor Dockerfile.ops dan build qiladi', () => {
    expect(anchor('ops')).toContain('dockerfile: Dockerfile.ops');
    expect(anchor('ops')).toContain('context: .');
  });

  it('eski loop skriptlari va db:prepare o`zgarmagan holda chaqiriladi', () => {
    expect(service('migration-runner')).toContain(
      "['npm', 'run', 'db:prepare']",
    );
    expect(service('db-reconcile')).toContain(
      "['sh', 'scripts/reconcile-cron.sh']",
    );
    expect(service('activity-log-prune')).toContain(
      "['sh', 'scripts/prune-activity-logs-cron.sh']",
    );
  });

  it('migration-runner hali ham exit bo`ladi, env_file saqlangan', () => {
    expect(service('migration-runner')).toContain("restart: 'no'");
    for (const name of OPS_SIDECARS) {
      expect(service(name)).toContain('env_file: .env.production');
    }
  });
});

describe('qUEE0Bgd: compose — no-new-privileges, cap_drop', () => {
  it('hardening anchor', () => {
    const hardening = anchor('hardening');
    expect(hardening).toContain('- no-new-privileges:true');
    expect(hardening).toMatch(/cap_drop:\s+- ALL/);
    expect(hardening).not.toContain('cap_add');
  });

  it('limit anchor`lari hardening`ni olib keladi', () => {
    expect(anchor('svc-limits')).toContain('<<: *hardening');
    expect(anchor('hot-svc-limits')).toContain('<<: *hardening');
    expect(anchor('ops')).toContain('<<: *hardening');
    expect(anchor('cloudflared')).toContain('<<: *hardening');
  });

  it.each(APP_SERVICES)('%s limit anchor`i bilan keladi', (name) => {
    expect(service(name)).toMatch(/<<: \*(hot-)?svc-limits$/m);
  });

  it.each(BACKUP_SIDECARS)('%s: root qoladi, faqat fayl ruxsatlari', (name) => {
    expect(service(name)).toContain('<<: *backup-hardening');
    expect(service(name)).not.toMatch(/^\s+user:/m);
  });

  it('backup-hardening: backups/ dagi boshqa egali 0600 dump`lar o`qiladi', () => {
    const backup = anchor('backup-hardening');
    expect(backup).toContain('- no-new-privileges:true');
    expect(backup).toMatch(/cap_drop:\s+- ALL/);
    expect(backup).toMatch(/cap_add:\s+- DAC_OVERRIDE\s+- DAC_READ_SEARCH/);
  });

  it('ma`lumot omborlari yashirin qayta yaratilmaydi (ta`rifi tegilmagan)', () => {
    // Entrypoint root'da chown qilib, keyin o'z foydalanuvchisiga tushadi —
    // cap_drop: ALL ularni buzadi; postgres ta'rifi o'zgarsa deploy uni qayta
    // yaratadi.
    for (const name of ['postgres', 'rabbitmq', 'minio']) {
      expect(service(name)).not.toMatch(/cap_drop|security_opt|<<:/);
    }
  });
});

describe('qUEE0Bgd: image versiyalari qotirilgan', () => {
  const images = [...compose.matchAll(/^\s+image: (\S+)$/gm)].map((m) => m[1]);

  it('compose`da image`lar bor', () => {
    expect(images.length).toBeGreaterThanOrEqual(6);
  });

  it('rabbitmq va cloudflared: tag + digest', () => {
    expect(service('rabbitmq')).toMatch(
      /image: rabbitmq:3\.13\.7-management@sha256:[0-9a-f]{64}$/m,
    );
    expect(anchor('cloudflared')).toMatch(
      /image: cloudflare\/cloudflared:[\d.]+@sha256:[0-9a-f]{64}$/m,
    );
  });

  it('suzuvchi tag faqat minio`da va u registry`dan hech qachon olinmaydi', () => {
    const floating = images.filter((i) =>
      /:latest$|^[^:]+$|^rabbitmq:3-management$|^minio\//.test(i),
    );
    expect(floating).toEqual(['minio/minio:latest']);
    expect(service('minio')).toMatch(/^ {4}pull_policy: never$/m);
  });
});

describe('qUEE0Bgd: deploy.yml', () => {
  it('postgres `pull` orqali yangilanib, deploy`da qayta yaratilmaydi', () => {
    // minio endi `pull` ni yiqitmaydi — postgres shu sabab yetib borardi.
    expect(service('postgres')).toMatch(/^ {4}pull_policy: missing$/m);
    expect(deployCommands).toContain(' pull rabbitmq postgres minio || true');
  });

  it('rabbitmq deploy`da qayta yaratilmaydi (node nomi = konteyner id)', () => {
    for (const compose_ of [
      'docker compose -f docker-compose.prod.yml up -d --no-recreate --remove-orphans rabbitmq\n',
      'docker compose -f docker-compose.prod.yml -f docker-compose.staging.yml up -d --no-recreate --remove-orphans rabbitmq\n',
    ]) {
      expect(deployCommands).toContain(compose_);
    }
    expect(deployCommands).not.toMatch(/up -d --remove-orphans [^\n]*rabbitmq/);
  });

  it('postgres va minio avvalgidek ko`tariladi', () => {
    expect(deployCommands).toContain(
      'docker compose -f docker-compose.prod.yml up -d --remove-orphans postgres minio\n',
    );
  });

  it('rabbitmq `depends_on` orqali ham tegilmaydi: sidecar`lar --no-deps', () => {
    expect(deployCommands).toContain(
      'docker compose -f docker-compose.prod.yml up -d --no-deps --build $OPS_SIDECARS',
    );
    expect(service('migration-runner')).not.toContain('rabbitmq');
  });

  it('faqat ishlayotgan ops sidecar`lari yangilanadi, deploy ularni yoqmaydi', () => {
    const start = deployCommands.indexOf('OPS_SIDECARS=""');
    expect(start).toBeGreaterThan(0);
    const block = deployCommands.slice(
      start,
      deployCommands.indexOf('$OPS_SIDECARS ||', start),
    );
    expect(block).toContain('for s in db-reconcile activity-log-prune; do');
    expect(block).toContain('ps -q "$s"');
    expect(block).toContain('if [ -n "$OPS_SIDECARS" ]; then');
  });

  it('ops sidecar xatosi deploy`ni qaytarmaydi (|| WARNING)', () => {
    expect(deployCommands).toMatch(
      /up -d --no-deps --build \$OPS_SIDECARS \|\| echo "WARNING/,
    );
  });

  it('migration-runner --build bilan ko`tariladi: image shu commit kodini oladi', () => {
    expect(deployCommands).toContain(
      'up --build --force-recreate --abort-on-container-exit migration-runner',
    );
  });
});
