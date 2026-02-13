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
  SUPERADMIN_NAME: Joi.string().default('superadmin'),
  SUPERADMIN_PHONE_NUMBER: Joi.string().default('+998905234382'),
  SUPERADMIN_PASSWORD: Joi.string().default('0990'),
});

export const orderValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('order_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_ORDER_QUEUE: Joi.string().required(),
});

export const catalogValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('catalog_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_CATALOG_QUEUE: Joi.string().required(),
});

export const logisticsValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('logistics_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_LOGISTICS_QUEUE: Joi.string().required(),
});

export const financeValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('finance_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_FINANCE_QUEUE: Joi.string().required(),
});

export const notificationValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('notification_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_NOTIFICATION_QUEUE: Joi.string().required(),
});

export const integrationValidationSchema = Joi.object({
  POSTGRES_URI: Joi.string().required(),
  DB_SCHEMA: Joi.string().default('integration_schema'),
  RABBITMQ_URI: Joi.string().required(),
  RABBITMQ_INTEGRATION_QUEUE: Joi.string().required(),
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
