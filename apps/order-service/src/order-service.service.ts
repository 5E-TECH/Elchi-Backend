import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { RpcException } from '@nestjs/microservices';
import { Brackets, DataSource, QueryFailedError, Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Order_status, Post_status, Roles, Where_deliver } from '@app/common';

@Injectable()
export class OrderServiceService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepo: Repository<OrderItem>,
  ) {}

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
      deleted: false,
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

    return this.findById(saved.id);
  }

  async findAll(query: {
    market_id?: string;
    customer_id?: string;
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
      .where('order.deleted = :deleted', { deleted: false });

    if (market_id) {
      qb.andWhere('order.market_id = :market_id', { market_id });
    }
    if (customer_id) {
      qb.andWhere('order.customer_id = :customer_id', { customer_id });
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

  async findTodayMarkets() {
    const qb = this.orderRepo
      .createQueryBuilder('order')
      .select('order.market_id', 'market_id')
      .addSelect('COUNT(order.id)', 'orders_count')
      .addSelect('COALESCE(SUM(order.total_price), 0)', 'total_price_sum')
      .where('order.deleted = :deleted', { deleted: false })
      .andWhere('order.createdAt >= CURRENT_DATE')
      .andWhere(`order.createdAt < (CURRENT_DATE + INTERVAL '1 day')`)
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

  async findNewMarkets() {
    const qb = this.orderRepo
      .createQueryBuilder('order')
      .select('order.market_id', 'market_id')
      .addSelect('COUNT(order.id)', 'orders_count')
      .addSelect('COALESCE(SUM(order.total_price), 0)', 'total_price_sum')
      .where('order.deleted = :deleted', { deleted: false })
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

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const qb = queryRunner.manager
        .createQueryBuilder(Order, 'order')
        .leftJoin(
          'identity_schema.admins',
          'customer',
          'customer.id::text = order.customer_id::text AND customer.role = :customerRole AND customer.is_deleted = false',
          { customerRole: Roles.CUSTOMER },
        )
        .leftJoin(
          'logistics_schema.districts',
          'district',
          'district.id::text = COALESCE(customer.district_id::text, order.district_id::text)',
        )
        .where('order.id IN (:...orderIds)', { orderIds: uniqueOrderIds })
        .andWhere('order.deleted = :deleted', { deleted: false })
        .andWhere('order.status = :status', { status: Order_status.NEW })
        .select('order.id', 'order_id')
        .addSelect('order.total_price', 'order_total_price')
        .addSelect('order.customer_id', 'order_customer_id')
        .addSelect('district.assigned_region', 'assigned_region')
        .addSelect('customer.id', 'customer_id')
        .addSelect('customer.name', 'customer_name')
        .addSelect('customer.phone_number', 'customer_phone');

      if (search?.trim()) {
        const searchValue = `%${search.trim()}%`;
        qb.andWhere(
          new Brackets((q) => {
            q.where('customer.name ILIKE :search', { search: searchValue }).orWhere(
              'customer.phone_number ILIKE :search',
              { search: searchValue },
            );
          }),
        );
      }

      const rows = await qb.getRawMany<{
        order_id: string;
        order_total_price: string;
        order_customer_id: string | null;
        assigned_region: string | null;
        customer_id: string | null;
      }>();

      if (!rows.length) {
        this.notFound('No orders found!');
      }

      if (rows.length !== uniqueOrderIds.length) {
        this.badRequest('Some orders are not found or not in NEW status');
      }

      const regionIds = Array.from(
        new Set(
          rows.map((row) => row.assigned_region).filter((regionId): regionId is string => Boolean(regionId)),
        ),
      );

      for (const row of rows) {
        if (!row.customer_id) {
          this.notFound(`Customer not found for order #${row.order_id}`);
        }
        if (!row.assigned_region) {
          this.notFound(`District/assigned region not found for order #${row.order_id}`);
        }
      }

      const postsByRegion = new Map<string, { id: string }>();

      if (regionIds.length) {
        const existingPosts = await queryRunner.manager.query(
          `SELECT id::text AS id, region_id::text AS region_id
           FROM logistics_schema.posts
           WHERE status = $1 AND region_id::text = ANY($2)
           FOR UPDATE`,
          [Post_status.NEW, regionIds],
        );

        for (const post of existingPosts as Array<{ id: string; region_id: string }>) {
          if (!postsByRegion.has(post.region_id)) {
            postsByRegion.set(post.region_id, { id: post.id });
          }
        }
      }

      for (const regionId of regionIds) {
        if (postsByRegion.has(regionId)) {
          continue;
        }

        const createdPostRows = await queryRunner.manager.query(
          `INSERT INTO logistics_schema.posts
             ("createdAt", "updatedAt", courier_id, post_total_price, order_quantity, qr_code_token, region_id, status)
           VALUES
             (NOW(), NOW(), $1, 0, 0, $2, $3, $4)
           RETURNING id::text AS id, region_id::text AS region_id`,
          ['0', this.generateCustomToken(), regionId, Post_status.NEW],
        );

        const createdPost = createdPostRows?.[0] as { id: string; region_id: string } | undefined;
        if (!createdPost) {
          throw new RpcException({ statusCode: 500, message: 'Post create failed' });
        }
        postsByRegion.set(regionId, { id: createdPost.id });
      }

      const postAggregates = new Map<string, { totalPrice: number; quantity: number }>();

      for (const row of rows) {
        const post = postsByRegion.get(row.assigned_region!);
        if (!post) {
          throw new RpcException({ statusCode: 500, message: 'Post not resolved' });
        }

        await queryRunner.manager
          .createQueryBuilder()
          .update(Order)
          .set({
            status: Order_status.RECEIVED,
            post_id: post.id,
          })
          .where('id = :id', { id: row.order_id })
          .execute();

        const agg = postAggregates.get(post.id) ?? { totalPrice: 0, quantity: 0 };
        agg.totalPrice += Number(row.order_total_price ?? 0);
        agg.quantity += 1;
        postAggregates.set(post.id, agg);
      }

      for (const [postId, agg] of postAggregates.entries()) {
        await queryRunner.manager.query(
          `UPDATE logistics_schema.posts
           SET post_total_price = post_total_price + $1,
               order_quantity = order_quantity + $2,
               "updatedAt" = NOW()
           WHERE id::text = $3`,
          [agg.totalPrice, agg.quantity, postId],
        );
      }

      await queryRunner.commitTransaction();
      return { statusCode: 200, message: 'Orders received', data: {} };
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
  }

  async findById(id: string) {
    let order: Order | null;
    try {
      order = await this.orderRepo.findOne({
        where: { id, deleted: false },
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

    return this.findById(order.id);
  }

  async remove(id: string) {
    const order = await this.findById(id);
    order.deleted = true;
    await this.orderRepo.save(order);
    return { message: `Order #${id} o'chirildi` };
  }
}
