import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

@Entity({ name: 'search_documents' })
@Index(['source', 'type', 'sourceId'], { unique: true })
@Index('IDX_SEARCH_DOC_TYPE', ['type'])
@Index('IDX_SEARCH_DOC_DELETED', ['isDeleted'])
export class SearchDocument extends BaseEntity {
  @Column({ type: 'varchar', length: 40 })
  source!: string;

  @Column({ type: 'varchar', length: 40 })
  type!: string;

  @Column({ type: 'varchar', length: 80 })
  sourceId!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  content!: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  tags!: string[];

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false })
  isDeleted!: boolean;
}
