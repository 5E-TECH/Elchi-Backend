import {
  SmsDeliveryReport,
  SmsDlrStatus,
  SmsPort,
  SmsProviderError,
  SmsSendInput,
  SmsSendResult,
} from '../sms.port';
import { asText } from '../sms-phone.util';

export interface PlayMobileCredentials {
  login: string;
  password: string;
  sender: string;
}

type FetchLike = typeof fetch;

const PLAYMOBILE_STATUS: Record<string, SmsDlrStatus> = {
  DELIVERED: 'delivered',
  TRANSMITTED: 'transmitted',
  NOTDELIVERED: 'not_delivered',
  REJECTED: 'rejected',
  FAILED: 'failed',
  EXPIRED: 'expired',
};

/**
 * Play Mobile adapteri — SKELET (8auPBa1O #8): port shakli ikkinchi provayderga
 * ham mos kelishini ko'rsatadi. `POST /broker-api/send`, Basic auth,
 * `messages[]`: recipient 998XXXXXXXXX (12 raqam, + siz), message-id BIZNIKI
 * (≤40 belgi), sms.originator, sms.content.text.
 *
 * ⚠️ Shartnoma va narx aniqlanmagan — jonli ishlatishdan oldin sinalsin.
 */
export class PlayMobileAdapter implements SmsPort {
  readonly provider = 'playmobile';

  constructor(
    private readonly credentials: PlayMobileCredentials,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://send.smsxabar.uz',
  ) {}

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const messageId = input.clientMessageId.replace(/-/g, '').slice(0, 40);
    const auth = Buffer.from(
      `${this.credentials.login}:${this.credentials.password}`,
    ).toString('base64');
    const response = await this.fetchImpl(`${this.baseUrl}/broker-api/send`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            recipient: input.to.replace(/\D/g, ''),
            'message-id': messageId,
            sms: {
              originator: this.credentials.sender,
              content: { text: input.text },
            },
          },
        ],
      }),
    }).catch((error: unknown) => {
      throw new SmsProviderError(
        `Play Mobile tarmoq xatosi: ${error instanceof Error ? error.message : 'unknown'}`,
        true,
      );
    });
    if (!response.ok) {
      throw new SmsProviderError(
        `Play Mobile: HTTP ${response.status}`,
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }
    return { providerMessageId: messageId, acceptedAt: new Date() };
  }

  parseDeliveryReport(payload: unknown): SmsDeliveryReport | null {
    const data = (payload ?? {}) as {
      body?: Record<string, unknown>;
      query?: Record<string, unknown>;
    };
    const body = data.body ?? {};
    const clientMessageId = asText(data.query?.cmid).trim();
    const providerStatus = asText(body.status).trim();
    const status = PLAYMOBILE_STATUS[providerStatus.toUpperCase()];
    if (!clientMessageId || !status) return null;
    return { clientMessageId, status, providerStatus, at: new Date() };
  }

  getBalance(): Promise<number | null> {
    return Promise.resolve(null);
  }
}
