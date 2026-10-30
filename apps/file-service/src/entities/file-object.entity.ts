import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * (dgvwZasd B) Fayl egaligi reestri — MinIO obyekti kimniki.
 *
 * Qator faqat `file.upload` ga `owner` berilganda yoziladi (gateway JWT'dan,
 * smena hisoboti — tizim). `owner_id` matn: tizim fayllari uchun `system`
 * (bigint ustun bunday qiymatni olmaydi). Fayl o'chirilsa qator ham ketadi
 * (kalit noyob, qayta ishlatilmaydi) — shuning uchun BaseEntity/soft-delete
 * yo'q.
 *
 * Reestrda YO'Q kalit (shu o'zgarishdan oldingi fayllar) — eski qoida
 * bilan ishlaydi: `file-gateway.controller.ts` `assertCanAccessPrivateKey`.
 */
@Entity({ name: 'file_objects' })
@Index('IDX_FILE_OBJECTS_OWNER', ['owner_id'])
export class FileObject {
  @PrimaryColumn({ type: 'varchar', length: 1024 })
  key!: string;

  @Column({ type: 'varchar', length: 64 })
  folder!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  owner_id!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  owner_role!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  owner_branch_id!: string | null;

  @Column({ type: 'varchar', length: 128 })
  mime_type!: string;

  @Column({ type: 'integer' })
  size_bytes!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;
}
