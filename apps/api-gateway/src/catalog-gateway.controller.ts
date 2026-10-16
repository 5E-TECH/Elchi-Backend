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
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import {
  ApiBody,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiConsumes,
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
): {
  user_id: string | undefined;
  search: string | undefined;
  page: number | undefined;
  limit: number | undefined;
} {
  const parsedLimit = toPositiveInt(limit);
  const trimmedSearch = typeof search === 'string' ? search.trim() : '';
  return {
    user_id: userId,
    search: trimmedSearch || undefined,
    page: toPositiveInt(page),
    limit:
      parsedLimit === undefined
        ? undefined
        : Math.min(parsedLimit, PRODUCT_LIST_MAX_LIMIT),
  };
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
   * biriktirilgan market (yo'q bo'lsa 400). my-products va PATCH my/:id shu
   * id bilan cheklanadi.
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

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.MARKET,
    // tsEevElW: market operatori o'z marketiga mahsulot qo'shadi.
    RoleEnum.MARKET_OPERATOR,
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new product' })
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

    const roles = req.user.roles ?? [];
    let marketId: string | undefined = dto.market_id;

    if (roles.includes(RoleEnum.MARKET)) {
      marketId = req.user.sub;
    } else if (this.isMarketOperatorRequester(req.user)) {
      // tsEevElW: tanadagi market_id E'TIBORSIZ — mahsulot doim operator
      // biriktirilgan marketga yoziladi; biriktirilmagan bo'lsa 400.
      marketId = await this.requireOperatorMarketId(req.user);
    } else if (
      roles.includes(RoleEnum.ADMIN) ||
      roles.includes(RoleEnum.SUPERADMIN) ||
      roles.includes(RoleEnum.REGISTRATOR) ||
      roles.includes(RoleEnum.MANAGER)
    ) {
      if (!marketId) {
        throw new BadRequestException(
          'market_id is required for admin/superadmin/registrator/manager',
        );
      }
    } else {
      throw new ForbiddenException('You are not allowed to create product');
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
  findAll(
    @Query('market_id') market_id?: string,
    @Query('user_id') user_id?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
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
        { query: buildProductListQuery(resolvedUserId, search, page, limit) },
      )
      .pipe(timeout(8000));
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
  getByMarketId(
    @Param('marketId') marketId: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.catalogClient
      .send(
        { cmd: 'catalog.product.find_all' },
        { query: buildProductListQuery(marketId, search, page, limit) },
      )
      .pipe(timeout(8000));
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
  async getMyProducts(
    @Req() req: { user: JwtUser },
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const ownMarketId = await this.resolveOwnMarketId(req.user);
    return firstValueFrom(
      this.catalogClient
        .send(
          { cmd: 'catalog.product.find_all' },
          { query: buildProductListQuery(ownMarketId, search, page, limit) },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Catalog service response timeout');
      }
      throw error;
    });
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
    return response;
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
  @ApiOperation({ summary: 'Update product (admin/registrator)' })
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
    let imageUrl = dto.image_url;
    if (file) {
      imageUrl = await this.uploadImageAndResolveUrl(
        file,
        req as unknown as HttpRequestLike,
      );
    }
    // `image` faylni yuqorida `image_url`ga aylantirdik — xom binary maydonni
    // servisga uzatmaymiz.
    const safeDto = { ...dto };
    delete safeDto.image;

    return this.catalogClient
      .send(
        { cmd: 'catalog.product.update' },
        { id, dto: { ...safeDto, image_url: imageUrl } },
      )
      .pipe(timeout(8000));
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.MARKET,
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete product (soft delete)' })
  @ApiParam({ name: 'id', description: 'Product ID (id)' })
  remove(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return this.catalogClient
      .send(
        { cmd: 'catalog.product.delete' },
        { id, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
      )
      .pipe(timeout(8000));
  }

  @Patch('my/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET, RoleEnum.MARKET_OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update own product (market / market_operator)',
    description:
      "Market — o'z mahsuloti; market operatori — biriktirilgan marketining mahsuloti. Begona mahsulot — 403.",
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
  async updateMyProduct(
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
    // tsEevElW: egalik — o'z marketi (operator uchun biriktirilgan market;
    // biriktirilmagan bo'lsa 400). Rasm yuklashdan OLDIN aniqlanadi.
    const ownMarketId = await this.resolveOwnMarketId(req.user);
    const isOperator = this.isMarketOperatorRequester(req.user);

    let imageUrl = dto.image_url;
    if (file) {
      imageUrl = await this.uploadImageAndResolveUrl(
        file,
        req as unknown as HttpRequestLike,
      );
    }
    // `image` faylni yuqorida `image_url`ga aylantirdik — xom binary maydonni
    // servisga uzatmaymiz.
    const safeDto = { ...dto };
    delete safeDto.image;

    return this.catalogClient
      .send(
        { cmd: 'catalog.product.update_own' },
        {
          id,
          user_id: ownMarketId,
          dto: { ...safeDto, image_url: imageUrl },
          // Activity log aktyori — operator o'zi (market emas).
          ...(isOperator
            ? {
                actor: {
                  id: String(req.user.sub),
                  role: RoleEnum.MARKET_OPERATOR,
                },
              }
            : {}),
        },
      )
      .pipe(timeout(8000));
  }
}
