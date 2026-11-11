import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, Cashbox_type, numericTransformer } from '@app/common';

export type ExtraCostApprovalAction = 'sell' | 'cancel' | 'partly_sell';
/**
 * (hwTkXsGi) `void` — market qaror qilmagan, so'rov yopildi (buyurtma boshqa
 * amal bilan yakunlandi, orqaga qaytarildi, yangi so'rov bilan almashtirildi
 * yoki tasdiqda buyurtma endi «kutilmoqda» emas). `reversed` — tasdiqlangan
 * xarajat buyurtma orqaga qaytarilganda teskari yozildi.
 */
export type ExtraCostApprovalStatus =
  'pending' | 'approved' | 'rejected' | 'void' | 'reversed';

/**
 * (SPEC v2, migratsiya 219) `replay` — eski xulq: tasdiqda amal qayta ijro
 * bo'ladi. `deferred` — amal darhol E = 0 bilan bajarilgan, tasdiq faqat E ni
 * alohida tranzaksiya qilib yozadi, rad etish hech narsa yozmaydi.
 */
export type ExtraCostApprovalMode = 'replay' | 'deferred';

/** So'rov qaysi tovarlar uchun (snapshot; nom o'qishda katalogdan). */
export interface ExtraCostApprovalItem {
  order_item_id: string | null;
  product_id: string | null;
  product_name: string | null;
  quantity: number;
  sold_quantity?: number;
  returned_quantity?: number;
}

/**
 * Kechiktirilgan E ni tasdiqda QAYTA HISOBLAMASDAN yozish uchun so'rov
 * paytidagi holat — bugungi kod E ni qayerga yozgan bo'lsa, aynan o'sha.
 */
export interface ExtraCostDeferredSnapshot {
  /**
   * E yechiladigan kassa turi — `Cashbox_type` QIYMATI ('couriers' /
   * 'branch'); `null` — kassa yo'q (HQ menejeri sotuvi: faqat market −E).
   */
  charged_cashbox_type: Cashbox_type.FOR_COURIER | Cashbox_type.BRANCH | null;
  charged_user_id: string | null;
  courier_id: string | null;
  branch_id: string | null;
  market_id: string | null;
  legs: { courier: number; branch: number; market: number };
  chain_start_status: string;
  ledger_kind: 'sell_extra_cost' | 'cancel_extra_cost';
  operation_at: string;
  order_number: string | null;
}

/** (hwTkXsGi) Bitta buyurtmada bittadan ortiq ochiq so'rov yo'q — migratsiya 206. */
export const EXTRA_COST_PENDING_UNIQUE_INDEX =
  'UQ_ORDER_EXTRA_COST_APPROVAL_PENDING';

@Entity({ name: 'order_extra_cost_approvals' })
@Index('IDX_ORDER_EXTRA_COST_APPROVAL_MARKET_STATUS', [
  'market_id',
  'status',
  'createdAt',
])
@Index('IDX_ORDER_EXTRA_COST_APPROVAL_ORDER_STATUS', ['order_id', 'status'])
@Index(EXTRA_COST_PENDING_UNIQUE_INDEX, ['order_id'], {
  unique: true,
  where: `"status" = 'pending' AND "is_deleted" = false`,
})
// (GykuOz8f) «Qo'shimcha xarajatli buyurtmalar»: kuryer (o'z so'rovlari) va
// filial menejeri (filial kuryerlari) ro'yxati — migratsiya 210.
@Index('IDX_EXTRA_COST_REQUESTER_CREATED', [
  'requested_by_user_id',
  'createdAt',
])
@Index('IDX_EXTRA_COST_BRANCH_CREATED', ['requester_branch_id', 'createdAt'])
export class OrderExtraCostApproval extends BaseEntity {
  @Column({ type: 'bigint' })
  order_id!: string;

  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'bigint' })
  requested_by_user_id!: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  requested_by_role!: string | null;

  @Column({ type: 'bigint', nullable: true })
  requester_branch_id!: string | null;

  @Column({ type: 'varchar', length: 20 })
  action!: ExtraCostApprovalAction;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  amount!: number;

  @Column({ type: 'jsonb', nullable: true })
  proof_file_keys!: string[] | null;

  @Column({ type: 'jsonb' })
  operation_payload!: Record<string, unknown>;

  /** (SPEC v2) Eski qatorlar — `replay`. */
  @Column({ type: 'varchar', length: 16, default: 'replay' })
  mode!: ExtraCostApprovalMode;

  @Column({ type: 'jsonb', nullable: true })
  items!: ExtraCostApprovalItem[] | null;

  @Column({ type: 'jsonb', nullable: true })
  deferred_snapshot!: ExtraCostDeferredSnapshot | null;

  /**
   * (SPEC v2 §3.5) Tasdiqdagi ortiqcha market buyurtmalariga qo'llangan
   * vaqt — `order.extra_cost.apply_overage` ning AYNAN BIR MARTA belgisi
   * (qayta yetkazish / qayta ishga tushish ikkinchi marta qo'llamasin).
   */
  @Column({ type: 'timestamptz', nullable: true })
  overage_applied_at!: Date | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: ExtraCostApprovalStatus;

  @Column({ type: 'bigint', nullable: true })
  decided_by_user_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decided_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  decision_comment!: string | null;

  /**
   * (1tnpaIqd, ega qarori) Muddat (EXTRA_COST_AUTO_APPROVE_MINUTES) o'tib
   * AVTOMATIK tasdiqlangan — `decided_by_user_id` NULL; hisobot va buyurtma
   * tarixida "avtomatik tasdiqlangan" deb ko'rinadi.
   */
  @Column({ type: 'boolean', default: false })
  auto_approved!: boolean;

  /**
   * (GykuOz8f) Market tasdig'isiz DARHOL yozilgan xarajat (tasdiq o'chiq
   * market yoki qayta ijro bo'lmagan har qanday yo'l): sotish / bekor qilish /
   * qisman sotish pul yozuvi bilan bitta tranzaksiyada `approved` bo'lib
   * yoziladi, `decided_by_user_id` NULL, `auto_approved` false. Orqaga
   * qaytarishda boshqa tasdiqlanganlar kabi `reversed`. Kuryerga xabar
   * yuborilmaydi (u o'zi yozgan).
   */
  @Column({ type: 'boolean', default: false })
  immediate!: boolean;

  /** Avtomatik tasdiqdan oldingi oxirgi eslatma (bir marta). */
  @Column({ type: 'timestamptz', nullable: true })
  reminder_sent_at!: Date | null;

  /**
   * (AFZaUUi5) Avtomatik tasdiq muddati shu vaqtdan sanaladi. NULL — skaner
   * hali ko'rmagan; birinchi tikda bir marta belgilanadi: yangi so'rov —
   * `createdAt`, muddatdan eski so'rov (avtomatik tasdiq yoqilgan paytda
   * ochiq turgan) — o'sha tik vaqti, aks holda ular birinchi daqiqada birdan
   * tasdiqlanib ketardi. DB sukuti yo'q — eski kod yozgan qator ham NULL
   * bo'lib qoladi. Tasdiq darvozasi (holat o'zgarganmi) esa avvalgidek
   * `createdAt` dan sanaladi.
   */
  @Column({ type: 'timestamptz', nullable: true })
  auto_approve_from!: Date | null;

  /**
   * (AFZaUUi5) Avtomatik tasdiq infratuzilma xatosi bilan tugagan urinishlar
   * soni; keyingi urinish `auto_retry_at` dan oldin bo'lmaydi (har daqiqa
   * qayta urinilmaydi). Biznes xatosida so'rov `void` — bular kerak emas.
   */
  @Column({ type: 'int', default: 0 })
  auto_attempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  auto_retry_at!: Date | null;

  /** (DuST9k8j) Rad etish sababi — ExtraCostRejectReason (yopiq ro'yxat). */
  @Column({ type: 'varchar', length: 40, nullable: true })
  reject_reason!: string | null;

  /**
   * (hwTkXsGi) `void` / `reversed` sababi va vaqti. Market qarori
   * (`decided_*`, `decision_comment`) ustidan yozilmaydi — tasdiqlangan
   * xarajat teskari qaytarilsa ham kim tasdiqlagani saqlanadi.
   */
  @Column({ type: 'text', nullable: true })
  closed_reason!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  closed_at!: Date | null;

  /** Yopishga sabab bo'lgan foydalanuvchi; tizim yoki hamkor — NULL. */
  @Column({ type: 'bigint', nullable: true })
  closed_by_user_id!: string | null;
}
