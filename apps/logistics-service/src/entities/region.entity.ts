import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '@app/common';
import { District } from './district.entity';

@Entity({ name: 'regions' })
@Index('IDX_REGION_SATO_CODE', ['sato_code'], { unique: true })
@Index('IDX_REGION_NAME', ['name'])
@Index('IDX_REGION_LOGIST', ['logist_id'])
export class Region extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  /**
   * Rasmiy SOATO kodi. `null` — noma'lum (soxta kod yozilmaydi).
   * Postgres'da UNIQUE indeks bir nechta NULL'ga ruxsat beradi.
   */
  @Column({ type: 'varchar', unique: true, nullable: true })
  sato_code!: string | null;

  /**
   * (dzyVftBx) Viloyatga biriktirilgan logist — `identity_schema.admins.id`
   * (role = 'logist'). `null` — logist biriktirilmagan.
   *
   * @ManyToOne(User) YO'Q: User entity identity-service'ga tegishli, sxemalar
   * alohida va DB'da FK yo'q (1716000000060 migratsiyasiga qarang). Logist
   * o'chirilganda SET NULL ni identity `deleteUser` → `logistics.region.
   * clear_logist` bajaradi.
   */
  @Column({ type: 'bigint', nullable: true })
  logist_id!: string | null;

  @OneToMany(() => District, (district) => district.region)
  districts!: District[];
}
