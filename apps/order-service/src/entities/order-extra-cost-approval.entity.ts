import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

export type ExtraCostApprovalAction = 'sell' | 'cancel' | 'partly_sell';
/**
 * (hwTkXsGi) `void` — market qaror qilmagan, so'rov yopildi (buyurtma boshqa
 * amal bilan yakunlandi, orqaga qaytarildi, yangi so'rov bilan almashtirildi
 * yoki tasdiqda buyurtma endi «kutilmoqda» emas). `reversed` — tasdiqlangan
 * xarajat buyurtma orqaga qaytarilganda teskari yozildi.
 */
export type ExtraCostApprovalStatus =
  'pending' | 'approved' | 'rejected' | 'void' | 'reversed';

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

  /** Avtomatik tasdiqdan oldingi oxirgi eslatma (bir marta). */
  @Column({ type: 'timestamptz', nullable: true })
  reminder_sent_at!: Date | null;

  /**
   * (AFZaUUi5) Avtomatik tasdiq muddati shu vaqtdan sanaladi. Yangi so'rovda —
   * yaratilgan vaqt (DB sukuti `now()`); avtomatik tasdiq yoqilgan paytda
   * ochiq turgan so'rovlarda — yoqilgan vaqt (migratsiya 208), aks holda
   * 24 soatdan eskilari birinchi daqiqada birdan tasdiqlanib ketardi. Tasdiq
   * darvozasi (holat o'zgarganmi) esa avvalgidek `createdAt` dan sanaladi.
   */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  auto_approve_from!: Date;

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
