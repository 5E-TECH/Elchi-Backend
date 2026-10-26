import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/** Zv3MLn0a — karta / hisob turi (migratsiya 161, CHECK). */
export enum CashboxCardKind {
  VIRTUAL_CARD = 'virtual_card',
  PLASTIC_CARD = 'plastic_card',
  BANK_ACCOUNT = 'bank_account',
}

export const CASHBOX_CARD_KINDS: readonly string[] =
  Object.values(CashboxCardKind);

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
 * konvertatsiya, `card_id` bilan CLICK kirim/chiqim) KASSA qatori qulfi
 * ostida o'zgaradi.
 *
 * Zv3MLn0a — kartalar endi filial (BRANCH) kassalarida ham bor (invariant har
 * kassa uchun alohida: Σ(kassa kartalari) == shu kassaning `balance_card`).
 * Tafsilotlar: turi, bank, karta tizimi, FAQAT oxirgi 4 raqam (to'liq
 * PAN / hisob raqami saqlanmaydi), egasi, izoh, smena sozlamalari.
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

  /** Zv3MLn0a — NULL: eski karta (turi ko'rsatilmagan). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  kind!: CashboxCardKind | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  bank_name!: string | null;

  /** Uzcard / Humo / Visa … (dizayndagi «Karta tizimi»). */
  @Column({ type: 'varchar', length: 30, nullable: true })
  card_network!: string | null;

  /** FAQAT oxirgi 4 raqam (CHECK `^[0-9]{4}$`). */
  @Column({ type: 'varchar', length: 4, nullable: true })
  last4!: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  holder_name!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  /** Smena yopishda qoldiq skrinshoti talab qilinadi (faqat superadmin). */
  @Column({ type: 'boolean', default: false })
  require_photo_on_shift_close!: boolean;

  /** Skrinshot AI bilan tekshiriladi — faqat rasm talab qilinganda (CHECK). */
  @Column({ type: 'boolean', default: false })
  ai_check_enabled!: boolean;
}
