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

@ApiTags('Products')
@Controller('product')
export class CatalogGatewayController {
  private readonly allowedMime = new Set<string>([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]);

  constructor(
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
    @Inject('FILE') private readonly fileClient: ClientProxy,
  ) {}

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
    if (!this.allowedMime.has(file.mimetype)) {
      throw new BadRequestException('Unsupported file type');
    }
    // E'lon qilingan tur faylning haqiqiy imzosiga mos kelishi shart —
    // `mimetype` ni mijoz yozadi, unga yolg'iz ishonib bo'lmaydi (audit S8).
    if (!matchesDeclaredType(file.buffer, file.mimetype)) {
      throw new BadRequestException(
        "Fayl mazmuni e'lon qilingan turga mos kelmadi",
      );
    }

    const uploadResponse = await firstValueFrom(
      this.fileClient
        .send(
          { cmd: 'file.upload' },
          {
            file_name: file.originalname,
            mime_type: file.mimetype,
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
    @Body() dto: { name?: string; image_url?: string; market_id?: string },
    @Req() req: { user: JwtUser },
  ) {
    if (!dto?.name) {
      throw new BadRequestException('name is required');
    }

    const roles = req.user.roles ?? [];
    let marketId: string | undefined = dto.market_id;

    if (roles.includes(RoleEnum.MARKET)) {
      marketId = req.user.sub;
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
          { dto: { name: dto.name, image_url: imageUrl, user_id: marketId } },
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
        {
          query: {
            user_id: resolvedUserId,
            search,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
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
  getByMarketId(@Param('marketId') marketId: string) {
    return this.catalogClient
      .send(
        { cmd: 'catalog.product.find_all' },
        { query: { user_id: marketId } },
      )
      .pipe(timeout(8000));
  }

  @Get('my-products')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my products (market role)' })
  getMyProducts(@Req() req: { user: JwtUser }) {
    return this.catalogClient
      .send(
        { cmd: 'catalog.product.find_all' },
        { query: { user_id: req.user.sub } },
      )
      .pipe(timeout(8000));
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...PRODUCT_READ_ROLES)
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
    if (
      this.isMarketOnlyRequester(req?.user) &&
      product &&
      typeof product === 'object'
    ) {
      const rawOwner = (product as { user_id?: unknown }).user_id;
      const ownerId =
        typeof rawOwner === 'string' || typeof rawOwner === 'number'
          ? String(rawOwner).trim()
          : '';
      if (!ownerId || ownerId !== String(req?.user?.sub ?? '').trim()) {
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
  @Roles(RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update own product (market)' })
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
        { id, user_id: req.user.sub, dto: { ...safeDto, image_url: imageUrl } },
      )
      .pipe(timeout(8000));
  }
}
