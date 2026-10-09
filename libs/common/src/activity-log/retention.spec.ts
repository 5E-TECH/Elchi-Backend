import {
  ACTIVITY_LOG_DEVICE_METADATA_KEYS,
  ACTIVITY_LOG_DEVICE_RETENTION_DEFAULT_DAYS,
  ACTIVITY_LOG_DEVICE_RETENTION_ENV,
  ACTIVITY_LOG_DEVICE_STRIP_BATCH_DEFAULT,
  buildDeviceMetadataCountSql,
  buildDeviceMetadataStripSql,
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
