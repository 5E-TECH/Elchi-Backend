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
import { CreateOrderRequestDto, UpdateOrderRequestDto } from './dto/order.swagger.dto';
import { Order_status } from '@app/common';

@ApiTags('Orders')
@Controller('orders')
export class OrderGatewayController {
  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

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

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List orders with filters' })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({ name: 'customer_id', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: Order_status })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  findAll(
    @Query('market_id') market_id?: string,
    @Query('customer_id') customer_id?: string,
    @Query('status') status?: Order_status,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.orderClient.send(
      { cmd: 'order.find_all' },
      {
        query: {
          market_id,
          customer_id,
          status,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }

  @Get('markets/today')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Today's markets with orders" })
  findTodayMarkets() {
    return this.orderClient.send({ cmd: 'order.find_today_markets' }, {});
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order by ID' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  findById(@Param('id') id: string) {
    return this.orderClient.send({ cmd: 'order.find_by_id' }, { id });
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  @ApiBody({ type: UpdateOrderRequestDto })
  update(@Param('id') id: string, @Body() dto: UpdateOrderRequestDto) {
    return this.orderClient.send({ cmd: 'order.update' }, { id, dto });
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
