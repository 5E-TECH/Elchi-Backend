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
  Req,
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
  PartlySellOrderRequestDto,
  SellOrderRequestDto,
  UpdateOrderByIdRequestDto,
} from './dto/order.swagger.dto';
import { Order_status, Roles as RoleEnum } from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';

interface JwtUser {
  sub: string;
  username: string;
  roles: string[];
}

class ReceiveExternalOrdersDto {
  integration_id!: string;
  orders!: any[];
}

@ApiTags('Orders')
@Controller('orders')
export class OrderGatewayController {
  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
  ) {}

  private toSnakeCaseKey(value: string) {
    return value
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/-/g, '_')
      .toLowerCase();
  }

  private toLegacyShape<T>(value: T): T {
    if (Array.isArray(value)) {
      return value.map((item) => this.toLegacyShape(item)) as T;
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
          this.toSnakeCaseKey(key),
          this.toLegacyShape(nestedValue),
        ]),
      ) as T;
    }

    return value;
  }

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

  private async sendIdentityWithTimeout(pattern: { cmd: string }, payload: object) {
    return firstValueFrom(this.identityClient.send(pattern, payload).pipe(timeout(8000))).catch(
      (error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException('Identity service response timeout');
        }
        throw error;
      },
    );
  }

  private async sendLogisticsWithTimeout(pattern: { cmd: string }, payload: object) {
    return firstValueFrom(this.logisticsClient.send(pattern, payload).pipe(timeout(8000))).catch(
      (error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException('Logistics service response timeout');
        }
        throw error;
      },
    );
  }

  private normalizeLegacyOrderRow(row: Record<string, unknown>) {
    const normalized = { ...row };
    if ('is_deleted' in normalized) {
      normalized.deleted = normalized.is_deleted;
      delete normalized.is_deleted;
    }
    return normalized;
  }

  private extractRows(payload: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(payload)) {
      return payload as Array<Record<string, unknown>>;
    }
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (Array.isArray(obj.data)) {
        return obj.data as Array<Record<string, unknown>>;
      }
    }
    return [];
  }

  private async enrichMarketRows(rows: Array<Record<string, any>>) {
    const marketIds = Array.from(
      new Set(rows.map((row) => String(row?.market_id ?? '')).filter(Boolean)),
    );

    if (!marketIds.length) {
      return rows;
    }

    const marketsResponse = await this.sendIdentityWithTimeout(
      { cmd: 'identity.market.find_by_ids' },
      { ids: marketIds },
    );
    const markets = marketsResponse?.data ?? [];
    const marketMap = new Map(
      markets.map((market: Record<string, any>) => [String(market.id), market]),
    );

    return rows.map((row) => ({
      ...row,
      market: marketMap.get(String(row.market_id)) ?? null,
    }));
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN, RoleEnum.REGISTRATOR, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create order' })
  @ApiBody({ type: CreateOrderRequestDto })
  async create(@Body() dto: CreateOrderRequestDto, @Req() req: { user: JwtUser }) {
    const { customer, ...orderDto } = dto;
    let customerId = dto.customer_id;
    const roles = req.user.roles ?? [];

    let resolvedMarketId = orderDto.market_id;
    if (roles.includes(RoleEnum.MARKET)) {
      resolvedMarketId = req.user.sub;
    } else if (
      (roles.includes(RoleEnum.ADMIN) ||
        roles.includes(RoleEnum.SUPERADMIN) ||
        roles.includes(RoleEnum.REGISTRATOR)) &&
      !resolvedMarketId
    ) {
      throw new BadRequestException('market_id is required');
    }

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
        .send(
          { cmd: 'order.create' },
          { dto: { ...orderDto, market_id: resolvedMarketId, customer_id: finalCustomerId } },
        )
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

  @Post('external/receive')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive orders from external integration payload' })
  @ApiBody({ type: ReceiveExternalOrdersDto })
  receiveExternalOrders(@Body() dto: ReceiveExternalOrdersDto) {
    return firstValueFrom(
      this.orderClient
        .send({ cmd: 'order.receive_external' }, dto)
        .pipe(timeout(15000)),
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

  @Get('courier/orders')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Legacy courier orders list endpoint' })
  @ApiQuery({ name: 'status', required: false, enum: Order_status })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'startDate', required: false, type: String, description: 'Legacy start date (YYYY-MM-DD or ISO)' })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: 'Legacy end date (YYYY-MM-DD or ISO)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  async findCourierOrdersLegacy(
    @Query('status') status?: Order_status,
    @Query('search') search?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const courierPostsResponse = await this.sendLogisticsWithTimeout(
      { cmd: 'logistics.post.my_for_courier' },
      {
        page: 1,
        limit: 1000,
        requester: { id: req?.user?.sub, roles: req?.user?.roles ?? [] },
      },
    );

    const courierPosts = this.extractRows(courierPostsResponse?.data ?? courierPostsResponse);
    const courierPostIds = Array.from(
      new Set(courierPosts.map((post) => String(post?.id ?? '')).filter(Boolean)),
    );

    if (!courierPostIds.length) {
      return successRes(
        {
          data: [],
          total: 0,
          page: page ? Number(page) : 1,
          limit: limit ? Number(limit) : 10,
          totalPages: 0,
        },
        200,
        'All my orders',
      );
    }

    const payload = {
      query: {
        post_ids: courierPostIds,
        status,
        exclude_statuses: status
          ? undefined
          : [
              Order_status.CREATED,
              Order_status.NEW,
              Order_status.RECEIVED,
              Order_status.ON_THE_ROAD,
            ],
        search,
        start_day: startDate,
        end_day: endDate,
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 10,
      },
    };

    const result = await this.sendOrderWithFallback(
      { cmd: 'order.find_all_enriched' },
      { cmd: 'order.find_all' },
      payload,
    );

    const resultRows = this.extractRows(result?.data ?? result);
    const filteredRows = resultRows.filter((row) =>
      courierPostIds.includes(String(row?.post_id ?? row?.postId ?? '')),
    );
    const legacyData = (this.toLegacyShape(filteredRows) as Array<Record<string, unknown>>)
      .map((row) => this.normalizeLegacyOrderRow(row));
    const total = Number(result?.total ?? legacyData.length);
    const currentPage = Number(result?.page ?? (page ? Number(page) : 1));
    const currentLimit = Number(result?.limit ?? (limit ? Number(limit) : 10));
    const totalPages = currentLimit > 0 ? Math.ceil(total / currentLimit) : 0;

    return successRes(
      {
        data: legacyData,
        total,
        page: currentPage,
        limit: currentLimit,
        totalPages,
      },
      200,
      'All my orders',
    );
  }

  @Get('markets/new')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Markets with NEW orders' })
  async findNewMarkets() {
    const result = await this.sendOrderWithFallback(
      { cmd: 'order.find_new_markets_enriched' },
      { cmd: 'order.find_new_markets' },
      {},
    );

    if (!Array.isArray(result)) {
      return result;
    }

    return this.enrichMarketRows(result);
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

  @Post('sell/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sell order (courier)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiBody({ type: SellOrderRequestDto })
  sellOrder(
    @Param('id') id: string,
    @Body() dto: SellOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.sell' },
          { id, dto, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('cancel/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel order (courier)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiBody({ type: SellOrderRequestDto })
  cancelOrder(
    @Param('id') id: string,
    @Body() dto: SellOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.cancel' },
          { id, dto, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('partly-sell/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Partly sell order (courier)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiBody({ type: PartlySellOrderRequestDto })
  partlySellOrder(
    @Param('id') id: string,
    @Body() dto: PartlySellOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.partly_sell' },
          { id, dto, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('rollback/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rollback sold/cancelled order to waiting' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  rollbackOrder(
    @Param('id') id: string,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.rollback_waiting' },
          { id, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
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
