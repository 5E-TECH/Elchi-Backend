import { DataSource } from 'typeorm';
import {
  businessDayKey,
  businessDayKeySql,
  planBusinessDayChange,
  type BusinessDayRule,
} from './business-day';

/**
 * xhiXv3w3 — `businessDayKeySql` HAQIQIY Postgres'da JS `businessDayKey` bilan
 * bir xil sana beradimi (o'tish kunlari, NULL, sukut). Env berilmasa skip:
 * `BUSINESS_DAY_PG_TEST_URI=postgres://…`.
 */
const pgUri = process.env.BUSINESS_DAY_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const tk = (local: string) => new Date(`${local.replace(' ', 'T')}:00+05:00`);

describePg('xhiXv3w3 — ish kuni SQL ifodasi (Postgres)', () => {
  let db: DataSource;

  beforeAll(async () => {
    db = new DataSource({ type: 'postgres', url: pgUri });
    await db.initialize();
  });

  afterAll(async () => {
    await db?.destroy();
  });

  const instants: Date[] = [];
  for (
    let t = tk('2026-11-20 00:00').getTime();
    t < tk('2026-12-06 00:00').getTime();
    t += 23 * 60_000
  ) {
    instants.push(new Date(t));
  }

  const check = async (rules: BusinessDayRule[]) => {
    const rows: Array<{ at: Date; day: string | null }> = await db.query(
      `SELECT x.at, ${businessDayKeySql('x.at', rules)} AS day
         FROM unnest($1::timestamptz[]) AS x(at)`,
      [instants.map((at) => at.toISOString())],
    );
    const mismatches = rows.filter(
      (row) => row.day !== businessDayKey(new Date(row.at), rules),
    );
    expect(
      mismatches.map((row) => [new Date(row.at).toISOString(), row.day]),
    ).toEqual([]);
    expect(rows).toHaveLength(instants.length);
  };

  it("sukut (qoida yo'q)", () => check([]));

  it('doimiy 05:00 va 18:00', async () => {
    await check([{ from: '2026-01-01', time: '05:00' }]);
    await check([{ from: '2026-01-01', time: '18:00' }]);
  });

  it("o'tishlar: 00:00 → 05:00 → 18:00 → 00:00 → 12:00", async () => {
    let rules: BusinessDayRule[] = [];
    for (const [now, time] of [
      ['2026-11-22 14:00', '05:00'],
      ['2026-11-25 20:00', '18:00'],
      ['2026-11-28 03:00', '00:00'],
      ['2026-12-01 09:00', '12:00'],
    ] as const) {
      rules = planBusinessDayChange(rules, time, tk(now)).schedule;
    }
    expect(rules.length).toBeGreaterThanOrEqual(3);
    await check(rules);
  });

  it('NULL → NULL', async () => {
    const rows: Array<{ day: string | null }> = await db.query(
      `SELECT ${businessDayKeySql('x.at', [
        { from: '2026-11-27', time: '05:00' },
      ])} AS day FROM (SELECT NULL::timestamptz AS at) x`,
    );
    expect(rows[0].day).toBeNull();
  });
});
