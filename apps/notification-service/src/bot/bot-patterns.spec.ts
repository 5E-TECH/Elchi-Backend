import 'reflect-metadata';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { TELEGRAM_UPDATE_EVENT as GATEWAY_EVENT } from '../../../api-gateway/src/telegram-webhook.controller';
import { NotificationServiceModule } from '../notification-service.module';
import { TELEGRAM_UPDATE_EVENT } from './bot-config';

/**
 * RMQ pattern to'qnashuvi himoyasi. 2026-10-17 prod: bot webhook hodisasi
 * `notification.telegram.update` nomi bilan yuborilardi — bu nom admin RPC'si
 * (telegram_markets guruhini yangilash) uchun band edi. Nest hodisani o'sha
 * MessagePattern handler'iga berdi, u xato qildi va update DLQ'ga ketdi —
 * bot /start ga javob bermadi. Unit testlar handler'ni to'g'ridan-to'g'ri
 * chaqirgani uchun buni ko'rmagan.
 */
type Ctor = new (...args: never[]) => object;

function patternsOf(): Array<{ pattern: string; where: string }> {
  const controllers = (Reflect.getMetadata(
    'controllers',
    NotificationServiceModule,
  ) ?? []) as Ctor[];
  const out: Array<{ pattern: string; where: string }> = [];
  for (const ctrl of controllers) {
    const proto = ctrl.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || typeof proto[name] !== 'function') continue;
      const patterns = Reflect.getMetadata(
        PATTERN_METADATA,
        proto[name] as object,
      ) as unknown[] | undefined;
      for (const pattern of patterns ?? []) {
        out.push({
          pattern: JSON.stringify(pattern),
          where: `${ctrl.name}.${name}`,
        });
      }
    }
  }
  return out;
}

describe('notification-service RMQ pattern’lari', () => {
  it('⭐ har pattern faqat BITTA handler’da (MessagePattern va EventPattern to‘qnashmaydi)', () => {
    const seen = new Map<string, string[]>();
    for (const { pattern, where } of patternsOf()) {
      seen.set(pattern, [...(seen.get(pattern) ?? []), where]);
    }
    const duplicates = [...seen].filter(([, where]) => where.length > 1);
    expect(duplicates).toEqual([]);
    expect(seen.size).toBeGreaterThan(30);
  });

  it('⭐ gateway webhook hodisasi aynan BotController’ga boradi', () => {
    expect(GATEWAY_EVENT).toBe(TELEGRAM_UPDATE_EVENT);
    const owners = patternsOf()
      .filter(
        (p) => p.pattern === JSON.stringify({ cmd: TELEGRAM_UPDATE_EVENT }),
      )
      .map((p) => p.where);
    expect(owners).toEqual(['BotController.onTelegramUpdate']);
  });
});
