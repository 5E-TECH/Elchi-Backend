import { checkStagingOutbound } from '@app/common';
import { SmsProviderError } from './sms.port';

/**
 * (staging-safe) APP_ENV=staging da qabul qiluvchi STAGING_SMS_ALLOWLIST da
 * yo'q (yoki allowlist bo'sh). `retryable=false` — scheduler qatorni darhol
 * terminal qiladi, `last_error` = aniq sabab (`staging_blocked: … (skipped)`);
 * provayderga HECH NARSA ketmaydi.
 */
export class SmsStagingBlockedError extends SmsProviderError {
  readonly stagingBlocked = true;

  constructor(reason: string) {
    super(reason, false);
    this.name = 'SmsStagingBlockedError';
  }
}

/**
 * Har adapter `send()` ning BIRINCHI qatori — provayderga HTTP so'rovidan
 * oldin. production/development'da hech narsa qilmaydi.
 */
export function assertSmsAllowedInEnv(to: string): void {
  const decision = checkStagingOutbound('sms', to);
  if (!decision.allowed) {
    throw new SmsStagingBlockedError(decision.reason ?? 'staging_blocked');
  }
}
