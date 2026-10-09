import {
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  Roles,
} from '../../enums';

/**
 * BILDIRISHNOMA TURLARI REYESTRI (Eh8y21Ha) — `notification.dispatch.type`
 * uchun YAGONA manba: backend validatsiyasi, sukut sozlamalari va frontend
 * (`GET /notifications/types`) shu ro'yxatdan oladi. Frontendda qo'lda
 * takrorlanmasin — vaqt o'tib ikkisi ajralib ketadi.
 *
 * ⚠️ MIGRATSIYA KERAK EMAS: katalog — kod, DB emas. `notifications.type`
 * oddiy VARCHAR (migrations/1716000000008:36), yangi tur qo'shish = shu faylga
 * bitta yozuv.
 *
 * ⚠️ `category` esa Postgres ENUM (migrations/1716000000008:17-21: order,
 * finance, branch, logistics, account, system, marketing). Yangi kategoriya =
 * migratsiya, shuning uchun har yangi tur MAVJUD 7 kategoriyaga sig'dirilsin.
 * Masalan `integration.sync_failed` va `ai.*` — `category: system`.
 *
 * ⚠️ IKKI YO'L: reyestr faqat `notification.dispatch` (inbox) yo'lini
 * qamraydi. `notification.send` (to'g'ridan-to'g'ri Telegram guruh relay'i,
 * integration-service admin ogohlantirishlari) turi yo'q va inboxga
 * yozilmaydi — u bu reyestrdan ATAYLAB tashqarida.
 */
export interface NotificationTypeDefinition {
  /** `{domen}.{hodisa}` — `notifications.type` ga aynan shu yoziladi. */
  key: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  /** Dispatch `channels` bermasa shu kanallar ishlatiladi. */
  default_channels: readonly NotificationChannel[];
  /**
   * Dedupe kaliti shabloni: `{{o'zgaruvchi}}` lar `dto.data` dan to'ldiriladi
   * (masalan `order:{{order_id}}:status`). O'zgaruvchi yetishmasa `group_key`
   * UMUMAN berilmaydi (bo'sh satr emas). `null` — har dispatch yangi qator.
   */
  group_key_pattern: string | null;
  /** Inbox / sozlamalar UI uchun o'zbekcha yorliq. */
  label_uz: string;
  /** Odatdagi qabul qiluvchi rollar (ma'lumot uchun; nishonni chaqiruvchi beradi). */
  default_audience: readonly string[];
  /** Foydalanuvchi bu turni o'chira oladimi. `critical` uchun DOIM false. */
  user_can_mute: boolean;
}

/** Vaqtinchalik (reyestrga kiritilmagan) turlar uchun yagona ochiq yo'l. */
export const FREE_NOTIFICATION_TYPE_PREFIX = 'x.';

const FREE_NOTIFICATION_TYPE_RE = /^x\.[a-z0-9][a-z0-9_.:-]{0,117}$/i;

const IN_APP_REALTIME: readonly NotificationChannel[] = Object.freeze([
  NotificationChannel.IN_APP,
  NotificationChannel.REALTIME,
]);

/** Buyurtma hodisalari: bir buyurtma = inboxda BITTA qator (holat yangilanadi). */
const ORDER_STATUS_GROUP = 'order:{{order_id}}:status';
// (i76gGjyq) Buyurtmaning `operator_id` si — market xodimi (`market_operator`),
// eski `operator` roli emas. LOGIST — viloyat logisti (OA16fdSq).
const ORDER_AUDIENCE: readonly string[] = Object.freeze([
  Roles.MARKET,
  Roles.MARKET_OPERATOR,
  Roles.LOGIST,
]);

const def = (
  entry: Omit<NotificationTypeDefinition, 'default_channels'> & {
    default_channels?: readonly NotificationChannel[];
  },
): NotificationTypeDefinition =>
  Object.freeze({
    ...entry,
    default_channels: entry.default_channels ?? IN_APP_REALTIME,
    default_audience: Object.freeze([...entry.default_audience]),
  });

/** Admin "Xabar yuborish" formasi `${category}.manual` yuboradi — har kategoriya uchun. */
const MANUAL_TYPES: NotificationTypeDefinition[] = (
  Object.values(NotificationCategory) as NotificationCategory[]
).map((category) =>
  def({
    key: `${category}.manual`,
    category,
    priority: NotificationPriority.NORMAL,
    group_key_pattern: null,
    label_uz: "Qo'lda yuborilgan xabar",
    default_audience: [],
    user_can_mute: true,
  }),
);

export const NOTIFICATION_TYPES: readonly NotificationTypeDefinition[] =
  Object.freeze([
    // ---- Buyurtma (order-service pilot, OA16fdSq) ----
    def({
      key: 'order.created',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: ORDER_STATUS_GROUP,
      label_uz: 'Buyurtma yaratildi',
      default_audience: ORDER_AUDIENCE,
      user_can_mute: true,
    }),
    def({
      key: 'order.accepted',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: ORDER_STATUS_GROUP,
      label_uz: 'Buyurtma qabul qilindi',
      default_audience: ORDER_AUDIENCE,
      user_can_mute: true,
    }),
    def({
      key: 'order.on_way',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: ORDER_STATUS_GROUP,
      label_uz: "Buyurtma yo'lda",
      default_audience: ORDER_AUDIENCE,
      user_can_mute: true,
    }),
    def({
      key: 'order.sold',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: ORDER_STATUS_GROUP,
      label_uz: 'Buyurtma sotildi',
      default_audience: ORDER_AUDIENCE,
      user_can_mute: true,
    }),
    def({
      key: 'order.cancelled',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.HIGH,
      // Market "bekor qilinganlar" Telegram guruhiga ham (BeePost order.service:3557).
      default_channels: [
        NotificationChannel.IN_APP,
        NotificationChannel.REALTIME,
        NotificationChannel.TELEGRAM,
      ],
      group_key_pattern: ORDER_STATUS_GROUP,
      label_uz: 'Buyurtma bekor qilindi',
      default_audience: ORDER_AUDIENCE,
      user_can_mute: true,
    }),
    def({
      key: 'order.partly_cancelled',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.HIGH,
      group_key_pattern: ORDER_STATUS_GROUP,
      label_uz: 'Buyurtma qisman bekor qilindi',
      default_audience: ORDER_AUDIENCE,
      user_can_mute: true,
    }),
    def({
      key: 'order.returned',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: ORDER_STATUS_GROUP,
      label_uz: 'Buyurtma marketga qaytarildi',
      default_audience: ORDER_AUDIENCE,
      user_can_mute: true,
    }),
    def({
      key: 'order.exchanged',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: ORDER_STATUS_GROUP,
      label_uz: 'Buyurtma almashtirildi',
      default_audience: ORDER_AUDIENCE,
      user_can_mute: true,
    }),
    def({
      key: 'order.not_accepted',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.HIGH,
      group_key_pattern: ORDER_STATUS_GROUP,
      label_uz: "Mijoz buyurtmani qabul qilmadi (yetkazib bo'lmadi)",
      default_audience: ORDER_AUDIENCE,
      user_can_mute: true,
    }),

    // (ePpLHPX2) Kuryerga biriktirish — buyurtma domeni hodisasi (kartadagi
    // kalit aynan shu). `logistics.assigned` bilan bir xil guruh kaliti:
    // bitta buyurtmaning kuryer bildirishnomasi inboxda BITTA qator.
    def({
      key: 'order.assigned_to_courier',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: 'order:{{order_id}}:courier',
      label_uz: 'Buyurtma kuryerga biriktirildi',
      default_audience: [Roles.COURIER, Roles.MARKET],
      user_can_mute: true,
    }),

    // ---- Moliya ----
    def({
      key: 'finance.payment_received',
      category: NotificationCategory.FINANCE,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: 'finance:payment:{{payment_id}}',
      label_uz: "To'lov qabul qilindi",
      default_audience: [Roles.MARKET],
      user_can_mute: true,
    }),
    // (ePpLHPX2) Balans to'ldirildi (BeePost notifyBalanceTopup analogi).
    def({
      key: 'finance.balance_topup',
      category: NotificationCategory.FINANCE,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: null,
      label_uz: "Balans to'ldirildi",
      default_audience: [Roles.MARKET, Roles.COURIER],
      user_can_mute: true,
    }),
    def({
      key: 'finance.settlement_closed',
      category: NotificationCategory.FINANCE,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: 'finance:settlement:{{settlement_id}}',
      label_uz: 'Hisob-kitob yopildi',
      default_audience: [Roles.MARKET, Roles.COURIER, Roles.BRANCH],
      user_can_mute: true,
    }),
    def({
      key: 'finance.manual_expense',
      category: NotificationCategory.FINANCE,
      priority: NotificationPriority.HIGH,
      group_key_pattern: null,
      label_uz: "Qo'lda xarajat yozildi",
      default_audience: [Roles.SUPERADMIN, Roles.ADMIN],
      user_can_mute: true,
    }),

    // ---- Filial ----
    def({
      key: 'branch.transfer_sent',
      category: NotificationCategory.BRANCH,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: 'branch:transfer:{{batch_id}}',
      label_uz: "Filialga pochta jo'natildi",
      default_audience: [Roles.BRANCH, Roles.MANAGER],
      user_can_mute: true,
    }),
    def({
      key: 'branch.transfer_received',
      category: NotificationCategory.BRANCH,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: 'branch:transfer:{{batch_id}}',
      label_uz: 'Filial pochtani qabul qildi',
      default_audience: [Roles.BRANCH, Roles.MANAGER],
      user_can_mute: true,
    }),

    // ---- Logistika ----
    def({
      key: 'logistics.assigned',
      category: NotificationCategory.LOGISTICS,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: 'order:{{order_id}}:courier',
      label_uz: 'Kuryerga biriktirildi',
      default_audience: [Roles.COURIER],
      user_can_mute: true,
    }),
    // (ePpLHPX2) Pochta (partiya) manzil filialiga yetib keldi.
    def({
      key: 'logistics.batch_arrived',
      category: NotificationCategory.LOGISTICS,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: 'logistics:post:{{post_id}}',
      label_uz: 'Pochta filialga yetib keldi',
      default_audience: [Roles.BRANCH, Roles.MANAGER],
      user_can_mute: true,
    }),
    def({
      key: 'logistics.return_approved',
      category: NotificationCategory.LOGISTICS,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: 'order:{{order_id}}:return',
      label_uz: 'Qaytarish tasdiqlandi',
      default_audience: [Roles.COURIER, Roles.MANAGER],
      user_can_mute: true,
    }),

    // ---- Akkaunt xavfsizligi (o'chirib bo'lmaydi) ----
    def({
      key: 'account.password_changed',
      category: NotificationCategory.ACCOUNT,
      priority: NotificationPriority.CRITICAL,
      group_key_pattern: null,
      label_uz: "Parol o'zgartirildi",
      default_audience: [],
      user_can_mute: false,
    }),
    def({
      key: 'account.login_new_device',
      category: NotificationCategory.ACCOUNT,
      priority: NotificationPriority.CRITICAL,
      group_key_pattern: null,
      label_uz: 'Yangi qurilmadan kirildi',
      default_audience: [],
      user_can_mute: false,
    }),

    // ---- Tizim ----
    // `integration` Postgres kategoriya enumida YO'Q — ataylab `system`.
    def({
      key: 'integration.sync_failed',
      category: NotificationCategory.SYSTEM,
      priority: NotificationPriority.HIGH,
      group_key_pattern: 'integration:{{integration_id}}:sync',
      label_uz: 'Integratsiya sinxronlash xatosi',
      default_audience: [Roles.SUPERADMIN, Roles.ADMIN],
      user_can_mute: true,
    }),
    def({
      key: 'system.announcement',
      category: NotificationCategory.SYSTEM,
      priority: NotificationPriority.NORMAL,
      group_key_pattern: null,
      label_uz: "Tizim e'loni",
      default_audience: [],
      user_can_mute: true,
    }),
    // ai-service kunlik shift bildirishnomalari (ai-budget.notifier.ts).
    def({
      key: 'ai.cap_warning',
      category: NotificationCategory.SYSTEM,
      priority: NotificationPriority.HIGH,
      group_key_pattern: 'ai.cap_warning:{{period_key}}',
      label_uz: 'AI kunlik byudjeti tugashga yaqin',
      default_audience: [Roles.SUPERADMIN, Roles.ADMIN],
      user_can_mute: true,
    }),
    def({
      key: 'ai.cap_exceeded',
      category: NotificationCategory.SYSTEM,
      priority: NotificationPriority.CRITICAL,
      group_key_pattern: 'ai.cap_exceeded:{{period_key}}',
      label_uz: 'AI kunlik byudjeti tugadi',
      default_audience: [Roles.SUPERADMIN, Roles.ADMIN],
      user_can_mute: false,
    }),

    // ---- Marketing ----
    def({
      key: 'marketing.promo',
      category: NotificationCategory.MARKETING,
      priority: NotificationPriority.LOW,
      group_key_pattern: 'marketing:promo:{{campaign_id}}',
      label_uz: 'Aksiya / promo',
      default_audience: [],
      user_can_mute: true,
    }),

    ...MANUAL_TYPES,
  ]);

const BY_KEY: ReadonlyMap<string, NotificationTypeDefinition> = new Map(
  NOTIFICATION_TYPES.map((entry) => [entry.key, entry]),
);

export function findNotificationType(
  key: string | null | undefined,
): NotificationTypeDefinition | undefined {
  return BY_KEY.get(String(key ?? '').trim());
}

/** Vaqtinchalik `x.` prefiksli erkin tur. */
export function isFreeNotificationType(key: string | null | undefined) {
  return FREE_NOTIFICATION_TYPE_RE.test(String(key ?? '').trim());
}

/** Fail-closed: katalogda bor YOKI `x.` prefiksli bo'lsagina true. */
export function isKnownNotificationType(key: string | null | undefined) {
  return Boolean(findNotificationType(key)) || isFreeNotificationType(key);
}

export function notificationTypeErrorMessage(key: unknown): string {
  const value = typeof key === 'string' ? key.trim() : '';
  return (
    `Noma'lum bildirishnoma turi "${value.slice(0, 120)}". Ruxsat etilgan turlar ` +
    `GET /notifications/types katalogida; vaqtinchalik (katalogga kiritilmagan) ` +
    `tur faqat "${FREE_NOTIFICATION_TYPE_PREFIX}" prefiksi bilan, masalan "x.test".`
  );
}

/**
 * `order:{{order_id}}:status` + `{ order_id: 81 }` → `order:81:status`.
 * Biror o'zgaruvchi yo'q / bo'sh / obyekt bo'lsa — `null` (group_key
 * berilmaydi; bo'sh satr yoki `order::status` QO'YILMAYDI).
 */
export function renderNotificationGroupKey(
  pattern: string | null | undefined,
  data: Record<string, unknown> | null | undefined,
): string | null {
  if (!pattern) return null;
  let missing = false;
  const rendered = pattern.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_match, name: string) => {
      const value = data?.[name];
      const text =
        typeof value === 'string'
          ? value.trim()
          : typeof value === 'number' && Number.isFinite(value)
            ? String(value)
            : typeof value === 'bigint'
              ? value.toString()
              : '';
      if (!text) missing = true;
      return text;
    },
  );
  if (missing || !rendered.trim() || rendered.length > 255) return null;
  return rendered;
}

export interface ResolvedNotificationDefaults {
  category: NotificationCategory;
  priority: NotificationPriority;
  group_key: string | null;
  channels: NotificationChannel[];
}

/**
 * Dispatch'da berilmagan maydonlarni katalogdan to'ldiradi. DTO'da berilgan
 * qiymat DOIM ustun. `x.` turlar va katalogdan tashqari turlar uchun eski
 * sukutlar (SYSTEM / NORMAL / [in_app, realtime]).
 */
export function resolveNotificationDefaults(input: {
  type: string;
  category?: NotificationCategory | null;
  priority?: NotificationPriority | null;
  group_key?: string | null;
  channels?: NotificationChannel[] | null;
  data?: Record<string, unknown> | null;
}): ResolvedNotificationDefaults {
  const entry = findNotificationType(input.type);
  const explicitGroupKey =
    typeof input.group_key === 'string' && input.group_key.trim()
      ? input.group_key
      : null;
  return {
    category: input.category ?? entry?.category ?? NotificationCategory.SYSTEM,
    priority: input.priority ?? entry?.priority ?? NotificationPriority.NORMAL,
    group_key:
      explicitGroupKey ??
      renderNotificationGroupKey(entry?.group_key_pattern, input.data),
    channels: input.channels?.length
      ? [...input.channels]
      : [...(entry?.default_channels ?? IN_APP_REALTIME)],
  };
}
