import * as Joi from 'joi';

export const gatewayValidationSchema = Joi.object({
  PORT: Joi.number().default(2004),
  ACCESS_TOKEN_KEY: Joi.string().required(),
  ACCESS_TOKEN_TIME: Joi.string().default('15m'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
  RABBITMQ_ORDER_QUEUE: Joi.string().required(),
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
  ACCESS_TOKEN_KEY: Joi.string().required(),
  ACCESS_TOKEN_TIME: Joi.string().default('15m'),
  REFRESH_TOKEN_KEY: Joi.string().required(),
  REFRESH_TOKEN_TIME: Joi.string().default('7d'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_IDENTITY_QUEUE: Joi.string().required(),
  RABBITMQ_LOGISTICS_QUEUE: Joi.string().required(),
  SUPERADMIN_NAME: Joi.string().required(),
  SUPERADMIN_PHONE_NUMBER: Joi.string().required(),
  SUPERADMIN_PASSWORD: Joi.string().required(),
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
  TELEGRAM_BOT_TOKEN: Joi.string().optional(),
});

export const integrationValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('integration_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_INTEGRATION_QUEUE: Joi.string().required(),
  INTEGRATION_CREDENTIAL_SECRET: Joi.string()
    .min(32)
    .required()
    .description('Primary secret used to AES-encrypt external integration credentials in DB. Must be >=32 chars of random entropy.'),
  INTEGRATION_CREDENTIAL_SECRET_PREVIOUS: Joi.string()
    .min(32)
    .optional()
    .description('Optional previous secret. During rotation: set both vars, then trigger a re-encrypt pass; rows decrypted with the previous key are re-encrypted with the primary on next save. Remove this var once all rows are migrated.'),
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
  MINIO_SECRET_KEY: Joi.string().required(),
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
