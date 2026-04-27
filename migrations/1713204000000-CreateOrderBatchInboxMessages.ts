import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrderBatchInboxMessages1713204000000 implements MigrationInterface {
  name = 'CreateOrderBatchInboxMessages1713204000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."order_batch_inbox_messages" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "command" character varying(64) NOT NULL,
        "message_id" character varying(128) NOT NULL,
        CONSTRAINT "PK_order_batch_inbox_messages_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ORDER_BATCH_INBOX_MESSAGES_COMMAND_MESSAGE"
      ON "${schema}"."order_batch_inbox_messages" ("command", "message_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."UQ_ORDER_BATCH_INBOX_MESSAGES_COMMAND_MESSAGE"
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "${schema}"."order_batch_inbox_messages"
    `);
  }
}
