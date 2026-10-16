import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

export type CampaignStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = Object.freeze([
  'draft',
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
]);

/** Yakuniy holatlar — keyingi partiya boshlanmaydi. */
export const CAMPAIGN_TERMINAL_STATUSES: readonly CampaignStatus[] =
  Object.freeze(['done', 'failed', 'cancelled']);

/** Saqlangan auditoriya sharti (tarixni qayta tiklash uchun — TC12). */
export interface CampaignAudience {
  roles?: string[];
  broadcast?: boolean;
  include_customers?: boolean;
  confirm_all_customers?: boolean;
  segment?: Record<string, unknown>;
  recipient_ids?: string[];
}

/**
 * Bildirishnoma kampaniyasi (xHPdpj0W) — migratsiya 1716000000076.
 *
 * Katta yuborish sinxron RPC EMAS: `create` darhol 202 qaytaradi, partiyalar
 * outbox orqali fonda (`notification.campaign.batch`). Har partiya bitta
 * tranzaksiyada: da'vo (`batch_no` shartli UPDATE) → inbox qatorlari →
 * `sent = sent + n` → keyingi partiya outbox'ga. Shu sabab qayta yetkazilgan
 * partiya ikki marta yozmaydi.
 *
 * `idempotency_key` UNIQUE — admin qayta bossa yangi kampaniya YARATILMAYDI.
 * Kim olmagani: har qabul qiluvchining inbox qatorida (`group_key =
 * campaign:<id>`, `delivery` JSONB); yozilmay qolgan partiyalar — `failed` +
 * `last_error`.
 */
@Entity({ name: 'notification_campaigns' })
@Index('IDX_NOTIF_CAMPAIGN_STATUS', ['status'])
@Index('IDX_NOTIF_CAMPAIGN_CREATED', ['createdAt'])
export class NotificationCampaign extends BaseEntity {
  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;

  @Column({ type: 'varchar', length: 120 })
  type!: string;

  @Column({ type: 'varchar', length: 32 })
  category!: string;

  @Column({ type: 'varchar', length: 16 })
  priority!: string;

  @Column({ type: 'jsonb' })
  channels!: string[];

  @Column({ type: 'jsonb' })
  audience!: CampaignAudience;

  /** Shablon kartasi uchun (hozircha yozilmaydi — matn `title`/`body`). */
  @Column({ type: 'varchar', length: 64, nullable: true })
  template_code!: string | null;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  data!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  link!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status!: CampaignStatus;

  /** Auditoriya hajmi (yaratishda, so'ng ishga tushishda qayta sanaladi). */
  @Column({ type: 'integer', default: 0 })
  total!: number;

  /** Inbox qatori yozilganlar (in_app — tizim yozuvi). */
  @Column({ type: 'integer', default: 0 })
  sent!: number;

  /** Qatori yozilmay qolganlar (partiya qayta-qayta yiqilgan). */
  @Column({ type: 'integer', default: 0 })
  failed!: number;

  /** Yakunda: total − sent − failed (oraliqda o'chirilgan/yo'qolganlar). */
  @Column({ type: 'integer', default: 0 })
  skipped!: number;

  @Column({ type: 'integer', default: 200 })
  batch_size!: number;

  /** Bajarilgan partiyalar soni = keyingi partiya raqami (da'vo kaliti). */
  @Column({ type: 'integer', default: 0 })
  batch_no!: number;

  /** Joriy partiyaning yiqilishlar soni. */
  @Column({ type: 'integer', default: 0 })
  batch_attempts!: number;

  /** Keyset kursor: oxirgi ishlangan qabul qiluvchi id'si. */
  @Column({ type: 'bigint', nullable: true })
  cursor_after_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  scheduled_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finished_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_batch_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelled_at!: Date | null;

  /**
   * (WIsb9Ytq) Reklama kampaniyasi tungi taqiq oynasiga tushdi — keyingi
   * partiya shu lahzaga (oyna tugashi, Toshkent 09:00) outbox `scheduledAt`
   * bilan surilgan. Tashlanmaydi; partiya ketishi bilan NULL. Migratsiya
   * 1716000000106.
   */
  @Column({ type: 'timestamptz', nullable: true })
  paused_until!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  cancelled_by!: string | null;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  @Index('UQ_NOTIF_CAMPAIGN_IDEMPOTENCY', { unique: true })
  @Column({ type: 'varchar', length: 128 })
  idempotency_key!: string;

  /** So'rov barmoq izi: bir xil kalit + boshqa mazmun → 409. */
  @Column({ type: 'varchar', length: 64 })
  request_hash!: string;
}
