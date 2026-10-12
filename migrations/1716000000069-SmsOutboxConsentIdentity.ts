import { MigrationInterface, QueryRunner } from 'typeorm';

export class SmsOutboxConsentIdentity1716000000069 implements MigrationInterface {
  name = 'SmsOutboxConsentIdentity1716000000069';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification_schema"."sms_outbox" ADD COLUMN "customer_id" BIGINT`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification_schema"."sms_outbox" DROP COLUMN "customer_id"`,
    );
  }
}
