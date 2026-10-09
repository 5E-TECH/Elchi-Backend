import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { numericTransformer } from '@app/common';

/**
 * znD3KaZL — FIFO hisob-kitobida BUTUN buyurtmaga sig'magan qoldiq
 * (`order.settlement.advance` javobidagi `leftover` > 0) jurnali.
 *
 * ⚠️ BU FAQAT KO'RSATKICH / AUDIT. Qoldiqning o'zi order-service'da
 * (`order_settlement_carry`) saqlanadi va keyingi to'lovga qo'shiladi; kassa
 * harakatlari bu jadvalga bog'liq emas. Har kassa to'lovi (`dedup_epoch` =
 * to'lov tokeni) uchun bo'g'in + tomon bo'yicha bitta qator: "kuryer
 * 550 000 topshirdi, daftar 300 000 ni yopdi, 250 000 qoldi" — endi
 * finance'da ham izi bor.
 *
 * Ikki yo'l bilan yoziladi, ikkalasi ham idempotent (`ON CONFLICT DO
 * NOTHING`, `(level, actor_id, dedup_epoch)` UNIQUE):
 *   • tezkor yo'l — finance advance javobini o'qiganda;
 *   • sekin yo'l — order-service FIFO tranzaksiyasi ichida outbox orqali
 *     yuborgan `finance.settlement.unapplied_recorded` hodisasi.
 *
 * `BaseEntity` ishlatilmaydi: jadval append-only (updatedAt / is_deleted
 * kerak emas) — ustunlar kartadagidek.
 */
@Entity({ name: 'finance_settlement_unapplied' })
@Index(
  'UQ_finance_settlement_unapplied_level_actor_epoch',
  ['level', 'actor_id', 'dedup_epoch'],
  { unique: true },
)
export class FinanceSettlementUnapplied {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /** Tomon: kuryer (courier_to_branch), filial (branch_to_hq) yoki market. */
  @Column({ type: 'bigint' })
  actor_id!: string;

  /** `courier_to_branch` | `branch_to_hq` | `hq_to_market`. */
  @Column({ type: 'varchar', length: 32 })
  level!: string;

  /** Javobdagi `leftover` — tomonning shu to'lovdan keyingi jami qoldig'i. */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: numericTransformer,
  })
  amount!: number;

  /** To'lov tokeni (advance `request_id`) — idempotentlik kaliti. */
  @Column({ type: 'varchar' })
  dedup_epoch!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;
}
