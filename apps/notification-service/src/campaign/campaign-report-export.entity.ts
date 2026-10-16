import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Hisobot qaysi kampaniya jadvaliga tegishli. */
export type CampaignReportKind = 'notification' | 'sms';

export const CAMPAIGN_REPORT_KINDS: readonly CampaignReportKind[] =
  Object.freeze(['notification', 'sms']);

export type CampaignExportStatus = 'queued' | 'running' | 'done' | 'failed';

/**
 * (H7kpCman) Katta "Yetkazilmaganlar" CSV eksporti — fon vazifasi
 * (migratsiya 1716000000107). 10 000 qatordan katta eksport sinxron
 * bajarilmaydi: so'rov shu qatorni ochib 202 qaytaradi, outbox
 * (`notification.campaign.export.run`) fonda CSV yig'adi; superadmin holatni
 * so'rab, tayyor bo'lganda yuklab oladi (har yuklash — `export` jurnali).
 *
 * CSV'da telefon MASKALANGAN (`***7434`), IP/moliyaviy qiymat yo'q.
 * `expires_at` dan keyin yuklab bo'lmaydi va CSV matni tozalanadi.
 */
@Entity({ name: 'campaign_report_exports' })
@Index('IDX_CAMPAIGN_REPORT_EXPORT_CAMPAIGN', ['campaign_kind', 'campaign_id'])
export class CampaignReportExport {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 16 })
  campaign_kind!: CampaignReportKind;

  @Column({ type: 'bigint' })
  campaign_id!: string;

  @Column({ type: 'bigint', nullable: true })
  requested_by!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  requested_role!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status!: CampaignExportStatus;

  /** So'rov paytidagi yetkazilmaganlar soni; tayyor bo'lganda — CSV qatorlari. */
  @Column({ type: 'integer', default: 0 })
  row_count!: number;

  @Column({ type: 'text', nullable: true })
  csv!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  filename!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Index('IDX_CAMPAIGN_REPORT_EXPORT_CREATED')
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finished_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at!: Date | null;
}
