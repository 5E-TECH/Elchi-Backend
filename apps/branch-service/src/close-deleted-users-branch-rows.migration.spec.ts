import { QueryRunner } from 'typeorm';
import {
  CLOSE_DELETED_USERS_BRANCH_ROWS_SQL,
  CloseDeletedUsersBranchRows1716000000252,
} from '../../../migrations/1716000000252-CloseDeletedUsersBranchRows';

/**
 * (revMyIKg) Migratsiya 252 — o'chirilgan foydalanuvchilarning faol
 * branch_users qatorlarini yopish. SQL matni tekshiriladi (oddiy unit spec).
 * Haqiqiy Postgres'dagi xatti-harakat (qaysi qatorlar yopiladi / tegilmaydi,
 * qayta yurgizish) — `close-deleted-users-branch-rows.migration.pg.spec.ts`
 * (CI: warehouse-postgres-specs, BRANCH_PG_TEST_URI).
 */
const normalized = CLOSE_DELETED_USERS_BRANCH_ROWS_SQL.replace(/\s+/g, ' ');

describe('revMyIKg — migratsiya 252 (CloseDeletedUsersBranchRows)', () => {
  it('nomi — TypeORM konvensiyasi (klass nomi + vaqt belgisi)', () => {
    expect(new CloseDeletedUsersBranchRows1716000000252().name).toBe(
      'CloseDeletedUsersBranchRows1716000000252',
    );
  });

  it('up(): bitta so‘rov — eksport qilingan SQL aynan', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CloseDeletedUsersBranchRows1716000000252().up({
      query,
    } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(CLOSE_DELETED_USERS_BRANCH_ROWS_SQL);
  });

  it('faqat FAOL qator va faqat o‘chirilgan user: is_deleted + updatedAt', () => {
    expect(normalized).toContain(
      'UPDATE "branch_schema"."branch_users" bu SET "is_deleted" = true, "updatedAt" = now() WHERE bu."is_deleted" = false AND EXISTS ( SELECT 1 FROM "identity_schema"."admins" a WHERE a."id" = bu."user_id" AND a."is_deleted" = true )',
    );
    // Rol yoki user statusi bo'yicha filtr yo'q: hamma rol, faqat is_deleted.
    expect(normalized).not.toMatch(/"status"/);
    expect(normalized).not.toMatch(/"role"\s*(=|IN|<>)/i);
  });

  it('boshqa jadvalga yozmaydi (kassa, hisob-kitob, buyurtma, admins)', () => {
    expect(normalized.match(/\bUPDATE\b/g)).toHaveLength(1);
    expect(normalized).not.toMatch(/\b(INSERT|DELETE|TRUNCATE|ALTER|DROP)\b/i);
    expect(normalized).not.toMatch(
      /finance_schema|order_schema|logistics_schema/,
    );
  });

  it('jadval(lar) yo‘q muhitda o‘tkazib yuboriladi; yopilganlar NOTICE bilan loglanadi', () => {
    expect(normalized).toContain(
      `IF to_regclass('"branch_schema"."branch_users"') IS NULL OR to_regclass('"identity_schema"."admins"') IS NULL THEN RETURN; END IF;`,
    );
    expect(normalized).toContain(
      'RETURNING bu."id", bu."branch_id", bu."user_id", bu."role"',
    );
    expect(normalized).toContain(
      "RAISE NOTICE 'CloseDeletedUsersBranchRows: % ta branch_users qatori yopildi: %'",
    );
  });

  it('down(): hech narsa qilmaydi (o‘chirilgan xodim tiriltirilmaydi)', async () => {
    const query = jest.fn();
    // TypeORM down() ga QueryRunner beradi — u ishlatilmasligi kerak.
    const migration: { down: (runner: QueryRunner) => Promise<void> } =
      new CloseDeletedUsersBranchRows1716000000252();

    await migration.down({ query } as unknown as QueryRunner);

    expect(query).not.toHaveBeenCalled();
  });
});
