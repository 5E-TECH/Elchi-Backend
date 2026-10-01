import * as Joi from 'joi';
import { gatewayValidationSchema } from './index';

/**
 * fix3b BE-2 — auth rate limit env kalitlari (fix3 C10, RBAC-11):
 * login sukuti 30/daqiqa, refresh alohida 60/daqiqa. Qiymatlar
 * auth-gateway.controller.ts `authThrottleConfig()` sukutlari bilan AYNI.
 *
 * ConfigModule opsiyalari bilan (`abortEarly:false, allowUnknown:true`).
 */
const CONFIG_MODULE_OPTIONS: Joi.ValidationOptions = {
  abortEarly: false,
  allowUnknown: true,
};

const GATEWAY_REQUIRED = {
  ACCESS_TOKEN_KEY:
    'f1e2d3c4b5a6978869504132a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
  ACCESS_TOKEN_TIME: '15m',
  RABBITMQ_URI: 'amqp://guest:guest@localhost:5672',
  RABBITMQ_IDENTITY_QUEUE: 'identity_queue',
  RABBITMQ_ORDER_QUEUE: 'order_queue',
  RABBITMQ_CATALOG_QUEUE: 'catalog_queue',
  RABBITMQ_LOGISTICS_QUEUE: 'logistics_queue',
  RABBITMQ_FINANCE_QUEUE: 'finance_queue',
  RABBITMQ_NOTIFICATION_QUEUE: 'notification_queue',
  RABBITMQ_INTEGRATION_QUEUE: 'integration_queue',
  RABBITMQ_ANALYTICS_QUEUE: 'analytics_queue',
  RABBITMQ_BRANCH_QUEUE: 'branch_queue',
  RABBITMQ_INVESTOR_QUEUE: 'investor_queue',
  RABBITMQ_FILE_QUEUE: 'file_queue',
  RABBITMQ_C2C_QUEUE: 'c2c_queue',
  RABBITMQ_SEARCH_QUEUE: 'search_queue',
};

const validate = (env: Record<string, unknown>) => {
  const result = gatewayValidationSchema.validate(
    { ...GATEWAY_REQUIRED, ...env },
    CONFIG_MODULE_OPTIONS,
  );
  return {
    error: result.error,
    value: result.value as Record<string, unknown>,
  };
};

describe('fix3b — gatewayValidationSchema auth throttle kalitlari', () => {
  it('sukutlar: login 30 / 60 000 ms, refresh 60 / 60 000 ms', () => {
    const { error, value } = validate({});

    expect(error).toBeUndefined();
    expect(value).toEqual(
      expect.objectContaining({
        AUTH_THROTTLE_LIMIT: 30,
        AUTH_THROTTLE_TTL_MS: 60_000,
        AUTH_REFRESH_THROTTLE_LIMIT: 60,
        AUTH_REFRESH_THROTTLE_TTL_MS: 60_000,
      }),
    );
  });

  it("qiymatsiz yozilgan refresh kalitlari (`KEY=`) boot'ni yiqitmaydi — sukut", () => {
    const { error, value } = validate({
      AUTH_REFRESH_THROTTLE_LIMIT: '',
      AUTH_REFRESH_THROTTLE_TTL_MS: '',
    });

    expect(error).toBeUndefined();
    expect(value.AUTH_REFRESH_THROTTLE_LIMIT).toBe(60);
    expect(value.AUTH_REFRESH_THROTTLE_TTL_MS).toBe(60_000);
  });

  it('aniq (env satri) qiymatlar songa aylanadi', () => {
    const { error, value } = validate({
      AUTH_THROTTLE_LIMIT: '45',
      AUTH_REFRESH_THROTTLE_LIMIT: '120',
      AUTH_REFRESH_THROTTLE_TTL_MS: '30000',
    });

    expect(error).toBeUndefined();
    expect(value.AUTH_THROTTLE_LIMIT).toBe(45);
    expect(value.AUTH_REFRESH_THROTTLE_LIMIT).toBe(120);
    expect(value.AUTH_REFRESH_THROTTLE_TTL_MS).toBe(30_000);
  });

  it.each([
    ['AUTH_REFRESH_THROTTLE_LIMIT', '0'],
    ['AUTH_REFRESH_THROTTLE_LIMIT', 'abc'],
    ['AUTH_REFRESH_THROTTLE_TTL_MS', '999'],
  ])("%s=%s — noto'g'ri qiymat boot'da aniqlanadi", (key, raw) => {
    const { error } = validate({ [key]: raw });

    expect(error?.details.map((detail) => detail.path.join('.'))).toEqual([
      key,
    ]);
  });
});
