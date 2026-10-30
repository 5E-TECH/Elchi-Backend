import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  gatewayValidationSchema,
  notificationValidationSchema,
  orderValidationSchema,
} from '@app/common';

/**
 * BOT-3a — Telegram bot update'lari (webhook) ALOHIDA `NOTIFICATION_BOT`
 * navbatida: umumiy NOTIFICATION navbatidagi dispatch / push / karta
 * to'lqini bot javobini kechiktirmaydi va update 60 s TTL dan keyin DLQ'ga
 * tushmaydi. Karta hodisalari (ommaviy) ATAYLAB umumiy navbatda qoladi.
 * Gateway navbatni bootstrap'da o'zi ham e'lon qiladi (`ensureQueue`).
 */
const ROOT = join(__dirname, '../../../..');
const src = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('BOT-3a — alohida NOTIFICATION_BOT navbati', () => {
  it('env sukuti: gateway va notification — notification_bot_queue', () => {
    for (const schema of [
      gatewayValidationSchema,
      notificationValidationSchema,
    ]) {
      const described = schema.describe() as {
        keys: Record<string, { flags?: { default?: unknown } }>;
      };
      expect(
        described.keys.RABBITMQ_NOTIFICATION_BOT_QUEUE?.flags?.default,
      ).toBe('notification_bot_queue');
    }
  });

  it('⭐ notification-service ikkala navbatni tinglaydi (DLQ topologiyasi bilan)', () => {
    const main = src('apps/notification-service/src/main.ts');
    expect(main).toContain("setupDlqTopology('NOTIFICATION_BOT')");
    expect(main).toContain("getOptions('NOTIFICATION_BOT')");
    expect(main).toContain("getOptions('NOTIFICATION')");
  });

  it('⭐ gateway webhook — bot navbatiga, navbat bootstrap`da e`lon qilinadi', () => {
    expect(src('apps/api-gateway/src/telegram-webhook.controller.ts')).toMatch(
      /@Inject\('NOTIFICATION_BOT'\)/,
    );
    expect(src('apps/api-gateway/src/api-gateway.module.ts')).toContain(
      "RmqModule.register({ name: 'NOTIFICATION_BOT' })",
    );
    expect(src('apps/api-gateway/src/main.ts')).toContain(
      "ensureQueue('NOTIFICATION_BOT')",
    );
  });

  it('⭐ karta hodisalari umumiy NOTIFICATION navbatida qoladi (bot navbatini tiqmaydi)', () => {
    expect(orderValidationSchema.describe()).not.toHaveProperty(
      'keys.RABBITMQ_NOTIFICATION_BOT_QUEUE',
    );
    expect(src('apps/order-service/src/order-service.module.ts')).not.toContain(
      'NOTIFICATION_BOT',
    );
    expect(
      src(
        'apps/order-service/src/notification/order-telegram-card.publisher.ts',
      ),
    ).toContain('NOTIFICATION_OUTBOX_TARGET');
  });
});
