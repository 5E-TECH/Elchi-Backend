import {
  Body,
  Controller,
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
}

@ApiTags('Finance')
@Controller('finance')
export class FinanceGatewayController {
  constructor(@Inject('FINANCE') private readonly financeClient: ClientProxy) {}

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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MARKET, RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find cashbox(es) by user' })
  @ApiParam({ name: 'user_id', description: 'User id (bigint string)' })
  @ApiQuery({ name: 'cashbox_type', required: false })
  @ApiQuery({ name: 'with_history', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findCashboxByUser(
    @Param('user_id') user_id: string,
    @Query() query: FindCashboxByUserQueryDto,
  ) {
    return this.send({ cmd: 'finance.cashbox.find_by_user' }, { user_id, ...query });
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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get cashbox by user ID with date filters' })
  @ApiParam({ name: 'id', description: 'User ID (bigint string)' })
  cashboxByUserId(
    @Param('id') id: string,
    @Query() query: MainCashboxFilterQueryDto,
  ) {
    return this.send({ cmd: 'finance.cashbox.user_by_id' }, { id, ...query });
  }

  @Get('cashbox/my-cashbox')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my cashbox (courier/market)' })
  myCashbox(
    @Req() req: { user: JwtUser },
    @Query() query: MainCashboxFilterQueryDto,
  ) {
    return this.send(
      { cmd: 'finance.cashbox.my' },
      { user_id: req.user.sub, roles: req.user.roles ?? [], ...query },
    );
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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all cashboxes total info' })
  allCashboxesInfo(@Query() query: CashboxAllInfoQueryDto) {
    return this.send({ cmd: 'finance.cashbox.all_info' }, query);
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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find cashbox history list' })
  @ApiQuery({ name: 'cashbox_id', required: false })
  @ApiQuery({ name: 'user_id', required: false })
  @ApiQuery({ name: 'operation_type', required: false })
  @ApiQuery({ name: 'source_type', required: false })
  @ApiQuery({ name: 'created_by', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findHistory(@Query() query: FindHistoryQueryDto) {
    return this.send({ cmd: 'finance.history.find_all' }, query);
  }

  @Post('shift/open')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Open shift' })
  @ApiBody({ type: OpenShiftRequestDto })
  openShift(@Body() dto: OpenShiftRequestDto) {
    return this.send({ cmd: 'finance.shift.open' }, dto);
  }

  @Post('shift/close')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Close shift' })
  @ApiBody({ type: CloseShiftRequestDto })
  closeShift(@Body() dto: CloseShiftRequestDto) {
    return this.send({ cmd: 'finance.shift.close' }, dto);
  }

  @Get('shift')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.OPERATOR)
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
