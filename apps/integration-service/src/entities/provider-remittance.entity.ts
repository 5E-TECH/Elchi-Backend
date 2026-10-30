import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/** DxdZFdIk — remittance holati (o'chirish yo'q, faqat bekor qilish). */
export enum RemittanceStatus {
  ACTIVE = 'active',
  CANCELLED = 'cancelled',
}

/**
 * A remittance: a payment the provider sent to Elchi to settle outstanding COD
 * receivables. Creating one settles a set of PENDING receivables (explicit
 * order ids, or FIFO up to `amount`) and records the audit trail of who/when.
 *
 * (N3yNa6rO) Remittance yaratilganda summa MAIN kassaga AVTOMATIK kirim
 * qilinadi (`finance.cashbox.fill`, `dedup_epoch =
 * provider-remittance:<id>` — idempotent). Natija javobda `cashbox_posted`;
 * `false` bo'lsa kassa yozuvi yiqilgan — qo'lda tekshirilsin (qo'lda kirim
 * qilish pulni IKKI marta yozadi, avval `cashbox_posted` ni ko'ring).
 */
@Entity({ name: 'provider_remittances' })
@Index('IDX_REMITTANCE_INTEGRATION', ['integration_id'])
export class ProviderRemittance extends BaseEntity {
  @Column({ type: 'bigint' })
  integration_id!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  amount!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  reference!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'int', default: 0 })
  settled_count!: number;

  /**
   * utIffRFx (migratsiya 080) — yopilgan qarz yig'indisi va sig'magan qoldiq
   * (`amount − settled_amount`). NULL — migratsiyadan oldingi yozuv.
   */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  settled_amount!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  unapplied_amount!: string | null;

  /**
   * utIffRFx 4-band (migratsiya 104) — qarz yopishda AVVALGI to'lovlardan
   * qolgan hamkor avansidan ishlatilgan qism (≥ 0). Yangi yozuvlarda
   * `unapplied_amount = amount + advance_applied − settled_amount` (musbat
   * qismi — hamkorning yangi avansi). NULL — migratsiyadan oldingi yozuv:
   * avans hisobiga KIRMAYDI.
   */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  advance_applied!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;

  /**
   * N3yNa6rO (migratsiya 196) — mijozning `Idempotency-Key` sarlavhasi. Bir
   * hamkorda takrorlanmaydi (qisman UNIQUE): ayni kalitli takror so'rov yangi
   * to'lov ochmaydi va pulni kassaga ikkinchi marta yozmaydi.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  idempotency_key!: string | null;

  /** DxdZFdIk (migratsiya 081) — 'active' | 'cancelled'. */
  @Column({ type: 'varchar', length: 16, default: RemittanceStatus.ACTIVE })
  status!: RemittanceStatus;

  @Column({ type: 'timestamptz', nullable: true })
  cancelled_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  cancelled_by!: string | null;

  @Column({ type: 'text', nullable: true })
  cancel_reason!: string | null;

  /**
   * DxdZFdIk — summa MAIN kassaga kirim bo'lib yozilganmi. NULL —
   * migratsiyadan oldingi yozuv (noma'lum).
   */
  @Column({ type: 'boolean', nullable: true })
  cashbox_posted!: boolean | null;
}
