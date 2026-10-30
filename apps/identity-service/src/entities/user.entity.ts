import { Entity, Column } from 'typeorm';
import {
  BaseEntity,
  Commission_type,
  CourierCompensationMode,
  ExpenseProofCondition,
  numericTransformer,
  Roles,
  Status,
  Where_deliver,
} from '@app/common';

@Entity({ name: 'admins', schema: 'identity_schema' })
export class User extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 20, unique: true })
  phone_number: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  extra_number?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  address?: string | null;

  @Column({ type: 'varchar', length: 60, unique: true, nullable: true })
  username: string | null;

  @Column({ type: 'varchar', length: 255 })
  password: string;

  /**
   * ESKI (bitta sessiya) modelning hashi — eng oxirgi login'niki. Endi
   * sessiyalar `identity_schema.user_sessions` da; bu ustun faqat deploy
   * paytida allaqachon kirgan foydalanuvchilar (refresh'da sessiya qatori
   * yaratiladi) va rollback uchun yozilib turadi. Umumiy javoblarga
   * HECH QACHON chiqmaydi.
   */
  @Column({ type: 'varchar', length: 512, nullable: true })
  refresh_token: string | null;

  /**
   * (Elchi Pochta #3) Sessiyalar "davri": oshirilsa shu foydalanuvchining
   * BARCHA sessiyalari yaroqsiz (`user_sessions.epoch` mos kelmaydi). Faqat
   * `invalidateAllSessions()` orqali o'zgartiriladi — parol/telefon/rol
   * almashishi, bloklash, o'chirish. Umumiy javoblarga chiqmaydi.
   */
  @Column({ type: 'integer', default: 0 })
  session_epoch: number;

  /**
   * (NDmZMzCP / aidsxJ2H) Keyingi kirishda parolni almashtirish kerak. Login
   * paytida mavjud parol yangi siyosatga mos kelmasa `true` qilinadi (login
   * baribir muvaffaqiyatli); foydalanuvchi parolni O'ZI almashtirsa `false`.
   * Login javobida va access token'da (`pwd_change`) ko'rinadi.
   */
  @Column({ type: 'boolean', default: false })
  must_change_password: boolean;

  /**
   * (aidsxJ2H, migratsiya 1716000000191) Parolni ADMIN / TIZIM bergan va
   * egasi uni hali almashtirmagan: `password_mode: 'generate_sms'`,
   * `manual` + `must_change_password: true` yoki «SMS'ni qayta yuborish».
   * `must_change_password` bilan birga `true` — access token'da
   * `pwd_forced`, gateway darvozasi env'ga qaramay ishlaydi. O'zi parolni
   * almashtirsa `false`. Mavjud foydalanuvchilar — `false`.
   */
  @Column({ type: 'boolean', default: false })
  password_change_forced: boolean;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: {
      to: (value: number) => value,
      from: (value: string | null) => (value === null ? 0 : Number(value)),
    },
  })
  salary: number;

  @Column({ type: 'int', nullable: true })
  payment_day: number;

  @Column({ type: 'bigint', nullable: true })
  region_id?: string | null;

  @Column({ type: 'bigint', nullable: true })
  district_id?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  market_tg_token?: string | null;

  @Column({ type: 'bigint', nullable: true })
  market_id?: string | null;

  /**
   * T7 (QPq2C1co, migratsiya 1716000000185) — faqat MARKET: marketning Elchi
   * mas'uli (superadmin / admin / registrator / logist, `admins.id`). NULL —
   * sukut mas'ul (`app_settings.contacts.default_market_responsible_id`).
   * Mas'ul o'chirilsa yoki roli mas'ul bo'lmaydiganga o'zgarsa — NULL.
   */
  @Column({ type: 'bigint', nullable: true })
  market_responsible_id?: string | null;

  /**
   * Shaxsiy Telegram (bot `/start <bir martalik kod>`). PARTIAL UNIQUE
   * (`UQ_ADMINS_TELEGRAM_ID`, migratsiya 1716000000121) — bitta Telegram
   * akkaunt = bitta xodim. Umumiy javoblarda QAYTMAYDI (sanitize →
   * `telegram_linked`).
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  telegram_id?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  telegram_username?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  telegram_linked_at?: Date | null;

  @Column({ type: 'bigint', nullable: true })
  avatar_id?: string | null;

  @Column({ type: 'enum', enum: Roles, default: Roles.ADMIN })
  role: Roles;

  @Column({ type: 'enum', enum: Status, default: Status.ACTIVE })
  status: Status;

  @Column({ type: 'int', nullable: true })
  tariff_home: number | null;

  @Column({ type: 'int', nullable: true })
  tariff_center: number | null;

  /**
   * KmWO9gTA (ega qarori 2026-10-19, migratsiya 1716000000182) — faqat
   * MARKET: «Vazn va hajm bo'yicha narx» kaliti. TRUE (sukut) — sotuvda
   * market tarifi = standart narx (`tariff_home` / `tariff_center`) +
   * vazn/hajm qo'shimchasi (dvigatel; faqat order-service'da
   * `SALE_PRICING_ENGINE=on` bo'lganda). FALSE — faqat standart narx
   * (kelishuvli market). Faqat SUPERADMIN/ADMIN o'zgartiradi.
   */
  @Column({ type: 'boolean', default: true })
  weight_volume_pricing: boolean;

  // hEjjuJaT: super-kuryer — bir nechta viloyatga xizmat qiladi
  // (identity_schema.courier_regions, har viloyatga ixtiyoriy tarif).
  @Column({ type: 'boolean', default: false })
  is_super_courier: boolean;

  // hEjjuJaT: TRUE — courier_regions qatorlaridan qat'i nazar HAR BIR viloyat
  // pochtasida chiqadi (faqat is_super_courier bilan birga ma'noli).
  @Column({ type: 'boolean', default: false })
  serves_all_regions: boolean;

  /**
   * How this courier is compensated per order (see CourierCompensationMode).
   * Drives courierShare at sale time: SALARY_ONLY keeps nothing per order,
   * PER_ORDER / SALARY_PLUS_PER_ORDER keep the tariff_home/center amount.
   * Defaults to PER_ORDER to preserve existing behaviour for current couriers.
   */
  @Column({
    type: 'enum',
    enum: CourierCompensationMode,
    default: CourierCompensationMode.PER_ORDER,
  })
  compensation_mode: CourierCompensationMode;

  @Column({ type: 'boolean', default: false })
  add_order: boolean;

  @Column({ type: 'boolean', default: false })
  can_add_extra_cost: boolean;

  // Per-manager SELL/CANCEL ruxsati (#4). HYBRID filial menejeriga sotish va
  // bekor qilish tugmalari faqat shu bayroq TRUE bo'lsagina ishlaydi. Superadmin
  // boshqaradi; default FALSE — ya'ni ruxsat ATAYLAB berilmaguncha yopiq.
  @Column({ type: 'boolean', default: false })
  can_sell_cancel: boolean;

  @Column({ type: 'boolean', default: true })
  cancelled_handover_qr_required: boolean;

  // Per-market proof policy: the SET of situations in which a courier MUST
  // attach file proof (image/video) for a sell/cancel operation of this
  // market's orders. NULL / empty = proof never required. See
  // ExpenseProofCondition for the catalog of supported conditions.
  @Column({ type: 'jsonb', nullable: true })
  expense_proof_conditions: ExpenseProofCondition[] | null;

  /**
   * w2bDrE3i — market bo'yicha qo'shimcha xarajat (extra_cost) DARVOZASI.
   * FALSE — bu market buyurtmalariga kuryer/menejer extra_cost yoza olmaydi
   * (403). Kuryer/menejerning `can_add_extra_cost` ruxsati BILAN BIRGA (AND)
   * ishlaydi — biri yopiq bo'lsa yozib bo'lmaydi.
   *
   * ⚠️ Sukut: YANGI market — FALSE (karta: "default o'chiq"). Migratsiya
   * 1716000000114 MAVJUD qatorlarni TRUE bilan qo'shadi (ortga-moslik:
   * ilgari darvoza yo'q edi, ya'ni hamma market uchun ochiq edi), so'ng
   * ustun sukutini FALSE ga o'tkazadi — backfill UPDATE yo'q.
   */
  @Column({ type: 'boolean', default: false })
  extra_cost_enabled: boolean;

  /**
   * w2bDrE3i — TRUE (sukut, avvalgi xulq): extra_cost market tasdig'idan
   * o'tadi (202 + approval). FALSE — tasdiqsiz darhol yoziladi. Isbot
   * (`expense_proof_conditions`) bundan MUSTAQIL — alohida tekshiriladi.
   */
  @Column({ type: 'boolean', default: true })
  extra_cost_requires_approval: boolean;

  /**
   * (ysBqD9Nx, EGA QARORI 2026-09-20) Market Telegram guruhi kartasida mijoz
   * ismi va telefoni ko'rinadimi. Sukut TRUE (ega tanlovi: operator kabinetni
   * ochmay qo'ng'iroq qilsin); FALSE — ism yo'q, telefon niqoblangan.
   * Market o'zi yoki admin kodsiz o'chiradi (`PATCH /markets/:id/telegram-group-pii`).
   */
  @Column({ type: 'boolean', default: true })
  tg_group_show_customer_pii: boolean;

  /**
   * hY7uacJu — faqat MARKET uchun: «Ombordan buyurtma yaratish» kaliti.
   * TRUE — market o'zi yaratgan buyurtma tuman filialidagi FAOL ombordan
   * ketishi mumkin (hamma mahsulot yetarli bo'lsa; aks holda HQ). Sukut
   * FALSE; faqat SUPERADMIN/ADMIN o'zgartiradi (migratsiya 1716000000143).
   */
  @Column({ type: 'boolean', default: false })
  can_order_from_warehouse: boolean;

  /**
   * XtcEyQjb — faqat MARKET_OPERATOR uchun: «Ombordagi qoldiq»ni ko'rish
   * kaliti. Market o'zi har operatoriga alohida yoqadi/o'chiradi
   * (`PATCH /market-operators/:id/warehouse-access`). Sukut FALSE —
   * `GET /market/warehouse-stock` operatorga 403 `WAREHOUSE_STOCK_FORBIDDEN`
   * (migratsiya 1716000000152).
   */
  @Column({ type: 'boolean', default: false })
  can_view_warehouse_stock: boolean;

  /**
   * VRyloH62 — TRUE: har buyurtmada operator raqami majburiy
   * (`default_operator_phone` yo'q bo'lsa formadagi raqam shart, aks holda
   * POST /orders 400). Sukut FALSE — avvalgi xulq.
   */
  @Column({ type: 'boolean', default: false })
  require_operator_phone: boolean;

  /**
   * VRyloH62 — marketning doimiy operator raqami (`+998XXXXXXXXX`): chekda
   * "Muammo bo'lsa" 1-raqami. NULL — yo'q.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  default_operator_phone: string | null;

  @Column({
    type: 'enum',
    enum: Where_deliver,
    default: Where_deliver.CENTER,
    nullable: true,
  })
  default_tariff: Where_deliver | null;

  /**
   * Operator commission config. When an order created by this operator is
   * sold, finance-service records an OperatorEarning. NULL commission_type
   * (or zero value) means this user earns no per-order commission.
   *   PERCENT → earning = total_price * commission_value / 100
   *   FIXED   → earning = commission_value (flat, per sold order)
   */
  @Column({ type: 'enum', enum: Commission_type, nullable: true })
  commission_type: Commission_type | null;

  // Dual-purpose: a percentage when commission_type=PERCENT, a flat money
  // amount when FIXED — so it must hold money-sized values, hence numeric(14,2).
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  commission_value: number | null;

  /**
   * NFiXfmq6 — faqat MARKET uchun: 1 ta AI buyurtma narxi (so'm). NULL —
   * global `AI_PRICE_PER_ORDER` (sukut 300); 0 — AI bepul. Faqat
   * SUPERADMIN/ADMIN o'zgartiradi (`PATCH /users/:id`), audit izi bilan.
   * Har yaratilgan AI buyurtmada amal qilgan narx ai-service
   * `ai_order_draft_item.applied_price_uzs` ga muzlatiladi (migratsiya
   * 1716000000118/119).
   */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  ai_price_per_order: number | null;

  // Per-user UI/dashboard preferences (theme, language, sidebar, dashboard
  // widget visibility, ...). Shape is owned by the frontend; backend stores it
  // opaquely. NULL = user has never customized (frontend applies defaults).
  @Column({ type: 'jsonb', nullable: true })
  settings: Record<string, unknown> | null;

  /**
   * Mijoz tili (nkhURiKX): SMS shablon shu tilda tanlanadi. Sukut 'uz'.
   * Xodimlar tili `settings.appearance.language` da — kontakt so'rovi shundan oladi.
   */
  @Column({ type: 'varchar', length: 2, default: 'uz' })
  language: string;

  // Kim bu foydalanuvchini YARATGAN (#3). Manager faqat O'ZI yaratgan
  // foydalanuvchilarni tahrirlay oladi. NULL = eski/tizim yaratgan yoki noma'lum
  // (bunday yozuvni manager tahrirlay olmaydi). bigint -> TS'da string.
  @Column({ type: 'bigint', nullable: true })
  created_by: string | null;
}
