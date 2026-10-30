import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Inject,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, lastValueFrom, timeout, TimeoutError } from 'rxjs';
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
  CreateInvestorInvestmentDto,
  CreateInvestorProfitShareDto,
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

/**
 * vpKijXce: ichki yo'lda investor — yo'ldan. Body'da ham `investor_id` bo'lsa
 * u yo'l bilan bir xil bo'lishi shart: aks holda so'rov ma'nosi noaniq
 * (qaysi investorga yozilishi kerak) — jimgina tanlash o'rniga 400.
 */
export function pathInvestorId(
  pathId: string,
  dto: { investor_id?: string | null },
): string {
  const fromPath = String(pathId ?? '').trim();
  const fromBody =
    dto?.investor_id === undefined || dto?.investor_id === null
      ? ''
      : String(dto.investor_id).trim();
  if (fromBody && fromBody !== fromPath) {
    throw new BadRequestException(
      'investor_id: yo‘l va body’dagi qiymat farq qiladi',
    );
  }
  return fromPath;
}

@ApiTags('Investor')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvestorGatewayController {
  constructor(
    @Inject('INVESTOR') private readonly investorClient: ClientProxy,
    // vpKijXce: `user_id` bog'lashda login roli tekshiruvi. Oxirida va
    // @Optional — mavjud spec'lar kontrollerni faqat INVESTOR bilan quradi.
    @Optional()
    @Inject('IDENTITY')
    private readonly identityClient?: ClientProxy,
  ) {}

  /**
   * vpKijXce: investor yozuviga faqat INVESTOR rolli login bog'lanadi.
   * Ilgari istalgan users.id (kuryer, market, admin...) yozilardi — u login
   * `/investors/me` ni baribir ocholmasdi (@Roles(INVESTOR)), haqiqiy investor
   * esa bog'lanmay qolardi. Uzish (null/'') tekshirilmaydi. Identity javob
   * bermasa — bog'lash RAD etiladi (fail-closed).
   */
  private async assertInvestorLogin(userId: unknown): Promise<void> {
    if (userId === undefined || userId === null) {
      return;
    }
    const id = String(userId as string | number).trim();
    if (!id) {
      return;
    }
    if (!this.identityClient) {
      throw new ServiceUnavailableException(
        'Identity service ulanmagan — user_id tekshirib bo‘lmadi',
      );
    }
    const response: unknown = await firstValueFrom(
      this.identityClient
        .send({ cmd: 'identity.user.find_by_id' }, { id })
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException(
          'Foydalanuvchilar xizmati vaqtida javob bermadi (timeout)',
        );
      }
      throw error;
    });
    const rawRole = (response as { data?: { role?: unknown } } | null)?.data
      ?.role;
    const role =
      typeof rawRole === 'string' ? rawRole.trim().toLowerCase() : '';
    if (role !== RoleEnum.INVESTOR) {
      throw new BadRequestException(
        'user_id investor rolli login bo‘lishi kerak (POST /investor-users)',
      );
    }
  }

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
  @ApiOperation({
    summary: "Investor: o'z investitsiyalari",
    description:
      "su4IYGCN — `data.summary`: `total_amount` (butun davr yig'indisi) + `range_amount` (`from_date`/`to_date` oralig'idagi yig'indi, ro'yxat filtri bilan bir xil chegaralar, sahifadan qat'i nazar; oraliq berilmasa `total_amount` ga teng).",
  })
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
  async createInvestor(
    @Body() dto: CreateInvestorDto,
    @Req() req?: AuthedRequest,
  ) {
    await this.assertInvestorLogin(dto?.user_id);
    return lastValueFrom(
      this.investorClient
        .send(
          { cmd: 'investor.create' },
          { dto, requester: this.toRequester(req) },
        )
        .pipe(timeout(8000)),
    );
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
  async updateInvestor(
    @Param('id') id: string,
    @Body() dto: UpdateInvestorDto,
    @Req() req?: AuthedRequest,
  ) {
    await this.assertInvestorLogin(dto?.user_id);
    return lastValueFrom(
      this.investorClient
        .send(
          { cmd: 'investor.update' },
          { id, dto, requester: this.toRequester(req) },
        )
        .pipe(timeout(8000)),
    );
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

  /**
   * vpKijXce: ilgari `@Post('investments') @Post('investors/:investor_id/...')`
   * ikki qavat edi — Nest dekoratorlari pastdan yuqoriga qo'llanadi va
   * yuqoridagisi yo'lni QAYTA YOZADI: ichki (nested) yo'l umuman ro'yxatdan
   * o'tmasdi (404). Endi har yo'l — alohida handler (bitta servis cmd).
   */
  @Post('investments')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create investment' })
  @ApiBody({ type: CreateInvestmentDto })
  createInvestment(
    @Body() dto: CreateInvestmentDto,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.investment.create' },
        { dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Post('investors/:investor_id/investments')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create investment for investor' })
  @ApiParam({ name: 'investor_id' })
  @ApiBody({ type: CreateInvestorInvestmentDto })
  createInvestorInvestment(
    @Param('investor_id') investor_id: string,
    @Body() dto: CreateInvestorInvestmentDto,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.investment.create' },
        {
          dto: { ...dto, investor_id: pathInvestorId(investor_id, dto) },
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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update investment' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateInvestmentDto })
  updateInvestment(
    @Param('id') id: string,
    @Body() dto: UpdateInvestmentDto,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.investment.update' },
        { id, dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  /**
   * vpKijXce: ichki yo'l — investitsiya SHU investorniki bo'lishi shart
   * (`scope_investor_id`, servis tekshiradi; begona → 404). Ilgari yo'ldagi
   * investor_id body'ga yozilib, begona investitsiyani jimgina shu investorga
   * ko'chirib yuborishi mumkin edi.
   */
  @Patch('investors/:investor_id/investments/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update investment of investor' })
  @ApiParam({ name: 'investor_id' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateInvestmentDto })
  updateInvestorInvestment(
    @Param('investor_id') investor_id: string,
    @Param('id') id: string,
    @Body() dto: UpdateInvestmentDto,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.investment.update' },
        {
          id,
          dto,
          scope_investor_id: investor_id,
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }

  @Delete('investments/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete investment (soft delete)' })
  @ApiParam({ name: 'id' })
  deleteInvestment(@Param('id') id: string, @Req() req?: AuthedRequest) {
    return this.investorClient
      .send(
        { cmd: 'investor.investment.delete' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Delete('investors/:investor_id/investments/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete investment of investor (soft delete)' })
  @ApiParam({ name: 'investor_id' })
  @ApiParam({ name: 'id' })
  deleteInvestorInvestment(
    @Param('investor_id') investor_id: string,
    @Param('id') id: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.investment.delete' },
        {
          id,
          scope_investor_id: investor_id,
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }

  @Post('profits')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create profit share manually' })
  @ApiBody({ type: CreateProfitShareDto })
  createProfit(@Body() dto: CreateProfitShareDto, @Req() req?: AuthedRequest) {
    return this.investorClient
      .send(
        { cmd: 'investor.profit.create' },
        { dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Post('investors/:investor_id/profits')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create profit share for investor manually' })
  @ApiParam({ name: 'investor_id' })
  @ApiBody({ type: CreateInvestorProfitShareDto })
  createInvestorProfit(
    @Param('investor_id') investor_id: string,
    @Body() dto: CreateInvestorProfitShareDto,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.profit.create' },
        {
          dto: { ...dto, investor_id: pathInvestorId(investor_id, dto) },
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }

  @Post('profits/calculate')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Calculate profit share by period and percentage' })
  @ApiBody({ type: CalculateProfitDto })
  calculateProfit(@Body() dto: CalculateProfitDto, @Req() req?: AuthedRequest) {
    return this.investorClient
      .send(
        { cmd: 'investor.profit.calculate' },
        { dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Post('investors/:investor_id/profits/calculate')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'Calculate profit share for one investor by period and percentage',
  })
  @ApiParam({ name: 'investor_id' })
  @ApiBody({ type: CalculateProfitDto })
  calculateInvestorProfit(
    @Param('investor_id') investor_id: string,
    @Body() dto: CalculateProfitDto,
    @Req() req?: AuthedRequest,
  ) {
    return this.investorClient
      .send(
        { cmd: 'investor.profit.calculate' },
        {
          dto: { ...dto, investor_id: pathInvestorId(investor_id, dto) },
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
