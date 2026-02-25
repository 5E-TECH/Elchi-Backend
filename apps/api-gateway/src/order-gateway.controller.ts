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
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
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
    return firstValueFrom(
      this.orderClient
        .send(
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
        )
        .pipe(timeout(8000)),
    )
      .then(async (response: { data?: Array<{ market_id?: string; customer_id?: string; district_id?: string | null }>; [key: string]: unknown }) => {
        const rows = response?.data ?? [];
        const marketIds = Array.from(
          new Set(rows.map((row) => row.market_id).filter(Boolean) as string[]),
        );
        const customerIds = Array.from(
          new Set(rows.map((row) => row.customer_id).filter(Boolean) as string[]),
        );
        const districtIds = Array.from(
          new Set(rows.map((row) => row.district_id).filter(Boolean) as string[]),
        );

        const [markets, customers, districts] = await Promise.all([
          Promise.all(
            marketIds.map(async (id) => {
              try {
                const res = await firstValueFrom(
                  this.identityClient
                    .send({ cmd: 'identity.market.find_by_id' }, { id })
                    .pipe(timeout(8000)),
                );
                return [id, res?.data ?? res ?? null] as const;
              } catch {
                return [id, null] as const;
              }
            }),
          ),
          Promise.all(
            customerIds.map(async (id) => {
              try {
                const res = await firstValueFrom(
                  this.identityClient
                    .send({ cmd: 'identity.user.find_by_id' }, { id })
                    .pipe(timeout(8000)),
                );
                return [id, res?.data ?? res ?? null] as const;
              } catch {
                return [id, null] as const;
              }
            }),
          ),
          Promise.all(
            districtIds.map(async (id) => {
              try {
                const res = await firstValueFrom(
                  this.logisticsClient
                    .send({ cmd: 'logistics.district.find_by_id' }, { id })
                    .pipe(timeout(8000)),
                );
                return [id, res?.data ?? res ?? null] as const;
              } catch {
                return [id, null] as const;
              }
            }),
          ),
        ]);

        const marketMap = new Map(markets);
        const customerMap = new Map(customers);
        const districtMap = new Map(districts);

        return {
          ...response,
          data: rows.map((row) => ({
            ...row,
            market: row.market_id ? marketMap.get(row.market_id) ?? null : null,
            customer: row.customer_id ? customerMap.get(row.customer_id) ?? null : null,
            district: row.district_id ? districtMap.get(row.district_id) ?? null : null,
          })),
        };
      })
      .catch((error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException('Order service response timeout');
        }
        throw error;
      });
  }

  @Get('markets/today')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Today's markets with orders" })
  async findTodayMarkets() {
    const rows = await firstValueFrom(
      this.orderClient.send({ cmd: 'order.find_today_markets' }, {}).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });

    const markets = await Promise.all(
      (rows ?? []).map(async (row: { market_id: string }) => {
        try {
          const res = await firstValueFrom(
            this.identityClient
              .send({ cmd: 'identity.market.find_by_id' }, { id: row.market_id })
              .pipe(timeout(8000)),
          );
          return res?.data ?? res ?? null;
        } catch {
          return null;
        }
      }),
    );

    return (rows ?? []).map(
      (row: { market_id: string; orders_count: number; total_price_sum: number }, i: number) => ({
        ...row,
        market: markets[i],
      }),
    );
  }

  @Get('markets/new')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Markets with NEW orders' })
  async findNewMarkets() {
    const rows = await firstValueFrom(
      this.orderClient.send({ cmd: 'order.find_new_markets' }, {}).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });

    const markets = await Promise.all(
      (rows ?? []).map(async (row: { market_id: string }) => {
        try {
          const res = await firstValueFrom(
            this.identityClient
              .send({ cmd: 'identity.market.find_by_id' }, { id: row.market_id })
              .pipe(timeout(8000)),
          );
          return res?.data ?? res ?? null;
        } catch {
          return null;
        }
      }),
    );

    return (rows ?? []).map(
      (row: { market_id: string; orders_count: number; total_price_sum: number }, i: number) => ({
        ...row,
        market: markets[i],
      }),
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
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.find_new_by_market' },
          {
            market_id: marketId,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
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
