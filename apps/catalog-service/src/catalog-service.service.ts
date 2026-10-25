import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { lastValueFrom, timeout } from 'rxjs';
import { Brackets, In, QueryFailedError, Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { successRes } from '../../../libs/common/helpers/response';
import {
  ActivityAction,
  ActivityLogService,
  ActivityLogQuery,
  formatProductSkuCode,
  normalizeProductBarcode,
  parseProductSkuCode,
  productBarcodeEquivalents,
  productBarcodeLookupVariants,
  PRODUCT_BARCODE_MAX_LENGTH,
  PRODUCT_DIMENSION_CM_MAX,
  PRODUCT_DIMENSION_CM_MIN,
  PRODUCT_DIMENSION_FIELDS,
  PRODUCT_SKU_PREFIX,
  PRODUCT_WEIGHT_KG_DECIMALS,
  PRODUCT_WEIGHT_KG_MAX,
  ProductDimensionField,
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
  // MH-3 (9fHyFp3y): o'lchov — RMQ'dan son yoki raqamli satr kelishi mumkin.
  weight_kg?: number | string | null;
  length_cm?: number | string | null;
  width_cm?: number | string | null;
  height_cm?: number | string | null;
  volumetric_enabled?: boolean | string | null;
  // hY7uacJu: zavod shtrix kodi (satr; `null`/'' — tozalash).
  barcode?: string | null;
};

/**
 * `catalog.product.create` yuki. O'lchov servis darajasida IXTIYORIY: ichki
 * (hamkor) yo'l `{ name, user_id }` bilan yaratadi; HTTP'da majburiylik
 * gateway DTO'sida (MH-S1).
 */
export type ProductCreateDto = ProductWriteDto & {
  name: string;
  user_id: string;
};

/** `findByCode` javobidagi qatorlar soni chegarasi. */
export const PRODUCT_BY_CODE_LIMIT = 50;

/** `create` — berilmagan o'lchov NULL; `update` — `null`/'' (tozalash) 400. */
type MeasureMode = 'create' | 'update';

/** Satr — faqat o'nlik yozuv (`1e2`, `0x10` kabi Number() hiylalari emas). */
const DECIMAL_TEXT = /^\d+(?:\.\d+)?$/;

const PRODUCT_DIMENSION_LABELS: Record<ProductDimensionField, string> = {
  length_cm: 'Uzunlik (length_cm)',
  width_cm: 'Kenglik (width_cm)',
  height_cm: 'Balandlik (height_cm)',
};

/** MH-3: DB CHECK nomi (migratsiya 1716000000141) → tushunarli 400 xabari. */
const PRODUCT_CHECK_MESSAGES: Record<string, string> = {
  CHK_products_weight_kg_positive:
    "Og'irlik (weight_kg) 0 dan katta bo'lishi kerak",
  CHK_products_dimensions_positive:
    "O'lchamlar (length_cm, width_cm, height_cm) 0 dan katta bo'lishi kerak",
  CHK_products_dimensions_all_or_none:
    "Uzunlik, kenglik va balandlik (length_cm, width_cm, height_cm) birga kiritiladi — uchalasi ham bo'lishi kerak",
  CHK_products_barcode_not_blank: "Shtrix kod bo'sh bo'lishi mumkin emas",
};

type ProductAuditSnapshot = {
  name: string;
  image_url: string | null;
  price: number | null;
  weight_kg: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  volumetric_enabled: boolean;
  barcode: string | null;
  sku_code: string | null;
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
   * MH-3: o'lchov qiymati «berilmagan»mi. `create` da `null`/'' — berilmagan
   * (NULL / sukut); `update` da — 400: PATCH'da o'lchov faqat yangi qiymat
   * bilan almashtiriladi (MH-S1 — o'lchov bor mahsulot o'lchovsiz qolmaydi;
   * o'zgarmaydigan maydon umuman yuborilmaydi).
   */
  private isMeasureBlank(
    raw: unknown,
    field: string,
    mode: MeasureMode,
  ): boolean {
    if (raw !== null && !(typeof raw === 'string' && !raw.trim())) {
      return false;
    }
    if (mode === 'update') {
      this.badRequest(
        `${field} ni tozalab bo'lmaydi (PATCH'da o'lchov faqat yangi qiymat bilan almashtiriladi)`,
      );
    }
    return true;
  }

  /** RMQ'dan son yoki o'nlik satr — son; boshqasi — NaN. */
  private toMeasureNumber(raw: unknown): number {
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && DECIMAL_TEXT.test(raw.trim())) {
      return Number(raw.trim());
    }
    return NaN;
  }

  /** MH-3: og'irlik (kg) — `> 0`, ≤ PRODUCT_WEIGHT_KG_MAX, ko'pi bilan 3 kasr. */
  private normalizeWeightKg(
    raw: unknown,
    mode: MeasureMode,
  ): number | undefined {
    if (raw === undefined) return undefined;
    if (this.isMeasureBlank(raw, 'weight_kg', mode)) return undefined;
    const value = this.toMeasureNumber(raw);
    const scale = 10 ** PRODUCT_WEIGHT_KG_DECIMALS;
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      value > PRODUCT_WEIGHT_KG_MAX ||
      Math.round(value * scale) / scale !== value
    ) {
      this.badRequest(
        `Og'irlik (weight_kg) — 0 dan katta, ko'pi bilan ${PRODUCT_WEIGHT_KG_DECIMALS} kasrli son (kg), ${PRODUCT_WEIGHT_KG_MAX} kg gacha`,
      );
    }
    return value;
  }

  /** MH-3: o'lcham (sm) — butun son, PRODUCT_DIMENSION_CM_MIN..MAX. */
  private normalizeDimensionCm(
    raw: unknown,
    field: ProductDimensionField,
    mode: MeasureMode,
  ): number | undefined {
    if (raw === undefined) return undefined;
    if (this.isMeasureBlank(raw, field, mode)) return undefined;
    const value = this.toMeasureNumber(raw);
    if (
      !Number.isInteger(value) ||
      value < PRODUCT_DIMENSION_CM_MIN ||
      value > PRODUCT_DIMENSION_CM_MAX
    ) {
      this.badRequest(
        `${PRODUCT_DIMENSION_LABELS[field]} — ${PRODUCT_DIMENSION_CM_MIN} dan ${PRODUCT_DIMENSION_CM_MAX} gacha butun son (sm)`,
      );
    }
    return value;
  }

  /** MH-3: «hajmga qarab hisoblash» — true/false yoki 'true'/'false'. */
  private normalizeVolumetric(
    raw: unknown,
    mode: MeasureMode,
  ): boolean | undefined {
    if (raw === undefined) return undefined;
    if (this.isMeasureBlank(raw, 'volumetric_enabled', mode)) return undefined;
    if (typeof raw === 'boolean') return raw;
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (text === 'true') return true;
    if (text === 'false') return false;
    this.badRequest("volumetric_enabled — true yoki false bo'lishi kerak");
  }

  /** hY7uacJu: shtrix kod — `@app/common` qoidasi (EAN nazorat raqami va h.k.). */
  private normalizeBarcode(raw: unknown): string | null | undefined {
    const result = normalizeProductBarcode(raw);
    if (!result.ok) {
      this.badRequest(result.reason);
    }
    return result.value;
  }

  /**
   * MH-3: L/W/H — uchalasi yoki hech biri (narx dvigateli chala o'lchamni
   * ko'rmasin). DB CHECK (`CHK_products_dimensions_all_or_none`) ham
   * ushlaydi — bu tushunarli 400 xabari uchun.
   */
  private assertDimensionsComplete(
    row: Partial<Record<ProductDimensionField, number | null>>,
  ): void {
    const given = PRODUCT_DIMENSION_FIELDS.filter(
      (field) => row[field] !== null && row[field] !== undefined,
    ).length;
    if (given !== 0 && given !== PRODUCT_DIMENSION_FIELDS.length) {
      this.badRequest(
        "Uzunlik, kenglik va balandlik (length_cm, width_cm, height_cm) birga kiritiladi — uchalasi ham bo'lishi kerak",
      );
    }
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
   * hY7uacJu: market ichida bitta kod — bitta mahsulot (faqat FAOL qatorlar;
   * o'chirilgan mahsulot kodi qayta ishlatiladi). Kanonik qiymat bilan bir
   * qatorda UPC-E ↔ EAN-8 ikkiligidagi teng yozuv ham tekshiriladi
   * (`productBarcodeEquivalents`). Poygani DB indeksi
   * (`UQ_products_barcode_user_id`) ushlaydi — `handleDbError` xuddi shu
   * ma'noli 409 ga aylantiradi.
   */
  private async ensureBarcodeAvailable(
    userId: string,
    barcode: string,
    excludeId?: string,
  ): Promise<void> {
    let existing: Pick<Product, 'id' | 'name'> | null;
    try {
      const qb = this.productRepo
        .createQueryBuilder('product')
        .select(['product.id', 'product.name'])
        .where('product.user_id = :user_id', { user_id: userId })
        .andWhere('product.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('product.barcode IN (:...barcodes)', {
          barcodes: [barcode, ...productBarcodeEquivalents(barcode)],
        });
      if (excludeId) {
        qb.andWhere('product.id <> :excludeId', { excludeId });
      }
      existing = await qb.getOne();
    } catch (error) {
      this.handleDbError(error);
    }
    if (existing) {
      this.conflict(
        `Bu marketda shu shtrix kod "${existing.name}" mahsulotiga biriktirilgan`,
      );
    }
  }

  /**
   * update/updateOwn uchun umumiy: faqat ruxsat etilgan maydonlar (name,
   * image_url, price, o'lchov, barcode) ANIQ ro'yxat bilan ko'chiriladi —
   * `id`, `user_id`, `sku_code`, `isDeleted`, `createdAt` hech qachon.
   * Avval HAMMA qiymat tekshiriladi (400), keyin dublikatlar (409).
   * Nom/kod o'zgarsagina dublikat tekshiriladi — eski (indeksgacha)
   * dublikatlarda rasm/narx tahriri bloklanmasin.
   *
   * Xodim (`update`) va market / operator (`update_own`, egalik oldin
   * tekshiriladi) — BIR XIL ro'yxat: market yaratishda o'lchovni kiritishga
   * majbur (MH-S1), demak uni o'zi tuzata olishi ham kerak.
   */
  private async applyProductChanges(
    product: Product,
    dto: ProductWriteDto,
  ): Promise<void> {
    const name =
      dto?.name !== undefined ? this.requireProductName(dto.name) : undefined;
    const price = this.normalizePrice(dto?.price);
    const weightKg = this.normalizeWeightKg(dto?.weight_kg, 'update');
    const dimensions: Partial<Record<ProductDimensionField, number>> = {};
    for (const field of PRODUCT_DIMENSION_FIELDS) {
      const value = this.normalizeDimensionCm(dto?.[field], field, 'update');
      if (value !== undefined) dimensions[field] = value;
    }
    const volumetric = this.normalizeVolumetric(
      dto?.volumetric_enabled,
      'update',
    );
    const barcode = this.normalizeBarcode(dto?.barcode);
    this.assertDimensionsComplete({
      length_cm: dimensions.length_cm ?? product.length_cm,
      width_cm: dimensions.width_cm ?? product.width_cm,
      height_cm: dimensions.height_cm ?? product.height_cm,
    });

    if (name !== undefined && name !== product.name) {
      await this.ensureNameAvailable(product.user_id, name, product.id);
    }
    if (barcode && barcode !== product.barcode) {
      await this.ensureBarcodeAvailable(product.user_id, barcode, product.id);
    }

    if (name !== undefined) product.name = name;
    if (dto?.image_url !== undefined) product.image_url = dto.image_url;
    if (price !== undefined) product.price = price;
    if (weightKg !== undefined) product.weight_kg = weightKg;
    for (const field of PRODUCT_DIMENSION_FIELDS) {
      const value = dimensions[field];
      if (value !== undefined) product[field] = value;
    }
    if (volumetric !== undefined) product.volumetric_enabled = volumetric;
    if (barcode !== undefined) product.barcode = barcode;
  }

  /**
   * activity_log `old_value`/`new_value` — o'lchov va kodlar ham (MH-3:
   * «o'lchov o'zgarishi jurnalda ko'rinadi»).
   */
  private auditSnapshot(product: Product): ProductAuditSnapshot {
    return {
      name: product.name,
      image_url: product.image_url ?? null,
      price: product.price ?? null,
      weight_kg: product.weight_kg ?? null,
      length_cm: product.length_cm ?? null,
      width_cm: product.width_cm ?? null,
      height_cm: product.height_cm ?? null,
      volumetric_enabled: product.volumetric_enabled ?? true,
      barcode: product.barcode ?? null,
      sku_code: product.sku_code ?? null,
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
        // hY7uacJu: qaysi unique indeks — kod yoki nom (poyga holati).
        const constraint = (pgError as { constraint?: string }).constraint;
        if (constraint === 'UQ_products_barcode_user_id') {
          this.conflict(
            'Bu marketda shu shtrix kod boshqa mahsulotga biriktirilgan',
          );
        }
        if (constraint === 'UQ_products_sku_code') {
          this.conflict('Elchi mahsulot kodi (sku_code) takrorlandi');
        }
        this.conflict('Bu marketda bu nomdagi product allaqachon mavjud');
      }
      if (pgError?.code === '23514') {
        // MH-3: DB CHECK (migratsiya 141) — qaysi cheklov buzilgani.
        const constraint = (pgError as { constraint?: string }).constraint;
        this.badRequest(
          (constraint && PRODUCT_CHECK_MESSAGES[constraint]) ||
            "Mahsulot o'lchovi yoki shtrix kodi noto'g'ri",
        );
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
              // hY7uacJu: kodlar tags'ga QO'SHILMAYDI — global qidiruv
              // imtiyozsiz rollar uchun market bo'yicha cheklanmaydi
              // (`:q = ANY(tags)` begona market mahsulotini ochib qo'yardi).
              // Kod bo'yicha qidiruv — faqat market scoping'li `by-code`.
              tags: ['product'],
              // MH-3 / hY7uacJu: kodlar va o'lchov — faqat metadata'da
              // (search-service uni imtiyozsiz rollarga qaytarmaydi).
              metadata: {
                user_id: product.user_id,
                image_url: product.image_url,
                sku_code: product.sku_code ?? null,
                barcode: product.barcode ?? null,
                weight_kg: product.weight_kg ?? null,
                length_cm: product.length_cm ?? null,
                width_cm: product.width_cm ?? null,
                height_cm: product.height_cm ?? null,
                volumetric_enabled: product.volumetric_enabled ?? true,
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

  /**
   * Pc4CAFdB: HTTP'da mahsulot yaratish faqat xodimga (superadmin, admin,
   * registrator, menejer) — cheklov FAQAT api-gateway dekoratorida
   * (`PRODUCT_WRITE_ROLES`). Bu servis qatlami himoyalanmagan (requester
   * parametri yo'q): hamkor posilkasidan avtomatik mahsulot yaratish yo'li
   * (integration-service `createCatalogProduct`) shu RMQ'ni to'g'ridan-to'g'ri
   * chaqiradi va rol qoidasini CHETLAB O'TADI. Bu epikning 8-kartasida hal
   * qilinadi.
   */
  async create(dto: ProductCreateDto) {
    // Aws1oApe: nom normalizatsiyasi (registr saqlanadi) va registrga befarq
    // dublikat tekshiruvi; bo'sh nom / noto'g'ri narx / o'lchov / shtrix
    // kod — market so'rovidan OLDIN 400.
    const name = this.requireProductName(dto?.name);
    const price = this.normalizePrice(dto?.price);
    // MH-3: servis darajasida o'lchov IXTIYORIY — hamkor yo'li (6tGZzupr)
    // `{ name, user_id }` bilan yaratadi; HTTP'da majburiy (gateway DTO).
    const weightKg = this.normalizeWeightKg(dto?.weight_kg, 'create');
    const lengthCm = this.normalizeDimensionCm(
      dto?.length_cm,
      'length_cm',
      'create',
    );
    const widthCm = this.normalizeDimensionCm(
      dto?.width_cm,
      'width_cm',
      'create',
    );
    const heightCm = this.normalizeDimensionCm(
      dto?.height_cm,
      'height_cm',
      'create',
    );
    this.assertDimensionsComplete({
      length_cm: lengthCm,
      width_cm: widthCm,
      height_cm: heightCm,
    });
    const volumetric = this.normalizeVolumetric(
      dto?.volumetric_enabled,
      'create',
    );
    const barcode = this.normalizeBarcode(dto?.barcode);

    await this.ensureMarketExists(dto.user_id);
    await this.ensureNameAvailable(String(dto.user_id), name);
    if (barcode) {
      await this.ensureBarcodeAvailable(String(dto.user_id), barcode);
    }

    const product = this.productRepo.create({
      name,
      user_id: dto.user_id,
      image_url: dto.image_url ?? null,
      price: price ?? null,
      weight_kg: weightKg ?? null,
      length_cm: lengthCm ?? null,
      width_cm: widthCm ?? null,
      height_cm: heightCm ?? null,
      volumetric_enabled: volumetric ?? true,
      barcode: barcode ?? null,
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
      // hY7uacJu: nom bo'yicha qidiruvga qo'shimcha — aniq Elchi kodi
      // (`ELC-P-000123`) va zavod shtrix kodi (saqlashdagi bilan bir xil
      // kanonik GTIN: 12/13/14 xonali skan bitta qiymatga keladi).
      const skuId = parseProductSkuCode(search);
      const barcodes = productBarcodeLookupVariants(search);
      qb.andWhere(
        new Brackets((where) => {
          where.where('product.name ILIKE :search', {
            search: `%${search}%`,
          });
          if (skuId) {
            where.orWhere('product.sku_code = :skuCode', {
              skuCode: formatProductSkuCode(skuId),
            });
          }
          if (barcodes.length) {
            where.orWhere('product.barcode IN (:...barcodes)', { barcodes });
          }
        }),
      );
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

  /**
   * hY7uacJu: skaner kodi → mahsulot(lar). `ELC-P-…` — Elchi kodi
   * (`sku_code`), boshqasi — zavod shtrix kodi (`barcode`; skan saqlashdagi
   * bilan bir xil kanonik GTIN'ga keltiriladi — 12/13/14 xonali yozuv bitta
   * mahsulotni topadi). `userId` berilsa faqat shu marketniki.
   *
   * Topilmasa 404 EMAS — `{ data: [], total: 0, matched_by: null }`:
   * skanerda noma'lum kod oddiy holat (frontend «Mahsulotga bog'lash»
   * oqimi); begona market mahsuloti ham xuddi shunday ko'rinadi (mavjudligi
   * oshkor bo'lmaydi). Public — ombor moduli kirim skanerida qayta ishlatadi.
   */
  async findByCode(code: unknown, userId?: string | null) {
    const text =
      typeof code === 'string' || typeof code === 'number'
        ? String(code).trim()
        : '';
    if (!text) {
      this.badRequest("Kod bo'sh bo'lishi mumkin emas");
    }
    if (text.length > PRODUCT_BARCODE_MAX_LENGTH) {
      this.badRequest(
        `Kod ${PRODUCT_BARCODE_MAX_LENGTH} belgidan oshmasligi kerak`,
      );
    }

    let skuCode: string | null = null;
    if (text.toUpperCase().startsWith(PRODUCT_SKU_PREFIX)) {
      const id = parseProductSkuCode(text);
      if (!id) {
        this.badRequest("Elchi mahsulot kodi noto'g'ri — namuna: ELC-P-000123");
      }
      skuCode = formatProductSkuCode(id);
    }
    const matchedBy: 'sku_code' | 'barcode' = skuCode ? 'sku_code' : 'barcode';

    const qb = this.productRepo
      .createQueryBuilder('product')
      .where('product.isDeleted = :isDeleted', { isDeleted: false });
    if (skuCode) {
      qb.andWhere('product.sku_code = :skuCode', { skuCode });
    } else {
      qb.andWhere('product.barcode IN (:...barcodes)', {
        barcodes: productBarcodeLookupVariants(text),
      });
    }
    if (userId) {
      qb.andWhere('product.user_id = :user_id', { user_id: String(userId) });
    }
    qb.orderBy('product.id', 'ASC').take(PRODUCT_BY_CODE_LIMIT);

    let rows: Product[];
    let total: number;
    try {
      [rows, total] = await qb.getManyAndCount();
    } catch (error) {
      this.handleDbError(error);
    }
    const data = await this.attachMarkets(rows);
    return { data, total, matched_by: total ? matchedBy : null };
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
    // MH-3: egalik yuqorida tekshirildi — keyin xodim bilan bir xil ro'yxat
    // (o'lchov va shtrix kod ham; market yaratishda ularni kiritadi).
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
      old_value: {
        name: product.name,
        sku_code: product.sku_code ?? null,
        barcode: product.barcode ?? null,
      },
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
