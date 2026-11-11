import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * TASHQI YETKAZUVCHI (carrier) AKKAUNTI — Carrier API (`/carrier/*`) kaliti.
 *
 * Tashqi yetkazib beruvchi kompaniya Elchi'da BITTA KURIER sifatida ishlaydi:
 * bizning xodim buyurtmani shu kurierga biriktiradi, kompaniya posilka QR'ini
 * skanerlab `/carrier/*` orqali ma'lumot oladi va holatni yuboradi. Har so'rov
 * gateway'da `courier_user_id` nomidan (COURIER roli bilan) mavjud kurier
 * amallariga yo'naltiriladi — kassa, settlement va tracking oddiy kurierdagidek.
 *
 * ⚠️ PARTNER (`partners`) JADVALIDAN ATAYLAB ALOHIDA. Partner kaliti
 * buyurtma YARATADI (sun'iy SUPERADMIN requester bilan); carrier kaliti esa
 * faqat o'ziga biriktirilgan buyurtmalarni ko'radi. Bitta jadvalda bo'lsa,
 * carrier kaliti `/partner/*` ga ham o'tib ketish xavfi bo'lardi.
 *
 * Kalitning o'zi saqlanmaydi — faqat SHA-256 hash (parol kabi), yaratish va
 * rotatsiya javobida BIR MARTA ko'rsatiladi. Kontrakt: docs/public/CARRIER_API.md.
 */
@Entity({ name: 'carrier_accounts' })
@Index('IDX_CARRIER_API_KEY_HASH', ['api_key_hash'], { unique: true })
@Index('IDX_CARRIER_ACTIVE', ['is_active'])
export class CarrierAccount extends BaseEntity {
  /** Tashqi kompaniya nomi (admin panel va audit uchun). */
  @Column({ type: 'varchar' })
  name!: string;

  /**
   * Bog'langan kurier — `identity_schema.admins.id` (role = courier).
   *
   * O'chirilmagan qatorlar orasida UNIQUE (migratsiyadagi qisman indeks
   * `IDX_CARRIER_COURIER_USER`): bitta kurier akkaunti ikki kompaniya
   * orasida bo'linmasin — aks holda biri ikkinchisining buyurtmasi va
   * kassasini ko'rardi.
   */
  @Column({ type: 'bigint' })
  courier_user_id!: string;

  /** API kalitning hash'i (kalitning o'zi saqlanmaydi). */
  @Column({ type: 'varchar', unique: true })
  api_key_hash!: string;

  /** Ixtiyoriy IP allowlist (bo'sh/null = cheklovsiz). */
  @Column({ type: 'jsonb', nullable: true })
  ip_allowlist!: string[] | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;
}
