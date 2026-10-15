import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/** 3PE0B03q — kartalar orasidagi ICHKI harakat turi (BeePost bilan bir xil). */
export enum CardMovementType {
  /** Kartadan kartaga — `balance_card` o'zgarmaydi. */
  CARD_TO_CARD = 'card_to_card',
  /** Kartadan naqdga — `balance_card` −, `balance_cash` +. */
  CARD_TO_CASH = 'card_to_cash',
  /** Naqddan kartaga — `balance_cash` −, `balance_card` +. */
  CASH_TO_CARD = 'cash_to_card',
}

/**
 * 3PE0B03q — MAIN kassa kartalari orasidagi ichki o'tkazma / konvertatsiya
 * jurnali. Kirim ham, chiqim ham EMAS: kassaning umumiy `balance` i
 * o'zgarmaydi, `cashbox_history` ga yozilmaydi (kirim/chiqim yig'indilari,
 * P&L ga ta'sir yo'q). Smena yopishda naqd↔karta konvertatsiyasi kutilgan
 * qoldiqqa qo'shiladi (`closeShift`).
 *
 * `dedup_epoch` — gateway `Idempotency-Key` i: bir xil kalit bilan takroriy
 * so'rov ikkinchi harakat yozmaydi (unique indeks — migratsiya 105).
 */
@Entity({ name: 'cashbox_card_movements' })
@Index('IDX_CARD_MOVEMENT_CASHBOX_CREATED', ['cashbox_id', 'createdAt'])
export class CashboxCardMovement extends BaseEntity {
  @Column({ type: 'varchar', length: 16 })
  type!: CardMovementType;

  @Column({ type: 'bigint' })
  cashbox_id!: string;

  @Column({ type: 'bigint', nullable: true })
  from_card_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  to_card_id!: string | null;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    transformer: numericTransformer,
  })
  amount!: number;

  /** Harakatdan keyingi MANBA karta balansi (CARD_TO_*). */
  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  balance_after_from!: number | null;

  /** Harakatdan keyingi MAQSAD karta balansi (*_TO_CARD). */
  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  balance_after_to!: number | null;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  dedup_epoch!: string | null;
}
