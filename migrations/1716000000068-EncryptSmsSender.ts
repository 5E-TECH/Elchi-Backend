import { MigrationInterface, QueryRunner } from 'typeorm';
import { SmsCredentialCipher } from '../apps/notification-service/src/sms/sms-credential.cipher';

export class EncryptSmsSender1716000000068 implements MigrationInterface {
  name = 'EncryptSmsSender1716000000068';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification_schema"."sms_provider_accounts" ADD COLUMN "sender_enc" TEXT`,
    );
    const rows = (await queryRunner.query(
      `SELECT "id", "sender" FROM "notification_schema"."sms_provider_accounts"`,
    )) as { id: string; sender: string }[];
    const cipher = new SmsCredentialCipher(process.env.SMS_CREDENTIAL_SECRET);
    for (const row of rows) {
      await queryRunner.query(
        `UPDATE "notification_schema"."sms_provider_accounts" SET "sender_enc" = $1 WHERE "id" = $2`,
        [cipher.encrypt(row.sender), row.id],
      );
    }
    await queryRunner.query(
      `ALTER TABLE "notification_schema"."sms_provider_accounts" ALTER COLUMN "sender_enc" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_schema"."sms_provider_accounts" DROP COLUMN "sender"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification_schema"."sms_provider_accounts" ADD COLUMN "sender" VARCHAR(32)`,
    );
    const rows = (await queryRunner.query(
      `SELECT "id", "sender_enc" FROM "notification_schema"."sms_provider_accounts"`,
    )) as { id: string; sender_enc: string }[];
    const cipher = new SmsCredentialCipher(
      process.env.SMS_CREDENTIAL_SECRET,
      process.env.SMS_CREDENTIAL_SECRET_PREVIOUS,
    );
    for (const row of rows) {
      await queryRunner.query(
        `UPDATE "notification_schema"."sms_provider_accounts" SET "sender" = $1 WHERE "id" = $2`,
        [cipher.decrypt(row.sender_enc), row.id],
      );
    }
    await queryRunner.query(
      `ALTER TABLE "notification_schema"."sms_provider_accounts" ALTER COLUMN "sender" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_schema"."sms_provider_accounts" DROP COLUMN "sender_enc"`,
    );
  }
}
