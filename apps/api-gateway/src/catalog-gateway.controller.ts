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
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreateProductRequestDto,
  UpdateProductRequestDto,
} from './dto/catalog.swagger.dto';

interface JwtUser {
  sub: string;
  roles?: string[];
}

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

  private async uploadImageAndResolveUrl(file: {
    originalname: string;
    mimetype: string;
    buffer: Buffer;
  }): Promise<string> {
    if (!this.allowedMime.has(file.mimetype)) {
      throw new BadRequestException('Unsupported file type');
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
    const resolvedUrl = payload?.url;
    if (!resolvedUrl || typeof resolvedUrl !== 'string') {
      throw new BadRequestException('Image upload failed');
    }

    return resolvedUrl;
  }

  @Get('health')
  @ApiOperation({ summary: 'Catalog service health check' })
  health() {
    return this.catalogClient.send({ cmd: 'catalog.health' }, {});
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET, RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
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
    @UploadedFile() file: {
      originalname: string;
      mimetype: string;
      buffer: Buffer;
    } | undefined,
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
    } else if (roles.includes(RoleEnum.ADMIN) || roles.includes(RoleEnum.SUPERADMIN)) {
      if (!marketId) {
        throw new BadRequestException('market_id is required for admin/superadmin');
      }
    } else {
      throw new ForbiddenException('You are not allowed to create product');
    }

    let imageUrl = dto.image_url;
    if (file) {
      imageUrl = await this.uploadImageAndResolveUrl(file);
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

  @Get()
  @UseGuards(JwtAuthGuard)
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
  ) {
    const resolvedUserId = market_id ?? user_id;

    return this.catalogClient.send(
      { cmd: 'catalog.product.find_all' },
      {
        query: {
          user_id: resolvedUserId,
          search,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }

  @Get('market/:marketId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get products by market id' })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  getByMarketId(@Param('marketId') marketId: string) {
    return this.catalogClient.send(
      { cmd: 'catalog.product.find_all' },
      { query: { user_id: marketId } },
    );
  }

  @Get('my-products')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my products (market role)' })
  getMyProducts(@Req() req: { user: JwtUser }) {
    return this.catalogClient.send(
      { cmd: 'catalog.product.find_all' },
      { query: { user_id: req.user.sub } },
    );
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get product by ID' })
  @ApiParam({ name: 'id', description: 'Product ID (id)' })
  findById(@Param('id') id: string) {
    return this.catalogClient.send({ cmd: 'catalog.product.find_by_id' }, { id });
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN, RoleEnum.REGISTRATOR)
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
    @UploadedFile() file: {
      originalname: string;
      mimetype: string;
      buffer: Buffer;
    } | undefined,
    @Body() dto: UpdateProductRequestDto,
  ) {
    let imageUrl = dto.image_url;
    if (file) {
      imageUrl = await this.uploadImageAndResolveUrl(file);
    }
    const { image: _ignoredImage, ...safeDto } = dto;

    return this.catalogClient.send(
      { cmd: 'catalog.product.update' },
      { id, dto: { ...safeDto, image_url: imageUrl } },
    );
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET, RoleEnum.ADMIN, RoleEnum.SUPERADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete product (soft delete)' })
  @ApiParam({ name: 'id', description: 'Product ID (id)' })
  remove(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return this.catalogClient.send(
      { cmd: 'catalog.product.delete' },
      { id, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
    );
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
    @UploadedFile() file: {
      originalname: string;
      mimetype: string;
      buffer: Buffer;
    } | undefined,
    @Body() dto: UpdateProductRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    let imageUrl = dto.image_url;
    if (file) {
      imageUrl = await this.uploadImageAndResolveUrl(file);
    }
    const { image: _ignoredImage, ...safeDto } = dto;

    return this.catalogClient.send(
      { cmd: 'catalog.product.update_own' },
      { id, user_id: req.user.sub, dto: { ...safeDto, image_url: imageUrl } },
    );
  }
}
