import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import type { SiteImportRepairRow } from './site-import-repair';
import { runSiteImportRepair } from './site-import-repair.runner';

/**
 * `scripts/repair-site-import.ts` HAQIQIY Postgres'da (vaqtinchalik sxemalar):
 *  - DRY-RUN hech narsa yozmaydi;
 *  - tuman, viloyat, pochta va mijoz kartasi to'g'rilanadi, sanoq qayta hisoblanadi;
 *  - jo'natilgan / kuryerdagi / sotilgan / begona / allaqachon to'g'ri
 *    buyurtmaga TEGILMAYDI; qayta yurgizish — 0.
 * Env (`ORDER_PG_TEST_URI`) bo'lmasa skip.
 */
const pgUri = process.env.ORDER_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('sayt importini tiklash (haqiqiy Postgres)', () => {
  const tag = randomUUID().replace(/-/g, '').slice(0, 10);
  const schemas = {
    order: `spec_sir_${tag}_o`,
    logistics: `spec_sir_${tag}_l`,
    identity: `spec_sir_${tag}_i`,
  };
  const O = `"${schemas.order}"`;
  const L = `"${schemas.logistics}"`;
  const I = `"${schemas.identity}"`;
  let db: DataSource;
  let runner: QueryRunner;

  const row = (
    order_id: string,
    external_id: string,
    sato: string,
    site = 'lidershop',
  ): SiteImportRepairRow => ({ order_id, site, external_id, sato });

  const run = (rows: SiteImportRepairRow[], apply: boolean) =>
    runSiteImportRepair(runner, rows, { apply }, schemas);

  const orders = () =>
    db.query<Array<Record<string, string | null>>>(
      `SELECT id::text, district_id::text, region_id::text, post_id::text
         FROM ${O}.orders ORDER BY id`,
    );

  beforeAll(async () => {
    db = new DataSource({ type: 'postgres', url: pgUri, extra: { max: 3 } });
    await db.initialize();
    runner = db.createQueryRunner();
    await runner.connect();
    for (const s of Object.values(schemas)) {
      await db.query(`CREATE SCHEMA "${s}"`);
    }
    await db.query(`
      CREATE TABLE ${L}.regions (id BIGINT PRIMARY KEY, name VARCHAR NOT NULL);
      CREATE TABLE ${L}.districts (
        id BIGINT PRIMARY KEY, name VARCHAR NOT NULL, sato_code VARCHAR,
        region_id BIGINT NOT NULL, assigned_region BIGINT, serving_branch_id BIGINT,
        is_deleted BOOLEAN NOT NULL DEFAULT false
      );
      CREATE TYPE ${L}.posts_status_enum AS ENUM ('new', 'sent', 'received');
      CREATE TABLE ${L}.posts (
        id BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        is_deleted BOOLEAN NOT NULL DEFAULT false,
        courier_id BIGINT NOT NULL, qr_code_token VARCHAR,
        region_id BIGINT REFERENCES ${L}.regions (id), branch_id BIGINT,
        status ${L}.posts_status_enum NOT NULL DEFAULT 'new',
        post_total_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
        order_quantity INT NOT NULL DEFAULT 0
      );
      CREATE TYPE ${I}.admins_role_enum AS ENUM ('customer', 'courier');
      CREATE TABLE ${I}.admins (
        id BIGINT PRIMARY KEY, role ${I}.admins_role_enum NOT NULL,
        district_id BIGINT, "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TYPE ${O}.orders_status_enum AS ENUM ('new', 'received', 'on the road', 'sold');
      CREATE TYPE ${O}.orders_source_enum AS ENUM ('internal', 'external');
      CREATE TYPE ${O}.orders_holder_enum AS ENUM ('HQ', 'BRANCH', 'COURIER');
      CREATE TABLE ${O}.orders (
        id BIGINT PRIMARY KEY, "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        is_deleted BOOLEAN NOT NULL DEFAULT false,
        source ${O}.orders_source_enum NOT NULL DEFAULT 'external',
        operator VARCHAR, external_id VARCHAR,
        status ${O}.orders_status_enum NOT NULL DEFAULT 'received',
        holder_type ${O}.orders_holder_enum NOT NULL DEFAULT 'HQ',
        courier_id BIGINT, current_batch_id BIGINT, branch_id BIGINT, customer_id BIGINT NOT NULL,
        district_id BIGINT, region_id BIGINT, post_id BIGINT,
        total_price NUMERIC(14, 2) NOT NULL DEFAULT 0
      );
      CREATE TABLE ${O}.activity_logs (
        id BIGSERIAL PRIMARY KEY, entity_type VARCHAR(64) NOT NULL,
        entity_id VARCHAR(100) NOT NULL, action VARCHAR(64) NOT NULL,
        old_value JSONB, new_value JSONB, user_id VARCHAR(100),
        user_name VARCHAR(200), user_role VARCHAR(32), service VARCHAR(32),
        metadata JSONB, description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  });

  beforeEach(async () => {
    await db.query(`
      TRUNCATE ${O}.orders, ${O}.activity_logs, ${I}.admins, ${L}.posts,
               ${L}.districts, ${L}.regions;
      INSERT INTO ${L}.regions VALUES (1, 'Toshkent shahri'), (3, 'Andijon'), (4, 'Buxoro'), (9, 'Navoiy');
      INSERT INTO ${L}.districts (id, name, sato_code, region_id, assigned_region) VALUES
        (1, 'Bektemir', '1726283', 1, 1), (30, 'Jalaquduq', '1703211', 3, 3),
        (44, 'Gijduvon', '1706215', 4, 9), (5, 'Olmazor', '1726280', 1, 1);
      INSERT INTO ${L}.posts (id, courier_id, region_id, branch_id, status, order_quantity, post_total_price) VALUES
        (1073, 0, 1, NULL, 'new', 5, 500), (1074, 0, 3, NULL, 'new', 0, 0),
        (900, 7, 1, NULL, 'sent', 1, 100);
      INSERT INTO ${I}.admins (id, role, district_id) VALUES
        (101, 'customer', 1), (102, 'customer', 77), (103, 'customer', 1), (104, 'customer', 1);
      INSERT INTO ${O}.orders (id, operator, external_id, customer_id, district_id, region_id, post_id, total_price) VALUES
        (1, 'external_lidershop', 'e1', 101, 1, 1703, 1073, 100),
        (2, 'external_lidershop', 'e2', 102, 1, 1706, 1073, 100),
        (3, 'external_lidershop', 'e3', 103, 1, 1726, 1073, 100);
    `);
  });

  afterAll(async () => {
    await runner?.release();
    for (const s of Object.values(schemas)) {
      await db?.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    }
    await db?.destroy();
  });

  const LIST = [
    row('1', 'e1', '1703211'),
    row('2', 'e2', '1706215'),
    row('3', 'e3', '1726280'),
  ];

  it('DRY-RUN — reja bor, hech narsa yozilmaydi', async () => {
    const before = await orders();
    const report = await run(LIST, false);
    expect(report.planned).toHaveLength(3);
    expect(await orders()).toEqual(before);
    expect(await db.query(`SELECT 1 FROM ${O}.activity_logs`)).toHaveLength(0);
    expect(await db.query(`SELECT 1 FROM ${L}.posts`)).toHaveLength(3);
  });

  it('⭐ yozish — tuman, viloyat, pochta, sanoq, mijoz kartasi, audit', async () => {
    const report = await run(LIST, true);
    expect(report.planned).toHaveLength(3);
    expect(report.skipped).toEqual([]);
    const [a, b, c] = await orders();
    expect(a).toMatchObject({
      district_id: '30',
      region_id: '3',
      post_id: '1074',
    });
    // Viloyat — xizmat viloyati (assigned_region), pochtasi yangi ochiladi.
    expect(b).toMatchObject({ district_id: '44', region_id: '9' });
    expect(['1073', '1074', '900']).not.toContain(b.post_id);
    // Haqiqatan Toshkentniki — o'z pochtasida qoladi, tumani to'g'rilanadi.
    expect(c).toMatchObject({
      district_id: '5',
      region_id: '1',
      post_id: '1073',
    });

    const posts = await db.query<Array<Record<string, string>>>(
      `SELECT id::text, region_id::text, order_quantity::text, post_total_price::text
         FROM ${L}.posts WHERE status = 'new' ORDER BY id`,
    );
    expect(posts.find((p) => p.id === '1073')).toMatchObject({
      order_quantity: '1',
      post_total_price: '100.00',
    });
    expect(posts.find((p) => p.region_id === '9')).toMatchObject({
      order_quantity: '1',
    });
    const customers = await db.query<Array<Record<string, string>>>(
      `SELECT id::text, district_id::text FROM ${I}.admins ORDER BY id`,
    );
    // 102 — kartasi boshqa tumanda edi, tegilmaydi.
    expect(customers.map((u) => u.district_id)).toEqual(['30', '77', '5', '1']);
    expect(report.customers).toBe(2);
    expect(
      await db.query(
        `SELECT 1 FROM ${O}.activity_logs WHERE metadata->>'run_id' = $1`,
        [report.run_id],
      ),
    ).toHaveLength(3);
  });

  it('⭐ qayta yurgizish — 0 ta', async () => {
    await run(LIST, true);
    const before = await orders();
    const again = await run(LIST, true);
    expect(again.planned).toHaveLength(0);
    expect(again.skipped).toHaveLength(3);
    expect(await orders()).toEqual(before);
  });

  it.each([
    [`UPDATE O.orders SET post_id = 900 WHERE id = 1`, "jo'natilgan"],
    [`UPDATE O.orders SET status = 'on the road' WHERE id = 1`, 'holati'],
    [`UPDATE O.orders SET holder_type = 'BRANCH' WHERE id = 1`, "HQ'da emas"],
    [`UPDATE O.orders SET courier_id = 5 WHERE id = 1`, 'kuryerda'],
    [`UPDATE O.orders SET current_batch_id = 5 WHERE id = 1`, 'paketida'],
    [`UPDATE O.orders SET is_deleted = true WHERE id = 1`, "o'chirilgan"],
    [`UPDATE O.orders SET external_id = 'x' WHERE id = 1`, 'mos emas'],
    [`UPDATE O.orders SET source = 'internal' WHERE id = 1`, 'mos emas'],
    [`UPDATE O.orders SET region_id = 1727 WHERE id = 1`, 'mos emas'],
    [`UPDATE O.orders SET region_id = 3 WHERE id = 1`, 'allaqachon'],
  ])('⭐ tegilmaydi: %s', async (sql, reason) => {
    await db.query(sql.replace('O.', `${O}.`));
    const before = (await orders())[0];
    const report = await run([LIST[0]], true);
    expect(report.planned).toHaveLength(0);
    expect(report.skipped[0].reason).toContain(reason);
    expect((await orders())[0]).toEqual(before);
  });

  /** 2026-11-25 04:04: 9 ta haqiqiy Toshkent buyurtmasi filialga jo'natilgan. */
  const sendOrder3 = (post: string) =>
    db.query(`
      INSERT INTO ${L}.posts (id, courier_id, region_id, branch_id, status) VALUES (1402, 0, 1, 41, 'sent'), (1403, 0, 4, 41, 'sent');
      UPDATE ${O}.orders SET post_id = ${post}, status = 'on the road', holder_type = 'BRANCH', branch_id = 41 WHERE id = 3;
    `);

  it("⭐ jo'natilgan, to'g'ri viloyatda — faqat tuman va viloyat; pochta, holat, egalik o'zgarmaydi", async () => {
    await sendOrder3('1402');
    const report = await run([LIST[2]], true);
    expect(report.planned).toHaveLength(1);
    expect(report.planned[0]).toMatchObject({
      in_place: true,
      old_post_id: '1402',
    });
    expect((await orders())[2]).toMatchObject({
      district_id: '5',
      region_id: '1',
      post_id: '1402',
    });
    const [row3] = await db.query<Array<Record<string, string>>>(
      `SELECT status::text, holder_type::text, branch_id::text FROM ${O}.orders WHERE id = 3`,
    );
    expect(row3).toEqual({
      status: 'on the road',
      holder_type: 'BRANCH',
      branch_id: '41',
    });
    const [post] = await db.query<Array<Record<string, string>>>(
      `SELECT order_quantity::text AS n FROM ${L}.posts WHERE id = 1402`,
    );
    expect(post.n).toBe('0');
  });

  it("⭐ jo'natilgan, BOSHQA viloyatga — tegilmaydi", async () => {
    await sendOrder3('1403');
    const report = await run([LIST[2]], true);
    expect(report.planned).toHaveLength(0);
    expect(report.skipped[0].reason).toContain('boshqa viloyat pochtasida');
    expect((await orders())[2].region_id).toBe('1726');
  });

  it("tumanga boshqa filial xizmat qilsa — jo'natilganiga tegilmaydi", async () => {
    await sendOrder3('1402');
    await db.query(
      `UPDATE ${L}.districts SET serving_branch_id = 9 WHERE id = 5`,
    );
    const report = await run([LIST[2]], true);
    expect(report.planned).toHaveLength(0);
    expect(report.skipped[0].reason).toContain('filial 9 xizmat qiladi');
  });

  it("⭐ ro'yxatda yo'q buzilgan buyurtma hisobotda chiqadi, tegilmaydi", async () => {
    const report = await run([LIST[0]], true);
    expect(report.unlisted.map((r) => r.order_id)).toEqual(['2', '3']);
    expect((await orders())[1].region_id).toBe('1706');
  });

  it("pochtasi o'chirilgan (yetim) buyurtma ham tuzatiladi", async () => {
    await db.query(`UPDATE ${O}.orders SET post_id = 5555 WHERE id = 1`);
    const report = await run([LIST[0]], true);
    expect(report.planned).toHaveLength(1);
    expect((await orders())[0].post_id).toBe('1074');
  });
});
