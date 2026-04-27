import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

@Entity({ name: 'order_batch_inbox_messages' })
@Index('UQ_ORDER_BATCH_INBOX_MESSAGES_COMMAND_MESSAGE', ['command', 'message_id'], {
  unique: true,
})
export class OrderBatchInboxMessage extends BaseEntity {
  @Column({ type: 'varchar', length: 64 })
  command!: string;

  @Column({ type: 'varchar', length: 128 })
  message_id!: string;
}
