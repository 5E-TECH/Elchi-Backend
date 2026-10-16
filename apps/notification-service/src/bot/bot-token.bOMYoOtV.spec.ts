import { Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotRuntimeService } from './bot-runtime.service';
import { TelegramApiError } from './bot-transport.service';
import { ENV_BOT_TOKEN } from './testing/bot-kit-spec';

/**
 * bOMYoOtV — bot tokeni HECH QACHON so'rov tanasidan yoki bazadan kelmaydi:
 *  - `resolveBotToken(payload, db)` olib tashlandi — faqat env;
 *  - DTO'larda `token` yo'q (gateway: forbidNonWhitelisted → 400 —
 *    notification-gateway.security.spec.ts);
 *  - REGISTRATOR `POST /notifications/send` → 403 (o'sha spec);
 *  - `telegram_markets.token` ikkiga bo'lindi (connect_token_hash + bot_slug),
 *    eski qiymatlar NULL (migratsiya; real SQL — bot-core.pg.spec.ts);
 *  - getMe 401 → bot ishga tushmaydi, readiness false;
 *  - loglarda token yo'q (bot-observability.9HIaV80X.spec.ts).
 */
const SRC = join(__dirname, '..');
const ROOT = join(SRC, '../../..');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('bOMYoOtV — token faqat env (grep-guard)', () => {
  const service = stripComments(
    readFileSync(join(SRC, 'notification-service.service.ts'), 'utf8'),
  );

  it('⭐ resolveBotToken va payload/DB token yo‘llari mavjud emas', () => {
    expect(service).not.toMatch(/resolveBotToken|tokenFromPayload|tokenFromDb/);
    expect(service).not.toMatch(
      /\bdto\.token\b|\bdata\.token\b|\btarget\.token\b|\brow\.token\b/,
    );
    expect(service).not.toMatch(
      /sealToken|openStoredToken|TelegramTokenCipher/,
    );
    expect(existsSync(join(SRC, 'telegram-token.cipher.ts'))).toBe(false);
  });

  it('⭐ notification-service DTO’larida `token` maydoni yo‘q', () => {
    for (const file of [
      'dto/send-notification.dto.ts',
      'dto/create-notification.dto.ts',
      'dto/update-notification.dto.ts',
    ]) {
      expect(stripComments(readFileSync(join(SRC, file), 'utf8'))).not.toMatch(
        /\btoken\??\s*:/,
      );
    }
  });

  it('entity: `token` ustuni xaritada yo‘q, connect_token_hash maxfiy (select:false), bot_slug bor', () => {
    const entity = stripComments(
      readFileSync(join(SRC, 'entities/telegram-market.entity.ts'), 'utf8'),
    );
    expect(entity).not.toMatch(/\btoken!?\s*:/);
    expect(entity).toMatch(/select: false[\s\S]*connect_token_hash/);
    expect(entity).toMatch(/bot_slug!?: string \| null/);
  });

  it('⭐ migratsiya: mavjud token qiymatlari NULL, yangi ustunlar qo‘shiladi', () => {
    const migration = readFileSync(
      join(ROOT, 'migrations/1716000000120-TelegramBotCore.ts'),
      'utf8',
    ).replace(/\s+/g, ' ');
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "connect_token_hash" varchar(64) NULL',
    );
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "bot_slug" varchar(32) NULL',
    );
    expect(migration).toMatch(
      /UPDATE "notification_schema"\."telegram_markets" SET "token" = NULL WHERE "token" IS NOT NULL/,
    );
  });
});

describe('bOMYoOtV — getMe 401 → bot ishga tushmaydi, readiness false', () => {
  afterEach(() => jest.restoreAllMocks());

  it('⭐ 401 Unauthorized', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const getUpdates = jest.fn();
    const runtime = new BotRuntimeService(
      {
        get: (key: string) =>
          ({
            TELEGRAM_BOT_TOKEN: ENV_BOT_TOKEN,
            TELEGRAM_WEBHOOK_SECRET: 'S3cret_token-for-telegram-0123456789',
          })[key],
      } as never,
      {
        getMe: jest
          .fn()
          .mockRejectedValue(
            new TelegramApiError('getMe', 401, 'Unauthorized', null),
          ),
        getUpdates,
        getWebhookInfo: jest.fn(),
        describe: (e: unknown) => String(e),
      } as never,
      { dispatch: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    await runtime.onApplicationBootstrap();
    expect(runtime.acceptsWebhook()).toBe(false);
    expect(runtime.isDegraded()).toBe(true);
    expect(runtime.health().healthy).toBe(false);
    expect(getUpdates).not.toHaveBeenCalled();
  });
});
