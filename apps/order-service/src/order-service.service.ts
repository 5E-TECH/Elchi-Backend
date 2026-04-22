import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { Between, Brackets, DataSource, In, QueryFailedError, Repository } from 'typeorm';
import { lastValueFrom, timeout } from 'rxjs';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Order_source } from './entities/order.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import {
  Cashbox_type,
  Operation_type,
  Order_status,
  PaymentMethod,
  Post_status,
  Roles,
  Source_type,
  Where_deliver,
  rmqSend,
  RMQ_SERVICE_TIMEOUT,
} from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';

@Injectable()
export class OrderServiceService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepo: Repository<OrderItem>,
    @InjectRepository(OrderTracking)
    private readonly orderTrackingRepo: Repository<OrderTracking>,
    @Inject('SEARCH') private readonly searchClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
  ) {}

  private async syncOrderToSearch(order: Order): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.upsert' },
            {
              source: 'order',
              type: 'order',
              sourceId: order.id,
              title: `Order #${order.id}`,
              content: [order.status, order.address, order.comment, order.market_id, order.customer_id]
                .filter(Boolean)
                .join(' '),
              tags: ['order', order.status, order.where_deliver].filter(Boolean),
              metadata: {
                status: order.status,
                market_id: order.market_id,
                customer_id: order.customer_id,
                post_id: order.post_id,
                canceled_post_id: order.canceled_post_id,
                region_id: order.region_id,
                district_id: order.district_id,
                total_price: order.total_price,
                isDeleted: order.isDeleted,
              },
            },
          )
          .pipe(timeout(1500)),
      );
    } catch {
      // Search sync should not block order flows.
    }
  }

  private async removeOrderFromSearch(orderId: string): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.remove' },
            { source: 'order', type: 'order', sourceId: orderId },
          )
          .pipe(timeout(1500)),
      );
    } catch {
      // Search sync should not block order flows.
    }
  }

  private notFound(message: string): never {
    throw new RpcException({ statusCode: 404, message });
  }

  private badRequest(message: string): never {
    throw new RpcException({ statusCode: 400, message });
  }

  private forbidden(message: string): never {
    throw new RpcException({ statusCode: 403, message });
  }

  private handleDbError(error: unknown): never {
    if (error instanceof QueryFailedError) {
      const pgError = error.driverError as {
        code?: string;
        message?: string;
        column?: string;
        table?: string;
      };
      const rawMessage = pgError?.message ?? '';

      if (rawMessage.includes('orders_status_enum')) {
        throw new RpcException({ statusCode: 400, message: "status noto'g'ri qiymat" });
      }
      if (rawMessage.includes('orders_where_deliver_enum')) {
        throw new RpcException({ statusCode: 400, message: "where_deliver noto'g'ri qiymat" });
      }
      if (pgError?.code === '22P02') {
        if (rawMessage.includes('bigint')) {
          throw new RpcException({ statusCode: 400, message: "ID qiymatlari raqam ko'rinishida bo'lishi kerak" });
        }
        throw new RpcException({ statusCode: 400, message: "Noto'g'ri formatdagi qiymat yuborildi" });
      }
      if (pgError?.code === '23502') {
        const column = pgError?.column ?? 'unknown';
        const table = pgError?.table ?? 'unknown';
        throw new RpcException({
          statusCode: 400,
          message: `Majburiy maydon bo'sh yuborildi: ${table}.${column}`,
        });
      }
      if (pgError?.code === '23503') {
        throw new RpcException({ statusCode: 400, message: "Bog'langan ma'lumot topilmadi" });
      }
    }
    throw error;
  }

  private toTrackingRole(roles?: string[]): 'admin' | 'courier' | 'market' | 'system' {
    const normalized = new Set((roles ?? []).map((role) => String(role).toLowerCase()));
    if (normalized.has(Roles.SUPERADMIN) || normalized.has(Roles.ADMIN) || normalized.has(Roles.REGISTRATOR)) {
      return 'admin';
    }
    if (normalized.has(Roles.COURIER)) {
      return 'courier';
    }
    if (normalized.has(Roles.MARKET)) {
      return 'market';
    }
    return 'system';
  }

  private mapInitialStatusForTracking(status: Order_status): Order_status {
    return status === Order_status.NEW ? Order_status.CREATED : status;
  }

  private isValidStatusTransition(fromStatus: Order_status, toStatus: Order_status): boolean {
    if (fromStatus === toStatus) return true;

    const transitions: Record<Order_status, Order_status[]> = {
      [Order_status.CREATED]: [Order_status.NEW, Order_status.RECEIVED, Order_status.CANCELLED],
      [Order_status.NEW]: [Order_status.RECEIVED, Order_status.CANCELLED],
      [Order_status.RECEIVED]: [Order_status.ON_THE_ROAD, Order_status.WAITING, Order_status.CANCELLED],
      [Order_status.ON_THE_ROAD]: [Order_status.WAITING, Order_status.CANCELLED],
      [Order_status.WAITING]: [
        Order_status.SOLD,
        Order_status.PARTLY_PAID,
        Order_status.PAID,
        Order_status.CANCELLED,
        Order_status.CLOSED,
      ],
      [Order_status.SOLD]: [Order_status.PAID, Order_status.WAITING, Order_status.CLOSED],
      [Order_status.PARTLY_PAID]: [Order_status.PAID, Order_status.WAITING, Order_status.CLOSED],
      [Order_status.PAID]: [Order_status.WAITING, Order_status.CLOSED],
      [Order_status.CANCELLED]: [Order_status.WAITING, Order_status.CLOSED],
      [Order_status.CANCELLED_SENT]: [Order_status.CANCELLED, Order_status.CLOSED],
      [Order_status.CLOSED]: [Order_status.WAITING],
    };

    return transitions[fromStatus]?.includes(toStatus) ?? false;
  }

  private async createTrackingEvent(
    data: {
      order_id: string;
      from_status: Order_status | null;
      to_status: Order_status;
      changed_by: string;
      changed_by_role: 'admin' | 'courier' | 'market' | 'system';
      note?: string | null;
    },
    repository?: Repository<OrderTracking>,
  ) {
    const repo = repository ?? this.orderTrackingRepo;
    const entity = repo.create({
      order_id: data.order_id,
      from_status: data.from_status,
      to_status: data.to_status,
      changed_by: data.changed_by,
      changed_by_role: data.changed_by_role,
      note: data.note ?? null,
    });
    await repo.save(entity);
  }

  private toUzIsoString(date: Date): string {
    const uzOffsetMs = 5 * 60 * 60 * 1000;
    return new Date(date.getTime() + uzOffsetMs).toISOString().replace('Z', '+05:00');
  }

  private normalizePagination(page?: number, limit?: number, fetchAll?: boolean) {
    const DEFAULT_LIMIT = 10;
    const MAX_LIMIT = 100;
    const MAX_FETCH_ALL = 5000;
    const parsedPage = Number(page ?? 1);
    const parsedLimit = Number(limit ?? DEFAULT_LIMIT);

    const normalizedLimit =
      fetchAll || parsedLimit === 0
        ? MAX_FETCH_ALL
        : !Number.isFinite(parsedLimit) || parsedLimit < 0
          ? DEFAULT_LIMIT
          : Math.min(parsedLimit, MAX_LIMIT);

    const normalizedPage =
      Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;

    return {
      page: normalizedPage,
      limit: normalizedLimit,
      total_pages(total: number) {
        return normalizedLimit > 0 ? Math.ceil(total / normalizedLimit) : 0;
      },
    };
  }

  private normalizeStatusFilter(
    status?: Order_status | Order_status[] | string | string[],
  ): Order_status[] | undefined {
    if (status == null) {
      return undefined;
    }

    const rawValues = Array.isArray(status) ? status : [status];
    const flattened = rawValues
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    if (!flattened.length) {
      return undefined;
    }

    const allowedStatuses = new Set(Object.values(Order_status));
    const invalidValues = flattened.filter((value) => !allowedStatuses.has(value as Order_status));
    if (invalidValues.length) {
      this.badRequest(`Invalid status value(s): ${invalidValues.join(', ')}`);
    }

    return Array.from(new Set(flattened)) as Order_status[];
  }

  private analyticsDateRange(startDate?: string, endDate?: string) {
    const UZB_OFFSET_MS = 5 * 60 * 60 * 1000;

    const parseUzDate = (value: string, endOfDay: boolean): Date | null => {
      const parts = value.split('-').map(Number);
      if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
        return null;
      }
      const [year, month, day] = parts;
      const utcMs = Date.UTC(
        year,
        month - 1,
        day,
        endOfDay ? 23 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 999 : 0,
      );
      return new Date(utcMs - UZB_OFFSET_MS);
    };

    const parseDateInput = (value: string, endOfDay: boolean) => {
      if (/^\d+$/.test(value)) {
        return new Date(Number(value));
      }
      if (value.includes('T')) {
        return new Date(value);
      }
      const parsedUz = parseUzDate(value, endOfDay);
      return parsedUz ?? new Date(value);
    };

    const hasStart = Boolean(startDate && String(startDate).trim().length > 0);
    const hasEnd = Boolean(endDate && String(endDate).trim().length > 0);

    let start: Date;
    let end: Date;

    if (!hasStart || !hasEnd) {
      const uzNow = new Date(Date.now() + UZB_OFFSET_MS);
      const year = uzNow.getUTCFullYear();
      const month = String(uzNow.getUTCMonth() + 1).padStart(2, '0');
      const day = String(uzNow.getUTCDate()).padStart(2, '0');
      const dateKey = `${year}-${month}-${day}`;
      start = parseUzDate(dateKey, false)!;
      end = parseUzDate(dateKey, true)!;
    } else {
      start = parseDateInput(String(startDate), false);
      end = parseDateInput(String(endDate), true);
    }

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new RpcException({ statusCode: 400, message: 'Sana formati noto‘g‘ri' });
    }

    return { start, end };
  }

  private soldStatuses() {
    return [Order_status.SOLD, Order_status.PAID, Order_status.PARTLY_PAID];
  }

  private dateKey(date: Date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tashkent',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  private dateLabel(date: Date) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tashkent',
      day: '2-digit',
      month: '2-digit',
    }).format(date).replace('/', '.').replace('/', '.');
  }

  private normalizeRevenuePeriod(period?: string): 'daily' | 'weekly' | 'monthly' | 'yearly' {
    const normalized = String(period ?? 'daily').toLowerCase();
    if (normalized === 'daily' || normalized === 'weekly' || normalized === 'monthly' || normalized === 'yearly') {
      return normalized;
    }
    throw new RpcException({ statusCode: 400, message: 'period must be one of: daily, weekly, monthly, yearly' });
  }

  private periodStart(date: Date, period: 'daily' | 'weekly' | 'monthly' | 'yearly'): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);

    if (period === 'daily') return d;
    if (period === 'monthly') {
      d.setDate(1);
      return d;
    }
    if (period === 'yearly') {
      d.setMonth(0, 1);
      return d;
    }

    // weekly (week starts on Monday)
    const day = d.getDay(); // 0=Sun..6=Sat
    const diffToMonday = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diffToMonday);
    return d;
  }

  private nextPeriodStart(
    date: Date,
    period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): Date {
    const d = new Date(date);
    if (period === 'daily') d.setDate(d.getDate() + 1);
    else if (period === 'weekly') d.setDate(d.getDate() + 7);
    else if (period === 'monthly') d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  private periodKey(date: Date, period: 'daily' | 'weekly' | 'monthly' | 'yearly'): string {
    const d = this.periodStart(date, period);
    if (period === 'daily') {
      return this.dateKey(d);
    }
    if (period === 'weekly') {
      return `W:${this.dateKey(d)}`;
    }
    if (period === 'monthly') {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      return `M:${y}-${m}`;
    }
    return `Y:${d.getFullYear()}`;
  }

  private periodLabel(date: Date, period: 'daily' | 'weekly' | 'monthly' | 'yearly'): string {
    const d = this.periodStart(date, period);
    if (period === 'daily') {
      return this.dateLabel(d);
    }
    if (period === 'weekly') {
      const end = new Date(d);
      end.setDate(end.getDate() + 6);
      return `${this.dateLabel(d)}-${this.dateLabel(end)}`;
    }
    if (period === 'monthly') {
      const m = String(d.getMonth() + 1).padStart(2, '0');
      return `${m}.${d.getFullYear()}`;
    }
    return String(d.getFullYear());
  }

  private generateSaleComment(
    orderComment?: string | null,
    dtoComment?: string | null,
    extraCost?: number,
    notes: string[] = [],
  ) {
    const parts: string[] = [];

    if (orderComment?.trim()) parts.push(orderComment.trim());
    if (dtoComment?.trim()) parts.push(dtoComment.trim());
    if ((extraCost ?? 0) > 0) {
      parts.push(`!!! Bu buyurtmadan qo'shimcha ${extraCost} miqdorda pul ushlab qolingan`);
    }

    for (const note of notes) {
      if (note?.trim()) parts.push(`!!! ${note.trim()}`);
    }

    return parts.join('\n');
  }

  private async getPostsByIds(ids: string[]) {
    if (!ids.length) return [];
    const response = await rmqSend<{ data?: Array<{ id: string; courier_id?: string | null }> }>(
      this.logisticsClient,
      { cmd: 'logistics.post.find_by_ids' },
      { ids },
    ).catch(() => ({ data: [] }));
    return response?.data ?? [];
  }

  private async getAllPostsForAnalytics() {
    const limit = 100;
    let page = 1;
    let totalPages = 1;
    const rows: Array<{ id: string; courier_id?: string | null; updatedAt?: string | Date | null }> = [];

    while (page <= totalPages) {
      const response = await rmqSend<{
        data?: {
          data?: Array<{ id: string; courier_id?: string | null; updatedAt?: string | Date | null }>;
          totalPages?: number;
        };
      }>(
        this.logisticsClient,
        { cmd: 'logistics.post.find_all' },
        { query: { page, limit } },
      ).catch(() => ({ data: { data: [], totalPages: 1 } }));

      rows.push(...(response?.data?.data ?? []));
      totalPages = Math.max(1, Number(response?.data?.totalPages ?? 1));
      page += 1;
    }

    return rows;
  }

  private async getMarketsByIds(ids: string[]) {
    if (!ids.length) return [];
    const response = await rmqSend<{ data?: Array<{ id: string; name?: string; tariff_home?: number; tariff_center?: number }> }>(
      this.identityClient,
      { cmd: 'identity.market.find_by_ids' },
      { ids },
    ).catch(() => ({ data: [] }));
    return response?.data ?? [];
  }

  private async getCouriersByIds(ids: string[]) {
    if (!ids.length) return [];
    const response = await rmqSend<{ data?: Array<{ id: string; name?: string; tariff_home?: number; tariff_center?: number }> }>(
      this.identityClient,
      { cmd: 'identity.courier.find_by_ids' },
      { ids },
    ).catch(() => ({ data: [] }));
    return response?.data ?? [];
  }

  private async getAllOperatorUsers() {
    const limit = 200;
    let page = 1;
    let totalPages = 1;
    const items: Array<{ id?: string; name?: string; username?: string; market_id?: string }> = [];

    while (page <= totalPages) {
      const response = await rmqSend<any>(
        this.identityClient,
        { cmd: 'identity.user.find_all' },
        { query: { role: Roles.OPERATOR, page, limit } },
      ).catch(() => null);

      const payload = response?.data ?? response ?? {};
      const batch = Array.isArray(payload?.items) ? payload.items : [];
      items.push(...batch);

      const pages = Number(payload?.meta?.totalPages ?? 1);
      totalPages = Number.isFinite(pages) && pages > 0 ? pages : 1;
      page += 1;
      if (page > 100) break;
    }

    return items;
  }

  private async getCashboxByUser(userId: string, cashboxType: Cashbox_type) {
    const response = await rmqSend<{ data?: { id: string; balance?: number } }>(
      this.financeClient,
      { cmd: 'finance.cashbox.find_by_user' },
      { user_id: userId, cashbox_type: cashboxType },
    ).catch(() => ({ data: undefined }));

    return response?.data;
  }

  private async updateCashboxBalance(data: {
    user_id: string;
    cashbox_type: Cashbox_type;
    amount: number;
    operation_type: Operation_type;
    source_type: Source_type;
    source_id?: string;
    source_user_id?: string;
    comment?: string;
    created_by?: string;
  }) {
    if (data.amount <= 0) {
      return;
    }

    await rmqSend(
      this.financeClient,
      { cmd: 'finance.cashbox.update_balance' },
      {
        ...data,
        payment_method: PaymentMethod.CASH,
      },
    );
  }

  private hasRole(requester: { roles?: string[] } | undefined, role: Roles) {
    return (requester?.roles ?? []).some(
      (item) => String(item).toLowerCase() === String(role).toLowerCase(),
    );
  }

  private async findLatestHistoryBySource(data: {
    user_id: string;
    source_type: Source_type;
    source_id: string;
  }) {
    const response = await rmqSend<{
      data?: { items?: Array<{ amount?: number; createdAt?: string }> };
    }>(
      this.financeClient,
      { cmd: 'finance.history.find_all' },
      {
        user_id: data.user_id,
        source_type: data.source_type,
        source_id: data.source_id,
        page: 1,
        limit: 1,
      },
    ).catch(() => ({ data: { items: [] } }));

    return response?.data?.items?.[0];
  }

  private isNearInTime(
    left?: string | Date | null,
    right?: string | Date | null,
    maxDiffMs = 5000,
  ) {
    if (!left || !right) {
      return false;
    }

    const leftTime = new Date(left).getTime();
    const rightTime = new Date(right).getTime();

    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
      return false;
    }

    return Math.abs(leftTime - rightTime) <= maxDiffMs;
  }

  async rollbackOrderToWaiting(
    requester: { id: string; roles?: string[] },
    id: string,
  ) {
    const order = await this.findById(id);
    const originalStatus = order.status;
    const isSuperAdmin = this.hasRole(requester, Roles.SUPERADMIN);
    const isCourier = this.hasRole(requester, Roles.COURIER);

    if (
      isCourier &&
      ![Order_status.SOLD, Order_status.CANCELLED].includes(order.status)
    ) {
      this.badRequest(`Rollback mumkin emas (status: ${order.status})`);
    }

    if (
      isSuperAdmin &&
      ![
        Order_status.SOLD,
        Order_status.CANCELLED,
        Order_status.CLOSED,
        Order_status.PAID,
        Order_status.PARTLY_PAID,
      ].includes(order.status)
    ) {
      this.badRequest(`Rollback mumkin emas (status: ${order.status})`);
    }

    if (!isCourier && !isSuperAdmin) {
      this.badRequest('Rollback uchun ruxsat yo‘q');
    }

    if (!order.post_id) {
      this.badRequest('Order has no post');
    }

    const postRes = await rmqSend<{ data?: { id: string; courier_id?: string | null } }>(
      this.logisticsClient,
      { cmd: 'logistics.post.find_by_id' },
      { id: String(order.post_id) },
    ).catch(() => ({ data: undefined }));
    const post = postRes?.data;
    if (!post) {
      this.notFound('Post not found');
    }

    if (isCourier && !isSuperAdmin && String(post.courier_id ?? '') !== String(requester.id)) {
      this.badRequest('Order is not assigned to this courier');
    }

    const courierId = String(post.courier_id ?? '');
    if (!courierId) {
      this.notFound('Courier not found');
    }

    const [market, courier] = await Promise.all([
      this.getMarketsByIds([String(order.market_id)]).then((rows) => rows[0]),
      this.getCouriersByIds([courierId]).then((rows) => rows[0]),
    ]);
    if (!market) {
      this.notFound('Market not found');
    }
    if (!courier) {
      this.notFound('Courier not found');
    }

    const [marketCashbox, courierCashbox] = await Promise.all([
      this.getCashboxByUser(String(order.market_id), Cashbox_type.FOR_MARKET),
      this.getCashboxByUser(courierId, Cashbox_type.FOR_COURIER),
    ]);
    if (!marketCashbox) {
      this.notFound('Market cashbox not found');
    }
    if (!courierCashbox) {
      this.notFound('Courier cashbox not found');
    }

    const marketTariff =
      order.where_deliver === Where_deliver.CENTER
        ? Number(market.tariff_center ?? 0)
        : Number(market.tariff_home ?? 0);
    const courierTariff =
      order.where_deliver === Where_deliver.CENTER
        ? Number(courier.tariff_center ?? 0)
        : Number(courier.tariff_home ?? 0);
    const rollbackComment = `[ROLLBACK] ${order.comment || ''}`.trim();
    const totalPrice = Number(order.total_price ?? 0);
    const [marketExtraCost, courierExtraCost] = await Promise.all([
      this.findLatestHistoryBySource({
        user_id: String(order.market_id),
        source_type: Source_type.EXTRA_COST,
        source_id: String(order.id),
      }),
      this.findLatestHistoryBySource({
        user_id: courierId,
        source_type: Source_type.EXTRA_COST,
        source_id: String(order.id),
      }),
    ]);

    const soldAt = order.sold_at ? Number(order.sold_at) : NaN;
    const orderUpdatedAt = order.updatedAt ? new Date(order.updatedAt) : null;
    const marketExtraCostCreatedAt = marketExtraCost?.createdAt ?? null;
    const courierExtraCostCreatedAt = courierExtraCost?.createdAt ?? null;
    const shouldRollbackMarketExtraCost =
      !!marketExtraCost &&
      Number(marketExtraCost.amount ?? 0) > 0 &&
      (
        [Order_status.SOLD, Order_status.PAID, Order_status.PARTLY_PAID].includes(originalStatus)
          ? Number.isFinite(soldAt) &&
            this.isNearInTime(new Date(soldAt), marketExtraCostCreatedAt)
          : [Order_status.CANCELLED, Order_status.CLOSED].includes(originalStatus)
            ? this.isNearInTime(orderUpdatedAt, marketExtraCostCreatedAt)
            : false
      );
    const shouldRollbackCourierExtraCost =
      !!courierExtraCost &&
      Number(courierExtraCost.amount ?? 0) > 0 &&
      (
        [Order_status.SOLD, Order_status.PAID, Order_status.PARTLY_PAID].includes(originalStatus)
          ? Number.isFinite(soldAt) &&
            this.isNearInTime(new Date(soldAt), courierExtraCostCreatedAt)
          : [Order_status.CANCELLED, Order_status.CLOSED].includes(originalStatus)
            ? this.isNearInTime(orderUpdatedAt, courierExtraCostCreatedAt)
            : false
      );

    if (
      [Order_status.SOLD, Order_status.PAID, Order_status.PARTLY_PAID].includes(originalStatus)
    ) {
      if (shouldRollbackMarketExtraCost) {
        await this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: Number(marketExtraCost?.amount ?? 0),
          operation_type: Operation_type.INCOME,
          source_type: Source_type.CORRECTION,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: "Qo'shimcha xarajat orqaga qaytarildi",
        });
      }

      if (shouldRollbackCourierExtraCost) {
        await this.updateCashboxBalance({
          user_id: courierId,
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: Number(courierExtraCost?.amount ?? 0),
          operation_type: Operation_type.INCOME,
          source_type: Source_type.CORRECTION,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: "Qo'shimcha xarajat orqaga qaytarildi",
        });
      }
    }

    if ([Order_status.SOLD, Order_status.PAID].includes(order.status)) {
      if (totalPrice === 0) {
        await Promise.all([
          this.updateCashboxBalance({
            user_id: String(order.market_id),
            cashbox_type: Cashbox_type.FOR_MARKET,
            amount: marketTariff,
            operation_type: Operation_type.INCOME,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: rollbackComment,
          }),
          this.updateCashboxBalance({
            user_id: courierId,
            cashbox_type: Cashbox_type.FOR_COURIER,
            amount: courierTariff,
            operation_type: Operation_type.INCOME,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: rollbackComment,
          }),
        ]);
      } else if (totalPrice < courierTariff) {
        await Promise.all([
          this.updateCashboxBalance({
            user_id: String(order.market_id),
            cashbox_type: Cashbox_type.FOR_MARKET,
            amount: Math.max(marketTariff - totalPrice, 0),
            operation_type: Operation_type.INCOME,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: rollbackComment,
          }),
          this.updateCashboxBalance({
            user_id: courierId,
            cashbox_type: Cashbox_type.FOR_COURIER,
            amount: Math.max(courierTariff - totalPrice, 0),
            operation_type: Operation_type.INCOME,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: rollbackComment,
          }),
        ]);
      } else if (totalPrice < marketTariff) {
        const courierToBePaid = totalPrice - courierTariff;
        await Promise.all([
          this.updateCashboxBalance({
            user_id: String(order.market_id),
            cashbox_type: Cashbox_type.FOR_MARKET,
            amount: Math.max(marketTariff - totalPrice, 0),
            operation_type: Operation_type.INCOME,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: rollbackComment,
          }),
          this.updateCashboxBalance({
            user_id: courierId,
            cashbox_type: Cashbox_type.FOR_COURIER,
            amount: Math.max(courierToBePaid, 0),
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: rollbackComment,
          }),
        ]);
      } else {
        const toBePaid =
          originalStatus === Order_status.PAID
            ? Number(order.paid_amount ?? 0)
            : totalPrice - marketTariff;
        const courierToBePaid = totalPrice - courierTariff;
        await Promise.all([
          this.updateCashboxBalance({
            user_id: String(order.market_id),
            cashbox_type: Cashbox_type.FOR_MARKET,
            amount: Math.max(toBePaid, 0),
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: rollbackComment,
          }),
          this.updateCashboxBalance({
            user_id: courierId,
            cashbox_type: Cashbox_type.FOR_COURIER,
            amount: Math.max(courierToBePaid, 0),
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: rollbackComment,
          }),
        ]);
      }
    }

    if (order.status === Order_status.PARTLY_PAID && isSuperAdmin) {
      const marketDiff = Number(order.paid_amount ?? 0);
      const courierDiff = Math.max(totalPrice - courierTariff, 0);

      await Promise.all([
        this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: marketDiff,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.CORRECTION,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: rollbackComment,
        }),
        this.updateCashboxBalance({
          user_id: courierId,
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: courierDiff,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.CORRECTION,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: rollbackComment,
        }),
      ]);
    }

    if (
      shouldRollbackMarketExtraCost &&
      [Order_status.CANCELLED, Order_status.CLOSED].includes(originalStatus)
    ) {
      await this.updateCashboxBalance({
        user_id: String(order.market_id),
        cashbox_type: Cashbox_type.FOR_MARKET,
        amount: Number(marketExtraCost.amount),
        operation_type: Operation_type.INCOME,
        source_type: Source_type.CORRECTION,
        source_id: String(order.id),
        created_by: String(requester.id),
        comment:
          [Order_status.CANCELLED, Order_status.CLOSED].includes(originalStatus)
            ? "Bekor qilingan buyurtmaga yozilgan qo'shimcha xarajat orqaga qaytarildi"
            : "Qo'shimcha xarajat orqaga qaytarildi",
      });
    }

    if (
      shouldRollbackCourierExtraCost &&
      [Order_status.CANCELLED, Order_status.CLOSED].includes(originalStatus)
    ) {
      await this.updateCashboxBalance({
        user_id: courierId,
        cashbox_type: Cashbox_type.FOR_COURIER,
        amount: Number(courierExtraCost.amount),
        operation_type: Operation_type.INCOME,
        source_type: Source_type.CORRECTION,
        source_id: String(order.id),
        created_by: String(requester.id),
        comment:
          [Order_status.CANCELLED, Order_status.CLOSED].includes(originalStatus)
            ? "Bekor qilingan buyurtmaga yozilgan qo'shimcha xarajat orqaga qaytarildi"
            : "Qo'shimcha xarajat orqaga qaytarildi",
      });
    }

    if (
      isSuperAdmin &&
      [Order_status.PAID, Order_status.PARTLY_PAID].includes(originalStatus)
    ) {
      await this.updateFull(id, {
        status: Order_status.WAITING,
        paid_amount: 0,
        sold_at: null,
      }, { id: requester.id, roles: requester.roles, note: 'Rollback to waiting' });
    } else {
      await this.updateFull(id, {
        status: Order_status.WAITING,
        to_be_paid: 0,
        sold_at: null,
      }, { id: requester.id, roles: requester.roles, note: 'Rollback to waiting' });
    }

    return successRes({}, 200, 'Order WAITING holatiga qaytarildi');
  }

  private async replaceOrderItems(
    orderId: string,
    items?: Array<{ product_id: string; quantity?: number }>,
  ): Promise<number> {
    try {
      await this.orderItemRepo.delete({ order_id: orderId });
    } catch (error) {
      this.handleDbError(error);
    }

    const normalizedItems = (items ?? []).map((item) => ({
      product_id: item.product_id,
      quantity: item.quantity ?? 1,
      order_id: orderId,
    }));

    if (!normalizedItems.length) {
      return 0;
    }

    try {
      // Use explicit insert so order_id is always written and never treated as DEFAULT/null.
      await this.orderItemRepo.createQueryBuilder().insert().values(normalizedItems).execute();
    } catch (error) {
      this.handleDbError(error);
    }

    return normalizedItems.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
  }

  async create(dto: {
    market_id: string;
    customer_id: string;
    where_deliver?: Where_deliver;
    total_price?: number;
    to_be_paid?: number;
    paid_amount?: number;
    status?: Order_status;
    comment?: string | null;
    operator?: string | null;
    operator_id?: string | null;
    post_id?: string | null;
    canceled_post_id?: string | null;
    sold_at?: string | null;
    district_id?: string | null;
    region_id?: string | null;
    address?: string | null;
    qr_code_token?: string | null;
    parent_order_id?: string | null;
    external_id?: string | null;
    source?: Order_source;
    items?: Array<{ product_id: string; quantity?: number }>;
  }, requester?: { id: string; roles?: string[] }) {
    const roles = new Set((requester?.roles ?? []).map((role) => String(role).toLowerCase()));
    const operatorId = dto.operator_id ?? (roles.has(Roles.OPERATOR) ? requester?.id ?? null : null);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedId = '';
    try {
      const orderRepo = queryRunner.manager.getRepository(Order);
      const orderItemRepo = queryRunner.manager.getRepository(OrderItem);
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);

      const order = orderRepo.create({
        market_id: dto.market_id,
        customer_id: dto.customer_id,
        where_deliver: dto.where_deliver ?? Where_deliver.CENTER,
        total_price: dto.total_price ?? 0,
        to_be_paid: dto.to_be_paid ?? 0,
        paid_amount: dto.paid_amount ?? 0,
        status: dto.status ?? Order_status.NEW,
        comment: dto.comment ?? null,
        operator: dto.operator ?? null,
        operator_id: operatorId,
        post_id: dto.post_id ?? null,
        canceled_post_id: dto.canceled_post_id ?? null,
        sold_at: dto.sold_at ?? null,
        district_id: dto.district_id ?? null,
        region_id: dto.region_id ?? null,
        address: dto.address ?? null,
        qr_code_token: dto.qr_code_token ?? this.generateCustomToken(),
        parent_order_id: dto.parent_order_id ?? null,
        external_id: dto.external_id ?? null,
        source: dto.source ?? Order_source.INTERNAL,
        isDeleted: false,
      });

      const saved = await orderRepo.save(order);
      savedId = saved.id;

      const normalizedItems = (dto.items ?? []).map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity ?? 1,
        order_id: saved.id,
      }));
      if (normalizedItems.length) {
        await orderItemRepo.createQueryBuilder().insert().values(normalizedItems).execute();
      }

      const productQuantity = normalizedItems.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
      if (saved.product_quantity !== productQuantity) {
        await orderRepo.update({ id: saved.id }, { product_quantity: productQuantity });
      }

      await this.createTrackingEvent(
        {
          order_id: saved.id,
          from_status: null,
          to_status: this.mapInitialStatusForTracking(saved.status),
          changed_by: String(requester?.id ?? 'system'),
          changed_by_role: requester?.id ? this.toTrackingRole(requester.roles) : 'system',
          note: 'Order created',
        },
        trackingRepo,
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.handleDbError(error);
    } finally {
      await queryRunner.release();
    }

    const fullOrder = await this.findById(savedId);
    void this.syncOrderToSearch(fullOrder);
    return fullOrder;
  }

  async findAll(query: {
    market_id?: string;
    customer_id?: string;
    customer_ids?: string[];
    post_id?: string;
    post_ids?: string[];
    exclude_statuses?: Order_status[];
    canceled_post_id?: string;
    qr_code_token?: string;
    status?: Order_status | Order_status[] | string | string[];
    return_requested?: boolean;
    start_day?: string;
    end_day?: string;
    courier?: string;
    region_id?: string;
    source?: Order_source | 'internal' | 'external';
    fetch_all?: boolean | string;
    fetchAll?: boolean | string;
    page?: number;
    limit?: number;
  }) {
    const {
      market_id,
      customer_id,
      customer_ids,
      post_id,
      post_ids,
      exclude_statuses,
      canceled_post_id,
      qr_code_token,
      status,
      return_requested,
      start_day,
      end_day,
      courier,
      region_id,
      source,
      fetch_all,
      fetchAll,
      page,
      limit,
    } = query;

    const useFetchAll =
      fetch_all === true ||
      fetchAll === true ||
      String(fetch_all).toLowerCase() === 'true' ||
      String(fetchAll).toLowerCase() === 'true';

    const pagination = this.normalizePagination(page, limit, useFetchAll);
    const statusFilter = this.normalizeStatusFilter(status);

    const qb = this.orderRepo
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .where('order.isDeleted = :isDeleted', { isDeleted: false });

    if (market_id) {
      qb.andWhere('order.market_id = :market_id', { market_id });
    }
    if (customer_ids?.length) {
      qb.andWhere('order.customer_id IN (:...customer_ids)', { customer_ids });
    } else if (customer_id) {
      qb.andWhere('order.customer_id = :customer_id', { customer_id });
    }
    if (post_id) {
      qb.andWhere('order.post_id = :post_id', { post_id });
    }
    if (post_ids?.length) {
      qb.andWhere('order.post_id IN (:...post_ids)', { post_ids });
    }
    if (canceled_post_id) {
      qb.andWhere('order.canceled_post_id = :canceled_post_id', { canceled_post_id });
    }
    if (qr_code_token) {
      qb.andWhere('order.qr_code_token = :qr_code_token', { qr_code_token });
    }
    if (statusFilter?.length) {
      qb.andWhere('order.status IN (:...statuses)', { statuses: statusFilter });
    } else if (exclude_statuses?.length) {
      qb.andWhere('order.status NOT IN (:...exclude_statuses)', { exclude_statuses });
    }
    if (typeof return_requested === 'boolean') {
      qb.andWhere('order.return_requested = :return_requested', { return_requested });
    }
    if (region_id) {
      qb.andWhere('order.region_id = :region_id', { region_id });
    }
    if (source === Order_source.EXTERNAL) {
      qb.andWhere('(order.source = :source OR order.external_id IS NOT NULL)', {
        source: Order_source.EXTERNAL,
      });
    } else if (source === Order_source.INTERNAL) {
      qb.andWhere('(order.source = :source OR order.external_id IS NULL)', {
        source: Order_source.INTERNAL,
      });
    }
    if (courier) {
      qb.andWhere(
        new Brackets((nested) => {
          nested
            .where('order.operator ILIKE :courierLike', { courierLike: `%${courier}%` })
            .orWhere('order.post_id = :courierId', { courierId: courier });
        }),
      );
    }
    if (start_day) {
      const startDate = new Date(start_day);
      if (Number.isNaN(startDate.getTime())) {
        throw new RpcException({ statusCode: 400, message: 'start_day noto\'g\'ri sana formatida' });
      }
      qb.andWhere('order.createdAt >= :startDate', { startDate });
    }
    if (end_day) {
      const endDate = new Date(end_day);
      if (Number.isNaN(endDate.getTime())) {
        throw new RpcException({ statusCode: 400, message: 'end_day noto\'g\'ri sana formatida' });
      }
      if (!end_day.includes('T')) {
        endDate.setHours(23, 59, 59, 999);
      }
      qb.andWhere('order.createdAt <= :endDate', { endDate });
    }

    qb.orderBy('order.createdAt', 'DESC')
      .skip((pagination.page - 1) * pagination.limit)
      .take(pagination.limit);

    let data: Order[];
    let total: number;
    try {
      [data, total] = await qb.getManyAndCount();
    } catch (error) {
      this.handleDbError(error);
    }

    return {
      data,
      total,
      page: pagination.page,
      limit: pagination.limit,
      total_pages: pagination.total_pages(total),
      totalPages: pagination.total_pages(total),
    };
  }

  async findNewMarkets() {
    const qb = this.orderRepo
      .createQueryBuilder('order')
      .select('order.market_id', 'market_id')
      .addSelect('COUNT(order.id)', 'orders_count')
      .addSelect('COALESCE(SUM(order.total_price), 0)', 'total_price_sum')
      .where('order.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('order.status = :status', { status: Order_status.NEW })
      .groupBy('order.market_id')
      .orderBy('orders_count', 'DESC');

    let rows: Array<{
      market_id: string;
      orders_count: string;
      total_price_sum: string;
    }>;
    try {
      rows = await qb.getRawMany();
    } catch (error) {
      this.handleDbError(error);
    }

    return rows.map((row) => ({
      market_id: row.market_id,
      orders_count: Number(row.orders_count),
      total_price_sum: Number(row.total_price_sum),
    }));
  }

  async findNewOrdersByMarket(market_id: string, page = 1, limit = 20) {
    return this.findAll({ market_id, status: Order_status.NEW, page, limit });
  }

  async findAllExternal(query: {
    market_id?: string;
    status?: Order_status | Order_status[] | string | string[];
    start_day?: string;
    end_day?: string;
    page?: number;
    limit?: number;
  }) {
    return this.findAll({
      ...query,
      source: Order_source.EXTERNAL,
    });
  }

  async createExternalOrder(dto: {
    market_id: string;
    customer_id: string;
    where_deliver?: Where_deliver;
    total_price?: number;
    to_be_paid?: number;
    paid_amount?: number;
    status?: Order_status;
    comment?: string | null;
    operator?: string | null;
    post_id?: string | null;
    district_id?: string | null;
    region_id?: string | null;
    address?: string | null;
    qr_code_token?: string | null;
    external_id?: string | null;
    items?: Array<{ product_id: string; quantity?: number }>;
  }) {
    return this.create({
      ...dto,
      source: Order_source.EXTERNAL,
      operator: dto.operator ?? 'external_manual',
      status: dto.status ?? Order_status.NEW,
    });
  }

  private generateCustomToken(length = 24): string {
    const chars = 'abcdef0123456789';
    let token = '';
    for (let i = 0; i < length; i += 1) {
      token += chars[Math.floor(Math.random() * chars.length)];
    }
    return token;
  }

  private getFieldValue(obj: any, fieldPath?: string | null): any {
    if (!obj || !fieldPath) return undefined;
    return fieldPath.split('.').reduce((acc, key) => acc?.[key], obj);
  }

  private async getIntegrationById(integrationId: string): Promise<Record<string, any>> {
    const response = await rmqSend<{ data?: Record<string, any> }>(
      this.integrationClient,
      { cmd: 'integration.find_by_id' },
      { id: integrationId },
    ).catch(() => ({ data: undefined }));

    const integration = response?.data;
    if (!integration) {
      this.notFound('Integration not found');
    }
    return integration;
  }

  private async getDefaultDistrictId(): Promise<string> {
    const response = await rmqSend<{ data?: { items?: Array<{ id: string }> } | Array<{ id: string }> }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_all' },
      { query: { page: 1, limit: 1 } },
    ).catch(() => ({ data: [] }));

    const rows = Array.isArray(response?.data)
      ? response.data
      : (response?.data as any)?.items ?? [];

    const districtId = rows?.[0]?.id ? String(rows[0].id) : '';
    if (!districtId) {
      this.notFound('No district found for external order import');
    }
    return districtId;
  }

  private async resolveDistrictId(externalDistrictValue: unknown, fallbackDistrictId: string): Promise<string> {
    const raw = externalDistrictValue == null ? '' : String(externalDistrictValue).trim();
    if (!raw) return fallbackDistrictId;

    const bySato = await rmqSend<{ data?: { id?: string } }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_by_sato' },
      { satoCode: raw },
    ).catch(() => ({ data: undefined }));
    if (bySato?.data?.id) {
      return String(bySato.data.id);
    }

    const byId = await rmqSend<{ data?: { id?: string } }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_by_id' },
      { id: raw },
    ).catch(() => ({ data: undefined }));
    if (byId?.data?.id) {
      return String(byId.data.id);
    }

    return fallbackDistrictId;
  }

  private async queueExternalStatusSync(order: Order, action: 'sold' | 'canceled' | 'paid' | 'rollback' | 'waiting', old_status: string, new_status: string) {
    if (!order.external_id || !order.operator?.startsWith('external_')) {
      return;
    }

    await rmqSend(
      this.integrationClient,
      { cmd: 'integration.sync.enqueue' },
      {
        order_id: order.id,
        external_order_id: order.external_id,
        operator: order.operator,
        action,
        old_status,
        new_status,
      },
    ).catch(() => undefined);
  }

  private resolveSyncAction(oldStatus: string, newStatus: string): 'sold' | 'canceled' | 'paid' | 'rollback' | 'waiting' | null {
    if (newStatus === Order_status.CANCELLED) {
      return 'canceled';
    }

    if (newStatus === Order_status.PAID || newStatus === Order_status.PARTLY_PAID) {
      return 'paid';
    }

    if (newStatus === Order_status.SOLD) {
      return 'sold';
    }

    if (newStatus === Order_status.WAITING) {
      if (
        [
          Order_status.CANCELLED,
          Order_status.CLOSED,
          Order_status.SOLD,
          Order_status.PAID,
          Order_status.PARTLY_PAID,
        ].includes(oldStatus as Order_status)
      ) {
        return 'rollback';
      }
      return 'waiting';
    }

    return null;
  }

  async receiveNewOrders(orderIds: string[], search?: string) {
    const uniqueOrderIds = Array.from(new Set((orderIds ?? []).filter(Boolean)));
    if (!uniqueOrderIds.length) {
      this.badRequest('order_ids is required');
    }

    // 1. Fetch orders from own schema only (no cross-schema queries)
    let orders = await this.orderRepo.find({
      where: {
        id: In(uniqueOrderIds),
        isDeleted: false,
        status: Order_status.NEW,
      },
    });

    if (!orders.length) {
      this.notFound('No orders found!');
    }

    // 2. Validate customers via RMQ (batch)
    const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
    const customersRes = await rmqSend<{ data: Array<{ id: string; name?: string; phone_number?: string }> }>(
      this.identityClient,
      { cmd: 'identity.customer.find_by_ids' },
      { ids: customerIds },
    );
    const customerMap = new Map(
      (customersRes?.data ?? []).map((c) => [String(c.id), c]),
    );

    // 3. Optional search filter on customer name/phone (via identity-service DB, not in-memory)
    if (search?.trim()) {
      const searchRes = await rmqSend<{ data: Array<{ id: string }> }>(
        this.identityClient,
        { cmd: 'identity.customer.search' },
        { search: search.trim(), limit: 1000 },
      );
      const matchingIds = new Set(
        (searchRes?.data ?? []).map((c) => String(c.id)),
      );
      orders = orders.filter((o) => matchingIds.has(o.customer_id));
      if (!orders.length) {
        this.notFound('No orders found matching search criteria');
      }
    }

    if (orders.length !== uniqueOrderIds.length && !search?.trim()) {
      this.badRequest('Some orders are not found or not in NEW status');
    }

    // 4. Validate customers exist
    for (const order of orders) {
      if (!customerMap.has(order.customer_id)) {
        this.notFound(`Customer not found for order #${order.id}`);
      }
    }

    // 5. Fetch district data via RMQ (batch) to get assigned_region
    const districtIds = [...new Set(orders.map((o) => o.district_id).filter(Boolean) as string[])];
    const districtsRes = await rmqSend<{ data: Array<{ id: string; assigned_region?: string; assignedToRegion?: { id: string } }> }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_by_ids' },
      { ids: districtIds },
    );
    const districtMap = new Map(
      (districtsRes?.data ?? []).map((d) => [String(d.id), d]),
    );

    // 6. Build payload for logistics post assignment
    const logisticsPayload: Array<{ order_id: string; assigned_region: string; total_price: number }> = [];
    for (const order of orders) {
      const district = districtMap.get(order.district_id!);
      const assignedRegion = district?.assigned_region
        ?? (district?.assignedToRegion as { id?: string } | undefined)?.id
        ?? null;
      if (!assignedRegion) {
        this.notFound(`District/assigned region not found for order #${order.id}`);
      }
      logisticsPayload.push({
        order_id: order.id,
        assigned_region: assignedRegion,
        total_price: Number(order.total_price ?? 0),
      });
    }

    // 7. Delegate post creation/update to logistics-service via RMQ
    const postAssignments = await rmqSend<{
      data: Array<{ order_id: string; post_id: string }>;
    }>(
      this.logisticsClient,
      { cmd: 'logistics.post.receive_orders' },
      { orders: logisticsPayload },
      { timeoutMs: RMQ_SERVICE_TIMEOUT },
    );

    const assignmentMap = new Map(
      (postAssignments?.data ?? []).map((a) => [a.order_id, a.post_id]),
    );

    // 8. Update order statuses in own schema (transaction)
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);
      for (const order of orders) {
        const postId = assignmentMap.get(order.id);
        const previousStatus = order.status;
        const nextStatus = Order_status.RECEIVED;
        await queryRunner.manager
          .createQueryBuilder()
          .update(Order)
          .set({
            status: nextStatus,
            post_id: postId ?? null,
          })
          .where('id = :id', { id: order.id })
          .execute();

        if (previousStatus !== nextStatus) {
          await this.createTrackingEvent(
            {
              order_id: order.id,
              from_status: previousStatus,
              to_status: nextStatus,
              changed_by: 'system',
              changed_by_role: 'system',
              note: 'Order assigned to post',
            },
            trackingRepo,
          );
        }
      }
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof RpcException) {
        throw error;
      }
      try {
        this.handleDbError(error);
      } catch (mappedError) {
        if (mappedError instanceof RpcException) {
          throw mappedError;
        }
      }
      throw new RpcException({
        statusCode: 500,
        message: error instanceof Error ? error.message : 'Internal server error',
      });
    } finally {
      await queryRunner.release();
    }

    // 9. Sync to search (fire-and-forget)
    await Promise.all(
      orders.map(async (order) => {
        try {
          const updated = await this.findById(order.id);
          await this.syncOrderToSearch(updated);
        } catch {
          // Search sync should not block receive flow.
        }
      }),
    );

    return successRes({}, 200, 'Orders received');
  }

  async receiveExternalOrders(dto: { integration_id: string; orders: any[] }) {
    const integration = await this.getIntegrationById(String(dto.integration_id));
    if (integration?.is_active === false) {
      this.badRequest('Integration is inactive');
    }

    const fieldMapping = (integration?.field_mapping ?? {}) as Record<string, string>;
    const marketId = integration?.market_id ? String(integration.market_id) : '';
    if (!marketId) {
      this.badRequest('integration.market_id is required');
    }

    const items = Array.isArray(dto.orders) ? dto.orders : [];
    if (!items.length) {
      this.badRequest('orders is required');
    }

    const fallbackDistrictId = await this.getDefaultDistrictId();
    const created: Array<{ id: string; external_id: string | null; status: Order_status }> = [];
    const skipped: Array<{ external_id: string | null; reason: string }> = [];

    for (const ext of items) {
      const externalIdRaw = this.getFieldValue(ext, fieldMapping.id_field ?? 'id');
      const externalId = externalIdRaw == null ? null : String(externalIdRaw);
      const operator = `external_${integration.slug}`;

      if (externalId) {
        const existing = await this.orderRepo.findOne({
          where: {
            external_id: externalId,
            operator,
            isDeleted: false,
          },
        });
        if (existing) {
          skipped.push({ external_id: externalId, reason: 'already_exists' });
          continue;
        }
      }

      const customerName = String(
        this.getFieldValue(ext, fieldMapping.customer_name_field ?? 'full_name') ?? 'External customer',
      );
      const phoneRaw = String(this.getFieldValue(ext, fieldMapping.phone_field ?? 'phone') ?? '');
      const normalizedDigits = phoneRaw.replace(/\D/g, '');
      const phone =
        normalizedDigits.length === 12 && normalizedDigits.startsWith('998')
          ? `+${normalizedDigits}`
          : normalizedDigits.length === 9
            ? `+998${normalizedDigits}`
            : phoneRaw;
      if (!phone?.trim()) {
        skipped.push({ external_id: externalId, reason: 'phone_missing' });
        continue;
      }

      const districtExternal = this.getFieldValue(ext, fieldMapping.district_code_field ?? 'district');
      const districtId = await this.resolveDistrictId(districtExternal, fallbackDistrictId);
      const regionExternal = this.getFieldValue(ext, fieldMapping.region_code_field ?? 'region');

      const customerResponse = await rmqSend<{ data?: { id?: string } }>(
        this.identityClient,
        { cmd: 'identity.customer.create' },
        {
          dto: {
            market_id: marketId,
            name: customerName,
            phone_number: phone,
            district_id: districtId,
            extra_number: this.getFieldValue(ext, fieldMapping.extra_phone_field ?? 'additional_phone') ?? undefined,
            address: this.getFieldValue(ext, fieldMapping.address_field ?? 'address') ?? undefined,
          },
        },
      );

      const customerId = customerResponse?.data?.id ? String(customerResponse.data.id) : '';
      if (!customerId) {
        skipped.push({ external_id: externalId, reason: 'customer_create_failed' });
        continue;
      }

      const totalPrice = Number(this.getFieldValue(ext, fieldMapping.total_price_field ?? 'total_price') ?? 0);
      const deliveryPrice = Number(
        this.getFieldValue(ext, fieldMapping.delivery_price_field ?? 'delivery_price') ?? 0,
      );
      const finalPrice = Math.max(totalPrice, 0) + Math.max(deliveryPrice, 0);
      const qrCode = this.getFieldValue(ext, fieldMapping.qr_code_field ?? 'qr_code') ?? this.generateCustomToken();

      const createdOrder = await this.create({
        market_id: marketId,
        customer_id: customerId,
        where_deliver: Where_deliver.CENTER,
        total_price: finalPrice,
        to_be_paid: 0,
        paid_amount: 0,
        status: Order_status.RECEIVED,
        comment: this.getFieldValue(ext, fieldMapping.comment_field ?? 'comment') ?? null,
        operator,
        district_id: districtId,
        region_id: regionExternal == null ? null : String(regionExternal),
        address: this.getFieldValue(ext, fieldMapping.address_field ?? 'address') ?? null,
        qr_code_token: qrCode == null ? null : String(qrCode),
        external_id: externalId,
        source: Order_source.EXTERNAL,
      });

      created.push({
        id: createdOrder.id,
        external_id: createdOrder.external_id ?? null,
        status: createdOrder.status,
      });
    }

    return {
      statusCode: 201,
      message: `${created.length} ta external order qabul qilindi`,
      data: {
        integration: {
          id: integration.id,
          slug: integration.slug,
          name: integration.name,
        },
        created,
        skipped,
      },
    };
  }

  async sellOrder(
    requester: { id: string; roles?: string[] },
    id: string,
    dto: { comment?: string; extraCost?: number; paidAmount?: number },
  ) {
    const order = await this.findById(id);
    if (order.status !== Order_status.WAITING) {
      this.badRequest('Order not found or not in waiting status');
    }
    if (!order.post_id) {
      this.badRequest('Order has no post');
    }

    const postRes = await rmqSend<{ data?: { id: string; courier_id?: string | null } }>(
      this.logisticsClient,
      { cmd: 'logistics.post.find_by_id' },
      { id: String(order.post_id) },
    ).catch(() => ({ data: undefined }));
    const post = postRes?.data;
    if (!post || String(post.courier_id ?? '') !== String(requester.id)) {
      this.badRequest('Order is not assigned to this courier');
    }

    const [market, courier] = await Promise.all([
      this.getMarketsByIds([String(order.market_id)]).then((rows) => rows[0]),
      this.getCouriersByIds([String(requester.id)]).then((rows) => rows[0]),
    ]);
    if (!market) {
      this.notFound('Market not found');
    }
    if (!courier) {
      this.notFound('Courier not found');
    }

    const [marketCashbox, courierCashbox] = await Promise.all([
      this.getCashboxByUser(String(order.market_id), Cashbox_type.FOR_MARKET),
      this.getCashboxByUser(String(requester.id), Cashbox_type.FOR_COURIER),
    ]);
    if (!marketCashbox) {
      this.notFound('Market cashbox not found');
    }
    if (!courierCashbox) {
      this.notFound('Courier cashbox not found');
    }

    const marketBalanceBefore = Number(marketCashbox.balance ?? 0);

      const marketTariff =
      order.where_deliver === Where_deliver.CENTER
        ? Number(market.tariff_center ?? 0)
        : Number(market.tariff_home ?? 0);
    const courierTariff =
      order.where_deliver === Where_deliver.CENTER
        ? Number(courier.tariff_center ?? 0)
        : Number(courier.tariff_home ?? 0);

    const totalPrice = Number(order.total_price ?? 0);
    const extraCost = Math.max(Number(dto?.extraCost ?? 0), 0);
    const finalComment = this.generateSaleComment(
      order.comment,
      dto?.comment,
      extraCost,
    );

    let toBePaid = 0;
    let courierToBePaid = 0;

    if (totalPrice === 0) {
      await Promise.all([
        this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: marketTariff,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: "0 so'mlik mahsulot sotuvi",
        }),
        this.updateCashboxBalance({
          user_id: String(requester.id),
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: courierTariff,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: "0 so'mlik mahsulot sotuvi",
        }),
      ]);
    } else if (totalPrice < courierTariff) {
      await Promise.all([
        this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: Math.max(marketTariff - totalPrice, 0),
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: `${totalPrice} so'mlik mahsulot sotuvi`,
        }),
        this.updateCashboxBalance({
          user_id: String(requester.id),
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: Math.max(courierTariff - totalPrice, 0),
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: `${totalPrice} so'mlik mahsulot sotuvi`,
        }),
      ]);
    } else if (totalPrice < marketTariff) {
      courierToBePaid = totalPrice - courierTariff;
      await Promise.all([
        this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: Math.max(marketTariff - totalPrice, 0),
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: `${totalPrice} so'mlik mahsulot sotuvi`,
        }),
        this.updateCashboxBalance({
          user_id: String(requester.id),
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: Math.max(courierToBePaid, 0),
          operation_type: Operation_type.INCOME,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: `${totalPrice} so'mlik mahsulot sotuvi`,
        }),
      ]);
    } else {
      toBePaid = totalPrice - marketTariff;
      courierToBePaid = totalPrice - courierTariff;

      await Promise.all([
        this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: Math.max(toBePaid, 0),
          operation_type: Operation_type.INCOME,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
        }),
        this.updateCashboxBalance({
          user_id: String(requester.id),
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: Math.max(courierToBePaid, 0),
          operation_type: Operation_type.INCOME,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
        }),
      ]);
    }

    const netToBePaid = Math.max(Number(toBePaid) || 0, 0);
    const requestedPaidAmount = Number(dto?.paidAmount ?? order.paid_amount ?? 0);
    if (!Number.isFinite(requestedPaidAmount) || requestedPaidAmount < 0) {
      this.badRequest('paidAmount must be a non-negative number');
    }
    const currentPaid = Math.min(Math.max(requestedPaidAmount, 0), netToBePaid);
    const remainingBeforeDebt = netToBePaid - currentPaid;
    const debtBeforeSale = marketBalanceBefore < 0 ? Math.abs(marketBalanceBefore) : 0;
    const autoPay = Math.min(remainingBeforeDebt, debtBeforeSale);
    const paidAfter = Math.min(netToBePaid, currentPaid + autoPay);
    const remaining = Math.max(netToBePaid - paidAfter, 0);
    const nextStatus =
      remaining === 0 && paidAfter > 0
        ? Order_status.PAID
        : paidAfter > 0
          ? Order_status.PARTLY_PAID
          : Order_status.SOLD;

    if (extraCost > 0) {
      await Promise.all([
        this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: extraCost,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.EXTRA_COST,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
        }),
        this.updateCashboxBalance({
          user_id: String(requester.id),
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: extraCost,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.EXTRA_COST,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
        }),
      ]);
    }

    await this.updateFull(id, {
      status: nextStatus,
      to_be_paid: netToBePaid,
      paid_amount: paidAfter,
      sold_at: String(Date.now()),
      comment: finalComment || null,
    }, { id: requester.id, roles: requester.roles, note: 'Order sold' });

    return successRes({}, 200, 'Order sold');
  }

  async cancelOrder(
    requester: { id: string; roles?: string[] },
    id: string,
    dto: { comment?: string; extraCost?: number },
  ) {
    const order = await this.findById(id);
    if (order.status !== Order_status.WAITING) {
      this.badRequest('Order not found or not in waiting status');
    }
    if (!order.post_id) {
      this.badRequest('Order has no post');
    }

    const postRes = await rmqSend<{ data?: { id: string; courier_id?: string | null } }>(
      this.logisticsClient,
      { cmd: 'logistics.post.find_by_id' },
      { id: String(order.post_id) },
    ).catch(() => ({ data: undefined }));
    const post = postRes?.data;
    if (!post || String(post.courier_id ?? '') !== String(requester.id)) {
      this.badRequest('Order is not assigned to this courier');
    }

    const extraCost = Math.max(Number(dto?.extraCost ?? 0), 0);
    const finalComment = this.generateSaleComment(
      order.comment,
      dto?.comment,
      extraCost,
    );

    if (extraCost > 0) {
      const [marketCashbox, courierCashbox] = await Promise.all([
        this.getCashboxByUser(String(order.market_id), Cashbox_type.FOR_MARKET),
        this.getCashboxByUser(String(requester.id), Cashbox_type.FOR_COURIER),
      ]);
      if (!marketCashbox) {
        this.notFound('Market cashbox not found');
      }
      if (!courierCashbox) {
        this.notFound('Courier cashbox not found');
      }

      await Promise.all([
        this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: extraCost,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.EXTRA_COST,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
        }),
        this.updateCashboxBalance({
          user_id: String(requester.id),
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: extraCost,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.EXTRA_COST,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
        }),
      ]);
    }

    await this.updateFull(id, {
      status: Order_status.CANCELLED,
      comment: finalComment || null,
      sold_at: null,
    }, { id: requester.id, roles: requester.roles, note: 'Order canceled' });

    return successRes({ id }, 200, 'Order canceled');
  }

  async partlySellOrder(
    requester: { id: string; roles?: string[] },
    id: string,
    dto: {
      order_item_info: Array<{ product_id: string; quantity: number }>;
      totalPrice: number;
      extraCost?: number;
      comment?: string;
    },
  ) {
    const order = await this.findById(id);
    const oldTotalPrice = Number(order.total_price ?? 0);
    if (order.status !== Order_status.WAITING) {
      this.badRequest('Order not found or not in waiting status');
    }
    if (!order.post_id) {
      this.badRequest('Order has no post');
    }

    const postRes = await rmqSend<{ data?: { id: string; courier_id?: string | null } }>(
      this.logisticsClient,
      { cmd: 'logistics.post.find_by_id' },
      { id: String(order.post_id) },
    ).catch(() => ({ data: undefined }));
    const post = postRes?.data;
    if (!post || String(post.courier_id ?? '') !== String(requester.id)) {
      this.badRequest('Order is not assigned to this courier');
    }

    if (!dto?.order_item_info?.length) {
      this.badRequest('order_item_info is required');
    }

    const price = Number(dto.totalPrice ?? 0);
    if (!Number.isFinite(price) || price < 0) {
      this.badRequest('totalPrice must be a non-negative number');
    }

    const [market, courier] = await Promise.all([
      this.getMarketsByIds([String(order.market_id)]).then((rows) => rows[0]),
      this.getCouriersByIds([String(requester.id)]).then((rows) => rows[0]),
    ]);
    if (!market) {
      this.notFound('Market not found');
    }
    if (!courier) {
      this.notFound('Courier not found');
    }

    const [marketCashbox, courierCashbox] = await Promise.all([
      this.getCashboxByUser(String(order.market_id), Cashbox_type.FOR_MARKET),
      this.getCashboxByUser(String(requester.id), Cashbox_type.FOR_COURIER),
    ]);
    if (!marketCashbox) {
      this.notFound('Market cashbox not found');
    }
    if (!courierCashbox) {
      this.notFound('Courier cashbox not found');
    }

    const marketBalanceBefore = Number(marketCashbox.balance ?? 0);
    const marketTariff =
      order.market_tariff != null
        ? Number(order.market_tariff)
        : order.where_deliver === Where_deliver.CENTER
          ? Number(market.tariff_center ?? 0)
          : Number(market.tariff_home ?? 0);
    const courierTariff =
      order.courier_tariff != null
        ? Number(order.courier_tariff)
        : order.where_deliver === Where_deliver.CENTER
          ? Number(courier.tariff_center ?? 0)
          : Number(courier.tariff_home ?? 0);

    const extraCost = Math.max(Number(dto?.extraCost ?? 0), 0);
    const finalComment = this.generateSaleComment(
      order.comment,
      dto?.comment,
      extraCost,
      ["Buyurtma arzonroqqa sotildi!"],
    );

    const existingItems = await this.orderItemRepo.find({
      where: { order_id: String(order.id) },
      order: { createdAt: 'ASC' },
    });

    const oldQty = existingItems.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
    const newQty = dto.order_item_info.reduce((sum, item) => {
      const qty = Number(item.quantity ?? 0);
      if (!Number.isFinite(qty) || qty < 0) {
        this.badRequest('Item quantity must be a non-negative number');
      }
      return sum + qty;
    }, 0);

    if (newQty > oldQty) {
      this.badRequest('Partly sell quantity cannot exceed original quantity');
    }

    for (const existingItem of existingItems) {
      const dtoItem = dto.order_item_info.find(
        (item) => String(item.product_id) === String(existingItem.product_id),
      );
      if (!dtoItem) {
        this.notFound(`Product not found in request: ${existingItem.product_id}`);
      }
      if (Number(dtoItem.quantity) > Number(existingItem.quantity)) {
        this.badRequest(`Quantity cannot exceed original amount for product ${existingItem.product_id}`);
      }
    }

    for (const dtoItem of dto.order_item_info) {
      const existingItem = existingItems.find(
        (item) => String(item.product_id) === String(dtoItem.product_id),
      );
      if (!existingItem) {
        this.notFound(`Product not found in order: ${dtoItem.product_id}`);
      }
    }

    const cancelledItems = existingItems
      .map((existingItem) => {
        const dtoItem = dto.order_item_info.find(
          (item) => String(item.product_id) === String(existingItem.product_id),
        );
        if (!dtoItem) return null;

        const diff = Number(existingItem.quantity) - Number(dtoItem.quantity);
        return diff > 0
          ? { product_id: String(existingItem.product_id), quantity: diff }
          : null;
      })
      .filter((item): item is { product_id: string; quantity: number } => item !== null);

    for (const existingItem of existingItems) {
      const dtoItem = dto.order_item_info.find(
        (item) => String(item.product_id) === String(existingItem.product_id),
      );
      if (!dtoItem) continue;

      const nextQty = Number(dtoItem.quantity);
      if (nextQty < Number(existingItem.quantity)) {
        existingItem.quantity = nextQty;
        await this.orderItemRepo.save(existingItem);
      }
    }

    let toBePaid = 0;
    let courierToBePaid = 0;

    if (price === 0) {
      await Promise.all([
        this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: marketTariff,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: "0 so'mlik mahsulot qisman sotuvi",
        }),
        this.updateCashboxBalance({
          user_id: String(requester.id),
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: courierTariff,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: "0 so'mlik mahsulot qisman sotuvi",
        }),
      ]);
    } else if (price < courierTariff) {
      await Promise.all([
        this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: Math.max(marketTariff - price, 0),
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: `${price} so'mlik mahsulot qisman sotuvi`,
        }),
        this.updateCashboxBalance({
          user_id: String(requester.id),
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: Math.max(courierTariff - price, 0),
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: `${price} so'mlik mahsulot qisman sotuvi`,
        }),
      ]);
    } else if (price < marketTariff) {
      courierToBePaid = price - courierTariff;
      await Promise.all([
        this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: Math.max(marketTariff - price, 0),
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: `${price} so'mlik mahsulot qisman sotuvi`,
        }),
        this.updateCashboxBalance({
          user_id: String(requester.id),
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: Math.max(courierToBePaid, 0),
          operation_type: Operation_type.INCOME,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: `${price} so'mlik mahsulot qisman sotuvi`,
        }),
      ]);
    } else {
      toBePaid = price - marketTariff;
      courierToBePaid = price - courierTariff;
      await Promise.all([
        this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: Math.max(toBePaid, 0),
          operation_type: Operation_type.INCOME,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
        }),
        this.updateCashboxBalance({
          user_id: String(requester.id),
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: Math.max(courierToBePaid, 0),
          operation_type: Operation_type.INCOME,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
        }),
      ]);
    }

    const netToBePaid = Math.max(Number(toBePaid) || 0, 0);
    const currentPaid = Math.min(
      Math.max(Number(order.paid_amount ?? 0), 0),
      netToBePaid,
    );
    const remainingBeforeDebt = netToBePaid - currentPaid;
    const debtBeforeSale = marketBalanceBefore < 0 ? Math.abs(marketBalanceBefore) : 0;
    const autoPay = Math.min(remainingBeforeDebt, debtBeforeSale);
    const paidAfter = Math.min(netToBePaid, currentPaid + autoPay);
    const remainingAfter = netToBePaid - paidAfter;

    if (extraCost > 0) {
      await Promise.all([
        this.updateCashboxBalance({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: extraCost,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.EXTRA_COST,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
        }),
        this.updateCashboxBalance({
          user_id: String(requester.id),
          cashbox_type: Cashbox_type.FOR_COURIER,
          amount: extraCost,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.EXTRA_COST,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
        }),
      ]);
    }

    await this.updateFull(id, {
      status:
        remainingAfter === 0 && paidAfter > 0
          ? Order_status.PAID
          : paidAfter > 0
            ? Order_status.PARTLY_PAID
            : Order_status.SOLD,
      to_be_paid: netToBePaid,
      paid_amount: paidAfter,
      sold_at: order.sold_at ?? String(Date.now()),
      total_price: price,
      market_tariff: order.market_tariff ?? marketTariff,
      courier_tariff: order.courier_tariff ?? courierTariff,
      return_requested: false,
      comment: finalComment || null,
    }, { id: requester.id, roles: requester.roles, note: 'Order partly sold' });

    const refreshedOrder = await this.findById(id);
    refreshedOrder.product_quantity = newQty;
    await this.orderRepo.save(refreshedOrder);

    if (cancelledItems.length > 0) {
      const cancelledQty = cancelledItems.reduce((sum, item) => sum + item.quantity, 0);
      const cancelledTotalPrice = Math.max(oldTotalPrice - price, 0);

      await this.create({
        market_id: String(order.market_id),
        customer_id: String(order.customer_id),
        where_deliver: order.where_deliver,
        total_price: cancelledTotalPrice,
        to_be_paid: 0,
        paid_amount: 0,
        status: Order_status.CANCELLED,
        comment: "Qisman bekor qilingan mahsulotlar",
        operator: order.operator ?? null,
        post_id: order.post_id ?? null,
        canceled_post_id: order.canceled_post_id ?? null,
        district_id: order.district_id ?? null,
        region_id: order.region_id ?? null,
        address: order.address ?? null,
        qr_code_token: `CANCEL-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
        parent_order_id: String(order.id),
        items: cancelledItems,
      });

      refreshedOrder.product_quantity = newQty;
    }

    return successRes({}, 200, 'Order qisman sotildi');
  }

  async findById(id: string) {
    let order: Order | null;
    try {
      order = await this.orderRepo.findOne({
        where: { id, isDeleted: false },
        relations: { items: true },
      });
    } catch (error) {
      this.handleDbError(error);
    }
    if (!order) {
      this.notFound(`Order #${id} topilmadi`);
    }
    return order;
  }

  async findByQrCode(token: string) {
    let order: Order | null;
    try {
      order = await this.orderRepo.findOne({
        where: { qr_code_token: token, isDeleted: false },
        relations: { items: true },
      });
    } catch (error) {
      this.handleDbError(error);
    }
    if (!order) {
      this.notFound('Order not found');
    }
    return successRes(order, 200, 'Order by QR code');
  }

  async findByQrCodeEnriched(token: string) {
    const result = await this.findByQrCode(token);
    const order = (result as { data?: Order })?.data;

    if (!order) {
      return result;
    }

    const enriched = await this.enrichOrders([order]);
    return successRes(enriched[0] ?? order, 200, 'Order by QR code');
  }

  async getTrackingByOrderId(id: string) {
    await this.findById(id);

    let rows: OrderTracking[];
    try {
      rows = await this.orderTrackingRepo.find({
        where: { order_id: id },
        order: { created_at: 'ASC' },
      });
    } catch (error) {
      this.handleDbError(error);
    }

    return rows.map((row) => ({
      id: row.id,
      order_id: row.order_id,
      from_status: row.from_status,
      to_status: row.to_status,
      changed_by: row.changed_by,
      changed_by_role: row.changed_by_role,
      note: row.note,
      created_at: this.toUzIsoString(row.created_at),
    }));
  }

  async update(
    id: string,
    dto: {
      market_id?: string;
      customer_id?: string;
      where_deliver?: Where_deliver;
      total_price?: number;
      market_tariff?: number | null;
      courier_tariff?: number | null;
      to_be_paid?: number;
      paid_amount?: number;
      status?: Order_status;
      return_requested?: boolean;
      comment?: string | null;
      operator?: string | null;
      post_id?: string | null;
      canceled_post_id?: string | null;
      sold_at?: string | null;
      district_id?: string | null;
      region_id?: string | null;
      address?: string | null;
      qr_code_token?: string | null;
      external_id?: string | null;
      source?: Order_source;
      items?: Array<{ product_id: string; quantity?: number }>;
    },
    requester?: { id?: string; roles?: string[]; note?: string | null },
  ) {
    return this.updateFull(id, dto, requester);
  }

  async updateFull(
    id: string,
    dto: {
      market_id?: string;
      customer_id?: string;
      where_deliver?: Where_deliver;
      total_price?: number;
      market_tariff?: number | null;
      courier_tariff?: number | null;
      to_be_paid?: number;
      paid_amount?: number;
      status?: Order_status;
      return_requested?: boolean;
      comment?: string | null;
      operator?: string | null;
      post_id?: string | null;
      canceled_post_id?: string | null;
      sold_at?: string | null;
      district_id?: string | null;
      region_id?: string | null;
      address?: string | null;
      qr_code_token?: string | null;
      external_id?: string | null;
      source?: Order_source;
      items?: Array<{ product_id: string; quantity?: number }>;
    },
    requester?: { id?: string; roles?: string[]; note?: string | null },
  ) {
    const order = await this.findById(id);
    const oldStatus = order.status;

    Object.assign(order, {
      market_id: dto.market_id ?? order.market_id,
      customer_id: dto.customer_id ?? order.customer_id,
      where_deliver: dto.where_deliver ?? order.where_deliver,
      total_price: dto.total_price ?? order.total_price,
      market_tariff:
        typeof dto.market_tariff !== 'undefined'
          ? dto.market_tariff
          : order.market_tariff,
      courier_tariff:
        typeof dto.courier_tariff !== 'undefined'
          ? dto.courier_tariff
          : order.courier_tariff,
      to_be_paid: dto.to_be_paid ?? order.to_be_paid,
      paid_amount: dto.paid_amount ?? order.paid_amount,
      status: dto.status ?? order.status,
      return_requested:
        typeof dto.return_requested !== 'undefined'
          ? dto.return_requested
          : order.return_requested,
      comment: dto.comment ?? order.comment,
      operator: dto.operator ?? order.operator,
      post_id: dto.post_id ?? order.post_id,
      canceled_post_id:
        typeof dto.canceled_post_id !== 'undefined'
          ? dto.canceled_post_id
          : order.canceled_post_id,
      sold_at:
        typeof dto.sold_at !== 'undefined'
          ? dto.sold_at
          : order.sold_at,
      district_id: dto.district_id ?? order.district_id,
      region_id: dto.region_id ?? order.region_id,
      address: dto.address ?? order.address,
      qr_code_token: dto.qr_code_token ?? order.qr_code_token,
      external_id:
        typeof dto.external_id !== 'undefined'
          ? dto.external_id
          : order.external_id,
      source: dto.source ?? order.source ?? Order_source.INTERNAL,
    });

    if (oldStatus !== order.status && !this.isValidStatusTransition(oldStatus, order.status)) {
      this.badRequest(`Invalid status transition: ${oldStatus} -> ${order.status}`);
    }

    if (dto.items) {
      order.product_quantity = await this.replaceOrderItems(order.id, dto.items);
    }

    // Prevent TypeORM cascade on stale one-to-many relation from nulling order_id.
    delete (order as Partial<Order> & { items?: OrderItem[] }).items;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const orderRepo = queryRunner.manager.getRepository(Order);
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);
      await orderRepo.save(order);

      if (oldStatus !== order.status) {
        await this.createTrackingEvent(
          {
            order_id: order.id,
            from_status: oldStatus,
            to_status: order.status,
            changed_by: String(requester?.id ?? 'system'),
            changed_by_role: requester?.id ? this.toTrackingRole(requester.roles) : 'system',
            note: requester?.note ?? null,
          },
          trackingRepo,
        );
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.handleDbError(error);
    } finally {
      await queryRunner.release();
    }

    const updated = await this.findById(order.id);
    const newStatus = updated.status;
    if (oldStatus !== newStatus) {
      const action = this.resolveSyncAction(oldStatus, newStatus);
      if (action) {
        void this.queueExternalStatusSync(updated, action, oldStatus, newStatus);
      }
    }
    void this.syncOrderToSearch(updated);
    return updated;
  }

  async remove(id: string, requester?: { id?: string; roles?: string[] }) {
    const order = await this.findById(id);

    const requesterId = String(requester?.id ?? '');
    const isSuperAdmin = this.hasRole(requester, Roles.SUPERADMIN);
    const isAdmin = this.hasRole(requester, Roles.ADMIN);
    const isRegistrator = this.hasRole(requester, Roles.REGISTRATOR);
    const isMarket = this.hasRole(requester, Roles.MARKET);

    if (order.status === Order_status.CREATED) {
      const isOwnerMarket = isMarket && requesterId === String(order.market_id ?? '');
      if (!isOwnerMarket) {
        this.forbidden("Faqat order egasi bo'lgan market 'created' holatdagi buyurtmani o‘chira oladi");
      }
    } else if (order.status === Order_status.NEW) {
      const canDeleteNew = isSuperAdmin || isAdmin || isRegistrator || isMarket;
      if (!canDeleteNew) {
        this.forbidden(
          "Faqat superadmin/admin/registrator/market 'new' holatdagi buyurtmani o‘chira oladi",
        );
      }
    } else if (order.status === Order_status.RECEIVED) {
      if (!isSuperAdmin) {
        this.forbidden("Faqat superadmin 'received' holatdagi buyurtmani o‘chira oladi");
      }
    } else {
      this.badRequest("Faqat 'created', 'new' yoki 'received' holatdagi buyurtmani o‘chirish mumkin");
    }

    order.isDeleted = true;
    await this.orderRepo.save(order);
    void this.removeOrderFromSearch(id);
    return successRes({}, 200, `Order #${id} o'chirildi`);
  }

  // ==================== Enrichment Helpers ====================

  private stripRegionDistricts<T>(region: T): T {
    if (!region || typeof region !== 'object') {
      return region;
    }
    const { districts, ...rest } = region as Record<string, unknown>;
    void districts;
    return rest as T;
  }

  private async enrichOrders(rows: Order[]) {
    if (!rows.length) return [];

    const marketIds = [...new Set(rows.map((r) => r.market_id).filter(Boolean))];
    const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))];
    const districtIds = [...new Set(rows.map((r) => r.district_id).filter(Boolean) as string[])];
    const regionIds = [...new Set(rows.map((r) => r.region_id).filter(Boolean) as string[])];
    const productIds = [...new Set(
      rows.flatMap((r) => r.items ?? []).map((i) => i.product_id).filter(Boolean),
    )];

    const [marketsRes, customersRes, districtsRes, regionsRes, productsRes] = await Promise.all([
      marketIds.length
        ? rmqSend<{ data: Array<{id: string; [key: string]: any}> }>(this.identityClient, { cmd: 'identity.market.find_by_ids' }, { ids: marketIds }).catch(() => ({ data: [] }))
        : { data: [] as Array<{id: string; [key: string]: any}> },
      customerIds.length
        ? rmqSend<{ data: Array<{id: string; [key: string]: any}> }>(this.identityClient, { cmd: 'identity.customer.find_by_ids' }, { ids: customerIds }).catch(() => ({ data: [] }))
        : { data: [] as Array<{id: string; [key: string]: any}> },
      districtIds.length
        ? rmqSend<{ data: Array<{id: string; [key: string]: any}> }>(this.logisticsClient, { cmd: 'logistics.district.find_by_ids' }, { ids: districtIds }).catch(() => ({ data: [] }))
        : { data: [] as Array<{id: string; [key: string]: any}> },
      regionIds.length
        ? rmqSend<{ data: Array<{id: string; [key: string]: any}> }>(this.logisticsClient, { cmd: 'logistics.region.find_by_ids' }, { ids: regionIds }).catch(() => ({ data: [] }))
        : { data: [] as Array<{id: string; [key: string]: any}> },
      productIds.length
        ? rmqSend<{ data: Array<{id: string; [key: string]: any}> }>(this.catalogClient, { cmd: 'catalog.product.find_by_ids' }, { ids: productIds }).catch(() => ({ data: [] }))
        : { data: [] },
    ]);

    const toMap = (arr: Array<{id: string; [key: string]: any}>) =>
      new Map(arr.map((item): [string, typeof item] => [String(item.id), item]));

    const marketMap = toMap(marketsRes?.data ?? []);
    const customerMap = toMap(customersRes?.data ?? []);
    const districtMap = toMap(districtsRes?.data ?? []);
    const regionMap = toMap(regionsRes?.data ?? []);
    const productMap = toMap(productsRes?.data ?? []);

    return rows.map((row) => ({
      ...row,
      market: row.market_id ? marketMap.get(row.market_id) ?? null : null,
      customer: row.customer_id
        ? {
            ...(customerMap.get(row.customer_id) ?? null),
            district: row.district_id ? districtMap.get(row.district_id) ?? null : null,
            region: row.region_id
              ? this.stripRegionDistricts(regionMap.get(row.region_id) ?? null)
              : null,
          }
        : null,
      district: row.district_id ? districtMap.get(row.district_id) ?? null : null,
      region: row.region_id
        ? this.stripRegionDistricts(regionMap.get(row.region_id) ?? null)
        : null,
      items: (row.items ?? []).map((item) => ({
        ...item,
        product: item.product_id ? productMap.get(item.product_id) ?? null : null,
      })),
    }));
  }

  // ==================== Enriched Endpoints ====================

  async findAllEnriched(query: {
    market_id?: string;
    customer_id?: string;
    post_ids?: string[];
    exclude_statuses?: Order_status[];
    status?: Order_status | Order_status[] | string | string[];
    search?: string;
    start_day?: string;
    end_day?: string;
    courier?: string;
    region_id?: string;
    page?: number;
    limit?: number;
  }) {
    const { search, ...orderQuery } = query;

    // If search is provided, find matching customer IDs via identity-service
    let customer_ids: string[] | undefined;
    if (search?.trim()) {
      const searchRes = await rmqSend<{ data: Array<{ id: string }> }>(
        this.identityClient,
        { cmd: 'identity.customer.search' },
        { search: search.trim(), limit: 1000 },
      ).catch(() => ({ data: [] }));

      customer_ids = (searchRes?.data ?? []).map((c) => String(c.id));
      if (!customer_ids.length) {
        const pagination = this.normalizePagination(query.page, query.limit);
        return {
          data: [],
          total: 0,
          page: pagination.page,
          limit: pagination.limit,
          total_pages: 0,
          totalPages: 0,
        };
      }
    }

    const result = await this.findAll({ ...orderQuery, customer_ids });
    const enriched = await this.enrichOrders(result.data);

    return {
      data: enriched,
      total: result.total,
      page: result.page,
      limit: result.limit,
      total_pages: result.total_pages ?? 0,
      totalPages: result.totalPages ?? result.total_pages ?? 0,
    };
  }

  async findByIdEnriched(id: string) {
    const order = await this.findById(id);
    const enriched = await this.enrichOrders([order]);
    return enriched[0] ?? order;
  }

  async findNewMarketsEnriched() {
    const rows = await this.findNewMarkets();
    const marketIds = rows.map((r) => r.market_id).filter(Boolean);

    if (!marketIds.length) return rows;

    const marketsRes = await rmqSend<{ data: Array<{id: string; [key: string]: any}> }>(
      this.identityClient,
      { cmd: 'identity.market.find_by_ids' },
      { ids: marketIds },
    ).catch(() => ({ data: [] as Array<{id: string; [key: string]: any}> }));

    const marketMap = new Map((marketsRes?.data ?? []).map((m): [string, typeof m] => [String(m.id), m]));

    return rows.map((row) => ({
      ...row,
      market: marketMap.get(row.market_id) ?? null,
    }));
  }

  async findNewByMarketEnriched(market_id: string, page = 1, limit = 10) {
    const result = await this.findAll({ market_id, status: Order_status.NEW, page, limit });
    const enriched = await this.enrichOrders(result.data);
    return {
      data: enriched,
      total: result.total,
      page: result.page,
      limit: result.limit,
      total_pages: result.total_pages ?? 0,
      totalPages: result.totalPages ?? result.total_pages ?? 0,
    };
  }

  async getOverviewStats(startDate?: string, endDate?: string) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());

    const [acceptedCount, cancelled, soldAndPaid, soldOrders] = await Promise.all([
      this.orderRepo.count({
        where: {
          isDeleted: false,
          createdAt: Between(start, end),
        },
      }),
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.updatedAt BETWEEN :start AND :end', { start, end })
        .andWhere('o.status = :status', { status: Order_status.CANCELLED })
        .getCount(),
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
        .getCount(),
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
        .getMany(),
    ]);

    const marketIds = [...new Set(soldOrders.map((o) => o.market_id).filter(Boolean))];
    const postIds = [...new Set(soldOrders.map((o) => o.post_id).filter(Boolean) as string[])];
    const [markets, posts] = await Promise.all([
      this.getMarketsByIds(marketIds),
      this.getPostsByIds(postIds),
    ]);
    const courierIds = [...new Set(posts.map((p) => p.courier_id).filter(Boolean) as string[])];
    const couriers = await this.getCouriersByIds(courierIds);

    const marketMap = new Map(markets.map((m) => [String(m.id), m]));
    const postMap = new Map(posts.map((p) => [String(p.id), p]));
    const courierMap = new Map(couriers.map((c) => [String(c.id), c]));

    let profit = 0;
    for (const order of soldOrders) {
      const market = marketMap.get(String(order.market_id));
      const courierId = order.post_id ? postMap.get(String(order.post_id))?.courier_id : null;
      const courier = courierId ? courierMap.get(String(courierId)) : null;
      if (order.where_deliver === Where_deliver.ADDRESS) {
        profit += Number(market?.tariff_home ?? 0) - Number(courier?.tariff_home ?? 0);
      } else {
        profit += Number(market?.tariff_center ?? 0) - Number(courier?.tariff_center ?? 0);
      }
    }

    return {
      acceptedCount,
      cancelled,
      soldAndPaid,
      profit,
      from: start.getTime(),
      to: end.getTime(),
    };
  }

  async getMarketStats(startDate?: string, endDate?: string) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());

    const totalsRaw = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.market_id', 'market_id')
      .addSelect('COUNT(*)', 'total')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.createdAt BETWEEN :start AND :end', { start, end })
      .andWhere('o.market_id IS NOT NULL')
      .groupBy('o.market_id')
      .getRawMany<{ market_id: string; total: string }>();

    const soldsRaw = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.market_id', 'market_id')
      .addSelect('COUNT(*)', 'sold')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
      .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
      .andWhere('o.market_id IS NOT NULL')
      .groupBy('o.market_id')
      .getRawMany<{ market_id: string; sold: string }>();

    const totalsMap = new Map(totalsRaw.map((r) => [String(r.market_id), Number(r.total)]));
    const soldsMap = new Map(soldsRaw.map((r) => [String(r.market_id), Number(r.sold)]));
    const marketIds = Array.from(new Set([...totalsMap.keys(), ...soldsMap.keys()]));
    const markets = await this.getMarketsByIds(marketIds);

    const result = markets.map((market) => {
      const totalOrders = totalsMap.get(String(market.id)) ?? 0;
      const soldOrders = soldsMap.get(String(market.id)) ?? 0;
      const sellingRate = totalOrders > 0 ? Number(((soldOrders * 100) / totalOrders).toFixed(2)) : 0;
      return { market, totalOrders, soldOrders, sellingRate };
    });

    result.sort((a, b) => b.sellingRate - a.sellingRate);
    return result;
  }

  async getCourierStats(startDate?: string, endDate?: string) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = start.getTime();
    const endMs = end.getTime();
    const postRows = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.post_id', 'post_id')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.updatedAt BETWEEN :start AND :end', { start, end })
      .andWhere('o.post_id IS NOT NULL')
      .groupBy('o.post_id')
      .getRawMany<{ post_id: string }>();
    const postIds = postRows.map((row) => String(row.post_id)).filter(Boolean);

    if (!postIds.length) {
      return [];
    }

    const posts = await this.getPostsByIds(postIds);

    const orders = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.post_id IN (:...postIds)', {
        postIds,
      })
      .andWhere('o.updatedAt BETWEEN :start AND :end', { start, end })
      .select(['o.id', 'o.status', 'o.post_id', 'o.sold_at'])
      .getMany();

    const postMap = new Map<string, { id: string; courier_id?: string | null }>(
      posts.map((post) => [String(post.id), post]),
    );
    const courierIds = [...new Set(posts.map((post) => post.courier_id).filter(Boolean) as string[])];
    const couriers = await this.getCouriersByIds(courierIds);

    const statsByCourier = new Map<string, { total: number; sold: number }>();
    for (const order of orders) {
      const courierId = order.post_id ? postMap.get(String(order.post_id))?.courier_id : null;
      if (!courierId) continue;
      const current = statsByCourier.get(String(courierId)) ?? { total: 0, sold: 0 };
      current.total += 1;
      const soldAt = order.sold_at ? Number(order.sold_at) : null;
      if (soldStatuses.includes(order.status) && soldAt && soldAt >= startMs && soldAt <= endMs) {
        current.sold += 1;
      }
      statsByCourier.set(String(courierId), current);
    }

    const result = couriers.map((courier) => {
      const stats = statsByCourier.get(String(courier.id)) ?? { total: 0, sold: 0 };
      const successRate = stats.total > 0 ? Number(((stats.sold * 100) / stats.total).toFixed(2)) : 0;
      return {
        courier,
        totalOrders: stats.total,
        soldOrders: stats.sold,
        successRate,
      };
    });

    result.sort((a, b) => b.successRate - a.successRate);
    return result;
  }

  async getTopMarkets(limit = 10) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const totalsRaw = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.market_id', 'market_id')
      .addSelect('COUNT(*)', 'total_orders')
      .addSelect(
        `SUM(CASE WHEN o.status IN (:...statuses) THEN 1 ELSE 0 END)`,
        'successful_orders',
      )
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.createdAt >= :lastMonth', { lastMonth })
      .andWhere('o.market_id IS NOT NULL')
      .setParameter('statuses', soldStatuses)
      .groupBy('o.market_id')
      .getRawMany<{ market_id: string; total_orders: string; successful_orders: string }>();

    const markets = await this.getMarketsByIds(totalsRaw.map((r) => String(r.market_id)));
    const marketMap = new Map(markets.map((m) => [String(m.id), m]));

    const result = totalsRaw
      .filter((row) => Number(row.total_orders) >= 30)
      .map((row) => {
        const totalOrders = Number(row.total_orders);
        const successfulOrders = Number(row.successful_orders);
        const successRate = totalOrders > 0 ? Number(((successfulOrders * 100) / totalOrders).toFixed(2)) : 0;
        const market = marketMap.get(String(row.market_id));
        return {
          market_id: row.market_id,
          market_name: market?.name ?? null,
          total_orders: totalOrders,
          successful_orders: successfulOrders,
          success_rate: successRate,
        };
      })
      .sort((a, b) => b.success_rate - a.success_rate)
      .slice(0, limit);

    return result;
  }

  async getTopCouriers(limit = 10) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const orders = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.createdAt >= :lastMonth', { lastMonth })
      .andWhere('o.post_id IS NOT NULL')
      .select(['o.post_id', 'o.status'])
      .getMany();

    const posts = await this.getPostsByIds([
      ...new Set(orders.map((o) => o.post_id).filter(Boolean) as string[]),
    ]);
    const postMap = new Map(posts.map((p) => [String(p.id), p]));
    const courierIds = [...new Set(posts.map((p) => p.courier_id).filter(Boolean) as string[])];
    const couriers = await this.getCouriersByIds(courierIds);
    const courierMap = new Map(couriers.map((c) => [String(c.id), c]));

    const stats = new Map<string, { total: number; successful: number }>();
    for (const order of orders) {
      const courierId = order.post_id ? postMap.get(String(order.post_id))?.courier_id : null;
      if (!courierId) continue;
      const current = stats.get(String(courierId)) ?? { total: 0, successful: 0 };
      current.total += 1;
      if (soldStatuses.includes(order.status)) {
        current.successful += 1;
      }
      stats.set(String(courierId), current);
    }

    return Array.from(stats.entries())
      .map(([courierId, current]) => {
        const courier = courierMap.get(courierId);
        const successRate = current.total > 0 ? Number(((current.successful * 100) / current.total).toFixed(2)) : 0;
        return {
          courier_id: courierId,
          courier_name: courier?.name ?? null,
          total_orders: current.total,
          successful_orders: current.successful,
          success_rate: successRate,
        };
      })
      .filter((row) => row.total_orders >= 30)
      .sort((a, b) => b.success_rate - a.success_rate)
      .slice(0, limit);
  }

  async getTopOperatorsByMarket(marketId: string, limit = 10) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const rows = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.operator_id', 'operator_id')
      .addSelect('COUNT(*)', 'total_orders')
      .addSelect(
        `SUM(CASE WHEN o.status IN (:...statuses) THEN 1 ELSE 0 END)`,
        'successful_orders',
      )
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.market_id = :marketId', { marketId })
      .andWhere('o.createdAt >= :lastMonth', { lastMonth })
      .andWhere('o.operator_id IS NOT NULL')
      .setParameter('statuses', soldStatuses)
      .groupBy('o.operator_id')
      .getRawMany<{ operator_id: string; total_orders: string; successful_orders: string }>();

    if (!rows.length) {
      return [];
    }

    const operators = await this.getAllOperatorUsers();
    const byId = new Map<string, any>();

    for (const operator of operators) {
      if (marketId && String(operator?.market_id ?? '') !== String(marketId)) {
        continue;
      }
      const idKey = String(operator?.id ?? '').trim();
      if (idKey) byId.set(idKey, operator);
    }

    return rows
      .map((row) => {
        const totalOrders = Number(row.total_orders) || 0;
        const successfulOrders = Number(row.successful_orders) || 0;
        const successRate =
          totalOrders > 0
            ? Number(((successfulOrders * 100) / totalOrders).toFixed(2))
            : 0;
        const operatorId = String(row.operator_id ?? '').trim();
        const matched = byId.get(operatorId) ?? null;

        return {
          operator_id: operatorId || null,
          operator_name: matched?.name ?? matched?.username ?? null,
          total_orders: totalOrders,
          successful_orders: successfulOrders,
          success_rate: successRate,
        };
      })
      .sort((a, b) => b.success_rate - a.success_rate)
      .slice(0, limit);
  }

  async getCourierStat(courierId: string, startDate?: string, endDate?: string) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());
    const courierPosts = (await this.getAllPostsForAnalytics()).filter((post) => {
      return String(post.courier_id) === String(courierId);
    });

    const postIds = courierPosts.map((post) => post.id);
    if (!postIds.length) {
      return {
        totalOrders: 0,
        soldOrders: 0,
        canceledOrders: 0,
        profit: 0,
        successRate: 0,
      };
    }

    const [totalOrders, soldOrders, canceledOrders, soldOrderEntities] = await Promise.all([
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.post_id IN (:...postIds)', { postIds })
        .andWhere('o.updatedAt BETWEEN :start AND :end', { start, end })
        .getCount(),
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.post_id IN (:...postIds)', { postIds })
        .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
        .getCount(),
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.post_id IN (:...postIds)', { postIds })
        .andWhere('o.updatedAt BETWEEN :start AND :end', { start, end })
        .andWhere('o.status = :status', { status: Order_status.CANCELLED })
        .getCount(),
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.post_id IN (:...postIds)', { postIds })
        .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
        .getMany(),
    ]);

    const couriers = await this.getCouriersByIds([courierId]);
    const courier = couriers[0];

    let profit = 0;
    for (const order of soldOrderEntities) {
      profit += order.where_deliver === Where_deliver.ADDRESS
        ? Number(courier?.tariff_home ?? 0)
        : Number(courier?.tariff_center ?? 0);
    }

    const successRate = totalOrders > 0 ? Number(((soldOrders * 100) / totalOrders).toFixed(2)) : 0;

    return {
      totalOrders,
      soldOrders,
      canceledOrders,
      profit,
      successRate,
    };
  }

  async getMarketStat(marketId: string, startDate?: string, endDate?: string) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());

    const allOrders = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.createdAt BETWEEN :start AND :end', { start, end })
      .andWhere('o.market_id = :marketId', { marketId })
      .getMany();

    if (!allOrders.length) {
      return {
        totalOrders: 0,
        soldOrders: 0,
        canceledOrders: 0,
        profit: 0,
        successRate: 0,
      };
    }

    const orderIds = allOrders.map((order) => order.id);

    const [soldOrders, canceledOrders, soldOrderEntities] = await Promise.all([
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.id IN (:...orderIds)', { orderIds })
        .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
        .getCount(),
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.id IN (:...orderIds)', { orderIds })
        .andWhere('o.updatedAt BETWEEN :start AND :end', { start, end })
        .andWhere('o.status = :status', { status: Order_status.CANCELLED })
        .getCount(),
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.id IN (:...orderIds)', { orderIds })
        .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
        .getMany(),
    ]);

    const profit = soldOrderEntities.reduce((sum, order) => sum + Number(order.to_be_paid ?? 0), 0);
    const successRate = allOrders.length > 0 ? Number(((soldOrders * 100) / allOrders.length).toFixed(2)) : 0;

    return {
      totalOrders: allOrders.length,
      soldOrders,
      canceledOrders,
      profit,
      successRate,
    };
  }

  async getRevenueStats(startDate?: string, endDate?: string, period = 'daily') {
    const normalizedPeriod = this.normalizeRevenuePeriod(period);
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());

    const soldOrders = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
      .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
      .select(['o.id', 'o.total_price', 'o.sold_at'])
      .getMany();

    const buckets = new Map<string, { period: string; label: string; ordersCount: number; revenue: number }>();
    let cursor = this.periodStart(start, normalizedPeriod);
    const endCursor = this.periodStart(end, normalizedPeriod);

    while (cursor <= endCursor) {
      const key = this.periodKey(cursor, normalizedPeriod);
      buckets.set(key, {
        period: key,
        label: this.periodLabel(cursor, normalizedPeriod),
        ordersCount: 0,
        revenue: 0,
      });
      cursor = this.nextPeriodStart(cursor, normalizedPeriod);
    }

    for (const order of soldOrders) {
      if (!order.sold_at) continue;
      const soldDate = new Date(Number(order.sold_at));
      const key = this.periodKey(soldDate, normalizedPeriod);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.ordersCount += 1;
      bucket.revenue += Number(order.total_price ?? 0);
    }

    const data = Array.from(buckets.values());
    const totalRevenue = data.reduce((sum, row) => sum + row.revenue, 0);
    const totalOrders = data.reduce((sum, row) => sum + row.ordersCount, 0);
    const avgRevenue = data.length ? Math.round(totalRevenue / data.length) : 0;

    return {
      data,
      summary: {
        totalRevenue,
        totalOrders,
        avgRevenue,
      },
    };
  }

  normalizeUpdatePayload(dto: Record<string, any>): Record<string, any> {
    const payload = { ...dto };

    if (typeof payload.where_deliver === 'string') {
      const normalized = payload.where_deliver.toLowerCase();
      if (normalized === Where_deliver.CENTER || normalized === Where_deliver.ADDRESS) {
        payload.where_deliver = normalized;
      }
    }

    if (typeof payload.status === 'string') {
      const normalized = payload.status.toLowerCase();
      payload.status = normalized === Order_status.CREATED ? Order_status.NEW : normalized;
    }

    if (payload.items) {
      payload.items = payload.items.map((item: any) => ({
        product_id: String(item.product_id),
        quantity: item.quantity ?? 1,
      }));
    }

    return payload;
  }
}
