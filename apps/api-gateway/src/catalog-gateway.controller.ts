import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Roles as RoleEnum } from '@app/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';

@ApiTags('Products')
@Controller('products')
export class CatalogGatewayController {
  constructor(@Inject('CATALOG') private readonly catalogClient: ClientProxy) {}

  @Get('health')
  @ApiOperation({ summary: 'Catalog service health check' })
  health() {
    return this.catalogClient.send({ cmd: 'catalog.health' }, {});
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new product' })
  @ApiCreatedResponse({ description: 'Product created successfully' })
  create(
    @Body() dto: { name: string; user_id: string; image_url?: string },
  ) {
    return this.catalogClient.send({ cmd: 'catalog.product.create' }, { dto });
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
  @Roles(RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update product' })
  @ApiParam({ name: 'id', description: 'Product ID (uuid)' })
  update(
    @Param('id') id: string,
    @Body() dto: { name?: string; image_url?: string },
  ) {
    return this.catalogClient.send({ cmd: 'catalog.product.update' }, { id, dto });
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete product (soft delete)' })
  @ApiParam({ name: 'id', description: 'Product ID (uuid)' })
  remove(@Param('id') id: string) {
    return this.catalogClient.send({ cmd: 'catalog.product.delete' }, { id });
  }
}
