import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Group_type } from '@app/common';

@Entity({ name: 'telegram_markets' })
@Index('IDX_TG_MARKET_ID', ['market_id'])
@Index('IDX_TG_GROUP_TYPE', ['group_type'])
@Index('IDX_TG_MARKET_GROUP', ['market_id', 'group_type'])
export class TelegramMarket extends BaseEntity {
  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'varchar' })
  group_id!: string;

  @Column({ type: 'enum', enum: Group_type })
  group_type!: Group_type;

  @Column({ type: 'varchar', nullable: true })
  token!: string | null;
}
