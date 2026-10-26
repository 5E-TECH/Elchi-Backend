import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NDmZMzCP (+ aidsxJ2H bilan AYNI bayroq) — `identity_schema.admins.must_change_password`.
 *
 * `true` — foydalanuvchi keyingi kirishda parolini almashtirishi kerak:
 *  - login paytida mavjud parol yangi siyosatga (min 8, xodim 10, oddiy
 *    parollar taqiqlangan) mos kelmasa identity uni `true` qiladi — login
 *    BARIBIR muvaffaqiyatli (mavjud foydalanuvchi chiqarib yuborilmaydi);
 *  - foydalanuvchi parolni O'ZI almashtirganda `false`.
 *
 * Sukut `false` — migratsiya hech kimni belgilamaydi (bcrypt xeshidan parol
 * uzunligini bilib bo'lmaydi; bayroq faqat keyingi muvaffaqiyatli kirishda
 * qo'yiladi). Qayta yurgizish xavfsiz (IF NOT EXISTS) — aidsxJ2H
 * migratsiyasi ham shu ustunni qo'shsa to'qnashmaydi.
 */
export class UserMustChangePassword1716000000163 implements MigrationInterface {
  name = 'UserMustChangePassword1716000000163';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" ADD COLUMN IF NOT EXISTS "must_change_password" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" DROP COLUMN IF EXISTS "must_change_password"`,
    );
  }
}
