import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * B824gOu5 (migratsiya 198) — kuryer chaqiruvi (pickup) tashrifi: kuryer
 * marketdan bir martada nechta posilka olib ketgani va shu tashrif uchun
 * olingan haq.
 *
 * Mustaqil yozuv: buyurtmaga ham, qabul partiyasiga ham bog'lanmaydi (haq
 * TASHRIFGA tegishli, posilkalarga bo'linmaydi). Tekin tashrif ham qator
 * (`fee = 0`, `is_free = true`) — «nechta tekin tashrif bo'ldi» savoliga javob.
 * `idempotency_key` UNIQUE — takroriy so'rov ikkinchi yozuv ochmaydi.
 *
 * `fifo_applied_at` / `fifo_transfer_id` — haq market to'lovining FIFO
 * hovuziga qo'shilganmi (`PickupFifoService` izohi). Bo'sh — hali qo'shilmagan:
 * market kassasi shu summaga buyurtmalar yig'indisidan kam turadi.
 */
@Entity({ name: 'pickup_visits' })
@Index('UQ_PICKUP_VISITS_IDEMPOTENCY', ['idempotency_key'], { unique: true })
@Index('IDX_PICKUP_VISITS_MARKET', ['market_id', 'occurred_at'])
@Index('IDX_PICKUP_VISITS_OCCURRED', ['occurred_at'])
@Index('IDX_PICKUP_VISITS_FIFO_OPEN', ['market_id'], {
  where: 'fifo_applied_at IS NULL AND fee > 0 AND is_deleted = false',
})
export class PickupVisit extends BaseEntity {
  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'bigint' })
  courier_id!: string;

  @Column({ type: 'int' })
  parcel_count!: number;

  /** Yozilgan paytdagi haq (sozlama keyin o'zgarsa ham shu qoladi). */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: numericTransformer,
  })
  fee!: number;

  @Column({ type: 'boolean', default: false })
  is_free!: boolean;

  @Column({ type: 'bigint' })
  created_by!: string;

  @Column({ type: 'timestamptz' })
  occurred_at!: Date;

  @Column({ type: 'varchar', length: 255 })
  idempotency_key!: string;

  /** Market kassasidagi `pickup_fee` qatori. */
  @Column({ type: 'bigint', nullable: true })
  cashbox_history_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  fifo_applied_at!: Date | null;

  /** Haqni FIFO'ga qo'shgan market to'lovining `transfer_id` si. */
  @Column({ type: 'uuid', nullable: true })
  fifo_transfer_id!: string | null;
}
