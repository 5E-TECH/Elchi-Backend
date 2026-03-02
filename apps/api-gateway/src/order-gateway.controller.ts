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
  UpdateOrderByIdRequestDto,
} from './dto/order.swagger.dto';
import { Order_status } from '@app/common';

@ApiTags('Orders')
@Controller('orders')
export class OrderGatewayController {
  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
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
    const requestedPage = page ? Number(page) : 1;
    const requestedLimit = limit ? Number(limit) : 10;
    const normalizedSearch = search?.trim().toLowerCase();
    const useInMemorySearch = Boolean(normalizedSearch);

    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.find_all' },
          {
            query: {
              market_id,
              customer_id,
              status,
              start_day,
              end_day,
              courier,
              region_id,
              page: useInMemorySearch ? 1 : requestedPage,
              limit: useInMemorySearch ? 1000 : requestedLimit,
            },
          },
        )
        .pipe(timeout(8000)),
    )
      .then(async (response: { data?: Array<{ market_id?: string; customer_id?: string; district_id?: string | null; region_id?: string | null; items?: Array<{ product_id?: string }> }>; [key: string]: unknown }) => {
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
        const regionIds = Array.from(
          new Set(rows.map((row) => row.region_id).filter(Boolean) as string[]),
        );
        const productIds = Array.from(
          new Set(
            rows
              .flatMap((row) => row.items ?? [])
              .map((item) => item.product_id)
              .filter(Boolean) as string[],
          ),
        );

        const [markets, customers, districts, regions, products] = await Promise.all([
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
                    .send({ cmd: 'identity.customer.find_by_id' }, { id })
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
          Promise.all(
            regionIds.map(async (id) => {
              try {
                const res = await firstValueFrom(
                  this.logisticsClient
                    .send({ cmd: 'logistics.region.find_by_id' }, { id })
                    .pipe(timeout(8000)),
                );
                return [id, res?.data ?? res ?? null] as const;
              } catch {
                return [id, null] as const;
              }
            }),
          ),
          Promise.all(
            productIds.map(async (id) => {
              try {
                const res = await firstValueFrom(
                  this.catalogClient
                    .send({ cmd: 'catalog.product.find_by_id' }, { id })
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
        const regionMap = new Map(regions);
        const productMap = new Map(products);

        let enrichedRows = rows.map((row) => ({
          ...row,
          market: row.market_id ? marketMap.get(row.market_id) ?? null : null,
          customer: row.customer_id
            ? {
                ...(customerMap.get(row.customer_id) ?? null),
                district: row.district_id ? districtMap.get(row.district_id) ?? null : null,
                region: row.region_id ? regionMap.get(row.region_id) ?? null : null,
              }
            : null,
          district: row.district_id ? districtMap.get(row.district_id) ?? null : null,
          region: row.region_id ? regionMap.get(row.region_id) ?? null : null,
          items: (row.items ?? []).map((item) => ({
            ...item,
            product: item.product_id ? productMap.get(item.product_id) ?? null : null,
          })),
        }));

        if (normalizedSearch) {
          enrichedRows = enrichedRows.filter((row) => {
            const customer = row.customer as { name?: string; phone_number?: string } | null;
            if (!customer) return false;
            const fullName = (customer.name ?? '').toLowerCase();
            const phone = (customer.phone_number ?? '').toLowerCase();
            return fullName.includes(normalizedSearch) || phone.includes(normalizedSearch);
          });
        }

        if (useInMemorySearch) {
          const from = (requestedPage - 1) * requestedLimit;
          const to = from + requestedLimit;
          return {
            ...response,
            data: enrichedRows.slice(from, to),
            total: enrichedRows.length,
            page: requestedPage,
            limit: requestedLimit,
          };
        }

        return {
          ...response,
          data: enrichedRows,
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
    )
      .then(async (response: { data?: Array<{ market_id?: string; customer_id?: string; district_id?: string | null; region_id?: string | null; items?: Array<{ product_id?: string }> }>; [key: string]: unknown }) => {
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
        const regionIds = Array.from(
          new Set(rows.map((row) => row.region_id).filter(Boolean) as string[]),
        );
        const productIds = Array.from(
          new Set(
            rows
              .flatMap((row) => row.items ?? [])
              .map((item) => item.product_id)
              .filter(Boolean) as string[],
          ),
        );

        const [markets, customers, districts, regions, products] = await Promise.all([
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
                    .send({ cmd: 'identity.customer.find_by_id' }, { id })
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
          Promise.all(
            regionIds.map(async (id) => {
              try {
                const res = await firstValueFrom(
                  this.logisticsClient
                    .send({ cmd: 'logistics.region.find_by_id' }, { id })
                    .pipe(timeout(8000)),
                );
                return [id, res?.data ?? res ?? null] as const;
              } catch {
                return [id, null] as const;
              }
            }),
          ),
          Promise.all(
            productIds.map(async (id) => {
              try {
                const res = await firstValueFrom(
                  this.catalogClient
                    .send({ cmd: 'catalog.product.find_by_id' }, { id })
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
        const regionMap = new Map(regions);
        const productMap = new Map(products);

        return {
          ...response,
          data: rows.map((row) => ({
            ...row,
            market: row.market_id ? marketMap.get(row.market_id) ?? null : null,
            customer: row.customer_id
              ? {
                  ...(customerMap.get(row.customer_id) ?? null),
                  district: row.district_id ? districtMap.get(row.district_id) ?? null : null,
                  region: row.region_id ? regionMap.get(row.region_id) ?? null : null,
                }
              : null,
            district: row.district_id ? districtMap.get(row.district_id) ?? null : null,
            region: row.region_id ? regionMap.get(row.region_id) ?? null : null,
            items: (row.items ?? []).map((item) => ({
              ...item,
              product: item.product_id ? productMap.get(item.product_id) ?? null : null,
            })),
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

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order by ID' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  async findById(@Param('id') id: string) {
    const order = await firstValueFrom(
      this.orderClient.send({ cmd: 'order.find_by_id' }, { id }).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });

    const [market, customer, district, region, post] = await Promise.all([
      order?.market_id
        ? firstValueFrom(
            this.identityClient
              .send({ cmd: 'identity.market.find_by_id' }, { id: order.market_id })
              .pipe(timeout(8000)),
          )
            .then((res) => res?.data ?? res ?? null)
            .catch(() => null)
        : Promise.resolve(null),
      order?.customer_id
        ? firstValueFrom(
            this.identityClient
              .send({ cmd: 'identity.customer.find_by_id' }, { id: order.customer_id })
              .pipe(timeout(8000)),
          )
            .then((res) => res?.data ?? res ?? null)
            .catch(() => null)
        : Promise.resolve(null),
      order?.district_id
        ? firstValueFrom(
            this.logisticsClient
              .send({ cmd: 'logistics.district.find_by_id' }, { id: order.district_id })
              .pipe(timeout(8000)),
          )
            .then((res) => res?.data ?? res ?? null)
            .catch(() => null)
        : Promise.resolve(null),
      order?.region_id
        ? firstValueFrom(
            this.logisticsClient
              .send({ cmd: 'logistics.region.find_by_id' }, { id: order.region_id })
              .pipe(timeout(8000)),
          )
            .then((res) => res?.data ?? res ?? null)
            .catch(() => null)
        : Promise.resolve(null),
      order?.post_id
        ? firstValueFrom(
            this.logisticsClient
              .send({ cmd: 'logistics.post.find_by_id' }, { id: order.post_id })
              .pipe(timeout(8000)),
          )
            .then((res) => res?.data ?? null)
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    const items = await Promise.all(
      (order?.items ?? []).map(async (item: { product_id?: string }) => {
        if (!item?.product_id) {
          return { ...item, product: null };
        }
        try {
          const res = await firstValueFrom(
            this.catalogClient
              .send({ cmd: 'catalog.product.find_by_id' }, { id: item.product_id })
              .pipe(timeout(8000)),
          );
          return { ...item, product: res?.data ?? res ?? null };
        } catch {
          return { ...item, product: null };
        }
      }),
    );

    return {
      statusCode: 200,
      message: 'Order by id',
      data: {
        id: order?.id ?? null,
        created_at: order?.createdAt ?? null,
        updated_at: order?.updatedAt ?? null,
        user_id: order?.market_id ?? null,
        product_quantity: order?.product_quantity ?? 0,
        where_deliver: order?.where_deliver ?? null,
        total_price: order?.total_price ?? 0,
        to_be_paid: order?.to_be_paid ?? 0,
        paid_amount: order?.paid_amount ?? 0,
        status: order?.status ?? null,
        comment: order?.comment ?? '',
        operator: order?.operator ?? '',
        post_id: order?.post_id ?? null,
        canceled_post_id: null,
        qr_code_token: order?.qr_code_token ?? null,
        parent_order_id: null,
        customer_id: order?.customer_id ?? null,
        district_id: order?.district_id ?? null,
        address: order?.address ?? null,
        sold_at: null,
        market_tariff: null,
        courier_tariff: null,
        deleted: order?.deleted ?? false,
        create_bot_messages: null,
        external_id: null,
        items: items.map((item) => ({
          id: (item as { id?: string }).id ?? null,
          created_at: (item as { createdAt?: string }).createdAt ?? null,
          updated_at: (item as { updatedAt?: string }).updatedAt ?? null,
          productId: (item as { product_id?: string }).product_id ?? null,
          orderId: (item as { order_id?: string }).order_id ?? null,
          quantity: (item as { quantity?: number }).quantity ?? 0,
          product: (item as { product?: unknown }).product ?? null,
        })),
        market,
        customer,
        district,
        region,
        post,
      },
    };
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order (full fields, including items)' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  @ApiBody({ type: UpdateOrderByIdRequestDto })
  update(@Param('id') id: string, @Body() dto: UpdateOrderByIdRequestDto) {
    // Keep PATCH /orders/:id as the primary full-update endpoint.
    return this.orderClient.send({ cmd: 'order.update_full' }, { id, dto });
  }

  @Patch(':id/full')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order by id (full fields)' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  @ApiBody({ type: UpdateOrderByIdRequestDto })
  updateFull(@Param('id') id: string, @Body() dto: UpdateOrderByIdRequestDto) {
    return this.orderClient.send({ cmd: 'order.update_full' }, { id, dto });
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
