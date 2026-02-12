import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Region } from './region.entity';

@Entity({ name: 'districts' })
@Index('IDX_DISTRICT_REGION', ['region_id'])
@Index('IDX_DISTRICT_SATO_CODE', ['sato_code'])
export class District extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar' })
  sato_code!: string;

  @Column({ type: 'uuid' })
  region_id!: string;

  @Column({ type: 'uuid', nullable: true })
  assigned_region!: string | null;

  @ManyToOne(() => Region, (region) => region.districts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'region_id' })
  region!: Region;
}
