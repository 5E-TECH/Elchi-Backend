import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
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

@Injectable()
export class IntegrationServiceService {
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    @InjectRepository(ExternalIntegration) private readonly integrationRepo: Repository<ExternalIntegration>,
    @InjectRepository(SyncQueue) private readonly syncQueueRepo: Repository<SyncQueue>,
    @InjectRepository(SyncHistory) private readonly syncHistoryRepo: Repository<SyncHistory>,
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
    if (!integration.auth_url || !integration.username || !integration.password) {
      this.badRequest('Integration login config is incomplete');
    }

    const syncConfig = this.toSyncConfig(integration);
    const authConfig = syncConfig.auth ?? {};
    const method = (authConfig.login_method ?? 'POST').toUpperCase() as HttpMethod;
    const context = {
      username: integration.username,
      password: integration.password,
    };
    const payload =
      authConfig.login_payload_template && Object.keys(authConfig.login_payload_template).length
        ? this.interpolate(authConfig.login_payload_template, context)
        : { username: integration.username, password: integration.password };

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
      return integration.api_key ?? null;
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

  private async fetchMarketsByIds(marketIds: string[]): Promise<Record<string, any>> {
    if (!marketIds.length) {
      return {};
    }

    try {
      const rows: any[] = await this.integrationRepo.manager.query(
        `
          SELECT *
          FROM identity_schema.admins
          WHERE id::text = ANY($1::text[])
            AND "isDeleted" = false
            AND role = 'market'
        `,
        [marketIds],
      );

      return rows.reduce<Record<string, any>>((acc, row) => {
        acc[String(row.id)] = row;
        return acc;
      }, {});
    } catch {
      return {};
    }
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
    const slug = String(dto.slug ?? '').trim();
    if (!slug) {
      this.badRequest('slug is required');
    }

    const existing = await this.integrationRepo.findOne({
      where: { slug, isDeleted: false },
    });
    if (existing) {
      this.badRequest('integration slug already exists');
    }

    if (!dto.api_url) {
      this.badRequest('api_url is required');
    }

    const entity = this.integrationRepo.create({
      name: dto.name ?? slug,
      slug,
      api_url: dto.api_url,
      api_key: dto.api_key ?? null,
      api_secret: dto.api_secret ?? null,
      auth_type: dto.auth_type ?? 'api_key',
      auth_url: dto.auth_url ?? null,
      username: dto.username ?? null,
      password: dto.password ?? null,
      market_id: dto.market_id ?? null,
      is_active: dto.is_active ?? true,
      field_mapping: dto.field_mapping ?? null,
      status_mapping: dto.status_mapping ?? null,
      status_sync_config: dto.status_sync_config ?? null,
      last_sync_at: null,
      total_synced_orders: 0,
    });

    const saved = await this.integrationRepo.save(entity);
    const [enriched] = await this.attachMarkets([saved as any]);
    return successRes(enriched, 201, 'integration created');
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
      return successRes(rows);
    }

    const [items, total] = await this.integrationRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    })

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const rows = {
      items,
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
    return successRes(enriched);
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
    const saved = await this.integrationRepo.save(row);
    const [enriched] = await this.attachMarkets([saved as any]);
    return successRes(enriched, 200, 'integration updated');
  }

  async deleteIntegration(id: string) {
    const row = await this.integrationRepo.findOne({ where: { id, isDeleted: false } });
    if (!row) {
      this.notFound('integration not found');
    }

    row.isDeleted = true;
    row.is_active = false;
    const saved = await this.integrationRepo.save(row);
    this.clearTokenCache(saved.id);
    return successRes({ id: saved.id }, 200, 'integration deleted');
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
    const [pending, processing, success, failed] = await Promise.all([
      this.syncQueueRepo.count({ where: { status: 'pending' } }),
      this.syncQueueRepo.count({ where: { status: 'processing' } }),
      this.syncQueueRepo.count({ where: { status: 'success' } }),
      this.syncQueueRepo.count({ where: { status: 'failed' } }),
    ]);

    return successRes({ pending, processing, success, failed });
  }

  async getSyncHistory(limit = 50, integration_id?: string) {
    const where: Record<string, unknown> = {};
    if (integration_id) {
      where.integration_id = integration_id;
    }
    const rows = await this.syncHistoryRepo.find({
      where,
      order: { sync_date: 'DESC' },
      take: Math.max(1, Math.min(limit, 200)),
    });
    return successRes(rows);
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
    order_id: string;
    external_order_id?: string;
    operator?: string;
    integration_id?: string;
    action: 'sold' | 'canceled' | 'paid' | 'rollback' | 'waiting';
    old_status?: string;
    new_status?: string;
  }) {
    if (!input?.order_id) {
      this.badRequest('order_id is required');
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

    const externalStatus = this.resolveExternalStatus(
      integration,
      input.action,
      input.new_status,
    );
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
      order_id: String(input.order_id),
      integration_id: String(integration.id),
      action: input.action,
      old_status: input.old_status ?? null,
      new_status: input.new_status ?? null,
      external_status: externalStatus,
      payload: context,
      status: 'processing',
      attempts: 1,
      max_attempts: 3,
      external_order_id: input.external_order_id ? String(input.external_order_id) : null,
      last_error: null,
      last_response: null,
      synced_at: null,
      next_retry_at: null,
    });
    const savedQueue = await this.syncQueueRepo.save(queue);

    const endpoint = updateConfig.endpoint;
    if (!endpoint) {
      savedQueue.status = 'failed';
      savedQueue.last_error = 'status_sync_config.external_update.endpoint is required';
      savedQueue.next_retry_at = null;
      await this.syncQueueRepo.save(savedQueue);
      return errorRes(savedQueue.last_error, 400, savedQueue);
    }

    const method = (updateConfig.method ?? 'POST').toUpperCase() as HttpMethod;
    const orderIdField = updateConfig.order_id_field ?? 'id';
    const statusField = updateConfig.status_field ?? 'status';
    const queryFromTemplate =
      (this.interpolate(updateConfig.query_template ?? {}, context) as Record<string, unknown>) ?? {};
    const bodyFromTemplate =
      (this.interpolate(updateConfig.body_template ?? {}, context) as Record<string, unknown>) ?? {};

    const params =
      method === 'GET'
        ? {
            ...queryFromTemplate,
            [orderIdField]: input.external_order_id ?? input.order_id,
            [statusField]: externalStatus,
          }
        : queryFromTemplate;
    const body =
      method === 'GET'
        ? undefined
        : {
            ...bodyFromTemplate,
            [orderIdField]: input.external_order_id ?? input.order_id,
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
        timeout_ms: updateConfig.timeout_ms,
        response_path: updateConfig.response_path,
      });

      savedQueue.status = 'success';
      savedQueue.last_error = null;
      savedQueue.last_response = requestResult as Record<string, unknown>;
      savedQueue.synced_at = new Date();
      savedQueue.next_retry_at = null;
      await this.syncQueueRepo.save(savedQueue);

      integration.last_sync_at = new Date();
      integration.total_synced_orders = Number(integration.total_synced_orders ?? 0) + 1;
      await this.integrationRepo.save(integration);

      await this.syncHistoryRepo.save(
        this.syncHistoryRepo.create({
          integration_id: integration.id,
          integration_name: integration.name,
          synced_orders: 1,
          sync_date: Date.now(),
        }),
      );

      return successRes(savedQueue, 201, 'sync enqueued and processed');
    } catch (error: any) {
      const message = (() => {
        if (error?.response?.message) return String(error.response.message);
        if (error?.message) return String(error.message);
        return 'external status sync failed';
      })();

      savedQueue.status = 'failed';
      savedQueue.last_error = message;
      savedQueue.last_response = error?.response ?? null;
      savedQueue.next_retry_at = null;
      await this.syncQueueRepo.save(savedQueue);

      return errorRes(message, 502, savedQueue);
    }
  }
}
