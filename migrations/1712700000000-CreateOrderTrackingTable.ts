import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrderTrackingTable1712700000000 implements MigrationInterface {
  name = 'CreateOrderTrackingTable1712700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."order_tracking" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "order_id" bigint NOT NULL,
        "from_status" "${schema}"."orders_status_enum",
        "to_status" "${schema}"."orders_status_enum" NOT NULL,
        "changed_by" character varying(64) NOT NULL,
        "changed_by_role" character varying(32) NOT NULL,
        "note" text,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_tracking_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_order_tracking_order_id" FOREIGN KEY ("order_id") REFERENCES "${schema}"."orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_tracking_order_id_created_at"
      ON "${schema}"."order_tracking" ("order_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';
    await queryRunner.query(`DROP INDEX IF EXISTS "${schema}"."IDX_order_tracking_order_id_created_at"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${schema}"."order_tracking"`);
  }
}
