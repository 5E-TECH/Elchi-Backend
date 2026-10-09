import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  ACTIVITY_LOG_DEVICE_METADATA_KEYS,
  ACTIVITY_LOG_DEVICE_RETENTION_DEFAULT_DAYS,
  ACTIVITY_LOG_DEVICE_RETENTION_ENV,
  ACTIVITY_LOG_DEVICE_STRIP_BATCH_DEFAULT,
  ACTIVITY_LOG_PRUNE_BATCH_DEFAULT,
  buildActivityLogPruneCountSql,
  buildActivityLogPruneSql,
  buildDeviceMetadataCountSql,
  buildDeviceMetadataStripSql,
  pruneActivityLogsBatched,
  quoteActivityLogTable,
  resolveDeviceRetentionDays,
  resolveDeviceRetentionMs,
  stripDeviceMetadataBatched,
} from './retention';

/**
 * f2Ud5tju DIQQAT — IP/qurilma maydonlari uchun QISQAROQ saqlash muddati.
 * SQL semantikasi (haqiqiy Postgres'da) — `retention.pg.spec.ts`.
 */
const DAY = 86_400_000;
const TABLE = '"order_schema"."activity_logs"';
const KEYS_SQL =
  "ARRAY['ip', 'user_agent', 'device_id', 'device_name']::text[]";

describe('activity-log retention — kalitlar (f2Ud5tju)', () => {
  it('FAQAT 4 ta kalit: ip, user_agent, device_id, device_name', () => {
    expect([...ACTIVITY_LOG_DEVICE_METADATA_KEYS]).toEqual([
      'ip',
      'user_agent',
      'device_id',
      'device_name',
    ]);
  });
});

describe('activity-log retention — env muddati (f2Ud5tju)', () => {
  const saved = process.env[ACTIVITY_LOG_DEVICE_RETENTION_ENV];
  afterEach(() => {
    if (saved === undefined)
      delete process.env[ACTIVITY_LOG_DEVICE_RETENTION_ENV];
    else process.env[ACTIVITY_LOG_DEVICE_RETENTION_ENV] = saved;
  });

  it('env kaliti nomi va sukut — 30 kun', () => {
    expect(ACTIVITY_LOG_DEVICE_RETENTION_ENV).toBe(
      'ACTIVITY_LOG_DEVICE_RETENTION_DAYS',
    );
    expect(ACTIVITY_LOG_DEVICE_RETENTION_DEFAULT_DAYS).toBe(30);
    delete process.env[ACTIVITY_LOG_DEVICE_RETENTION_ENV];
    expect(resolveDeviceRetentionDays(90)).toBe(30);
    expect(resolveDeviceRetentionMs(90 * DAY)).toBe(30 * DAY);
  });

  it('env qiymati process.env dan o`qiladi', () => {
    process.env[ACTIVITY_LOG_DEVICE_RETENTION_ENV] = '14';
    expect(resolveDeviceRetentionDays(90)).toBe(14);
    expect(resolveDeviceRetentionMs(90 * DAY)).toBe(14 * DAY);
  });

  it('umumiy muddatdan katta bo`lsa — umumiy muddat ustun', () => {
    expect(resolveDeviceRetentionDays(90, '120')).toBe(90);
    expect(resolveDeviceRetentionMs(90 * DAY, '120')).toBe(90 * DAY);
    // sukut (30) ham umumiydan katta bo'lishi mumkin
    expect(resolveDeviceRetentionDays(7, undefined)).toBe(7);
    expect(resolveDeviceRetentionMs(7 * DAY, undefined)).toBe(7 * DAY);
  });

  it('noto`g`ri qiymat (bo`sh, 0, manfiy, kasr, matn) — sukut', () => {
    for (const raw of ['', '  ', '0', '-5', '1.5', 'abc', '30d']) {
      expect(resolveDeviceRetentionDays(365, raw)).toBe(30);
      expect(resolveDeviceRetentionMs(365 * DAY, raw)).toBe(30 * DAY);
    }
  });

  it('umumiy muddat noaniq bo`lsa — faqat qurilma muddati', () => {
    expect(resolveDeviceRetentionDays(Number.NaN, '45')).toBe(45);
    expect(resolveDeviceRetentionMs(0, '45')).toBe(45 * DAY);
  });
});

describe('activity-log retention — SQL (f2Ud5tju)', () => {
  it('jadval nomi qo`shtirnoqda, ichki qo`shtirnoq qochiriladi', () => {
    expect(quoteActivityLogTable('order_schema')).toBe(TABLE);
    expect(quoteActivityLogTable(undefined)).toBe('"activity_logs"');
    expect(quoteActivityLogTable('we"ird', 'activity_logs')).toBe(
      '"we""ird"."activity_logs"',
    );
  });

  it('FAQAT eski qatorlar, FAQAT 4 kalit, partiya + keyset', () => {
    const sql = buildDeviceMetadataStripSql(TABLE, 1000);
    // eski qatorlar: chegara $1
    expect(sql).toContain('s.created_at < $1');
    // keyset: oldingi partiyadan davom, PK tartibida, LIMIT bilan
    expect(sql).toContain('s.id > $2');
    expect(sql).toContain('ORDER BY s.id');
    expect(sql).toContain('LIMIT 1000');
    // faqat shu kalitlardan biri bor obyekt qatorlar
    expect(sql).toContain("jsonb_typeof(s.metadata) = 'object'");
    expect(sql).toContain(`s.metadata ?| ${KEYS_SQL}`);
    // faqat shu 4 kalit olib tashlanadi — boshqa ustun/kalitga SET yo'q
    expect(sql).toContain(`SET metadata = t.metadata - ${KEYS_SQL}`);
    expect(sql.match(/\bSET\b/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).toContain(`UPDATE ${TABLE} AS t`);
  });

  it('noto`g`ri batch — sukut', () => {
    expect(buildDeviceMetadataStripSql(TABLE, 0)).toContain(
      `LIMIT ${ACTIVITY_LOG_DEVICE_STRIP_BATCH_DEFAULT}`,
    );
    expect(buildDeviceMetadataStripSql(TABLE, 2.5)).toContain(
      `LIMIT ${ACTIVITY_LOG_DEVICE_STRIP_BATCH_DEFAULT}`,
    );
  });

  it('dry-run hisobi ham faqat eski + kalitli qatorlarni sanaydi', () => {
    const sql = buildDeviceMetadataCountSql(TABLE);
    expect(sql).toContain('created_at < $1');
    expect(sql).toContain(`metadata ?| ${KEYS_SQL}`);
    expect(sql).not.toMatch(/\bUPDATE\b/);
  });
});

describe('stripDeviceMetadataBatched — partiyalab (f2Ud5tju)', () => {
  const cutoff = new Date('2026-09-09T00:00:00.000Z');

  it('partiya to`la bo`lsa keyingisi oxirgi id dan davom etadi', async () => {
    const results = [
      [{ stripped: 2, last_id: '17' }],
      [{ stripped: 2, last_id: '40' }],
      [{ stripped: 1, last_id: '41' }],
    ];
    const run = jest.fn(() => Promise.resolve(results.shift()));

    const total = await stripDeviceMetadataBatched(run, TABLE, cutoff, 2);

    expect(total).toBe(5);
    expect(run).toHaveBeenCalledTimes(3);
    const calls = run.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls.map((c) => c[1])).toEqual([
      [cutoff, '0'],
      [cutoff, '17'],
      [cutoff, '40'],
    ]);
    // har partiya — bitta cheklangan so'rov
    for (const [sql] of calls) expect(sql).toContain('LIMIT 2');
  });

  it('tozalanadigan qator bo`lmasa — bitta so`rov, 0', async () => {
    const run = jest.fn(() =>
      Promise.resolve([{ stripped: 0, last_id: null }]),
    );
    await expect(
      stripDeviceMetadataBatched(run, TABLE, cutoff, 100),
    ).resolves.toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('kutilmagan driver javobi — tsikl to`xtaydi (cheksiz aylanmaydi)', async () => {
    for (const weird of [undefined, [], [{}], [{ stripped: 'x' }], 'ok']) {
      const run = jest.fn(() => Promise.resolve(weird));
      await expect(
        stripDeviceMetadataBatched(run, TABLE, cutoff, 1),
      ).resolves.toBe(0);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
});

/**
 * f2Ud5tju topilmasi (prune-delete-count): `scripts/prune-activity-logs.ts`
 * DELETE natijasining `.length` ini o'chirilgan son deb olardi. TypeORM 0.3
 * `query()` esa yuqori darajadagi DELETE/UPDATE uchun `[rows, rowCount]`
 * qaytaradi — son har doim 2, `2 < batch` bo'lgani uchun tsikl birinchi
 * partiyadan keyin to'xtardi (har ishga tushishda har sxemadan ko'pi bilan
 * 10 000 qator, log'da "deleted 2"). Haqiqiy Postgres — `retention.pg.spec.ts`.
 */
describe('pruneActivityLogsBatched — umumiy muddat DELETE (f2Ud5tju, prune-delete-count)', () => {
  /** Postgres `command` tegi — YUQORI darajadagi buyruq (`WITH ... SELECT` → SELECT). */
  const topLevelCommand = (sql: string): string | undefined => {
    let depth = 0;
    let flat = '';
    for (const ch of sql) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0) flat += ch;
    }
    return /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.exec(flat)?.[1].toUpperCase();
  };

  /**
   * Jadvalda `oldRows` ta muddati o'tgan qator. So'rov HAQIQIY TypeORM
   * `PostgresQueryRunner.query()` orqali o'tadi (skript ishlatadigan
   * `ds.query()` bilan bir xil natija shakli — nusxa emas, TypeORM'ning o'zi);
   * faqat pg mijozi soxta: Postgres kabi `{ command, rows, rowCount }`.
   */
  const typeormTable = (oldRows: number) => {
    let remaining = oldRows;
    const client = {
      query: jest.fn<
        Promise<{ command?: string; rows: unknown[]; rowCount: number }>,
        [string, unknown[]]
      >((sql) => {
        const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? Infinity);
        const n = Math.min(limit, remaining);
        remaining -= n;
        const command = topLevelCommand(sql);
        if (command === 'DELETE') {
          const rows = Array.from({ length: n }, () => ({ '?column?': 1 }));
          return Promise.resolve({ command, rows, rowCount: n });
        }
        // WITH batch AS (...), deleted AS (DELETE ... RETURNING 1) SELECT COUNT(*)
        return Promise.resolve({
          command,
          rows: [{ deleted: n }],
          rowCount: 1,
        });
      }),
    };
    const ds = new DataSource({
      type: 'postgres',
      url: 'postgres://spec@127.0.0.1:1/spec',
    });
    const qr = ds.createQueryRunner();
    // tarmoq yo'q: `query()` ulanish o'rniga soxta pg mijozini oladi
    jest.spyOn(qr, 'connect').mockResolvedValue(client);
    const run = jest.fn((sql: string, params: unknown[]) =>
      qr.query(sql, params),
    );
    return { run, client, remaining: () => remaining };
  };

  it('ildiz sabab: eski top-level DELETE — TypeORM `[rows, rowCount]`, `.length` har doim 2', async () => {
    const db = typeormTable(25_000);
    // eski skriptdagi so'rov (cutoff interpolatsiya qilingan)
    const legacy = `DELETE FROM ${TABLE}
           WHERE id IN (
             SELECT id FROM ${TABLE}
             WHERE created_at < now() - interval '365 days'
             ORDER BY id
             LIMIT 10000
           )
           RETURNING 1`;

    const result = (await db.run(legacy, [])) as unknown[];

    expect(db.remaining()).toBe(15_000); // 10 000 qator o'chdi...
    expect(result).toHaveLength(2); // ...lekin "son" — 2 (`[rows, rowCount]`)
    expect(result[1]).toBe(10_000);
  });

  it('son to`g`ri va tsikl HAMMA partiyani tugatadi (25 000 / 10 000)', async () => {
    const db = typeormTable(25_000);

    const total = await pruneActivityLogsBatched(db.run, TABLE, 365, 10_000);

    expect(total).toBe(25_000); // eski kod: 2
    expect(db.remaining()).toBe(0); // eski kod: 15 000 qolardi
    expect(db.client.query).toHaveBeenCalledTimes(3); // 10 000 + 10 000 + 5 000
    for (const [sql, params] of db.client.query.mock.calls) {
      expect(topLevelCommand(sql)).toBe('SELECT');
      expect(sql).toContain('LIMIT 10000');
      expect(params).toEqual([365]);
    }
  });

  it('batch`ga karrali son — oxirgi bo`sh partiyada to`xtaydi', async () => {
    const db = typeormTable(20_000);
    await expect(
      pruneActivityLogsBatched(db.run, TABLE, 365, 10_000),
    ).resolves.toBe(20_000);
    expect(db.remaining()).toBe(0);
    expect(db.run).toHaveBeenCalledTimes(3); // 10 000 + 10 000 + 0
  });

  it('kichik batch (1, 2 — eski kod cheksiz aylanardi): har partiya to`liq sanaladi', async () => {
    for (const [batch, calls] of [
      [2, 4], // 2 + 2 + 2 + 1
      [1, 8], // 7 × 1 + 0
    ]) {
      const db = typeormTable(7);
      await expect(
        pruneActivityLogsBatched(db.run, TABLE, 30, batch),
      ).resolves.toBe(7);
      expect(db.remaining()).toBe(0);
      expect(db.run).toHaveBeenCalledTimes(calls);
    }
  });

  it('o`chiriladigan qator bo`lmasa — bitta so`rov, 0', async () => {
    const db = typeormTable(0);
    await expect(pruneActivityLogsBatched(db.run, TABLE, 365)).resolves.toBe(0);
    expect(db.run).toHaveBeenCalledTimes(1);
  });

  it('kutilmagan driver javobi — tsikl to`xtaydi (cheksiz aylanmaydi)', async () => {
    for (const weird of [
      undefined,
      [],
      [{}],
      [{ deleted: 'x' }],
      'ok',
      [[{ '?column?': 1 }], 1], // top-level DELETE shakli
    ]) {
      const run = jest.fn(() => Promise.resolve(weird as unknown));
      await expect(pruneActivityLogsBatched(run, TABLE, 365, 1)).resolves.toBe(
        0,
      );
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it('noto`g`ri muddat (0 = HAMMASI o`chardi) — so`rov yuborilmaydi', async () => {
    for (const days of [0, -1, 1.5, Number.NaN]) {
      const run = jest.fn(() => Promise.resolve([{ deleted: 0 }] as unknown));
      await expect(
        pruneActivityLogsBatched(run, TABLE, days),
      ).rejects.toBeInstanceOf(RangeError);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('SQL: natija — bitta SELECT qatori (driver shaklidan qat`i nazar aniq son)', () => {
    const sql = buildActivityLogPruneSql(TABLE, 1000);
    // yuqori darajadagi buyruq SELECT — TypeORM `[rows, rowCount]` qaytarmaydi
    expect(sql.trimStart()).toMatch(/^WITH\b/);
    expect(topLevelCommand(sql)).toBe('SELECT');
    expect(sql).toMatch(/SELECT COUNT\(\*\)::int AS deleted FROM \w+\s*$/);
    expect(sql).toContain(`DELETE FROM ${TABLE}`);
    // FAQAT eski qatorlar, partiyalab, PK tartibida
    expect(sql).toContain('created_at < now() - make_interval(days => $1)');
    expect(sql).toContain('ORDER BY s.id');
    expect(sql).toContain('LIMIT 1000');
    expect(sql.match(/\bDELETE\b/g)).toHaveLength(1);
  });

  it('noto`g`ri batch — sukut (10 000)', () => {
    expect(ACTIVITY_LOG_PRUNE_BATCH_DEFAULT).toBe(10_000);
    expect(buildActivityLogPruneSql(TABLE, 0)).toContain('LIMIT 10000');
    expect(buildActivityLogPruneSql(TABLE, 2.5)).toContain('LIMIT 10000');
  });

  it('dry-run hisobi DELETE bilan AYNI shartni sanaydi, hech narsa o`zgartirmaydi', () => {
    const count = buildActivityLogPruneCountSql(TABLE);
    expect(count).toContain(`FROM ${TABLE}`);
    expect(count).toContain('created_at < now() - make_interval(days => $1)');
    expect(count).not.toMatch(/\b(DELETE|UPDATE)\b/);
    expect(topLevelCommand(count)).toBe('SELECT');
  });

  it('skript DELETE ni o`zi yozmaydi — sinalgan helper orqali; dry-run va metadata strip joyida', () => {
    const src = readFileSync(
      join(__dirname, '../../../../scripts/prune-activity-logs.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // DELETE — faqat helper (muddat va partiya env'dan)
    expect(src).toMatch(
      /pruneActivityLogsBatched\(\s*run,\s*table,\s*retentionDays,\s*batchSize,?\s*\)/,
    );
    expect(src).not.toMatch(/\bDELETE\b/);
    expect(src).not.toMatch(/\bRETURNING\b/);
    expect(src).not.toMatch(/interval '/); // cutoff interpolatsiyasi yo'q
    // --dry-run: o'sha shart, o'sha muddat
    expect(src).toMatch(
      /buildActivityLogPruneCountSql\(table\),\s*\[retentionDays\]/,
    );
    // ip/qurilma strip (ACTIVITY_LOG_DEVICE_RETENTION_DAYS) — o'zgarmagan
    expect(src).toContain('ACTIVITY_LOG_DEVICE_RETENTION_ENV');
    expect(src).toMatch(
      /stripDeviceMetadataBatched\(\s*run,\s*table,\s*deviceCutoff,\s*batchSize,?\s*\)/,
    );
    expect(src).toMatch(
      /buildDeviceMetadataCountSql\(table\),\s*\[deviceCutoff\]/,
    );
  });
});
