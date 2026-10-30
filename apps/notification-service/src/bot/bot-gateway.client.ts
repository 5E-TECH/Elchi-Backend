import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { PASSWORD_CHANGE_REQUIRED, rmqSend } from '@app/common';

/** docker tarmog'idagi gateway (Cloudflare'siz, ichki). */
export const DEFAULT_GATEWAY_INTERNAL_URL = 'http://api-gateway:3004';

export interface GatewayResponse<T> {
  status: number;
  body: T | null;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** (BOT-2 #2d) Bot javobi: xodim avval kabinetda parolini almashtirishi shart. */
export const BOT_PASSWORD_CHANGE_TEXT =
  '🔐 Avval kabinetda parolni almashtiring — keyin botdan foydalanish mumkin.';

/**
 * (BOT-2 #2d) Gateway `403 PASSWORD_CHANGE_REQUIRED` qaytardi (Telegram
 * tokenida `pwd_change`, `PASSWORD_CHANGE_GATE=on`). Har handler bu holatni
 * alohida tekshirmasin — `BotRouterService` ushlab, aniq matn bilan javob beradi.
 */
export class BotPasswordChangeRequiredError extends Error {
  constructor() {
    super('password change required');
    this.name = 'BotPasswordChangeRequiredError';
  }
}

/**
 * Handler'dagi `catch` uni «aloqa xatosi» deb YUTMASIN — router aniq
 * «Avval kabinetda parolni almashtiring» javobini beradi. Gateway'ga
 * boradigan har `try/catch` / `.catch()` boshida chaqiriladi.
 */
export function rethrowPasswordChange(error: unknown): void {
  if (error instanceof BotPasswordChangeRequiredError) throw error;
}

/**
 * (xC88d8kH #3 / 3ZfiXuaW DIQQAT) Bot amallari aktorning O'Z JWT'si bilan
 * MAVJUD gateway endpointlariga boradi — bot uchun "qulayroq" parallel
 * endpoint YO'Q, RBAC bitta joyda (assertCanViewOrder, isCourier doirasi…).
 *
 * Token: identity `identity.auth.telegram_actor` (tekshirilgan webhook
 * update'idagi `from.id`) → 30 daqiqalik access JWT, refresh yo'q. Token
 * faqat `Authorization` sarlavhasida — URL/log'ga HECH QACHON tushmaydi.
 *
 * ⚠️ Token KESHLANMAYDI — har so'rov JORIY aktor uchun yangi token oladi.
 * 2026-10-17 prod: kesh telegram_id bo'yicha edi; chat kuryerdan uzilib
 * marketga ulangach `/balans` 30 daqiqagacha KURYERNING kassasini ko'rsatdi
 * (eski JWT). Token chiqarish — bitta qidiruv + imzo (DB'ga yozuv yo'q).
 */
@Injectable()
export class BotGatewayClient {
  private readonly logger = new Logger(BotGatewayClient.name);
  private readonly baseUrl: string;
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  constructor(
    @Inject('IDENTITY') private readonly identity: ClientProxy,
    config: ConfigService,
  ) {
    const raw = String(
      config.get<string>('ELCHI_GATEWAY_INTERNAL_URL') ?? '',
    ).trim();
    this.baseUrl = (raw || DEFAULT_GATEWAY_INTERNAL_URL).replace(/\/+$/, '');
  }

  /**
   * Aktor nomidan so'rov. `path` — `/orders?...` ko'rinishida. `body` —
   * JSON yoki `FormData` (multipart, masalan `POST /files/upload`).
   */
  async request<T = unknown>(
    telegramId: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    options: { timeoutMs?: number; idempotencyKey?: string } = {},
  ): Promise<GatewayResponse<T>> {
    if (!path.startsWith('/'))
      throw new Error('path / bilan boshlanishi shart');
    const token = await this.tokenFor(telegramId);
    const multipart = body instanceof FormData;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'X-Request-Source': 'telegram-bot',
    };
    if (!multipart) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : multipart
              ? body
              : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      this.logger.warn(
        `gateway ${method} ${path.split('?')[0]}: ${error instanceof Error ? error.message : 'network'}`,
      );
      throw error;
    }
    const parsed = (await response.json().catch(() => null)) as T | null;
    if (
      response.status === 403 &&
      (parsed as { code?: unknown } | null)?.code === PASSWORD_CHANGE_REQUIRED
    ) {
      throw new BotPasswordChangeRequiredError();
    }
    return { status: response.status, body: parsed };
  }

  private async tokenFor(telegramId: string): Promise<string> {
    const res = await rmqSend<{ accessToken?: string }>(
      this.identity,
      { cmd: 'identity.auth.telegram_actor' },
      { telegram_id: telegramId },
      { timeoutMs: 5_000, retries: 1 },
    );
    const token = String(res?.accessToken ?? '');
    if (!token) throw new Error('telegram aktori tokeni olinmadi');
    return token;
  }
}
