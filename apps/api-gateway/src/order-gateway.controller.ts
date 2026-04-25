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
  CreateExternalOrderRequestDto,
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

type BranchAssignment = {
  branch_id?: string | null;
  role?: string | null;
};

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
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
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

  private async sendBranchWithTimeout(pattern: { cmd: string }, payload: object) {
    return firstValueFrom(this.branchClient.send(pattern, payload).pipe(timeout(8000))).catch(
      (error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException('Branch service response timeout');
        }
        throw error;
      },
    );
  }

  private isBranchStaffAssignment(assignment?: BranchAssignment | null): boolean {
    const role = String(assignment?.role ?? '').toUpperCase();
    return role === 'MANAGER' || role === 'OPERATOR';
  }

  private async resolveBranchAssignment(reqUser: JwtUser): Promise<BranchAssignment | null> {
    const response = await this.sendBranchWithTimeout(
      { cmd: 'branch.user.find_by_user' },
      {
        user_id: reqUser.sub,
        requester: { id: reqUser.sub, roles: reqUser.roles ?? [] },
      },
    );

    return (response?.data ?? null) as BranchAssignment | null;
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

  private parsePaginationQuery(page?: string, limit?: string) {
    const allowedLimits = [10, 25, 50, 100];
    const parsedLimit = Number(limit ?? 10);
    if (!Number.isFinite(parsedLimit) || !allowedLimits.includes(parsedLimit)) {
      throw new BadRequestException(`limit faqat ${allowedLimits.join(', ')} bo'lishi mumkin`);
    }

    const parsedPage = Number(page ?? 1);
    const normalizedPage =
      Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;

    return { page: normalizedPage, limit: parsedLimit };
  }

  private parseStatusQuery(status?: string | string[]) {
    if (status == null) {
      return undefined;
    }

    const rawValues = Array.isArray(status) ? status : [status];
    const flattened = rawValues
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    if (!flattened.length) {
      return undefined;
    }

    const allowedStatuses = new Set(Object.values(Order_status));
    const invalidValues = flattened.filter((value) => !allowedStatuses.has(value as Order_status));
    if (invalidValues.length) {
      throw new BadRequestException(
        `Noto'g'ri status qiymati: ${invalidValues.join(', ')}`,
      );
    }

    return Array.from(new Set(flattened)) as Order_status[];
  }

  private withPaginationMeta(payload: unknown, fallback: { page: number; limit: number }) {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }
    const body = payload as Record<string, unknown>;
    const rows = this.extractRows(body);
    const total = Number(body.total ?? rows.length ?? 0);
    const page = Number(body.page ?? fallback.page);
    const limit = Number(body.limit ?? fallback.limit);
    const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;

    return {
      ...body,
      data: Array.isArray(body.data) ? body.data : rows,
      total,
      page,
      limit,
      total_pages: totalPages,
      totalPages,
    };
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
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
    RoleEnum.OPERATOR,
    RoleEnum.BRANCH,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create order' })
  @ApiBody({ type: CreateOrderRequestDto })
  async create(@Body() dto: CreateOrderRequestDto, @Req() req: { user: JwtUser }) {
    const { customer, ...orderDto } = dto;
    let customerId = dto.customer_id;
    const roles = req.user.roles ?? [];
    const shouldResolveBranchAssignment =
      roles.includes(RoleEnum.BRANCH) || roles.includes(RoleEnum.OPERATOR);
    const branchAssignment = shouldResolveBranchAssignment
      ? await this.resolveBranchAssignment(req.user)
      : null;
    const isBranchStaff = this.isBranchStaffAssignment(branchAssignment);
    const assignedBranchId = branchAssignment?.branch_id
      ? String(branchAssignment.branch_id)
      : null;

    if (isBranchStaff && !assignedBranchId) {
      throw new BadRequestException('Filial xodimi hech qaysi filialga biriktirilmagan');
    }

    if (isBranchStaff && orderDto.branch_id && String(orderDto.branch_id) !== assignedBranchId) {
      throw new BadRequestException("Filial xodimi boshqa filial uchun order yarata olmaydi");
    }

    if (
      isBranchStaff &&
      typeof orderDto.source !== 'undefined' &&
      String(orderDto.source).toLowerCase() !== 'branch'
    ) {
      throw new BadRequestException("Filial xodimi uchun source faqat 'branch' bo'lishi mumkin");
    }

    let resolvedMarketId = orderDto.market_id;
    if (roles.includes(RoleEnum.MARKET)) {
      resolvedMarketId = req.user.sub;
    } else if (roles.includes(RoleEnum.OPERATOR)) {
      const operatorResponse = await this.sendIdentityWithTimeout(
        { cmd: 'identity.user.find_by_id' },
        { id: req.user.sub },
      );
      const operatorUser = operatorResponse?.data ?? operatorResponse;
      if (!operatorUser?.market_id) {
        throw new BadRequestException('Operator uchun market aniqlanmadi');
      }
      resolvedMarketId = String(operatorUser.market_id);
      if (!orderDto.operator) {
        orderDto.operator = operatorUser.name ?? operatorUser.username ?? null;
      }
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
          {
            dto: {
              ...orderDto,
              market_id: resolvedMarketId,
              customer_id: finalCustomerId,
              operator_id: roles.includes(RoleEnum.OPERATOR) ? req.user.sub : null,
              branch_id: isBranchStaff ? assignedBranchId : (orderDto.branch_id ?? null),
              source: isBranchStaff ? 'branch' : orderDto.source,
            },
            requester: { id: req.user.sub, roles },
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

  @Get('external')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List external orders with filters' })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: Order_status, isArray: true })
  @ApiQuery({ name: 'date', required: false, type: String, description: 'Single day filter (YYYY-MM-DD)' })
  @ApiQuery({ name: 'start_day', required: false, type: String })
  @ApiQuery({ name: 'end_day', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, schema: { default: 1, minimum: 1 } as any })
  @ApiQuery({ name: 'limit', required: false, enum: [10, 25, 50, 100], schema: { default: 10 } as any })
  findAllExternal(
    @Query('market_id') market_id?: string,
    @Query('status') status?: string | string[],
    @Query('date') date?: string,
    @Query('start_day') start_day?: string,
    @Query('end_day') end_day?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const roles = req?.user?.roles ?? [];
    const isMarket = roles.includes(RoleEnum.MARKET);
    const requesterId = req?.user?.sub;

    if (isMarket && market_id && requesterId && String(market_id) !== String(requesterId)) {
      throw new BadRequestException('market role cannot query other market_id');
    }

    const resolvedMarketId = isMarket && requesterId ? requesterId : market_id;
    const resolvedStartDay = start_day ?? date;
    const resolvedEndDay = end_day ?? date;

    const pagination = this.parsePaginationQuery(page, limit);

    const statuses = this.parseStatusQuery(status);

    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.external.find_all' },
          {
            query: {
              market_id: resolvedMarketId,
              status: statuses,
              start_day: resolvedStartDay,
              end_day: resolvedEndDay,
              page: pagination.page,
              limit: pagination.limit,
            },
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    }).then((response) => this.withPaginationMeta(response, pagination));
  }

  @Post('external')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN, RoleEnum.REGISTRATOR, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create external order' })
  @ApiBody({ type: CreateExternalOrderRequestDto })
  async createExternal(@Body() dto: CreateExternalOrderRequestDto, @Req() req: { user: JwtUser }) {
    const { customer, external_id, ...orderDto } = dto;
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

      const customerPayload = {
        ...customer,
        market_id: customer.market_id ?? resolvedMarketId,
      };

      const customerResponse = await firstValueFrom(
        this.identityClient
          .send({ cmd: 'identity.customer.create' }, { dto: customerPayload })
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

    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.external.create' },
          {
            dto: {
              ...orderDto,
              external_id: external_id ?? null,
              market_id: resolvedMarketId,
              customer_id: customerId,
            },
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
  @ApiQuery({ name: 'status', required: false, enum: Order_status, isArray: true })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Customer name/family/phone search' })
  @ApiQuery({ name: 'start_day', required: false, type: String, description: 'Start date (YYYY-MM-DD or ISO)' })
  @ApiQuery({ name: 'end_day', required: false, type: String, description: 'End date (YYYY-MM-DD or ISO)' })
  @ApiQuery({ name: 'courier', required: false, type: String, description: 'Courier (operator text or post_id)' })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({ name: 'branch_id', required: false, type: String })
  @ApiQuery({ name: 'source', required: false, enum: ['internal', 'external', 'branch'] })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, schema: { default: 1, minimum: 1 } as any })
  @ApiQuery({ name: 'limit', required: false, enum: [10, 25, 50, 100], schema: { default: 10 } as any })
  findAll(
    @Query('market_id') market_id?: string,
    @Query('customer_id') customer_id?: string,
    @Query('status') status?: string | string[],
    @Query('search') search?: string,
    @Query('start_day') start_day?: string,
    @Query('end_day') end_day?: string,
    @Query('courier') courier?: string,
    @Query('region_id') region_id?: string,
    @Query('branch_id') branch_id?: string,
    @Query('source') source?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const roles = req?.user?.roles ?? [];
    const isMarket = roles.includes(RoleEnum.MARKET);
    const requesterId = req?.user?.sub;

    if (isMarket && market_id && requesterId && String(market_id) !== String(requesterId)) {
      throw new BadRequestException('market role cannot query other market_id');
    }

    const resolvedMarketId = isMarket && requesterId ? requesterId : market_id;

    const pagination = this.parsePaginationQuery(page, limit);

    const statuses = this.parseStatusQuery(status);

    const payload = {
      query: {
        market_id: resolvedMarketId,
        customer_id,
        status: statuses,
        search,
        start_day,
        end_day,
        courier,
        region_id,
        branch_id,
        source,
        page: pagination.page,
        limit: pagination.limit,
      },
    };

    return this.sendOrderWithFallback(
      { cmd: 'order.find_all_enriched' },
      { cmd: 'order.find_all' },
      payload,
    ).then((response) => this.withPaginationMeta(response, pagination));
  }

  @Get('market/:marketId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List orders by market ID with pagination' })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  @ApiQuery({ name: 'branch_id', required: false, type: String })
  @ApiQuery({ name: 'source', required: false, enum: ['internal', 'external', 'branch'] })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, schema: { default: 1, minimum: 1 } as any })
  @ApiQuery({ name: 'limit', required: false, enum: [10, 25, 50, 100], schema: { default: 10 } as any })
  findAllByMarket(
    @Param('marketId') marketId: string,
    @Query('branch_id') branch_id?: string,
    @Query('source') source?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pagination = this.parsePaginationQuery(page, limit);

    return this.sendOrderWithFallback(
      { cmd: 'order.find_all_enriched' },
      { cmd: 'order.find_all' },
      {
        query: {
          market_id: marketId,
          branch_id,
          source,
          page: pagination.page,
          limit: pagination.limit,
        },
      },
    ).then((response) => this.withPaginationMeta(response, pagination));
  }

  @Get('courier/orders')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Legacy courier orders list endpoint' })
  @ApiQuery({ name: 'status', required: false, enum: Order_status, isArray: true })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'startDate', required: false, type: String, description: 'Legacy start date (YYYY-MM-DD or ISO)' })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: 'Legacy end date (YYYY-MM-DD or ISO)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, schema: { default: 1, minimum: 1 } as any })
  @ApiQuery({ name: 'limit', required: false, enum: [10, 25, 50, 100], schema: { default: 10 } as any })
  async findCourierOrdersLegacy(
    @Query('status') status?: string | string[],
    @Query('search') search?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const pagination = this.parsePaginationQuery(page, limit);

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
          page: pagination.page,
          limit: pagination.limit,
          total_pages: 0,
          totalPages: 0,
        },
        200,
        'All my orders',
      );
    }

    const statuses = this.parseStatusQuery(status);

    const payload = {
      query: {
        post_ids: courierPostIds,
        status: statuses,
        exclude_statuses: statuses?.length
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
        page: pagination.page,
        limit: pagination.limit,
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
    const currentPage = Number(result?.page ?? pagination.page);
    const currentLimit = Number(result?.limit ?? pagination.limit);
    const totalPages = currentLimit > 0 ? Math.ceil(total / currentLimit) : 0;

    return successRes(
      {
        data: legacyData,
        total,
        page: currentPage,
        limit: currentLimit,
        total_pages: totalPages,
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
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, schema: { default: 1, minimum: 1 } as any })
  @ApiQuery({ name: 'limit', required: false, enum: [10, 25, 50, 100], schema: { default: 10 } as any })
  async findNewOrdersByMarket(
    @Param('marketId') marketId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pagination = this.parsePaginationQuery(page, limit);
    const payload = {
      market_id: marketId,
      page: pagination.page,
      limit: pagination.limit,
    };

    return this.sendOrderWithFallback(
      { cmd: 'order.find_new_by_market_enriched' },
      { cmd: 'order.find_new_by_market' },
      payload,
    ).then((response) => this.withPaginationMeta(response, pagination));
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

  @Get('qr-code/:token')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.COURIER,
    RoleEnum.MARKET,
    RoleEnum.REGISTRATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order by QR code (Post Control style)' })
  @ApiParam({ name: 'token', description: 'Order QR token' })
  findByQrCode(@Param('token') token: string) {
    return this.sendOrderWithFallback(
      { cmd: 'order.find_by_qr_enriched' },
      { cmd: 'order.find_by_qr' },
      { token },
    );
  }

  @Get(':id/tracking')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order tracking history by ID' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  getTracking(@Param('id') id: string) {
    return firstValueFrom(
      this.orderClient
        .send({ cmd: 'order.tracking' }, { id })
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
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
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOrderByIdRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.update_normalized' },
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

  @Patch(':id/full')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order by id (full fields)' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  @ApiBody({ type: UpdateOrderByIdRequestDto })
  updateFull(
    @Param('id') id: string,
    @Body() dto: UpdateOrderByIdRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.update_normalized' },
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

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete order (status-based role rules)' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  remove(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return this.orderClient.send(
      { cmd: 'order.delete' },
      { id, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
    );
  }
}
