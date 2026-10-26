import * as Joi from 'joi';

/**
 * Reject obviously low-entropy / placeholder secrets at boot. A 32+ char random
 * hex/base64 secret easily passes; the doc-placeholder values and repeated
 * characters do not. Fail-fast beats a weak AES key silently shipping.
 */
const rejectWeakSecret: Joi.CustomValidator<string> = (value, helpers) => {
  const v = String(value);
  if (
    /replace|change[_-]?me|example|placeholder|your[_-]?secret|^secret$|^password$|minioadmin/i.test(
      v,
    )
  ) {
    return helpers.error('any.invalid');
  }
  if (/^(.)\1+$/.test(v)) {
    return helpers.error('any.invalid'); // all the same character
  }
  if (new Set(v).size < 10) {
    return helpers.error('any.invalid'); // too few distinct characters
  }
  return value;
};

/**
 * Reject obviously weak / default admin passwords (e.g. `superadmin123`,
 * `admin`, `change_me`). Less strict than rejectWeakSecret (a human-typed
 * password need not be high-entropy hex), but blocks the shipped placeholders.
 */
const rejectWeakPassword: Joi.CustomValidator<string> = (value, helpers) => {
  const v = String(value);
  if (
    /^(superadmin|admin|password|change[_-]?me|qwerty|123|test)/i.test(v) ||
    /(123456|password|superadmin123|admin123)/i.test(v)
  ) {
    return helpers.error('any.invalid');
  }
  return value;
};

/** Strong signing/encryption key: >=32 chars, high entropy, not a placeholder. */
const strongKey = (description: string) =>
  Joi.string()
    .min(32)
    .custom(rejectWeakSecret, 'weak-secret check')
    .required()
    .description(description)
    .messages({
      'any.invalid':
        'looks weak/placeholder. Generate a strong value: openssl rand -hex 32',
      'string.min': 'must be at least 32 characters of random entropy',
    });

/**
 * Observability env keys shared by every service (all call initSentry + use the
 * Pino logger). Optional — absence is tolerated (Sentry no-ops) — but validated
 * so a typo'd DSN or an invalid LOG_LEVEL fails fast at boot.
 * (Audit observability P1: SENTRY_DSN / LOG_LEVEL were unvalidated.)
 */
const observabilityKeys = {
  SENTRY_DSN: Joi.string().uri().allow('').optional(),
  SENTRY_ENVIRONMENT: Joi.string().optional(),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .optional(),
};

export const gatewayValidationSchema = Joi.object({
  ...observabilityKeys,
  PORT: Joi.number().default(2004),
  ACCESS_TOKEN_KEY: strongKey(
    'JWT access-token signing key. MUST match identity-service. A weak key allows forging a JWT for any role (full account takeover).',
  ),
  ACCESS_TOKEN_TIME: Joi.string().default('1h'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
  RABBITMQ_ORDER_QUEUE: Joi.string().required(),
  // Gateway's own consumer queue for realtime.notify → socket.io push. Optional:
  // when unset the hybrid consumer is skipped and only client↔client chat works.
  RABBITMQ_GATEWAY_QUEUE: Joi.string().optional(),
  RABBITMQ_CATALOG_QUEUE: Joi.string().required(),
  RABBITMQ_LOGISTICS_QUEUE: Joi.string().required(),
  RABBITMQ_FINANCE_QUEUE: Joi.string().required(),
  RABBITMQ_NOTIFICATION_QUEUE: Joi.string().required(),
  // (uCrzrElu) Telegram webhook sekreti — `POST /telegram/webhook/:botSlug`
  // `X-Telegram-Bot-Api-Secret-Token` bilan timingSafeEqual solishtiradi.
  // Bo'sh bo'lsa webhook yo'li YOPIQ (hamma so'rov 401) — bot o'chiq.
  TELEGRAM_WEBHOOK_SECRET: Joi.string()
    .pattern(/^[A-Za-z0-9_-]{16,256}$/)
    .allow('')
    .optional(),
  TELEGRAM_BOT_SLUG: Joi.string()
    .pattern(/^[a-z0-9_-]{1,32}$/)
    .default('elchi'),
  RABBITMQ_INTEGRATION_QUEUE: Joi.string().required(),
  RABBITMQ_ANALYTICS_QUEUE: Joi.string().required(),
  RABBITMQ_BRANCH_QUEUE: Joi.string().required(),
  RABBITMQ_INVESTOR_QUEUE: Joi.string().required(),
  RABBITMQ_FILE_QUEUE: Joi.string().required(),
  RABBITMQ_C2C_QUEUE: Joi.string().required(),
  RABBITMQ_SEARCH_QUEUE: Joi.string().required(),
  // Global throttle: how many requests per IP within the window (ms).
  // Auth endpoints (login/refresh) override these with stricter limits.
  THROTTLE_TTL_MS: Joi.number().integer().min(1000).default(60_000),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(60),
  // fix3 C10 (RBAC-11): login — 30/daqiqa/IP (ilgari 10). Haqiqiy qiymatni
  // auth-gateway.controller.ts `authThrottleConfig()` process.env dan o'qiydi
  // (@Throttle metadata klass yuklanganda, Joi sukutidan OLDIN) — bu yerdagi
  // sukutlar u bilan AYNI bo'lishi shart.
  AUTH_THROTTLE_TTL_MS: Joi.number().integer().min(1000).default(60_000),
  AUTH_THROTTLE_LIMIT: Joi.number().integer().min(1).default(30),
  // Refresh — login'dan ALOHIDA, 60/daqiqa/IP. `.empty('')`: qiymatsiz
  // yozilgan kalit gateway'ni yiqitmasin (kod ham bo'sh qiymatda sukutga tushadi).
  AUTH_REFRESH_THROTTLE_LIMIT: Joi.number()
    .integer()
    .min(1)
    .empty('')
    .default(60),
  AUTH_REFRESH_THROTTLE_TTL_MS: Joi.number()
    .integer()
    .min(1000)
    .empty('')
    .default(60_000),
  // R6R8BLGA: skaner route'lari (GET /scan/:token, POST /orders/receive,
  // POST /orders/scan-assign) — per-IP, yuqoriroq limit (filial bitta IP).
  // Haqiqiy qiymat `auth/scan-throttle.ts` `scanThrottleConfig()` da
  // (process.env, global THROTTLE_LIMIT dan past emas) — sukutlar AYNI.
  SCAN_THROTTLE_LIMIT: Joi.number().integer().min(1).empty('').default(300),
  SCAN_THROTTLE_TTL_MS: Joi.number().integer().min(1000).empty(''),
  // mSkzzNBJ: ochiq kalkulyator (POST /public/delivery-quote, GET
  // /public/delivery-tariffs) — per-IP, QATTIQROQ limit (global THROTTLE_LIMIT
  // dan yuqori emas) va qisqa javob keshi (0 — o'chiq). Haqiqiy qiymat
  // `public-delivery-pricing/public-delivery-pricing.ts` da (process.env) —
  // sukutlar AYNI.
  PUBLIC_PRICING_THROTTLE_LIMIT: Joi.number()
    .integer()
    .min(1)
    .empty('')
    .default(30),
  PUBLIC_PRICING_THROTTLE_TTL_MS: Joi.number().integer().min(1000).empty(''),
  PUBLIC_PRICING_CACHE_TTL_MS: Joi.number()
    .integer()
    .min(0)
    .max(600_000)
    .empty('')
    .default(30_000),
  // Comma-separated list of allowed browser origins for CORS.
  // localhost/127.0.0.1 are always allowed in code regardless of this value.
  CORS_ORIGINS: Joi.string().allow('').default(''),
  // Swagger UI (/api) HTTP Basic Auth credentials. In production Swagger is
  // served only when SWAGGER_PASSWORD is set, and always behind Basic Auth.
  SWAGGER_USER: Joi.string().default('admin'),
  SWAGGER_PASSWORD: Joi.string().allow('').default(''),
  /**
   * AI buyurtma (ai-service) navbati.
   *
   * ⚠️ `required()` EMAS, ataylab `default`. Barcha servislar BITTA
   * `.env.production` ni o'qiydi — kalit yozilmay qolsa butun API
   * (gateway) yiqilmasligi kerak; AI yo'li shunchaki standart navbatga ulanadi.
   *
   * ⚠️ Barcha AI kalitlarida `.empty('')`: `.env.production` da qiymatsiz
   * yozilgan kalit (`AI_ORDER_ENABLED=`) Joi xatosi bilan butun gateway'ni
   * yiqitmasin — bo'sh qiymat sukutga tushadi (AI_ORDER_ENABLED uchun `false`).
   */
  RABBITMQ_AI_QUEUE: Joi.string().empty('').default('ai_queue'),
  /**
   * AI buyurtma operatsion o'chirgichi (kill switch). `false` bo'lsa
   * `POST /orders/ai-parse` Anthropic'ga bormasdan 200 `{ok:false,
   * reason:'disabled'}` qaytaradi. `ai-confirm` bunga BOG'LANMAGAN — qo'lda
   * tahrirlangan buyurtmalarni qabul qilish ishlayveradi.
   *
   * ⚠️ Sukut `false`: birinchi deploy "qorong'i" chiqadi, E2E'dan keyin
   * `true` qilinadi (faqat api-gateway qayta yaratiladi).
   */
  AI_ORDER_ENABLED: Joi.boolean()
    .truthy('true', '1', 'yes')
    .falsy('false', '0', 'no')
    .empty('')
    .default(false)
    .description(
      "AI buyurtma kill switch. false — ai-parse 'disabled' qaytaradi, ai-confirm ishlayveradi.",
    ),
  // `ai-parse` uchun FOYDALANUVCHI (JWT sub) bo'yicha limit: TTL oynasida nechta
  // so'rov. Bu global per-IP THROTTLE_* ni o'zgartirmaydi — alohida 'ai-user'
  // throttler (UserThrottlerGuard) ishlatadi.
  AI_PARSE_THROTTLE_LIMIT: Joi.number().integer().min(1).empty('').default(10),
  AI_PARSE_THROTTLE_TTL_MS: Joi.number()
    .integer()
    .min(1000)
    .empty('')
    .default(60_000),
  // ⚠️ ANTHROPIC_API_KEY bu yerda ATAYLAB YO'Q: gateway kalitni ushlamaydi va
  // noto'g'ri formatdagi kalit butun API'ni yiqitmasligi kerak. Kalit faqat
  // `aiValidationSchema` da (pastda) tekshiriladi.
});

export const identityValidationSchema = Joi.object({
  ...observabilityKeys,
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('identity_schema'),
  ACCESS_TOKEN_KEY: strongKey(
    'JWT access-token signing key. MUST match api-gateway. A weak key allows forging a JWT for any role (full account takeover).',
  ),
  ACCESS_TOKEN_TIME: Joi.string().default('1h'),
  // (xC88d8kH) Telegram Mini App / bot aktori tokeni — qisqa, refresh yo'q.
  TELEGRAM_ACCESS_TOKEN_TIME: Joi.string().default('30m'),
  // initData imzosini tekshirish uchun (notification-service bilan bir xil token).
  TELEGRAM_BOT_TOKEN: Joi.string().allow('').optional(),
  REFRESH_TOKEN_KEY: strongKey(
    'JWT refresh-token signing key. A weak key allows minting refresh tokens (persistent account takeover).',
  ),
  REFRESH_TOKEN_TIME: Joi.string().default('1d'),
  // (Elchi Pochta #3, 2026-10-23) Yaratilganiga shuncha soat to'lmagan
  // sessiya boshqa sessiyalarni yopa olmaydi (403 SESSION_TOO_NEW); 0 — o'chiq.
  SESSION_REVOKE_LOCK_HOURS: Joi.number().min(0).max(8760).default(48),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
  RABBITMQ_LOGISTICS_QUEUE: Joi.string().required(),
  SUPERADMIN_NAME: Joi.string().required(),
  SUPERADMIN_PHONE_NUMBER: Joi.string().required(),
  SUPERADMIN_PASSWORD: Joi.string()
    .min(12)
    .custom(rejectWeakPassword, 'weak-password check')
    .required()
    .messages({
      'any.invalid':
        'SUPERADMIN_PASSWORD is a known weak/default password. Use a strong, unique password (>=12 chars).',
      'string.min': 'SUPERADMIN_PASSWORD must be at least 12 characters.',
    }),
  // ── OTP (rkz0yBxr). SMS notification-service orqali ketadi.
  RABBITMQ_NOTIFICATION_QUEUE: Joi.string().default('notification_queue'),
  // (Elchi Pochta #3, 2026-10-24) gateway navbati — identity yopgan
  // sessiyalarni (`security_reset`) `auth.sessions.kick` bilan e'lon qiladi,
  // gateway ularning socketlarini uzadi. Ixtiyoriy: bo'sh — e'lon yo'q.
  RABBITMQ_GATEWAY_QUEUE: Joi.string().allow('').optional(),
  // Kod va raqam hash'i uchun kalit; berilmasa ACCESS_TOKEN_KEY ishlatiladi.
  OTP_HASH_SECRET: Joi.string()
    .min(32)
    .custom(rejectWeakSecret, 'weak-secret check')
    .allow('')
    .optional(),
  OTP_TTL_SECONDS: Joi.number().integer().min(60).max(1800).default(300),
  OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(5),
  OTP_RESEND_SECONDS: Joi.number().integer().min(10).default(60),
  OTP_HOURLY_LIMIT: Joi.number().integer().min(1).default(5),
  OTP_DAILY_LIMIT: Joi.number().integer().min(1).default(10),
});

export const orderValidationSchema = Joi.object({
  ...observabilityKeys,
  // (1tnpaIqd, ega qarori) market javob bermasa qo'shimcha xarajat shuncha
  // daqiqadan keyin AVTOMATIK tasdiqlanadi; berilmasa — o'chiq.
  EXTRA_COST_AUTO_APPROVE_MINUTES: Joi.number().integer().min(1).optional(),
  EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES: Joi.number()
    .integer()
    .min(1)
    .default(10),
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('order_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_ORDER_QUEUE: Joi.string().required(),
  // (OA16fdSq/ePpLHPX2) Hodisa → bildirishnoma outbox maqsadi (NOTIFICATION).
  RABBITMQ_NOTIFICATION_QUEUE: Joi.string().default('notification_queue'),
  RABBITMQ_SEARCH_QUEUE: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
  RABBITMQ_LOGISTICS_QUEUE: Joi.string().required(),
  RABBITMQ_CATALOG_QUEUE: Joi.string().required(),
  RABBITMQ_FILE_QUEUE: Joi.string().required(),
  // `ai.product.disambiguate` (mahsulotni LLM bilan aniqlashtirish) shu navbat
  // orqali ai-service'ga boradi. `required()` emas — kalit yo'q bo'lsa ham
  // order-service ko'tariladi.
  RABBITMQ_AI_QUEUE: Joi.string().empty('').default('ai_queue'),
});

export const catalogValidationSchema = Joi.object({
  ...observabilityKeys,
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('catalog_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_CATALOG_QUEUE: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
  // hY7uacJu: ombor moduli — filial va tuman → hudud o'qish.
  RABBITMQ_BRANCH_QUEUE: Joi.string().default('branch_queue'),
  RABBITMQ_LOGISTICS_QUEUE: Joi.string().default('logistics_queue'),
});

export const logisticsValidationSchema = Joi.object({
  ...observabilityKeys,
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('logistics_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_LOGISTICS_QUEUE: Joi.string().required(),
  // (OA16fdSq/ePpLHPX2) Hodisa → bildirishnoma outbox maqsadi (NOTIFICATION).
  RABBITMQ_NOTIFICATION_QUEUE: Joi.string().default('notification_queue'),
  RABBITMQ_ORDER_QUEUE: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
  RABBITMQ_SEARCH_QUEUE: Joi.string().required(),
  // (DAqXPeSy) Yetkazish narxi — mahsulot o'lchovini catalog'dan o'qish.
  RABBITMQ_CATALOG_QUEUE: Joi.string().default('catalog_queue'),
});

export const financeValidationSchema = Joi.object({
  ...observabilityKeys,
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('finance_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_FINANCE_QUEUE: Joi.string().required(),
  // (OA16fdSq/ePpLHPX2) Hodisa → bildirishnoma outbox maqsadi (NOTIFICATION).
  RABBITMQ_NOTIFICATION_QUEUE: Joi.string().default('notification_queue'),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
  // (rWdLuoP3) Gateway navbati — smena / kassa kartasi realtime hodisalari
  // (outbox → `realtime.notify`). Ixtiyoriy: bo'sh — hodisa yozilmaydi.
  RABBITMQ_GATEWAY_QUEUE: Joi.string().allow('').optional(),
  // (2crjWf7v #2) Kuryer kassasidagi naqd shu summadan (so'm) OSHSA kuniga
  // bir marta "filialga topshiring" eslatmasi. Bo'sh / 0 — o'chiq.
  COURIER_CASH_REMINDER_THRESHOLD: Joi.number().min(0).allow('').optional(),
  // Eslatma soati (Asia/Tashkent, 0-23). Sukut 18:00.
  COURIER_CASH_REMINDER_HOUR: Joi.number().integer().min(0).max(23).default(18),
});

export const notificationValidationSchema = Joi.object({
  ...observabilityKeys,
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('notification_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_NOTIFICATION_QUEUE: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
  RABBITMQ_ORDER_QUEUE: Joi.string().required(),
  // Optional: gateway queue for realtime socket.io push. When unset, in-app
  // notifications are still persisted; only the live push is skipped.
  RABBITMQ_GATEWAY_QUEUE: Joi.string().optional(),
  // (DuST9k8j) isbot fayllari (file.read) — Telegram DM'ga biriktirish.
  RABBITMQ_FILE_QUEUE: Joi.string().optional(),
  TELEGRAM_BOT_TOKEN: Joi.string().optional(),
  // (rzGKtE9N #4 / TgYRqaTk #4) Admin Telegram guruhi (chat id, odatda
  // manfiy). IXTIYORIY: bo'sh env bilan boot yiqilmaydi. TELEGRAM_ADMIN_GROUP_ID
  // — eski nom (sinonim).
  NOTIFICATION_ADMIN_GROUP_ID: Joi.string()
    .pattern(/^-?\d{1,20}$/)
    .allow('')
    .optional(),
  TELEGRAM_ADMIN_GROUP_ID: Joi.string()
    .pattern(/^-?\d{1,20}$/)
    .allow('')
    .optional(),
  // (rCFZAmOz) Shaxsiy Telegram ulash: deep link uchun bot username (@siz).
  // TELEGRAM_LINK_SECRET endi ISHLATILMAYDI (6jXw0DDr: bir martalik DB kodi)
  // — mavjud .env lar buzilmasligi uchun sxemada qoldi.
  TELEGRAM_BOT_USERNAME: Joi.string().allow('').optional(),
  TELEGRAM_LINK_SECRET: Joi.string()
    .min(32)
    .custom(rejectWeakSecret, 'weak-secret check')
    .allow('')
    .optional(),
  // (ZlpXb4Wh, ega qarori 2026-09-20) BITTA bot, BITTA token: eski
  // order-create boti shu yadroga birlashtirildi. ORDER_BOT_TOKEN endi
  // ISHLATILMAYDI (berilsa startda bir marta WARN). WebApp havolasi qoladi.
  ORDER_BOT_TOKEN: Joi.string().allow('').optional(),
  ORDER_BOT_WEBAPP_URL: Joi.string().uri().allow('').optional(),
  // (MWYaqprw) Kuryer skan Mini App'i (`/tg/scan`). Berilsa `/ishim` da
  // "📷 Skaner" (web_app) tugmasi chiqadi; URL'ga token QO'YILMAYDI — Mini App
  // initData bilan `POST /auth/telegram` dan JWT oladi. Frontend ekrani
  // chiqmaguncha bo'sh qoldiriladi (tugma ko'rinmaydi).
  TELEGRAM_SCAN_WEBAPP_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .allow('')
    .optional(),
  // (Mvx0h1Fv / uCrzrElu) bot transporti. Sukut — `auto`: token va webhook
  // sekreti bo'lsa `webhook`; token yo'q/placeholder bo'lsa `off`. `polling`
  // faqat zaxira va faqat BOT_POLLING_LEADER=true bo'lgan bitta konteynerda.
  // (h9newLsd / z2FRwu2c) "🌐 Kabinetda ochish" tugmalari uchun panel manzili.
  ELCHI_CABINET_URL: Joi.string()
    .uri({ scheme: ['https', 'http'] })
    .default('https://admin.elchipochta.uz'),
  // (4BirMSVp) Kuryer kunlik hisobotining avtomatik vaqti (Asia/Tashkent,
  // sekund maydoni bilan: `0 0 21 * * *`). Bo'sh — o'chiq (faqat /kun).
  COURIER_DAILY_REPORT_CRON: Joi.string().allow('').optional(),
  // (xC88d8kH #3) bot aktori nomidan mavjud gateway endpointlari (ichki tarmoq).
  ELCHI_GATEWAY_INTERNAL_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://api-gateway:3004'),
  TELEGRAM_BOT_MODE: Joi.string()
    .valid('auto', 'webhook', 'polling', 'off')
    .default('auto'),
  BOT_POLLING_LEADER: Joi.boolean().truthy('1').falsy('0').default(false),
  // Webhook URL'idagi `:botSlug` (bitta bot — bitta slug).
  TELEGRAM_BOT_SLUG: Joi.string()
    .pattern(/^[a-z0-9_-]{1,32}$/)
    .default('elchi'),
  // `X-Telegram-Bot-Api-Secret-Token` (setWebhook secret_token): 1–256
  // belgi, [A-Za-z0-9_-]. Gateway shu bilan solishtiradi.
  TELEGRAM_WEBHOOK_SECRET: Joi.string()
    .pattern(/^[A-Za-z0-9_-]{16,256}$/)
    .allow('')
    .optional(),
  // Web Push (VAPID). Hammasi ixtiyoriy: kalitsiz servis baribir ko'tariladi,
  // faqat push o'chiq bo'ladi (startda WARN). Juftlik BIR MARTA yaratiladi —
  // qayta yaratilsa barcha mavjud obunalar o'ladi.
  VAPID_PUBLIC_KEY: Joi.string().allow('').optional(),
  VAPID_PRIVATE_KEY: Joi.string().allow('').optional(),
  VAPID_SUBJECT: Joi.string()
    .pattern(/^(mailto:|https:\/\/)/)
    .allow('')
    .optional(),
  // ── SMS (3fRbyadQ, 8auPBa1O, sVByLMnt). Sukutlar XAVFSIZ: SMS_ENABLED=false.
  SMS_ENABLED: Joi.boolean()
    .truthy('true', '1')
    .falsy('false', '0')
    .default(false),
  SMS_PROVIDER: Joi.string().valid('eskiz', 'playmobile').default('eskiz'),
  SMS_DAILY_CAP: Joi.number().integer().min(0).default(500),
  // (rkz0yBxr) OTP (security) — ALOHIDA kunlik kvota: reklama/tranzaksion SMS
  // OTP kvotasini yemaydi va aksincha (login oqimi reklama bilan birga o'lmasin).
  SMS_OTP_DAILY_CAP: Joi.number().integer().min(0).default(500),
  SMS_MAX_FANOUT: Joi.number().integer().min(1).default(200),
  SMS_CRON_ENABLED: Joi.boolean()
    .truthy('true', '1')
    .falsy('false', '0')
    .default(true),
  SMS_CRON_EXPR: Joi.string().optional(),
  SMS_BATCH_SIZE: Joi.number().integer().min(1).max(500).optional(),
  // Bir bo'lak narxi (so'm). Berilmasa narx NULL — "tarif sozlanmagan", 0 emas.
  SMS_TARIFF_TRANSACTIONAL: Joi.number().min(0).allow('').optional(),
  SMS_TARIFF_PROMO: Joi.number().min(0).allow('').optional(),
  // Kredensiallarni DB'da shifrlash kaliti (openssl rand -hex 32).
  SMS_CREDENTIAL_SECRET: Joi.string()
    .min(32)
    .custom(rejectWeakSecret, 'weak-secret check')
    .allow('')
    .optional(),
  SMS_CREDENTIAL_SECRET_PREVIOUS: Joi.string()
    .min(32)
    .custom(rejectWeakSecret, 'weak-secret check')
    .allow('')
    .optional(),
  // (n0kLbx3d) telegram_markets.token ni DB'da shifrlash kaliti — 32 bayt
  // (openssl rand -hex 32). Formatni cipher start'da ham tekshiradi; bo'sh
  // bo'lsa kalit boshqa maxfiy env'dan hosil qilinadi (WARN).
  TELEGRAM_TOKEN_ENC_KEY: Joi.string()
    .pattern(/^(?:[0-9a-fA-F]{64}|[A-Za-z0-9+/_-]{43}=?)$/)
    .allow('')
    .optional(),
  TELEGRAM_TOKEN_ENC_KEY_PREVIOUS: Joi.string()
    .pattern(/^(?:[0-9a-fA-F]{64}|[A-Za-z0-9+/_-]{43}=?)$/)
    .allow('')
    .optional(),
  // DLR va opt-out havolalarini imzolovchi sir (faqat notification-service'da).
  SMS_DLR_SECRET: Joi.string()
    .min(32)
    .custom(rejectWeakSecret, 'weak-secret check')
    .allow('')
    .optional(),
  SMS_DLR_CALLBACK_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .allow('')
    .optional(),
  SMS_OPT_OUT_BASE_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .allow('')
    .optional(),
  // (7Ec56EIw / Jht84wGp) CRITICAL xabar shuncha daqiqada o'qilmasa va push
  // yetmagan bo'lsa — SMS eskalatsiyasi (ATIGI BIR MARTA). 0 — o'chiq.
  // SMS faqat SMS_ENABLED=true bo'lsa ketadi.
  NOTIF_ESCALATION_MINUTES: Joi.number().integer().min(0).max(1440).default(10),
  // (7Ec56EIw #4) Onlayn (socket ulangan) foydalanuvchiga push yubormaslik —
  // gateway `realtime.presence.check` patterni deploy qilinguncha false.
  NOTIF_PUSH_PRESENCE_CHECK: Joi.boolean()
    .truthy('true', '1')
    .falsy('false', '0')
    .default(false),
  // (A1HzKEby #4) Bo'ron chegarasi: bir foydalanuvchiga bir TURDAGI xabar
  // oxirgi 1 soatda shuncha qatordan oshsa — yangi qator o'rniga eng oxirgi
  // qator yangilanadi (`data.count` oshadi). CRITICAL — chegarasiz. 0 — o'chiq.
  NOTIF_HOURLY_CAP_PER_TYPE: Joi.number().integer().min(0).default(30),
  // (A1HzKEby #3) Inbox retention — kunlik cron PARTIYALAB o'chiradi.
  // ⚠️ Sukut O'CHIQ: yoqishdan oldin NOTIF_RETENTION_DRY_RUN=true bilan
  // nechta qator ketishini logdan o'lchang. `priority=critical` HECH QACHON
  // o'chirilmaydi; o'qilmaganlar muddati o'qilganlarnikidan uzun bo'lishi shart.
  NOTIF_RETENTION_ENABLED: Joi.boolean()
    .truthy('true', '1')
    .falsy('false', '0')
    .default(false),
  NOTIF_RETENTION_DRY_RUN: Joi.boolean()
    .truthy('true', '1')
    .falsy('false', '0')
    .default(false),
  NOTIF_RETENTION_READ_DAYS: Joi.number().integer().min(7).default(60),
  NOTIF_RETENTION_UNREAD_DAYS: Joi.number().integer().min(8).default(180),
  NOTIF_RETENTION_BATCH_SIZE: Joi.number()
    .integer()
    .min(100)
    .max(10000)
    .default(5000),
  NOTIF_RETENTION_MAX_BATCHES: Joi.number()
    .integer()
    .min(1)
    .max(10000)
    .default(200),
  NOTIF_RETENTION_CRON_EXPR: Joi.string().default('0 30 3 * * *'),
  // Reklama taqiq oynasi (Toshkent vaqti), qonun soatlari o'zgarishi mumkin.
  NOTIF_PROMO_QUIET_HOURS: Joi.string()
    .pattern(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/)
    .default('18:00-09:00'),
  SMS_CONSENT_TTL_DAYS: Joi.number().integer().min(1).optional(),
  SMS_BALANCE_ALERT_THRESHOLD: Joi.number().min(0).allow('').optional(),
  SMS_BALANCE_CRON_EXPR: Joi.string().optional(),
  SMS_ALERT_RECIPIENT_IDS: Joi.string().allow('').optional(),
});

export const integrationValidationSchema = Joi.object({
  ...observabilityKeys,
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('integration_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_INTEGRATION_QUEUE: Joi.string().required(),
  INTEGRATION_CREDENTIAL_SECRET: Joi.string()
    .min(32)
    .custom(rejectWeakSecret, 'weak-secret check')
    .required()
    .description(
      'Primary secret used to AES-encrypt external integration credentials in DB. Must be >=32 chars of random entropy (openssl rand -hex 32), not a passphrase/placeholder.',
    )
    .messages({
      'any.invalid':
        'INTEGRATION_CREDENTIAL_SECRET looks weak/placeholder. Use: openssl rand -hex 32',
    }),
  INTEGRATION_CREDENTIAL_SECRET_PREVIOUS: Joi.string()
    .min(32)
    .custom(rejectWeakSecret, 'weak-secret check')
    .optional()
    .description(
      'Optional previous secret. During rotation: set both vars, then trigger a re-encrypt pass; rows decrypted with the previous key are re-encrypted with the primary on next save. Remove this var once all rows are migrated.',
    ),
  // SSRF guard escape hatch. When true, outbound integration requests may target
  // private/loopback/metadata hosts (dev/testing only). Default false.
  INTEGRATION_ALLOW_PRIVATE_HOSTS: Joi.boolean()
    .truthy('true', '1', 'yes')
    .falsy('false', '0', 'no')
    .default(false)
    .description(
      'Dev/testing only. Set true to allow integrations to call private/loopback hosts. Keep false in production.',
    ),
  // When true, reject signature-valid webhooks lacking a delivery id (for
  // providers that declared a webhook_id_header) so replay protection is always on.
  INTEGRATION_REQUIRE_DELIVERY_ID: Joi.boolean()
    .truthy('true', '1', 'yes')
    .falsy('false', '0', 'no')
    .default(false)
    .description(
      'Enforce that webhook deliveries carry the configured id header (replay protection). Default false (warn only).',
    ),
  // Sync queue scheduler. The processor itself is HA-safe (pg_try_advisory_lock
  // inside processPendingSyncQueue), so multiple replicas can run the cron
  // safely — only one will hold the lock per tick.
  INTEGRATION_SYNC_CRON_ENABLED: Joi.boolean()
    .truthy('true', '1', 'yes')
    .falsy('false', '0', 'no')
    .default(true)
    .description(
      'Master switch. Set false to disable auto-processing (e.g. during incident response) — manual integration.sync.trigger still works.',
    ),
  INTEGRATION_SYNC_CRON_EXPR: Joi.string()
    .default('*/30 * * * * *')
    .description(
      'Cron expression for the sync queue tick. Default: every 30 seconds (matches PCS).',
    ),
  INTEGRATION_SYNC_BATCH_SIZE: Joi.number()
    .integer()
    .min(1)
    .max(500)
    .default(20)
    .description(
      'Max items processed per tick. Higher = lower latency under burst, more DB load per tick.',
    ),
  // Ochiq posilkalar solishtiruvchisi (DOZ6dtJn). HA-safe: alohida
  // pg_try_advisory_lock (reconcileDueIntegrations) ostida ishlaydi.
  INTEGRATION_RECONCILE_CRON_ENABLED: Joi.boolean()
    .truthy('true', '1', 'yes')
    .falsy('false', '0', 'no')
    .default(true)
    .description(
      "Master switch for the periodic reconciler. false — only manual 'Hoziroq tenglashtirish' works.",
    ),
  INTEGRATION_RECONCILE_CRON_EXPR: Joi.string()
    .default('0 */15 * * * *')
    .description(
      'Cron expression for the reconcile tick. Default: every 15 minutes.',
    ),
  INTEGRATION_RECONCILE_BATCH_SIZE: Joi.number()
    .integer()
    .min(1)
    .max(1000)
    .default(200)
    .description('Max open shipments queried per integration per tick.'),
  // awaiting_config hamkor webhooklari uchun kunlik yig'ma ogohlantirish
  // (vy9gakYq). Server UTC da: 04:00 UTC = 09:00 Toshkent.
  INTEGRATION_WEBHOOK_DIGEST_CRON_ENABLED: Joi.boolean()
    .truthy('true', '1', 'yes')
    .falsy('false', '0', 'no')
    .default(true)
    .description(
      'Daily admin digest of partner webhooks stuck in awaiting_config.',
    ),
  INTEGRATION_WEBHOOK_DIGEST_CRON_EXPR: Joi.string()
    .default('0 0 4 * * *')
    .description('Cron expression for the digest. Default: 09:00 Tashkent.'),
});

export const analyticsValidationSchema = Joi.object({
  ...observabilityKeys,
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_ANALYTICS_QUEUE: Joi.string().required(),
});

export const branchValidationSchema = Joi.object({
  ...observabilityKeys,
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('branch_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_BRANCH_QUEUE: Joi.string().required(),
  BRANCH_HQ_CODE: Joi.string().min(1).default('HQ-TSHKNT'),
  BRANCH_HQ_NAME: Joi.string().min(1).default('HQ Toshkent'),
  BRANCH_HQ_ADDRESS: Joi.string().allow('').default('Toshkent'),
});

export const investorValidationSchema = Joi.object({
  ...observabilityKeys,
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('investor_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_INVESTOR_QUEUE: Joi.string().required(),
});

export const fileValidationSchema = Joi.object({
  ...observabilityKeys,
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_FILE_QUEUE: Joi.string().required(),
  MINIO_ENDPOINT: Joi.string().required(),
  MINIO_PORT: Joi.number().default(9000),
  MINIO_USE_SSL: Joi.boolean().truthy('true').falsy('false').default(false),
  MINIO_ACCESS_KEY: Joi.string().required(),
  MINIO_SECRET_KEY: Joi.string()
    .min(16)
    .custom(rejectWeakSecret, 'weak-secret check')
    .required()
    .messages({
      'any.invalid':
        'MINIO_SECRET_KEY looks weak/default (e.g. minioadmin). Use: openssl rand -hex 24',
      'string.min': 'MINIO_SECRET_KEY must be at least 16 characters.',
    }),
  MINIO_BUCKET: Joi.string().default('elchi-files'),
  FILE_SIGNED_URL_EXPIRES: Joi.number().default(3600),
  // Hard upper bound on client-provided expires_in. AWS S3 max is 7 days (604800s).
  FILE_SIGNED_URL_MAX_EXPIRES: Joi.number().default(86_400),
  FILE_MAX_SIZE_MB: Joi.number().default(10),
});

export const c2cValidationSchema = Joi.object({
  ...observabilityKeys,
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('c2c_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_C2C_QUEUE: Joi.string().required(),
});

export const searchValidationSchema = Joi.object({
  ...observabilityKeys,
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('search_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_SEARCH_QUEUE: Joi.string().required(),
});

/**
 * ai-service — Anthropic'ni chaqiradigan va `ANTHROPIC_API_KEY` ni ushlaydigan
 * YAGONA jarayon. Xarajat jurnali (`ai_usage_log`) va kunlik shift hisoblagichi
 * (`ai_spend_counter`) o'z sxemasida (`ai_schema`) turadi.
 *
 * ⚠️ `.unknown(false)` QO'SHILMAYDI: barcha servislar bitta `.env.production`
 * ni o'qiydi — begona kalitlarni rad etish ai-service'ni boshqa servislarning
 * kalitlari sababli yiqitadi. Xato nomlangan kalit (masalan `ANTROPIC_API_KEY`)
 * Joi'da emas, bootstrap'da `inspectAnthropicEnv` orqali WARN bilan
 * ko'rsatiladi (faqat NOMLAR, qiymat hech qachon logga chiqmaydi).
 */
export const aiValidationSchema = Joi.object({
  ...observabilityKeys,
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('ai_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_AI_QUEUE: Joi.string().empty('').default('ai_queue'),
  // Kunlik shift 80% / 100% ga yetganda superadmin/admin'ga bildirishnoma.
  RABBITMQ_NOTIFICATION_QUEUE: Joi.string().required(),
  /**
   * Anthropic kaliti.
   *
   * - Berilmagan yoki bo'sh → servis NORMAL ko'tariladi, AI o'chiq
   *   (`ClaudeService.isEnabled() === false`, startda bitta WARN).
   * - Berilgan, lekin `sk-ant-` bilan boshlanmaydi → ai-service boot'i yiqiladi
   *   (fail-fast). Boshqa servislarga ta'sir qilmaydi — kalit faqat shu sxemada.
   *
   * ⚠️ `strongKey`/`rejectWeakSecret` va `required()` ATAYLAB ishlatilmaydi:
   * kalitsiz ishga tushish — qonuniy holat (AI o'chiq).
   *
   * ⚠️ `messages` — Joi'ning standart `string.pattern.base` xabari QIYMATNI
   * (`with value "..."`) matnga qo'shadi va u ConfigModule orqali boot logiga,
   * u yerdan Sentry'ga tushadi. Noto'g'ri formatdagi kalit ham haqiqiy sir
   * bo'lishi mumkin (masalan boshqa provayder kaliti), shuning uchun xabarda
   * faqat kalit NOMI qoladi.
   */
  ANTHROPIC_API_KEY: Joi.string()
    .trim()
    .allow('')
    .pattern(/^sk-ant-/)
    .optional()
    .messages({
      'string.pattern.base':
        "ANTHROPIC_API_KEY noto'g'ri formatda: 'sk-ant-' bilan boshlanishi kerak (qiymat xavfsizlik uchun ko'rsatilmaydi). AI'ni o'chirish uchun kalitni bo'sh qoldiring.",
    }),
  // Modellar. ⚠️ AI_ORDER_VISION_MODEL = AI_ORDER_MODEL — matn va rasm
  // chaqiruvlari bitta prompt keshini bo'lishadi (model almashsa kesh yo'qoladi).
  AI_ORDER_MODEL: Joi.string().empty('').default('claude-sonnet-5'),
  AI_ORDER_VISION_MODEL: Joi.string().empty('').default('claude-sonnet-5'),
  AI_CLASSIFY_MODEL: Joi.string().empty('').default('claude-haiku-4-5'),
  // Tuman LLM fallback'i (5Z1ZvvzE): ro'yxat system-promptda keshlanadi —
  // model minimal kesh chegarasi ro'yxatdan (~2.4k token) kichik bo'lishi
  // kerak (haiku-4-5 = 4096 → kesh yo'q, eski rejim avtomatik).
  AI_DISTRICT_MODEL: Joi.string().empty('').default('claude-sonnet-5'),
  // Pul: `ai_usage_log.cost_uzs = cost_usd × AI_USD_UZS_RATE`;
  // `applied_price_uzs` = AI_ORDER_PRICE_UZS (order_extract_* uchun).
  AI_USD_UZS_RATE: Joi.number().positive().empty('').default(12800),
  AI_ORDER_PRICE_UZS: Joi.number().min(0).empty('').default(300),
  /**
   * NFiXfmq6 — GLOBAL narx: 1 ta AI buyurtma (so'm). Market yozuvidagi
   * `ai_price_per_order` bo'sh bo'lsa shu ishlaydi; 0 — hammaga bepul.
   * Berilmasa eski `AI_ORDER_PRICE_UZS` (sukut 300) ishlatiladi — mavjud
   * deploy'lar o'zgarishsiz qoladi. Har yaratilgan AI buyurtmada amal qilgan
   * narx `ai_order_draft_item.applied_price_uzs` ga muzlatiladi.
   */
  AI_PRICE_PER_ORDER: Joi.number().min(0).empty('').optional(),
  // NFiXfmq6 marja paneli alertlari (hardcode emas): kesh hit-rate shu
  // ulushdan pastga tushsa; bitta market kunlik xarajati o'zining boshqa
  // kunlardagi o'rtachasidan shu karradan oshsa; market marjasi shu
  // summadan (so'm) past bo'lsa. Kunlik shift ogohlantirishi —
  // AI_CAP_WARN_RATIO.
  AI_ALERT_CACHE_HIT_MIN_RATIO: Joi.number()
    .min(0)
    .max(1)
    .empty('')
    .default(0.5),
  AI_ALERT_MARKET_SPIKE_FACTOR: Joi.number().greater(1).empty('').default(5),
  AI_ALERT_MARGIN_MIN_UZS: Joi.number().empty('').default(0),
  /**
   * Kunlik GLOBAL avariya shifti (USD, Toshkent sanasi bo'yicha). Oshsa
   * ai-parse `cap_exceeded` qaytaradi va Anthropic'ga so'rov KETMAYDI; qo'lda
   * buyurtma yaratish ishlayveradi. Market/foydalanuvchi kvotasi va oylik
   * shift YO'Q (ega qarori).
   */
  AI_DAILY_USD_CAP: Joi.number().positive().empty('').default(50),
  // Shiftning shu ulushida (sukut 80%) bir marta ogohlantirish yuboriladi.
  AI_CAP_WARN_RATIO: Joi.number().min(0.1).max(0.99).empty('').default(0.8),
  // SUPERADMIN'ning bir kunlik "shiftni ko'tarish" amali uchun yuqori chegara.
  AI_CAP_RAISE_MAX_USD: Joi.number().positive().empty('').default(50),
  // ai-service navbatining prefetch'i (faqat kanal QoS). Bir vaqtda nechta
  // Anthropic chaqiruvi ochiq turishi mumkinligini cheklaydi.
  AI_RMQ_PREFETCH: Joi.number().integer().min(1).max(50).empty('').default(8),
});
