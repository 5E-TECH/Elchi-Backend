import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * i6Nyedea — jurnal ARXIVI (cold jadval): saqlash muddati o'tgan
 * `activity_logs` qatorlari o'chirilishdan OLDIN shu yerga ko'chiriladi
 * (`buildPolicyArchiveSql` — bitta SQL buyrug'ida DELETE + INSERT). Har audit
 * sxemasida o'z jadvali (migratsiya 1716000000101), servis ulanishining
 * `DB_SCHEMA` si bo'yicha — hot jadval bilan AYNI sxema.
 *
 * - Ustunlar `ActivityLog` bilan AYNAN bir xil (spec solishtiradi) + ikki
 *   arxiv ustuni: `archived_at` (qachon ko'chirildi), `archive_rule` (qaysi
 *   saqlash qoidasi: `auth` / `default`).
 * - `id` — hot jadvaldagi ASL id (o'z ketma-ketligi yo'q): bir qator ikki
 *   marta arxivlansa PK xatosi partiyani bekor qiladi, qator yo'qolmaydi.
 * - `metadata` dan IP/qurilma kalitlari ko'chirishda olib tashlanadi
 *   (f2Ud5tju qisqa muddati arxivda ham amal qiladi).
 * - Arxiv faqat O'QILADI (`GET /activity-logs?archive=true`) — unga yozish
 *   faqat retention ko'chirishi orqali; arxivning o'z saqlash muddati YO'Q
 *   (ega qarori bilan keyin qo'shiladi).
 */
@Entity({ name: 'activity_logs_archive' })
@Index('IDX_ACTIVITY_ARCHIVE_ENTITY', [
  'entity_type',
  'entity_id',
  'created_at',
])
@Index('IDX_ACTIVITY_ARCHIVE_USER', ['user_id', 'created_at'])
@Index('IDX_ACTIVITY_ARCHIVE_CREATED', ['created_at'])
export class ActivityLogArchive {
  @PrimaryColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  entity_type!: string;

  @Column({ type: 'varchar', length: 100 })
  entity_id!: string;

  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ type: 'jsonb', nullable: true })
  old_value!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  new_value!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  user_id!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  user_name!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  user_role!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  service!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  trace_id!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Asl yozilgan vaqt (hot jadvaldan o'zgarmay ko'chadi). */
  @Column({ type: 'timestamptz' })
  created_at!: Date;

  /** Arxivga ko'chirilgan vaqt. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  archived_at!: Date;

  /** Saqlash qoidasi nomi (`auth` / `default`). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  archive_rule!: string | null;
}
