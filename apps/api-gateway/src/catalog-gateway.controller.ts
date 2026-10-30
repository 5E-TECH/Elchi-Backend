import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, map, TimeoutError, timeout } from 'rxjs';
import { projectOrderContactsForRoles } from './auth/order-contact-projection';
import { PRODUCT_BARCODE_MAX_LENGTH, Roles as RoleEnum } from '@app/common';
import {
  ApiBody,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Public } from './auth/public.decorator';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreateProductRequestDto,
  ProductByCodeResponseDto,
  UpdateProductRequestDto,
} from './dto/catalog.swagger.dto';
import { matchesDeclaredType } from '@app/common';

interface JwtUser {
  sub: string;
  roles?: string[];
}

interface HttpRequestLike {
  protocol?: string;
  get?(name: string): string | undefined;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Mahsulot ro'yxati / bitta mahsulot — o'qish rollari (fix3 C11, CODE-08).
 * Ilgari faqat JwtAuthGuard edi: kuryer, mijoz, investor ham barcha
 * marketlar mahsulotlarini market profili (telefon, tarif) bilan olardi.
 * Filial xodimlari `product/market/:marketId` bilan bir xil ro'yxatni
 * allaqachon o'qiydi — ular saqlanadi; market faqat o'zinikini.
 */
const PRODUCT_READ_ROLES: string[] = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.REGISTRATOR,
  RoleEnum.MANAGER,
  RoleEnum.BRANCH,
  RoleEnum.MARKET,
];

/**
 * tsEevElW: bitta mahsulot (GET /product/:id) — market operatori ham o'qiydi
 * (frontend tahrirlash oynasi shu marshrutdan o'qiydi), lekin FAQAT o'zi
 * biriktirilgan marketning mahsulotini (`findById` dagi egalik tekshiruvi).
 * Umumiy ro'yxat (GET /product) operatorga OCHILMAYDI — u `my-products` dan.
 */
const PRODUCT_DETAIL_ROLES: string[] = [
  ...PRODUCT_READ_ROLES,
  RoleEnum.MARKET_OPERATOR,
];

/**
 * Pc4CAFdB (ega qarori 2026-10-15): mahsulot YARATISH va O'CHIRISH — faqat
 * Elchi xodimi. Market va market operatori chiqarildi (ular ro'yxatni
 * o'qiydi va buyurtma yaratadi — PRODUCT_READ_ROLES / buyurtma rollari
 * tegilmaydi), BRANCH qo'shilmaydi.
 *
 * 6tGZzupr: servis qatlami `catalog.product.create` requester oladi — market
 * rollari u yerda ham rad etiladi; hamkor posilkasidan avtomatik yaratish
 * yo'li gateway'dan o'tmaydi va ATAYLAB `system` deb belgilanadi (jurnalda
 * ko'rinadi).
 */
export const PRODUCT_WRITE_ROLES: string[] = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.REGISTRATOR,
  RoleEnum.MANAGER,
];

/**
 * 3qDsJpfW: HTTP ro'yxatlarida `limit` ning yuqori chegarasi — order-service
 * AI katalog yuklashi (`CATALOG_LOAD_LIMIT = 500`) bilan bir xil. Berilmasa
 * catalog-service sukuti (`page = 1`, `limit = 10`) qoladi.
 */
export const PRODUCT_LIST_MAX_LIMIT = 500;

/** Musbat butun son yoki `undefined` (bo'sh / noto'g'ri qiymat — sukut). */
const toPositiveInt = (value?: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

/**
 * 3qDsJpfW: `catalog.product.find_all` so'rovi — GET /product, GET
 * /product/my-products va GET /product/market/:marketId UCHALASI shu
 * yerdan quriladi. Ilgari my-products va market/:marketId search/page/limit
 * ni umuman uzatmasdi: server sukuti `limit = 10` bilan 11-mahsulot hech
 * qachon ko'rinmasdi va qidiruv ishlamasdi.
 */
export function buildProductListQuery(
  userId: string | undefined,
  search?: string,
  page?: string,
  limit?: string,
  sortBy?: string,
  sortDir?: string,
  needsMeasurement?: string,
): {
  user_id: string | undefined;
  search: string | undefined;
  page: number | undefined;
  limit: number | undefined;
  sort_by?: ProductSortBy;
  sort_dir?: 'asc' | 'desc';
  needs_measurement?: boolean;
} {
  const parsedLimit = toPositiveInt(limit);
  const trimmedSearch = typeof search === 'string' ? search.trim() : '';
  const sort = parseProductSort(sortBy, sortDir);
  const measurement = parseNeedsMeasurement(needsMeasurement);
  return {
    user_id: userId,
    search: trimmedSearch || undefined,
    page: toPositiveInt(page),
    limit:
      parsedLimit === undefined
        ? undefined
        : Math.min(parsedLimit, PRODUCT_LIST_MAX_LIMIT),
    ...sort,
    ...(measurement === undefined ? {} : { needs_measurement: measurement }),
  };
}

/** 6tGZzupr: «o'lchov kutilmoqda» filtri; noto'g'ri qiymat — 400. */
function parseNeedsMeasurement(raw?: string): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = String(raw).trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new BadRequestException(
    "needs_measurement — true yoki false bo'lishi kerak",
  );
}

/** j4kTqiSQ: GET product* saralash — FAQAT shu ro'yxat (SQL'ga xom kirmaydi). */
export const PRODUCT_SORT_FIELDS = ['name', 'created_at', 'price'] as const;
export type ProductSortBy = (typeof PRODUCT_SORT_FIELDS)[number];

/**
 * j4kTqiSQ: `sort_by` / `sort_dir` — ro'yxatdan tashqari qiymat 400.
 * Berilmasa — eski tartib (yangisi tepada).
 */
export function parseProductSort(
  sortBy?: string,
  sortDir?: string,
): { sort_by?: ProductSortBy; sort_dir?: 'asc' | 'desc' } {
  const by = typeof sortBy === 'string' ? sortBy.trim().toLowerCase() : '';
  const dir = typeof sortDir === 'string' ? sortDir.trim().toLowerCase() : '';
  const out: { sort_by?: ProductSortBy; sort_dir?: 'asc' | 'desc' } = {};
  if (by) {
    if (!(PRODUCT_SORT_FIELDS as readonly string[]).includes(by)) {
      throw new BadRequestException(
        `sort_by faqat: ${PRODUCT_SORT_FIELDS.join(', ')}`,
      );
    }
    out.sort_by = by as ProductSortBy;
  }
  if (dir) {
    if (dir !== 'asc' && dir !== 'desc') {
      throw new BadRequestException('sort_dir faqat: asc, desc');
    }
    out.sort_dir = dir;
  }
  return out;
}

/**
 * j4kTqiSQ: PATCH /product/:id da rasmni O'CHIRISH so'rovi. JSON:
 * `image: null` yoki `image_url: null` / `''`; multipart (null yubora
 * olmaydi): `image=null` (FormData null'ni shunday yozadi), `image_url=''`
 * yoki `remove_image=true`. Yangi fayl yuklangan bo'lsa — fayl ustun.
 */
export function wantsProductImageRemoval(dto: {
  image?: unknown;
  image_url?: unknown;
  remove_image?: unknown;
}): boolean {
  if (dto.image === null || dto.image === 'null') return true;
  if (dto.image_url === null || dto.image_url === '') return true;
  const flag = dto.remove_image;
  return flag === true || flag === 'true' || flag === '1' || flag === 1;
}

/** ugoDD9TT: rasm turi → fayl kengaytmasi. */
const IMAGE_EXTENSIONS: Record<string, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/jpg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
};

/**
 * ugoDD9TT: yuklangan rasm nomi kengaytmasi haqiqiy turga mos bo'lsin —
 * `image_url` (kalit nomidan) masalan `.png` bilan tugaydi. Nom allaqachon
 * mos kengaytmada bo'lsa o'zgarmaydi; aks holda mos kengaytma qo'shiladi.
 */
export function productImageFileName(
  originalName: string | undefined,
  mimeType: string,
): string {
  const allowed = IMAGE_EXTENSIONS[mimeType] ?? [];
  const name = String(originalName ?? '').trim() || 'image';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!allowed.length || allowed.includes(ext)) {
    return name;
  }
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.${allowed[0]}`;
}

@ApiTags('Products')
@Controller('product')
export class CatalogGatewayController {
  /**
   * ugoDD9TT: mahsulot RASMI uchun tor ro'yxat. Ilgari hujjat endpointidan
   * ko'chirilgan ro'yxat (PDF, XLSX) ishlatilardi — PDF "rasm" sifatida 201
   * bilan saqlanib, ekranda jim buzilgan rasm bo'lib qolardi.
   */
  private readonly allowedImageMime = new Set<string>([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
  ]);

  constructor(
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
    @Inject('FILE') private readonly fileClient: ClientProxy,
    // tsEevElW: market operatorining biriktirilgan marketi (`user.market_id`).
    @Inject('IDENTITY') private readonly identityClient?: ClientProxy,
  ) {}

  private hasRole(user: JwtUser | undefined, role: string): boolean {
    return (user?.roles ?? []).some(
      (item) =>
        String(item ?? '')
          .trim()
          .toLowerCase() === role,
    );
  }

  /**
   * tsEevElW: so'rovchi MARKET_OPERATOR (market/admin/superadmin emas) —
   * katalogda o'zi biriktirilgan market nomidan ishlaydi.
   */
  private isMarketOperatorRequester(user?: JwtUser): boolean {
    return (
      this.hasRole(user, RoleEnum.MARKET_OPERATOR) &&
      !this.hasRole(user, RoleEnum.MARKET) &&
      !this.hasRole(user, RoleEnum.SUPERADMIN) &&
      !this.hasRole(user, RoleEnum.ADMIN)
    );
  }

  /**
   * tsEevElW: market operatori biriktirilgan market id'si — identity
   * `user.market_id` (order-gateway `resolveMarketOperatorMarketId` bilan bir
   * xil manba; BeePost product.service.ts:66-74). Topilmasa yoki identity
   * javob bermasa — '' (chaqiruvchi rad etadi, fail-closed).
   */
  private async resolveOperatorMarketId(user: JwtUser): Promise<string> {
    if (!this.identityClient) {
      return '';
    }
    const profile: unknown = await firstValueFrom(
      this.identityClient
        .send({ cmd: 'identity.user.find_by_id' }, { id: user?.sub })
        .pipe(timeout(8000)),
    ).catch(() => null);
    const raw = (profile as { data?: { market_id?: unknown } } | null)?.data
      ?.market_id;
    return typeof raw === 'string' || typeof raw === 'number'
      ? String(raw).trim()
      : '';
  }

  /** tsEevElW: biriktirilmagan operator — tushunarli 400 (TC4). */
  private async requireOperatorMarketId(user: JwtUser): Promise<string> {
    const marketId = await this.resolveOperatorMarketId(user);
    if (!marketId) {
      throw new BadRequestException(
        "Operator hech qaysi marketga biriktirilmagan — mahsulot katalogi bilan ishlab bo'lmaydi",
      );
    }
    return marketId;
  }

  /**
   * tsEevElW: "o'z marketi" — MARKET uchun token `sub`, MARKET_OPERATOR uchun
   * biriktirilgan market (yo'q bo'lsa 400). my-products va by-code shu id
   * bilan cheklanadi (o'qish; Pc4CAFdB dan keyin market yozmaydi).
   */
  private async resolveOwnMarketId(user: JwtUser): Promise<string> {
    if (this.isMarketOperatorRequester(user)) {
      return this.requireOperatorMarketId(user);
    }
    return String(user?.sub ?? '').trim();
  }

  private buildPublicFileUrl(req: HttpRequestLike, key: string): string {
    const forwardedProto = req?.headers?.['x-forwarded-proto'];
    const protoHeader = Array.isArray(forwardedProto)
      ? forwardedProto[0]
      : forwardedProto;
    const protocol =
      String(protoHeader || req?.protocol || 'https').trim() || 'https';
    const host = req?.get?.('host') || String(req?.headers?.host || '').trim();
    if (!host) {
      throw new BadRequestException(
        'Unable to resolve public host for uploaded file',
      );
    }
    return `${protocol}://${host}/files/view/${encodeURIComponent(key)}`;
  }

  private async uploadImageAndResolveUrl(
    file: {
      originalname: string;
      mimetype: string;
      buffer: Buffer;
    },
    req: HttpRequestLike,
  ): Promise<string> {
    const mimeType = String(file.mimetype ?? '')
      .trim()
      .toLowerCase();
    if (!this.allowedImageMime.has(mimeType)) {
      throw new BadRequestException('Faqat PNG/JPEG/WebP rasm yuklash mumkin');
    }
    // E'lon qilingan tur faylning haqiqiy imzosiga mos kelishi shart —
    // `mimetype` ni mijoz yozadi, unga yolg'iz ishonib bo'lmaydi (audit S8).
    if (!matchesDeclaredType(file.buffer, mimeType)) {
      throw new BadRequestException(
        "Fayl mazmuni e'lon qilingan turga mos kelmadi",
      );
    }

    const uploadResponse = await firstValueFrom(
      this.fileClient
        .send(
          { cmd: 'file.upload' },
          {
            // ugoDD9TT: kalit (va URL) kengaytmasi haqiqiy turga mos.
            file_name: productImageFileName(file.originalname, mimeType),
            mime_type: mimeType,
            file_base64: file.buffer.toString('base64'),
            folder: 'products',
          },
        )
        .pipe(timeout(8000)),
    );

    const payload = uploadResponse?.data ?? uploadResponse;
    const key = payload?.key;
    if (!key || typeof key !== 'string') {
      throw new BadRequestException('Image upload failed');
    }

    return this.buildPublicFileUrl(req, key);
  }

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Catalog service health check' })
  health() {
    return this.catalogClient
      .send({ cmd: 'catalog.health' }, {})
      .pipe(timeout(8000));
  }

  /**
   * Pc4CAFdB (ega qarori 2026-10-15): mahsulotni FAQAT Elchi xodimi yaratadi —
   * o'lchov (og'irlik, o'lcham) yetkazish narxiga kiradi, uni sotuvchi emas,
   * xodim kiritadi. MARKET va MARKET_OPERATOR chiqarildi, BRANCH qo'shilmaydi.
   * `market_id` HAR DOIM majburiy (yo'q — 400).
   */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a new product (superadmin/admin/registrator/manager)',
    description:
      'Faqat xodim (superadmin, admin, registrator, menejer). `market_id` majburiy — yuborilmasa 400. Market va market operatori — 403.',
  })
  @ApiCreatedResponse({ description: 'Product created successfully' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreateProductRequestDto })
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async create(
    @UploadedFile()
    file:
      | {
          originalname: string;
          mimetype: string;
          buffer: Buffer;
        }
      | undefined,
    // Aws1oApe: DTO KLASSI — global ValidationPipe (`whitelist`,
    // `forbidNonWhitelisted`) endi ishlaydi: ortiqcha maydon → 400.
    @Body() dto: CreateProductRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    if (!dto?.name) {
      throw new BadRequestException('name is required');
    }

    // Pc4CAFdB: market / market operatori tarmoqlari olib tashlandi — rol
    // RolesGuard'da tekshiriladi, bu yerda ham (himoya qatlami) faqat xodim.
    if (!PRODUCT_WRITE_ROLES.some((role) => this.hasRole(req.user, role))) {
      throw new ForbiddenException('You are not allowed to create product');
    }
    const marketId = String(dto.market_id ?? '').trim();
    if (!marketId) {
      throw new BadRequestException(
        'market_id is required for admin/superadmin/registrator/manager',
      );
    }

    let imageUrl = dto.image_url;
    if (file) {
      imageUrl = await this.uploadImageAndResolveUrl(
        file,
        req as unknown as HttpRequestLike,
      );
    }

    return firstValueFrom(
      this.catalogClient
        .send(
          { cmd: 'catalog.product.create' },
          {
            dto: {
              name: dto.name,
              image_url: imageUrl,
              user_id: marketId,
              // zRqDRLAZ: ixtiyoriy narx (berilmasa uzatilmaydi).
              ...(dto.price !== undefined ? { price: dto.price } : {}),
              // MH-3 (MH-S1): o'lchov — DTO majburiy qilgan, son bo'lib ketadi.
              weight_kg: dto.weight_kg,
              length_cm: dto.length_cm,
              width_cm: dto.width_cm,
              height_cm: dto.height_cm,
              // Berilmasa catalog sukuti (true) / kodsiz.
              ...(dto.volumetric_enabled !== undefined
                ? { volumetric_enabled: dto.volumetric_enabled }
                : {}),
              ...(dto.barcode !== undefined ? { barcode: dto.barcode } : {}),
            },
            // 6tGZzupr: `remove` naqshi — jurnalda aktyor, market rollari 403.
            requester: { id: req.user.sub, roles: req.user.roles ?? [] },
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Catalog service response timeout');
      }
      throw error;
    });
  }

  /** So'rovchi faqat MARKET (o'z mahsulotlari bilan cheklanadi). */
  private isMarketOnlyRequester(user?: JwtUser): boolean {
    const roles = (user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    return (
      roles.includes(RoleEnum.MARKET) &&
      !roles.includes(RoleEnum.SUPERADMIN) &&
      !roles.includes(RoleEnum.ADMIN)
    );
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...PRODUCT_READ_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List products with filtering and pagination' })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({ name: 'user_id', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({
    name: 'sort_by',
    required: false,
    enum: PRODUCT_SORT_FIELDS,
    description:
      'j4kTqiSQ: saralash maydoni (sukut — created_at, yangisi tepada); boshqa qiymat 400',
  })
  @ApiQuery({ name: 'sort_dir', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'needs_measurement',
    required: false,
    type: Boolean,
    description:
      "6tGZzupr: true — «o'lchov kutilmoqda» (og'irlik yoki o'lcham yo'q) mahsulotlar, false — o'lchovi to'liqlar. Qatorlarda `needs_measurement` qaytadi.",
  })
  findAll(
    @Query('market_id') market_id?: string,
    @Query('user_id') user_id?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
    @Query('sort_by') sortBy?: string,
    @Query('sort_dir') sortDir?: string,
    @Query('needs_measurement') needsMeasurement?: string,
  ) {
    let resolvedUserId = market_id ?? user_id;
    if (this.isMarketOnlyRequester(req?.user)) {
      // Market — faqat o'z mahsulotlari (boshqa market id'si 403).
      const ownId = String(req?.user?.sub ?? '').trim();
      if (resolvedUserId && String(resolvedUserId).trim() !== ownId) {
        throw new ForbiddenException(
          "Market faqat o'z mahsulotlarini ko'ra oladi",
        );
      }
      resolvedUserId = ownId;
    }

    return this.catalogClient
      .send(
        { cmd: 'catalog.product.find_all' },
        {
          query: buildProductListQuery(
            resolvedUserId,
            search,
            page,
            limit,
            sortBy,
            sortDir,
            needsMeasurement,
          ),
        },
      )
      .pipe(
        timeout(8000),
        // T7 (B3): `market` — menejer/filialga telefonsiz.
        map((response: unknown) =>
          projectOrderContactsForRoles(req?.user?.roles, response),
        ),
      );
  }

  @Get('market/:marketId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
    RoleEnum.BRANCH,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get products by market id' })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({
    name: 'sort_by',
    required: false,
    enum: PRODUCT_SORT_FIELDS,
    description:
      'j4kTqiSQ: saralash maydoni (sukut — created_at, yangisi tepada); boshqa qiymat 400',
  })
  @ApiQuery({ name: 'sort_dir', required: false, enum: ['asc', 'desc'] })
  getByMarketId(
    @Param('marketId') marketId: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sort_by') sortBy?: string,
    @Query('sort_dir') sortDir?: string,
    @Req() req?: { user: JwtUser },
  ) {
    return this.catalogClient
      .send(
        { cmd: 'catalog.product.find_all' },
        {
          query: buildProductListQuery(
            marketId,
            search,
            page,
            limit,
            sortBy,
            sortDir,
          ),
        },
      )
      .pipe(
        timeout(8000),
        // T7 (B3): `market` — menejer/filialga telefonsiz.
        map((response: unknown) =>
          projectOrderContactsForRoles(req?.user?.roles, response),
        ),
      );
  }

  @Get('my-products')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET, RoleEnum.MARKET_OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get my products (market / market_operator)',
    description:
      "Market — o'z mahsulotlari; market operatori — biriktirilgan marketining mahsulotlari (biriktirilmagan bo'lsa 400). search/page/limit qo'llab-quvvatlanadi.",
  })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({
    name: 'sort_by',
    required: false,
    enum: PRODUCT_SORT_FIELDS,
    description:
      'j4kTqiSQ: saralash maydoni (sukut — created_at, yangisi tepada); boshqa qiymat 400',
  })
  @ApiQuery({ name: 'sort_dir', required: false, enum: ['asc', 'desc'] })
  async getMyProducts(
    @Req() req: { user: JwtUser },
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sort_by') sortBy?: string,
    @Query('sort_dir') sortDir?: string,
  ) {
    const sort = parseProductSort(sortBy, sortDir);
    const ownMarketId = await this.resolveOwnMarketId(req.user);
    return firstValueFrom(
      this.catalogClient
        .send(
          { cmd: 'catalog.product.find_all' },
          {
            query: {
              ...buildProductListQuery(ownMarketId, search, page, limit),
              ...sort,
            },
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Catalog service response timeout');
      }
      throw error;
    });
  }

  /**
   * hY7uacJu: skaner kodi → mahsulot (ombor kirimi, inventarizatsiya,
   * «Mahsulotga bog'lash»). `:id` dan OLDIN e'lon qilinadi. O'qish qoidasi
   * `GET /product/:id` bilan bir xil (PRODUCT_DETAIL_ROLES): market — faqat
   * o'zi, operator — biriktirilgan marketi, xodim — ixtiyoriy `market_id`.
   */
  @Get('by-code/:code')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...PRODUCT_DETAIL_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Find product by scanned code (ELC-P-… or factory barcode)',
    description:
      "`ELC-P-000123` — Elchi kodi (sku_code, registrga befarq, nolsiz ham); boshqasi — zavod shtrix kodi (EAN-13/8, UPC-A 12, UPC-E 8, GTIN-14 — saqlashdagi bilan bir xil kanonik GTIN'ga keltiriladi, ya'ni 8/12/13/14 xonali skan (UPC-E ham, kengaytirilgan UPC-A ham) bitta mahsulotni topadi; GS1 DataMatrix/QR matnidan GTIN ajratiladi; zavod QR matni aynan). Topilmasa 200 + `data: []`, `matched_by: null` (404 emas). Market — faqat o'z mahsulotlari (boshqa `market_id` — 403); market operatori — biriktirilgan marketi (biriktirilmagan — 400); xodim — `market_id` ixtiyoriy filtr.",
  })
  @ApiParam({
    name: 'code',
    description:
      "Skaner qiymati — `encodeURIComponent` bilan yuboring (QR matnida `/` bo'lishi mumkin).",
    example: 'ELC-P-000123',
  })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiOkResponse({ type: ProductByCodeResponseDto })
  async findByCode(
    @Param('code') code: string,
    @Query('market_id') marketId?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const text = typeof code === 'string' ? code.trim() : '';
    if (!text) {
      throw new BadRequestException("Kod bo'sh bo'lishi mumkin emas");
    }
    if (text.length > PRODUCT_BARCODE_MAX_LENGTH) {
      throw new BadRequestException(
        `Kod ${PRODUCT_BARCODE_MAX_LENGTH} belgidan oshmasligi kerak`,
      );
    }

    const requested = typeof marketId === 'string' ? marketId.trim() : '';
    let userId: string | undefined;
    if (
      this.isMarketOnlyRequester(req?.user) ||
      this.isMarketOperatorRequester(req?.user)
    ) {
      // Market — token `sub`; operator — biriktirilgan market (yo'q — 400).
      const ownId = await this.resolveOwnMarketId(req?.user as JwtUser);
      if (!ownId || (requested && requested !== ownId)) {
        throw new ForbiddenException(
          "Market faqat o'z mahsulotlarini ko'ra oladi",
        );
      }
      userId = ownId;
    } else {
      userId = requested || undefined;
    }

    const response: unknown = await firstValueFrom(
      this.catalogClient
        .send(
          { cmd: 'catalog.product.find_by_code' },
          { code: text, user_id: userId },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Catalog service response timeout');
      }
      throw error;
    });
    // T7 (B3): `market` — menejer/filialga telefonsiz.
    return projectOrderContactsForRoles(req?.user?.roles, response);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...PRODUCT_DETAIL_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get product by ID' })
  @ApiParam({ name: 'id', description: 'Product ID (id)' })
  async findById(@Param('id') id: string, @Req() req?: { user: JwtUser }) {
    const response: unknown = await firstValueFrom(
      this.catalogClient
        .send({ cmd: 'catalog.product.find_by_id' }, { id })
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Catalog service response timeout');
      }
      throw error;
    });

    // fix3 C11: market faqat o'z mahsulotini (tahrirlash oynasi shu
    // marshrutdan o'qiydi). Egasi aniqlanmasa — rad (fail-closed).
    // catalog `findById` mahsulotni O'RAMSIZ qaytaradi (eski `{ data }`
    // o'rami ham qabul qilinadi) — ilgari faqat `.data` o'qilib, tekshiruv
    // hech qachon ishlamasdi.
    const body =
      response && typeof response === 'object'
        ? (response as Record<string, unknown>)
        : null;
    const product =
      body && body.data && typeof body.data === 'object' ? body.data : body;
    const isMarket = this.isMarketOnlyRequester(req?.user);
    const isOperator = !isMarket && this.isMarketOperatorRequester(req?.user);
    if ((isMarket || isOperator) && product && typeof product === 'object') {
      const rawOwner = (product as { user_id?: unknown }).user_id;
      const ownerId =
        typeof rawOwner === 'string' || typeof rawOwner === 'number'
          ? String(rawOwner).trim()
          : '';
      // tsEevElW: operator — biriktirilgan marketi; aniqlanmasa '' → rad.
      const ownMarketId = isOperator
        ? await this.resolveOperatorMarketId(req?.user as JwtUser)
        : String(req?.user?.sub ?? '').trim();
      if (!ownerId || !ownMarketId || ownerId !== ownMarketId) {
        throw new ForbiddenException(
          "Market faqat o'z mahsulotini ko'ra oladi",
        );
      }
    }
    // T7 (B3): `market` — menejer/filialga telefonsiz.
    return projectOrderContactsForRoles(req?.user?.roles, response);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update product (admin/registrator)',
    description:
      "j4kTqiSQ: rasmni o'chirish — JSON `image: null` (yoki `image_url: null`/`''`), multipart `remove_image=true` " +
      "(yoki `image=null`, `image_url=''`). Yangi `image` fayl berilsa — fayl ustun.",
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'id', description: 'Product ID (id)' })
  @ApiBody({ type: UpdateProductRequestDto })
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async update(
    @Param('id') id: string,
    @UploadedFile()
    file:
      | {
          originalname: string;
          mimetype: string;
          buffer: Buffer;
        }
      | undefined,
    @Body() dto: UpdateProductRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    let imageUrl: string | null | undefined = dto.image_url;
    if (file) {
      imageUrl = await this.uploadImageAndResolveUrl(
        file,
        req as unknown as HttpRequestLike,
      );
    } else if (wantsProductImageRemoval(dto)) {
      // j4kTqiSQ: «×» — saqlangan rasm olib tashlanadi (`image_url = NULL`).
      imageUrl = null;
    }
    // `image` faylni yuqorida `image_url`ga aylantirdik — xom binary maydonni
    // servisga uzatmaymiz.
    const safeDto = { ...dto };
    delete safeDto.image;
    delete safeDto.remove_image;

    return this.catalogClient
      .send(
        { cmd: 'catalog.product.update' },
        { id, dto: { ...safeDto, image_url: imageUrl } },
      )
      .pipe(timeout(8000));
  }

  /** Pc4CAFdB: market mahsulotni o'chirmaydi — faqat xodim. */
  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Delete product (soft delete; superadmin/admin/registrator/manager)',
  })
  @ApiParam({ name: 'id', description: 'Product ID (id)' })
  remove(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return this.catalogClient
      .send(
        { cmd: 'catalog.product.delete' },
        { id, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
      )
      .pipe(timeout(8000));
  }

  // Pc4CAFdB: `PATCH /product/my/:id` (market / market operatori o'z
  // mahsulotini tahrirlashi) BUTUNLAY olib tashlandi — market mahsulotni
  // tahrirlamaydi. Handler'ni `@Roles` siz qoldirish TAQIQLANADI: RolesGuard
  // metadata bo'lmasa fail-open (tizimga kirgan HAMMAGA ochiq).
}
