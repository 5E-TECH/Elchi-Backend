import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * FIFO hisob-kitobida TAQSIMLANMAY QOLGAN naqd — tomon (kuryer / filial /
 * market) va bo'g'in bo'yicha bitta qator.
 *
 * ⚠️ NEGA KERAK. FIFO faqat BUTUN buyurtmalarni yopadi: navbatdagi eng eski
 * buyurtma lump-sum qoldig'iga sig'masa to'xtaydi. Ilgari o'sha qoldiq shunchaki
 * tashlab yuborilardi — kassa pulni ko'chirgan, daftar esa uni hech bir
 * buyurtmaga yozmagan bo'lardi. Natijada (E2E 30-09):
 *   • filial 760 000 topshirdi, daftar 665 000 ni yopdi, 95 000 izsiz qoldi;
 *   • moliyaviy balans o'sha 95 000 ni ham asosiy kassada, ham "yo'ldagi pul"da
 *     sanab, holatni sun'iy oshirdi;
 *   • navbatdagi buyurtma abadiy qotib qoldi — keyingi to'lov o'sha yo'qolgan
 *     qoldiqni bilmasdi.
 *
 * Endi qoldiq shu yerda saqlanadi: keyingi to'lovda lump-sum'ga qo'shiladi,
 * yig'indilar (balans, menejer paneli) esa uni darhol ayiradi.
 *
 * `branch_id` faqat kuryer bo'g'ini uchun ma'noli: `NULL` — HQ kuryeri (naqd
 * to'g'ridan-to'g'ri HQ'ga yetgan, ya'ni zanjir qarzini kamaytiradi); filial
 * kuryerida esa naqd hali filialda, zanjir qarzi o'zgarmaydi.
 */
@Entity({ name: 'order_settlement_carry' })
@Index('UQ_order_settlement_carry_level_party', ['level', 'party_id'], {
  unique: true,
})
export class OrderSettlementCarry extends BaseEntity {
  @Column({ type: 'varchar', length: 32 })
  level!: string;

  @Column({ type: 'bigint' })
  party_id!: string;

  @Column({ type: 'bigint', nullable: true })
  branch_id!: string | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  amount!: number;
}
