import { randomBytes } from 'crypto';

/**
 * (7s1bqOT6) ApiGatewayModule'ni testda yuklash uchun muhit.
 *
 * `ConfigModule.forRoot({ validationSchema: gatewayValidationSchema })` env'ni
 * MODUL IMPORT qilingan paytda tekshiradi — shuning uchun bu fayl
 * `api-gateway.module` dan OLDIN import qilinishi shart (side-effect import).
 * Qiymatlar soxta: RabbitMQ'ga ulanilmaydi (ClientProxy faqat birinchi
 * `.send()` da ulanadi, testlar esa mijozlarni mock bilan almashtiradi).
 * Mavjud env (CI / lokal) qiymatlari ustiga yozilmaydi.
 */
export const GATEWAY_CLIENT_TOKENS = [
  'IDENTITY',
  'ORDER',
  'CATALOG',
  'LOGISTICS',
  'FINANCE',
  'NOTIFICATION',
  'NOTIFICATION_BOT',
  'INTEGRATION',
  'ANALYTICS',
  'BRANCH',
  'INVESTOR',
  'FILE',
  'C2C',
  'SEARCH',
  'AI',
] as const;

const defaults: Record<string, string> = {
  // Har ishga tushishda tasodifiy (repoda literal sekret yo'q — gitleaks).
  ACCESS_TOKEN_KEY: randomBytes(32).toString('hex'),
  RABBITMQ_URI: 'amqp://127.0.0.1:1',
  // HTTP so'rov loglari test chiqishini to'ldirmasin.
  LOG_LEVEL: 'silent',
};
for (const token of GATEWAY_CLIENT_TOKENS) {
  defaults[`RABBITMQ_${token}_QUEUE`] =
    `gateway_test_${token.toLowerCase()}_queue`;
}
for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}
