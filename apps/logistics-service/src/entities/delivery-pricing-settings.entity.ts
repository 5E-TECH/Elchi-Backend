import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * DAqXPeSy — narx formulasi sozlamalari
 * (`logistics_schema.delivery_pricing_settings`, migratsiya 1716000000142).
 * Ko'pi bilan BITTA faol qator (`UQ_delivery_pricing_settings_active`);
 * o'zgartirish — yangi qator, eskisi `is_active = false` (tarix qoladi).
 * Formulaning hech bir soni kodga qotirilmaydi — hammasi shu yerdan.
 */
@Entity({ name: 'delivery_pricing_settings' })
@Index('UQ_delivery_pricing_settings_active', ['is_active'], {
  unique: true,
  where: '"is_active" = true AND "is_deleted" = false',
})
export class DeliveryPricingSettings extends BaseEntity {
  /** Hajmli vazn = U × K × B (sm) / shu son. MH qarori — 5000. */
  @Column({ type: 'int' })
  volumetric_divisor!: number;

  /**
   * (AQ9lkgVB, migratsiya 1716000000154) Hajm shu kg dan (≥) boshlab
   * hisobga olinadi; hajmli vazn kichik bo'lsa — faqat haqiqiy og'irlik.
   * 0 — har doim (oldingi xulq).
   */
  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    default: 0,
    transformer: numericTransformer,
  })
  volumetric_from_kg!: number;

  /** Baza narxga kiradigan vazn, kg (1.0). */
  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    transformer: numericTransformer,
  })
  first_kg_included!: number;

  /** Eng kichik hisob vazni, kg (0.1). */
  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    transformer: numericTransformer,
  })
  min_billable_kg!: number;

  /** Hisob vazni shu qadam bilan YUQORIGA yaxlitlanadi, kg (0.1). */
  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    transformer: numericTransformer,
  })
  billable_step_kg!: number;

  /** Yakuniy narx shu songa karrali (500 so'm). */
  @Column({ type: 'int' })
  round_to!: number;

  /** Pickup tashrifi haqi, so'm — buyurtma narxiga QO'SHILMAYDI. */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: numericTransformer,
  })
  pickup_fee!: number;

  /** Bir tashrifda shuncha va undan ko'p posilka — pickup tekin. NULL — hech qachon. */
  @Column({ type: 'int', nullable: true })
  pickup_free_from_count!: number | null;

  /** Tezkor yetkazish ko'paytiruvchisi (1.4 → subtotal × 0.4 ustama). */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 3,
    transformer: numericTransformer,
  })
  express_multiplier!: number;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;
}
