import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './entities/product.entity';

@Injectable()
export class CatalogServiceService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
  ) {}

  async create(dto: { name: string; user_id: string; image_url?: string }) {
    const product = this.productRepo.create(dto);
    return this.productRepo.save(product);
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
      throw new NotFoundException(`Product #${id} topilmadi`);
    }
    return product;
  }

  async update(
    id: string,
    dto: { name?: string; image_url?: string },
  ) {
    const product = await this.findById(id);
    Object.assign(product, dto);
    return this.productRepo.save(product);
  }

  async remove(id: string) {
    const product = await this.findById(id);
    product.isDeleted = true;
    await this.productRepo.save(product);
    return { message: `Product #${id} o'chirildi` };
  }
}
