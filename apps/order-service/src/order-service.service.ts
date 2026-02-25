import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { RpcException } from '@nestjs/microservices';
import { QueryFailedError, Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Order_status, Where_deliver } from '@app/common';

@Injectable()
export class OrderServiceService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepo: Repository<OrderItem>,
  ) {}

  private notFound(message: string): never {
    throw new RpcException({ statusCode: 404, message });
  }

  private handleDbError(error: unknown): never {
    if (error instanceof QueryFailedError) {
      const pgError = error.driverError as { code?: string };
      if (pgError?.code === '22P02') {
        throw new RpcException({ statusCode: 400, message: "ID format noto'g'ri" });
      }
    }
    throw error;
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

    const items = (dto.items ?? []).map((item) =>
      this.orderItemRepo.create({
        product_id: item.product_id,
        quantity: item.quantity ?? 1,
        order_id: saved.id,
      }),
    );

    if (items.length) {
      try {
        await this.orderItemRepo.save(items);
      } catch (error) {
        this.handleDbError(error);
      }
    }

    saved.product_quantity = items.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
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
    page?: number;
    limit?: number;
  }) {
    const { market_id, customer_id, status, page = 1, limit = 10 } = query;

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
      await this.orderItemRepo.delete({ order_id: order.id });
      const items = dto.items.map((item) =>
        this.orderItemRepo.create({
          product_id: item.product_id,
          quantity: item.quantity ?? 1,
          order_id: order.id,
        }),
      );
      if (items.length) {
        try {
          await this.orderItemRepo.save(items);
        } catch (error) {
          this.handleDbError(error);
        }
      }
      order.product_quantity = items.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
    }

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
