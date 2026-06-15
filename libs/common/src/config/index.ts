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

export const gatewayValidationSchema = Joi.object({
  PORT: Joi.number().default(2004),
  ACCESS_TOKEN_KEY: strongKey(
    'JWT access-token signing key. MUST match identity-service. A weak key allows forging a JWT for any role (full account takeover).',
  ),
  ACCESS_TOKEN_TIME: Joi.string().default('15m'),
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
  AUTH_THROTTLE_TTL_MS: Joi.number().integer().min(1000).default(60_000),
  AUTH_THROTTLE_LIMIT: Joi.number().integer().min(1).default(10),
  // Comma-separated list of allowed browser origins for CORS.
  // localhost/127.0.0.1 are always allowed in code regardless of this value.
  CORS_ORIGINS: Joi.string().allow('').default(''),
  // Swagger UI (/api) HTTP Basic Auth credentials. In production Swagger is
  // served only when SWAGGER_PASSWORD is set, and always behind Basic Auth.
  SWAGGER_USER: Joi.string().default('admin'),
  SWAGGER_PASSWORD: Joi.string().allow('').default(''),
});

export const identityValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('identity_schema'),
  ACCESS_TOKEN_KEY: strongKey(
    'JWT access-token signing key. MUST match api-gateway. A weak key allows forging a JWT for any role (full account takeover).',
  ),
  ACCESS_TOKEN_TIME: Joi.string().default('15m'),
  REFRESH_TOKEN_KEY: strongKey(
    'JWT refresh-token signing key. A weak key allows minting refresh tokens (persistent account takeover).',
  ),
  REFRESH_TOKEN_TIME: Joi.string().default('7d'),
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
});

export const orderValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('order_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_ORDER_QUEUE: Joi.string().required(),
  RABBITMQ_SEARCH_QUEUE: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
  RABBITMQ_LOGISTICS_QUEUE: Joi.string().required(),
  RABBITMQ_CATALOG_QUEUE: Joi.string().required(),
  RABBITMQ_FILE_QUEUE: Joi.string().required(),
});

export const catalogValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('catalog_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_CATALOG_QUEUE: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
});

export const logisticsValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('logistics_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_LOGISTICS_QUEUE: Joi.string().required(),
  RABBITMQ_ORDER_QUEUE: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
  RABBITMQ_SEARCH_QUEUE: Joi.string().required(),
});

export const financeValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('finance_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_FINANCE_QUEUE: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
});

export const notificationValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('notification_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_NOTIFICATION_QUEUE: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
  RABBITMQ_ORDER_QUEUE: Joi.string().required(),
  // Optional: gateway queue for realtime socket.io push. When unset, in-app
  // notifications are still persisted; only the live push is skipped.
  RABBITMQ_GATEWAY_QUEUE: Joi.string().optional(),
  TELEGRAM_BOT_TOKEN: Joi.string().optional(),
  // Order-create bot (PCS order_create-bot parity). Both optional — the bot
  // stays disabled when ORDER_BOT_TOKEN is unset.
  ORDER_BOT_TOKEN: Joi.string().optional(),
  ORDER_BOT_WEBAPP_URL: Joi.string().uri().optional(),
});

export const integrationValidationSchema = Joi.object({
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
});

export const analyticsValidationSchema = Joi.object({
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_ANALYTICS_QUEUE: Joi.string().required(),
});

export const branchValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('branch_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_BRANCH_QUEUE: Joi.string().required(),
  BRANCH_HQ_CODE: Joi.string().min(1).default('HQ-TSHKNT'),
  BRANCH_HQ_NAME: Joi.string().min(1).default('HQ Toshkent'),
  BRANCH_HQ_ADDRESS: Joi.string().allow('').default('Toshkent'),
});

export const investorValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('investor_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_INVESTOR_QUEUE: Joi.string().required(),
});

export const fileValidationSchema = Joi.object({
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
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('c2c_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_C2C_QUEUE: Joi.string().required(),
});

export const searchValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('search_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_SEARCH_QUEUE: Joi.string().required(),
});
