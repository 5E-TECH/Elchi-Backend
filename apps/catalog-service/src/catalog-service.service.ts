import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { lastValueFrom, timeout } from 'rxjs';
import { In, QueryFailedError, Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { successRes } from '../../../libs/common/helpers/response';
import {
  ActivityAction,
  ActivityLogService,
  ActivityLogQuery,
} from '@app/common';

interface MarketInfo {
  id: string;
  name: string;
  role: string;
  status: string;
}

@Injectable()
export class CatalogServiceService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
    @Inject('SEARCH') private readonly searchClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    private readonly activityLog: ActivityLogService,
  ) {}

  private auditActor(
    requester?: { id?: string; roles?: string[] } | null,
  ): { user_id: string | null; user_role: string | null } {
    const roles = requester?.roles ?? [];
    return {
      user_id: requester?.id ? String(requester.id) : null,
      user_role: roles.length ? roles.join(',') : null,
    };
  }

  private notFound(message: string): never {
    throw new RpcException({ statusCode: 404, message });
  }

  private forbidden(message: string): never {
    throw new RpcException({ statusCode: 403, message });
  }

  private conflict(message: string): never {
    throw new RpcException({ statusCode: 409, message });
  }

  private async ensureMarketExists(marketId: string): Promise<void> {
    try {
      const result = await lastValueFrom(
        this.identityClient
          .send({ cmd: 'identity.market.find_by_id' }, { id: marketId })
          .pipe(timeout(5000)),
      );

      if (!result?.success) {
        this.notFound(`Market #${marketId} topilmadi yoki faol emas`);
      }
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }
      const rpcError = error as { statusCode?: number; message?: string };
      if (rpcError?.statusCode === 404) {
        this.notFound(`Market #${marketId} topilmadi yoki faol emas`);
      }
      throw new RpcException({
        statusCode: 502,
        message: 'Identity servisiga ulanishda xatolik',
      });
    }
  }

  private handleDbError(error: unknown): never {
    if (error instanceof QueryFailedError) {
      const pgError = error.driverError as { code?: string };
      if (pgError?.code === '22P02') {
        throw new RpcException({ statusCode: 400, message: 'ID format noto‘g‘ri' });
      }
      if (pgError?.code === '23505') {
        this.conflict('Bu marketda bu nomdagi product allaqachon mavjud');
      }
    }
    throw error;
  }

  private async syncProductToSearch(product: Product) {
    try {
      await lastValueFrom(
        this.searchClient.send(
          { cmd: 'search.index.upsert' },
          {
            source: 'catalog',
            type: 'product',
            sourceId: product.id,
            title: product.name,
            content: product.user_id,
            tags: ['product'],
            metadata: {
              user_id: product.user_id,
              image_url: product.image_url,
            },
          },
        ).pipe(timeout(1500)),
      );
    } catch {
      // Search index sync should not block product flows.
    }
  }

  private async removeProductFromSearch(id: string) {
    try {
      await lastValueFrom(
        this.searchClient.send(
          { cmd: 'search.index.remove' },
          { source: 'catalog', type: 'product', sourceId: id },
        ).pipe(timeout(1500)),
      );
    } catch {
      // Search index sync should not block product flows.
    }
  }

  private async attachMarket(product: Product): Promise<Product & { market: MarketInfo | null }> {
    try {
      const result = await lastValueFrom(
        this.identityClient
          .send({ cmd: 'identity.market.find_by_id' }, { id: product.user_id })
          .pipe(timeout(3000)),
      );

      return {
        ...product,
        market: result?.data ?? null,
      };
    } catch {
      return { ...product, market: null };
    }
  }

  private async attachMarkets(
    products: Product[],
  ): Promise<Array<Product & { market: MarketInfo | null }>> {
    if (products.length === 0) {
      return [];
    }

    const marketIds = [...new Set(products.map((p) => p.user_id))];

    let byId = new Map<string, MarketInfo>();
    try {
      const result = await lastValueFrom(
        this.identityClient
          .send({ cmd: 'identity.market.find_by_ids' }, { ids: marketIds })
          .pipe(timeout(5000)),
      );

      if (result?.data) {
        byId = new Map(result.data.map((m: MarketInfo) => [m.id, m]));
      }
    } catch {
      // Market ma'lumotlari olinmasa, null qo'yiladi
    }

    return products.map((product) => ({
      ...product,
      market: byId.get(product.user_id) ?? null,
    }));
  }

  private async findByIdEntity(id: string): Promise<Product> {
    let product: Product | null;
    try {
      product = await this.productRepo.findOne({
        where: { id, isDeleted: false },
      });
    } catch (error) {
      this.handleDbError(error);
    }

    if (!product) {
      this.notFound(`Product #${id} topilmadi`);
    }

    return product;
  }

  async create(dto: { name: string; user_id: string; image_url?: string }) {
    await this.ensureMarketExists(dto.user_id);

    const product = this.productRepo.create(dto);
    let saved: Product;
    try {
      saved = await this.productRepo.save(product);
    } catch (error) {
      this.handleDbError(error);
    }

    void this.syncProductToSearch(saved);

    void this.activityLog.log({
      entity_type: 'Product',
      entity_id: saved.id,
      action: ActivityAction.CREATED,
      new_value: { name: saved.name, image_url: saved.image_url },
      metadata: { user_id: saved.user_id },
    });

    return this.findById(saved.id);
  }

  async findAll(query: {
    user_id?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const { user_id, search, page = 1, limit = 10 } = query;

    const qb = this.productRepo
      .createQueryBuilder('product')
      .where('product.isDeleted = :isDeleted', { isDeleted: false });

    if (user_id) {
      qb.andWhere('product.user_id = :user_id', { user_id });
    }

    if (search) {
      qb.andWhere('product.name ILIKE :search', { search: `%${search}%` });
    }

    qb.orderBy('product.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    let data: Product[];
    let total: number;
    try {
      [data, total] = await qb.getManyAndCount();
    } catch (error) {
      this.handleDbError(error);
    }
    const enriched = await this.attachMarkets(data);
    return { data: enriched, total, page, limit };
  }

  async findById(id: string) {
    const product = await this.findByIdEntity(id);
    return this.attachMarket(product);
  }

  async update(
    id: string,
    dto: { name?: string; image_url?: string },
  ) {
    const product = await this.findByIdEntity(id);
    const before = { name: product.name, image_url: product.image_url };
    Object.assign(product, dto);
    let saved: Product;
    try {
      saved = await this.productRepo.save(product);
    } catch (error) {
      this.handleDbError(error);
    }

    void this.syncProductToSearch(saved);

    void this.activityLog.logChange({
      entity_type: 'Product',
      entity_id: saved.id,
      old_value: before,
      new_value: { name: saved.name, image_url: saved.image_url },
      action: ActivityAction.UPDATED,
      metadata: { user_id: saved.user_id },
    });

    return this.findById(saved.id);
  }

  async updateOwn(
    id: string,
    userId: string,
    dto: { name?: string; image_url?: string },
  ) {
    const product = await this.findByIdEntity(id);
    if (product.user_id !== userId) {
      this.forbidden('You can update only your own product');
    }

    const before = { name: product.name, image_url: product.image_url };
    Object.assign(product, dto);
    let saved: Product;
    try {
      saved = await this.productRepo.save(product);
    } catch (error) {
      this.handleDbError(error);
    }

    void this.syncProductToSearch(saved);

    void this.activityLog.logChange({
      entity_type: 'Product',
      entity_id: saved.id,
      old_value: before,
      new_value: { name: saved.name, image_url: saved.image_url },
      action: ActivityAction.UPDATED,
      // The market updating its OWN product IS the actor.
      user_id: String(userId),
      user_role: 'market',
      metadata: { user_id: saved.user_id },
    });

    return this.findById(saved.id);
  }

  async remove(id: string, requester?: { id: string; roles: string[] }) {
    const product = await this.findByIdEntity(id);

    if (requester?.roles?.includes('market') && product.user_id !== requester.id) {
      this.forbidden('You can delete only your own product');
    }

    product.isDeleted = true;
    await this.productRepo.save(product);
    void this.removeProductFromSearch(id);

    void this.activityLog.log({
      entity_type: 'Product',
      entity_id: product.id,
      action: ActivityAction.DELETED,
      old_value: { name: product.name },
      metadata: { user_id: product.user_id },
      ...this.auditActor(requester),
    });

    return successRes({}, 200, `Product #${id} o'chirildi`);
  }

  async findByIds(ids: string[]) {
    if (!ids.length) {
      return { data: [] };
    }
    const products = await this.productRepo.find({
      where: { id: In(ids), isDeleted: false },
    });
    return { data: products };
  }

  async removeByMarket(userId: string) {
    let products: Product[];
    try {
      products = await this.productRepo.find({
        where: { user_id: userId, isDeleted: false },
        select: ['id'],
      });
    } catch (error) {
      this.handleDbError(error);
    }

    if (products.length === 0) {
      return successRes({ count: 0 }, 200, 'No products to delete');
    }

    const ids = products.map((p) => p.id);

    try {
      await this.productRepo
        .createQueryBuilder()
        .update(Product)
        .set({ isDeleted: true })
        .where('user_id = :user_id', { user_id: userId })
        .andWhere('isDeleted = :isDeleted', { isDeleted: false })
        .execute();
    } catch (error) {
      this.handleDbError(error);
    }

    for (const id of ids) {
      void this.removeProductFromSearch(id);
    }

    void this.activityLog.log({
      entity_type: 'Product',
      entity_id: 'by_market',
      action: ActivityAction.DELETED,
      metadata: {
        user_id: userId,
        deleted_count: ids.length,
        order_ids: ids.slice(0, 10),
      },
    });

    return successRes({ count: ids.length }, 200, 'Products deleted');
  }

  async auditLogQuery(q: ActivityLogQuery) {
    return this.activityLog.query(q ?? {});
  }

  async auditLogByEntity(
    entity_type: string,
    entity_id: string,
    limit?: number,
  ) {
    return this.activityLog.findByEntity(entity_type, entity_id, limit ?? 50);
  }
}
