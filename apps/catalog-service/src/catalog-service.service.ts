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
  phone_number: string | null;
  status: string;
}

/**
 * 5hfCZgu5: identity qaytargan market obyekti mahsulot javobiga BUTUNLIGICHA
 * yopishtirilardi — telegram tokeni, ichki username, maosh, tariflar,
 * komissiya. Faqat oq ro'yxatdagi maydonlar qoladi (frontend faqat
 * `market.name` ni o'qiydi).
 */
function toMarketInfo(raw: unknown): MarketInfo | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const str = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return {
    id: str(row.id),
    name: str(row.name),
    phone_number: str(row.phone_number) || null,
    status: str(row.status),
  };
}

/**
 * Aws1oApe: mahsulot nomi normalizatsiyasi (BeePost product.service.ts
 * `normalizeName` dan farqli — registr SAQLANADI): chetdagi bo'shliqlar
 * olinadi, ichkisi bitta probelga qisqaradi. Registrga befarq taqqoslash
 * faqat tekshiruv/indeksda (`lower(...)`).
 */
export function normalizeProductName(raw: unknown): string {
  return typeof raw === 'string' || typeof raw === 'number'
    ? String(raw).trim().replace(/\s+/g, ' ')
    : '';
}

/** zRqDRLAZ: `numeric(14,2)` ning yuqori chegarasi. */
export const PRODUCT_PRICE_MAX = 999_999_999_999.99;

export type ProductWriteDto = {
  name?: string;
  image_url?: string | null;
  price?: number | string | null;
};

@Injectable()
export class CatalogServiceService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
    @Inject('SEARCH') private readonly searchClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    private readonly activityLog: ActivityLogService,
  ) {}

  private auditActor(requester?: { id?: string; roles?: string[] } | null): {
    user_id: string | null;
    user_role: string | null;
  } {
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

  private badRequest(message: string): never {
    throw new RpcException({ statusCode: 400, message });
  }

  /** Aws1oApe: bo'sh (faqat bo'shliqdan iborat) nom — 400. */
  private requireProductName(raw: unknown): string {
    const name = normalizeProductName(raw);
    if (!name) {
      this.badRequest("Mahsulot nomi bo'sh bo'lishi mumkin emas");
    }
    return name;
  }

  /**
   * zRqDRLAZ: narx — `undefined` (o'zgarmaydi), `null`/'' (tozalanadi) yoki
   * 0..PRODUCT_PRICE_MAX oralig'idagi, ko'pi bilan 2 kasrli son.
   */
  private normalizePrice(raw: unknown): number | null | undefined {
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    if (typeof raw === 'string' && !raw.trim()) return null;
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number(raw.trim())
          : NaN;
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > PRODUCT_PRICE_MAX ||
      Math.round(value * 100) / 100 !== value
    ) {
      this.badRequest(
        "Narx 0 dan katta yoki teng, ko'pi bilan 2 kasrli son bo'lishi kerak",
      );
    }
    return value;
  }

  /**
   * Aws1oApe: shu marketning FAOL mahsulotlari orasida registr va
   * bo'shliqlarga befarq bir xil nomli mahsulot bormi. DB indeksi
   * (`IDX_products_lower_name_user_id`, 117) poygani ham ushlaydi; bu
   * tekshiruv indeks yaratilmay qolgan (prod'dagi eski dublikatlar) holatda
   * ham yangi dublikatni to'xtatadi va tushunarli xabar beradi.
   */
  private async ensureNameAvailable(
    userId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    let existing: Pick<Product, 'id' | 'name'> | null;
    try {
      const qb = this.productRepo
        .createQueryBuilder('product')
        .select(['product.id', 'product.name'])
        .where('product.user_id = :user_id', { user_id: userId })
        .andWhere('product.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere(
          "lower(regexp_replace(btrim(product.name), '[[:space:]]+', ' ', 'g')) = lower(:name)",
          { name },
        );
      if (excludeId) {
        qb.andWhere('product.id <> :excludeId', { excludeId });
      }
      existing = await qb.getOne();
    } catch (error) {
      this.handleDbError(error);
    }
    if (existing) {
      this.conflict(
        `Bu marketda "${existing.name}" nomli mahsulot allaqachon mavjud (katta-kichik harf va bo'shliqlar farqi hisobga olinmaydi)`,
      );
    }
  }

  /**
   * update/updateOwn uchun umumiy: faqat ruxsat etilgan maydonlar (name,
   * image_url, price). Nom o'zgarsagina dublikat tekshiriladi — eski
   * (indeksgacha) dublikatlarda rasm/narx tahriri bloklanmasin.
   */
  private async applyProductChanges(
    product: Product,
    dto: ProductWriteDto,
  ): Promise<void> {
    if (dto?.name !== undefined) {
      const name = this.requireProductName(dto.name);
      if (name !== product.name) {
        await this.ensureNameAvailable(product.user_id, name, product.id);
      }
      product.name = name;
    }
    if (dto?.image_url !== undefined) {
      product.image_url = dto.image_url;
    }
    const price = this.normalizePrice(dto?.price);
    if (price !== undefined) {
      product.price = price;
    }
  }

  private auditSnapshot(product: Product): {
    name: string;
    image_url: string | null;
    price: number | null;
  } {
    return {
      name: product.name,
      image_url: product.image_url ?? null,
      price: product.price ?? null,
    };
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
        throw new RpcException({
          statusCode: 400,
          message: 'ID format noto‘g‘ri',
        });
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
        this.searchClient
          .send(
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
          )
          .pipe(timeout(1500)),
      );
    } catch {
      // Search index sync should not block product flows.
    }
  }

  private async removeProductFromSearch(id: string) {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.remove' },
            { source: 'catalog', type: 'product', sourceId: id },
          )
          .pipe(timeout(1500)),
      );
    } catch {
      // Search index sync should not block product flows.
    }
  }

  private async attachMarket(
    product: Product,
  ): Promise<Product & { market: MarketInfo | null }> {
    try {
      const result = await lastValueFrom(
        this.identityClient
          .send({ cmd: 'identity.market.find_by_id' }, { id: product.user_id })
          .pipe(timeout(3000)),
      );

      return {
        ...product,
        market: toMarketInfo(result?.data),
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

      if (Array.isArray(result?.data)) {
        byId = new Map(
          (result.data as unknown[])
            .map((m) => toMarketInfo(m))
            .filter((m): m is MarketInfo => m !== null)
            .map((m) => [m.id, m]),
        );
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

  async create(dto: {
    name: string;
    user_id: string;
    image_url?: string | null;
    price?: number | string | null;
  }) {
    // Aws1oApe: nom normalizatsiyasi (registr saqlanadi) va registrga befarq
    // dublikat tekshiruvi; bo'sh nom / noto'g'ri narx — market so'rovidan
    // OLDIN 400.
    const name = this.requireProductName(dto?.name);
    const price = this.normalizePrice(dto?.price);
    await this.ensureMarketExists(dto.user_id);
    await this.ensureNameAvailable(String(dto.user_id), name);

    const product = this.productRepo.create({
      name,
      user_id: dto.user_id,
      image_url: dto.image_url ?? null,
      price: price ?? null,
    });
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
      new_value: this.auditSnapshot(saved),
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

  async update(id: string, dto: ProductWriteDto) {
    const product = await this.findByIdEntity(id);
    const before = this.auditSnapshot(product);
    await this.applyProductChanges(product, dto);
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
      new_value: this.auditSnapshot(saved),
      action: ActivityAction.UPDATED,
      metadata: { user_id: saved.user_id },
    });

    return this.findById(saved.id);
  }

  async updateOwn(
    id: string,
    userId: string,
    dto: ProductWriteDto,
    // tsEevElW: market operatori tahrirlasa — aktyor operatorning o'zi.
    actor?: { id?: string; role?: string } | null,
  ) {
    const product = await this.findByIdEntity(id);
    if (!userId || product.user_id !== String(userId)) {
      this.forbidden('You can update only your own product');
    }

    const before = this.auditSnapshot(product);
    await this.applyProductChanges(product, dto);
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
      new_value: this.auditSnapshot(saved),
      action: ActivityAction.UPDATED,
      // The market updating its OWN product IS the actor (tsEevElW: yoki
      // shu marketning operatori).
      user_id: actor?.id ? String(actor.id) : String(userId),
      user_role: actor?.role ? String(actor.role) : 'market',
      metadata: { user_id: saved.user_id },
    });

    return this.findById(saved.id);
  }

  async remove(id: string, requester?: { id: string; roles: string[] }) {
    const product = await this.findByIdEntity(id);

    if (
      requester?.roles?.includes('market') &&
      product.user_id !== requester.id
    ) {
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
