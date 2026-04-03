import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { Order_status } from '@app/common';
import { ExternalIntegration } from './entities/external-integration.entity';
import { SyncQueue } from './entities/sync-queue.entity';
import { SyncHistory } from './entities/sync-history.entity';
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
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();
  private readonly credentialSecret = process.env.INTEGRATION_CREDENTIAL_SECRET || 'elchi-integration-secret';
  private queueProcessing = false;

  constructor(
    @InjectRepository(ExternalIntegration) private readonly integrationRepo: Repository<ExternalIntegration>,
    @InjectRepository(SyncQueue) private readonly syncQueueRepo: Repository<SyncQueue>,
    @InjectRepository(SyncHistory) private readonly syncHistoryRepo: Repository<SyncHistory>,
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

  private getCredentialKey(): Buffer {
    return createHash('sha256').update(this.credentialSecret).digest();
  }

  private encryptCredential(value?: string | null): string | null {
    if (!value) {
      return null;
    }

    if (value.startsWith('enc:')) {
      return value;
    }

    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', this.getCredentialKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `enc:${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  private decryptCredential(value?: string | null): string | null {
    if (!value) {
      return null;
    }

    if (!value.startsWith('enc:')) {
      return value;
    }

    try {
      const [, ivHex, encryptedHex] = value.split(':');
      if (!ivHex || !encryptedHex) {
        return value;
      }
      const iv = Buffer.from(ivHex, 'hex');
      const encrypted = Buffer.from(encryptedHex, 'hex');
      const decipher = createDecipheriv('aes-256-cbc', this.getCredentialKey(), iv);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString('utf8');
    } catch {
      return value;
    }
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

  async processPendingSyncQueue(limit = 20, integration_id?: string) {
    if (this.queueProcessing) {
      return successRes({ message: 'queue processor is already running' });
    }

    this.queueProcessing = true;
    let processed = 0;
    let completed = 0;
    let failed = 0;

    try {
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
        {
          processed,
          completed,
          failed,
        },
        200,
        'sync queue processed',
      );
    } finally {
      this.queueProcessing = false;
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
}
