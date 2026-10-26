import {
  SmsDeliveryReport,
  SmsDlrStatus,
  SmsPort,
  SmsProviderError,
  SmsSendInput,
  SmsSendResult,
} from '../sms.port';
import { TASHKENT_OFFSET_MINUTES } from '@app/common';
import { asText } from '../sms-phone.util';
import { assertSmsAllowedInEnv } from '../sms-staging.guard';

export interface EskizCredentials {
  login: string;
  password: string;
  sender: string;
}

type FetchLike = typeof fetch;

const DEFAULT_BASE_URL = 'https://notify.eskiz.uz/api';
const REQUEST_TIMEOUT_MS = 10_000;
/** Eskiz tokeni ~30 kun yashaydi; erta yangilaymiz. */
const TOKEN_TTL_MS = 25 * 24 * 60 * 60 * 1000;

/** Eskiz DLR status → yagona lug'at. */
const ESKIZ_STATUS: Record<string, SmsDlrStatus> = {
  DELIVRD: 'delivered',
  DELIVERED: 'delivered',
  TRANSMTD: 'transmitted',
  ACCEPTD: 'transmitted',
  ENROUTE: 'transmitted',
  WAITING: 'transmitted',
  UNDELIV: 'not_delivered',
  UNDELIVERED: 'not_delivered',
  REJECTD: 'rejected',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  FAILED: 'failed',
  ERROR: 'failed',
};

const LOCAL_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Eskiz `status_date` ("2026-10-14 10:17:30") — vaqt zonasisiz, Toshkent
 * devor soati. `new Date(...)` uni SERVER TZ'ida o'qirdi (prod UTC → 5 soat
 * siljish). Zona ko'rsatilgan qiymat (Z / +05:00) o'zgarishsiz o'qiladi.
 */
export const parseEskizTime = (value: string): Date | null => {
  const match = LOCAL_TIME_RE.exec(value.trim());
  const date = match
    ? new Date(
        Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6] ?? 0),
        ) -
          TASHKENT_OFFSET_MINUTES * 60_000,
      )
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Eskiz.uz adapteri (8auPBa1O #1).
 *
 * - login (email+parol → Bearer) + token keshi; 401 bo'lsa BIR marta qayta
 *   login va qayta urinish;
 * - raqam Eskiz formatida: 998XXXXXXXXX (+ siz, 12 raqam);
 * - DLR moslash BIZNING id bo'yicha: callback_url ga `cmid=<client_message_id>`
 *   qo'shiladi, `user_sms_id` ham shu.
 *
 * ⚠️ Kontrakt Eskiz hujjatlaridan; haqiqiy akkaunt bilan sinalmagan
 * (shartnoma/alfa-nom yo'q). Birinchi jonli yuborishda javob shakli tekshirilsin.
 */
export class EskizAdapter implements SmsPort {
  readonly provider = 'eskiz';
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly credentials: EskizCredentials,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    // (staging-safe) staging'da allowlist'dan tashqariga — login ham, send ham YO'Q.
    assertSmsAllowedInEnv(input.to);
    const body = new URLSearchParams({
      mobile_phone: input.to.replace(/\D/g, ''),
      message: input.text,
      from: this.credentials.sender,
      user_sms_id: input.clientMessageId,
    });
    if (input.callbackUrl) body.set('callback_url', input.callbackUrl);

    const response = await this.authorized('/message/sms/send', {
      method: 'POST',
      body,
    });
    const json = (await this.readJson(response)) as {
      id?: string | number;
      message_id?: string | number;
      status?: string;
      message?: string;
    };
    return {
      providerMessageId:
        json?.id !== undefined
          ? String(json.id)
          : json?.message_id !== undefined
            ? String(json.message_id)
            : null,
      acceptedAt: new Date(),
      raw: json,
    };
  }

  parseDeliveryReport(payload: unknown): SmsDeliveryReport | null {
    const data = (payload ?? {}) as {
      body?: Record<string, unknown>;
      query?: Record<string, unknown>;
    };
    const body = data.body ?? {};
    const query = data.query ?? {};
    const clientMessageId = asText(query.cmid ?? body.user_sms_id).trim();
    const providerStatus = asText(body.status).trim().toUpperCase();
    const status = ESKIZ_STATUS[providerStatus];
    if (!clientMessageId || !status) return null;
    const at = parseEskizTime(asText(body.status_date ?? body.updated_at));
    return {
      clientMessageId,
      status,
      providerStatus,
      at: at ?? new Date(),
    };
  }

  async getBalance(): Promise<number | null> {
    const response = await this.authorized('/user/get-limit', {
      method: 'GET',
    });
    const json = (await this.readJson(response)) as {
      data?: { balance?: number | string };
      balance?: number | string;
    };
    const balance = Number(json?.data?.balance ?? json?.balance);
    return Number.isFinite(balance) ? balance : null;
  }

  // ---------------------------------------------------------------------------

  private async authorized(
    path: string,
    init: RequestInit,
    retried = false,
  ): Promise<Response> {
    const token = await this.getToken();
    const response = await this.request(path, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    if (response.status === 401 && !retried) {
      this.token = null;
      return this.authorized(path, init, true);
    }
    if (!response.ok) await this.throwFor(response);
    return response;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const response = await this.request('/auth/login', {
      method: 'POST',
      body: new URLSearchParams({
        email: this.credentials.login,
        password: this.credentials.password,
      }),
    });
    if (!response.ok) await this.throwFor(response, 'Eskiz login');
    const json = (await this.readJson(response)) as {
      data?: { token?: string };
    };
    const token = json?.data?.token;
    if (!token)
      throw new SmsProviderError("Eskiz login javobida token yo'q", false);
    this.token = token;
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    return token;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      throw new SmsProviderError(
        `Eskiz tarmoq xatosi: ${error instanceof Error ? error.message : 'unknown'}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private async throwFor(response: Response, label = 'Eskiz'): Promise<never> {
    const json = await this.readJson(response);
    const message =
      (json as { message?: unknown })?.message !== undefined
        ? JSON.stringify((json as { message?: unknown }).message)
        : `HTTP ${response.status}`;
    // 5xx va 429 — vaqtinchalik; 4xx (noto'g'ri raqam, alfa-nom) — qayta urinish befoyda.
    const retryable = response.status >= 500 || response.status === 429;
    throw new SmsProviderError(
      `${label}: ${message}`.slice(0, 500),
      retryable,
      response.status,
      json,
    );
  }
}
