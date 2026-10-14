import {
  Body,
  Controller,
  Delete,
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
import { timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CalculateProfitDto,
  CreateInvestmentDto,
  CreateInvestorDto,
  CreateProfitShareDto,
  UpdateInvestmentDto,
  UpdateInvestorDto,
} from './dto/investor.swagger.dto';

interface JwtUser {
  sub: string;
  username?: string;
  roles?: string[];
}

type AuthedRequest = { user?: JwtUser };

function toOptionalNumber(value?: string): number | undefined {
  return value ? Number(value) : undefined;
}

function toOptionalBool(value?: string): boolean | undefined {
  return typeof value === 'string'
    ? ['true', '1', 'yes'].includes(value.toLowerCase())
    : undefined;
}

@ApiTags('Investor')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvestorGatewayController {
  constructor(
    @Inject('INVESTOR') private readonly investorClient: ClientProxy,
  ) {}

  /**
   * vpKijXce: ilgari bu kontroller servisga HECH QACHON `requester` uzatmasdi —
   * investor/investitsiya/foyda yaratish, o'zgartirish, o'chirish va foydani
   * to'lash audit izida aktorsiz (user_id = null) yozilardi, `mark-paid` esa
   * kassa chiqimini `user_id: '0'` nomidan qilardi.
   * GADgsW5G: endi O'QISH marshrutlari ham (jami 21 handler) requester
   * uzatadi — har bir `investor.*` cmd payload'ida `requester.id` bor
   * (kontrakt: investor-gateway.requester.contract.spec.ts).
   */
  private toRequester(req?: AuthedRequest) {
    return {
      id: req?.user?.sub ? String(req.user.sub) : undefined,
      roles: req?.user?.roles ?? [],
    };
  }

  // -------------------------------------------------------------------
  // vpKijXce: investorning O'ZI uchun marshrutlar.
  // ⚠️ `investors/:id` dan OLDIN turishi shart (aks holda "me" :id bo'lib
  // admin-only handler'ga tushadi). Doira faqat JWT sub'dan — query'dagi
  // `investor_id` o'qilmaydi va servisga yuborilmaydi (TC4).
  // -------------------------------------------------------------------

  @Get('investors/me')
  @Roles(RoleEnum.INVESTOR)
  @ApiOperation({
    summary:
      "Investor: o'z profili va yig'indisi (investitsiya, foiz, to'langan/kutilayotgan foyda)",
  })
  getMyProfile(@Req() req: AuthedRequest) {
    return this.investorClient
      .send(
        { cmd: 'investor.me.profile' },
        { requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Get('investors/me/dashboard')
  @Roles(RoleEnum.INVESTOR)
  @ApiOperation({
    summary: "Investor: dashboard kartalari + oylik foyda grafigi (o'ziniki)",
  })
  @ApiQuery({
    name: 'months',
    required: false,
    type: Number,
    description: '1..36, default 12',
  })
  getMyDashboard(@Req() req: AuthedRequest, @Query('months') months?: string) {
    return this.investorClient
      .send(
        { cmd: 'investor.me.dashboard' },
        {
          requester: this.toRequester(req),
          query: { months: toOptionalNumber(months) },
        },
      )
      .pipe(timeout(8000));
  }

  @Get('investors/me/investments')
  @Roles(RoleEnum.INVESTOR)
  @ApiOperation({ summary: "Investor: o'z investitsiyalari" })
  @ApiQuery({ name: 'from_date', required: false, type: String })
  @ApiQuery({ name: 'to_date', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getMyInvestments(
    @Req() req: AuthedRequest,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.me.investments' },
        {
          requester: this.toRequester(req),
          query: {
            from_date,
            to_date,
            page: toOptionalNumber(page),
            limit: toOptionalNumber(limit),
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Get('investors/me/profits')
  @Roles(RoleEnum.INVESTOR)
  @ApiOperation({ summary: "Investor: o'z foyda tarixi" })
  @ApiQuery({ name: 'is_paid', required: false, type: String, example: 'true' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getMyProfits(
    @Req() req: AuthedRequest,
    @Query('is_paid') is_paid?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.me.profits' },
        {
          requester: this.toRequester(req),
          query: {
            is_paid: toOptionalBool(is_paid),
            page: toOptionalNumber(page),
            limit: toOptionalNumber(limit),
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Post('investors')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create investor' })
  @ApiBody({ type: CreateInvestorDto })
  createInvestor(@Body() dto: CreateInvestorDto, @Req() req?: AuthedRequest) {
    return this.investorClient
      .send(
        { cmd: 'investor.create' },
        { dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Get('investors')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List investors (pagination + search + status)' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'inactive'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAllInvestors(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.find_all' },
        {
          requester: this.toRequester(req),
          query: {
            search,
            status,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
      )
      .pipe(timeout(8000));
  }

  /**
   * vpKijXce TC7: superadmin/admin investor ko'radigan AYNAN shu dashboardni
   * (kartalar + oylik grafik) istalgan investor uchun ochib nazorat qiladi.
   */
  @Get('investors/:investor_id/dashboard')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'Investor dashboard (nazorat): kartalar + oylik foyda grafigi',
  })
  @ApiParam({ name: 'investor_id' })
  @ApiQuery({
    name: 'months',
    required: false,
    type: Number,
    description: '1..36, default 12',
  })
  getInvestorDashboard(
    @Param('investor_id') investor_id: string,
    @Query('months') months?: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.dashboard' },
        {
          investor_id,
          query: { months: toOptionalNumber(months) },
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }

  @Get('investors/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Find investor by id (with investments/profits)' })
  @ApiParam({ name: 'id' })
  findInvestorById(@Param('id') id: string, @Req() req?: AuthedRequest) {
    return this.investorClient
      .send(
        { cmd: 'investor.find_by_id' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Patch('investors/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update investor' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateInvestorDto })
  updateInvestor(
    @Param('id') id: string,
    @Body() dto: UpdateInvestorDto,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.update' },
        { id, dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Delete('investors/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete investor (soft delete)' })
  @ApiParam({ name: 'id' })
  deleteInvestor(@Param('id') id: string, @Req() req?: AuthedRequest) {
    return this.investorClient
      .send(
        { cmd: 'investor.delete' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Post('investments')
  @Post('investors/:investor_id/investments')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create investment' })
  @ApiParam({ name: 'investor_id', required: false })
  @ApiBody({ type: CreateInvestmentDto })
  createInvestment(
    @Body() dto: CreateInvestmentDto,
    @Param('investor_id') investor_id?: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.investment.create' },
        {
          dto: { ...dto, investor_id: investor_id ?? dto.investor_id },
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }

  @Get('investments')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List investments' })
  @ApiQuery({ name: 'investor_id', required: false, type: String })
  @ApiQuery({ name: 'from_date', required: false, type: String })
  @ApiQuery({ name: 'to_date', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAllInvestments(
    @Query('investor_id') investor_id?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.investment.find_all' },
        {
          requester: this.toRequester(req),
          query: {
            investor_id,
            from_date,
            to_date,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Get('investors/:investor_id/investments')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List investments by investor' })
  @ApiParam({ name: 'investor_id' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findInvestmentsByInvestor(
    @Param('investor_id') investor_id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.investment.find_by_investor' },
        {
          investor_id,
          requester: this.toRequester(req),
          query: {
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Get('investments/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Find investment by id' })
  @ApiParam({ name: 'id' })
  findInvestmentById(@Param('id') id: string, @Req() req?: AuthedRequest) {
    return this.investorClient
      .send(
        { cmd: 'investor.investment.find_by_id' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Patch('investments/:id')
  @Patch('investors/:investor_id/investments/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update investment' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'investor_id', required: false })
  @ApiBody({ type: UpdateInvestmentDto })
  updateInvestment(
    @Param('id') id: string,
    @Body() dto: UpdateInvestmentDto,
    @Param('investor_id') investor_id?: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.investment.update' },
        {
          id,
          dto: { ...dto, investor_id: investor_id ?? dto.investor_id },
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }

  @Delete('investments/:id')
  @Delete('investors/:investor_id/investments/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete investment (soft delete)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'investor_id', required: false })
  deleteInvestment(@Param('id') id: string, @Req() req?: AuthedRequest) {
    return this.investorClient
      .send(
        { cmd: 'investor.investment.delete' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Post('profits')
  @Post('investors/:investor_id/profits')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create profit share manually' })
  @ApiParam({ name: 'investor_id', required: false })
  @ApiBody({ type: CreateProfitShareDto })
  createProfit(
    @Body() dto: CreateProfitShareDto,
    @Param('investor_id') investor_id?: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.profit.create' },
        {
          dto: { ...dto, investor_id: investor_id ?? dto.investor_id },
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }

  @Post('profits/calculate')
  @Post('investors/:investor_id/profits/calculate')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Calculate profit share by period and percentage' })
  @ApiParam({ name: 'investor_id', required: false })
  @ApiBody({ type: CalculateProfitDto })
  calculateProfit(
    @Body() dto: CalculateProfitDto,
    @Param('investor_id') investor_id?: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.profit.calculate' },
        {
          dto: { ...dto, investor_id: investor_id ?? dto.investor_id },
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }

  @Get('profits')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List profit shares' })
  @ApiQuery({ name: 'investor_id', required: false, type: String })
  @ApiQuery({ name: 'is_paid', required: false, type: String, example: 'true' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAllProfits(
    @Query('investor_id') investor_id?: string,
    @Query('is_paid') is_paid?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.profit.find_all' },
        {
          requester: this.toRequester(req),
          query: {
            investor_id,
            is_paid:
              typeof is_paid === 'string'
                ? ['true', '1', 'yes'].includes(is_paid.toLowerCase())
                : undefined,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Get('investors/:investor_id/profits')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List profit shares by investor' })
  @ApiParam({ name: 'investor_id' })
  @ApiQuery({
    name: 'is_paid',
    required: false,
    type: String,
    example: 'false',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findProfitByInvestor(
    @Param('investor_id') investor_id: string,
    @Query('is_paid') is_paid?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.profit.find_by_investor' },
        {
          investor_id,
          requester: this.toRequester(req),
          query: {
            is_paid:
              typeof is_paid === 'string'
                ? ['true', '1', 'yes'].includes(is_paid.toLowerCase())
                : undefined,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Patch('profits/:id/mark-paid')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Mark profit share as paid' })
  @ApiParam({ name: 'id' })
  markProfitPaid(@Param('id') id: string, @Req() req?: AuthedRequest) {
    // vpKijXce: requester endi uzatiladi — kassa chiqimi va audit haqiqiy
    // admin nomidan (ilgari user_id '0' / aktorsiz).
    return this.investorClient
      .send(
        { cmd: 'investor.profit.mark_paid' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }
}
