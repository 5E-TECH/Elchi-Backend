import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import {
  CreateOrderRequestDto,
  OrdersArrayDto,
  UpdateOrderByIdRequestDto,
} from './dto/order.swagger.dto';
import { Order_status, Roles as RoleEnum } from '@app/common';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';

@ApiTags('Orders')
@Controller('orders')
export class OrderGatewayController {
  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private async sendOrderWithTimeout(pattern: { cmd: string }, payload: object) {
    return firstValueFrom(this.orderClient.send(pattern, payload).pipe(timeout(8000))).catch(
      (error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException('Order service response timeout');
        }
        throw error;
      },
    );
  }

  private async sendOrderWithFallback(
    primary: { cmd: string },
    fallback: { cmd: string },
    payload: object,
  ) {
    try {
      return await this.sendOrderWithTimeout(primary, payload);
    } catch (error) {
      if (error instanceof GatewayTimeoutException) {
        throw error;
      }
      return this.sendOrderWithTimeout(fallback, payload);
    }
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create order' })
  @ApiBody({ type: CreateOrderRequestDto })
  async create(@Body() dto: CreateOrderRequestDto) {
    const { customer, ...orderDto } = dto;
    let customerId = dto.customer_id;

    if (!customerId) {
      if (!customer) {
        throw new BadRequestException('customer_id yoki customer obyekt yuborilishi shart');
      }

      const customerResponse = await firstValueFrom(
        this.identityClient
          .send({ cmd: 'identity.customer.create' }, { dto: customer })
          .pipe(timeout(8000)),
      ).catch((error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException('Identity service response timeout');
        }
        throw error;
      });

      const createdCustomer = customerResponse?.data ?? customerResponse;
      customerId = createdCustomer?.id;
      if (!customerId) {
        throw new BadRequestException('Customer yaratildi, lekin id qaytmadi');
      }
    }
    const finalCustomerId = customerId;

    return firstValueFrom(
      this.orderClient
        .send({ cmd: 'order.create' }, { dto: { ...orderDto, customer_id: finalCustomerId } })
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('receive')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive new orders' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiBody({ type: OrdersArrayDto })
  receiveNewOrders(@Body() dto: OrdersArrayDto, @Query('search') search?: string) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.receive' },
          {
            order_ids: dto.order_ids,
            search,
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List orders with filters' })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({ name: 'customer_id', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: Order_status })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Customer name/family/phone search' })
  @ApiQuery({ name: 'start_day', required: false, type: String, description: 'Start date (YYYY-MM-DD or ISO)' })
  @ApiQuery({ name: 'end_day', required: false, type: String, description: 'End date (YYYY-MM-DD or ISO)' })
  @ApiQuery({ name: 'courier', required: false, type: String, description: 'Courier (operator text or post_id)' })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  findAll(
    @Query('market_id') market_id?: string,
    @Query('customer_id') customer_id?: string,
    @Query('status') status?: Order_status,
    @Query('search') search?: string,
    @Query('start_day') start_day?: string,
    @Query('end_day') end_day?: string,
    @Query('courier') courier?: string,
    @Query('region_id') region_id?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const payload = {
      query: {
        market_id,
        customer_id,
        status,
        search,
        start_day,
        end_day,
        courier,
        region_id,
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 10,
      },
    };

    return this.sendOrderWithFallback(
      { cmd: 'order.find_all_enriched' },
      { cmd: 'order.find_all' },
      payload,
    );
  }

  @Get('markets/new')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Markets with NEW orders' })
  async findNewMarkets() {
    return this.sendOrderWithFallback(
      { cmd: 'order.find_new_markets_enriched' },
      { cmd: 'order.find_new_markets' },
      {},
    );
  }

  @Get('markets/:marketId/new')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'NEW orders by market id' })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  async findNewOrdersByMarket(
    @Param('marketId') marketId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const payload = {
      market_id: marketId,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    };

    return this.sendOrderWithFallback(
      { cmd: 'order.find_new_by_market_enriched' },
      { cmd: 'order.find_new_by_market' },
      payload,
    );
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order by ID' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  async findById(@Param('id') id: string) {
    return this.sendOrderWithFallback(
      { cmd: 'order.find_by_id_enriched' },
      { cmd: 'order.find_by_id' },
      { id },
    );
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order (full fields, including items)' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  @ApiBody({ type: UpdateOrderByIdRequestDto })
  update(@Param('id') id: string, @Body() dto: UpdateOrderByIdRequestDto) {
    return firstValueFrom(
      this.orderClient
        .send({ cmd: 'order.update_normalized' }, { id, dto })
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Patch(':id/full')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order by id (full fields)' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  @ApiBody({ type: UpdateOrderByIdRequestDto })
  updateFull(@Param('id') id: string, @Body() dto: UpdateOrderByIdRequestDto) {
    return firstValueFrom(
      this.orderClient
        .send({ cmd: 'order.update_normalized' }, { id, dto })
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete order (soft delete)' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  remove(@Param('id') id: string) {
    return this.orderClient.send({ cmd: 'order.delete' }, { id });
  }
}
