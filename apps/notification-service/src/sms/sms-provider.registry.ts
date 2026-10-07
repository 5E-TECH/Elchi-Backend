import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { EskizAdapter } from './adapters/eskiz.adapter';
import { PlayMobileAdapter } from './adapters/playmobile.adapter';
import { SmsConfigService } from './sms-config.service';
import { SmsProviderAccountsService } from './sms-provider-accounts.service';
import type { SmsPort, SmsSenderProfile } from './sms.port';

/**
 * Provayder tanlovi: SMS_PROVIDER + sender_profile → adapter (DB'dagi shifrlangan
 * kredensial bilan). OTP 'otp' profilidan ketadi — reklama akkaunti bloklansa
 * ham login oqimi yashaydi. 'otp' akkaunti sozlanmagan bo'lsa OTP YUBORILMAYDI
 * (fallback YO'Q — aks holda ajratish ma'nosiz).
 */
@Injectable()
export class SmsProviderRegistry {
  private readonly logger = new Logger(SmsProviderRegistry.name);
  private readonly cache = new Map<string, SmsPort>();

  constructor(
    private readonly config: SmsConfigService,
    private readonly accounts: SmsProviderAccountsService,
  ) {
    accounts.onChange(() => this.cache.clear());
  }

  async resolve(profile: SmsSenderProfile): Promise<SmsPort | null> {
    const provider = this.config.provider;
    const key = `${provider}:${profile}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const credentials = await this.accounts.getCredentials(provider, profile);
    if (!credentials) return null;
    const adapter: SmsPort | null =
      provider === 'eskiz'
        ? new EskizAdapter(credentials)
        : provider === 'playmobile'
          ? new PlayMobileAdapter(credentials)
          : null;
    if (!adapter) {
      this.logger.error(`Noma'lum SMS_PROVIDER='${provider}'`);
      return null;
    }
    this.cache.set(key, adapter);
    return adapter;
  }

  /** Webhook tanasini o'qish uchun — kredensialsiz (faqat parser kerak). */
  parserFor(provider: string): SmsPort | null {
    const blank = { login: '', password: '', sender: '' };
    if (provider === 'eskiz') return new EskizAdapter(blank);
    if (provider === 'playmobile') return new PlayMobileAdapter(blank);
    return null;
  }

  async hasAccount(profile: SmsSenderProfile): Promise<boolean> {
    try {
      return (
        (await this.accounts.getCredentials(this.config.provider, profile)) !==
        null
      );
    } catch {
      return false;
    }
  }

  // ==================== DLR imzosi ====================

  /** Har xabar uchun alohida token: HMAC(client_message_id). */
  dlrToken(clientMessageId: string): string | null {
    const secret = this.config.dlrSecret;
    if (!secret) return null;
    return createHmac('sha256', secret)
      .update(`dlr:${clientMessageId}`)
      .digest('base64url');
  }

  verifyDlrToken(clientMessageId: string, token: unknown): boolean {
    const expected = this.dlrToken(clientMessageId);
    if (!expected || typeof token !== 'string') return false;
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  callbackUrl(clientMessageId: string): string | null {
    const base = this.config.callbackBaseUrl;
    const token = this.dlrToken(clientMessageId);
    if (!base || !token) return null;
    const params = new URLSearchParams({ cmid: clientMessageId, token });
    return `${base}/${this.config.provider}?${params.toString()}`;
  }
}
