import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { rmqSend } from '@app/common';

/** docker tarmog'idagi gateway (Cloudflare'siz, ichki). */
export const DEFAULT_GATEWAY_INTERNAL_URL = 'http://api-gateway:3004';
/** Token muddatidan shuncha oldin yangilanadi. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface GatewayResponse<T> {
  status: number;
  body: T | null;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * (xC88d8kH #3 / 3ZfiXuaW DIQQAT) Bot amallari aktorning O'Z JWT'si bilan
 * MAVJUD gateway endpointlariga boradi — bot uchun "qulayroq" parallel
 * endpoint YO'Q, RBAC bitta joyda (assertCanViewOrder, isCourier doirasi…).
 *
 * Token: identity `identity.auth.telegram_actor` (tekshirilgan webhook
 * update'idagi `from.id`) → 30 daqiqalik access JWT, refresh yo'q. Token
 * faqat `Authorization` sarlavhasida — URL/log'ga HECH QACHON tushmaydi.
 * Kesh — telegram_id bo'yicha, muddati tugashidan 1 daqiqa oldin yangilanadi;
 * 401 da tashlanadi (rol/holat o'zgargan bo'lishi mumkin).
 */
@Injectable()
export class BotGatewayClient {
  private readonly logger = new Logger(BotGatewayClient.name);
  private readonly baseUrl: string;
  private readonly tokens = new Map<string, { token: string; exp: number }>();
  fetchImpl: FetchLike = (url, init) => fetch(url, init);
  now: () => number = Date.now;

  constructor(
    @Inject('IDENTITY') private readonly identity: ClientProxy,
    config: ConfigService,
  ) {
    const raw = String(
      config.get<string>('ELCHI_GATEWAY_INTERNAL_URL') ?? '',
    ).trim();
    this.baseUrl = (raw || DEFAULT_GATEWAY_INTERNAL_URL).replace(/\/+$/, '');
  }

  /** Aktor nomidan so'rov. `path` — `/orders?...` ko'rinishida. */
  async request<T = unknown>(
    telegramId: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<GatewayResponse<T>> {
    if (!path.startsWith('/')) throw new Error('path / bilan boshlanishi shart');
    const token = await this.tokenFor(telegramId);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Request-Source': 'telegram-bot',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.logger.warn(
        `gateway ${method} ${path.split('?')[0]}: ${error instanceof Error ? error.message : 'network'}`,
      );
      throw error;
    }
    if (response.status === 401) this.tokens.delete(telegramId);
    const parsed = (await response.json().catch(() => null)) as T | null;
    return { status: response.status, body: parsed };
  }

  private async tokenFor(telegramId: string): Promise<string> {
    const cached = this.tokens.get(telegramId);
    if (cached && cached.exp - TOKEN_REFRESH_MARGIN_MS > this.now()) {
      return cached.token;
    }
    const res = await rmqSend<{
      accessToken?: string;
      access_token_expires_at?: number | null;
    }>(
      this.identity,
      { cmd: 'identity.auth.telegram_actor' },
      { telegram_id: telegramId },
      { timeoutMs: 5_000, retries: 1 },
    );
    const token = String(res?.accessToken ?? '');
    if (!token) throw new Error('telegram aktori tokeni olinmadi');
    this.tokens.set(telegramId, {
      token,
      exp: Number(res?.access_token_expires_at) || this.now() + 5 * 60_000,
    });
    return token;
  }
}
