import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * y8Tqm9Ap — jadval slotining BIR MARTALIK kaliti: `auto_close:<shift>:<slot>`
 * yoki `warn:<shift>:<slot>`. PRIMARY KEY — bir nechta finance replikasi bir
 * slotni faqat bir marta bajaradi (INSERT … ON CONFLICT DO NOTHING).
 */
@Entity({ name: 'shift_schedule_claims' })
export class ShiftScheduleClaim {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  key!: string;

  /**
   * Smena kaliti uchun — smena; kassa kaliti (`auto_open:<kassa>:<slot>`,
   * `late_open:<kassa>:<slot>`, migratsiya 216) uchun NULL yoki ochilgan smena.
   */
  @Column({ type: 'bigint', nullable: true })
  shift_id!: string | null;

  @Column({ type: 'varchar', length: 20 })
  kind!: string;

  @Column({ type: 'varchar', length: 20 })
  slot!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
