import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** Sessiya qanday ochilgan: parol, SMS kod yoki deploy'dan oldingi token. */
export type UserSessionMethod = 'password' | 'otp' | 'legacy';

/**
 * Sessiya yopilish sababi (`revoke_reason`):
 *  - `logout` — egasi shu qurilmadan chiqdi;
 *  - `security_reset` — parol/telefon/rol almashdi, akkaunt bloklandi yoki
 *    o'chirildi (`admins.session_epoch` oshdi yoki parol barmoq izi mos
 *    emas → HAMMA sessiyalar). Bu sabab qatorga soatlik tozalashda yoki
 *    token keyingi marta ko'rsatilganda yoziladi; tekshiruvning o'zi esa
 *    darhol amal qiladi (refresh va ro'yxat epoch/barmoq izini solishtiradi);
 *  - `revoked_by_owner` — egasi boshqa qurilmadan «Sessiyalar» bo'limida shu
 *    sessiyani (yoki «Boshqa sessiyalardan chiqish» bilan joriydan boshqa
 *    hammasini) yopdi.
 * Ustun `varchar(32)`, CHECK yo'q — yangi sabab migratsiyasiz qo'shiladi.
 */
export type UserSessionRevokeReason =
  | 'logout'
  | 'security_reset'
  | 'revoked_by_owner';

/**
 * "Sessionlar" bo'limi (Elchi Pochta #3) — har login uchun ALOHIDA sessiya.
 * Migratsiya 1716000000130.
 *
 * Ilgari `admins.refresh_token` da bitta hash turardi va har yangi login
 * boshqa qurilmalarni chiqarib yuborardi. Endi har login o'z qatorini oladi:
 * refresh shu qator bo'yicha tekshiriladi, logout faqat shu qatorni yopadi,
 * egasi esa «Sessiyalar» bo'limidan boshqa qurilmalarini chiqarib yubora oladi.
 *
 * - OCHIQ TOKEN SAQLANMAYDI — faqat refresh JWT'ning sha256 hashi (UNIQUE).
 * - `id` — UUID (ilovada yaratiladi): ketma-ket raqam tizimdagi umumiy login
 *   sonini oshkor qilardi. Access token'da `sid` claim'i shu id.
 * - `epoch` — sessiya ochilgandagi `admins.session_epoch`. Xavfsizlik
 *   hodisasi (parol/telefon/rol almashishi, bloklash, o'chirish) epoch'ni
 *   oshiradi va AYNI `users.save()` ichida (atomar) eski sessiyalarning
 *   hammasi yaroqsiz bo'ladi — alohida UPDATE kutilmaydi.
 * - Qurilma ma'lumoti login paytidagi so'rov kontekstidan
 *   (`requestContext.getAuditContext()` — gateway middleware'i: CF IP,
 *   User-Agent, X-Device-Id / X-Device-Name yoki UA'dan nom).
 */
@Entity({ name: 'user_sessions', schema: 'identity_schema' })
@Index('UQ_USER_SESSIONS_REFRESH_HASH', ['refresh_token_hash'], {
  unique: true,
})
@Index('IDX_USER_SESSIONS_USER_ACTIVE', ['user_id', 'last_seen_at'], {
  where: '"revoked_at" IS NULL',
})
@Index('IDX_USER_SESSIONS_EXPIRES', ['expires_at'])
export class UserSession {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'bigint' })
  user_id!: string;

  /** sha256(refresh JWT), hex — 64 belgi. */
  @Column({ type: 'varchar', length: 64 })
  refresh_token_hash!: string;

  @Column({ type: 'integer', default: 0 })
  epoch!: number;

  /**
   * Ochilgandagi parol hashining barmoq izi (`passwordFingerprint`). Joriy
   * parol bilan mos kelmasa sessiya yaroqsiz — parol qaysi yo'l bilan
   * almashganidan qat'i nazar.
   */
  @Column({ type: 'varchar', length: 32 })
  password_fp!: string;

  @Column({ type: 'varchar', length: 16, default: 'password' })
  method!: UserSessionMethod;

  /** Login vaqti (legacy sessiyada — eski refresh JWT'ning `iat` i). */
  @Column({ type: 'timestamptz' })
  created_at!: Date;

  /** Oxirgi muvaffaqiyatli refresh (yoki login) vaqti. */
  @Column({ type: 'timestamptz' })
  last_seen_at!: Date;

  /** Refresh JWT muddati (`exp`) — refresh rotatsiya qilinmaydi. */
  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at!: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  revoke_reason!: UserSessionRevokeReason | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  device_id!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  device_name!: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  user_agent!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip!: string | null;
}
