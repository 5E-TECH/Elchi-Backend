import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import {
  ActivityAction,
  ActivityLogService,
  HmacAlgorithm,
  Order_status,
  verifyHmacSignature,
} from '@app/common';
import { ExternalIntegration } from './entities/external-integration.entity';
import { SyncQueue } from './entities/sync-queue.entity';
import { SyncHistory } from './entities/sync-history.entity';
import { ProviderWebhookLog } from './entities/provider-webhook-log.entity';
import { ProviderShipment } from './entities/provider-shipment.entity';
import { errorRes, successRes } from '../../../libs/common/helpers/response';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type ExternalRequestInput = {
  slug: string;
  endpoint?: string;
  method?: HttpMethod;
  params?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  use_auth?: boolean;
  timeout_ms?: number;
  response_path?: string;
};

type QrSearchInput = {
  slug: string;
  qr_code: string;
  endpoint?: string;
  method?: HttpMethod;
  qr_field?: string;
  response_path?: string;
  timeout_ms?: number;
};

type AuthConfig = {
  token_path?: string;
  login_method?: HttpMethod;
  login_payload_template?: Record<string, unknown>;
  header_prefix?: string;
};

type ExternalSearchConfig = {
  endpoint?: string;
  method?: HttpMethod;
  qr_field?: string;
  use_auth?: boolean;
  query_template?: Record<string, unknown>;
  body_template?: Record<string, unknown>;
  headers?: Record<string, string>;
  response_path?: string;
  timeout_ms?: number;
};

type ExternalUpdateConfig = {
  endpoint?: string;
  method?: HttpMethod;
  order_id_field?: string;
  status_field?: string;
  use_auth?: boolean;
  query_template?: Record<string, unknown>;
  body_template?: Record<string, unknown>;
  headers?: Record<string, string>;
  response_path?: string;
  timeout_ms?: number;
};

type StatusSyncConfig = {
  auth?: AuthConfig;
  external_search?: ExternalSearchConfig;
  external_update?: ExternalUpdateConfig;
};

type FindAllIntegrationsQuery = {
  is_active?: boolean | string;
  status?: string;
  market_id?: string;
  from_date?: string;
  to_date?: string;
  page?: number;
  limit?: number;
};

type SyncHistoryQuery = {
  integration_id?: string;
  status?: 'success' | 'failed' | string;
  from_date?: string;
  to_date?: string;
  page?: number;
  limit?: number;
};

@Injectable()
export class IntegrationServiceService {
  private readonly logger = new Logger(IntegrationServiceService.name);
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();
  // No default fallback by design: an environment without INTEGRATION_CREDENTIAL_SECRET
  // must not boot, otherwise stored credentials would silently encrypt with a
  // publicly-known key. Joi validation guarantees presence at startup.
  // Optional PREVIOUS key supports rotation: rows encrypted with the older
  // secret can still be decrypted, then re-encrypted with the primary on next save.
  private readonly primaryKey = createHash('sha256')
    .update(process.env.INTEGRATION_CREDENTIAL_SECRET!)
    .digest();
  private readonly previousKey = process.env.INTEGRATION_CREDENTIAL_SECRET_PREVIOUS
    ? createHash('sha256')
        .update(process.env.INTEGRATION_CREDENTIAL_SECRET_PREVIOUS)
        .digest()
    : null;

  constructor(
    @InjectRepository(ExternalIntegration) private readonly integrationRepo: Repository<ExternalIntegration>,
    @InjectRepository(SyncQueue) private readonly syncQueueRepo: Repository<SyncQueue>,
    @InjectRepository(SyncHistory) private readonly syncHistoryRepo: Repository<SyncHistory>,
    @InjectRepository(ProviderWebhookLog)
    private readonly webhookLogRepo: Repository<ProviderWebhookLog>,
    @InjectRepository(ProviderShipment)
    private readonly shipmentRepo: Repository<ProviderShipment>,
    private readonly activityLog: ActivityLogService,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('NOTIFICATION') private readonly notificationClient: ClientProxy,
  ) {}

  private badRequest(message: string): never {
    throw new RpcException(errorRes(message, 400));
  }

  private notFound(message: string): never {
    throw new RpcException(errorRes(message, 404));
  }

  private extractPath(source: unknown, path?: string): unknown {
    if (!path || !path.trim()) {
      return source;
    }

    return path.split('.').reduce<unknown>((acc, key) => {
      if (acc === null || typeof acc !== 'object') {
        return undefined;
      }
      return (acc as Record<string, unknown>)[key];
    }, source);
  }

  private interpolate(template: unknown, ctx: Record<string, string>): unknown {
    if (typeof template === 'string') {
      return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => ctx[key] ?? '');
    }

    if (Array.isArray(template)) {
      return template.map((item) => this.interpolate(item, ctx));
    }

    if (template && typeof template === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(template)) {
        out[key] = this.interpolate(value, ctx);
      }
      return out;
    }

    return template;
  }

  private toSyncConfig(integration: ExternalIntegration): StatusSyncConfig {
    const raw = integration.status_sync_config;
    if (!raw || typeof raw !== 'object') {
      return {};
    }
    return raw as StatusSyncConfig;
  }

  private async findActiveBySlug(slug: string): Promise<ExternalIntegration> {
    const integration = await this.integrationRepo.findOne({
      where: { slug, is_active: true, isDeleted: false },
    });
    if (!integration) {
      this.notFound(`Active integration not found for slug: ${slug}`);
    }
    return integration;
  }

  private resolveTokenFromResponse(response: unknown, tokenPath?: string): string | null {
    if (tokenPath) {
      const byConfiguredPath = this.extractPath(response, tokenPath);
      if (typeof byConfiguredPath === 'string' && byConfiguredPath.length > 0) {
        return byConfiguredPath;
      }
    }

    const candidates = [
      this.extractPath(response, 'access_token'),
      this.extractPath(response, 'token'),
      this.extractPath(response, 'data.access_token'),
      this.extractPath(response, 'data.token'),
      this.extractPath(response, 'result.access_token'),
      this.extractPath(response, 'result.token'),
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
    }

    return null;
  }

  private async loginAndGetToken(integration: ExternalIntegration): Promise<string> {
    const decryptedPassword = this.decryptCredential(integration.password);
    if (!integration.auth_url || !integration.username || !decryptedPassword) {
      this.badRequest('Integration login config is incomplete');
    }

    const syncConfig = this.toSyncConfig(integration);
    const authConfig = syncConfig.auth ?? {};
    const method = (authConfig.login_method ?? 'POST').toUpperCase() as HttpMethod;
    const context = {
      username: integration.username,
      password: decryptedPassword,
    };
    const payload =
      authConfig.login_payload_template && Object.keys(authConfig.login_payload_template).length
        ? this.interpolate(authConfig.login_payload_template, context)
        : { username: integration.username, password: decryptedPassword };

    try {
      const response = await fetch(integration.auth_url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        this.badRequest(`Integration login failed: ${text || response.statusText}`);
      }

      const responseData = (await response.json()) as unknown;
      const token = this.resolveTokenFromResponse(responseData, authConfig.token_path);
      if (!token) {
        this.badRequest('Token could not be extracted from auth response');
      }

      this.tokenCache.set(integration.id, {
        token,
        expiresAt: Date.now() + 55 * 60 * 1000,
      });

      return token;
    } catch (error: any) {
      const message = error?.message ?? 'Login request failed';
      this.badRequest(`Integration login failed: ${String(message)}`);
    }
  }

  private async getValidToken(integration: ExternalIntegration): Promise<string | null> {
    if (integration.auth_type === 'api_key') {
      return this.decryptCredential(integration.api_key) ?? null;
    }

    const cached = this.tokenCache.get(integration.id);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.token;
    }

    return this.loginAndGetToken(integration);
  }

  private clearTokenCache(integrationId: string): void {
    this.tokenCache.delete(integrationId);
  }

  private async rmqRequest<T>(
    client: ClientProxy,
    pattern: { cmd: string },
    payload: Record<string, any>,
    ttlMs = 5000,
  ): Promise<T | null> {
    try {
      return await firstValueFrom(client.send(pattern, payload).pipe(timeout(ttlMs)));
    } catch (error) {
      if (error instanceof TimeoutError) {
        return null;
      }
      return null;
    }
  }

  private getRetryDelayMs(attempt: number): number {
    // Exponential-like backoff requested for retries: 1m, 5m, 15m
    const retryDelays = [60_000, 5 * 60_000, 15 * 60_000];
    const index = Math.max(0, Math.min(retryDelays.length - 1, attempt - 1));
    return retryDelays[index];
  }

  private async notifyAdminsAboutPermanentFailure(
    queue: SyncQueue,
    integration: ExternalIntegration | null,
    errorMessage: string,
  ): Promise<void> {
    const adminGroupId =
      process.env.NOTIFICATION_ADMIN_GROUP_ID ||
      process.env.TELEGRAM_ADMIN_GROUP_ID ||
      '';

    if (!adminGroupId) {
      return;
    }

    const message =
      `Integration retry permanently failed\n` +
      `integration_id: ${queue.integration_id}\n` +
      `integration_slug: ${integration?.slug ?? 'unknown'}\n` +
      `order_id: ${queue.order_id}\n` +
      `attempts: ${queue.attempts}\n` +
      `error: ${errorMessage}`;

    try {
      await this.rmqRequest(
        this.notificationClient,
        { cmd: 'notification.send' },
        {
          group_id: adminGroupId,
          message,
          token: process.env.TELEGRAM_BOT_TOKEN || undefined,
        },
        5000,
      );
    } catch {
      // Best-effort notification only; queue processing must continue.
    }
  }

  private toSafeInt(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return Math.trunc(parsed);
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private normalizeStatus(value: unknown): 'active' | 'inactive' {
    const normalized = String(value ?? 'active').toLowerCase();
    return normalized === 'inactive' ? 'inactive' : 'active';
  }

  private normalizeType(value: unknown): 'api' | 'webhook' | 'ftp' {
    const normalized = String(value ?? 'api').toLowerCase();
    if (normalized === 'webhook' || normalized === 'ftp') {
      return normalized;
    }
    return 'api';
  }

  private maskCredentials(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const masked = { ...(value as Record<string, unknown>) };
    const sensitiveKeys = ['api_key', 'api_secret', 'password', 'token', 'access_token'];
    for (const key of sensitiveKeys) {
      if (typeof masked[key] !== 'undefined' && masked[key] !== null && String(masked[key]).length > 0) {
        masked[key] = '***';
      }
    }
    return masked;
  }

  private normalizeCredentialsForStorage(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const raw = { ...(value as Record<string, unknown>) };
    const encryptKeys = ['api_key', 'api_secret', 'password', 'token', 'access_token'];
    for (const key of encryptKeys) {
      const val = raw[key];
      if (typeof val === 'string' && val.length > 0) {
        raw[key] = this.encryptCredential(val);
      }
    }
    return raw;
  }

  private encryptCredential(value?: string | null): string | null {
    if (!value) {
      return null;
    }

    if (value.startsWith('enc:')) {
      return value;
    }

    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', this.primaryKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `enc:${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypt with the primary key; on auth failure fall back to the previous
   * key (rotation window). Returns the raw value if both keys fail, matching
   * the legacy "treat unparseable as plaintext" contract.
   */
  private decryptCredential(value?: string | null): string | null {
    if (!value) {
      return null;
    }

    if (!value.startsWith('enc:')) {
      return value;
    }

    const [, ivHex, encryptedHex] = value.split(':');
    if (!ivHex || !encryptedHex) {
      return value;
    }

    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const tryKey = (key: Buffer): string | null => {
      try {
        const decipher = createDecipheriv('aes-256-cbc', key, iv);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return decrypted.toString('utf8');
      } catch {
        return null;
      }
    };

    const primary = tryKey(this.primaryKey);
    if (primary !== null) {
      return primary;
    }

    if (this.previousKey) {
      const fromPrevious = tryKey(this.previousKey);
      if (fromPrevious !== null) {
        this.logger.warn(
          'Credential decrypted with previous key — re-encrypt with primary on next save (rotation in progress)',
        );
        return fromPrevious;
      }
    }

    // Both keys failed — leave value untouched; an audit script can re-key it
    // manually once the right secret is known.
    return value;
  }

  private async getProductsCountByMarket(marketId: string): Promise<number> {
    const response = await this.rmqRequest<{ total?: number }>(
      this.catalogClient,
      { cmd: 'catalog.product.find_all' },
      { query: { user_id: marketId, page: 1, limit: 1 } },
    );
    return this.toSafeInt(response?.total);
  }

  private async getOrderCountByMarket(marketId: string, status?: Order_status): Promise<number> {
    const query: Record<string, any> = { market_id: marketId, page: 1, limit: 1 };
    if (status) {
      query.status = status;
    }

    const response = await this.rmqRequest<{ total?: number }>(
      this.orderClient,
      { cmd: 'order.find_all' },
      { query },
    );
    return this.toSafeInt(response?.total);
  }

  private async getOrderStatsByMarket(
    marketId: string,
  ): Promise<{ total_orders: number; successful_orders: number; cancelled_orders: number }> {
    const [total, cancelled, sold, paid, partlyPaid] = await Promise.all([
      this.getOrderCountByMarket(marketId),
      this.getOrderCountByMarket(marketId, Order_status.CANCELLED),
      this.getOrderCountByMarket(marketId, Order_status.SOLD),
      this.getOrderCountByMarket(marketId, Order_status.PAID),
      this.getOrderCountByMarket(marketId, Order_status.PARTLY_PAID),
    ]);

    return {
      total_orders: total,
      successful_orders: sold + paid + partlyPaid,
      cancelled_orders: cancelled,
    };
  }

  private async fetchMarketsByIds(marketIds: string[]): Promise<Record<string, any>> {
    if (!marketIds.length) {
      return {};
    }

    const identityResponse = await this.rmqRequest<{ data?: any[] }>(
      this.identityClient,
      { cmd: 'identity.market.find_by_ids' },
      { ids: marketIds },
    );
    const markets = Array.isArray(identityResponse?.data) ? identityResponse.data : [];
    if (!markets.length) {
      return {};
    }

    const rows = await Promise.all(
      markets.map(async (market) => {
        const marketId = String(market.id);
        const [productsCount, orderStats] = await Promise.all([
          this.getProductsCountByMarket(marketId),
          this.getOrderStatsByMarket(marketId),
        ]);

        return {
          id: marketId,
          name: market.name ?? null,
          phone_number: market.phone_number ?? null,
          status: market.status ?? null,
          role: market.role ?? null,
          products_count: productsCount,
          total_orders: orderStats.total_orders,
          successful_orders: orderStats.successful_orders,
          cancelled_orders: orderStats.cancelled_orders,
        };
      }),
    );

    return rows.reduce<Record<string, any>>((acc, row) => {
      acc[String(row.id)] = row;
      return acc;
    }, {});
  }

  private async attachMarkets<T extends { market_id?: string | null }>(rows: T[]): Promise<Array<T & { market: any | null }>> {
    const marketIds = Array.from(
      new Set(
        rows
          .map((row) => (row.market_id ? String(row.market_id) : null))
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const marketsById = await this.fetchMarketsByIds(marketIds);

    return rows.map((row) => ({
      ...row,
      market: row.market_id ? marketsById[String(row.market_id)] ?? null : null,
    }));
  }

  private sanitizeMarket(market: any | null): any | null {
    if (!market || typeof market !== 'object') {
      return null;
    }

    const safeMarket = { ...market };
    delete safeMarket.password;
    delete safeMarket.refresh_token;
    delete safeMarket.market_tg_token;
    return safeMarket;
  }

  private sanitizeIntegrationRow(row: any): any {
    if (!row || typeof row !== 'object') {
      return row;
    }

    const safe = { ...row };
    delete safe.api_key;
    delete safe.api_secret;
    delete safe.password;
    safe.credentials = this.maskCredentials(safe.credentials);

    return {
      ...safe,
      market: this.sanitizeMarket(safe.market ?? null),
    };
  }

  private sanitizeIntegrationRows(rows: any[]): any[] {
    return rows.map((row) => this.sanitizeIntegrationRow(row));
  }

  private extractMarketsFromItems(items: any[]): { items: any[]; market: any | null; markets: any[] } {
    if (!Array.isArray(items) || items.length === 0) {
      return { items: [], market: null, markets: [] };
    }

    const marketsById = new Map<string, any>();
    const itemsWithoutMarket = items.map((item) => {
      const market = item?.market ?? null;
      if (market?.id) {
        marketsById.set(String(market.id), market);
      }
      const next = { ...item };
      delete next.market;
      return next;
    });

    const markets = Array.from(marketsById.values());
    const market = markets.length === 1 ? markets[0] : null;

    return { items: itemsWithoutMarket, market, markets };
  }

  private buildExternalUrl(baseUrl: string, endpoint?: string): string {
    if (!endpoint || !endpoint.trim()) {
      this.badRequest('External endpoint is required');
    }

    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      return endpoint;
    }

    return `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
  }

  private async executeExternalRequest(input: ExternalRequestInput) {
    const integration = await this.findActiveBySlug(input.slug);
    const method = (input.method ?? 'POST').toUpperCase() as HttpMethod;
    const url = this.buildExternalUrl(integration.api_url, input.endpoint);
    const useAuth = input.use_auth ?? true;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(input.headers ?? {}),
    };

    const syncConfig = this.toSyncConfig(integration);
    const headerPrefix = syncConfig.auth?.header_prefix ?? 'Bearer';

    if (useAuth) {
      const token = await this.getValidToken(integration);
      if (token) {
        headers.Authorization = `${headerPrefix} ${token}`;
      }
    }

    try {
      const query =
        input.params && Object.keys(input.params).length > 0
          ? `?${new URLSearchParams(
              Object.entries(input.params).reduce<Record<string, string>>((acc, [k, v]) => {
                if (typeof v === 'undefined' || v === null) {
                  return acc;
                }
                acc[k] = String(v);
                return acc;
              }, {}),
            ).toString()}`
          : '';
      const finalUrl = `${url}${query}`;

      const response = await fetch(finalUrl, {
        method,
        headers,
        body: typeof input.body === 'undefined' || method === 'GET' ? undefined : JSON.stringify(input.body),
      });

      const rawText = await response.text();
      const responseData =
        rawText && rawText.trim().length
          ? (() => {
              try {
                return JSON.parse(rawText);
              } catch {
                return rawText;
              }
            })()
          : null;

      if (!response.ok) {
        if (response.status === 401) {
          this.clearTokenCache(integration.id);
        }
        throw new RpcException(
          errorRes(
            typeof responseData === 'object' && responseData && 'message' in responseData
              ? String((responseData as Record<string, unknown>).message)
              : `External request failed with status ${response.status}`,
            response.status,
            responseData,
          ),
        );
      }

      return successRes({
        integration: {
          id: integration.id,
          slug: integration.slug,
          name: integration.name,
        },
        request: {
          method,
          url: finalUrl,
        },
        raw: responseData,
        data: this.extractPath(responseData, input.response_path),
      });
    } catch (error: any) {
      if (error instanceof RpcException) {
        throw error;
      }

      const message = error?.message ?? 'External request failed';
      throw new RpcException(errorRes(String(message), 502));
    }
  }

  async createIntegration(dto: Partial<ExternalIntegration>) {
    const name = String(dto.name ?? '').trim();
    const slug = String(dto.slug ?? this.slugify(name)).trim();
    if (!slug) {
      this.badRequest('slug is required');
    }

    const existing = await this.integrationRepo.findOne({
      where: { slug, isDeleted: false },
    });
    if (existing) {
      this.badRequest('integration slug already exists');
    }

    const baseUrl = String((dto as any).base_url ?? dto.api_url ?? '').trim();
    if (!baseUrl) {
      this.badRequest('base_url is required');
    }

    const status = this.normalizeStatus((dto as any).status ?? (dto.is_active === false ? 'inactive' : 'active'));
    const integrationType = this.normalizeType((dto as any).type);

    const credentialsInput =
      ((dto as any).credentials && typeof (dto as any).credentials === 'object'
        ? ((dto as any).credentials as Record<string, unknown>)
        : null) ?? {};
    const authType = (String(
      dto.auth_type ??
        (credentialsInput.auth_type as string | undefined) ??
        (credentialsInput.api_key ? 'api_key' : 'login'),
    ).toLowerCase() === 'login'
      ? 'login'
      : 'api_key') as 'api_key' | 'login';
    const apiKey = (dto.api_key ?? (credentialsInput.api_key as string | undefined) ?? null) as string | null;
    const apiSecret = (dto.api_secret ?? (credentialsInput.api_secret as string | undefined) ?? null) as
      | string
      | null;
    const username = (dto.username ?? (credentialsInput.username as string | undefined) ?? null) as string | null;
    const password = (dto.password ?? (credentialsInput.password as string | undefined) ?? null) as string | null;
    const authUrl = (dto.auth_url ?? (credentialsInput.auth_url as string | undefined) ?? null) as string | null;
    const mergedCredentials = {
      ...credentialsInput,
      ...(apiKey ? { api_key: apiKey } : {}),
      ...(apiSecret ? { api_secret: apiSecret } : {}),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      ...(authUrl ? { auth_url: authUrl } : {}),
      auth_type: authType,
    };

    const entity = this.integrationRepo.create({
      name: name || slug,
      slug,
      type: integrationType,
      base_url: baseUrl,
      credentials: this.normalizeCredentialsForStorage(mergedCredentials),
      status,
      api_url: baseUrl,
      api_key: this.encryptCredential(apiKey),
      api_secret: this.encryptCredential(apiSecret),
      auth_type: authType,
      auth_url: authUrl,
      username,
      password: this.encryptCredential(password),
      market_id: dto.market_id ?? null,
      is_active: status === 'active',
      field_mapping: dto.field_mapping ?? null,
      status_mapping: dto.status_mapping ?? null,
      status_sync_config: dto.status_sync_config ?? null,
      last_sync_at: null,
      total_synced_orders: 0,
    });

    const saved = await this.integrationRepo.save(entity);
    const [enriched] = await this.attachMarkets([saved as any]);
    return successRes(this.sanitizeIntegrationRow(enriched), 201, 'integration created');
  }

  async findAllIntegrations(query?: FindAllIntegrationsQuery) {
    const where: Record<string, unknown> = { isDeleted: false };

    const normalizedStatus = String(query?.status ?? '').toLowerCase();
    if (normalizedStatus === 'active') {
      where.is_active = true;
    } else if (normalizedStatus === 'inactive') {
      where.is_active = false;
    } else if (typeof query?.is_active !== 'undefined') {
      if (typeof query.is_active === 'boolean') {
        where.is_active = query.is_active;
      } else {
        where.is_active = ['true', '1', 'yes'].includes(String(query.is_active).toLowerCase());
      }
    }

    if (query?.market_id) {
      where.market_id = query.market_id;
    }

    const fromDate = query?.from_date ? new Date(query.from_date) : undefined;
    const toDate = query?.to_date ? new Date(query.to_date) : undefined;
    if (fromDate && Number.isNaN(fromDate.getTime())) {
      this.badRequest('from_date is invalid');
    }
    if (toDate && Number.isNaN(toDate.getTime())) {
      this.badRequest('to_date is invalid');
    }
    if (fromDate && toDate) {
      if (fromDate > toDate) {
        this.badRequest('from_date must be <= to_date');
      }
      where.createdAt = Between(fromDate, toDate);
    } else if (fromDate) {
      where.createdAt = Between(fromDate, new Date());
    } else if (toDate) {
      where.createdAt = Between(new Date(0), toDate);
    }

    const hasPagination = typeof query?.page !== 'undefined' || typeof query?.limit !== 'undefined';
    const page = Math.max(1, Number(query?.page ?? 1));
    const limit = Math.min(200, Math.max(1, Number(query?.limit ?? 10)));
    if (!Number.isFinite(page) || !Number.isFinite(limit)) {
      this.badRequest('page and limit must be numbers');
    }

    if (!hasPagination) {
      const rows = await this.integrationRepo.find({
        where,
        order: { createdAt: 'DESC' },
      });
      const enriched = await this.attachMarkets(rows as any);
      return successRes(this.sanitizeIntegrationRows(enriched as any[]));
    }

    const [items, total] = await this.integrationRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const enriched = await this.attachMarkets(items as any);
    const sanitizedItems = this.sanitizeIntegrationRows(enriched as any[]);
    const { items: itemsWithoutMarket, market, markets } = this.extractMarketsFromItems(sanitizedItems);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const rows = {
      items: itemsWithoutMarket,
      market,
      markets,
      meta: {
        page,
        limit,
        total,
        totalPages,
      },
    };

    return successRes(rows);
  }

  async findIntegrationById(id: string) {
    const row = await this.integrationRepo.findOne({ where: { id, isDeleted: false } });
    if (!row) {
      this.notFound('integration not found');
    }
    const [enriched] = await this.attachMarkets([row as any]);
    return successRes(this.sanitizeIntegrationRow(enriched));
  }

  async updateIntegration(id: string, dto: Partial<ExternalIntegration>) {
    const row = await this.integrationRepo.findOne({ where: { id, isDeleted: false } });
    if (!row) {
      this.notFound('integration not found');
    }

    if (dto.slug && dto.slug !== row.slug) {
      const exists = await this.integrationRepo.findOne({
        where: { slug: dto.slug, isDeleted: false },
      });
      if (exists) {
        this.badRequest('integration slug already exists');
      }
    }

    Object.assign(row, dto);
    if (typeof (dto as any).type !== 'undefined') {
      row.type = this.normalizeType((dto as any).type);
    }
    if (typeof (dto as any).base_url !== 'undefined') {
      const baseUrl = String((dto as any).base_url ?? '').trim();
      if (!baseUrl) {
        this.badRequest('base_url cannot be empty');
      }
      row.base_url = baseUrl;
      row.api_url = baseUrl;
    } else if (typeof dto.api_url !== 'undefined') {
      const apiUrl = String(dto.api_url ?? '').trim();
      if (!apiUrl) {
        this.badRequest('api_url cannot be empty');
      }
      row.api_url = apiUrl;
      row.base_url = apiUrl;
    }
    if (typeof (dto as any).status !== 'undefined') {
      row.status = this.normalizeStatus((dto as any).status);
      row.is_active = row.status === 'active';
    } else if (typeof dto.is_active !== 'undefined') {
      row.status = dto.is_active ? 'active' : 'inactive';
      row.is_active = Boolean(dto.is_active);
    }
    if (typeof (dto as any).credentials !== 'undefined') {
      const credentialsInput = ((dto as any).credentials ?? null) as Record<string, unknown> | null;
      row.credentials = this.normalizeCredentialsForStorage(credentialsInput);
      if (credentialsInput && typeof credentialsInput === 'object') {
        if (typeof credentialsInput.auth_type === 'string') {
          row.auth_type = credentialsInput.auth_type === 'login' ? 'login' : 'api_key';
        }
        if (typeof credentialsInput.api_key === 'string') {
          row.api_key = this.encryptCredential(credentialsInput.api_key);
        }
        if (typeof credentialsInput.api_secret === 'string') {
          row.api_secret = this.encryptCredential(credentialsInput.api_secret);
        }
        if (typeof credentialsInput.username === 'string') {
          row.username = credentialsInput.username;
        }
        if (typeof credentialsInput.password === 'string') {
          row.password = this.encryptCredential(credentialsInput.password);
        }
        if (typeof credentialsInput.auth_url === 'string') {
          row.auth_url = credentialsInput.auth_url;
        }
      }
    }
    if (typeof dto.api_key !== 'undefined') {
      row.api_key = this.encryptCredential(dto.api_key ?? null);
    }
    if (typeof dto.api_secret !== 'undefined') {
      row.api_secret = this.encryptCredential(dto.api_secret ?? null);
    }
    if (typeof dto.password !== 'undefined') {
      row.password = this.encryptCredential(dto.password ?? null);
    }
    if (typeof dto.auth_type !== 'undefined') {
      row.auth_type = dto.auth_type === 'login' ? 'login' : 'api_key';
    }
    const saved = await this.integrationRepo.save(row);
    const [enriched] = await this.attachMarkets([saved as any]);
    return successRes(this.sanitizeIntegrationRow(enriched), 200, 'integration updated');
  }

  async deleteIntegration(id: string) {
    const row = await this.integrationRepo.findOne({ where: { id, isDeleted: false } });
    if (!row) {
      this.notFound('integration not found');
    }

    if (row.is_active) {
      this.badRequest('integration must be inactive before delete');
    }

    row.isDeleted = true;
    row.is_active = false;
    row.status = 'inactive';
    const saved = await this.integrationRepo.save(row);
    this.clearTokenCache(saved.id);
    return successRes({ id: saved.id }, 200, 'integration deleted');
  }

  async healthcheckIntegration(input: {
    id?: string;
    slug?: string;
    endpoint?: string;
    method?: HttpMethod;
    use_auth?: boolean;
    timeout_ms?: number;
  }) {
    const id = String(input?.id ?? '').trim();
    const slug = String(input?.slug ?? '').trim();

    let integration: ExternalIntegration | null = null;
    if (id) {
      integration = await this.integrationRepo.findOne({ where: { id, isDeleted: false } });
    } else if (slug) {
      integration = await this.integrationRepo.findOne({ where: { slug, isDeleted: false } });
    }

    if (!integration) {
      this.notFound('integration not found');
    }

    const method = (input?.method ?? 'GET').toUpperCase() as HttpMethod;
    const endpoint = input?.endpoint ?? '/';
    const url = this.buildExternalUrl(integration.api_url, endpoint);
    const useAuth = input?.use_auth ?? true;

    const headers: Record<string, string> = {};
    const syncConfig = this.toSyncConfig(integration);
    const headerPrefix = syncConfig.auth?.header_prefix ?? 'Bearer';

    if (useAuth) {
      const token = await this.getValidToken(integration);
      if (token) {
        headers.Authorization = `${headerPrefix} ${token}`;
      }
    }

    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(Math.max(1000, input?.timeout_ms ?? 8000)),
      });

      return successRes(
        {
          ok: response.ok,
          status: response.status,
          response_time_ms: Date.now() - startedAt,
          method,
          url,
          integration: {
            id: integration.id,
            slug: integration.slug,
            name: integration.name,
            is_active: integration.is_active,
          },
        },
        200,
        'integration healthcheck completed',
      );
    } catch (error: any) {
      return errorRes(
        error?.message ? String(error.message) : 'integration healthcheck failed',
        502,
        {
          ok: false,
          response_time_ms: Date.now() - startedAt,
          method,
          url,
          integration: {
            id: integration.id,
            slug: integration.slug,
            name: integration.name,
            is_active: integration.is_active,
          },
        },
      );
    }
  }

  async externalRequest(input: ExternalRequestInput) {
    return this.executeExternalRequest(input);
  }

  async searchByQr(input: QrSearchInput) {
    if (!input.qr_code?.trim()) {
      this.badRequest('qr_code is required');
    }

    const integration = await this.findActiveBySlug(input.slug);
    const syncConfig = this.toSyncConfig(integration);
    const searchConfig = syncConfig.external_search ?? {};
    const method = (input.method ?? searchConfig.method ?? 'POST').toUpperCase() as HttpMethod;
    const qrField = input.qr_field ?? searchConfig.qr_field ?? 'qr_code';
    const endpoint = input.endpoint ?? searchConfig.endpoint;
    const responsePath = input.response_path ?? searchConfig.response_path;

    const context = { qr_code: input.qr_code };
    const paramsFromTemplate =
      (this.interpolate(searchConfig.query_template ?? {}, context) as Record<string, unknown>) ?? {};
    const bodyFromTemplate =
      (this.interpolate(searchConfig.body_template ?? {}, context) as Record<string, unknown>) ?? {};

    const params = method === 'GET' ? { ...paramsFromTemplate, [qrField]: input.qr_code } : paramsFromTemplate;
    const body = method === 'GET' ? undefined : { ...bodyFromTemplate, [qrField]: input.qr_code };

    return this.executeExternalRequest({
      slug: input.slug,
      endpoint,
      method,
      params,
      body,
      headers: searchConfig.headers ?? undefined,
      use_auth: searchConfig.use_auth ?? true,
      timeout_ms: input.timeout_ms ?? searchConfig.timeout_ms,
      response_path: responsePath,
    });
  }

  async getQueueStatus() {
    const [pending, processing, completed, failed, permanentlyFailed, legacySuccess] = await Promise.all([
      this.syncQueueRepo.count({ where: { status: 'pending' } }),
      this.syncQueueRepo.count({ where: { status: 'processing' } }),
      this.syncQueueRepo.count({ where: { status: 'completed' as any } }),
      this.syncQueueRepo.count({ where: { status: 'failed' } }),
      this.syncQueueRepo.count({ where: { status: 'permanently_failed' as any } }),
      this.syncQueueRepo.count({ where: { status: 'success' as any } }),
    ]);

    return successRes({
      pending,
      processing,
      completed: completed + legacySuccess,
      failed,
      permanently_failed: permanentlyFailed,
    });
  }

  async getSyncHistory(query?: SyncHistoryQuery) {
    const where: Record<string, unknown> = {};

    if (query?.integration_id) {
      where.integration_id = query.integration_id;
    }

    const normalizedStatus = String(query?.status ?? '').toLowerCase();
    if (normalizedStatus === 'success' || normalizedStatus === 'failed') {
      where.status = normalizedStatus;
    }

    const fromDate = query?.from_date ? new Date(query.from_date) : undefined;
    const toDate = query?.to_date ? new Date(query.to_date) : undefined;
    if (fromDate && Number.isNaN(fromDate.getTime())) {
      this.badRequest('from_date is invalid');
    }
    if (toDate && Number.isNaN(toDate.getTime())) {
      this.badRequest('to_date is invalid');
    }
    if (fromDate && toDate) {
      if (fromDate > toDate) {
        this.badRequest('from_date must be <= to_date');
      }
      where.sync_date = Between(fromDate.getTime(), toDate.getTime());
    } else if (fromDate) {
      where.sync_date = Between(fromDate.getTime(), Date.now());
    } else if (toDate) {
      where.sync_date = Between(0, toDate.getTime());
    }

    const page = Math.max(1, Number(query?.page ?? 1));
    const limit = Math.min(200, Math.max(1, Number(query?.limit ?? 20)));
    if (!Number.isFinite(page) || !Number.isFinite(limit)) {
      this.badRequest('page and limit must be numbers');
    }

    const [items, total] = await this.syncHistoryRepo.findAndCount({
      where,
      order: { sync_date: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const successCount = await this.syncHistoryRepo.count({
      where: { ...where, status: 'success' as any },
    });
    const failedCount = await this.syncHistoryRepo.count({
      where: { ...where, status: 'failed' as any },
    });
    const totalAttempts = successCount + failedCount;
    const success_rate = totalAttempts > 0 ? Number(((successCount * 100) / totalAttempts).toFixed(2)) : 0;

    return successRes({
      items,
      summary: {
        total_attempts: totalAttempts,
        success_count: successCount,
        failed_count: failedCount,
        success_rate,
      },
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  }

  private async writeSyncHistoryAttempt(params: {
    queue: SyncQueue;
    integration_name?: string | null;
    status: 'success' | 'failed';
    result?: Record<string, any> | null;
  }) {
    await this.syncHistoryRepo.save(
      this.syncHistoryRepo.create({
        sync_queue_id: params.queue.id,
        integration_id: params.queue.integration_id,
        integration_name: params.integration_name ?? 'unknown',
        synced_orders: params.status === 'success' ? 1 : 0,
        status: params.status,
        result: params.result ?? null,
        sync_date: Date.now(),
        attempted_at: new Date(),
      }),
    );
  }

  private resolveExternalStatus(integration: ExternalIntegration, action: string, newStatus?: string): string {
    const mapping = (integration.status_mapping ?? {}) as Record<string, string>;
    const candidates = [newStatus, action].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (mapping[candidate]) {
        return String(mapping[candidate]);
      }
      const lower = candidate.toLowerCase();
      if (mapping[lower]) {
        return String(mapping[lower]);
      }
      const upper = candidate.toUpperCase();
      if (mapping[upper]) {
        return String(mapping[upper]);
      }
    }

    return String(newStatus ?? action);
  }

  async enqueueSync(input: {
    order_id?: string;
    external_order_id?: string;
    operator?: string;
    integration_id?: string;
    action: 'sold' | 'canceled' | 'paid' | 'rollback' | 'waiting' | 'create' | 'update' | 'delete';
    entity_type?: string;
    entity_id?: string;
    payload?: Record<string, unknown>;
    old_status?: string;
    new_status?: string;
  }) {
    const action = String(input?.action ?? '').toLowerCase();
    const isGenericAction = ['create', 'update', 'delete'].includes(action);
    if (!isGenericAction && !input?.order_id) {
      this.badRequest('order_id is required');
    }
    if (isGenericAction) {
      if (!input?.integration_id) {
        this.badRequest('integration_id is required');
      }
      if (!input?.entity_type?.trim()) {
        this.badRequest('entity_type is required');
      }
      if (!input?.entity_id?.trim()) {
        this.badRequest('entity_id is required');
      }
    }

    const operator = String(input?.operator ?? '').trim();
    const slugFromOperator = operator.startsWith('external_')
      ? operator.slice('external_'.length)
      : '';

    const integration = input?.integration_id
      ? await this.integrationRepo.findOne({
          where: { id: String(input.integration_id), isDeleted: false },
        })
      : await this.integrationRepo.findOne({
          where: { slug: slugFromOperator, isDeleted: false },
        });

    if (!integration) {
      return errorRes('integration not found for sync enqueue', 404, {
        operator,
        integration_id: input?.integration_id ?? null,
      });
    }

    const externalStatus = isGenericAction
      ? null
      : this.resolveExternalStatus(integration, input.action, input.new_status);
    const syncConfig = this.toSyncConfig(integration);
    const updateConfig = syncConfig.external_update ?? {};

    const context = {
      order_id: String(input.order_id),
      external_order_id: String(input.external_order_id ?? ''),
      external_status: String(externalStatus),
      action: String(input.action ?? ''),
      old_status: String(input.old_status ?? ''),
      new_status: String(input.new_status ?? ''),
    };

    const queue = this.syncQueueRepo.create({
      order_id: input.order_id ? String(input.order_id) : null,
      integration_id: String(integration.id),
      action: input.action,
      entity_type: isGenericAction ? String(input.entity_type) : null,
      entity_id: isGenericAction ? String(input.entity_id) : null,
      old_status: input.old_status ?? null,
      new_status: input.new_status ?? null,
      external_status: externalStatus,
      payload: (input.payload as Record<string, string> | undefined) ?? context,
      status: 'pending',
      attempts: 0,
      retry_count: 0,
      // initial attempt + max 3 retries
      max_attempts: 4,
      external_order_id:
        !isGenericAction && input.external_order_id ? String(input.external_order_id) : null,
      last_error: null,
      last_response: null,
      synced_at: null,
      next_retry_at: null,
    });
    const savedQueue = await this.syncQueueRepo.save(queue);

    await this.processPendingSyncQueue(1);
    const updated = await this.syncQueueRepo.findOne({ where: { id: savedQueue.id } });
    return successRes(updated ?? savedQueue, 201, 'sync enqueued');
  }

  private async processQueueItem(queue: SyncQueue): Promise<SyncQueue> {
    queue.status = 'processing';
    queue.attempts = Number(queue.attempts ?? 0) + 1;
    queue.retry_count = Math.min(
      Math.max(0, Number(queue.max_attempts ?? 4) - 1),
      Math.max(0, Number(queue.attempts ?? 0) - 1),
    );
    queue.last_error = null;
    await this.syncQueueRepo.save(queue);

    const integration = await this.integrationRepo.findOne({
      where: { id: String(queue.integration_id), isDeleted: false },
    });

    if (!integration) {
      queue.status = 'failed';
      queue.last_error = 'integration not found for queue item';
      queue.next_retry_at = null;
      await this.syncQueueRepo.save(queue);
      await this.writeSyncHistoryAttempt({
        queue,
        integration_name: null,
        status: 'failed',
        result: { error: queue.last_error },
      });
      return queue;
    }

    const syncConfig = this.toSyncConfig(integration);
    const updateConfig = syncConfig.external_update ?? {};
    const endpoint = updateConfig.endpoint;

    if (!endpoint) {
      queue.status = 'failed';
      queue.last_error = 'status_sync_config.external_update.endpoint is required';
      queue.next_retry_at = null;
      await this.syncQueueRepo.save(queue);
      await this.writeSyncHistoryAttempt({
        queue,
        integration_name: integration.name,
        status: 'failed',
        result: { error: queue.last_error },
      });
      return queue;
    }

    const method = (updateConfig.method ?? 'POST').toUpperCase() as HttpMethod;
    const orderIdField = updateConfig.order_id_field ?? 'id';
    const statusField = updateConfig.status_field ?? 'status';
    const isGenericAction = ['create', 'update', 'delete'].includes(String(queue.action));
    const payload = (queue.payload ?? {}) as Record<string, string>;
    const queryFromTemplate =
      (this.interpolate(updateConfig.query_template ?? {}, payload) as Record<string, unknown>) ?? {};
    const bodyFromTemplate =
      (this.interpolate(updateConfig.body_template ?? {}, payload) as Record<string, unknown>) ?? {};

    const externalOrderId = queue.external_order_id ?? queue.order_id ?? queue.entity_id;
    const externalStatus = queue.external_status ?? queue.new_status ?? queue.action;

    const params =
      method === 'GET'
        ? isGenericAction
          ? {
              ...queryFromTemplate,
              entity_type: queue.entity_type,
              entity_id: queue.entity_id,
              action: queue.action,
            }
          : {
              ...queryFromTemplate,
              [orderIdField]: externalOrderId,
              [statusField]: externalStatus,
            }
        : queryFromTemplate;
    const body =
      method === 'GET'
        ? undefined
        : isGenericAction
          ? {
              ...bodyFromTemplate,
              entity_type: queue.entity_type,
              entity_id: queue.entity_id,
              action: queue.action,
              ...(queue.payload ?? {}),
            }
          : {
              ...bodyFromTemplate,
              [orderIdField]: externalOrderId,
              [statusField]: externalStatus,
            };

    try {
      const requestResult = await this.executeExternalRequest({
        slug: integration.slug,
        endpoint,
        method,
        params,
        body,
        headers: updateConfig.headers ?? undefined,
        use_auth: updateConfig.use_auth ?? true,
        timeout_ms: 30000,
        response_path: updateConfig.response_path,
      });

      queue.status = 'completed' as any;
      queue.last_error = null;
      queue.last_response = requestResult as Record<string, unknown>;
      queue.synced_at = new Date();
      queue.next_retry_at = null;
      await this.syncQueueRepo.save(queue);

      integration.last_sync_at = new Date();
      integration.total_synced_orders = Number(integration.total_synced_orders ?? 0) + 1;
      await this.integrationRepo.save(integration);

      await this.writeSyncHistoryAttempt({
        queue,
        integration_name: integration.name,
        status: 'success',
        result: requestResult as Record<string, any>,
      });

      return queue;
    } catch (error: any) {
      const message = (() => {
        if (error?.response?.message) return String(error.response.message);
        if (error?.message) return String(error.message);
        return 'external status sync failed';
      })();

      queue.last_error = message;
      queue.last_response = error?.response ?? null;
      if (Number(queue.attempts) < Number(queue.max_attempts ?? 4)) {
        queue.status = 'pending';
        queue.retry_count = Math.min(
          Math.max(0, Number(queue.max_attempts ?? 4) - 1),
          Math.max(0, Number(queue.attempts ?? 0)),
        );
        queue.next_retry_at = new Date(Date.now() + this.getRetryDelayMs(Number(queue.attempts)));
      } else {
        queue.status = 'permanently_failed' as any;
        queue.retry_count = Math.max(0, Number(queue.max_attempts ?? 4) - 1);
        queue.next_retry_at = null;
        await this.notifyAdminsAboutPermanentFailure(queue, integration, message);
      }
      await this.syncQueueRepo.save(queue);
      await this.writeSyncHistoryAttempt({
        queue,
        integration_name: integration.name,
        status: 'failed',
        result: {
          error: message,
          response: error?.response ?? null,
        },
      });
      return queue;
    }
  }

  // 0x494e5447515545 = "INTGQUE" ASCII. Postgres advisory locks are
  // session-scoped → released automatically if the connection dies, so a
  // crashed processor never leaves the queue blocked.
  private static readonly QUEUE_ADVISORY_LOCK_KEY = 0x494e5447515545n;

  async processPendingSyncQueue(limit = 20, integration_id?: string) {
    // Advisory locks are session-scoped — acquire/release MUST run on the
    // same connection. A dedicated QueryRunner pins one connection for the
    // entire critical section (pooled queries elsewhere don't interfere).
    const queryRunner = this.syncQueueRepo.manager.connection.createQueryRunner();
    await queryRunner.connect();

    let acquired = false;
    try {
      const lockRows = await queryRunner.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [IntegrationServiceService.QUEUE_ADVISORY_LOCK_KEY.toString()],
      );
      acquired = Boolean(lockRows?.[0]?.acquired);
      if (!acquired) {
        return successRes({ message: 'queue processor is already running' });
      }

      let processed = 0;
      let completed = 0;
      let failed = 0;

      while (processed < Math.max(1, limit)) {
        const now = new Date();
        const pendingWhere = integration_id
          ? [
              { status: 'pending', next_retry_at: IsNull(), integration_id },
              { status: 'pending', next_retry_at: LessThanOrEqual(now), integration_id },
            ]
          : [
              { status: 'pending', next_retry_at: IsNull() },
              { status: 'pending', next_retry_at: LessThanOrEqual(now) },
            ];

        const queue = await this.syncQueueRepo.findOne({
          where: pendingWhere as any,
          order: { createdAt: 'ASC' },
        });

        if (!queue) {
          break;
        }

        const result = await this.processQueueItem(queue);
        processed += 1;
        if (result.status === ('completed' as any) || result.status === ('success' as any)) {
          completed += 1;
        } else if (result.status === 'failed' || result.status === ('permanently_failed' as any)) {
          failed += 1;
        }
      }

      return successRes(
        { processed, completed, failed },
        200,
        'sync queue processed',
      );
    } finally {
      if (acquired) {
        try {
          // unlock_all is bulletproof: even if our explicit unlock fails (or
          // is somehow skipped), the connection cannot return to the pool
          // still holding our lock. Pooled connections persist across users,
          // so a stuck lock would silently block every future processor.
          await queryRunner.query('SELECT pg_advisory_unlock_all()');
        } catch (err) {
          this.logger.warn(
            `pg_advisory_unlock_all failed: ${(err as Error)?.message ?? err}`,
          );
        }
      }
      await queryRunner.release();
    }
  }

  async retrySyncQueue(queue_id?: string, integration_id?: string) {
    if (queue_id) {
      const row = await this.syncQueueRepo.findOne({
        where: integration_id
          ? [
              { id: String(queue_id), integration_id, status: 'failed' as any },
              { id: String(queue_id), integration_id, status: 'permanently_failed' as any },
            ]
          : [
              { id: String(queue_id), status: 'failed' as any },
              { id: String(queue_id), status: 'permanently_failed' as any },
            ],
      });
      if (!row) {
        this.notFound('failed/permanently_failed sync queue item not found');
      }
      row.status = 'pending';
      row.retry_count = 0;
      row.next_retry_at = null;
      await this.syncQueueRepo.save(row);
      return this.processPendingSyncQueue(1, integration_id);
    }

    const rows = await this.syncQueueRepo.find({
      where: integration_id
        ? [
            { integration_id, status: 'failed' as any },
            { integration_id, status: 'permanently_failed' as any },
          ]
        : [
            { status: 'failed' as any },
            { status: 'permanently_failed' as any },
          ],
      take: 20,
      order: { createdAt: 'ASC' },
    });

    for (const row of rows) {
      row.status = 'pending';
      row.retry_count = 0;
      row.next_retry_at = null;
      await this.syncQueueRepo.save(row);
    }

    return this.processPendingSyncQueue(Math.max(1, rows.length), integration_id);
  }

  // ===========================================================================
  // Inbound webhooks (provider → Elchi)
  // ===========================================================================

  /**
   * Receive and authenticate an inbound webhook from any provider.
   *
   * Provider-agnostic: the integration is resolved by slug, its webhook config
   * (secret, signature header/scheme, id header) drives verification, and the
   * result is logged for audit + replay protection. This is the single entry
   * point all carriers/marketplaces call back into.
   *
   * Returns a small status object; the caller (gateway) maps it to an HTTP
   * code. We deliberately return 200-style success even when processing of a
   * verified event fails downstream — the event is logged and can be replayed
   * — but signature failures return an auth error so a misconfigured or
   * malicious sender gets a clear rejection and the event never enters the
   * processing path.
   */
  async receiveWebhook(input: {
    slug: string;
    raw_body_base64?: string;
    raw_body?: string;
    headers?: Record<string, string>;
    trace_id?: string | null;
  }) {
    const slug = String(input.slug ?? '').trim();
    const headers = this.lowercaseHeaders(input.headers);
    const rawBody = input.raw_body_base64
      ? Buffer.from(input.raw_body_base64, 'base64')
      : Buffer.from(input.raw_body ?? '', 'utf8');

    const integration = slug
      ? await this.integrationRepo.findOne({
          where: { slug, isDeleted: false },
        })
      : null;

    if (!integration) {
      // Unknown provider — log with no integration_id so abuse is visible,
      // then reject. Don't reveal whether the slug exists.
      await this.saveWebhookLog({
        integration_id: null,
        provider_slug: slug || null,
        delivery_id: null,
        event_type: null,
        signature_valid: false,
        status: 'rejected',
        raw_body: this.truncateBody(rawBody.toString('utf8')),
        parsed_payload: null,
        error: 'integration not found',
        trace_id: input.trace_id ?? null,
      });
      return { ok: false, code: 401, reason: 'unknown_provider' };
    }

    const secret = this.decryptCredential(integration.webhook_secret);
    if (!secret) {
      await this.saveWebhookLog({
        integration_id: String(integration.id),
        provider_slug: integration.slug,
        delivery_id: null,
        event_type: null,
        signature_valid: false,
        status: 'rejected',
        raw_body: this.truncateBody(rawBody.toString('utf8')),
        parsed_payload: null,
        error: 'webhook_secret not configured',
        trace_id: input.trace_id ?? null,
      });
      return { ok: false, code: 401, reason: 'not_configured' };
    }

    const signatureHeader = (
      integration.webhook_signature_header ?? 'x-signature'
    ).toLowerCase();
    const signature = headers[signatureHeader] ?? '';
    const algorithm = (integration.webhook_algorithm ??
      'sha256') as HmacAlgorithm;

    const verification = verifyHmacSignature({
      rawBody,
      signature,
      secret,
      previousSecret: this.decryptCredential(
        integration.webhook_secret_previous,
      ),
      stripPrefix: integration.webhook_signature_prefix ?? undefined,
      algorithm,
    });

    const deliveryId = integration.webhook_id_header
      ? (headers[integration.webhook_id_header.toLowerCase()] ?? null)
      : null;
    const parsed = this.tryParseJson(rawBody.toString('utf8'));
    const eventType = this.extractEventType(parsed, headers);

    if (!verification.valid) {
      await this.saveWebhookLog({
        integration_id: String(integration.id),
        provider_slug: integration.slug,
        delivery_id: deliveryId,
        event_type: eventType,
        signature_valid: false,
        status: 'rejected',
        raw_body: this.truncateBody(rawBody.toString('utf8')),
        parsed_payload: parsed,
        error: `signature ${verification.reason ?? 'invalid'}`,
        trace_id: input.trace_id ?? null,
      });
      this.logger.warn(
        `webhook signature rejected for ${integration.slug}: ${verification.reason}`,
      );
      return { ok: false, code: 401, reason: 'invalid_signature' };
    }

    // Replay protection: if this provider sends a delivery id and we've
    // already logged it, treat as an idempotent re-delivery.
    if (deliveryId) {
      const existing = await this.webhookLogRepo.findOne({
        where: {
          integration_id: String(integration.id),
          delivery_id: deliveryId,
        },
      });
      if (existing) {
        return { ok: true, code: 200, reason: 'duplicate', replay: true };
      }
    }

    const log = await this.saveWebhookLog({
      integration_id: String(integration.id),
      provider_slug: integration.slug,
      delivery_id: deliveryId,
      event_type: eventType,
      signature_valid: true,
      status: 'verified',
      raw_body: this.truncateBody(rawBody.toString('utf8')),
      parsed_payload: parsed,
      error: null,
      trace_id: input.trace_id ?? null,
    });

    // Routing/processing (shipment status application) lands in a follow-up.
    // For now the verified event is durably logged; record an audit entry so
    // operators can see inbound traffic immediately.
    await this.activityLog.log({
      entity_type: 'ProviderWebhook',
      entity_id: log?.id ?? deliveryId ?? integration.slug,
      action: ActivityAction.WEBHOOK_RECEIVED,
      new_value: { event_type: eventType, provider: integration.slug },
      metadata: { delivery_id: deliveryId },
    });

    return {
      ok: true,
      code: 200,
      reason: 'accepted',
      event_type: eventType,
      delivery_id: deliveryId,
      log_id: log?.id ?? null,
    };
  }

  private async saveWebhookLog(data: {
    integration_id: string | null;
    provider_slug: string | null;
    delivery_id: string | null;
    event_type: string | null;
    signature_valid: boolean;
    status: ProviderWebhookLog['status'];
    raw_body: string | null;
    parsed_payload: Record<string, unknown> | null;
    error: string | null;
    trace_id: string | null;
  }): Promise<ProviderWebhookLog | null> {
    try {
      const entity = this.webhookLogRepo.create({
        ...data,
        processed_at: data.status === 'processed' ? new Date() : null,
      });
      return await this.webhookLogRepo.save(entity);
    } catch (err) {
      // Unique violation on (integration_id, delivery_id) = concurrent replay;
      // not fatal. Any other failure must not break the webhook response.
      this.logger.warn(
        `webhook log write failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private lowercaseHeaders(
    headers?: Record<string, string>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) {
      out[k.toLowerCase()] = v;
    }
    return out;
  }

  private tryParseJson(body: string): Record<string, unknown> | null {
    if (!body.trim()) return null;
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed };
    } catch {
      return null;
    }
  }

  private extractEventType(
    parsed: Record<string, unknown> | null,
    headers: Record<string, string>,
  ): string | null {
    const fromHeader =
      headers['x-event'] ?? headers['x-event-type'] ?? headers['x-webhook-event'];
    if (fromHeader) return String(fromHeader);
    const candidate =
      parsed?.['event'] ?? parsed?.['event_type'] ?? parsed?.['type'];
    return candidate != null ? String(candidate) : null;
  }

  private truncateBody(body: string, max = 20_000): string {
    return body.length > max ? body.slice(0, max) : body;
  }

  // ===========================================================================
  // Provider shipments (order ↔ external shipment tracking)
  // ===========================================================================

  /**
   * Create or update the shipment row for an order (upsert on order_id).
   * Used by outbound dispatch (after creating a shipment at the provider) and
   * by reconcile/webhook updates. One shipment per order — a re-dispatch to a
   * different provider overwrites the provider fields on the same row.
   */
  async upsertShipment(input: {
    order_id: string;
    integration_id: string;
    provider_slug?: string | null;
    external_ref?: string | null;
    tracking_number?: string | null;
    provider_status?: string | null;
    internal_status?: string | null;
    last_request_id?: string | null;
    meta?: Record<string, unknown> | null;
    increment_attempt?: boolean;
    last_error?: string | null;
  }) {
    const orderId = String(input.order_id);
    let shipment = await this.shipmentRepo.findOne({
      where: { order_id: orderId },
    });

    if (!shipment) {
      shipment = this.shipmentRepo.create({
        order_id: orderId,
        integration_id: String(input.integration_id),
        send_attempts: 0,
      });
    }

    shipment.integration_id = String(input.integration_id);
    if (input.provider_slug !== undefined)
      shipment.provider_slug = input.provider_slug;
    if (input.external_ref !== undefined)
      shipment.external_ref = input.external_ref;
    if (input.tracking_number !== undefined)
      shipment.tracking_number = input.tracking_number;
    if (input.provider_status !== undefined) {
      shipment.provider_status = input.provider_status;
      shipment.status_changed_at = new Date();
    }
    if (input.internal_status !== undefined)
      shipment.internal_status = input.internal_status;
    if (input.last_request_id !== undefined)
      shipment.last_request_id = input.last_request_id;
    if (input.meta !== undefined) shipment.meta = input.meta;
    if (input.last_error !== undefined) shipment.last_error = input.last_error;
    if (input.increment_attempt) {
      shipment.send_attempts = Number(shipment.send_attempts ?? 0) + 1;
    }

    const saved = await this.shipmentRepo.save(shipment);
    return successRes(saved, 200, 'shipment upserted');
  }

  async getShipmentByOrder(order_id: string) {
    const shipment = await this.shipmentRepo.findOne({
      where: { order_id: String(order_id) },
    });
    if (!shipment) {
      return successRes(null, 200, 'no shipment for order');
    }
    return successRes(shipment, 200, 'shipment found');
  }

  /**
   * Look up a shipment from a webhook payload — providers reference an order
   * by either their own id (external_ref) or the tracking number.
   */
  async findShipmentByRef(input: {
    external_ref?: string | null;
    tracking_number?: string | null;
    integration_id?: string | null;
  }): Promise<ProviderShipment | null> {
    const { external_ref, tracking_number, integration_id } = input;
    if (external_ref) {
      const byRef = await this.shipmentRepo.findOne({
        where: integration_id
          ? { external_ref, integration_id: String(integration_id) }
          : { external_ref },
      });
      if (byRef) return byRef;
    }
    if (tracking_number) {
      const byTracking = await this.shipmentRepo.findOne({
        where: integration_id
          ? { tracking_number, integration_id: String(integration_id) }
          : { tracking_number },
      });
      if (byTracking) return byTracking;
    }
    return null;
  }

  async listShipments(input: {
    integration_id?: string;
    internal_status?: string;
    limit?: number;
    offset?: number;
  }) {
    const take = Math.min(Math.max(Number(input.limit ?? 50), 1), 200);
    const skip = Math.max(Number(input.offset ?? 0), 0);
    const where: Record<string, unknown> = { isDeleted: false };
    if (input.integration_id) where.integration_id = String(input.integration_id);
    if (input.internal_status) where.internal_status = input.internal_status;

    const [rows, total] = await this.shipmentRepo.findAndCount({
      where,
      order: { updatedAt: 'DESC', id: 'DESC' },
      take,
      skip,
    });
    return successRes({ rows, total, limit: take, offset: skip }, 200, 'shipments');
  }

  /**
   * Map a provider's raw status string to our internal handling using the
   * integration's inbound_status_mapping. Case-insensitive on the provider
   * code. Returns null when the provider status isn't mapped (caller decides
   * whether that's an intermediate status to ignore or a config gap to log).
   */
  mapProviderStatus(
    integration: Pick<ExternalIntegration, 'inbound_status_mapping'>,
    providerStatus: string,
  ): { status?: string; action?: string } | null {
    const mapping = integration.inbound_status_mapping ?? {};
    if (!providerStatus) return null;

    // Exact match first, then case-insensitive.
    if (mapping[providerStatus]) return mapping[providerStatus];
    const upper = providerStatus.toUpperCase();
    for (const [key, value] of Object.entries(mapping)) {
      if (key.toUpperCase() === upper) return value;
    }
    return null;
  }
}
