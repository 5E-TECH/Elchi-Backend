import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '@app/common';
import { District } from './district.entity';

@Entity({ name: 'regions' })
@Index('IDX_REGION_SATO_CODE', ['sato_code'], { unique: true })
@Index('IDX_REGION_NAME', ['name'])
export class Region extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  /**
   * Rasmiy SOATO kodi. `null` — noma'lum (soxta kod yozilmaydi).
   * Postgres'da UNIQUE indeks bir nechta NULL'ga ruxsat beradi.
   */
  @Column({ type: 'varchar', unique: true, nullable: true })
  sato_code!: string | null;

  @OneToMany(() => District, (district) => district.region)
  districts!: District[];
}
