import { TELEGRAM_UPDATE_EVENT as SHARED } from '@app/common';
import { TELEGRAM_UPDATE_EVENT as NOTIFICATION } from '../../notification-service/src/bot/bot-config';
import { TELEGRAM_UPDATE_EVENT as GATEWAY } from './telegram-webhook.controller';

/**
 * zDUUxyH2 — webhook hodisasi nomi yagona manbadan: gateway emit qiladigan va
 * notification-service tinglaydigan nom bir xil (2026-10-17 dagi kabi
 * nom farqi /start ni javobsiz qoldirmasin).
 */
it('gateway va notification-service bir xil hodisa nomini ishlatadi (libs/common)', () => {
  expect(GATEWAY).toBe(SHARED);
  expect(NOTIFICATION).toBe(SHARED);
  expect(SHARED).toBe('notification.telegram.webhook_update');
});
