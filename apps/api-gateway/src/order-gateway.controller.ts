import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { IsArray, IsNotEmpty, IsString } from 'class-validator';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import {
  AssignOrdersToCourierRequestDto,
  CouldNotDeliverOrderRequestDto,
  CreateOrderByTelegramBotRequestDto,
  CreateExternalOrderRequestDto,
  InitiateOrderReturnRequestDto,
  CreateOrderRequestDto,
  HandoverCancelledOrdersToMarketRequestDto,
  OrdersArrayDto,
  PartlySellOrderRequestDto,
  RollbackOrderRequestDto,
  ScanAssignOrderRequestDto,
  SellOrderRequestDto,
  UpdateOrderByIdRequestDto,
} from './dto/order.swagger.dto';
import { Order_status, Roles as RoleEnum, Where_deliver } from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';

interface JwtUser {
  sub: string;
  username: string;
  roles: string[];
  branch_id?: string | null;
}

type BranchAssignment = {
  branch_id?: string | null;
  role?: string | null;
};

type UploadedProofFile = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

const PROOF_OPERATION_TIMEOUT_MS = 60000;

class ReceiveExternalOrdersDto {
  @IsString()
  @IsNotEmpty()
  integration_id!: string;

  @IsArray()
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
    @Optional() @Inject('FILE') private readonly fileClient?: ClientProxy,
  ) {}

  private normalizeRoles(roles?: string[]) {
    const normalized = new Set<string>();
    for (const rawRole of roles ?? []) {
      const role = String(rawRole ?? '')
        .trim()
        .toLowerCase();
      if (!role) {
        continue;
      }
      normalized.add(role);
    }
    return Array.from(normalized);
  }

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
        Object.entries(value as Record<string, unknown>).map(
          ([key, nestedValue]) => [
            this.toSnakeCaseKey(key),
            this.toLegacyShape(nestedValue),
          ],
        ),
      ) as T;
    }

    return value;
  }

  private async sendOrderWithTimeout(
    pattern: { cmd: string },
    payload: object,
  ) {
    return firstValueFrom(
      this.orderClient.send(pattern, payload).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
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

  private async sendIdentityWithTimeout(
    pattern: { cmd: string },
    payload: object,
  ) {
    return firstValueFrom(
      this.identityClient.send(pattern, payload).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Identity service response timeout');
      }
      throw error;
    });
  }

  private async sendLogisticsWithTimeout(
    pattern: { cmd: string },
    payload: object,
  ) {
    return firstValueFrom(
      this.logisticsClient.send(pattern, payload).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Logistics service response timeout');
      }
      throw error;
    });
  }

  private async findAllCourierPostIds(reqUser?: JwtUser): Promise<string[]> {
    const requester = {
      id: reqUser?.sub,
      roles: reqUser?.roles ?? [],
    };
    const firstResponse = await this.sendLogisticsWithTimeout(
      { cmd: 'logistics.post.my_for_courier' },
      { page: 1, limit: 100, requester },
    );
    const firstBody = firstResponse?.data ?? firstResponse;
    const posts = this.extractRows(firstBody);
    const totalPages = Math.max(
      1,
      Number(firstBody?.totalPages ?? firstBody?.total_pages ?? 1),
    );

    if (totalPages > 1) {
      const remainingResponses = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, index) => index + 2).map(
          (postPage) =>
            this.sendLogisticsWithTimeout(
              { cmd: 'logistics.post.my_for_courier' },
              { page: postPage, limit: 100, requester },
            ),
        ),
      );
      remainingResponses.forEach((response) => {
        posts.push(...this.extractRows(response?.data ?? response));
      });
    }

    return Array.from(
      new Set(posts.map((post) => String(post?.id ?? '')).filter(Boolean)),
    );
  }

  private async findCourierCancelledRows(
    reqUser: JwtUser | undefined,
    filters: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    const requesterId = String(reqUser?.sub ?? '').trim();
    if (!requesterId) {
      return [];
    }

    const courierPostIds = await this.findAllCourierPostIds(reqUser).catch(
      () => [],
    );
    const baseQuery = {
      ...filters,
      status: [Order_status.CANCELLED],
      canceled_post_unassigned: true,
      fetch_all: true,
      disable_pagination: true,
      page: undefined,
      limit: undefined,
    };
    const requests = [
      this.sendOrderWithFallback(
        { cmd: 'order.find_all_enriched' },
        { cmd: 'order.find_all' },
        { query: { ...baseQuery, courier_ids: [requesterId] } },
      ),
    ];

    if (courierPostIds.length) {
      requests.push(
        this.sendOrderWithFallback(
          { cmd: 'order.find_all_enriched' },
          { cmd: 'order.find_all' },
          { query: { ...baseQuery, post_ids: courierPostIds } },
        ),
      );
    }

    const responses = await Promise.all(requests);
    const uniqueRows = new Map<string, Record<string, unknown>>();
    responses.flatMap((response) =>
      this.extractRows(response?.data ?? response),
    ).forEach((row) => {
      const id = String(row?.id ?? '').trim();
      if (id) {
        uniqueRows.set(id, row);
      }
    });
    return Array.from(uniqueRows.values());
  }

  private normalizeProofFileKeys(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .flatMap((item) => this.normalizeProofFileKeys(item))
        .filter(Boolean);
    }
    if (typeof value !== 'string') return [];

    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return this.normalizeProofFileKeys(parsed);
    } catch {
      // Keep plain form-data values such as "key1,key2" supported.
    }
    return trimmed
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
  }

  private async uploadProofFile(file?: UploadedProofFile): Promise<string[]> {
    if (!file) return [];
    if (!this.fileClient) {
      throw new BadRequestException('File service is not configured');
    }

    const response = await firstValueFrom(
      this.fileClient
        .send(
          { cmd: 'file.upload' },
          {
            file_name: file.originalname,
            mime_type: file.mimetype,
            file_base64: file.buffer.toString('base64'),
            folder: 'proof',
          },
        )
        .pipe(timeout(PROOF_OPERATION_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('File service response timeout');
      }
      throw error;
    });

    const key = String(
      (response as { data?: { key?: unknown }; key?: unknown })?.data?.key ??
        (response as { key?: unknown })?.key ??
        '',
    ).trim();
    if (!key) {
      throw new BadRequestException('Proof file upload did not return a key');
    }
    return [key];
  }

  private async withUploadedProof<
    T extends { proofFileKeys?: string[]; proofFileKeysVerified?: boolean },
  >(
    dto: T,
    file?: UploadedProofFile,
  ): Promise<T> {
    const existingKeys = this.normalizeProofFileKeys(dto?.proofFileKeys);
    const uploadedKeys = await this.uploadProofFile(file);
    return {
      ...dto,
      proofFileKeys: Array.from(new Set([...existingKeys, ...uploadedKeys])),
      proofFileKeysVerified: uploadedKeys.length > 0 && existingKeys.length === 0,
    };
  }

  private async sendBranchWithTimeout(
    pattern: { cmd: string },
    payload: object,
  ) {
    return firstValueFrom(
      this.branchClient.send(pattern, payload).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Branch service response timeout');
      }
      throw error;
    });
  }

  private isBranchStaffAssignment(
    assignment?: BranchAssignment | null,
  ): boolean {
    const role = String(assignment?.role ?? '').toUpperCase();
    return role === 'MANAGER' || role === 'REGISTRATOR' || role === 'BRANCH';
  }

  /**
   * Object-level authorization for reading a SINGLE order (find_by_id, tracking).
   * Order ids are sequential bigints, so without this any authenticated account
   * could enumerate every order's financials + customer PII (IDOR). Mirrors the
   * list-endpoint scoping. Throws ForbiddenException when not allowed.
   */
  private async assertCanViewOrder(
    reqUser: JwtUser | undefined,
    order: Record<string, any> | null | undefined,
  ): Promise<void> {
    if (!order || typeof order !== 'object') {
      return; // nothing fetched (not-found) — let the normal response through
    }
    const roles = this.normalizeRoles(reqUser?.roles);
    // Internal full-access staff (consistent with the unscoped list endpoint).
    if (
      roles.includes(RoleEnum.SUPERADMIN) ||
      roles.includes(RoleEnum.ADMIN) ||
      roles.includes(RoleEnum.OPERATOR) ||
      roles.includes(RoleEnum.MARKET_OPERATOR)
    ) {
      return;
    }
    const sub = String(reqUser?.sub ?? '').trim();
    const field = (key: string): string =>
      String(order?.[key] ?? order?.[this.toCamelKey(key)] ?? '').trim();
    const denied = (): never => {
      throw new ForbiddenException("Bu buyurtmani ko'rishga ruxsat yo'q");
    };

    if (roles.includes(RoleEnum.MARKET)) {
      return sub && field('market_id') === sub ? undefined : denied();
    }
    if (roles.includes(RoleEnum.CUSTOMER)) {
      return sub && field('customer_id') === sub ? undefined : denied();
    }
    if (roles.includes(RoleEnum.COURIER)) {
      return sub && field('courier_id') === sub ? undefined : denied();
    }
    if (
      roles.includes(RoleEnum.BRANCH) ||
      roles.includes(RoleEnum.MANAGER) ||
      roles.includes(RoleEnum.REGISTRATOR)
    ) {
      const assignment = await this.resolveBranchAssignment(reqUser as JwtUser);
      const branchId = String(assignment?.branch_id ?? '').trim();
      const orderBranches = [
        field('branch_id'),
        field('holder_branch_id'),
        field('home_branch_id'),
      ];
      return branchId && orderBranches.includes(branchId)
        ? undefined
        : denied();
    }
    // investor / unknown roles: no per-order access.
    return denied();
  }

  private async assertCanViewOrderTracking(
    reqUser: JwtUser | undefined,
    order: Record<string, any> | null | undefined,
  ): Promise<void> {
    if (!order || typeof order !== 'object') {
      return;
    }

    const roles = this.normalizeRoles(reqUser?.roles);
    if (roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN)) {
      return;
    }

    const sub = String(reqUser?.sub ?? '').trim();
    const field = (key: string): string =>
      String(order?.[key] ?? order?.[this.toCamelKey(key)] ?? '').trim();
    const holderType = field('holder_type').toUpperCase();
    const denied = (): never => {
      throw new ForbiddenException("Bu buyurtma trackingini ko'rishga ruxsat yo'q");
    };

    if (roles.includes(RoleEnum.COURIER)) {
      return sub &&
        holderType === 'COURIER' &&
        field('holder_courier_id') === sub
        ? undefined
        : denied();
    }

    if (
      roles.includes(RoleEnum.BRANCH) ||
      roles.includes(RoleEnum.MANAGER) ||
      roles.includes(RoleEnum.REGISTRATOR)
    ) {
      const assignment = await this.resolveBranchAssignment(reqUser as JwtUser);
      const branchId = String(assignment?.branch_id ?? '').trim();
      return branchId &&
        holderType === 'BRANCH' &&
        field('holder_branch_id') === branchId
        ? undefined
        : denied();
    }

    return denied();
  }

  private toCamelKey(snake: string): string {
    return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }

  private async resolveBranchAssignment(
    reqUser: JwtUser,
  ): Promise<BranchAssignment | null> {
    const normalizedRoles = this.normalizeRoles(reqUser.roles);
    const jwtBranchId = String(reqUser?.branch_id ?? '').trim();
    const canUseJwtBranch =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);

    if (canUseJwtBranch && jwtBranchId) {
      const inferredRole =
        normalizedRoles.find((role) =>
          [RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR].includes(
            role as RoleEnum,
          ),
        ) ?? RoleEnum.BRANCH;
      return {
        branch_id: jwtBranchId,
        role: inferredRole.toUpperCase(),
      };
    }

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
    return this.normalizeOrderStatusForDisplay(normalized);
  }

  private normalizeOrderStatusForDisplay(row: Record<string, unknown>) {
    const normalized = { ...row };
    if (String(normalized.status ?? '') === Order_status.CANCELLED_SENT) {
      normalized.status = Order_status.CANCELLED;
      delete normalized.transport_status;
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
      throw new BadRequestException(
        `limit faqat ${allowedLimits.join(', ')} bo'lishi mumkin`,
      );
    }

    const parsedPage = Number(page ?? 1);
    const normalizedPage =
      Number.isFinite(parsedPage) && parsedPage >= 1
        ? Math.floor(parsedPage)
        : 1;

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
    const invalidValues = flattened.filter(
      (value) => !allowedStatuses.has(value as Order_status),
    );
    if (invalidValues.length) {
      throw new BadRequestException(
        `Noto'g'ri status qiymati: ${invalidValues.join(', ')}`,
      );
    }

    const statuses = flattened;

    return Array.from(new Set(statuses)) as Order_status[];
  }

  private withPaginationMeta(
    payload: unknown,
    fallback: { page: number; limit: number },
  ) {
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
      data: (Array.isArray(body.data) ? body.data : rows).map((row) =>
        row && typeof row === 'object'
          ? this.normalizeOrderStatusForDisplay(row as Record<string, unknown>)
          : row,
      ),
      total,
      page,
      limit,
      total_pages: totalPages,
      totalPages,
    };
  }

  private toManagerCancelledTabResponse(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    const body = payload as Record<string, unknown>;
    const rows = this.extractRows(body);
    const data = rows.map((row) => {
      const realStatus = String(row.status ?? '');
      if (realStatus !== Order_status.CANCELLED_SENT) {
        return row;
      }

      return {
        ...row,
        status: Order_status.CANCELLED,
      };
    });

    return { ...body, data };
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
    RoleEnum.MANAGER,
    RoleEnum.BRANCH,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create order' })
  @ApiBody({ type: CreateOrderRequestDto })
  async create(
    @Body() dto: CreateOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    const { customer, ...orderDto } = dto;
    let customerId = dto.customer_id;
    const roles = this.normalizeRoles(req.user.roles);
    const shouldResolveBranchAssignment =
      roles.includes(RoleEnum.BRANCH) ||
      roles.includes(RoleEnum.MANAGER) ||
      roles.includes(RoleEnum.REGISTRATOR);
    const branchAssignment = shouldResolveBranchAssignment
      ? await this.resolveBranchAssignment(req.user)
      : null;
    const isBranchStaff = this.isBranchStaffAssignment(branchAssignment);
    const assignedBranchId = branchAssignment?.branch_id
      ? String(branchAssignment.branch_id)
      : null;

    if (isBranchStaff && !assignedBranchId) {
      throw new BadRequestException(
        'Filial xodimi hech qaysi filialga biriktirilmagan',
      );
    }

    if (
      isBranchStaff &&
      orderDto.branch_id &&
      String(orderDto.branch_id) !== assignedBranchId
    ) {
      throw new BadRequestException(
        'Filial xodimi boshqa filial uchun order yarata olmaydi',
      );
    }

    if (
      isBranchStaff &&
      typeof orderDto.source !== 'undefined' &&
      String(orderDto.source).toLowerCase() !== 'branch'
    ) {
      throw new BadRequestException(
        "Filial xodimi uchun source faqat 'branch' bo'lishi mumkin",
      );
    }

    let resolvedMarketId = orderDto.market_id;
    if (roles.includes(RoleEnum.MARKET)) {
      resolvedMarketId = req.user.sub;
    } else if (roles.includes(RoleEnum.MARKET_OPERATOR)) {
      // An operator (incl. the telegram bot) is linked to a market via
      // user.market_id — resolve it server-side. The bot DTO carries no
      // market_id, so without this the order.create insert hit a NOT-NULL
      // violation and orphaned the just-created customer. Resolving BEFORE the
      // customer is created also avoids the orphan on failure. (Audit I6.)
      const operatorProfile = await this.sendIdentityWithTimeout(
        { cmd: 'identity.user.find_by_id' },
        { id: req.user.sub },
      ).catch(() => null);
      const operatorData =
        (operatorProfile as { data?: { market_id?: string | null } })?.data ??
        null;
      resolvedMarketId =
        String(operatorData?.market_id ?? '').trim() || undefined;
      if (!resolvedMarketId) {
        throw new BadRequestException(
          "Operator hech qaysi marketga biriktirilmagan — buyurtma yaratib bo'lmaydi",
        );
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
        throw new BadRequestException(
          'customer_id yoki customer obyekt yuborilishi shart',
        );
      }

      const customerResponse = await firstValueFrom(
        this.identityClient
          .send({ cmd: 'identity.customer.create' }, { dto: customer })
          .pipe(timeout(8000)),
      ).catch((error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException(
            'Identity service response timeout',
          );
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
              operator_id:
                roles.includes(RoleEnum.REGISTRATOR) ||
                roles.includes(RoleEnum.MARKET_OPERATOR)
                  ? req.user.sub
                  : null,
              branch_id: isBranchStaff
                ? assignedBranchId
                : (orderDto.branch_id ?? null),
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

  @Post('telegram/bot/create')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET_OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create order by telegram bot' })
  @ApiBody({ type: CreateOrderByTelegramBotRequestDto })
  async botOrderCreate(
    @Body() dto: CreateOrderByTelegramBotRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    const mappedDto: CreateOrderRequestDto = {
      customer: {
        name: dto.name,
        phone_number: dto.phone_number,
        district_id: dto.district_id,
        extra_number: dto.extra_number,
        address: dto.address,
      },
      where_deliver: dto.where_deliver ?? Where_deliver.CENTER,
      total_price: dto.total_price,
      status: Order_status.CREATED,
      comment: dto.comment ?? null,
      operator: dto.operator ?? null,
      items: dto.order_item_info,
    };

    return this.create(mappedDto, req);
  }

  @Post('receive')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive new orders' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiBody({ type: OrdersArrayDto })
  receiveNewOrders(
    @Body() dto: OrdersArrayDto,
    @Query('search') search?: string,
  ) {
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
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List external orders with filters' })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: Order_status,
    isArray: true,
  })
  @ApiQuery({
    name: 'date',
    required: false,
    type: String,
    description: 'Single day filter (YYYY-MM-DD)',
  })
  @ApiQuery({ name: 'start_day', required: false, type: String })
  @ApiQuery({ name: 'end_day', required: false, type: String })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    schema: { default: 1, minimum: 1 } as any,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    enum: [10, 25, 50, 100],
    schema: { default: 10 } as any,
  })
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

    if (
      isMarket &&
      market_id &&
      requesterId &&
      String(market_id) !== String(requesterId)
    ) {
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
    )
      .catch((error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException('Order service response timeout');
        }
        throw error;
      })
      .then((response) => this.withPaginationMeta(response, pagination));
  }

  @Post('external')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create external order' })
  @ApiBody({ type: CreateExternalOrderRequestDto })
  async createExternal(
    @Body() dto: CreateExternalOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    const { customer, external_id, ...orderDto } = dto;
    let customerId = dto.customer_id;
    const roles = this.normalizeRoles(req.user.roles);

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
        throw new BadRequestException(
          'customer_id yoki customer obyekt yuborilishi shart',
        );
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
          throw new GatewayTimeoutException(
            'Identity service response timeout',
          );
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
  @ApiQuery({
    name: 'status',
    required: false,
    enum: Order_status,
    isArray: true,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Customer name/family/phone search',
  })
  @ApiQuery({
    name: 'start_day',
    required: false,
    type: String,
    description: 'Start date (YYYY-MM-DD or ISO)',
  })
  @ApiQuery({
    name: 'end_day',
    required: false,
    type: String,
    description: 'End date (YYYY-MM-DD or ISO)',
  })
  @ApiQuery({
    name: 'courier',
    required: false,
    type: String,
    description: 'Courier (operator text or post_id)',
  })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({ name: 'district_id', required: false, type: String })
  @ApiQuery({ name: 'branch_id', required: false, type: String })
  @ApiQuery({
    name: 'source',
    required: false,
    enum: ['internal', 'external', 'branch'],
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    schema: { default: 1, minimum: 1 } as any,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    enum: [10, 25, 50, 100],
    schema: { default: 10 } as any,
  })
  async findAll(
    @Query('market_id') market_id?: string,
    @Query('customer_id') customer_id?: string,
    @Query('status') status?: string | string[],
    @Query('search') search?: string,
    @Query('start_day') start_day?: string,
    @Query('end_day') end_day?: string,
    @Query('courier') courier?: string,
    @Query('region_id') region_id?: string,
    @Query('district_id') district_id?: string,
    @Query('branch_id') branch_id?: string,
    @Query('courier_ids') courier_ids?: string | string[],
    @Query('fetch_all') fetch_all?: string,
    @Query('source') source?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    const isMarket = normalizedRoles.includes(RoleEnum.MARKET);
    const isCourier = normalizedRoles.includes(RoleEnum.COURIER);
    const isSystemPrivilegedRequester =
      normalizedRoles.includes(RoleEnum.ADMIN) ||
      normalizedRoles.includes(RoleEnum.SUPERADMIN);
    const isBranchScopedRequester =
      !isCourier &&
      (normalizedRoles.includes(RoleEnum.BRANCH) ||
        normalizedRoles.includes(RoleEnum.MANAGER) ||
        normalizedRoles.includes(RoleEnum.REGISTRATOR));
    const requesterId = req?.user?.sub;

    if (
      isMarket &&
      market_id &&
      requesterId &&
      String(market_id) !== String(requesterId)
    ) {
      throw new BadRequestException('market role cannot query other market_id');
    }

    const resolvedMarketId = isMarket && requesterId ? requesterId : market_id;
    let resolvedBranchId = branch_id;

    if (isBranchScopedRequester && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      resolvedBranchId = String(assignment.branch_id);
    }

    const pagination = this.parsePaginationQuery(page, limit);
    const normalizedCourierIds = (Array.isArray(courier_ids) ? courier_ids : courier_ids ? [courier_ids] : [])
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim())
      .filter(Boolean);
    const useFetchAll = String(fetch_all ?? '').toLowerCase() === 'true';

    const statuses = this.parseStatusQuery(status);
    const isCancelledTab =
      Boolean(statuses?.length) &&
      statuses!.every(
        (value) =>
          value === Order_status.CANCELLED ||
          value === Order_status.CANCELLED_SENT,
      );
    const isBranchCancelledTab = isBranchScopedRequester && isCancelledTab;
    const isHqCancelledTab = isSystemPrivilegedRequester && isCancelledTab;
    const resolvedStatuses =
      (isCourier || isBranchCancelledTab || isHqCancelledTab) && isCancelledTab
        ? [Order_status.CANCELLED]
        : statuses;
    const resolvedCourierIds =
      isCourier && requesterId
        ? [String(requesterId)]
        : normalizedCourierIds.length
          ? normalizedCourierIds
          : undefined;

    if (isCourier && isCancelledTab) {
      const allCancelledRows = await this.findCourierCancelledRows(req?.user, {
        market_id: resolvedMarketId,
        customer_id,
        search,
        start_day,
        end_day,
        region_id,
        district_id,
        source,
      });
      const total = allCancelledRows.length;
      const offset = (pagination.page - 1) * pagination.limit;
      const data = allCancelledRows.slice(offset, offset + pagination.limit);
      const totalPages = Math.ceil(total / pagination.limit);

      return {
        data,
        total,
        page: pagination.page,
        limit: pagination.limit,
        total_pages: totalPages,
        totalPages,
      };
    }

    const payload = {
      query: {
        market_id: resolvedMarketId,
        customer_id,
        status: resolvedStatuses,
        search,
        start_day,
        end_day,
        courier,
        courier_ids: resolvedCourierIds,
        fetch_all: useFetchAll || undefined,
        region_id,
        district_id,
        branch_id: resolvedBranchId,
        holder_type: isBranchCancelledTab
          ? 'BRANCH'
          : isHqCancelledTab
            ? 'HQ'
            : undefined,
        canceled_post_unassigned:
          isBranchCancelledTab || isHqCancelledTab ? true : undefined,
        source,
        page: pagination.page,
        limit: pagination.limit,
      },
    };

    return this.sendOrderWithFallback(
      { cmd: 'order.find_all_enriched' },
      { cmd: 'order.find_all' },
      payload,
    ).then((response) => {
      return this.withPaginationMeta(response, pagination);
    });
  }

  @Get('market/:marketId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List orders by market ID with pagination' })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  @ApiQuery({ name: 'branch_id', required: false, type: String })
  @ApiQuery({ name: 'courier_ids', required: false, type: String, isArray: true })
  @ApiQuery({ name: 'fetch_all', required: false, type: Boolean })
  @ApiQuery({
    name: 'source',
    required: false,
    enum: ['internal', 'external', 'branch'],
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    schema: { default: 1, minimum: 1 } as any,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    enum: [10, 25, 50, 100],
    schema: { default: 10 } as any,
  })
  findAllByMarket(
    @Param('marketId') marketId: string,
    @Query('branch_id') branch_id?: string,
    @Query('source') source?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    // A market role may only list its OWN orders — block cross-market reads.
    const roles = this.normalizeRoles(req?.user?.roles);
    if (
      roles.includes(RoleEnum.MARKET) &&
      String(req?.user?.sub ?? '') !== String(marketId)
    ) {
      throw new ForbiddenException('market role cannot query other market_id');
    }
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
  @Get('courier-orders')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Legacy courier orders list endpoint' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: Order_status,
    isArray: true,
  })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'Legacy start date (YYYY-MM-DD or ISO)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description: 'Legacy end date (YYYY-MM-DD or ISO)',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    schema: { default: 1, minimum: 1 } as any,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    enum: [10, 25, 50, 100],
    schema: { default: 10 } as any,
  })
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
    const statuses = this.parseStatusQuery(status);
    const cancelledTabStatuses = [
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
    ];
    const isCancelledTab =
      Boolean(statuses?.length) &&
      statuses!.every((value) => cancelledTabStatuses.includes(value));
    if (isCancelledTab) {
      const allCancelledRows = await this.findCourierCancelledRows(req?.user, {
        search,
        start_day: startDate,
        end_day: endDate,
      });
      const total = allCancelledRows.length;
      const offset = (pagination.page - 1) * pagination.limit;
      const pageRows = allCancelledRows.slice(
        offset,
        offset + pagination.limit,
      );
      const legacyData = this.toLegacyShape(pageRows).map((row) =>
        this.normalizeLegacyOrderRow(row),
      );
      const totalPages = Math.ceil(total / pagination.limit);

      return successRes(
        {
          data: legacyData,
          total,
          page: pagination.page,
          limit: pagination.limit,
          total_pages: totalPages,
          totalPages,
        },
        200,
        'All my orders',
      );
    }

    const courierPostIds = await this.findAllCourierPostIds(req?.user);
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

    let filteredRows: any[];
    let total: number;
    let currentPage = pagination.page;
    let currentLimit = pagination.limit;

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
    filteredRows = resultRows.filter((row) =>
      courierPostIds.includes(String(row?.post_id ?? row?.postId ?? '')),
    );
    total = Number(result?.total ?? filteredRows.length);
    currentPage = Number(result?.page ?? pagination.page);
    currentLimit = Number(result?.limit ?? pagination.limit);

    const legacyData = this.toLegacyShape(filteredRows).map((row) =>
      this.normalizeLegacyOrderRow(row),
    );
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
  async findNewMarkets(@Req() req?: { user: JwtUser }) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    const isBranchScopedRequester =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);

    let resolvedBranchId: string | undefined;
    let excludeBranchSource = false;

    if (isBranchScopedRequester && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      resolvedBranchId = String(assignment.branch_id);
    } else {
      excludeBranchSource = true;
    }

    const result = await this.sendOrderWithFallback(
      { cmd: 'order.find_new_markets_enriched' },
      { cmd: 'order.find_new_markets' },
      {
        branch_id: resolvedBranchId,
        exclude_branch_source: excludeBranchSource,
      },
    );

    if (!Array.isArray(result)) {
      return result;
    }

    return this.enrichMarketRows(result);
  }

  @Get('markets/cancelled')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Markets with CANCELLED orders' })
  async findCancelledMarkets(@Req() req?: { user: JwtUser }) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    const isMarket = normalizedRoles.includes(RoleEnum.MARKET);
    const isBranchScopedRequester =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);

    let branchId: string | undefined;
    let holderType: 'HQ' | 'BRANCH' | undefined = 'HQ';
    let excludeBranchSource = false;
    let marketId: string | undefined;

    if (isMarket) {
      if (!req?.user?.sub) {
        throw new BadRequestException('Market aniqlanmadi');
      }
      marketId = String(req.user.sub);
      holderType = undefined;
      excludeBranchSource = false;
    } else if (isBranchScopedRequester && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      branchId = String(assignment.branch_id);
      holderType = 'BRANCH';
      excludeBranchSource = false;
    }

    return this.sendOrderWithTimeout(
      { cmd: 'order.find_cancelled_markets_enriched' },
      {
        market_id: marketId,
        branch_id: branchId,
        holder_type: holderType,
        exclude_branch_source: excludeBranchSource,
      },
    );
  }

  @Get('branch/orders')
  @Get('branch/cancelled')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Branch tomonidan qabul qilingan va hali HQga yuborilmagan canceled orderlar',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [Order_status.CANCELLED],
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    schema: { default: 1, minimum: 1 } as any,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    enum: [10, 25, 50, 100],
    schema: { default: 10 } as any,
  })
  async findBranchCancelledOrders(
    @Query('status') status?: string | string[],
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    if (!req?.user) {
      throw new BadRequestException('Foydalanuvchi aniqlanmadi');
    }

    const assignment = await this.resolveBranchAssignment(req.user);
    if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
      throw new BadRequestException('Branch user branchga biriktirilmagan');
    }

    const pagination = this.parsePaginationQuery(page, limit);
    const statuses = this.parseStatusQuery(status);
    if (
      statuses?.length &&
      !statuses.every((value) => value === Order_status.CANCELLED)
    ) {
      throw new BadRequestException(
        'Branch canceled orders endpoint faqat cancelled status uchun',
      );
    }
    const payload = {
      query: {
        branch_id: String(assignment.branch_id),
        status: [Order_status.CANCELLED],
        holder_type: 'BRANCH',
        canceled_post_unassigned: true,
        page: pagination.page,
        limit: pagination.limit,
      },
    };

    return this.sendOrderWithFallback(
      { cmd: 'order.find_all_enriched' },
      { cmd: 'order.find_all' },
      payload,
    ).then((response) =>
      this.toManagerCancelledTabResponse(
        this.withPaginationMeta(response, pagination),
      ),
    );
  }

  @Get('markets/:marketId/new')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'NEW orders by market id' })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  async findNewOrdersByMarket(
    @Param('marketId') marketId: string,
    @Req() req?: { user: JwtUser },
  ) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    if (
      normalizedRoles.includes(RoleEnum.MARKET) &&
      String(req?.user?.sub ?? '') !== String(marketId)
    ) {
      throw new ForbiddenException('market role cannot query other market_id');
    }
    const isBranchScopedRequester =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);

    let resolvedBranchId: string | undefined;
    let excludeBranchSource = false;

    if (isBranchScopedRequester && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      resolvedBranchId = String(assignment.branch_id);
    } else {
      excludeBranchSource = true;
    }

    const payload = {
      market_id: marketId,
      branch_id: resolvedBranchId,
      exclude_branch_source: excludeBranchSource,
    };

    return this.sendOrderWithFallback(
      { cmd: 'order.find_new_by_market_enriched' },
      { cmd: 'order.find_new_by_market' },
      payload,
    );
  }

  @Get('markets/:marketId/cancelled')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'CANCELLED orders by market id' })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  async findCancelledOrdersByMarket(
    @Param('marketId') marketId: string,
    @Req() req?: { user: JwtUser },
  ) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    const isMarket = normalizedRoles.includes(RoleEnum.MARKET);
    const isBranchScopedRequester =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);

    let branchId: string | undefined;
    let holderType: 'HQ' | 'BRANCH' | undefined = 'HQ';
    let excludeBranchSource = false;

    if (isMarket) {
      if (!req?.user?.sub || String(req.user.sub) !== String(marketId)) {
        throw new ForbiddenException(
          'Market faqat o‘zining canceled orderlarini ko‘ra oladi',
        );
      }
      excludeBranchSource = false;
    } else if (isBranchScopedRequester && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      branchId = String(assignment.branch_id);
      holderType = 'BRANCH';
      excludeBranchSource = false;
    }

    return this.sendOrderWithTimeout(
      { cmd: 'order.find_cancelled_by_market_enriched' },
      {
        market_id: marketId,
        branch_id: branchId,
        holder_type: holderType,
        exclude_branch_source: excludeBranchSource,
      },
    );
  }

  @Post('markets/:marketId/cancelled/qr')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Market canceled order handover uchun 2 daqiqalik QR olish',
  })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  async createCancelledMarketHandoverQr(
    @Param('marketId') marketId: string,
    @Req() req: { user: JwtUser },
  ) {
    if (String(req.user.sub) !== String(marketId)) {
      throw new ForbiddenException('Market faqat o‘zi uchun QR yarata oladi');
    }

    return this.sendOrderWithTimeout(
      { cmd: 'order.market_cancelled_handover.create_qr' },
      {
        market_id: marketId,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
  }

  @Post('markets/:marketId/cancelled/handover')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Selected CANCELLED orderlarni QR ruxsati bilan marketga topshirish',
  })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  @ApiBody({ type: HandoverCancelledOrdersToMarketRequestDto })
  handoverCancelledOrdersToMarket(
    @Param('marketId') marketId: string,
    @Body() dto: HandoverCancelledOrdersToMarketRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendOrderWithTimeout(
      { cmd: 'order.market_cancelled_handover.complete' },
      {
        market_id: marketId,
        order_ids: dto.order_ids,
        authorization_token: dto.authorization_token,
        manual_overrides: dto.manual_overrides,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order by ID' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  async findById(@Param('id') id: string, @Req() req?: { user: JwtUser }) {
    const response = await this.sendOrderWithFallback(
      { cmd: 'order.find_by_id_enriched' },
      { cmd: 'order.find_by_id' },
      { id },
    );
    await this.assertCanViewOrder(req?.user, (response as any)?.data);
    return response;
  }

  @Get('qr-code/:token')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
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

  @Post('scan-assign')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Scan QR and assign order to current courier' })
  @ApiBody({ type: ScanAssignOrderRequestDto })
  scanAssignOrder(
    @Body() dto: ScanAssignOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendLogisticsWithTimeout(
      { cmd: 'logistics.order.scan_assign' },
      {
        dto,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
  }

  @Post('assign-to-courier')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Manager bulk-assign orders to one courier' })
  @ApiBody({ type: AssignOrdersToCourierRequestDto })
  assignOrdersToCourier(
    @Body() dto: AssignOrdersToCourierRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendLogisticsWithTimeout(
      { cmd: 'logistics.order.assign_to_courier' },
      {
        dto,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
  }

  @Get(':id/tracking')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.COURIER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order tracking history by ID' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  async getTracking(
    @Param('id') id: string,
    @Query('page') pageRaw?: string,
    @Query('limit') limitRaw?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const page = Math.max(1, Number(pageRaw) || 1);
    const limit = Math.min(100, Math.max(1, Number(limitRaw) || 20));

    // Authorize against the order itself before exposing its movement history.
    const order = await this.sendOrderWithFallback(
      { cmd: 'order.find_by_id_enriched' },
      { cmd: 'order.find_by_id' },
      { id },
    );
    await this.assertCanViewOrderTracking(req?.user, (order as any)?.data);
    return firstValueFrom(
      this.orderClient
        .send({ cmd: 'order.tracking' }, { id, page, limit })
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
  @Roles(RoleEnum.COURIER, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sell order (courier)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({ type: SellOrderRequestDto })
  @UseInterceptors(
    FileInterceptor('proof', {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async sellOrder(
    @Param('id') id: string,
    @Body() dto: SellOrderRequestDto,
    @UploadedFile() proof: UploadedProofFile | undefined,
    @Req() req: { user: JwtUser },
  ) {
    const dtoWithProof = await this.withUploadedProof(dto, proof);
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.sell' },
          {
            id,
            dto: dtoWithProof,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: randomUUID(),
          },
        )
        .pipe(timeout(PROOF_OPERATION_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('cancel/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel order (courier)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({ type: SellOrderRequestDto })
  @UseInterceptors(
    FileInterceptor('proof', {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async cancelOrder(
    @Param('id') id: string,
    @Body() dto: SellOrderRequestDto,
    @UploadedFile() proof: UploadedProofFile | undefined,
    @Req() req: { user: JwtUser },
  ) {
    const dtoWithProof = await this.withUploadedProof(dto, proof);
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.cancel' },
          {
            id,
            dto: dtoWithProof,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: randomUUID(),
          },
        )
        .pipe(timeout(PROOF_OPERATION_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('settlement/courier-to-branch')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Settle a courier lump-sum payment to the branch (FIFO per order)',
  })
  settlementCourierToBranch(
    @Body() dto: { courier_id: string; amount: number },
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.settlement.courier_to_branch' },
          {
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: randomUUID(),
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

  @Post('settlement/branch-to-hq')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MANAGER, RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Settle a branch lump-sum remittance to HQ (FIFO per order)',
  })
  settlementBranchToHq(
    @Body() dto: { branch_id: string; amount: number },
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.settlement.branch_to_hq' },
          {
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: randomUUID(),
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

  @Post('settlement/hq-to-market')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Settle an HQ lump-sum payment to a market (FIFO per order)',
  })
  settlementHqToMarket(
    @Body() dto: { market_id: string; amount: number },
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.settlement.hq_to_market' },
          {
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: randomUUID(),
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

  @Get(':id/settlement')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the per-order settlement state' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  getOrderSettlement(@Param('id') id: string) {
    return firstValueFrom(
      this.orderClient
        .send({ cmd: 'order.settlement.find_by_order' }, { id })
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post(':id/could-not-deliver')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mark order as couldn't deliver (courier)" })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiBody({ type: CouldNotDeliverOrderRequestDto })
  couldNotDeliverOrder(
    @Param('id') id: string,
    @Body() dto: CouldNotDeliverOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.could_not_deliver' },
          {
            id,
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: randomUUID(),
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

  @Post('partly-sell/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Partly sell order (courier)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({ type: PartlySellOrderRequestDto })
  @UseInterceptors(
    FileInterceptor('proof', {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async partlySellOrder(
    @Param('id') id: string,
    @Body() dto: PartlySellOrderRequestDto,
    @UploadedFile() proof: UploadedProofFile | undefined,
    @Req() req: { user: JwtUser },
  ) {
    const dtoWithProof = await this.withUploadedProof(dto, proof);
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.partly_sell' },
          {
            id,
            dto: dtoWithProof,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: randomUUID(),
          },
        )
        .pipe(timeout(PROOF_OPERATION_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('rollback/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MANAGER, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Rollback sold/cancelled order to waiting/cancelled/cancelled_sent',
  })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiBody({ type: RollbackOrderRequestDto, required: false })
  rollbackOrder(
    @Param('id') id: string,
    @Body() dto: RollbackOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.rollback_waiting' },
          {
            id,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            dto,
            request_id: randomUUID(),
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

  @Post(':id/initiate-return')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Initiate order return (HQ)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiBody({ type: InitiateOrderReturnRequestDto })
  initiateReturn(
    @Param('id') id: string,
    @Body() dto: InitiateOrderReturnRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.initiate_return' },
          {
            id,
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
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

  @Post(':id/mark-returned-to-market')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark order as returned to market (branch)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  markReturnedToMarket(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.mark_returned_to_market' },
          {
            id,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
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

  // Full order edit (money/status fields) — SUPERADMIN/ADMIN/REGISTRATOR only
  // (audit 2026-06-07: was JwtAuthGuard-only, letting any role rewrite any order).
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
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
          {
            id,
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
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

  @Patch(':id/full')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
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
          {
            id,
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
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
      {
        id,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
  }
}
