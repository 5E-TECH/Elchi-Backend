import { notificationValidationSchema } from '@app/common';

/**
 * (kf0uVbyg TC5) VAPID kalitlarisiz ham notification-service config
 * validatsiyasidan o'tadi — prod'da kalit yo'q (`enabled:false`), servis
 * ko'tarilishi SHART, faqat push o'chiq bo'ladi (WARN — web-push.service.spec).
 */
describe('notificationValidationSchema — VAPID ixtiyoriy (kf0uVbyg TC5)', () => {
  const base = {
    POSTGRES_URI: 'postgres://u:p@localhost:5432/db',
    RABBITMQ_URI: 'amqp://localhost',
    RABBITMQ_NOTIFICATION_QUEUE: 'notification_queue',
    RABBITMQ_IDENTITY_QUEUE: 'identity_queue',
    RABBITMQ_ORDER_QUEUE: 'order_queue',
  };

  it('VAPID_* umuman berilmasa xato yo‘q', () => {
    const { error } = notificationValidationSchema.validate(base, {
      allowUnknown: true,
    });
    expect(error).toBeUndefined();
  });

  it('bo‘sh VAPID_* qiymatlari ham qabul qilinadi (.env.example dagidek)', () => {
    const { error } = notificationValidationSchema.validate(
      {
        ...base,
        VAPID_PUBLIC_KEY: '',
        VAPID_PRIVATE_KEY: '',
        VAPID_SUBJECT: '',
      },
      { allowUnknown: true },
    );
    expect(error).toBeUndefined();
  });

  it('VAPID_SUBJECT faqat mailto: yoki https:// bo‘lishi mumkin', () => {
    const { error } = notificationValidationSchema.validate(
      { ...base, VAPID_SUBJECT: 'http://elchi.uz' },
      { allowUnknown: true },
    );
    expect(error?.message).toMatch(/VAPID_SUBJECT/);
  });
});
