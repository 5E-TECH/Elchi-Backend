import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `orders.accepted_at` — the single date axis for dashboard cohort metrics.
 *
 * Audit 2026-08-15 (docs/audit/DASHBOARD_METRICS_AUDIT_2026-08-15.md, R-01/R-02):
 * the dashboard success rate reached 188% because its numerator and denominator
 * came from unrelated populations on unrelated date columns —
 * `acceptedCount` counted only `order_tracking.action = 'branch_batch_received'`
 * rows by `t.created_at`, while `soldAndPaid` counted every sold order by
 * `o.sold_at`. Neither was a subset of the other, so the ratio was unbounded.
 *
 * `accepted_at` stamps the moment the parcel entered the delivery network, on
 * the order row itself, once and never overwritten. Every cohort count
 * (accepted / delivered / cancelled) is then a FILTER over one query on one
 * axis, which makes `delivered <= accepted` a structural guarantee.
 *
 * Backfill: earliest tracking transition into an "accepted" status; orders that
 * currently sit in an accepted status but predate tracking fall back to
 * `createdAt`. Orders that never left created/new (or were cancelled straight
 * out of them) stay NULL — they never entered the network and must not inflate
 * the denominator.
 */
export class AddOrderAcceptedAt1716000000022 implements MigrationInterface {
  name = 'AddOrderAcceptedAt1716000000022';

  /**
   * Statuses only reachable once the parcel has been physically accepted.
   * `cancelled` / `cancelled (sent)` are deliberately absent: they are also
   * reachable straight from created/new, so they prove nothing on their own.
   */
  private static readonly ACCEPTED_STATUSES = [
    'received',
    'on the road',
    'waiting',
    'waiting_customer',
    'sold',
    'paid',
    'partly_paid',
    'returned_to_market',
    'closed',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const orders = '"order_schema"."orders"';
    const tracking = '"order_schema"."order_tracking"';
    const statusList = AddOrderAcceptedAt1716000000022.ACCEPTED_STATUSES.map(
      (status) => `'${status}'`,
    ).join(', ');

    await queryRunner.query(`
      ALTER TABLE ${orders}
      ADD COLUMN IF NOT EXISTS "accepted_at" TIMESTAMP WITH TIME ZONE NULL;
    `);

    // 1. Authoritative backfill — first transition into an accepted status.
    await queryRunner.query(`
      UPDATE ${orders} o
      SET "accepted_at" = first_accept.at
      FROM (
        SELECT t."order_id" AS order_id, MIN(t."created_at") AS at
        FROM ${tracking} t
        WHERE t."to_status"::text IN (${statusList})
        GROUP BY t."order_id"
      ) AS first_accept
      WHERE o."id" = first_accept.order_id
        AND o."accepted_at" IS NULL;
    `);

    // 2. Fallback for rows that predate order_tracking (and for EXTERNAL orders
    //    created straight into RECEIVED, which never write a tracking row):
    //    they are demonstrably accepted today, so use their creation time.
    await queryRunner.query(`
      UPDATE ${orders}
      SET "accepted_at" = "createdAt"
      WHERE "accepted_at" IS NULL
        AND "status"::text IN (${statusList});
    `);

    // Cohort scan: accepted_at range + is_deleted, matching getOverviewStats.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_ACCEPTED_AT"
      ON ${orders} ("accepted_at")
      WHERE "accepted_at" IS NOT NULL AND "is_deleted" = false;
    `);

    // The cohort query groups by COALESCE(parent_order_id, id) and filters on
    // status inside the same scan.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_ACCEPTED_AT_STATUS"
      ON ${orders} ("accepted_at", "status")
      WHERE "accepted_at" IS NOT NULL AND "is_deleted" = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."IDX_ORDERS_ACCEPTED_AT_STATUS";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."IDX_ORDERS_ACCEPTED_AT";`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_schema"."orders" DROP COLUMN IF EXISTS "accepted_at";`,
    );
  }
}
