import { ActivityAction } from './types';

/**
 * AMAL FE'LLARI REYESTRI (y8CxCtcK). BeePost `client/src/pages/logs-page/
 * index.tsx` dagi `ACTION_CONFIG` namunasi: har fe'l → o'zbekcha yorliq →
 * kategoriya → ikona nomi + rang toni.
 *
 * YAGONA MANBA: `/activity-logs/actions` shu ro'yxatni qaytaradi (statik
 * 16 ta `ActivityAction` emas), gateway har jurnal qatoriga `action_meta`
 * qo'shadi. ⚠️ Kodda yangi fe'l yozilsa — shu yerga qo'shing, aks holda
 * `action-registry.spec.ts` (AST skaneri: satr, `ActivityAction.X`,
 * shart-ifoda, konstanta obyekt, shablon) YIQILADI.
 *
 * Ikona nomlari — umumiy so'zlar (frontend o'z ikonka kutubxonasiga
 * moslaydi), ton — BeePost tonlari bilan bir xil to'plam.
 */

export type ActivityActionCategory =
  | 'order'
  | 'finance'
  | 'auth'
  | 'branch'
  | 'integration'
  | 'logistics'
  | 'notification'
  | 'general';

export type ActivityActionTone =
  | 'green'
  | 'red'
  | 'rose'
  | 'amber'
  | 'blue'
  | 'cyan'
  | 'violet'
  | 'slate';

/** Dropdown guruhlari tartibi bilan (antd Select optGroup). */
export const ACTIVITY_ACTION_CATEGORIES: ReadonlyArray<{
  key: ActivityActionCategory;
  label: string;
}> = Object.freeze([
  { key: 'order', label: 'Buyurtma' },
  { key: 'finance', label: 'Moliya' },
  { key: 'auth', label: 'Kirish' },
  { key: 'branch', label: 'Filial' },
  { key: 'integration', label: 'Integratsiya' },
  { key: 'logistics', label: 'Logistika' },
  { key: 'notification', label: 'Bildirishnoma' },
  { key: 'general', label: 'Umumiy' },
]);

export interface ActivityActionInfo {
  label: string;
  category: ActivityActionCategory;
  icon: string;
  tone: ActivityActionTone;
}

export interface ActivityActionMeta extends ActivityActionInfo {
  action: string;
  category_label: string;
  /** `false` — reyestrda yo'q eski/noma'lum fe'l (humanize zaxirasi). */
  known: boolean;
}

const entry = (
  label: string,
  category: ActivityActionCategory,
  icon: string,
  tone: ActivityActionTone,
): ActivityActionInfo => Object.freeze({ label, category, icon, tone });

export const ACTIVITY_ACTION_REGISTRY: Readonly<
  Record<string, ActivityActionInfo>
> = Object.freeze({
  // ---- umumiy fe'llar (`ActivityAction`) ----
  [ActivityAction.CREATED]: entry('Yaratildi', 'general', 'plus', 'green'),
  [ActivityAction.UPDATED]: entry('Tahrirlandi', 'general', 'edit', 'blue'),
  [ActivityAction.DELETED]: entry("O'chirildi", 'general', 'delete', 'red'),
  [ActivityAction.RESTORED]: entry('Tiklandi', 'general', 'undo', 'cyan'),
  [ActivityAction.STATUS_CHANGE]: entry(
    "Holat o'zgardi",
    'general',
    'swap',
    'blue',
  ),
  [ActivityAction.PAYMENT]: entry("To'lov", 'finance', 'wallet', 'green'),
  [ActivityAction.REFUND]: entry(
    'Pul qaytarildi',
    'finance',
    'rollback',
    'rose',
  ),
  [ActivityAction.LOGIN]: entry('Tizimga kirdi', 'auth', 'login', 'green'),
  [ActivityAction.LOGOUT]: entry('Tizimdan chiqdi', 'auth', 'logout', 'slate'),
  [ActivityAction.AUTH_FAILURE]: entry(
    'Kirish xatosi',
    'auth',
    'warning',
    'red',
  ),
  [ActivityAction.EXPORT]: entry('Eksport', 'general', 'download', 'slate'),
  [ActivityAction.IMPORT]: entry('Import', 'general', 'upload', 'slate'),
  [ActivityAction.WEBHOOK_RECEIVED]: entry(
    'Webhook qabul qilindi',
    'integration',
    'webhook',
    'violet',
  ),
  [ActivityAction.EXTERNAL_SYNC]: entry(
    'Tashqi sinxronlash',
    'integration',
    'sync',
    'violet',
  ),
  [ActivityAction.ASSIGN]: entry('Biriktirildi', 'general', 'link', 'blue'),
  [ActivityAction.UNASSIGN]: entry(
    'Biriktirish bekor qilindi',
    'general',
    'unlink',
    'amber',
  ),

  // ---- buyurtma ----
  'order.sell': entry('Sotildi', 'order', 'check', 'green'),
  'order.partly_sell': entry('Qisman sotildi', 'order', 'check', 'amber'),
  'order.cancel': entry('Bekor qilindi', 'order', 'stop', 'red'),
  'order.rollback': entry('Orqaga qaytarildi', 'order', 'rollback', 'rose'),
  'order.initiate_return': entry(
    'Qaytarish boshlandi',
    'order',
    'undo',
    'amber',
  ),

  // ---- moliya ----
  'finance.manual_income': entry("Qo'lda kirim", 'finance', 'plus', 'green'),
  'finance.manual_expense': entry("Qo'lda chiqim", 'finance', 'minus', 'rose'),
  // (2crjWf7v #4) kuryer kvitansiyani tasdiqladi / e'tiroz bildirdi (faqat audit).
  'finance.courier_payment_ack': entry(
    'Kuryer kvitansiyaga javob berdi',
    'finance',
    'check',
    'blue',
  ),
  // kiZgTybn: smena yopishda karta qoldig'ini tasdiqlash (rasm, AI, sozlamalar).
  'finance.shift_settings_updated': entry(
    "Smena yopish sozlamalari o'zgartirildi",
    'finance',
    'edit',
    'blue',
  ),
  'finance.shift_account_photo_uploaded': entry(
    "Karta qoldig'i rasmi yuklandi",
    'finance',
    'plus',
    'blue',
  ),
  'finance.shift_account_ai_checked': entry(
    "Karta qoldig'i AI bilan tekshirildi",
    'finance',
    'check',
    'blue',
  ),
  // 3PE0B03q (R6): nomli kassa kartalari
  'finance.card_created': entry(
    'Kassa kartasi yaratildi',
    'finance',
    'plus',
    'green',
  ),
  'finance.card_renamed': entry(
    "Kassa kartasi nomi o'zgartirildi",
    'finance',
    'edit',
    'blue',
  ),
  // Zv3MLn0a: karta tafsilotlari (turi, bank, oxirgi 4 raqam, egasi, smena
  // sozlamalari) va Asosiy kartani almashtirish.
  'finance.card_updated': entry(
    'Kassa kartasi tahrirlandi',
    'finance',
    'edit',
    'blue',
  ),
  'finance.card_made_default': entry(
    'Asosiy karta almashtirildi',
    'finance',
    'check',
    'blue',
  ),
  'finance.card_activated': entry(
    'Kassa kartasi faollashtirildi',
    'finance',
    'check',
    'green',
  ),
  'finance.card_archived': entry(
    'Kassa kartasi arxivlandi',
    'finance',
    'stop',
    'slate',
  ),
  'finance.card_transfer': entry(
    "Kartadan kartaga o'tkazma",
    'finance',
    'swap',
    'blue',
  ),
  'finance.card_convert': entry(
    'Karta ↔ naqd konvertatsiya',
    'finance',
    'swap',
    'cyan',
  ),
  // Elchi Pochta №1: kassa xarajatlari kategoriyalari (superadmin)
  'finance.expense_category_created': entry(
    "Xarajat kategoriyasi qo'shildi",
    'finance',
    'plus',
    'green',
  ),
  'finance.expense_category_updated': entry(
    'Xarajat kategoriyasi tahrirlandi',
    'finance',
    'edit',
    'blue',
  ),
  'finance.expense_category_deleted': entry(
    "Xarajat kategoriyasi o'chirildi",
    'finance',
    'delete',
    'red',
  ),
  'finance.balance_update': entry(
    "Balans o'zgartirildi",
    'finance',
    'calculator',
    'amber',
  ),
  'investor.profit_calculated': entry(
    'Investor foydasi hisoblandi',
    'finance',
    'calculator',
    'cyan',
  ),
  'ai.cap.raise': entry(
    'AI kunlik limiti oshirildi',
    'finance',
    'arrow-up',
    'amber',
  ),

  // ---- kirish ----
  'auth.otp_requested': entry("SMS kod so'raldi", 'auth', 'message', 'slate'),
  'auth.otp_verified': entry('SMS kod tasdiqlandi', 'auth', 'check', 'green'),

  // ---- filial ----
  'branch.transfer_batch_create': entry(
    "Jo'natma yaratildi",
    'branch',
    'send',
    'blue',
  ),
  'branch.return_batch_create': entry(
    "Qaytarish jo'natmasi yaratildi",
    'branch',
    'undo',
    'amber',
  ),
  'branch.post_dispatch': entry("Pochta jo'natildi", 'branch', 'send', 'blue'),
  'branch.config_set': entry(
    "Filial sozlamasi o'zgardi",
    'branch',
    'setting',
    'slate',
  ),
  courier_transfer: entry("Kuryer o'tkazildi", 'branch', 'swap', 'blue'),
  courier_transfer_reverted: entry(
    "Kuryer o'tkazmasi qaytarildi",
    'branch',
    'undo',
    'amber',
  ),
  courier_transfer_revert_failed: entry(
    "Kuryer o'tkazmasini qaytarib bo'lmadi",
    'branch',
    'warning',
    'red',
  ),

  // ---- logistika ----
  'logistics.post_assign_orders': entry(
    'Pochtaga buyurtmalar biriktirildi',
    'logistics',
    'link',
    'blue',
  ),
  'logistics.post_auto_batch': entry(
    "Avtomatik pochta yig'ildi",
    'logistics',
    'group',
    'cyan',
  ),
  'logistics.return_approve': entry(
    'Qaytarish tasdiqlandi',
    'logistics',
    'check',
    'green',
  ),
  'logistics.return_reject': entry(
    'Qaytarish rad etildi',
    'logistics',
    'close',
    'red',
  ),
  'logistics.sato_bulk_apply': entry(
    "SATO kodlari ommaviy qo'llandi",
    'logistics',
    'sync',
    'violet',
  ),
  // (DAqXPeSy) yetkazish narxi — tarif versiyasi va formula sozlamalari.
  'logistics.delivery_tariff_created': entry(
    'Yetkazish tarifining yangi versiyasi',
    'logistics',
    'tag',
    'amber',
  ),
  'logistics.delivery_pricing_settings_updated': entry(
    "Yetkazish narxi sozlamalari o'zgardi",
    'logistics',
    'setting',
    'amber',
  ),
  // (hY7uacJu) ombor moduli — kirim va inventarizatsiya (catalog-service).
  'warehouse.stock_in': entry('Omborga kirim', 'logistics', 'upload', 'green'),
  'warehouse.inventory': entry(
    'Ombor inventarizatsiyasi',
    'logistics',
    'calculator',
    'amber',
  ),
  // (XtcEyQjb) market o'z operatoriga «Ombordagi qoldiq»ni ochdi/yopdi (identity).
  'identity.market_operator_warehouse_access_changed': entry(
    "Operatorning ombor qoldig'i ruxsati o'zgardi",
    'auth',
    'key',
    'amber',
  ),
  /**
   * (ILq3WNL1) Muvaffaqiyatli birlashtirish — alohida amal (ilgari oddiy
   * `deleted` + `new_value.merged_into` edi: jurnalda topib/filtrlab
   * bo'lmasdi). Eski `deleted` + `merged_into` yozuvlari migratsiyasiz
   * qoladi (o'tmish o'zgartirilmaydi). ru/en — FE i18n: «Район объединён» /
   * «District merged».
   */
  'district.merge': entry('Tuman birlashtirildi', 'logistics', 'link', 'green'),
  // (ILq3WNL1) ru/en — FE i18n: «Объединение района не завершено» /
  // «District merge incomplete».
  'district.merge_compensation_failed': entry(
    'Tuman birlashtirish chala qoldi',
    'logistics',
    'warning',
    'red',
  ),

  // ---- bildirishnoma ----
  'notification.dispatched': entry(
    'Bildirishnoma yuborildi',
    'notification',
    'bell',
    'blue',
  ),
  'notification.campaign.created': entry(
    'Kampaniya yaratildi',
    'notification',
    'send',
    'green',
  ),
  'notification.campaign.cancelled': entry(
    'Kampaniya bekor qilindi',
    'notification',
    'stop',
    'red',
  ),
  'notification.tg_group_connected': entry(
    'Telegram guruh ulandi',
    'notification',
    'link',
    'cyan',
  ),
  // (9HIaV80X #7) bot amallari: ulash, uzish, kanal holati, callback.
  'order.extra_cost_auto_approved': entry(
    "Qo'shimcha xarajat avtomatik tasdiqlandi",
    'order',
    'clock',
    'amber',
  ),
  'notification.tg_linked': entry(
    'Telegram akkaunt ulandi',
    'notification',
    'link',
    'cyan',
  ),
  'notification.tg_unlinked': entry(
    'Telegram akkaunt uzildi',
    'notification',
    'unlink',
    'slate',
  ),
  'notification.tg_channel_inactive': entry(
    'Telegram kanali nofaol (bot chiqarildi/bloklandi)',
    'notification',
    'stop',
    'red',
  ),
  'notification.tg_channel_active': entry(
    'Telegram kanali qayta faol',
    'notification',
    'link',
    'green',
  ),
  // (ysBqD9Nx, ega qarori #3) market guruhiga yuborilgan/tahrirlangan buyurtma
  // kartasi — "kim ko'rdi" savoliga iz (qaysi guruh, qaysi buyurtma, qachon).
  'notification.tg_group_card': entry(
    'Telegram guruhiga buyurtma kartasi',
    'notification',
    'send',
    'cyan',
  ),
  'notification.tg_group_member_joined': entry(
    "Telegram guruhiga yangi a'zo qo'shildi",
    'notification',
    'user',
    'amber',
  ),
  'notification.tg_callback': entry(
    'Telegram tugmasi bosildi',
    'notification',
    'pointer',
    'blue',
  ),

  // ---- integratsiya ----
  'webhook.reprocess': entry(
    'Webhook qayta ishlandi',
    'integration',
    'sync',
    'violet',
  ),
  'webhook.payload.unmasked_view': entry(
    "Webhook ma'lumoti ochiq ko'rildi",
    'integration',
    'eye',
    'amber',
  ),
  'market.tg_token_viewed': entry(
    "Market Telegram tokeni ko'rildi",
    'integration',
    'eye',
    'amber',
  ),
  'market.tg_token_rotated': entry(
    'Market Telegram tokeni yangilandi',
    'integration',
    'key',
    'amber',
  ),
  'market.tg_token_rotated_all': entry(
    'Barcha market tokenlari yangilandi',
    'integration',
    'key',
    'red',
  ),
});

const CATEGORY_LABEL: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(ACTIVITY_ACTION_CATEGORIES.map((c) => [c.key, c.label])),
);

/** Noma'lum fe'l prefiksidan kategoriya (humanize zaxirasi uchun). */
const PREFIX_CATEGORY: ReadonlyArray<[string, ActivityActionCategory]> = [
  ['order.', 'order'],
  ['finance.', 'finance'],
  ['investor.', 'finance'],
  ['auth.', 'auth'],
  ['branch.', 'branch'],
  ['courier_', 'branch'],
  ['logistics.', 'logistics'],
  ['warehouse.', 'logistics'],
  ['district.', 'logistics'],
  ['notification.', 'notification'],
  ['webhook.', 'integration'],
  ['integration.', 'integration'],
  ['market.', 'integration'],
];

/** `"order.batch_sent"` → `"Order batch sent"` (BeePost humanize kabi). */
export function humanizeActivityAction(action: string): string {
  const words = String(action ?? '')
    .replace(/[._-]+/g, ' ')
    .trim();
  if (!words) return '-';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Bitta fe'lning ko'rinishi. Reyestrda yo'q (eski yoki yangi, lekin
 * qo'shilmagan) fe'l UI'ni sindirmaydi: humanize qilingan yorliq, prefiksdan
 * kategoriya, neytral ikona/ton va `known: false`.
 */
export function describeActivityAction(action: string): ActivityActionMeta {
  const key = String(action ?? '');
  const info = ACTIVITY_ACTION_REGISTRY[key];
  if (info) {
    return {
      action: key,
      ...info,
      category_label: CATEGORY_LABEL[info.category],
      known: true,
    };
  }
  const category =
    PREFIX_CATEGORY.find(([prefix]) => key.startsWith(prefix))?.[1] ??
    'general';
  return {
    action: key,
    label: humanizeActivityAction(key),
    category,
    category_label: CATEGORY_LABEL[category],
    icon: 'dot',
    tone: 'slate',
    known: false,
  };
}

/** Reyestrdagi barcha fe'llar — kategoriya tartibida, ichida yorliq bo'yicha. */
export function listActivityActions(): ActivityActionMeta[] {
  const order = new Map(ACTIVITY_ACTION_CATEGORIES.map((c, i) => [c.key, i]));
  return Object.keys(ACTIVITY_ACTION_REGISTRY)
    .map((action) => describeActivityAction(action))
    .sort(
      (a, b) =>
        (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) ||
        a.label.localeCompare(b.label) ||
        a.action.localeCompare(b.action),
    );
}

/**
 * i6Nyedea — QISQA saqlanadigan kirish hodisalari (login/logout/auth_failure
 * + OTP). Qolgan hamma fe'l (moliya, buyurtma, investor, settlement ...)
 * UZUN muddatda saqlanadi. Reyestrdagi `auth` kategoriyasidan olinadi —
 * yangi kirish fe'li qo'shilsa avtomatik qisqa muddatga tushadi.
 */
export const ACTIVITY_LOG_AUTH_ACTIONS: ReadonlyArray<string> = Object.freeze(
  Object.entries(ACTIVITY_ACTION_REGISTRY)
    .filter(([, info]) => info.category === 'auth')
    .map(([action]) => action)
    .sort(),
);
