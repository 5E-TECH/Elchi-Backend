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

  @Column({ type: 'bigint' })
  shift_id!: string;

  @Column({ type: 'varchar', length: 20 })
  kind!: string;

  @Column({ type: 'varchar', length: 20 })
  slot!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
