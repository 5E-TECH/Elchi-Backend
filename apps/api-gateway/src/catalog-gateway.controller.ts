import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Roles as RoleEnum } from '@app/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
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
@Controller('api/v1/product')
export class CatalogGatewayController {
  constructor(@Inject('CATALOG') private readonly catalogClient: ClientProxy) {}

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
  create(
    @Body() dto: { name: string; image_url?: string; market_id?: string },
    @Req() req: { user: JwtUser },
  ) {
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

    return this.catalogClient.send(
      { cmd: 'catalog.product.create' },
      { dto: { name: dto.name, image_url: dto.image_url, user_id: marketId } },
    );
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List products with filtering and pagination' })
  @ApiQuery({ name: 'user_id', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  findAll(
    @Query('user_id') user_id?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.catalogClient.send(
      { cmd: 'catalog.product.find_all' },
      {
        query: {
          user_id,
          search,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }

  @Get('market/:marketId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get products by market id' })
  @ApiParam({ name: 'marketId', description: 'Market ID (uuid)' })
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
  @ApiParam({ name: 'id', description: 'Product ID (uuid)' })
  findById(@Param('id') id: string) {
    return this.catalogClient.send({ cmd: 'catalog.product.find_by_id' }, { id });
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update product (admin/registrator)' })
  @ApiParam({ name: 'id', description: 'Product ID (uuid)' })
  @ApiBody({ type: UpdateProductRequestDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductRequestDto,
  ) {
    return this.catalogClient.send({ cmd: 'catalog.product.update' }, { id, dto });
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET, RoleEnum.ADMIN, RoleEnum.SUPERADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete product (soft delete)' })
  @ApiParam({ name: 'id', description: 'Product ID (uuid)' })
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
  @ApiParam({ name: 'id', description: 'Product ID (uuid)' })
  @ApiBody({ type: UpdateProductRequestDto })
  updateMyProduct(
    @Param('id') id: string,
    @Body() dto: UpdateProductRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.catalogClient.send(
      { cmd: 'catalog.product.update_own' },
      { id, user_id: req.user.sub, dto },
    );
  }
}
