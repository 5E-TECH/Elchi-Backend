import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export const COURIER_PAYMENT_ACKS = ['confirmed', 'disputed'] as const;
export type CourierPaymentAckValue = (typeof COURIER_PAYMENT_ACKS)[number];

/**
 * (2crjWf7v #4) Kuryerning kvitansiyaga javobi ("👍 Tasdiqlayman" /
 * "❗️ Noto'g'ri"). FAQAT audit: hech qachon kassa harakati yaratmaydi.
 * Migratsiya 1716000000125.
 */
@Entity({ name: 'courier_payment_acks' })
@Index('UQ_COURIER_PAYMENT_ACK', ['payment_id', 'courier_id'], { unique: true })
export class CourierPaymentAck {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /** Kuryer kassasidagi `cashbox_history` qatori (COURIER_PAYMENT). */
  @Column({ type: 'bigint' })
  payment_id!: string;

  @Column({ type: 'bigint' })
  courier_id!: string;

  @Column({ type: 'varchar', length: 16 })
  ack!: CourierPaymentAckValue;

  @Column({ type: 'varchar', length: 500, nullable: true })
  comment!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
