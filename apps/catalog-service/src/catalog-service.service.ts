import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { lastValueFrom } from 'rxjs';
import { QueryFailedError, Repository } from 'typeorm';
import { Product } from './entities/product.entity';

@Injectable()
export class CatalogServiceService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
    @Inject('SEARCH') private readonly searchClient: ClientProxy,
  ) {}

  private notFound(message: string): never {
    throw new RpcException({ statusCode: 404, message });
  }

  private forbidden(message: string): never {
    throw new RpcException({ statusCode: 403, message });
  }

  private conflict(message: string): never {
    throw new RpcException({ statusCode: 409, message });
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
        ),
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
        ),
      );
    } catch {
      // Search index sync should not block product flows.
    }
  }

  async create(dto: { name: string; user_id: string; image_url?: string }) {
    const product = this.productRepo.create(dto);
    let saved: Product;
    try {
      saved = await this.productRepo.save(product);
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const pgError = error.driverError as { code?: string };
        if (pgError?.code === '23505') {
          this.conflict('Bu marketda bu nomdagi product allaqachon mavjud');
        }
      }
      throw error;
    }

    await this.syncProductToSearch(saved);
    return saved;
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

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async findById(id: string) {
    const product = await this.productRepo.findOne({
      where: { id, isDeleted: false },
    });
    if (!product) {
      this.notFound(`Product #${id} topilmadi`);
    }
    return product;
  }

  async update(
    id: string,
    dto: { name?: string; image_url?: string },
  ) {
    const product = await this.findById(id);
    Object.assign(product, dto);
    let saved: Product;
    try {
      saved = await this.productRepo.save(product);
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const pgError = error.driverError as { code?: string };
        if (pgError?.code === '23505') {
          this.conflict('Bu marketda bu nomdagi product allaqachon mavjud');
        }
      }
      throw error;
    }

    await this.syncProductToSearch(saved);
    return saved;
  }

  async updateOwn(
    id: string,
    userId: string,
    dto: { name?: string; image_url?: string },
  ) {
    const product = await this.findById(id);
    if (product.user_id !== userId) {
      this.forbidden('You can update only your own product');
    }

    Object.assign(product, dto);
    let saved: Product;
    try {
      saved = await this.productRepo.save(product);
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const pgError = error.driverError as { code?: string };
        if (pgError?.code === '23505') {
          this.conflict('Bu marketda bu nomdagi product allaqachon mavjud');
        }
      }
      throw error;
    }

    await this.syncProductToSearch(saved);
    return saved;
  }

  async remove(id: string, requester?: { id: string; roles: string[] }) {
    const product = await this.findById(id);

    if (requester?.roles?.includes('market') && product.user_id !== requester.id) {
      this.forbidden('You can delete only your own product');
    }

    product.isDeleted = true;
    await this.productRepo.save(product);
    await this.removeProductFromSearch(id);
    return { message: `Product #${id} o'chirildi` };
  }
}
