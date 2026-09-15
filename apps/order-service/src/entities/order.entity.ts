import {
  Column,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';
import { Order_status, Where_deliver } from '@app/common';
import { OrderItem } from './order-item.entity';
import { OrderTracking } from './order-tracking.entity';
import { Branch } from './branch.entity';
import { OrderCustodyEvent } from './order-custody-event.entity';

export enum Order_source {
  INTERNAL = 'internal',
  EXTERNAL = 'external',
  BRANCH = 'branch',
}

export enum OrderHolderType {
  HQ = 'HQ',
  BRANCH = 'BRANCH',
  COURIER = 'COURIER',
  // Terminal custody state: the parcel was handed back to the market (returned /
  // cancelled-and-returned). Closes the custody chain so a returned parcel is no
  // longer attributed to a courier/branch. (Audit I10.)
  MARKET = 'MARKET',
}

@Entity({ name: 'orders' })
@Index('IDX_ORDER_DELETED_AT', ['deleted_at'], {
  where: 'deleted_at IS NOT NULL',
})
/**
 * Tashqi buyurtma dublikat tekshiruvi (`receiveExternalOrders`) shu ikki
 * ustun bo'yicha izlaydi. Indekssiz har kelgan yozuv uchun `orders` jadvali
 * TO'LIQ skanerlanardi (audit EI-11).
 *
 * UNIQUE EMAS: `external_id` NULL bo'lishi mumkin va mavjud ma'lumotda
 * dublikat bo'lsa migratsiya deploy'ni yiqitardi. Himoya kodda qoladi,
 * indeks uni tez qiladi.
 */
@Index('IDX_ORDER_EXTERNAL_LOOKUP', ['external_id', 'operator'], {
  where: '"external_id" IS NOT NULL',
})
export class Order extends BaseEntity {
  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'bigint' })
  customer_id!: string;

  @Column({ type: 'int', default: 0 })
  product_quantity!: number;

  @Column({ type: 'enum', enum: Where_deliver, default: Where_deliver.CENTER })
  where_deliver!: Where_deliver;

  // Money is stored as numeric(14,2) (exact fixed-point) to match
  // order_settlement and keep SUM()/financial aggregations drift-free. The
  // numericTransformer keeps the JS field a `number`, so existing arithmetic
  // and the API contract (still a number) are unchanged.
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  total_price!: number;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  market_tariff!: number | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  courier_tariff!: number | null;

  /**
   * Amount the courier KEEPS for this order, snapshotted at sale time per the
   * courier's compensation mode (= tariff for per-order modes, 0 for
   * salary-only). Distinct from courier_tariff (the configured tariff value).
   * Used for exact settlement and rollback math.
   */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  courier_share!: number | null;

  /**
   * Amount the (PARTNER) branch KEEPS for this order, snapshotted at sale time
   * (= Branch.per_order_share for PARTNER branches, 0 for OWNED / HQ).
   */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  branch_share!: number | null;

  /**
   * Amount actually credited to the branch cashbox at sale time. Manager-direct
   * sales credit the full collected amount, while courier sales keep their
   * existing settlement-based amount. Used to reverse the exact credit.
   */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  branch_cashbox_amount!: number | null;

  /**
   * SOTUV PAYTIDA MIJOZDAN YIG'ILGAN NAQD (snapshot).
   *
   * `total_price − paid_online_amount` — ya'ni kuryer haqiqatan qo'liga
   * olgan pul. Naqd sotuvda u `total_price` ga teng, onlayn to'langan
   * buyurtmada 0, qisman to'langanda oradagi farq.
   *
   * ⚠️ NEGA SNAPSHOT, NEGA QAYTA HISOBLANMAYDI. Rollback sotuvni AYNAN
   * teskari yozishi kerak. `paid_online_amount` esa sotuvdan KEYIN ham
   * o'zgarishi mumkin (qaytarish webhooki uni kamaytiradi). Qayta
   * hisoblansa rollback boshqa summani teskari yozardi va kassada farq
   * qolardi — `courier_share`/`branch_cashbox_amount` aynan shu sababdan
   * snapshot qilingan.
   *
   * `null` — sotuvdan oldin yoki bu ustun paydo bo'lishidan oldin sotilgan
   * eski buyurtmalar. Rollback bunda `total_price` ga qaytadi, ya'ni eski
   * ma'lumot bugungidek ishlaydi.
   */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  sale_collectible_amount!: number | null;

  /**
   * Sotuv/bekor qilishda kuryer yozgan qo'shimcha xarajat.
   *
   * Ilgari bu summa HECH QAYERDA buyurtmada saqlanmasdi — faqat kassa
   * tarixida (`source_type = EXTRA_COST`) va audit logda qolardi. Oqibati:
   * buyurtmani ko'rib turib qancha xarajat yozilganini bilish uchun kassa
   * tarixini qazish kerak edi, hamkorga (BeePost) esa u UMUMAN yetib
   * bormasdi — hamkor tomonida market hech narsa to'lamasdi va ikki
   * daftar shu summaga ajralib qolardi.
   */
  @Column({ type: 'int', default: 0 })
  extra_cost!: number;

  /**
   * MIJOZ ONLAYN TO'LAGAN SUMMA (Uzum, Alif, Payme, Click, bank).
   *
   * ⚠️ `paid_amount` BILAN ARALASHTIRMANG — ular butunlay boshqa narsa:
   *
   *   `paid_amount`        = MARKET QARZINING avtomatik to'langan qismi
   *                          (`sellOrder` da market kassasining manfiy
   *                          balansidan kelib chiqadi). Mijoz puli EMAS.
   *   `paid_online_amount` = MIJOZ to'lov tizimi orqali to'lagan pul.
   *                          Kuryer bu summani naqd YIG'MASLIGI kerak.
   *
   * `total_price` bilan bir xil tip (`numeric(14,2)`): `to_be_paid` va
   * `paid_amount` — eski `int` ustunlar, ya'ni tiyin saqlamaydi. Yangi
   * maydonni ham `int` qilsak, to'lov tizimidan kelgan tiyinli summa
   * jimgina yumaloqlanardi.
   */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  paid_online_amount!: number;

  /**
   * ONLAYN TO'LOV HOLATI.
   *
   * ⚠️ `Order_status.PAID` / `PARTLY_PAID` BILAN ARALASHTIRMANG — ular
   * MARKET bilan hisob-kitob haqida. Bu maydon esa MIJOZNING to'lovi
   * haqida; ikkisi bir-biridan mustaqil.
   *
   * Qiymatlar: `paid` | `partly` | `refunded`. `null` — onlayn to'lov
   * bo'lmagan (COD, oddiy holat).
   *
   * ⚠️ NEGA ENUM EMAS. Postgres enum'iga qiymat qo'shish `ALTER TYPE`
   * migratsiyasini talab qiladi va to'lov holatlari hali barqarorlashmagan
   * (qaytarish, qisman qaytarish, bekor qilish tafsilotlari provayderga
   * qarab farq qiladi). Qiymatlar kodda `PaymentState` tipi bilan
   * cheklanadi.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  payment_status!: string | null;

  @Column({ type: 'int', default: 0 })
  to_be_paid!: number;

  @Column({ type: 'int', default: 0 })
  paid_amount!: number;

  @Column({ type: 'enum', enum: Order_status, default: Order_status.NEW })
  status!: Order_status;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ type: 'varchar', nullable: true })
  operator!: string | null;

  @Column({ type: 'bigint', nullable: true })
  operator_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  post_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  canceled_post_id!: string | null;

  @Column({ type: 'boolean', default: false })
  return_requested!: boolean;

  // MinIO object keys of proof files (image/video) attached to the most recent
  // proof-required sell/cancel operation on this order. Covers proof conditions
  // that produce no expense (e.g. cancelling a zero-total order). Expense-bearing
  // proofs are additionally stored on the matching cashbox_history row.
  @Column({ type: 'jsonb', nullable: true })
  proof_files!: string[] | null;

  @Column({ type: 'bigint', nullable: true })
  sold_at!: string | null;

  @Column({ type: 'bigint', nullable: true })
  district_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  region_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  branch_id!: string | null;

  /**
   * The order's home (owning/creating) branch — the branch the market submitted
   * it to. Set once at creation and never overwritten, unlike `branch_id` which
   * tracks the current physical location. Drives the return-to-market rules
   * (market may collect at HQ or at the home branch).
   */
  @Column({ type: 'bigint', nullable: true })
  home_branch_id!: string | null;

  @ManyToOne(() => Branch, {
    nullable: true,
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'branch_id' })
  branch!: Branch | null;

  @Column({ type: 'bigint', nullable: true })
  current_batch_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  courier_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  assigned_at!: Date | null;

  @Column({ type: 'enum', enum: OrderHolderType, default: OrderHolderType.HQ })
  holder_type!: OrderHolderType;

  @Column({ type: 'bigint', nullable: true })
  holder_branch_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  holder_courier_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_handover_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  last_handover_by!: string | null;

  @Column({ type: 'text', nullable: true })
  return_reason!: string | null;

  @Column({ type: 'varchar', nullable: true })
  address!: string | null;

  @Column({ type: 'varchar', nullable: true })
  qr_code_token!: string | null;

  @Column({ type: 'bigint', nullable: true })
  parent_order_id!: string | null;

  @Column({ type: 'varchar', nullable: true })
  external_id!: string | null;

  @Column({ type: 'enum', enum: Order_source, default: Order_source.INTERNAL })
  source!: Order_source;

  /**
   * Soft delete marker. NULL when the order is active.
   *
   * TypeORM auto-filters `deleted_at IS NULL` from every query unless the
   * caller opts in with `withDeleted()`. The legacy `isDeleted` boolean is
   * still kept in sync by the soft-delete helper so existing code that
   * filters on it continues to work.
   */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items!: OrderItem[];

  @OneToMany(() => OrderTracking, (tracking) => tracking.order)
  tracking!: OrderTracking[];

  @OneToMany(() => OrderCustodyEvent, (event) => event.order)
  custody_events!: OrderCustodyEvent[];
}
