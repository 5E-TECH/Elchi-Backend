import type { QueryRunner } from 'typeorm';
import { PostOrderMemberships1716000000201 } from '../../../../migrations/1716000000201-PostOrderMemberships';

/**
 * Migratsiya 201 — SQL matni (DB'siz). Haqiqiy Postgres'dagi xulq
 * (trigger, seed, qayta yurgizish, down): `post-membership.pg.spec.ts`
 * (ORDER_POST_MEMBERSHIP_PG_TEST_URI bo'lsa).
 */
async function capture(direction: 'up' | 'down'): Promise<string[]> {
  const sql: string[] = [];
  const runner = {
    query: jest.fn((text: string) => {
      sql.push(text.replace(/\s+/g, ' ').trim());
      return Promise.resolve([]);
    }),
  } as unknown as QueryRunner;
  await new PostOrderMemberships1716000000201()[direction](runner);
  return sql;
}

describe('migratsiya 1716000000201 PostOrderMemberships', () => {
  it('nomi va vaqt tamg`asi', () => {
    expect(new PostOrderMemberships1716000000201().name).toBe(
      'PostOrderMemberships1716000000201',
    );
  });

  it('jadval shartnomasi: ustunlar, CHECK, post FK YO`Q', async () => {
    const [create] = await capture('up');
    expect(create).toContain(
      'CREATE TABLE IF NOT EXISTS "order_schema"."post_order_memberships"',
    );
    for (const column of [
      '"id" bigserial PRIMARY KEY',
      '"order_id" bigint NOT NULL',
      '"post_id" bigint NOT NULL',
      '"kind" varchar(16) NOT NULL',
      '"joined_at" timestamptz NOT NULL DEFAULT now()',
      '"left_at" timestamptz NULL',
      '"next_post_id" bigint NULL',
      '"source" varchar(32) NULL',
      '"created_at" timestamptz NOT NULL DEFAULT now()',
    ]) {
      expect(create).toContain(column);
    }
    expect(create).toContain(`CHECK ("kind" IN ('DELIVERY', 'CANCELED'))`);
    // FK — seed'dan KEYIN alohida (RI tekshiruvi har seed qatorida emas).
    expect(create).not.toContain('FOREIGN KEY');
    expect(create).not.toContain('logistics_schema');
  });

  it('order FK (CASCADE): seed`dan KEYIN, indekslardan OLDIN, pg_constraint qo`riqchisi bilan', async () => {
    const sql = await capture('up');
    const fkIndex = sql.findIndex((s) => s.includes('ADD CONSTRAINT'));
    const lastSeed = sql
      .map((s) => s.includes("'seed_current'"))
      .lastIndexOf(true);
    const firstIndex = sql.findIndex((s) => s.startsWith('CREATE INDEX'));
    expect(fkIndex).toBeGreaterThan(lastSeed);
    expect(firstIndex).toBeGreaterThan(fkIndex);
    expect(sql[fkIndex]).toBe(
      `DO $$ BEGIN IF NOT EXISTS ( SELECT 1 FROM pg_constraint WHERE conname = 'FK_POST_ORDER_MEMBERSHIP_ORDER' AND conrelid = '"order_schema"."post_order_memberships"'::regclass ) THEN ALTER TABLE "order_schema"."post_order_memberships" ADD CONSTRAINT "FK_POST_ORDER_MEMBERSHIP_ORDER" FOREIGN KEY ("order_id") REFERENCES "order_schema"."orders" ("id") ON DELETE CASCADE; END IF; END $$`,
    );
    expect(sql.join('\n')).not.toMatch(/FOREIGN KEY \("post_id"\)/);
  });

  it('trigger: AFTER INSERT OR UPDATE OF post_id, canceled_post_id; seed`dan OLDIN', async () => {
    const sql = await capture('up');
    const fnIndex = sql.findIndex((s) =>
      s.startsWith(
        'CREATE OR REPLACE FUNCTION "order_schema"."track_post_membership"()',
      ),
    );
    const trgIndex = sql.findIndex((s) => s.startsWith('CREATE TRIGGER'));
    const seedIndex = sql.findIndex((s) => s.includes("'seed_current'"));
    expect(fnIndex).toBeGreaterThan(0);
    expect(trgIndex).toBeGreaterThan(fnIndex);
    expect(seedIndex).toBeGreaterThan(trgIndex);
    expect(sql[trgIndex]).toBe(
      'CREATE TRIGGER "TRG_ORDERS_TRACK_POST_MEMBERSHIP" AFTER INSERT OR UPDATE OF "post_id", "canceled_post_id" ON "order_schema"."orders" FOR EACH ROW EXECUTE FUNCTION "order_schema"."track_post_membership"()',
    );
    expect(sql[trgIndex - 1]).toBe(
      'DROP TRIGGER IF EXISTS "TRG_ORDERS_TRACK_POST_MEMBERSHIP" ON "order_schema"."orders"',
    );
  });

  it.each([
    ['post_id', 'DELIVERY'],
    ['canceled_post_id', 'CANCELED'],
  ])('trigger funksiyasi: %s → %s (yopish + ochish)', async (column, kind) => {
    const sql = await capture('up');
    const fn = sql.find((s) =>
      s.includes('FUNCTION "order_schema"."track_post_membership"'),
    ) as string;
    expect(fn).toContain(`old_value := OLD."${column}";`);
    expect(fn).toContain(`IF NEW."${column}" IS DISTINCT FROM old_value THEN`);
    expect(fn).toContain(
      `SET "left_at" = changed_at, "next_post_id" = NEW."${column}" WHERE "order_id" = NEW."id" AND "kind" = '${kind}' AND "left_at" IS NULL;`,
    );
    expect(fn).toContain(
      `IF NEW."${column}" IS NOT NULL THEN INSERT INTO "order_schema"."post_order_memberships" ("order_id", "post_id", "kind", "joined_at", "source") VALUES (NEW."id", NEW."${column}", '${kind}', changed_at, 'trigger') ON CONFLICT DO NOTHING;`,
    );
    // INSERT'da OLD maydoniga murojaat qilinmaydi.
    expect(fn).toContain(
      `IF TG_OP = 'UPDATE' THEN old_value := OLD."${column}"; ELSE old_value := NULL; END IF;`,
    );
    expect(fn).toContain('RETURN NULL;');
  });

  it('trigger vaqti: clock_timestamp() — chaqiruvda bir marta; now() (tranzaksiya boshi) emas', async () => {
    const sql = await capture('up');
    const fn = sql.find((s) =>
      s.includes('FUNCTION "order_schema"."track_post_membership"'),
    ) as string;
    expect(fn).toContain(
      'DECLARE old_value bigint; changed_at timestamptz := clock_timestamp(); BEGIN',
    );
    expect(fn.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(fn).not.toContain('now()');
  });

  it.each([
    ['post_id', 'DELIVERY'],
    ['canceled_post_id', 'CANCELED'],
  ])(
    'seed: %s → %s, INSERT … SELECT … ON CONFLICT DO NOTHING',
    async (column, kind) => {
      const sql = await capture('up');
      expect(sql).toContain(
        `INSERT INTO "order_schema"."post_order_memberships" ("order_id", "post_id", "kind", "joined_at", "source") SELECT o."id", o."${column}", '${kind}', now(), 'seed_current' FROM "order_schema"."orders" o WHERE o."${column}" IS NOT NULL ON CONFLICT DO NOTHING`,
      );
    },
  );

  it('indekslar (CONCURRENTLY yo`q — bitta tranzaksiya)', async () => {
    const sql = await capture('up');
    expect(sql).toEqual(
      expect.arrayContaining([
        'CREATE INDEX IF NOT EXISTS "IDX_POST_ORDER_MEMBERSHIP_POST" ON "order_schema"."post_order_memberships" ("post_id", "kind", "joined_at")',
        'CREATE INDEX IF NOT EXISTS "IDX_POST_ORDER_MEMBERSHIP_ORDER" ON "order_schema"."post_order_memberships" ("order_id", "joined_at")',
        'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_POST_ORDER_MEMBERSHIP_OPEN" ON "order_schema"."post_order_memberships" ("order_id", "kind") WHERE "left_at" IS NULL',
      ]),
    );
    expect(sql.join('\n')).not.toMatch(/CONCURRENTLY/i);
  });

  it('down(): trigger → funksiya → jadval', async () => {
    expect(await capture('down')).toEqual([
      'DROP TRIGGER IF EXISTS "TRG_ORDERS_TRACK_POST_MEMBERSHIP" ON "order_schema"."orders"',
      'DROP FUNCTION IF EXISTS "order_schema"."track_post_membership"()',
      'DROP TABLE IF EXISTS "order_schema"."post_order_memberships"',
    ]);
  });
});
