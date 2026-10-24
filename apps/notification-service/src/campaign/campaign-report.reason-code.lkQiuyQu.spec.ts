import { failureReasonCode, pushReasonCode } from './campaign-report.service';

/**
 * (lkQiuyQu) Kampaniya hisoboti «Yetkazilmaganlar»: push sabab KODI
 * (frontend xaritasi — texnik matn ko'rsatilmaydi). Maskalangan telefon —
 * campaign-report.service.spec.ts (TC6 / CSV).
 */
describe('lkQiuyQu — push sabab kodi', () => {
  it.each([
    ['no_subscription', '', 'no_subscription'],
    ['failed', 'push_disabled', 'push_disabled'],
    ['failed', 'Received unexpected response code 410', 'subscription_expired'],
    ['failed', '404 Not Found', 'subscription_expired'],
    ['failed', 'Received unexpected response code 413', 'payload_too_large'],
    ['failed', 'Received unexpected response code 429', 'rate_limited'],
    ['failed', 'Received unexpected response code 403', 'push_rejected'],
    ['failed', 'Received unexpected response code 502', 'push_service_error'],
    ['failed', 'connect ETIMEDOUT 1.2.3.4:443', 'network_error'],
    ['failed', 'Nimadir buzildi', 'push_failed'],
    ['failed', '', 'push_failed'],
    ['skipped', '', null],
  ])('status=%s, error=%j → %s', (status, error, expected) => {
    expect(pushReasonCode(status, error)).toBe(expected);
  });

  it('`<kanal>_reason` kodi ustun (online / quiet_hours / muted)', () => {
    expect(
      failureReasonCode('push', 'skipped', {
        push: 'skipped',
        push_reason: 'quiet_hours',
      }),
    ).toBe('quiet_hours');
    expect(
      failureReasonCode('telegram', 'skipped', {
        telegram: 'skipped',
        telegram_reason: 'muted',
      }),
    ).toBe('muted');
  });

  it('boshqa kanal — `_error` faqat kod bo‘lsa, xom matn kod EMAS', () => {
    expect(
      failureReasonCode('telegram', 'failed', {
        telegram: 'failed',
        telegram_error: 'bot_blocked',
      }),
    ).toBe('bot_blocked');
    expect(
      failureReasonCode('telegram', 'failed', {
        telegram: 'failed',
        telegram_error: 'Bad Request: chat not found',
      }),
    ).toBeNull();
  });
});
