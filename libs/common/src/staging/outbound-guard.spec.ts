import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { notificationValidationSchema, aiValidationSchema } from '../config';
import { ClaudeService } from '../ai/claude.service';
import type { AnthropicClientFactory } from '../ai/claude.types';
import {
  STAGING_AI_DEFAULT_DAILY_USD_CAP,
  checkStagingOutbound,
  isAiAllowedInEnv,
  isStagingEnv,
  normalizeStagingTarget,
  parseStagingAllowlist,
  resolveAppEnv,
  stagingAiDailyUsdCap,
} from './outbound-guard';

/**
 * (staging-safe) STAGING chiquvchi darvozasining yadrosi: APP_ENV, allowlist
 * normalizatsiyasi, fail-closed, AI kaliti va Joi sxemasi.
 */
describe('staging outbound guard — yadro', () => {
  const STAGING = { APP_ENV: 'staging' };

  describe('resolveAppEnv', () => {
    it('berilmagan / bo‘sh → production (prod o‘zgarmaydi)', () => {
      expect(resolveAppEnv({})).toBe('production');
      expect(resolveAppEnv({ APP_ENV: '' })).toBe('production');
      expect(resolveAppEnv({ APP_ENV: '  ' })).toBe('production');
    });

    it('ma‘lum qiymatlar (katta-kichik harf farqsiz)', () => {
      expect(resolveAppEnv({ APP_ENV: 'Staging' })).toBe('staging');
      expect(resolveAppEnv({ APP_ENV: 'development' })).toBe('development');
      expect(resolveAppEnv({ APP_ENV: 'production' })).toBe('production');
    });

    it('noma‘lum qiymat — fail-closed (staging deb olinadi)', () => {
      expect(resolveAppEnv({ APP_ENV: 'stagin' })).toBe('staging');
      expect(isStagingEnv({ APP_ENV: 'prod' })).toBe(true);
    });
  });

  describe('normalizatsiya', () => {
    it('SMS: har xil yozuv bitta +998 ko‘rinishga', () => {
      expect(normalizeStagingTarget('sms', '90 123 45 67')).toBe(
        '+998901234567',
      );
      expect(normalizeStagingTarget('sms', '998901234567')).toBe(
        '+998901234567',
      );
      expect(normalizeStagingTarget('sms', '+998 (90) 123-45-67')).toBe(
        '+998901234567',
      );
      expect(normalizeStagingTarget('sms', 'abc')).toBeNull();
    });

    it('Telegram: raqamli id (manfiy guruh ham) va @username', () => {
      expect(normalizeStagingTarget('telegram', -1001234567890)).toBe(
        '-1001234567890',
      );
      expect(normalizeStagingTarget('telegram', ' 0042 ')).toBe('42');
      expect(normalizeStagingTarget('telegram', '@Elchi_Test')).toBe(
        '@elchi_test',
      );
      expect(normalizeStagingTarget('telegram', 'x y')).toBeNull();
    });

    it('push: foydalanuvchi id', () => {
      expect(normalizeStagingTarget('push', '25')).toBe('25');
      expect(normalizeStagingTarget('push', 25)).toBe('25');
      expect(normalizeStagingTarget('push', '@user')).toBeNull();
    });

    it('allowlist — vergul/nuqtali vergul bilan ajratiladi (bo‘shliqli telefon — bitta element)', () => {
      const list = parseStagingAllowlist('sms', {
        STAGING_SMS_ALLOWLIST: '+998901234567, 998911112233;  93 000 00 01',
      });
      expect([...list].sort()).toEqual([
        '+998901234567',
        '+998911112233',
        '+998930000001',
      ]);
    });
  });

  describe('checkStagingOutbound', () => {
    it('production: allowlist‘siz ham hamma kanal ochiq (o‘zgarishsiz)', () => {
      for (const channel of ['sms', 'telegram', 'push'] as const) {
        expect(checkStagingOutbound(channel, '+998901234567', {})).toEqual({
          allowed: true,
          reason: null,
        });
      }
    });

    it('staging + bo‘sh allowlist → FAIL-CLOSED (hech kimga)', () => {
      const decision = checkStagingOutbound('sms', '+998901234567', STAGING);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(
        /^staging_blocked: .*STAGING_SMS_ALLOWLIST bo'sh/,
      );
      expect(checkStagingOutbound('telegram', '42', STAGING).allowed).toBe(
        false,
      );
      expect(checkStagingOutbound('push', '25', STAGING).allowed).toBe(false);
    });

    it('staging: allowlist‘dagi — ruxsat, boshqasi — sababli blok (PII‘siz)', () => {
      const env = {
        ...STAGING,
        STAGING_SMS_ALLOWLIST: '+998901234567',
        STAGING_TELEGRAM_CHAT_ALLOWLIST: '42,-100555',
        STAGING_PUSH_USER_ALLOWLIST: '25,26',
      };
      expect(checkStagingOutbound('sms', '998901234567', env).allowed).toBe(
        true,
      );
      const blocked = checkStagingOutbound('sms', '+998977776655', env);
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain('***6655');
      expect(blocked.reason).not.toContain('977776655');
      expect(checkStagingOutbound('telegram', -100555, env).allowed).toBe(true);
      expect(checkStagingOutbound('telegram', '43', env).allowed).toBe(false);
      expect(checkStagingOutbound('push', '26', env).allowed).toBe(true);
      expect(checkStagingOutbound('push', '27', env).allowed).toBe(false);
    });

    it('development: cheklovsiz (lokal ishlab chiqish)', () => {
      expect(
        checkStagingOutbound('sms', '+998901234567', {
          APP_ENV: 'development',
        }).allowed,
      ).toBe(true);
    });
  });

  describe('AI', () => {
    it('production — AI ruxsat, staging shifti yo‘q', () => {
      expect(isAiAllowedInEnv({})).toBe(true);
      expect(stagingAiDailyUsdCap({})).toBeNull();
    });

    it('staging — sukut O‘CHIQ, faqat STAGING_AI_ENABLED=true bilan', () => {
      expect(isAiAllowedInEnv(STAGING)).toBe(false);
      expect(
        isAiAllowedInEnv({ ...STAGING, STAGING_AI_ENABLED: 'false' }),
      ).toBe(false);
      expect(isAiAllowedInEnv({ ...STAGING, STAGING_AI_ENABLED: 'true' })).toBe(
        true,
      );
    });

    it('staging shifti: sukut 2 USD, env bilan o‘zgaradi', () => {
      expect(stagingAiDailyUsdCap(STAGING)).toBe(
        STAGING_AI_DEFAULT_DAILY_USD_CAP,
      );
      expect(
        stagingAiDailyUsdCap({ ...STAGING, STAGING_AI_DAILY_USD_CAP: '0.5' }),
      ).toBe(0.5);
    });
  });

  describe('Joi sxemasi (APP_ENV + allowlist)', () => {
    const base = {
      POSTGRES_URI: 'postgres://x',
      RABBITMQ_URI: 'amqp://x',
      RABBITMQ_NOTIFICATION_QUEUE: 'n',
      RABBITMQ_IDENTITY_QUEUE: 'i',
      RABBITMQ_ORDER_QUEUE: 'o',
    };
    const validate = (extra: Record<string, string>) =>
      notificationValidationSchema.validate(
        { ...base, ...extra },
        { allowUnknown: true, abortEarly: false },
      );

    it('APP_ENV sukuti — production; STAGING_AI_ENABLED sukuti — false', () => {
      const { error, value } = validate({});
      expect(error).toBeUndefined();
      expect(value.APP_ENV).toBe('production');
      expect(value.STAGING_AI_ENABLED).toBe(false);
    });

    it('noto‘g‘ri APP_ENV boot‘da rad etiladi', () => {
      expect(validate({ APP_ENV: 'prod' }).error).toBeDefined();
      expect(validate({ APP_ENV: 'Staging' }).value.APP_ENV).toBe('staging');
    });

    it('allowlist‘dagi yaroqsiz element boot‘da rad etiladi (jim blok emas)', () => {
      expect(
        validate({ STAGING_SMS_ALLOWLIST: '+998901234567,12' }).error?.message,
      ).toContain('STAGING_SMS_ALLOWLIST');
      expect(
        validate({ STAGING_TELEGRAM_CHAT_ALLOWLIST: '42,-1001' }).error,
      ).toBeUndefined();
      expect(
        validate({ STAGING_PUSH_USER_ALLOWLIST: '25, x' }).error,
      ).toBeDefined();
    });

    it('ai-service sxemasida ham bor', () => {
      const { error, value } = aiValidationSchema.validate(
        {
          RABBITMQ_URI: 'amqp://x',
          POSTGRES_URI: 'postgres://x',
          RABBITMQ_NOTIFICATION_QUEUE: 'n',
          APP_ENV: 'staging',
          STAGING_AI_DAILY_USD_CAP: '1.5',
        },
        { allowUnknown: true, abortEarly: false },
      );
      expect(error).toBeUndefined();
      expect(value.APP_ENV).toBe('staging');
      expect(value.STAGING_AI_DAILY_USD_CAP).toBe(1.5);
    });
  });
});

describe('ClaudeService — staging AI kaliti', () => {
  const KEY = 'sk-ant-api03-' + 'x'.repeat(40);
  const OLD = { ...process.env };

  const build = () => {
    const factory = jest.fn(() => ({
      messages: { create: jest.fn() },
    })) as unknown as jest.MockedFunction<AnthropicClientFactory>;
    const config = {
      get: (key: string): unknown =>
        key === 'ANTHROPIC_API_KEY' ? KEY : undefined,
    } as unknown as ConfigService;
    return { service: new ClaudeService(config, factory), factory };
  };

  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    process.env = { ...OLD };
    jest.restoreAllMocks();
  });

  it('production: kalit bor — AI yoqiq (o‘zgarishsiz)', () => {
    delete process.env.APP_ENV;
    const { service, factory } = build();
    expect(service.isEnabled()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('staging (STAGING_AI_ENABLED yo‘q): mijoz QURILMAYDI, extractJson → disabled', async () => {
    process.env.APP_ENV = 'staging';
    delete process.env.STAGING_AI_ENABLED;
    const { service, factory } = build();
    expect(service.isEnabled()).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    service.onApplicationBootstrap();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('STAGING_AI_ENABLED'),
    );
    await expect(
      service.extractJson({
        system: 's',
        userText: 'u',
        schema: { type: 'object' },
        meta: { feature: 'order_extract_multi', requestArea: 'order' },
      } as never),
    ).resolves.toEqual({ ok: false, reason: 'disabled', attempts: 0 });
  });

  it('staging + STAGING_AI_ENABLED=true: AI yoqiq', () => {
    process.env.APP_ENV = 'staging';
    process.env.STAGING_AI_ENABLED = 'true';
    const { service, factory } = build();
    expect(service.isEnabled()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
