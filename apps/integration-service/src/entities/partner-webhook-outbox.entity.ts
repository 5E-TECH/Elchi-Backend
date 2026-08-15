import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * C2.3 — Elchi → hamkor (marketplace) chiquvchi webhook outbox'i.
 *
 * Elchi order statusi o'zgarganda (partner_shipment_ref bor bo'lsa) shu jadvalga
 * bitta qator yoziladi va scheduler uni hamkorning `webhook_url`'iga HMAC-imzoli
 * (`X-Elchi-Signature`) POST qiladi. Xatoda backoff (1m/5m/15m) bilan qayta
 * uriniladi; muvaffaqiyatda `completed` bo'lib qayta yuborilmaydi (dedup).
 *
 * Dedup: `(partner_id, order_id, new_status)` UNIQUE — bir status o'zgarishi bir
 * marta navbatga qo'yiladi (bir xil hodisa ikki marta emit qilinsa, ikkinchisi
 * unique cheklovga tushadi va tashlab yuboriladi).
 *
 * Ataylab ExternalIntegration `sync_queue`'dan AJRATILGAN — u ExternalIntegration
 * `integration_id`'ga (NOT NULL + FK) bog'langan; hamkor webhook'lari esa
 * `partner_id`'ga bog'lanadi. Kontrakt: docs/PARTNER_API.md §4.
 */
export type PartnerWebhookStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'permanently_failed';

@Entity({ name: 'partner_webhook_outbox' })
@Index('IDX_PWO_STATUS_RETRY', ['status', 'next_retry_at'])
@Index('IDX_PWO_DEDUP', ['partner_id', 'order_id', 'new_status'], {
  unique: true,
})
export class PartnerWebhookOutbox extends BaseEntity {
  /** Qaysi hamkorga yuboriladi (partners.id). */
  @Column({ type: 'bigint' })
  partner_id!: string;

  /** Elchi ichki buyurtma id (order.id) = hamkordagi shipment_id. */
  @Column({ type: 'bigint' })
  order_id!: string;

  /** Hamkor tomonidagi buyurtma id (idempotency/teskari qidiruv). */
  @Column({ type: 'varchar' })
  external_order_id!: string;

  /** Hodisa turi — hozircha `shipment.status_changed`. */
  @Column({ type: 'varchar' })
  event_type!: string;

  /** Elchi Order_status (sold | cancelled | ...) — dedup kaliti qismi. */
  @Column({ type: 'varchar', nullable: true })
  new_status!: string | null;

  /** Yuboriladigan JSON tanasi (imzo aynan shu ustidan hisoblanadi). */
  @Column({ type: 'jsonb' })
  payload!: Record<string, any>;

  @Column({ type: 'varchar', default: 'pending' })
  status!: PartnerWebhookStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', default: 4 })
  max_attempts!: number;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  last_response!: Record<string, any> | null;

  @Column({ type: 'timestamptz', nullable: true })
  next_retry_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  delivered_at!: Date | null;
}
