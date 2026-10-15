import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { getMetadataArgsStorage } from 'typeorm';
import {
  ACTIVITY_LOG_ARCHIVE_SCHEMAS,
  CreateActivityLogsArchive1716000000101,
} from '../../../../migrations/1716000000101-CreateActivityLogsArchive';
import { ACTIVITY_LOG_DESCRIPTION_SCHEMAS } from '../../../../migrations/1716000000062-AddActivityLogDescription';
import { ActivityLogArchive } from './activity-log-archive.entity';
import { ActivityLog } from './activity-log.entity';
import { ActivityLogMaintenanceService } from './activity-log-maintenance.service';
import { ActivityLogModule } from './activity-log.module';
import { ActivityLogRetentionScheduler } from './activity-log-retention.scheduler';
import { ActivityLogService } from './activity-log.service';
import { ACTIVITY_LOG_DEVICE_METADATA_KEYS } from './retention';
import {
  ACTIVITY_LOG_ARCHIVE_COLUMNS,
  ACTIVITY_LOG_ARCHIVE_TABLE,
  buildPolicyArchiveSql,
  isActivityLogArchiveEnabled,
  pruneByRuleBatched,
  resolveActivityLogRetentionPolicy,
} from './retention-policy';

/**
 * i6Nyedea TC "Arxiv varianti tanlangan bo'lsa, o'chirilgan qatorlar
 * arxivda topiladi" — tanlangan variant: COLD JADVAL (`activity_logs_archive`
 * har audit sxemasida). O'chirish = KO'CHIRISH: bitta SQL buyrug'i
 * (DELETE ... RETURNING → INSERT INTO archive) — ikkalasi birga bajariladi
 * yoki birortasi ham bajarilmaydi. Haqiqiy Postgres — `archive.pg.spec.ts`.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const T = '"order_schema"."activity_logs"';
const A = '"order_schema"."activity_logs_archive"';

const columnsOf = (target: unknown): string[] =>
  getMetadataArgsStorage()
    .columns.filter((c) => c.target === target)
    .map((c) => c.propertyName);

describe('i6Nyedea arxiv — siyosat (env)', () => {
  it('⭐ arxiv SUKUT bo`yicha YOQIQ — faqat aniq `false` arxivsiz o`chirishga o`tkazadi', () => {
    expect(isActivityLogArchiveEnabled({})).toBe(true);
    expect(
      isActivityLogArchiveEnabled({ ACTIVITY_LOG_PRUNE_ARCHIVE: '' }),
    ).toBe(true);
    // Noma'lum qiymat — xavfsiz tomonga (arxiv).
    expect(
      isActivityLogArchiveEnabled({ ACTIVITY_LOG_PRUNE_ARCHIVE: 'nope' }),
    ).toBe(true);
    for (const v of ['false', 'FALSE', '0', 'no', 'off']) {
      expect(
        isActivityLogArchiveEnabled({ ACTIVITY_LOG_PRUNE_ARCHIVE: v }),
      ).toBe(false);
    }
  });
});

describe('i6Nyedea arxiv — SQL (ko`chirish)', () => {
  const [auth, rest] = resolveActivityLogRetentionPolicy({}).rules;

  it('⭐ bitta buyruq: DELETE ... RETURNING → INSERT INTO archive; ON CONFLICT YO`Q', () => {
    const sql = buildPolicyArchiveSql(T, A, auth, 500);
    expect(sql.trimStart()).toMatch(/^WITH\b/);
    expect(sql.match(/\bDELETE FROM\b/g)).toHaveLength(1);
    expect(sql).toContain(`DELETE FROM ${T}`);
    expect(sql).toMatch(/\bRETURNING\b/);
    expect(sql).toContain(`INSERT INTO ${A}`);
    // Konflikt (dublikat id) partiyani BEKOR qilsin — jim yutilmasin.
    expect(sql).not.toMatch(/ON CONFLICT/i);
    // DELETE bilan AYNI shart, partiya chegarasi.
    expect(sql).toContain('s.action = ANY($2::text[])');
    expect(sql).toContain('s.created_at < now() - make_interval(days => $1)');
    expect(sql).toContain('LIMIT 500');
    expect(buildPolicyArchiveSql(T, A, rest, 0)).toContain('LIMIT 10000');
    expect(buildPolicyArchiveSql(T, A, rest, 500)).toContain(
      's.action <> ALL($2::text[])',
    );
    // Qoida nomi — `$3` (archive_rule ustuni).
    expect(sql).toContain('$3');
    // Natija: ham o'chirilgan, ham arxivlangan son.
    expect(sql).toMatch(/AS deleted/);
    expect(sql).toMatch(/AS archived/);
  });

  it('⭐ har ustun ko`chiriladi; arxivga IP/qurilma kalitlari TUSHMAYDI (f2Ud5tju)', () => {
    const sql = buildPolicyArchiveSql(T, A, auth, 500);
    for (const col of ACTIVITY_LOG_ARCHIVE_COLUMNS) {
      expect(sql).toContain(`"${col}"`);
    }
    for (const key of ACTIVITY_LOG_DEVICE_METADATA_KEYS) {
      expect(sql).toContain(`'${key}'`);
    }
    expect(sql).toMatch(/"metadata" - ARRAY\[/);
  });

  it('⭐ partiyalab ko`chiradi: params [kun, fe`llar, qoida]; jami o`chirilgan = arxivlangan', async () => {
    const results = [1000, 1000, 300];
    const run = jest.fn(() => {
      const n = results.shift() ?? 0;
      return Promise.resolve([{ deleted: n, archived: n }]);
    });
    const res = await pruneByRuleBatched(run, T, auth, {
      batchSize: 1000,
      pauseMs: 0,
      archiveTable: A,
    });
    expect(res).toEqual({ deleted: 2300, batches: 3, archived: 2300 });
    expect(run.mock.calls[0]).toEqual([
      expect.stringContaining(`INSERT INTO ${A}`),
      [90, auth.actions, 'auth'],
    ]);
  });

  it('o`chirilgan != arxivlangan bo`lsa — xato (monitoringga), keyingi partiya YO`Q', async () => {
    const run = jest.fn(() =>
      Promise.resolve([{ deleted: 1000, archived: 999 }]),
    );
    await expect(
      pruneByRuleBatched(run, T, auth, {
        batchSize: 1000,
        pauseMs: 0,
        archiveTable: A,
      }),
    ).rejects.toThrow(/arxiv/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('archiveTable berilmasa — eski DELETE yo`li AYNAN (orqaga moslik)', async () => {
    const run = jest.fn((sql: string, params: unknown[]) => {
      void params;
      return Promise.resolve(sql ? [{ deleted: 5 }] : []);
    });
    const res = await pruneByRuleBatched(run, T, auth, {
      batchSize: 1000,
      pauseMs: 0,
    });
    expect(res).toEqual({ deleted: 5, batches: 1 });
    expect(run.mock.calls[0][0]).not.toContain('INSERT INTO');
    expect(run.mock.calls[0][1]).toEqual([90, auth.actions]);
  });
});

describe('i6Nyedea arxiv — entity / ustunlar', () => {
  it('⭐ ACTIVITY_LOG_ARCHIVE_COLUMNS = ActivityLog entity ustunlari (yangi ustun unutilmasin)', () => {
    expect([...ACTIVITY_LOG_ARCHIVE_COLUMNS].sort()).toEqual(
      columnsOf(ActivityLog).sort(),
    );
  });

  it('ActivityLogArchive = ActivityLog ustunlari + archived_at + archive_rule', () => {
    expect(columnsOf(ActivityLogArchive).sort()).toEqual(
      [...columnsOf(ActivityLog), 'archived_at', 'archive_rule'].sort(),
    );
    const table = getMetadataArgsStorage().tables.find(
      (t) => t.target === ActivityLogArchive,
    );
    expect(table?.name).toBe(ACTIVITY_LOG_ARCHIVE_TABLE);
    // id — hot jadvaldagi ASL id (ketma-ketlik emas).
    const id = getMetadataArgsStorage().columns.find(
      (c) => c.target === ActivityLogArchive && c.propertyName === 'id',
    );
    expect(id?.mode).toBe('regular');
    expect(id?.options.primary).toBe(true);
  });

  it('ActivityLogModule.forService arxiv entity`sini ham ro`yxatdan o`tkazadi', () => {
    const mod = ActivityLogModule.forService('order-service');
    const typeorm = mod.imports?.[0] as { providers?: unknown[] };
    const text = JSON.stringify(
      (typeorm?.providers ?? []).map((p) => String((p as any)?.provide)),
    );
    expect(text).toContain('ActivityLogArchive');
  });
});

describe('i6Nyedea arxiv — migratsiya 1716000000101', () => {
  it('⭐ HAR audit sxemasi (062 ro`yxati = kod bilan tekshirilgan 10 sxema)', () => {
    expect([...ACTIVITY_LOG_ARCHIVE_SCHEMAS].sort()).toEqual(
      [...ACTIVITY_LOG_DESCRIPTION_SCHEMAS].sort(),
    );
  });

  const runner = (archiveRows = 0) => {
    const sql: string[] = [];
    return {
      sql,
      queryRunner: {
        query: jest.fn((q: string) => {
          sql.push(q);
          if (/COUNT\(\*\)/.test(q)) {
            return Promise.resolve([{ n: archiveRows }]);
          }
          return Promise.resolve([]);
        }),
      },
    };
  };

  it('up(): har sxemada (hot jadval bo`lsa) arxiv jadvali, PK=id, indekslar; mavjud ma`lumotga tegmaydi', async () => {
    const { sql, queryRunner } = runner();
    await new CreateActivityLogsArchive1716000000101().up(queryRunner as never);
    for (const schema of ACTIVITY_LOG_ARCHIVE_SCHEMAS) {
      const block = sql.find((q) =>
        q.includes(`"${schema}"."activity_logs_archive"`),
      );
      expect(block).toBeDefined();
      expect(block).toContain(`to_regclass('"${schema}"."activity_logs"')`);
      expect(block).toContain('CREATE TABLE IF NOT EXISTS');
      expect(block).toContain('PRIMARY KEY ("id")');
      expect(block).toContain(
        '"archived_at" TIMESTAMPTZ NOT NULL DEFAULT now()',
      );
      expect(block).toContain(`IDX_ACTIVITY_ARCHIVE_CREATED_${schema}`);
    }
    // Hot jadval qatorlari ko'chirilmaydi / o'zgartirilmaydi.
    expect(sql.join('\n')).not.toMatch(/\b(DELETE|UPDATE|INSERT)\b/);
  });

  it('⭐ down(): arxiv BO`SH bo`lsa jadval tushiriladi', async () => {
    const { sql, queryRunner } = runner(0);
    await new CreateActivityLogsArchive1716000000101().down(
      queryRunner as never,
    );
    for (const schema of ACTIVITY_LOG_ARCHIVE_SCHEMAS) {
      expect(
        sql.some((q) =>
          q.includes(
            `DROP TABLE IF EXISTS "${schema}"."activity_logs_archive"`,
          ),
        ),
      ).toBe(true);
    }
  });

  it('⭐ down(): arxivda qator bo`lsa RAD etadi (dalil jimgina yo`qolmasin)', async () => {
    const { sql, queryRunner } = runner(3);
    await expect(
      new CreateActivityLogsArchive1716000000101().down(queryRunner as never),
    ).rejects.toThrow(/arxiv/i);
    expect(sql.some((q) => /DROP TABLE/.test(q))).toBe(false);
  });
});

describe('i6Nyedea arxiv — ActivityLogMaintenanceService.pruneByPolicy', () => {
  const policy = resolveActivityLogRetentionPolicy({});

  function make(opts: { archiveExists: boolean; moved?: number }) {
    const calls: string[] = [];
    const repo = {
      metadata: { schema: 'order_schema', tableName: 'activity_logs' },
      query: jest.fn((sql: string, params: unknown[]) => {
        calls.push(sql);
        if (sql.includes('to_regclass')) {
          expect(params).toEqual([A]);
          return Promise.resolve([{ ok: opts.archiveExists }]);
        }
        if (sql.includes('INSERT INTO')) {
          const n = opts.moved ?? 0;
          return Promise.resolve([{ deleted: n, archived: n }]);
        }
        if (sql.includes('DELETE FROM')) {
          return Promise.resolve([{ deleted: opts.moved ?? 0 }]);
        }
        return Promise.resolve([{ count: 4 }]);
      }),
    };
    const svc = new ActivityLogMaintenanceService(
      repo as never,
      {} as never,
      'order-service',
    );
    return { svc, repo, calls };
  }

  it('⭐ arxiv yoqiq, jadval YO`Q — o`chirish RAD etiladi (hech qanday DELETE yuborilmaydi)', async () => {
    const { svc, calls } = make({ archiveExists: false });
    await expect(
      svc.pruneByPolicy({ dryRun: false, policy, pauseMs: 0 }),
    ).rejects.toThrow(/activity_logs_archive/);
    expect(calls.some((q) => q.includes('DELETE'))).toBe(false);
  });

  it('⭐ arxiv yoqiq, jadval bor — har qoida arxivga KO`CHIRILADI, hisobotda archived', async () => {
    const { svc, calls } = make({ archiveExists: true, moved: 7 });
    const report = await svc.pruneByPolicy({
      dryRun: false,
      policy,
      pauseMs: 0,
    });
    expect(report.archive).toEqual({
      enabled: true,
      table: A,
      ready: true,
    });
    expect(report.rules.map((r) => [r.name, r.count, r.archived])).toEqual([
      ['auth', 7, 7],
      ['default', 7, 7],
    ]);
    const writes = calls.filter((q) => q.includes('DELETE'));
    expect(writes).toHaveLength(2);
    expect(writes.every((q) => q.includes(`INSERT INTO ${A}`))).toBe(true);
  });

  it('arxiv o`chiq (ACTIVITY_LOG_PRUNE_ARCHIVE=false) — eski DELETE yo`li, jadval tekshirilmaydi', async () => {
    const { svc, calls } = make({ archiveExists: false, moved: 2 });
    const report = await svc.pruneByPolicy({
      dryRun: false,
      policy,
      pauseMs: 0,
      archive: false,
    });
    expect(report.archive.enabled).toBe(false);
    expect(calls.some((q) => q.includes('INSERT INTO'))).toBe(false);
    expect(calls.some((q) => q.includes('to_regclass'))).toBe(false);
    expect(report.rules.map((r) => r.count)).toEqual([2, 2]);
  });

  it('⭐ dry-run — hech narsa o`zgarmaydi, arxiv tayyorligi hisobotda (yoqishdan oldin tekshiruv)', async () => {
    const { svc, calls } = make({ archiveExists: false });
    const report = await svc.pruneByPolicy({ dryRun: true, policy });
    expect(report.archive).toEqual({ enabled: true, table: A, ready: false });
    expect(report.rules).toEqual([
      { name: 'auth', days: 90, count: 4, batches: 0 },
      { name: 'default', days: 1095, count: 4, batches: 0 },
    ]);
    expect(calls.some((q) => /\b(DELETE|INSERT|UPDATE)\b/.test(q))).toBe(false);
  });
});

describe('i6Nyedea arxiv — scheduler log`i', () => {
  afterEach(() => jest.restoreAllMocks());

  it('dry-run va arxiv jadvali yo`q — ogohlantirish (bayroq yoqilsa o`chirish to`xtaydi)', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const maintenance = {
      pruneByPolicy: jest.fn(() =>
        Promise.resolve({
          service: 'order-service',
          dryRun: true,
          rules: [{ name: 'auth', days: 90, count: 1, batches: 0 }],
          warnings: [],
          archive: { enabled: true, table: A, ready: false },
        }),
      ),
    };
    await new ActivityLogRetentionScheduler(
      maintenance as never,
      'order-service',
    ).run();
    expect(warn.mock.calls.map(([m]) => String(m)).join('\n')).toContain(
      'activity_logs_archive',
    );
  });

  it('ko`chirish natijasi tizim log`ida "arxivga ko`chirildi"', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    process.env.ACTIVITY_LOG_PRUNE_ENABLED = 'true';
    try {
      const maintenance = {
        pruneByPolicy: jest.fn(() =>
          Promise.resolve({
            service: 'order-service',
            dryRun: false,
            rules: [
              { name: 'auth', days: 90, count: 3, batches: 1, archived: 3 },
            ],
            warnings: [],
            archive: { enabled: true, table: A, ready: true },
          }),
        ),
      };
      await new ActivityLogRetentionScheduler(
        maintenance as never,
        'order-service',
      ).run();
      expect(log.mock.calls.map(([m]) => String(m)).join('\n')).toContain(
        "arxivga ko'chirildi: auth(90 kun)=3",
      );
    } finally {
      delete process.env.ACTIVITY_LOG_PRUNE_ENABLED;
    }
  });
});

describe('i6Nyedea arxiv — o`qish (ActivityLogService.query archive)', () => {
  function make() {
    const qb: Record<string, jest.Mock> = {};
    for (const m of ['andWhere', 'orderBy', 'addOrderBy', 'skip', 'take']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getManyAndCount = jest.fn(() => Promise.resolve([[{ id: '9' }], 1]));
    const hotRepo = {
      createQueryBuilder: jest.fn(() => qb),
      manager: { getRepository: jest.fn() },
    };
    const archiveRepo = { createQueryBuilder: jest.fn(() => qb) };
    hotRepo.manager.getRepository.mockReturnValue(archiveRepo);
    const service = new ActivityLogService(hotRepo as never, 'order-service');
    return { service, hotRepo, archiveRepo, qb };
  }

  it('⭐ archive=true — so`rov ARXIV jadvalidan, filtrlar o`sha', async () => {
    const { service, hotRepo, archiveRepo, qb } = make();
    const res = await service.query({
      archive: true,
      entity_type: 'Order',
      entity_id: '100',
    });
    expect(hotRepo.manager.getRepository).toHaveBeenCalledWith(
      ActivityLogArchive,
    );
    expect(archiveRepo.createQueryBuilder).toHaveBeenCalledWith('a');
    expect(hotRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(qb.andWhere).toHaveBeenCalledWith('a.entity_type = :et', {
      et: 'Order',
    });
    expect(res.items).toEqual([{ id: '9' }]);
  });

  it('archive berilmasa (yoki "false") — hot jadval, avvalgidek', async () => {
    for (const q of [{}, { archive: false }, { archive: 'false' as never }]) {
      const { service, hotRepo, archiveRepo } = make();
      await service.query(q);
      expect(hotRepo.createQueryBuilder).toHaveBeenCalledWith('a');
      expect(archiveRepo.createQueryBuilder).not.toHaveBeenCalled();
    }
  });
});

describe('i6Nyedea arxiv — sidecar skripti', () => {
  it('⭐ skript ham arxivga ko`chiradi; arxiv jadvali yo`q sxemada o`chirmaydi', () => {
    const src = readFileSync(
      join(ROOT, 'scripts', 'prune-activity-logs.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).toMatch(/isActivityLogArchiveEnabled\(\)/);
    expect(src).toMatch(
      /activityLogArchiveExists\(\s*run,\s*archiveTable\s*\)/,
    );
    expect(src).toMatch(
      /pruneByRuleBatched\(\s*run,\s*table,\s*rule,\s*\{\s*batchSize,\s*pauseMs,\s*archiveTable,?\s*\}/,
    );
    expect(src).not.toMatch(/\bDELETE\b/);
  });
});
