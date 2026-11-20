import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Filial kassa hisoboti qayerga: guruhga (sukut) yoki menejerlarning shaxsiy chatiga. */
export type BranchReportTarget = 'group' | 'private';
export const BRANCH_REPORT_TARGETS: readonly BranchReportTarget[] = [
  'group',
  'private',
];

/**
 * (migratsiya 247) Filial bo'yicha Telegram sozlamasi. Qator yo'q — `group`.
 * Guruh ulanmagan bo'lsa ham `private` tanlash mumkin (menejer shaxsiy
 * chatiga yuboriladi).
 */
@Entity({ name: 'telegram_branch_settings' })
export class TelegramBranchSetting {
  @PrimaryColumn({ type: 'bigint' })
  branch_id!: string;

  @Column({ type: 'varchar', length: 8, default: 'group' })
  report_target!: BranchReportTarget;

  @Column({ type: 'bigint', nullable: true })
  updated_by!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at!: Date;
}
