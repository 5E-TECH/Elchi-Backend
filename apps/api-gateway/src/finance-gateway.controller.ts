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
import { Roles as RoleEnum } from '@app/common';
import {
  CashboxAllInfoQueryDto,
  CloseShiftRequestDto,
  CreateCashboxRequestDto,
  CreateSalaryRequestDto,
  FindCashboxByUserQueryDto,
  FindHistoryQueryDto,
  FindShiftQueryDto,
  MainCashboxFilterQueryDto,
  MainCashboxManualRequestDto,
  OpenShiftRequestDto,
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
  ) {}

  private async send<T = any>(pattern: object, payload: object, timeoutMs = 8000): Promise<T> {
    return firstValueFrom(this.financeClient.send(pattern, payload).pipe(timeout(timeoutMs))).catch(
      (error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException('Finance service response timeout');
        }
        throw error;
      },
    );
  }

  private async sendIdentity<T = any>(
    pattern: object,
    payload: object,
    timeoutMs = 8000,
  ): Promise<T> {
    return firstValueFrom(this.identityClient.send(pattern, payload).pipe(timeout(timeoutMs))).catch(
      (error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException('Identity service response timeout');
        }
        throw error;
      },
    );
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
      new Set(histories.map((item: any) => String(item?.created_by ?? '')).filter(Boolean)),
    );
    if (!createdByIds.length) {
      return histories;
    }

    const users = await Promise.all(
      createdByIds.map(async (id) => {
        try {
          const userResponse = await this.sendIdentity<{ data?: Record<string, any> }>(
            { cmd: 'identity.user.find_by_id' },
            { id },
          );
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
    return this.hasRole(user, RoleEnum.SUPERADMIN) || this.hasRole(user, RoleEnum.ADMIN);
  }

  private isManager(user: JwtUser | undefined) {
    return this.hasRole(user, RoleEnum.MANAGER) && !this.isPrivileged(user);
  }

  private async canManagerAccessUser(manager: JwtUser | undefined, userId: string) {
    if (!manager?.sub) {
      return false;
    }
    if (String(userId) === String(manager.sub)) {
      return true;
    }

    try {
      const userResponse = await this.sendIdentity<{ data?: Record<string, any> }>(
        { cmd: 'identity.user.find_by_id' },
        { id: userId },
      );
      const targetUser = userResponse?.data;
      if (!targetUser) {
        return false;
      }

      const managerId = String(manager.sub);
      const targetCreatedBy = String(targetUser.created_by ?? '');
      const managerBranchId = String(manager.branch_id ?? '');
      const targetBranchId = String(targetUser.branch_id ?? '');

      if (targetCreatedBy && targetCreatedBy === managerId) {
        return true;
      }

      if (managerBranchId && targetBranchId && managerBranchId === targetBranchId) {
        return true;
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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MARKET, RoleEnum.COURIER, RoleEnum.MANAGER)
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
        const managerCanAccess = await this.canManagerAccessUser(req?.user, user_id);
        if (!managerCanAccess) {
          throw new ForbiddenException("Siz bu foydalanuvchi kassasini ko'ra olmaysiz");
        }
      } else if (String(user_id) !== String(req?.user?.sub ?? '')) {
        throw new ForbiddenException("Siz faqat o'zingizning kassangizni ko'ra olasiz");
      }
    }
    const response = await this.send(
      { cmd: 'finance.cashbox.find_by_user' },
      { user_id, ...query },
    );

    const withHistory = query.with_history ?? true;
    if (!withHistory) {
      return response;
    }

    if (Array.isArray(response?.data)) {
      response.data = await Promise.all(
        response.data.map(async (cashbox: any) => ({
          ...cashbox,
          cashboxHistory: await this.loadCashboxHistory(String(cashbox?.id ?? ''), query),
        })),
      );
      if (
        this.isManager(req?.user) &&
        String(user_id) === String(req?.user?.sub ?? '')
      ) {
        try {
          const couriersResponse = await this.sendIdentity<{ data?: { items?: any[] } }>(
            { cmd: 'identity.user.find_all' },
            { query: { role: RoleEnum.COURIER, limit: 500, page: 1 } },
          );
          const allCouriers = couriersResponse?.data?.items ?? [];
          response.meta = {
            ...(response.meta ?? {}),
            couriers: allCouriers.filter((courier) => {
              const sameCreator = String(courier?.created_by ?? '') === String(req.user.sub);
              const sameBranch =
                String(courier?.branch_id ?? '') &&
                String(courier?.branch_id ?? '') === String(req.user.branch_id ?? '');
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
      response.data.cashboxHistory = await this.attachCreatedByUsers(response.data.history);
      return response;
    }

    if (Array.isArray(response?.data?.history)) {
      response.data.cashboxHistory = await this.attachCreatedByUsers(response.data.history);
      return response;
    }

    if (response?.data?.id) {
      response.data.cashboxHistory = await this.loadCashboxHistory(String(response.data.id), query);
      if (
        this.isManager(req?.user) &&
        String(user_id) === String(req?.user?.sub ?? '')
      ) {
        try {
          const couriersResponse = await this.sendIdentity<{ data?: { items?: any[] } }>(
            { cmd: 'identity.user.find_all' },
            { query: { role: RoleEnum.COURIER, limit: 500, page: 1 } },
          );
          const allCouriers = couriersResponse?.data?.items ?? [];
          response.meta = {
            ...(response.meta ?? {}),
            couriers: allCouriers.filter((courier) => {
              const sameCreator = String(courier?.created_by ?? '') === String(req.user.sub);
              const sameBranch =
                String(courier?.branch_id ?? '') &&
                String(courier?.branch_id ?? '') === String(req.user.branch_id ?? '');
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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get main cashbox summary' })
  getMainCashbox(@Query() query: MainCashboxFilterQueryDto) {
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
          throw new ForbiddenException("Siz bu foydalanuvchi kassasini ko'ra olmaysiz");
        }
      } else if (String(id) !== String(req?.user?.sub ?? '')) {
        throw new ForbiddenException("Siz faqat o'zingizning kassangizni ko'ra olasiz");
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
    const response = await this.send(
      { cmd: 'finance.cashbox.my' },
      { user_id: req.user.sub, roles: req.user.roles ?? [], ...query },
    );

    return this.attachCreatedByUsersToHistory(response);
  }

  @Post('cashbox/payment/courier')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Accept payment from courier' })
  @ApiBody({ type: PaymentFromCourierRequestDto })
  paymentFromCourier(
    @Req() req: { user: JwtUser },
    @Body() dto: PaymentFromCourierRequestDto,
  ) {
    return this.send(
      { cmd: 'finance.cashbox.payment_courier' },
      { ...dto, created_by: req.user.sub },
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
      const ownCashboxResponse = await this.send(
        { cmd: 'finance.cashbox.my' },
        { user_id: req.user.sub, roles: req.user.roles ?? [] },
      );
      const ownCashbox = ownCashboxResponse?.data?.cashbox ?? ownCashboxResponse?.data ?? null;
      const ownHistoryResponse = await this.send(
        { cmd: 'finance.history.find_all' },
        { ...query, user_id: req.user.sub },
      );

      const managerBalance = Number(ownCashbox?.balance ?? 0);
      const page = Number(query?.page ?? 1);
      const limit = Number(query?.limit ?? 20);

      return {
        statusCode: 200,
        message: "Manager cashbox info (faqat o'ziga tegishli)",
        data: {
          kassadagi_summa: managerBalance,
          berilishi_kerak: managerBalance > 0 ? managerBalance : 0,
          olinishi_kerak: managerBalance < 0 ? Math.abs(managerBalance) : 0,
          counterparty: 'HQ',
          mainCashboxTotal: 0,
          courierCashboxTotal: managerBalance,
          marketCashboxTotal: 0,
          allCashboxHistories: ownHistoryResponse?.data?.items ?? [],
          pagination: ownHistoryResponse?.data?.pagination ?? {
            total: Number(ownHistoryResponse?.data?.total ?? 0),
            page,
            limit,
            totalPages: Number(ownHistoryResponse?.data?.totalPages ?? 0),
          },
        },
      };
    }
    return this.send({ cmd: 'finance.cashbox.all_info' }, query);
  }

  @Get('cashbox/manager/settlement')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Manager cashbox settlement (HQ bilan hisob-kitob)" })
  async managerSettlement(
    @Req() req: { user: JwtUser },
    @Query() query: MainCashboxFilterQueryDto,
  ) {
    const response = await this.send(
      { cmd: 'finance.cashbox.my' },
      { user_id: req.user.sub, roles: req.user.roles ?? [], ...query },
    );

    const cashbox = response?.data?.cashbox ?? response?.data ?? null;
    const cash = Number(cashbox?.balance_cash ?? 0);
    const card = Number(cashbox?.balance_card ?? 0);
    const totalBalance = Number(cashbox?.balance ?? cash + card);
    const berilishiKerak = totalBalance > 0 ? totalBalance : 0;
    const olinishiKerak = totalBalance < 0 ? Math.abs(totalBalance) : 0;

    return {
      statusCode: 200,
      message: "Manager settlement (HQ bilan) hisoblandi",
      data: {
        counterparty: 'HQ',
        kassa: { cash, card, total: totalBalance },
        berilishi_kerak: berilishiKerak,
        olinishi_kerak: olinishiKerak,
        cashbox,
      },
    };
  }

  @Get('cashbox/manager/payable-to-hq')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Managerdan HQga berilishi kerak summa" })
  async managerPayableToHq(
    @Req() req: { user: JwtUser },
    @Query() query: MainCashboxFilterQueryDto,
  ) {
    const response = await this.send(
      { cmd: 'finance.cashbox.my' },
      { user_id: req.user.sub, roles: req.user.roles ?? [], ...query },
    );

    const cashbox = response?.data?.cashbox ?? response?.data ?? null;
    const totalBalance = Number(cashbox?.balance ?? 0);

    return {
      statusCode: 200,
      message: 'Manager -> HQ berilishi kerak summa',
      data: {
        counterparty: 'HQ',
        berilishi_kerak: totalBalance > 0 ? totalBalance : 0,
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

  @Patch('cashbox/spend')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Spend money from main cashbox' })
  @ApiBody({ type: MainCashboxManualRequestDto })
  spendMoney(
    @Req() req: { user: JwtUser },
    @Body() dto: MainCashboxManualRequestDto,
  ) {
    return this.send({ cmd: 'finance.cashbox.spend' }, { ...dto, user_id: req.user.sub });
  }

  @Patch('cashbox/fill')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fill main cashbox' })
  @ApiBody({ type: MainCashboxManualRequestDto })
  fillCashbox(
    @Req() req: { user: JwtUser },
    @Body() dto: MainCashboxManualRequestDto,
  ) {
    return this.send({ cmd: 'finance.cashbox.fill' }, { ...dto, user_id: req.user.sub });
  }

  @Get('history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find cashbox history list' })
  @ApiQuery({ name: 'cashbox_id', required: false })
  @ApiQuery({ name: 'user_id', required: false })
  @ApiQuery({ name: 'cashbox_type', required: false, enum: ['main', 'for_courier', 'for_market'] })
  @ApiQuery({ name: 'cashboxType', required: false, enum: ['main', 'for_courier', 'for_market'] })
  @ApiQuery({ name: 'operation_type', required: false })
  @ApiQuery({ name: 'source_type', required: false })
  @ApiQuery({ name: 'created_by', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findHistory(@Query() query: FindHistoryQueryDto, @Req() req: { user: JwtUser }) {
    if (this.hasRole(req?.user, RoleEnum.MANAGER) && !this.isPrivileged(req?.user)) {
      return this.send({ cmd: 'finance.history.find_all' }, { ...query, user_id: req.user.sub });
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
}
