import { notificationValidationSchema } from '../config';
import { missingGroupKeyVariables } from './notification-types';

/**
 * A1HzKEby — (1) dispatch 400 xabari uchun shablonning yetishmayotgan
 * o'zgaruvchilari; (2) retention / bo'ron chegarasi env'lari Joi sxemasida
 * XAVFSIZ sukut bilan (retention o'chiq) va xavfli qiymatlar rad etiladi.
 */
describe('missingGroupKeyVariables (A1HzKEby)', () => {
  it('yetishmagan / bo‘sh / obyekt qiymatli o‘zgaruvchilar ro‘yxati', () => {
    expect(
      missingGroupKeyVariables('order:{{order_id}}:status', undefined),
    ).toEqual(['order_id']);
    expect(
      missingGroupKeyVariables('a:{{x}}:{{ y }}:{{x}}', {
        x: ' ',
        y: { z: 1 },
      }),
    ).toEqual(['x', 'y']);
    expect(
      missingGroupKeyVariables('order:{{order_id}}:status', { order_id: 81 }),
    ).toEqual([]);
    expect(missingGroupKeyVariables(null, {})).toEqual([]);
  });
});

describe('notificationValidationSchema — A1HzKEby env', () => {
  const base = {
    POSTGRES_URI: 'postgres://x',
    RABBITMQ_URI: 'amqp://x',
    RABBITMQ_NOTIFICATION_QUEUE: 'n',
    RABBITMQ_IDENTITY_QUEUE: 'i',
    RABBITMQ_ORDER_QUEUE: 'o',
  };
  const validate = (env: Record<string, unknown>) =>
    notificationValidationSchema.validate(
      { ...base, ...env },
      { allowUnknown: true, abortEarly: false },
    );

  it('sukutlar: retention O‘CHIQ, 60/180 kun, partiya 5000, chegara 30', () => {
    const { error, value } = validate({});
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      NOTIF_HOURLY_CAP_PER_TYPE: 30,
      NOTIF_RETENTION_ENABLED: false,
      NOTIF_RETENTION_DRY_RUN: false,
      NOTIF_RETENTION_READ_DAYS: 60,
      NOTIF_RETENTION_UNREAD_DAYS: 180,
      NOTIF_RETENTION_BATCH_SIZE: 5000,
      NOTIF_RETENTION_MAX_BATCHES: 200,
      NOTIF_RETENTION_CRON_EXPR: '0 30 3 * * *',
    });
  });

  it('xavfli qiymatlar rad etiladi: READ_DAYS < 7, BATCH_SIZE > 10000, manfiy chegara', () => {
    expect(validate({ NOTIF_RETENTION_READ_DAYS: '1' }).error).toBeDefined();
    expect(
      validate({ NOTIF_RETENTION_BATCH_SIZE: '50000' }).error,
    ).toBeDefined();
    expect(validate({ NOTIF_HOURLY_CAP_PER_TYPE: '-1' }).error).toBeDefined();
    expect(
      validate({
        NOTIF_RETENTION_ENABLED: 'true',
        NOTIF_RETENTION_READ_DAYS: '30',
      }).value,
    ).toMatchObject({
      NOTIF_RETENTION_ENABLED: true,
      NOTIF_RETENTION_READ_DAYS: 30,
    });
  });
});
