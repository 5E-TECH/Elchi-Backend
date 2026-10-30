import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  gatewayValidationSchema,
  notificationValidationSchema,
  orderValidationSchema,
} from '@app/common';

/**
 * BOT-3a — Telegram bot update'lari va karta hodisalari ALOHIDA
 * `NOTIFICATION_BOT` navbatida: umumiy NOTIFICATION navbatidagi dispatch /
 * push to'lqini bot javobini kechiktirmaydi va update 60 s TTL dan keyin
 * DLQ'ga tushmaydi.
 */
const ROOT = join(__dirname, '../../../..');
const src = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('BOT-3a — alohida NOTIFICATION_BOT navbati', () => {
  it('env sukuti: gateway, order, notification — notification_bot_queue', () => {
    for (const schema of [
      gatewayValidationSchema,
      orderValidationSchema,
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

  it('⭐ gateway webhook va order-service karta hodisasi — bot navbatiga', () => {
    expect(src('apps/api-gateway/src/telegram-webhook.controller.ts')).toMatch(
      /@Inject\('NOTIFICATION_BOT'\)/,
    );
    expect(src('apps/api-gateway/src/api-gateway.module.ts')).toContain(
      "RmqModule.register({ name: 'NOTIFICATION_BOT' })",
    );
    const orderModule = src('apps/order-service/src/order-service.module.ts');
    expect(orderModule).toContain(
      "RmqModule.register({ name: 'NOTIFICATION_BOT' })",
    );
    expect(orderModule).toMatch(/targets:[\s\S]*'NOTIFICATION_BOT'/);
    expect(
      src(
        'apps/order-service/src/notification/order-telegram-card.publisher.ts',
      ),
    ).toContain('NOTIFICATION_BOT_OUTBOX_TARGET');
  });
});
