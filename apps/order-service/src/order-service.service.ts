import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { Brackets, DataSource, In, QueryFailedError, Repository } from 'typeorm';
import { lastValueFrom, timeout } from 'rxjs';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Order_status, Post_status, Roles, Where_deliver, rmqSend, RMQ_SERVICE_TIMEOUT } from '@app/common';

@Injectable()
export class OrderServiceService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepo: Repository<OrderItem>,
    @Inject('SEARCH') private readonly searchClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
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
    post_id?: string | null;
    district_id?: string | null;
    region_id?: string | null;
    address?: string | null;
    qr_code_token?: string | null;
    items?: Array<{ product_id: string; quantity?: number }>;
  }) {
    const order = this.orderRepo.create({
      market_id: dto.market_id,
      customer_id: dto.customer_id,
      where_deliver: dto.where_deliver ?? Where_deliver.CENTER,
      total_price: dto.total_price ?? 0,
      to_be_paid: dto.to_be_paid ?? 0,
      paid_amount: dto.paid_amount ?? 0,
      status: dto.status ?? Order_status.NEW,
      comment: dto.comment ?? null,
      operator: dto.operator ?? null,
      post_id: dto.post_id ?? null,
      district_id: dto.district_id ?? null,
      region_id: dto.region_id ?? null,
      address: dto.address ?? null,
      qr_code_token: dto.qr_code_token ?? null,
      isDeleted: false,
    });

    let saved: Order;
    try {
      saved = await this.orderRepo.save(order);
    } catch (error) {
      this.handleDbError(error);
    }

    saved.product_quantity = await this.replaceOrderItems(saved.id, dto.items);
    try {
      await this.orderRepo.save(saved);
    } catch (error) {
      this.handleDbError(error);
    }

    const fullOrder = await this.findById(saved.id);
    void this.syncOrderToSearch(fullOrder);
    return fullOrder;
  }

  async findAll(query: {
    market_id?: string;
    customer_id?: string;
    customer_ids?: string[];
    post_id?: string;
    qr_code_token?: string;
    status?: Order_status;
    start_day?: string;
    end_day?: string;
    courier?: string;
    region_id?: string;
    page?: number;
    limit?: number;
  }) {
    const {
      market_id,
      customer_id,
      customer_ids,
      post_id,
      qr_code_token,
      status,
      start_day,
      end_day,
      courier,
      region_id,
      page = 1,
      limit = 10,
    } = query;

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
    if (qr_code_token) {
      qb.andWhere('order.qr_code_token = :qr_code_token', { qr_code_token });
    }
    if (status) {
      qb.andWhere('order.status = :status', { status });
    }
    if (region_id) {
      qb.andWhere('order.region_id = :region_id', { region_id });
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
      .skip((page - 1) * limit)
      .take(limit);

    let data: Order[];
    let total: number;
    try {
      [data, total] = await qb.getManyAndCount();
    } catch (error) {
      this.handleDbError(error);
    }

    return { data, total, page, limit };
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

  private generateCustomToken(length = 24): string {
    const chars = 'abcdef0123456789';
    let token = '';
    for (let i = 0; i < length; i += 1) {
      token += chars[Math.floor(Math.random() * chars.length)];
    }
    return token;
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
      for (const order of orders) {
        const postId = assignmentMap.get(order.id);
        await queryRunner.manager
          .createQueryBuilder()
          .update(Order)
          .set({
            status: Order_status.RECEIVED,
            post_id: postId ?? null,
          })
          .where('id = :id', { id: order.id })
          .execute();
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

    return { statusCode: 200, message: 'Orders received', data: {} };
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

  async update(
    id: string,
    dto: {
      market_id?: string;
      customer_id?: string;
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
      items?: Array<{ product_id: string; quantity?: number }>;
    },
  ) {
    return this.updateFull(id, dto);
  }

  async updateFull(
    id: string,
    dto: {
      market_id?: string;
      customer_id?: string;
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
      items?: Array<{ product_id: string; quantity?: number }>;
    },
  ) {
    const order = await this.findById(id);

    Object.assign(order, {
      market_id: dto.market_id ?? order.market_id,
      customer_id: dto.customer_id ?? order.customer_id,
      where_deliver: dto.where_deliver ?? order.where_deliver,
      total_price: dto.total_price ?? order.total_price,
      to_be_paid: dto.to_be_paid ?? order.to_be_paid,
      paid_amount: dto.paid_amount ?? order.paid_amount,
      status: dto.status ?? order.status,
      comment: dto.comment ?? order.comment,
      operator: dto.operator ?? order.operator,
      post_id: dto.post_id ?? order.post_id,
      district_id: dto.district_id ?? order.district_id,
      region_id: dto.region_id ?? order.region_id,
      address: dto.address ?? order.address,
      qr_code_token: dto.qr_code_token ?? order.qr_code_token,
    });

    if (dto.items) {
      order.product_quantity = await this.replaceOrderItems(order.id, dto.items);
    }

    // Prevent TypeORM cascade on stale one-to-many relation from nulling order_id.
    delete (order as Partial<Order> & { items?: OrderItem[] }).items;

    try {
      await this.orderRepo.save(order);
    } catch (error) {
      this.handleDbError(error);
    }

    const updated = await this.findById(order.id);
    void this.syncOrderToSearch(updated);
    return updated;
  }

  async remove(id: string) {
    const order = await this.findById(id);
    order.isDeleted = true;
    await this.orderRepo.save(order);
    void this.removeOrderFromSearch(id);
    return { message: `Order #${id} o'chirildi` };
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
    status?: Order_status;
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
        return { data: [], total: 0, page: query.page ?? 1, limit: query.limit ?? 10 };
      }
    }

    const result = await this.findAll({ ...orderQuery, customer_ids });
    const enriched = await this.enrichOrders(result.data);

    return {
      data: enriched,
      total: result.total,
      page: result.page,
      limit: result.limit,
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

  async findNewByMarketEnriched(market_id: string, page = 1, limit = 20) {
    const result = await this.findAll({ market_id, status: Order_status.NEW, page, limit });
    const enriched = await this.enrichOrders(result.data);
    return { data: enriched, total: result.total, page: result.page, limit: result.limit };
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
