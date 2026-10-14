import { Column, Entity } from 'typeorm';
import { BaseEntity } from '@app/common';
import type { AudienceTargetInput } from './audience-request';

/**
 * Nom bilan saqlangan auditoriya (ebSV5oyP #7) — migratsiya 1716000000086.
 * FAQAT shart saqlanadi (rollar / mijoz segmenti / aniq id'lar soni emas) —
 * telefon/ism ro'yxati YO'Q; son har safar `identity.audience.resolve`
 * orqali JONLI sanaladi (preview va yuborish bitta manbadan).
 */
@Entity({ name: 'notification_audience_segments' })
export class NotificationAudienceSegment extends BaseEntity {
  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb' })
  audience!: AudienceTargetInput;

  /** Saqlash paytidagi son (ma'lumot uchun; jonli son — preview). */
  @Column({ type: 'integer', nullable: true })
  last_total!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_counted_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;
}
