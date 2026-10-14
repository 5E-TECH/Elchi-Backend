import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { CronJob } from 'cron';
import * as sentry from '../sentry/sentry.helper';
import { ActivityLogMaintenanceService } from './activity-log-maintenance.service';
import { ActivityLogModule } from './activity-log.module';
import { ActivityLogRetentionScheduler } from './activity-log-retention.scheduler';
import {
  ACTIVITY_LOG_PRUNE_SCHEDULE,
  ACTIVITY_LOG_PRUNE_TIMEZONE,
  activityLogPruneCronFor,
  buildPolicyCountSql,
  buildPolicyPruneSql,
  isActivityLogPruneEnabled,
  pruneByRuleBatched,
  resolveActivityLogRetentionPolicy,
} from './retention-policy';

/**
 * i6Nyedea — jurnal saqlash muddati: siyosat, servis cron'lari, dry-run
 * sukuti. Haqiqiy Postgres (partiyalar, 100k qator, login birlashtirish) —
 * `retention-policy.pg.spec.ts`.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');

describe('i6Nyedea — siyosat (env)', () => {
  it('⭐ ACTIVITY_LOG_PRUNE_ENABLED sukut bo`yicha O`CHIQ (dry-run)', () => {
    expect(isActivityLogPruneEnabled({})).toBe(false);
    expect(isActivityLogPruneEnabled({ ACTIVITY_LOG_PRUNE_ENABLED: '' })).toBe(
      false,
    );
    expect(
      isActivityLogPruneEnabled({ ACTIVITY_LOG_PRUNE_ENABLED: 'false' }),
    ).toBe(false);
    expect(
      isActivityLogPruneEnabled({ ACTIVITY_LOG_PRUNE_ENABLED: 'nope' }),
    ).toBe(false);
    for (const v of ['true', 'TRUE', '1', 'yes', 'on']) {
      expect(isActivityLogPruneEnabled({ ACTIVITY_LOG_PRUNE_ENABLED: v })).toBe(
        true,
      );
    }
  });

  it('⭐ qiymat berilmasa xavfsiz (uzun) sukut: auth 90, qolgani 1095 kun', () => {
    const { rules, warnings } = resolveActivityLogRetentionPolicy({});
    expect(rules.map((r) => [r.name, r.days, r.mode])).toEqual([
      ['auth', 90, 'include'],
      ['default', 1095, 'exclude'],
    ]);
    expect(warnings).toEqual([]);
    // login/logout/auth_failure — qisqa sinfda; moliyaviy fe'llar EMAS.
    expect(rules[0].actions).toEqual(
      expect.arrayContaining(['login', 'logout', 'auth_failure']),
    );
    expect(rules[0].actions).not.toContain('finance.manual_expense');
    expect(rules[1].actions).toEqual(rules[0].actions);
  });

  it('env`dan o`qiladi; noto`g`ri / juda kichik qiymat rad etiladi + ogohlantirish', () => {
    const ok = resolveActivityLogRetentionPolicy({
      ACTIVITY_LOG_RETENTION_AUTH_DAYS: '30',
      ACTIVITY_LOG_RETENTION_DEFAULT_DAYS: '730',
    });
    expect(ok.rules.map((r) => r.days)).toEqual([30, 730]);

    const bad = resolveActivityLogRetentionPolicy({
      ACTIVITY_LOG_RETENTION_AUTH_DAYS: '0',
      ACTIVITY_LOG_RETENTION_DEFAULT_DAYS: '30', // < 365 — moliyaviy dalil himoyasi
    });
    expect(bad.rules.map((r) => r.days)).toEqual([90, 1095]);
    expect(bad.warnings).toHaveLength(2);
    expect(bad.warnings[1]).toContain('kamida 365 kun');
  });

  it('SQL: auth — `action = ANY`, default — `action <> ALL`; DELETE va dry-run AYNI shart', () => {
    const [auth, rest] = resolveActivityLogRetentionPolicy({}).rules;
    const t = '"order_schema"."activity_logs"';
    expect(buildPolicyPruneSql(t, auth, 500)).toContain(
      's.action = ANY($2::text[])',
    );
    expect(buildPolicyPruneSql(t, rest, 500)).toContain(
      's.action <> ALL($2::text[])',
    );
    expect(buildPolicyPruneSql(t, rest, 500)).toContain('LIMIT 500');
    const cond = 's.created_at < now() - make_interval(days => $1)';
    expect(buildPolicyPruneSql(t, auth, 500)).toContain(cond);
    expect(buildPolicyCountSql(t, auth)).toContain(cond);
  });
});

describe('i6Nyedea — partiyalab o`chirish', () => {
  const rule = resolveActivityLogRetentionPolicy({}).rules[0];

  it('⭐ partiya to`la bo`lsa davom etadi, har partiya orasida pauza; kam bo`lsa to`xtaydi', async () => {
    const results = [1000, 1000, 1000, 400];
    const run = jest.fn(() =>
      Promise.resolve([{ deleted: results.shift() ?? 0 }]),
    );
    const sleep = jest.fn(() => Promise.resolve());

    const res = await pruneByRuleBatched(run, 'T', rule, {
      batchSize: 1000,
      pauseMs: 50,
      sleep,
    });

    expect(res).toEqual({ deleted: 3400, batches: 4 });
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[0]).toEqual([
      expect.stringContaining('LIMIT 1000'),
      [90, rule.actions],
    ]);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it('qochib ketgan sikl himoyasi: maxBatches dan oshmaydi', async () => {
    const run = jest.fn(() => Promise.resolve([{ deleted: 10 }]));
    const res = await pruneByRuleBatched(run, 'T', rule, {
      batchSize: 10,
      pauseMs: 0,
      maxBatches: 5,
    });
    expect(res.batches).toBe(5);
  });

  it('noto`g`ri muddat (0 — HAMMASINI o`chirardi) so`rovsiz rad etiladi', async () => {
    const run = jest.fn();
    await expect(
      pruneByRuleBatched(run, 'T', { ...rule, days: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('i6Nyedea — servis cron`lari', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        return name === 'node_modules' ? [] : walk(full);
      }
      return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
    });

  it('⭐ har servis (ActivityLogModule.forService) o`z slotiga ega; vaqtlar TURLICHA', () => {
    const names = walk(join(ROOT, 'apps')).flatMap((f) =>
      [
        ...readFileSync(f, 'utf8').matchAll(
          /ActivityLogModule\.forService\(\s*'([a-z-]+)'\s*\)/g,
        ),
      ].map((m) => m[1]),
    );
    const unique = [...new Set(names)];
    // 9 ta jurnal servisi + ai-service.
    expect(unique.length).toBeGreaterThanOrEqual(10);
    for (const name of unique) {
      expect({ name, slot: ACTIVITY_LOG_PRUNE_SCHEDULE[name] }).toEqual({
        name,
        slot: expect.any(String),
      });
    }
    const slots = unique.map((n) => ACTIVITY_LOG_PRUNE_SCHEDULE[n]);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('servis o`z vaqtini env bilan almashtira oladi', () => {
    expect(
      activityLogPruneCronFor('order-service', {
        ACTIVITY_LOG_PRUNE_CRON_ORDER_SERVICE: '0 0 2 * * *',
      }),
    ).toBe('0 0 2 * * *');
    expect(activityLogPruneCronFor('order-service', {})).toBe('0 15 3 * * *');
    expect(activityLogPruneCronFor('new-service', {})).toBe('0 45 4 * * *');
  });

  it('⭐ ActivityLogModule.forService scheduler va maintenance ni ro`yxatdan o`tkazadi', () => {
    const mod = ActivityLogModule.forService('finance-service');
    expect(mod.providers).toEqual(
      expect.arrayContaining([
        ActivityLogRetentionScheduler,
        ActivityLogMaintenanceService,
      ]),
    );
    expect(mod.exports).toContain(ActivityLogMaintenanceService);
  });
});

describe('ActivityLogRetentionScheduler', () => {
  const report = {
    service: 'order-service',
    dryRun: true,
    rules: [
      { name: 'auth', days: 90, count: 7, batches: 0 },
      { name: 'default', days: 1095, count: 0, batches: 0 },
    ],
    warnings: [],
  };

  function make(pruneImpl?: () => Promise<unknown>) {
    const maintenance = {
      pruneByPolicy: jest.fn(pruneImpl ?? (() => Promise.resolve(report))),
      logCoalesced: jest.fn(),
    };
    const scheduler = new ActivityLogRetentionScheduler(
      maintenance as never,
      'order-service',
    );
    return { scheduler, maintenance };
  }

  afterEach(() => {
    delete process.env.ACTIVITY_LOG_PRUNE_ENABLED;
    delete process.env.ACTIVITY_LOG_PRUNE_CRON_DISABLED;
    jest.restoreAllMocks();
  });

  it('⭐ sukut — DRY-RUN (hech narsa o`chirilmaydi), natija tizim log`iga', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const { scheduler, maintenance } = make();

    const res = await scheduler.run();

    expect(maintenance.pruneByPolicy).toHaveBeenCalledWith({ dryRun: true });
    expect(res).toBe(report);
    expect(logSpy.mock.calls.map(([m]) => String(m)).join('\n')).toContain(
      "dry-run — o'chiriladigan: auth(90 kun)=7",
    );
    // Jurnal yozuvi YO'Q — scheduler'da ActivityLogService umuman yo'q,
    // maintenance'ning logCoalesced'i ham chaqirilmaydi.
    expect(maintenance.logCoalesced).not.toHaveBeenCalled();
  });

  it('ACTIVITY_LOG_PRUNE_ENABLED=true — haqiqiy o`chirish rejimi', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    process.env.ACTIVITY_LOG_PRUNE_ENABLED = 'true';
    const { scheduler, maintenance } = make();
    await scheduler.run();
    expect(maintenance.pruneByPolicy).toHaveBeenCalledWith({ dryRun: false });
  });

  it('⭐ xato monitoringga chiqadi (logger.error + Sentry), servis yiqilmaydi', async () => {
    const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const sentrySpy = jest
      .spyOn(sentry, 'captureException')
      .mockImplementation();
    const { scheduler } = make(() => Promise.reject(new Error('lock timeout')));

    await expect(scheduler.run()).resolves.toBeNull();

    expect(errSpy.mock.calls[0][0]).toContain('XATO: lock timeout');
    expect(sentrySpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: 'ActivityLogRetentionScheduler.run',
        service: 'order-service',
      }),
    );
  });

  it('oldingi ishga tushish tugamagan bo`lsa ikkinchisi o`tkazib yuboriladi', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    let release!: () => void;
    const { scheduler, maintenance } = make(
      () =>
        new Promise((resolve) => {
          release = () => resolve(report);
        }),
    );
    const first = scheduler.run();
    await expect(scheduler.run()).resolves.toBeNull();
    release();
    await first;
    expect(maintenance.pruneByPolicy).toHaveBeenCalledTimes(1);
  });

  it('⭐ bootstrap: servis slotida, Toshkent vaqtida CronJob; destroy — to`xtatiladi', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const stop = jest.fn();
    const fromSpy = jest
      .spyOn(CronJob, 'from')
      .mockReturnValue({ stop } as never);
    const { scheduler } = make();

    scheduler.onApplicationBootstrap();
    expect(fromSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cronTime: '0 15 3 * * *',
        timeZone: ACTIVITY_LOG_PRUNE_TIMEZONE,
        start: true,
        unrefTimeout: true,
      }),
    );
    scheduler.onModuleDestroy();
    expect(stop).toHaveBeenCalled();
  });

  it('ACTIVITY_LOG_PRUNE_CRON_DISABLED=true — cron ro`yxatdan o`tmaydi', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    process.env.ACTIVITY_LOG_PRUNE_CRON_DISABLED = 'true';
    const fromSpy = jest.spyOn(CronJob, 'from');
    make().scheduler.onApplicationBootstrap();
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it('noto`g`ri cron ifodasi servisni yiqitmaydi', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    process.env.ACTIVITY_LOG_PRUNE_CRON_ORDER_SERVICE = 'not a cron';
    try {
      expect(() => make().scheduler.onApplicationBootstrap()).not.toThrow();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      delete process.env.ACTIVITY_LOG_PRUNE_CRON_ORDER_SERVICE;
    }
  });
});
