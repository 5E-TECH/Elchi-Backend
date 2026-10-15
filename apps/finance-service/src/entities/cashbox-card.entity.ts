import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * 3PE0B03q (UZOQ MUDDAT) — asosiy (MAIN) kassa ichidagi NOMLI karta
 * (BeePost `cashbox_card` porti: Humo, Uzcard, Click hisobi va h.k.).
 *
 * INVARIANT: Σ(kartalar balansi) == MAIN kassaning `balance_card`.
 *
 * Elchi farqi — "Asosiy karta" (`is_default = true`) balansi SAQLANMAYDI,
 * HOSILA: `balance_card − Σ(nomli kartalar)`. Shunda kartasiz kelgan har
 * qanday karta harakati (sotuv oyog'i, CLICK to'lovi va h.k.) avtomatik
 * "Asosiy karta" ga tushadi, invariant qurilishidan saqlanadi va mavjud
 * `balance_card` ni seed qilish (prod ma'lumotini o'zgartirish) kerak emas.
 * Asosiy kartaning manfiy hosila balansi = nomli kartalar `balance_card` dan
 * oshib ketgan (moslik buzilgan, `in_sync = false`).
 *
 * Nomli kartaning `balance` i faqat karta operatsiyalarida (o'tkazma,
 * konvertatsiya, `card_id` bilan CLICK kirim/chiqim) MAIN kassa qatori
 * qulfi ostida o'zgaradi.
 */
@Entity({ name: 'cashbox_cards' })
@Index('IDX_CASHBOX_CARD_CASHBOX', ['cashbox_id'])
export class CashboxCard extends BaseEntity {
  @Column({ type: 'bigint' })
  cashbox_id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  /** Nomli karta balansi. Asosiy kartada ishlatilmaydi (doim 0, hosila). */
  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  balance!: number;

  @Column({ type: 'boolean', default: false })
  is_default!: boolean;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'int', default: 0 })
  sort_order!: number;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;
}
