import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Region } from './region.entity';

@Entity({ name: 'districts' })
@Index('IDX_DISTRICT_REGION', ['region_id'])
@Index('IDX_DISTRICT_SATO_CODE', ['sato_code'])
export class District extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  /**
   * Rasmiy SOATO kodi. `null` — NOMA'LUM.
   *
   * Nullable ATAYLAB: avval ustun NOT NULL edi va shu sabab seed soxta kod
   * (`REG-01-DIS-01`) yasashga majbur bo'lardi. Soxta kod haqiqiydek
   * ko'rinib, hamkor tizimlar bilan moslashni jimgina buzardi.
   */
  @Column({ type: 'varchar', nullable: true })
  sato_code!: string | null;

  @Column({ type: 'bigint' })
  region_id!: string;

  @Column({ type: 'bigint', nullable: true })
  assigned_region!: string | null;

  @ManyToOne(() => Region, (region) => region.districts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'region_id' })
  region!: Region;

  @ManyToOne(() => Region, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_region' })
  assignedToRegion!: Region | null;
}
