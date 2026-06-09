import {
  Body,
  Controller,
  ForbiddenException,
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
import { Roles } from './auth/roles.decorator';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import {
  Cashbox_type,
  Operation_type,
  Order_status,
  Roles as RoleEnum,
  Source_type,
  Where_deliver,
} from '@app/common';
import {
  CashboxAllInfoQueryDto,
  CloseShiftRequestDto,
  CreateCashboxRequestDto,
  CreateOperatorPaymentRequestDto,
  CreateSalaryRequestDto,
  RecordFinancialBalanceRequestDto,
  FindCashboxByUserQueryDto,
  FindHistoryQueryDto,
  FindShiftQueryDto,
  MainCashboxFilterQueryDto,
  MainCashboxManualRequestDto,
  OpenShiftRequestDto,
  PaymentBranchToMainRequestDto,
  PaymentFromCourierRequestDto,
  PaymentToMarketRequestDto,
  UpdateCashboxBalanceRequestDto,
  UpdateSalaryRequestDto,
} from './dto/finance.swagger.dto';

interface JwtUser {
  sub: string;
  roles?: string[];
  branch_id?: string | null;
}

@ApiTags('Finance')
@Controller('finance')
export class FinanceGatewayController {
  constructor(
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
  ) {}

  private async send<T = any>(
    pattern: object,
    payload: object,
    timeoutMs = 8000,
  ): Promise<T> {
    return firstValueFrom(
      this.financeClient.send(pattern, payload).pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Finance service response timeout');
      }
      throw error;
    });
  }

  private async sendIdentity<T = any>(
    pattern: object,
    payload: object,
    timeoutMs = 8000,
  ): Promise<T> {
    return firstValueFrom(
      this.identityClient.send(pattern, payload).pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Identity service response timeout');
      }
      throw error;
    });
  }

  private async sendOrder<T = any>(
    pattern: object,
    payload: object,
    timeoutMs = 8000,
  ): Promise<T> {
    return firstValueFrom(
      this.orderClient.send(pattern, payload).pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  private async sendBranch<T = any>(
    pattern: object,
    payload: object,
    timeoutMs = 8000,
  ): Promise<T> {
    return firstValueFrom(
      this.branchClient.send(pattern, payload).pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Branch service response timeout');
      }
      throw error;
    });
  }

  private async attachCreatedByUsersToHistory(response: any) {
    const histories = response?.data?.cashboxHistory;
    if (!Array.isArray(histories) || !histories.length) {
      return response;
    }

    response.data.cashboxHistory = await this.attachCreatedByUsers(histories);

    return response;
  }

  private async attachCreatedByUsers(histories: any[]) {
    if (!Array.isArray(histories) || !histories.length) {
      return histories;
    }

    const createdByIds = Array.from(
      new Set(
        histories
          .map((item: any) => String(item?.created_by ?? ''))
          .filter(Boolean),
      ),
    );
    if (!createdByIds.length) {
      return histories;
    }

    const users = await Promise.all(
      createdByIds.map(async (id) => {
        try {
          const userResponse = await this.sendIdentity<{
            data?: Record<string, any>;
          }>({ cmd: 'identity.user.find_by_id' }, { id });
          const user = userResponse?.data ?? null;
          return [id, user] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );

    const usersMap = new Map(users);
    return histories.map((item: any) => ({
      ...item,
      createdByUser: usersMap.get(String(item?.created_by ?? '')) ?? null,
    }));
  }

  private hasRole(user: JwtUser | undefined, role: RoleEnum) {
    return (user?.roles ?? []).some(
      (item) => String(item ?? '').toLowerCase() === String(role).toLowerCase(),
    );
  }

  private isPrivileged(user: JwtUser | undefined) {
    return (
      this.hasRole(user, RoleEnum.SUPERADMIN) ||
      this.hasRole(user, RoleEnum.ADMIN)
    );
  }

  private isManager(user: JwtUser | undefined) {
    return this.hasRole(user, RoleEnum.MANAGER) && !this.isPrivileged(user);
  }

  private extractBranchId(user: Record<string, any> | JwtUser | undefined) {
    return String(
      (user as any)?.branch_id ??
        (user as any)?.branchId ??
        (user as any)?.branch?.id ??
        (user as any)?.branch?.branch_id ??
        '',
    );
  }

  private toRequester(user: JwtUser | undefined) {
    return {
      id: String(user?.sub ?? ''),
      roles: Array.isArray(user?.roles) ? user?.roles : [],
      branch_id: user?.branch_id ?? null,
    };
  }

  private async resolveBranchIdByUserId(
    userId: string,
    requester?: JwtUser,
  ): Promise<string> {
    try {
      const assignment = await this.sendBranch<{ data?: Record<string, any> }>(
        { cmd: 'branch.user.find_by_user' },
        { user_id: userId, requester: this.toRequester(requester) },
      );
      return this.extractBranchId(assignment?.data);
    } catch {
      return '';
    }
  }

  private async isUserAssignedToBranch(
    branchId: string,
    userId: string,
    requester?: JwtUser,
  ): Promise<boolean> {
    if (!branchId || !userId) {
      return false;
    }
    try {
      const branchUsersResponse = await this.sendBranch<{ data?: any[] }>(
        { cmd: 'branch.user.find_by_branch' },
        { branch_id: branchId, requester: this.toRequester(requester) },
      );
      const branchUsers = Array.isArray(branchUsersResponse?.data)
        ? branchUsersResponse.data
        : [];
      return branchUsers.some(
        (row: any) => String(row?.user_id ?? '') === String(userId),
      );
    } catch {
      return false;
    }
  }

  private async canManagerAccessUser(
    manager: JwtUser | undefined,
    userId: string,
  ) {
    if (!manager?.sub) {
      return false;
    }
    if (String(userId) === String(manager.sub)) {
      return true;
    }

    try {
      const userResponse = await this.sendIdentity<{
        data?: Record<string, any>;
      }>({ cmd: 'identity.user.find_by_id' }, { id: userId });
      const targetUser = userResponse?.data;
      if (!targetUser) {
        return false;
      }

      let managerBranchId = this.extractBranchId(manager);
      if (!managerBranchId) {
        managerBranchId = await this.resolveBranchIdByUserId(
          String(manager.sub),
          manager,
        );
      }
      if (!managerBranchId) {
        try {
          const managerResponse = await this.sendIdentity<{
            data?: Record<string, any>;
          }>({ cmd: 'identity.user.find_by_id' }, { id: manager.sub });
          managerBranchId = this.extractBranchId(managerResponse?.data);
        } catch {
          managerBranchId = '';
        }
      }

      let targetBranchId = this.extractBranchId(targetUser);
      if (!targetBranchId) {
        targetBranchId = await this.resolveBranchIdByUserId(
          String(userId),
          manager,
        );
      }

      if (
        managerBranchId &&
        targetBranchId &&
        managerBranchId === targetBranchId
      ) {
        return true;
      }

      if (managerBranchId) {
        const assigned = await this.isUserAssignedToBranch(
          managerBranchId,
          String(userId),
          manager,
        );
        if (assigned) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private async loadCashboxHistory(
    cashboxId: string,
    query: { page?: number; limit?: number },
  ): Promise<any[]> {
    if (!cashboxId) {
      return [];
    }
    const historyResponse = await this.send(
      { cmd: 'finance.history.find_all' },
      { cashbox_id: cashboxId, page: query.page, limit: query.limit },
    );
    const histories = historyResponse?.data?.items ?? [];
    return this.attachCreatedByUsers(histories);
  }

  private async buildManagerSettlement(
    user: JwtUser,
    query?: { fromDate?: string; toDate?: string },
  ) {
    let managerBranchId = this.extractBranchId(user);
    if (!managerBranchId) {
      managerBranchId = await this.resolveBranchIdByUserId(
        String(user.sub),
        user,
      );
    }

    const ownCashboxResponse = await this.send(
      { cmd: 'finance.cashbox.my' },
      {
        user_id: user.sub,
        branch_id: managerBranchId || null,
        roles: user.roles ?? [],
        ...query,
      },
    );
    const ownCashbox =
      ownCashboxResponse?.data?.cashbox ?? ownCashboxResponse?.data ?? null;
    const kassa = Number(ownCashbox?.balance ?? 0);

    const managerProfileRes = await this.sendIdentity<{
      data?: Record<string, any>;
    }>({ cmd: 'identity.user.find_by_id' }, { id: user.sub });
    const managerProfile = managerProfileRes?.data ?? {};
    if (!managerBranchId) {
      managerBranchId = this.extractBranchId(managerProfile);
    }
    const managerTariffHome = Number(managerProfile?.tariff_home ?? 0);
    const managerTariffCenter = Number(managerProfile?.tariff_center ?? 0);

    const branchCouriers: any[] = [];
    if (managerBranchId) {
      try {
        const branchUsersResponse = await this.sendBranch<{ data?: any[] }>(
          { cmd: 'branch.user.find_by_branch' },
          { branch_id: managerBranchId, requester: this.toRequester(user) },
        );
        const branchUsers = Array.isArray(branchUsersResponse?.data)
          ? branchUsersResponse.data
          : [];
        const courierAssignments = branchUsers.filter((item: any) => {
          const role = String(item?.role ?? '').toUpperCase();
          return role === 'COURIER' && item?.user_id;
        });

        const loadedCouriers = await Promise.all(
          courierAssignments.map(async (assignment: any) => {
            try {
              const userRes = await this.sendIdentity<{
                data?: Record<string, any>;
              }>(
                { cmd: 'identity.user.find_by_id' },
                { id: String(assignment.user_id) },
              );
              return userRes?.data ?? null;
            } catch {
              return null;
            }
          }),
        );

        branchCouriers.push(...loadedCouriers.filter(Boolean));
      } catch {
        // fallthrough to generic identity list below
      }
    }

    let couriers = branchCouriers;
    if (!couriers.length) {
      const couriersResponse = await this.sendIdentity<{
        data?: { items?: any[] };
      }>(
        { cmd: 'identity.user.find_all' },
        { query: { role: RoleEnum.COURIER, limit: 1000, page: 1 } },
      );
      const allCouriers = couriersResponse?.data?.items ?? [];
      couriers = allCouriers.filter((courier) => {
        const sameCreator =
          String(courier?.created_by ?? '') === String(user.sub);
        const sameBranch =
          String(courier?.branch_id ?? '') &&
          String(courier?.branch_id ?? '') === String(managerBranchId ?? '');
        return sameCreator || sameBranch;
      });
    }

    const courierTariffMap = new Map(
      couriers.map((courier) => [
        String(courier?.id ?? ''),
        {
          home: Number(courier?.tariff_home ?? 0),
          center: Number(courier?.tariff_center ?? 0),
        },
      ]),
    );

    const courierCashboxes = await Promise.all(
      couriers.map(async (courier) => {
        const courierId = String(courier?.id ?? '').trim();
        const cashboxRes = await this.send(
          { cmd: 'finance.cashbox.find_by_user' },
          {
            user_id: courierId,
            cashbox_type: Cashbox_type.FOR_COURIER,
            with_history: false,
          },
        ).catch(() => null);
        const cashbox = cashboxRes?.data?.cashbox ?? cashboxRes?.data ?? null;
        return {
          courierId,
          balance: Number(cashbox?.balance ?? 0),
        };
      }),
    );
    const olinishiKerak = courierCashboxes.reduce(
      (sum, item) => sum + Math.max(Number(item.balance ?? 0), 0),
      0,
    );
    const courierBalanceMap = new Map(
      courierCashboxes.map((item) => [item.courierId, item.balance]),
    );

    const courierIds = couriers
      .map((courier) => String(courier?.id ?? '').trim())
      .filter(Boolean);

    const soldOrderQuery = {
      status: [
        Order_status.SOLD,
        Order_status.PAID,
        Order_status.PARTLY_PAID,
      ],
      page: 1,
      limit: 5000,
      start_day: query?.fromDate,
      end_day: query?.toDate,
    };
    const [branchSoldOrdersResponse, courierSoldOrdersResponse] =
      await Promise.all([
        managerBranchId
          ? this.sendOrder(
              { cmd: 'order.find_all' },
              {
                query: {
                  ...soldOrderQuery,
                  branch_id: managerBranchId,
                },
              },
            ).catch(() => null)
          : Promise.resolve(null),
        courierIds.length
          ? this.sendOrder(
              { cmd: 'order.find_all' },
              {
                query: {
                  ...soldOrderQuery,
                  courier_ids: courierIds,
                },
              },
            ).catch(() => null)
          : Promise.resolve(null),
      ]);

    const extractOrders = (response: any): any[] => {
      const rows =
        response?.data?.data ??
        response?.data?.items ??
        response?.data ??
        [];
      return Array.isArray(rows) ? rows : [];
    };
    const soldOrders = Array.from(
      new Map(
        [
          ...extractOrders(branchSoldOrdersResponse),
          ...extractOrders(courierSoldOrdersResponse),
        ].map((order: any) => [String(order?.id ?? ''), order]),
      ).values(),
    );

    const calculateOrderAmounts = (order: any) => {
      const totalPrice = Math.max(Number(order?.total_price ?? 0), 0);
      const whereDeliver = String(order?.where_deliver ?? '').toLowerCase();
      const managerTariff =
        whereDeliver === String(Where_deliver.CENTER).toLowerCase()
          ? managerTariffCenter
          : managerTariffHome;
      const courierId = String(order?.courier_id ?? '').trim();
      const courierTariffFromOrder = Number(order?.courier_tariff ?? NaN);
      const courierTariffByUser =
        courierId && courierTariffMap.has(courierId)
          ? whereDeliver === String(Where_deliver.CENTER).toLowerCase()
            ? Number(courierTariffMap.get(courierId)?.center ?? 0)
            : Number(courierTariffMap.get(courierId)?.home ?? 0)
          : 0;
      const courierShare = Math.max(
        Number.isFinite(courierTariffFromOrder)
          ? courierTariffFromOrder
          : courierTariffByUser,
        0,
      );

      return {
        courierId,
        courierReceivable: Math.max(totalPrice - courierShare, 0),
        hqPayable: Math.max(totalPrice - managerTariff, 0),
      };
    };

    let berilishiKerak = 0;
    const courierOrders = new Map<string, any[]>();

    for (const order of soldOrders) {
      const amounts = calculateOrderAmounts(order);
      if (!amounts.courierId || !courierTariffMap.has(amounts.courierId)) {
        berilishiKerak += amounts.hqPayable;
        continue;
      }
      const rows = courierOrders.get(amounts.courierId) ?? [];
      rows.push(order);
      courierOrders.set(amounts.courierId, rows);
    }

    for (const [courierId, orders] of courierOrders) {
      const sortedOrders = [...orders].sort(
        (left, right) =>
          new Date(left?.createdAt ?? 0).getTime() -
          new Date(right?.createdAt ?? 0).getTime(),
      );
      const totalCourierReceivable = sortedOrders.reduce(
        (sum, order) => sum + calculateOrderAmounts(order).courierReceivable,
        0,
      );
      let acceptedAmount = Math.max(
        totalCourierReceivable -
          Math.max(Number(courierBalanceMap.get(courierId) ?? 0), 0),
        0,
      );

      for (const order of sortedOrders) {
        if (acceptedAmount <= 0) break;
        const amounts = calculateOrderAmounts(order);
        if (amounts.courierReceivable <= 0) {
          berilishiKerak += amounts.hqPayable;
          continue;
        }
        const allocated = Math.min(
          acceptedAmount,
          amounts.courierReceivable,
        );
        berilishiKerak +=
          amounts.hqPayable * (allocated / amounts.courierReceivable);
        acceptedAmount -= allocated;
      }
    }

    const branchToMainHistoryResponse = ownCashbox?.id
      ? await this.send<{
          data?: {
            items?: Array<{
              amount?: number | string;
            }>;
          };
        }>(
          { cmd: 'finance.history.find_all' },
          {
            cashbox_id: String(ownCashbox.id),
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.BRANCH_TO_MAIN,
            from_date: query?.fromDate,
            to_date: query?.toDate,
            page: 0,
            limit: 0,
          },
        ).catch(() => null)
      : null;
    const paidToHq = (branchToMainHistoryResponse?.data?.items ?? []).reduce(
      (sum, history) => {
        const amount = Number(history?.amount ?? 0);
        return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
      },
      0,
    );
    const remainingPayableToHq = Math.max(
      Math.round(berilishiKerak) - paidToHq,
      0,
    );

    return {
      kassa,
      olinishi_kerak: Math.max(olinishiKerak, 0),
      berilishi_kerak: remainingPayableToHq,
      hq_ga_tollangan: paidToHq,
      counterparty: 'HQ',
      cashbox: ownCashbox,
      couriers,
    };
  }

  @Get('health')
  @ApiOperation({ summary: 'Finance service health check' })
  health() {
    return this.send({ cmd: 'finance.health' }, {});
  }

  @Post('cashbox')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create cashbox' })
  @ApiBody({ type: CreateCashboxRequestDto })
  createCashbox(@Body() dto: CreateCashboxRequestDto) {
    return this.send({ cmd: 'finance.cashbox.create' }, dto);
  }

  @Get('cashbox/user/:user_id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.MARKET,
    RoleEnum.COURIER,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find cashbox(es) by user' })
  @ApiParam({ name: 'user_id', description: 'User id (bigint string)' })
  @ApiQuery({ name: 'cashbox_type', required: false })
  @ApiQuery({ name: 'with_history', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async findCashboxByUser(
    @Param('user_id') user_id: string,
    @Query() query: FindCashboxByUserQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    if (!this.isPrivileged(req?.user)) {
      if (this.isManager(req?.user)) {
        const managerCanAccess = await this.canManagerAccessUser(
          req?.user,
          user_id,
        );
        if (!managerCanAccess) {
          throw new ForbiddenException(
            "Siz bu foydalanuvchi kassasini ko'ra olmaysiz",
          );
        }
      } else if (String(user_id) !== String(req?.user?.sub ?? '')) {
        throw new ForbiddenException(
          "Siz faqat o'zingizning kassangizni ko'ra olasiz",
        );
      }
    }
    let isPrivilegedBranchView = false;
    let privilegedBranchSettlement: Awaited<
      ReturnType<FinanceGatewayController['buildManagerSettlement']>
    > | null = null;
    let requestQuery: FindCashboxByUserQueryDto = query;
    if (this.isPrivileged(req?.user) && !query.cashbox_type) {
      try {
        await this.sendBranch(
          { cmd: 'branch.find_by_id' },
          { id: user_id, requester: this.toRequester(req.user) },
        );
        isPrivilegedBranchView = true;
        requestQuery = {
          ...query,
          cashbox_type: Cashbox_type.BRANCH,
        };

        const branchUsersResponse = await this.sendBranch<{ data?: any[] }>(
          { cmd: 'branch.user.find_by_branch' },
          {
            branch_id: user_id,
            requester: this.toRequester(req.user),
          },
        );
        const managerAssignment = (
          Array.isArray(branchUsersResponse?.data)
            ? branchUsersResponse.data
            : []
        ).find(
          (item: any) =>
            String(item?.role ?? '').toUpperCase() === 'MANAGER' &&
            item?.user_id,
        );
        if (managerAssignment?.user_id) {
          privilegedBranchSettlement = await this.buildManagerSettlement({
            sub: String(managerAssignment.user_id),
            roles: [RoleEnum.MANAGER],
            branch_id: user_id,
          });
        }
      } catch {
        isPrivilegedBranchView = false;
        privilegedBranchSettlement = null;
      }
    }

    const response = await this.send(
      { cmd: 'finance.cashbox.find_by_user' },
      { user_id, ...requestQuery },
    );

    const withHistory = query.with_history ?? true;
    if (!withHistory) {
      if (isPrivilegedBranchView && response?.data) {
        response.data = {
          cashbox: response.data,
          kassadagi_summa: Number(response.data?.balance ?? 0),
          berilishi_kerak: Number(
            privilegedBranchSettlement?.berilishi_kerak ?? 0,
          ),
          olinishi_kerak: Number(
            privilegedBranchSettlement?.berilishi_kerak ?? 0,
          ),
          counterparty: 'HQ',
        };
      }
      return response;
    }

    if (Array.isArray(response?.data)) {
      response.data = await Promise.all(
        response.data.map(async (cashbox: any) => ({
          ...cashbox,
          cashboxHistory: await this.loadCashboxHistory(
            String(cashbox?.id ?? ''),
            query,
          ),
        })),
      );
      if (
        this.isManager(req?.user) &&
        String(user_id) === String(req?.user?.sub ?? '')
      ) {
        try {
          const couriersResponse = await this.sendIdentity<{
            data?: { items?: any[] };
          }>(
            { cmd: 'identity.user.find_all' },
            { query: { role: RoleEnum.COURIER, limit: 500, page: 1 } },
          );
          const allCouriers = couriersResponse?.data?.items ?? [];
          response.meta = {
            ...(response.meta ?? {}),
            couriers: allCouriers.filter((courier) => {
              const sameCreator =
                String(courier?.created_by ?? '') === String(req.user.sub);
              const sameBranch =
                String(courier?.branch_id ?? '') &&
                String(courier?.branch_id ?? '') ===
                  String(req.user.branch_id ?? '');
              return sameCreator || sameBranch;
            }),
          };
        } catch {
          response.meta = { ...(response.meta ?? {}), couriers: [] };
        }
      }
      return response;
    }

    if (response?.data?.cashbox && Array.isArray(response?.data?.history)) {
      if (isPrivilegedBranchView) {
        response.data.history = response.data.history.filter(
          (item: any) =>
            String(item?.source_type ?? '') ===
            String(Source_type.BRANCH_TO_MAIN),
        );
        response.data.pagination = {
          ...(response.data.pagination ?? {}),
          total: response.data.history.length,
          totalPages: response.data.history.length ? 1 : 0,
        };
        response.data.kassadagi_summa = Number(
          response.data.cashbox?.balance ?? 0,
        );
        response.data.berilishi_kerak = Number(
          privilegedBranchSettlement?.berilishi_kerak ?? 0,
        );
        response.data.olinishi_kerak = Number(
          privilegedBranchSettlement?.berilishi_kerak ?? 0,
        );
        response.data.counterparty = 'HQ';
      }
      response.data.cashboxHistory = await this.attachCreatedByUsers(
        response.data.history,
      );
      return response;
    }

    if (
      Array.isArray(response?.data?.cashboxes) &&
      Array.isArray(response?.data?.history)
    ) {
      response.data.cashboxHistory = await this.attachCreatedByUsers(
        response.data.history,
      );
      return response;
    }

    if (Array.isArray(response?.data?.history)) {
      response.data.cashboxHistory = await this.attachCreatedByUsers(
        response.data.history,
      );
      return response;
    }

    if (response?.data?.id) {
      response.data.cashboxHistory = await this.loadCashboxHistory(
        String(response.data.id),
        query,
      );
      if (
        this.isManager(req?.user) &&
        String(user_id) === String(req?.user?.sub ?? '')
      ) {
        try {
          const couriersResponse = await this.sendIdentity<{
            data?: { items?: any[] };
          }>(
            { cmd: 'identity.user.find_all' },
            { query: { role: RoleEnum.COURIER, limit: 500, page: 1 } },
          );
          const allCouriers = couriersResponse?.data?.items ?? [];
          response.meta = {
            ...(response.meta ?? {}),
            couriers: allCouriers.filter((courier) => {
              const sameCreator =
                String(courier?.created_by ?? '') === String(req.user.sub);
              const sameBranch =
                String(courier?.branch_id ?? '') &&
                String(courier?.branch_id ?? '') ===
                  String(req.user.branch_id ?? '');
              return sameCreator || sameBranch;
            }),
          };
        } catch {
          response.meta = { ...(response.meta ?? {}), couriers: [] };
        }
      }
      return response;
    }

    return response;
  }

  @Patch('cashbox/balance')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update cashbox balance and create history' })
  @ApiBody({ type: UpdateCashboxBalanceRequestDto })
  updateCashboxBalance(@Body() dto: UpdateCashboxBalanceRequestDto) {
    return this.send({ cmd: 'finance.cashbox.update_balance' }, dto);
  }

  @Get('cashbox/main')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get main cashbox summary' })
  getMainCashbox(
    @Query() query: MainCashboxFilterQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    if (this.isManager(req?.user)) {
      return this.send(
        { cmd: 'finance.cashbox.user_by_id' },
        { id: req.user.sub, cashbox_type: Cashbox_type.FOR_COURIER, ...query },
      );
    }
    return this.send({ cmd: 'finance.cashbox.main' }, query);
  }

  @Get('cashbox/user/:id/main')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get cashbox by user ID with date filters' })
  @ApiParam({ name: 'id', description: 'User ID (bigint string)' })
  async cashboxByUserId(
    @Param('id') id: string,
    @Query() query: MainCashboxFilterQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    if (!this.isPrivileged(req?.user)) {
      if (this.isManager(req?.user)) {
        const managerCanAccess = await this.canManagerAccessUser(req?.user, id);
        if (!managerCanAccess) {
          throw new ForbiddenException(
            "Siz bu foydalanuvchi kassasini ko'ra olmaysiz",
          );
        }
      } else if (String(id) !== String(req?.user?.sub ?? '')) {
        throw new ForbiddenException(
          "Siz faqat o'zingizning kassangizni ko'ra olasiz",
        );
      }
    }
    return this.send({ cmd: 'finance.cashbox.user_by_id' }, { id, ...query });
  }

  @Get('cashbox/my-cashbox')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MARKET, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my cashbox (courier/market)' })
  async myCashbox(
    @Req() req: { user: JwtUser },
    @Query() query: MainCashboxFilterQueryDto,
  ) {
    const branchId = this.isManager(req?.user)
      ? this.extractBranchId(req.user) || (await this.resolveBranchIdByUserId(String(req.user.sub), req.user))
      : null;
    const response = await this.send(
      { cmd: 'finance.cashbox.my' },
      { user_id: req.user.sub, branch_id: branchId, roles: req.user.roles ?? [], ...query },
    );

    return this.attachCreatedByUsersToHistory(response);
  }

  @Post('cashbox/payment/courier')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Accept payment from courier' })
  @ApiBody({ type: PaymentFromCourierRequestDto })
  async paymentFromCourier(
    @Req() req: { user: JwtUser },
    @Body() dto: PaymentFromCourierRequestDto,
  ) {
    const isManager = this.isManager(req?.user);
    let receiverBranchId = '';
    if (isManager) {
      receiverBranchId =
        this.extractBranchId(req.user) ||
        (await this.resolveBranchIdByUserId(String(req.user.sub), req.user));
      if (!receiverBranchId) {
        throw new ForbiddenException("Managerning branch'i topilmadi");
      }
      const courierResponse = await this.sendIdentity<{
        data?: Record<string, any>;
      }>({ cmd: 'identity.user.find_by_id' }, { id: dto.courier_id });
      const courier = courierResponse?.data;
      if (!courier) {
        throw new ForbiddenException('Courier topilmadi');
      }

      const roleList = Array.isArray(courier.roles)
        ? courier.roles
        : courier.role
          ? [courier.role]
          : [];
      const isCourier = roleList.some(
        (role: unknown) =>
          String(role ?? '').toLowerCase() === RoleEnum.COURIER,
      );
      if (!isCourier) {
        throw new ForbiddenException('Bu foydalanuvchi courier emas');
      }

      const managerCanAccess = await this.canManagerAccessUser(
        req?.user,
        dto.courier_id,
      );
      if (!managerCanAccess) {
        throw new ForbiddenException(
          "Siz faqat o'z branch'ingiz courieridan to'lov qabul qilasiz",
        );
      }
    }

    return this.send(
      { cmd: 'finance.cashbox.payment_courier' },
      {
        ...dto,
        created_by: req.user.sub,
        ...(isManager
          ? {
              receiver_user_id: receiverBranchId,
              receiver_cashbox_type: Cashbox_type.BRANCH,
            }
          : {}),
      },
    );
  }

  @Post('cashbox/payment/market')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Payment to market' })
  @ApiBody({ type: PaymentToMarketRequestDto })
  paymentToMarket(
    @Req() req: { user: JwtUser },
    @Body() dto: PaymentToMarketRequestDto,
  ) {
    return this.send(
      { cmd: 'finance.cashbox.payment_market' },
      { ...dto, created_by: req.user.sub },
    );
  }

  @Post('cashbox/payment/branch-to-main')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Transfer money from branch manager cashbox to HQ main cashbox',
  })
  @ApiBody({ type: PaymentBranchToMainRequestDto })
  async paymentBranchToMain(
    @Req() req: { user: JwtUser },
    @Body() dto: PaymentBranchToMainRequestDto,
  ) {
    const branchId = String(dto.branch_id ?? '').trim();
    if (!branchId) {
      throw new ForbiddenException('branch_id yuborilishi shart');
    }

    await this.sendBranch(
      { cmd: 'branch.find_by_id' },
      { id: branchId, requester: this.toRequester(req.user) },
    );

    return this.send(
      { cmd: 'finance.cashbox.payment_branch_main' },
      {
        branch_id: branchId,
        amount: dto.amount,
        payment_method: dto.payment_method,
        payment_date: dto.payment_date,
        comment: dto.comment,
        created_by: req.user.sub,
      },
    );
  }

  @Get('cashbox/all-info')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all cashboxes total info' })
  async allCashboxesInfo(
    @Query() query: CashboxAllInfoQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    if (this.isManager(req?.user)) {
      const settlement = await this.buildManagerSettlement(req.user, {
        fromDate: (query as any)?.fromDate,
        toDate: (query as any)?.toDate,
      });
      const ownHistoryResponse = await this.send(
        { cmd: 'finance.history.find_all' },
        {
          ...query,
          user_id: settlement.cashbox?.user_id ?? '',
          cashbox_type: Cashbox_type.BRANCH,
        },
      );
      const page = Number(query?.page ?? 1);
      const limit = Number(query?.limit ?? 20);

      return {
        statusCode: 200,
        message: "Manager cashbox info (faqat o'ziga tegishli)",
        data: {
          kassadagi_summa: settlement.kassa,
          berilishi_kerak: settlement.berilishi_kerak,
          olinishi_kerak: settlement.olinishi_kerak,
          counterparty: settlement.counterparty,
          mainCashboxTotal: 0,
          courierCashboxTotal: settlement.kassa,
          marketCashboxTotal: 0,
          allCashboxHistories: ownHistoryResponse?.data?.items ?? [],
          couriers: settlement.couriers,
          pagination: ownHistoryResponse?.data?.pagination ?? {
            total: Number(ownHistoryResponse?.data?.total ?? 0),
            page,
            limit,
            totalPages: Number(ownHistoryResponse?.data?.totalPages ?? 0),
          },
        },
      };
    }

    const [financeResponse, branchesResponse] = await Promise.all([
      this.send({ cmd: 'finance.cashbox.all_info' }, query),
      this.sendBranch<{
        data?: {
          items?: Array<{
            type?: string;
            olinishi_kerak?: number | string;
          }>;
        };
      }>(
        { cmd: 'branch.find_all' },
        {
          requester: this.toRequester(req.user),
          query: {
            status: 'active',
            page: 1,
            limit: 1000,
          },
        },
      ).catch(() => null),
    ]);

    const branches = branchesResponse?.data?.items ?? [];
    const branchManagersReceivable = branches.reduce((sum, branch) => {
      if (String(branch?.type ?? '').toUpperCase() === 'HQ') {
        return sum;
      }
      const amount = Number(branch?.olinishi_kerak ?? 0);
      return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
    }, 0);

    if (financeResponse?.data) {
      financeResponse.data.kassadagi_summa = Number(
        financeResponse.data.mainCashboxTotal ?? 0,
      );
      financeResponse.data.berilishi_kerak = Number(
        financeResponse.data.marketCashboxTotal ?? 0,
      );
      financeResponse.data.olinishi_kerak = branchManagersReceivable;
      financeResponse.data.courierCashboxTotal = branchManagersReceivable;
    }

    return financeResponse;
  }

  @Get('cashbox/manager/settlement')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Manager cashbox settlement (HQ bilan hisob-kitob)',
  })
  async managerSettlement(
    @Req() req: { user: JwtUser },
    @Query() query: MainCashboxFilterQueryDto,
  ) {
    const settlement = await this.buildManagerSettlement(req.user, query);
    const cash = Number(settlement?.cashbox?.balance_cash ?? 0);
    const card = Number(settlement?.cashbox?.balance_card ?? 0);

    return {
      statusCode: 200,
      message: 'Manager settlement (HQ bilan) hisoblandi',
      data: {
        counterparty: settlement.counterparty,
        kassa: { cash, card, total: settlement.kassa },
        berilishi_kerak: settlement.berilishi_kerak,
        olinishi_kerak: settlement.olinishi_kerak,
        cashbox: settlement.cashbox,
      },
    };
  }

  @Get('cashbox/manager/payable-to-hq')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Managerdan HQga berilishi kerak summa' })
  async managerPayableToHq(
    @Req() req: { user: JwtUser },
    @Query() query: MainCashboxFilterQueryDto,
  ) {
    const settlement = await this.buildManagerSettlement(req.user, query);

    return {
      statusCode: 200,
      message: 'Manager -> HQ berilishi kerak summa',
      data: {
        counterparty: settlement.counterparty,
        berilishi_kerak: settlement.berilishi_kerak,
      },
    };
  }

  @Get('cashbox/financial-balanse')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get financial balance' })
  financialBalance() {
    return this.send({ cmd: 'finance.cashbox.financial_balance' }, {});
  }

  // --- Financial balance ledger (company-wide P&L history) ---

  @Post('financial-balance/entries')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Record a manual financial ledger entry (income/expense/bills/salary/correction)',
  })
  @ApiBody({ type: RecordFinancialBalanceRequestDto })
  recordFinancialBalance(
    @Body() dto: RecordFinancialBalanceRequestDto,
    @Req() req: { user?: JwtUser },
  ) {
    return this.send(
      { cmd: 'finance.financial_balance.record' },
      { ...dto, created_by: req.user?.sub ?? null },
    );
  }

  @Get('financial-balance/history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List financial balance ledger entries + current balance',
  })
  @ApiQuery({ name: 'source_type', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  financialBalanceHistory(
    @Query('source_type') source_type?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.send(
      { cmd: 'finance.financial_balance.history' },
      {
        source_type,
        from_date,
        to_date,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      },
    );
  }

  @Patch('cashbox/spend')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Spend money from main cashbox' })
  @ApiBody({ type: MainCashboxManualRequestDto })
  spendMoney(
    @Req() req: { user: JwtUser },
    @Body() dto: MainCashboxManualRequestDto,
  ) {
    const isManager = this.isManager(req?.user);
    return this.send(
      { cmd: 'finance.cashbox.spend' },
      {
        ...dto,
        user_id: req.user.sub,
        ...(isManager ? { cashbox_type: Cashbox_type.FOR_COURIER } : {}),
      },
    );
  }

  @Patch('cashbox/fill')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fill main cashbox' })
  @ApiBody({ type: MainCashboxManualRequestDto })
  fillCashbox(
    @Req() req: { user: JwtUser },
    @Body() dto: MainCashboxManualRequestDto,
  ) {
    const isManager = this.isManager(req?.user);
    return this.send(
      { cmd: 'finance.cashbox.fill' },
      {
        ...dto,
        user_id: req.user.sub,
        ...(isManager ? { cashbox_type: Cashbox_type.FOR_COURIER } : {}),
      },
    );
  }

  @Get('history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find cashbox history list' })
  @ApiQuery({ name: 'cashbox_id', required: false })
  @ApiQuery({ name: 'user_id', required: false })
  @ApiQuery({
    name: 'cashbox_type',
    required: false,
    enum: ['main', 'for_courier', 'for_market'],
  })
  @ApiQuery({
    name: 'cashboxType',
    required: false,
    enum: ['main', 'for_courier', 'for_market'],
  })
  @ApiQuery({ name: 'operation_type', required: false })
  @ApiQuery({ name: 'source_type', required: false })
  @ApiQuery({ name: 'created_by', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findHistory(
    @Query() query: FindHistoryQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    if (
      this.hasRole(req?.user, RoleEnum.MANAGER) &&
      !this.isPrivileged(req?.user)
    ) {
      return this.send(
        { cmd: 'finance.history.find_all' },
        { ...query, user_id: req.user.sub },
      );
    }
    return this.send({ cmd: 'finance.history.find_all' }, query);
  }

  @Get('history/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.COURIER,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find cashbox history detail by id' })
  @ApiParam({ name: 'id', description: 'History id (bigint string)' })
  findHistoryById(@Param('id') id: string) {
    return this.send({ cmd: 'finance.history.find_by_id' }, { id });
  }

  @Post('shift/open')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Open shift' })
  @ApiBody({ type: OpenShiftRequestDto })
  openShift(@Body() dto: OpenShiftRequestDto) {
    return this.send({ cmd: 'finance.shift.open' }, dto);
  }

  @Post('shift/close')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Close shift' })
  @ApiBody({ type: CloseShiftRequestDto })
  closeShift(@Body() dto: CloseShiftRequestDto) {
    return this.send({ cmd: 'finance.shift.close' }, dto);
  }

  @Get('shift')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find shifts with filters' })
  @ApiQuery({ name: 'opened_by', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findShifts(@Query() query: FindShiftQueryDto) {
    return this.send({ cmd: 'finance.shift.find_all' }, query);
  }

  @Post('salary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create salary row for user' })
  @ApiBody({ type: CreateSalaryRequestDto })
  createSalary(@Body() dto: CreateSalaryRequestDto) {
    return this.send({ cmd: 'finance.salary.create' }, dto);
  }

  @Patch('salary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update salary row for user' })
  @ApiBody({ type: UpdateSalaryRequestDto })
  updateSalary(@Body() dto: UpdateSalaryRequestDto) {
    return this.send({ cmd: 'finance.salary.update' }, dto);
  }

  @Get('salary/:user_id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find salary by user id' })
  @ApiParam({ name: 'user_id', description: 'User id (bigint string)' })
  findSalaryByUser(@Param('user_id') user_id: string) {
    return this.send({ cmd: 'finance.salary.find_by_user' }, { user_id });
  }

  // --- Operator earnings & payments ---

  @Post('operator-payments')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Record a payout to an operator' })
  @ApiBody({ type: CreateOperatorPaymentRequestDto })
  createOperatorPayment(
    @Body() dto: CreateOperatorPaymentRequestDto,
    @Req() req: { user?: JwtUser },
  ) {
    return this.send(
      { cmd: 'finance.operator.payment.create' },
      { ...dto, paid_by_id: req.user?.sub ?? null },
    );
  }

  @Get('operators/:operator_id/balance')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Operator earned/paid/balance summary' })
  @ApiParam({
    name: 'operator_id',
    description: 'Operator user id (bigint string)',
  })
  findOperatorBalance(@Param('operator_id') operator_id: string) {
    return this.send({ cmd: 'finance.operator.balance.find' }, { operator_id });
  }

  @Get('operators/:operator_id/earnings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List an operator earnings' })
  @ApiParam({
    name: 'operator_id',
    description: 'Operator user id (bigint string)',
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  listOperatorEarnings(
    @Param('operator_id') operator_id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.send(
      { cmd: 'finance.operator.earning.list' },
      {
        operator_id,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      },
    );
  }

  @Get('operators/:operator_id/payments')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List an operator payouts' })
  @ApiParam({
    name: 'operator_id',
    description: 'Operator user id (bigint string)',
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  listOperatorPayments(
    @Param('operator_id') operator_id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.send(
      { cmd: 'finance.operator.payment.list' },
      {
        operator_id,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      },
    );
  }
}
