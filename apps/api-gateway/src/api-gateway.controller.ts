import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Cashbox_type, Roles as RoleEnum } from '@app/common';
import { firstValueFrom, timeout } from 'rxjs';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { successRes } from '../../../libs/common/helpers/response';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Public } from './auth/public.decorator';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  SessionRevocationService,
  applyRevokedSessionIds,
} from './auth/session-revocation.service';
import {
  ChangeUserRoleRequestDto,
  CreateAdminRequestDto,
  CreateCourierRequestDto,
  CreateLogistRequestDto,
  CreateManagerRequestDto,
  CreateMarketRequestDto,
  CreateRegistratorRequestDto,
  MarketTgTokenResponseDto,
  RotateAllMarketTgTokensRequestDto,
  RotateAllMarketTgTokensResponseDto,
  UpdateAdminRequestDto,
  UpdateMarketAddOrderRequestDto,
  UpdateMarketCancelledHandoverQrRequestDto,
  UpdateMarketExpenseProofRequestDto,
  UpdateMarketTelegramGroupPiiRequestDto,
  UpdateMarketExtraCostRequestDto,
  UpdateMarketOperatorPhoneRequestDto,
  UpdateUserStatusRequestDto,
} from './dto/identity.swagger.dto';
import { SetCourierRegionsRequestDto } from './dto/courier-regions.swagger.dto';
import { CreateInvestorUserRequestDto } from './dto/investor.swagger.dto';
import { isRpcNotFoundError } from './order-qr-light-view';
import { ParseBigintIdPipe } from './pipes/parse-bigint-id.pipe';
import {
  LOGIST_REGIONS_UNAVAILABLE_MESSAGE,
  LogistRegionScopeService,
  isLogistRequester,
  isRowInLogistRegions,
  projectLogistPayload,
  resolveLogistRegionFilter,
} from './auth/logist-scope';

interface JwtUser {
  sub: string;
  username: string;
  roles?: string[];
  branch_id?: string | null;
  /** (Elchi Pochta #3) Sessiya id si — login/refresh tokenlarida. */
  sid?: string | null;
}

/**
 * YEThmZBn — GET /users «Filial» ustuni so'raladigan rollar (identity
 * `shouldAttachBranchRelation` bilan bir xil to'plam).
 */
const USER_BRANCH_ROLES = new Set([
  'courier',
  'manager',
  'registrator',
  'branch',
  'branch_admin',
]);
/** YEThmZBn — filial xizmati sekin bo'lsa ro'yxat shu muddatdan ortiq kutmaydi. */
const USER_BRANCH_LOOKUP_TIMEOUT_MS = 3000;

interface BranchAssignment {
  branch_id?: string | null;
  role?: string | null;
  branch?: {
    id?: string | null;
    type?: string | null;
  } | null;
}

@ApiTags('Identity')
@Controller()
export class ApiGatewayController {
  private readonly logger = new Logger(ApiGatewayController.name);

  constructor(
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    /**
     * (Elchi Pochta #3) Parol tiklanganda yopilgan sessiyalarni shu gateway
     * keshida darhol belgilash va socketlarini uzish (`kickSessions`).
     * Ixtiyoriy — spec'lar controller'ni usiz quradi.
     */
    @Optional() private readonly revocation?: SessionRevocationService,
    // Z3pUOxou — logist viloyatlari (GET /couriers). Yo'q bo'lsa logist
    // so'rovi 503 (fail-closed); boshqa rollar unga bog'liq emas.
    @Optional() private readonly logistScope?: LogistRegionScopeService,
  ) {}

  private toRequester(req: { user: JwtUser }) {
    return {
      id: req.user.sub,
      roles: req.user.roles ?? [],
    };
  }

  private async resolveBranchAssignment(
    reqUser: JwtUser,
  ): Promise<BranchAssignment | null> {
    const response = await firstValueFrom(
      this.branchClient
        .send(
          { cmd: 'branch.user.find_by_user' },
          {
            user_id: reqUser.sub,
            requester: { id: reqUser.sub, roles: reqUser.roles ?? [] },
          },
        )
        .pipe(timeout(8000)),
    );

    return (response?.data ?? null) as BranchAssignment | null;
  }

  /**
   * Filialning faol COURIER qatorlaridagi user_id'lar (branch_users). Rol
   * katta-kichik harfga qaramay solishtiriladi.
   */
  private async findBranchCourierIds(
    branchId: string,
    req: { user: JwtUser },
  ): Promise<string[]> {
    const branchUsersResponse = await firstValueFrom(
      this.branchClient
        .send(
          { cmd: 'branch.user.find_by_branch' },
          {
            branch_id: branchId,
            requester: this.toRequester(req),
          },
        )
        .pipe(timeout(8000)),
    );

    const branchUsers = Array.isArray(branchUsersResponse?.data)
      ? branchUsersResponse.data
      : [];
    return Array.from(
      new Set<string>(
        branchUsers
          .filter(
            (row: any) => String(row?.role ?? '').toUpperCase() === 'COURIER',
          )
          .map((row: any) => String(row?.user_id ?? '').trim())
          .filter(Boolean),
      ),
    );
  }

  private async findUserCashbox(userId: string, cashboxType: Cashbox_type) {
    try {
      const response = await firstValueFrom(
        this.financeClient
          .send(
            { cmd: 'finance.cashbox.find_by_user' },
            { user_id: String(userId), cashbox_type: cashboxType },
          )
          .pipe(timeout(8000)),
      );

      if (Array.isArray(response?.data)) {
        return (
          response.data.find(
            (cashbox: any) => cashbox?.cashbox_type === cashboxType,
          ) ?? null
        );
      }

      return response?.data ?? null;
    } catch {
      return null;
    }
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Gateway health check via identity service' })
  getHello() {
    return this.identityClient
      .send({ cmd: 'identity.health' }, {})
      .pipe(timeout(8000));
  }

  @Post('admins')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create admin' })
  @ApiBody({ type: CreateAdminRequestDto })
  @ApiCreatedResponse({ description: 'Admin created' })
  @ApiConflictResponse({ description: 'Conflict' })
  createAdmin(
    @Body() dto: CreateAdminRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.identityClient
      .send(
        { cmd: 'identity.user.create' },
        { dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Post('registrators')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create registrator' })
  @ApiBody({ type: CreateRegistratorRequestDto })
  @ApiCreatedResponse({ description: 'Registrator created' })
  @ApiConflictResponse({ description: 'Conflict' })
  async createRegistrator(
    @Body() dto: CreateRegistratorRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    const requesterRoles = (req?.user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    const isManager = requesterRoles.includes(RoleEnum.MANAGER);

    // Manager'lar uchun branch_id'ni JWT yoki BranchUser orqali to'g'rilash;
    // boshqalar uchun body'dan keladi. HYBRID branch tekshiruvi ham shu yerda.
    // (Bu hozircha gateway'da qoladi — kelajakda branch-service'ga ko'chiriladi.)
    let resolvedBranchId = String(dto?.branch_id ?? '').trim();
    if (isManager) {
      const assignment = await this.resolveBranchAssignment(req.user);
      const branchId = String(assignment?.branch_id ?? '').trim();
      const branchType = String(assignment?.branch?.type ?? '')
        .trim()
        .toUpperCase();

      if (!branchId) {
        throw new ForbiddenException(
          'Manager hech qaysi branchga biriktirilmagan',
        );
      }
      if (branchType !== 'HYBRID') {
        throw new ForbiddenException(
          "Faqat HYBRID branch manager'i registrator yarata oladi",
        );
      }
      resolvedBranchId = branchId;
    }

    if (!resolvedBranchId) {
      throw new BadRequestException('branch_id majburiy');
    }

    // identity-service o'zi user.save + branch.user.assign saga'sini bajaradi
    // va fail bo'lsa user'ni o'chiradi. Gateway endi faqat transit qiladi.
    return firstValueFrom(
      this.identityClient
        .send(
          { cmd: 'identity.registrator.create' },
          {
            dto: { ...dto, branch_id: resolvedBranchId },
            requester: this.toRequester(req),
          },
        )
        .pipe(timeout(8000)),
    );
  }

  @Get('registrators')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List registrators with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    example: 'active',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'Registrator list' })
  getRegistrators(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.identityClient
      .send(
        { cmd: 'identity.user.find_all' },
        {
          query: {
            role: RoleEnum.REGISTRATOR,
            search,
            status,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Get('admins')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List admins with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    example: 'active',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'Admin list' })
  getAdmins(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.identityClient
      .send(
        { cmd: 'identity.user.find_all' },
        {
          query: {
            role: RoleEnum.ADMIN,
            search,
            status,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
      )
      .pipe(timeout(8000));
  }

  // (dzyVftBx) Logist — viloyatlar ustidan nazorat qiluvchi xodim. Yaratish
  // admin naqshida (identity.logist.create); o'chirish umumiy
  // DELETE /users/:id orqali (identity uning viloyatlarini bo'shatadi).
  @Post('logists')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create logist' })
  @ApiBody({ type: CreateLogistRequestDto })
  @ApiCreatedResponse({ description: 'Logist created' })
  @ApiConflictResponse({ description: 'Conflict' })
  createLogist(
    @Body() dto: CreateLogistRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.identityClient
      .send(
        { cmd: 'identity.logist.create' },
        { dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Get('logists')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List logists with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    example: 'active',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'Logist list' })
  getLogists(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.identityClient
      .send(
        { cmd: 'identity.user.find_all' },
        {
          query: {
            role: RoleEnum.LOGIST,
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
   * vpKijXce — investor LOGINI (identity, rol = investor). BeePost
   * `POST /users/investor` naqshi: faqat kirish uchun (ism, telefon, parol),
   * maosh/filial/kassa yo'q. Keyingi qadam — `POST /investors` yoki
   * `PATCH /investors/:id` da `user_id` = shu login id si; `/investors/me`
   * investorni aynan shu bog'lanish orqali topadi. O'chirish — umumiy
   * `DELETE /users/:id`.
   */
  @Post('investor-users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create investor login (role = investor)' })
  @ApiBody({ type: CreateInvestorUserRequestDto })
  @ApiCreatedResponse({ description: 'Investor login created' })
  @ApiConflictResponse({ description: 'Phone number already exists' })
  createInvestorUser(
    @Body() dto: CreateInvestorUserRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.identityClient
      .send(
        { cmd: 'identity.investor_user.create' },
        { dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Get('investor-users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List investor logins (investorga bog‘lash uchun tanlov)',
  })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    example: 'active',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'Investor login list' })
  getInvestorUsers(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.identityClient
      .send(
        { cmd: 'identity.user.find_all' },
        {
          query: {
            role: RoleEnum.INVESTOR,
            search,
            status,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Post('couriers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MANAGER, RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create courier',
    description:
      "Menejer — faqat o'z filialida (`branch_id` yuborilmaydi yoki o'z filiali; boshqasi — 400). " +
      'perqZ3oM (ega qarori): superadmin/admin `branch_id` bilan istalgan FAOL HQ / REGIONAL / HYBRID filialda yaratadi ' +
      "(viloyat filialdan olinadi); `branch_id` yuborilmasa — HQ (avvalgidek). Noma'lum, nofaol, PICKUP yoki " +
      "viloyatsiz (HQ bo'lmagan) filial — 400, kuryer yaratilmaydi. Kuryer o'sha filialga biriktiriladi (branch_users) — " +
      'pul zanjiri menejer yaratgan kuryer bilan bir xil (kuryer → filial → HQ).',
  })
  @ApiBody({ type: CreateCourierRequestDto })
  @ApiCreatedResponse({ description: 'Courier created' })
  @ApiConflictResponse({ description: 'Conflict' })
  async createCourier(
    @Body() dto: CreateCourierRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    const requesterRoles = (req?.user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    const isSystemPrivileged =
      requesterRoles.includes(RoleEnum.SUPERADMIN) ||
      requesterRoles.includes(RoleEnum.ADMIN);
    const requestedBranchId = String(dto.branch_id ?? '').trim();

    // Branch selection: SUPERADMIN/ADMIN — tanlangan filial (perqZ3oM) yoki
    // sukut HQ; menejer — o'z BranchUser assignment'idan. region_id ham
    // branch'dan keladi. (Hozircha gateway'da — kelajakda branch-service'ga
    // ko'chiriladi.)
    let branchId = '';
    if (isSystemPrivileged && requestedBranchId) {
      // perqZ3oM (ega qarori): SA/admin HQ bo'lmagan filialga ham kuryer
      // yaratadi. Faqat raqamli id ('+1', ' 1 ', '0x1' — Postgres bigint'ga
      // jimgina aylantiradi); kanonik ko'rinish ('01' ≡ '1').
      if (!/^\d{1,19}$/.test(requestedBranchId)) {
        throw new BadRequestException("branch_id noto'g'ri");
      }
      branchId = BigInt(requestedBranchId).toString();
    } else if (isSystemPrivileged) {
      const hqBranch = await firstValueFrom(
        this.branchClient
          .send({ cmd: 'branch.find_hq' }, {})
          .pipe(timeout(8000)),
      );
      branchId = String(hqBranch?.data?.id ?? '').trim();
      if (!branchId) {
        throw new BadRequestException('HQ branch topilmadi');
      }
    } else {
      const assignment = await this.resolveBranchAssignment(req.user);
      branchId = String(assignment?.branch_id ?? '').trim();
      if (!branchId) {
        throw new ForbiddenException(
          'Foydalanuvchi hech qaysi branchga biriktirilmagan',
        );
      }
    }

    /**
     * ⚠️ Menejer uchun `branch_id` JIMGINA E'TIBORSIZ QOLDIRILMAYDI (Andijon
     * E2E, wUHQrZko): filial so'rovchidan aniqlanadi (o'z filiali); boshqa
     * filial yuborilsa ochiq 400, mos kelsa (menejer UI'si o'z filialini
     * yuboradi) avvalgidek. SA/admin uchun yuborilgan filial — tanlov
     * (perqZ3oM), quyida tekshiriladi.
     */
    if (
      !isSystemPrivileged &&
      requestedBranchId &&
      requestedBranchId !== branchId
    ) {
      throw new BadRequestException(
        `Kuryer faqat o'z filialingizda yaratiladi — branch_id=${requestedBranchId} qabul qilinmaydi`,
      );
    }

    const branchResponse = await firstValueFrom(
      this.branchClient
        .send(
          { cmd: 'branch.find_by_id' },
          { id: branchId, requester: this.toRequester(req) },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      // perqZ3oM: SA/admin tanlagan filial yo'q (yoki o'chirilgan) — 400.
      if (isSystemPrivileged && isRpcNotFoundError(error)) {
        throw new BadRequestException(
          `Filial topilmadi — branch_id=${branchId}`,
        );
      }
      throw error;
    });
    const branchType = String(branchResponse?.data?.type ?? '')
      .trim()
      .toUpperCase();
    const branchRegionId = String(branchResponse?.data?.region_id ?? '').trim();

    if (isSystemPrivileged) {
      if (!branchResponse?.data) {
        throw new BadRequestException(
          `Filial topilmadi — branch_id=${branchId}`,
        );
      }
      if (!requestedBranchId && branchType !== 'HQ') {
        throw new BadRequestException(
          'Admin/Superadmin uchun sukut — HQ branch, u HQ turida emas',
        );
      }
      const branchStatus = String(branchResponse.data.status ?? '')
        .trim()
        .toLowerCase();
      if (branchStatus && branchStatus !== 'active') {
        throw new BadRequestException(
          "Filial faol emas — unda kuryer yaratib bo'lmaydi",
        );
      }
      // branch-service `branch.user.assign` qoidasi bilan AYNI (u kuryer
      // yozilganidan KEYIN rad etib, saga kompensatsiyasiga tushardi).
      if (!['HQ', 'REGIONAL', 'HYBRID'].includes(branchType)) {
        throw new BadRequestException(
          'Kuryer faqat HQ, REGIONAL yoki HYBRID filialda yaratiladi',
        );
      }
      // HQ bo'lmagan filial kuryeri — viloyati filialdan (menejer yo'li
      // bilan bir xil); viloyatsiz filialda yaratilmaydi.
      if (branchType !== 'HQ' && !branchRegionId) {
        throw new BadRequestException('Filialda region_id topilmadi');
      }
    } else if (!branchRegionId) {
      throw new BadRequestException('Manager branchida region_id topilmadi');
    }

    // identity-service create + branch.user.assign saga'sini o'zi bajaradi.
    // Fail bo'lsa user'ni o'chiradi.
    return firstValueFrom(
      this.identityClient
        .send(
          { cmd: 'identity.courier.create' },
          {
            dto: {
              name: dto.name,
              phone_number: dto.phone_number,
              password: dto.password,
              salary: dto.salary,
              payment_day: dto.payment_day,
              tariff_home: dto.tariff_home,
              tariff_center: dto.tariff_center,
              region_id: branchRegionId || undefined,
              // DtKKY0V8 — tuman identity'da tekshiriladi (mavjud + viloyat).
              district_id: dto.district_id ?? undefined,
              branch_id: branchId,
            },
            requester: this.toRequester(req),
          },
        )
        .pipe(timeout(8000)),
    );
  }

  @Post('managers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create manager' })
  @ApiBody({ type: CreateManagerRequestDto })
  @ApiCreatedResponse({ description: 'Manager created' })
  @ApiConflictResponse({ description: 'Conflict' })
  async createManager(
    @Body() dto: CreateManagerRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    // identity-service'ning createManager o'zi user.save + branch.user.assign
    // saga'sini bajaradi (branch_id DTO'da majburiy).
    return firstValueFrom(
      this.identityClient
        .send(
          { cmd: 'identity.manager.create' },
          { dto, requester: this.toRequester(req) },
        )
        .pipe(timeout(8000)),
    );
  }

  @Get('couriers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    // Z3pUOxou (ega LG-S1/LG-S3): logist — o'z viloyatlari kuryerlari, pulsiz.
    RoleEnum.LOGIST,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List couriers with filtering and pagination',
    description:
      "Z3pUOxou — LOGIST: faqat `region_id` si o'ziga biriktirilgan viloyatlardan biri bo'lgan kuryerlar (`region_id` filtri — faqat o'z viloyati, boshqasi 400; biriktirilmagan — bo'sh). Maosh va moliya maydonlari (salary, payment_day, compensation_mode, commission_*, tariff_*, balanslar) yo'q; `branch_id` filtri logist uchun e'tiborsiz.",
  })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    example: 'active',
  })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({
    name: 'regionId',
    required: false,
    type: String,
    description: 'Alias for region_id',
  })
  @ApiQuery({ name: 'branch_id', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'Courier list' })
  async getCouriers(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('region_id') region_id?: string,
    @Query('regionId') regionId?: string,
    @Query('branch_id') branch_id?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const resolvedRegionId = region_id ?? regionId;
    const roles = (req?.user?.roles ?? []).map((role) =>
      String(role).toLowerCase(),
    );
    if (isLogistRequester(roles) && req?.user) {
      return this.getCouriersForLogist(
        { search, status, region_id: resolvedRegionId, page, limit },
        req,
      );
    }
    const isSystemPrivileged =
      roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN);

    let resolvedBranchId = String(branch_id ?? '').trim() || undefined;
    if (!isSystemPrivileged && req?.user?.sub) {
      const assignment = await this.resolveBranchAssignment(req.user);
      const assignedBranchId = String(assignment?.branch_id ?? '').trim();
      if (assignedBranchId) {
        resolvedBranchId = assignedBranchId;
      }
    }

    // Filialga bog'langan (SA/ADMIN bo'lmagan) so'rovchi: filial kuryerlari
    // AVVAL branch_users'dan olinadi va identity shu `user_ids` bilan
    // sahifalanadi. Ilgari identity avval sahifalardi (limit ≤ 100), filial
    // filtri esa KEYIN qo'llanardi — kuryerlar 100 tadan oshsa, filial (masalan
    // HQ) kuryerlari ro'yxatdan jimgina tushib qolardi va meta.total noto'g'ri
    // edi. SA/ADMIN yo'li o'zgarmagan.
    let branchCourierIds: string[] | null = null;
    if (!isSystemPrivileged && resolvedBranchId && req?.user) {
      branchCourierIds = await this.findBranchCourierIds(resolvedBranchId, req);
      if (!branchCourierIds.length) {
        const emptyPage = Number(page) > 0 ? Number(page) : 1;
        const emptyLimit =
          Number(limit) > 0 ? Math.min(Number(limit), 100) : 10;
        return successRes({
          items: [],
          meta: { page: emptyPage, limit: emptyLimit, total: 0, totalPages: 1 },
        });
      }
    }

    const response = await firstValueFrom(
      this.identityClient
        .send(
          { cmd: 'identity.courier.find_all' },
          {
            query: {
              search,
              status,
              region_id: resolvedRegionId,
              page: page ? Number(page) : undefined,
              limit: limit ? Number(limit) : undefined,
              ...(branchCourierIds ? { user_ids: branchCourierIds } : {}),
            },
          },
        )
        .pipe(timeout(8000)),
    );

    let items = Array.isArray(response?.data?.items) ? response.data.items : [];

    if (resolvedBranchId && req?.user) {
      // Ikkinchi qatlam: identity qaytargan har bir kuryer shu filialnikimi.
      const courierIdsInBranch = new Set(
        branchCourierIds ??
          (await this.findBranchCourierIds(resolvedBranchId, req)),
      );
      items = items.filter((courier: any) =>
        courierIdsInBranch.has(String(courier?.id ?? '').trim()),
      );
    }

    if (!items.length) {
      if (response?.data?.meta) {
        response.data.meta.total = 0;
        response.data.meta.totalPages = 1;
      }
      response.data.items = [];
      return response;
    }

    // Kuryer kassasi (balance / balance_cash / balance_card) faqat pul bilan
    // ishlaydigan rollarga qo'shiladi: SUPERADMIN, ADMIN, MANAGER. REGISTRATOR
    // va BRANCH kuryerlar ro'yxatini (masalan /dispatch kuryer tanlovi) ko'radi,
    // balanslarni emas — finance'ga murojaat ham qilinmaydi. Ruxsat ro'yxati
    // (allow-list): @Roles'ga keyin qo'shiladigan rol ham balanssiz qoladi.
    const canSeeCourierBalances =
      isSystemPrivileged || roles.includes(RoleEnum.MANAGER);
    if (!canSeeCourierBalances) {
      response.data.items = items;
      return response;
    }

    response.data.items = await Promise.all(
      items.map(async (courier: any) => ({
        ...courier,
        cashbox: await this.findUserCashbox(
          String(courier?.id ?? ''),
          Cashbox_type.FOR_COURIER,
        ),
      })),
    );

    return response;
  }

  /**
   * Z3pUOxou — GET /couriers (LOGIST): identity'ga `region_ids` (o'z
   * viloyatlari, qat'iy `courier.region_id IN`; super-kuryer kengaytmasi
   * yo'q). Javob qatori yana tekshiriladi (himoya), kassa so'ralmaydi, pul
   * maydonlari olib tashlanadi.
   */
  private async getCouriersForLogist(
    filters: {
      search?: string;
      status?: string;
      region_id?: string;
      page?: string;
      limit?: string;
    },
    req: { user: JwtUser },
  ) {
    if (!this.logistScope) {
      throw new ServiceUnavailableException(LOGIST_REGIONS_UNAVAILABLE_MESSAGE);
    }
    const regionIds = await this.logistScope.regionIds(req.user.sub);
    const regionFilter = resolveLogistRegionFilter(
      filters.region_id,
      regionIds,
    );
    const page = Number(filters.page) > 0 ? Number(filters.page) : 1;
    const limit =
      Number(filters.limit) > 0 ? Math.min(Number(filters.limit), 100) : 10;
    if (!regionIds.length) {
      return successRes({
        items: [],
        meta: { page, limit, total: 0, totalPages: 1 },
      });
    }

    const response = await firstValueFrom(
      this.identityClient
        .send(
          { cmd: 'identity.courier.find_all' },
          {
            query: {
              search: filters.search,
              status: filters.status,
              region_ids: regionFilter ? [regionFilter] : regionIds,
              page: filters.page ? Number(filters.page) : undefined,
              limit: filters.limit ? Number(filters.limit) : undefined,
            },
          },
        )
        .pipe(timeout(8000)),
    );
    const data = (response as { data?: { items?: unknown } } | null)?.data;
    const scoped =
      data && Array.isArray(data.items)
        ? {
            ...(response as object),
            data: {
              ...data,
              items: (data.items as unknown[]).filter((courier) =>
                isRowInLogistRegions(courier, regionIds),
              ),
            },
          }
        : response;
    return projectLogistPayload(req.user.roles, scoped);
  }

  @Get('managers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List managers with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    example: 'active',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'Manager list' })
  async getManagers(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const response = await firstValueFrom(
      this.identityClient
        .send(
          { cmd: 'identity.user.find_all' },
          {
            query: {
              role: RoleEnum.MANAGER,
              search,
              status,
              page: page ? Number(page) : undefined,
              limit: limit ? Number(limit) : undefined,
            },
          },
        )
        .pipe(timeout(8000)),
    );

    const items = Array.isArray(response?.data?.items)
      ? response.data.items
      : [];
    if (!items.length) {
      return response;
    }

    const requester = req?.user ? this.toRequester(req) : undefined;
    const branchRows = await firstValueFrom(
      this.branchClient
        .send(
          { cmd: 'branch.find_all' },
          {
            requester,
            query: {
              status: 'active',
              page: 1,
              limit: 10000,
            },
          },
        )
        .pipe(timeout(8000)),
    ).catch(() => null);
    const branches = Array.isArray(branchRows?.data?.items)
      ? branchRows.data.items
      : [];

    const branchByManagerId = new Map<string, any>();
    for (const branch of branches) {
      const managerIds = [
        branch?.manager_id,
        branch?.payment?.user_id,
        branch?.payment?.manager_id,
      ]
        .map((id) => String(id ?? '').trim())
        .filter(Boolean);
      for (const managerId of managerIds) {
        if (!branchByManagerId.has(managerId)) {
          branchByManagerId.set(managerId, branch);
        }
      }
    }

    response.data.items = await Promise.all(
      items.map(async (manager: any) => {
        const managerId = String(manager?.id ?? '').trim();
        let branch = branchByManagerId.get(managerId) ?? null;

        if (!branch && managerId) {
          const assignment = await firstValueFrom(
            this.branchClient
              .send(
                { cmd: 'branch.user.find_by_user' },
                { user_id: managerId, requester },
              )
              .pipe(timeout(8000)),
          ).catch(() => null);
          branch = assignment?.data?.branch ?? null;
        }

        const branchId = String(branch?.id ?? '').trim();
        const cashbox = branchId
          ? await this.findUserCashbox(branchId, Cashbox_type.BRANCH)
          : null;
        const payableToHq = Math.max(Number(branch?.berilishi_kerak ?? 0), 0);

        return {
          ...manager,
          branch,
          branch_id: branchId || (manager?.branch_id ?? null),
          cashbox,
          payable_to_hq: payableToHq,
          berilishi_kerak: payableToHq,
          olinishi_kerak: payableToHq,
        };
      }),
    );

    return response;
  }

  // hEjjuJaT — super-kuryer (ko'p viloyat) va viloyat bo'yicha tarif.
  // Faqat SUPERADMIN / ADMIN (kuryer tarifi — pul sozlamasi).
  @Get('couriers/:id/regions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Super-kuryer viloyatlari va viloyat tariflari (hEjjuJaT)',
  })
  @ApiParam({ name: 'id', description: 'Courier ID' })
  getCourierRegions(@Param('id', ParseBigintIdPipe) id: string) {
    return this.identityClient
      .send({ cmd: 'identity.courier.regions.get' }, { id })
      .pipe(timeout(8000));
  }

  @Put('couriers/:id/regions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Super-kuryer bayroqlari va viloyatlar ro'yxatini to'liq almashtirish (hEjjuJaT)",
  })
  @ApiParam({ name: 'id', description: 'Courier ID' })
  @ApiBody({ type: SetCourierRegionsRequestDto })
  setCourierRegions(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: SetCourierRegionsRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.identityClient
      .send(
        { cmd: 'identity.courier.regions.set' },
        { id, dto, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Get('couriers/region/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List couriers by region id' })
  @ApiParam({ name: 'id', description: 'Region ID' })
  @ApiOkResponse({ description: 'Courier list by region' })
  getCouriersByRegion(@Param('id') id: string) {
    return this.identityClient
      .send(
        { cmd: 'identity.courier.find_all' },
        {
          query: {
            region_id: id,
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Get('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all users with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'role', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    example: 'active',
  })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({
    name: 'regionId',
    required: false,
    type: String,
    description: 'Alias for region_id',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({
    name: 'telegram_linked',
    required: false,
    enum: ['true', 'false'],
    description:
      'yA31z7Rr — «Ulangan / Ulanmagan» chiplari: true — Telegram boti ' +
      'ulangan (qatordagi `telegram_linked: true`), false — ulanmagan. Boshqa ' +
      'filtrlar bilan AND; `meta.total` / `countsByRole` filtrdan keyin. ' +
      'Boshqa qiymat — 400.',
  })
  @ApiOkResponse({
    description:
      'User list. YEThmZBn / kGIjOciz: har qatorda `branch_id: string | null` ' +
      'va `branch: { id, name } | null` — kuryer / menejer / registrator / ' +
      'filial xodimining filiali (boshqa rollar va filial xizmati javob ' +
      'bermasa — null). x6IO746K: `role = market_operator` qatorlarida ' +
      '`market: { id, name } | null` (market o`chirilgan / topilmagan — null; ' +
      'boshqa rollarda kalit yo`q).',
  })
  async getUsers(
    @Query('search') search?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('region_id') region_id?: string,
    @Query('regionId') regionId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
    @Query('telegram_linked') telegramLinked?: string,
  ) {
    const resolvedRegionId = region_id ?? regionId;
    const telegramLinkedFilter = this.parseTelegramLinkedFilter(telegramLinked);
    const requesterRoles = (req?.user?.roles ?? []).map((item) =>
      String(item ?? '').toLowerCase(),
    );
    const isSystemPrivileged =
      requesterRoles.includes(RoleEnum.SUPERADMIN) ||
      requesterRoles.includes(RoleEnum.ADMIN);
    // fix #3: VIEW = hamma. Manager endi admin/superadmin kabi BARCHA userlarni
    // ko'radi — ro'yxat branch_users bo'yicha cheklanmaydi va "branchga
    // biriktirilmagan" 403 manager uchun OLIB TASHLANDI. Ilgari shu yerda
    // bo'lgan manager branch-scope bloki butunlay chiqarib tashlandi; keyingi
    // post-filter bloki ham (manager-only) olib tashlandi. Tahrirlash huquqi
    // esa identity-service'da created_by bo'yicha ALOHIDA cheklanadi.
    //
    // SECURITY-TODO (alohida karta): identity find_all → sanitize() parol,
    // refresh_token va market_tg_token'ni olib tashlaydi, LEKIN `salary` (va
    // payment_day/commission_*) ro'yxat payload'ida qoladi. Endi manager ham
    // bu ro'yxatni to'liq ko'radi — maosh kabi maxfiy maydonlar menejerga
    // ochiq. Bu yerda TUZATILMAYDI; alohida xavfsizlik kartasida hal qilinsin.
    const canViewAllUsers =
      isSystemPrivileged || requesterRoles.includes(RoleEnum.MANAGER);

    // o5jS4rUS: kuryer/filial ko'lami FAQAT menejerga. Superadmin/admin hech
    // qaysi filialga biriktirilmagan — ilgari ular ham HQ'ga fallback qilib,
    // HQ'ga biriktirilmagan BARCHA viloyat kuryerlarini ro'yxatdan yashirardi
    // (/users?role=courier 2 ta, /couriers 10 ta). Tizim egasi uchun ko'lam
    // cheklanmagan.
    const requesterCanHaveCourierScope =
      requesterRoles.includes(RoleEnum.MANAGER) && !isSystemPrivileged;

    let branchBoundUserIds: string[] | undefined;
    if (requesterCanHaveCourierScope && req?.user?.sub) {
      const assignment = await this.resolveBranchAssignment(req.user);
      let branchId = String(assignment?.branch_id ?? '').trim();

      // fix #3: manager ham admin/superadmin kabi HQ'ga fallback qiladi —
      // branchga biriktirilmagan manager bu yerda endi 403 OLMAYDI.
      if (!branchId && canViewAllUsers) {
        const hqBranch = await firstValueFrom(
          this.branchClient
            .send({ cmd: 'branch.find_hq' }, {})
            .pipe(timeout(8000)),
        );
        branchId = String(hqBranch?.data?.id ?? '').trim();
      }

      if (!branchId) {
        throw new ForbiddenException(
          "Foydalanuvchi courier ko'rish uchun branchga biriktirilmagan",
        );
      }

      const branchUsersResponse = await firstValueFrom(
        this.branchClient
          .send(
            { cmd: 'branch.user.find_by_branch' },
            { branch_id: branchId, requester: this.toRequester(req) },
          )
          .pipe(timeout(8000)),
      );
      const branchUsers = Array.isArray(branchUsersResponse?.data)
        ? branchUsersResponse.data
        : [];
      branchBoundUserIds = Array.from(
        new Set(
          branchUsers
            .map((row: any) => String(row?.user_id ?? '').trim())
            .filter(Boolean),
        ),
      );
    }

    const response = await firstValueFrom(
      this.identityClient
        .send(
          { cmd: 'identity.user.find_all' },
          {
            query: {
              search,
              role,
              status,
              region_id: resolvedRegionId,
              // yA31z7Rr — server tomonda (sahifalash va total to'g'ri).
              telegram_linked: telegramLinkedFilter,
              // 2CBnPAeg — menejer ko'lami identity SO'ROVIDA: kuryer va
              // filial rolidagi foydalanuvchi faqat menejer filialiga
              // biriktirilgan bo'lsa chiqadi (boshqa rollar cheklanmaydi).
              // Ilgari sahifa olingandan KEYIN gateway'da filtrlanardi —
              // `meta.total` / `totalUsers` sahifadagi qatorlar soniga teng,
              // `countsByRole` esa ko'lamsiz edi. Endi ro'yxat, `total` va
              // `countsByRole` bitta shart bilan (filial doirasida).
              branch_scope: Array.isArray(branchBoundUserIds)
                ? { user_ids: branchBoundUserIds }
                : undefined,
              page: page ? Number(page) : undefined,
              limit: limit ? Number(limit) : undefined,
            },
          },
        )
        .pipe(timeout(8000)),
    );

    // fix #3: manager-only branch post-filter OLIB TASHLANDI — manager endi
    // admin/superadmin kabi BARCHA userlarni ko'radi (view parity). Tahrirlash
    // huquqi identity-service'da created_by bo'yicha cheklanadi.

    // YEThmZBn: «Filial» ustuni — har qatorga `branch: { id, name } | null`.
    const pageItems = (response as { data?: { items?: unknown } } | undefined)
      ?.data?.items;
    if (Array.isArray(pageItems)) {
      await this.attachUserBranches(
        pageItems as Array<Record<string, unknown>>,
        req,
      );
    }

    return response;
  }

  /**
   * yA31z7Rr — `?telegram_linked=true|false` (katta-kichik harf farqsiz).
   * Bo'sh / berilmagan — filtr yo'q; boshqa qiymat — 400 (jimgina
   * e'tiborsiz qoldirilsa chip «Ulanmagan» bo'lsa ham hamma chiqardi).
   */
  private parseTelegramLinkedFilter(value?: string): boolean | undefined {
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase();
    if (!normalized) return undefined;
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    throw new BadRequestException(
      "telegram_linked faqat true yoki false bo'lishi mumkin",
    );
  }

  /**
   * YEThmZBn — GET /users ro'yxatiga filial: sahifadagi filial-rolli
   * foydalanuvchilar (kuryer, menejer, registrator, filial) uchun filial
   * xizmatiga BITTA so'rov (`branch.user.find_by_user_ids`, N+1 yo'q).
   * Boshqa rollar va biriktirilmaganlar — `branch: null`. Filial xizmati
   * javob bermasa / xato bersa — hamma `branch: null`, ro'yxat baribir 200.
   * Faqat shu HTTP javobi boyitiladi — `identity.user.find_all` ning ichki
   * chaqiruvchilari uchun shakl o'zgarmaydi.
   */
  private async attachUserBranches(
    items: Array<Record<string, unknown>>,
    req?: { user: JwtUser },
  ): Promise<void> {
    // string / number qiymat matni; boshqasi (obyekt, null) — ''.
    const textOf = (value: unknown) =>
      typeof value === 'string' || typeof value === 'number'
        ? String(value).trim()
        : '';
    const rowId = (row: Record<string, unknown>) => textOf(row?.id);
    const lookupIds = Array.from(
      new Set(
        items
          .filter((row) =>
            USER_BRANCH_ROLES.has(textOf(row?.role).toLowerCase()),
          )
          .map(rowId)
          .filter(Boolean),
      ),
    );

    const branchByUser = new Map<string, { id: string; name: string | null }>();
    if (lookupIds.length && req?.user) {
      try {
        const res = await firstValueFrom(
          this.branchClient
            .send<{
              data?: Array<{
                user_id?: unknown;
                branch?: { id?: unknown; name?: unknown } | null;
              }>;
            }>(
              { cmd: 'branch.user.find_by_user_ids' },
              { user_ids: lookupIds, requester: this.toRequester(req) },
            )
            .pipe(timeout(USER_BRANCH_LOOKUP_TIMEOUT_MS)),
        );
        for (const row of Array.isArray(res?.data) ? res.data : []) {
          const userId = textOf(row?.user_id);
          const branchId = textOf(row?.branch?.id);
          if (!userId || !branchId) continue;
          const name = row?.branch?.name;
          branchByUser.set(userId, {
            id: branchId,
            name: typeof name === 'string' && name.trim() ? name : null,
          });
        }
      } catch (error) {
        this.logger.warn(
          `GET /users: branch.user.find_by_user_ids failed (${
            error instanceof Error ? error.message : 'unknown error'
          }) — branch: null`,
        );
      }
    }

    for (const row of items) {
      if (row && typeof row === 'object') {
        const branch = branchByUser.get(rowId(row)) ?? null;
        // kGIjOciz — `branch_id` (= branch.id) ham: «Filial» filtri/ustuni
        // uchun obyektni ochmasdan.
        row.branch_id = branch?.id ?? null;
        row.branch = branch;
      }
    }
  }

  @Get('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user by id (admin/superadmin)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiOkResponse({
    description:
      'User by id. kGIjOciz: `branch_id: string | null` va `branch: { id, ' +
      'name } | null` (kuryer / menejer / registrator / filial xodimi; ' +
      'boshqa rollar — null). x6IO746K: market operatorida `market: { id, ' +
      'name } | null`.',
  })
  @ApiNotFoundResponse({ description: 'Not found' })
  async getUserById(@Param('id') id: string, @Req() req?: { user?: JwtUser }) {
    // `id` is a bigint PK downstream. A non-numeric segment (e.g. /users/me,
    // /users/profile) reached the DB and 500'd on "invalid input syntax for
    // type bigint". Reject it as 404 up front. (Live-E2E fix.)
    if (!/^\d+$/.test(String(id))) {
      throw new NotFoundException('User not found');
    }
    const requesterRoles = (req?.user?.roles ?? []).map((r) =>
      String(r).toLowerCase(),
    );
    const requesterIsPrivileged =
      requesterRoles.includes(RoleEnum.SUPERADMIN) ||
      requesterRoles.includes(RoleEnum.ADMIN);
    const requesterIsMarket = requesterRoles.includes(RoleEnum.MARKET);

    if (requesterIsMarket && !requesterIsPrivileged && req?.user?.sub !== id) {
      throw new ForbiddenException('Market faqat o‘z profilini ko‘ra oladi');
    }

    if (
      !requesterIsPrivileged &&
      requesterRoles.includes(RoleEnum.MANAGER) &&
      req?.user?.sub
    ) {
      const assignment = await this.resolveBranchAssignment(req.user);
      const branchId = String(assignment?.branch_id ?? '').trim();
      const branchType = String(assignment?.branch?.type ?? '')
        .trim()
        .toUpperCase();

      if (!branchId) {
        throw new ForbiddenException(
          'Manager hech qaysi branchga biriktirilmagan',
        );
      }
      if (branchType !== 'REGIONAL' && branchType !== 'HYBRID') {
        throw new ForbiddenException(
          'Bu branch type uchun userlarni ko‘rish ruxsati yo‘q',
        );
      }

      const branchUsersResponse = await firstValueFrom(
        this.branchClient
          .send(
            { cmd: 'branch.user.find_by_branch' },
            {
              branch_id: branchId,
              requester: this.toRequester(req as { user: JwtUser }),
            },
          )
          .pipe(timeout(8000)),
      );
      const branchUsers = Array.isArray(branchUsersResponse?.data)
        ? branchUsersResponse.data
        : [];
      const branchUserIds = new Set(
        branchUsers
          .map((row: any) => String(row?.user_id ?? '').trim())
          .filter(Boolean),
      );

      if (!branchUserIds.has(String(id).trim())) {
        throw new ForbiddenException('Siz bu user ma’lumotini ko‘ra olmaysiz');
      }
    }

    // (GvL6ZFAd) market_tg_token bu javobda HECH bir rol uchun (SUPERADMIN
    // ham) yo'q — avvalgi SUPERADMIN/ADMIN istisnosi (`include_tg_token`)
    // bekor qilindi. Token: GET /markets/:id/tg-token (faqat SUPERADMIN).
    // YEThmZBn: `include_branch` — kuryer/menejer/registrator filiali
    // (`branch: { id, name } | null`) javobga qo'shiladi.
    return firstValueFrom(
      this.identityClient
        .send({ cmd: 'identity.user.find_by_id' }, { id, include_branch: true })
        .pipe(timeout(8000)),
    );
  }

  @Patch('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update user (all roles)',
    description:
      "`password` berilsa (parolni tiklash): shu foydalanuvchining BARCHA sessiyalari darhol yopiladi (`password_changed`; 48 soatlik qulfga bog'liq emas) — uning access tokenlari keyingi so'rovdayoq 401, refresh ham 401. O'zini tahrirlasa (`:id` = o'zi) — joriy sessiya qoladi, qolganlari yopiladi. Javobga `sessions_revoked: <n>` qo'shiladi.",
  })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiBody({ type: UpdateAdminRequestDto })
  @ApiOkResponse({ description: 'User updated' })
  @ApiConflictResponse({ description: 'Conflict' })
  @ApiNotFoundResponse({ description: 'Not found' })
  async updateUser(
    @Param('id') id: string,
    @Body() dto: UpdateAdminRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    // fix #3: gateway endi managerni OLDINDAN 403 qilmaydi (branch_users
    // scope + REGIONAL/HYBRID tekshiruvi olib tashlandi). Egalik qarorini
    // identity-service beradi — AUTHORITATIVE: manager faqat O'ZI YARATGAN
    // (created_by === requester.id) userni tahrirlay oladi, aks holda 403.
    // Delete/status esa ushbu route'larda admin/superadmin-only (@Roles).
    // (Elchi Pochta #3) `current_session_id` — o'z parolini almashtirsa
    // joriy sessiya qolsin; parol tiklansa yopilgan sessiyalar shu gateway
    // keshida darhol «yopilgan» (`applyRevokedSessionIds`), (2026-10-24)
    // ularning ochiq socketlari `auth:session_revoked` (`password_changed`)
    // olib uziladi.
    const response = await firstValueFrom(
      this.identityClient
        .send<unknown>(
          { cmd: 'identity.user.update' },
          {
            id,
            dto,
            requester: this.toRequester(req),
            current_session_id:
              typeof req.user.sid === 'string' ? req.user.sid : null,
          },
        )
        .pipe(timeout(8000)),
    );
    return applyRevokedSessionIds(response, this.revocation);
  }

  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete user (all roles)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiOkResponse({ description: 'User deleted' })
  @ApiNotFoundResponse({ description: 'Not found' })
  deleteUser(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    // 15 s: kuryer o'chirilishidan oldin identity filial tekshiruvini
    // (branch.user.courier_transfer_check → finance/order/logistics) 12 s
    // gacha kutadi — gateway limiti undan uzunroq bo'lishi shart.
    return this.identityClient
      .send(
        { cmd: 'identity.user.delete' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(timeout(15000));
  }

  /**
   * K3scaE0W — rolni o'zgartirish. Faqat SUPERADMIN (admin → 403). Ichki
   * qoidalar (qaysi rollar, filial biriktiruvi, logist viloyatlari, rolga
   * bog'liq maydonlar, jurnal old/new role) — identity `changeUserRole`.
   */
  @Patch('users/:id/role')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Change user role (superadmin only; admin ⇄ registrator ⇄ manager ⇄ logist)',
  })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiBody({ type: ChangeUserRoleRequestDto })
  @ApiOkResponse({ description: 'Role changed' })
  @ApiConflictResponse({
    description: 'User is assigned to a branch — unassign first',
  })
  @ApiNotFoundResponse({ description: 'Not found' })
  changeUserRole(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: ChangeUserRoleRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.identityClient
      .send(
        { cmd: 'identity.user.change_role' },
        { id, role: dto.role, requester: this.toRequester(req) },
      )
      .pipe(timeout(10000));
  }

  /**
   * K3scaE0W — rol katalogi: Roles enum'ining to'liq ro'yxati (o'zbekcha
   * nom, yaratish marshruti, almashtirish/filtr bayroqlari). Frontend
   * RoleSelector / UserFilters / ruxsatlar ma'lumotnomasi shundan quriladi.
   */
  @Get('roles')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Role catalog (single source for role lists)' })
  @ApiOkResponse({ description: 'Role catalog' })
  getRoleCatalog() {
    return this.identityClient
      .send({ cmd: 'identity.role.catalog' }, {})
      .pipe(timeout(8000));
  }

  @Patch('users/:id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set user status (active/inactive)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiBody({ type: UpdateUserStatusRequestDto })
  @ApiOkResponse({ description: 'Status updated' })
  @ApiNotFoundResponse({ description: 'Not found' })
  updateUserStatus(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.identityClient
      .send(
        { cmd: 'identity.user.status' },
        { id, status: dto.status, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Post('markets')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create market' })
  @ApiBody({ type: CreateMarketRequestDto })
  @ApiCreatedResponse({ description: 'Market created' })
  @ApiConflictResponse({ description: 'Conflict' })
  async createMarket(
    @Body() dto: CreateMarketRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    const requesterRoles = (req?.user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    const isManager = requesterRoles.includes(RoleEnum.MANAGER);

    if (isManager) {
      const assignment = await this.resolveBranchAssignment(req.user);
      const branchId = String(assignment?.branch_id ?? '').trim();
      const branchType = String(assignment?.branch?.type ?? '')
        .trim()
        .toUpperCase();

      if (!branchId) {
        throw new ForbiddenException(
          'Manager hech qaysi branchga biriktirilmagan',
        );
      }
      if (branchType !== 'HYBRID') {
        throw new ForbiddenException(
          "Faqat HYBRID branch manager'i market yarata oladi",
        );
      }
    }

    return this.identityClient
      .send(
        { cmd: 'identity.market.create' },
        {
          dto: {
            name: dto.name,
            phone_number: dto.phone_number,
            username: dto.username,
            password: dto.password,
            // KmWO9gTA: tariflar LEGACY va ixtiyoriy (berilmasa NULL).
            tariff_home: dto.tariff_home,
            tariff_center: dto.tariff_center,
            // KmWO9gTA: «Vazn va hajm bo'yicha narx» (faqat admin/superadmin —
            // identity tekshiradi).
            weight_volume_pricing: dto.weight_volume_pricing,
            default_tariff: dto.default_tariff,
            add_order: dto.add_order,
            cancelled_handover_qr_required: dto.cancelled_handover_qr_required,
            expense_proof_conditions: dto.expense_proof_conditions,
            // w2bDrE3i (faqat admin/superadmin — identity tekshiradi).
            extra_cost_enabled: dto.extra_cost_enabled,
            extra_cost_requires_approval: dto.extra_cost_requires_approval,
            // VRyloH62: chekdagi operator raqami sozlamasi.
            require_operator_phone: dto.require_operator_phone,
            default_operator_phone: dto.default_operator_phone,
          },
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }

  @Get('markets')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.COURIER,
    // iFAkvaht (N16): logist buyurtmalari «Market» filtri — faqat minimal
    // ko'rinish {id, name, status} (tarif, telefon, kassa YO'Q; ega LG-S1).
    RoleEnum.LOGIST,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List markets with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    example: 'active',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({
    description:
      "Market list. SUPERADMIN/ADMIN: to'liq qator + cashbox. MANAGER/REGISTRATOR/BRANCH: faqat {id, name, phone_number, status, tariff_home, tariff_center, default_tariff} (yiFTzkzH; tarif maydoni yo'q bo'lsa null). COURIER va LOGIST (iFAkvaht — buyurtmalar «Market» filtri): faqat {id, name, status}.",
  })
  async getMarkets(
    @Req() req: { user: JwtUser },
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const response = await firstValueFrom(
      this.identityClient
        .send(
          { cmd: 'identity.market.find_all' },
          {
            query: {
              search,
              status,
              page: page ? Number(page) : undefined,
              limit: limit ? Number(limit) : undefined,
            },
          },
        )
        .pipe(timeout(8000)),
    );

    const items = Array.isArray(response?.data?.items)
      ? response.data.items
      : [];
    if (!items.length) {
      return response;
    }

    // CODE-08 / C11: faqat superadmin/admin to'liq market qatorini (login
    // telefoni, username, tariflar, sozlamalar) va kassa balansini oladi.
    // Qolgan rollar ekranlari faqat tanlash ro'yxatini ko'rsatadi — ularga
    // shu ro'yxat uchun kerakli maydonlar qaytadi (kassa so'rovi ham yo'q).
    const view = this.marketListView(req?.user);
    if (view !== 'full') {
      response.data.items = items.map((market: any) =>
        this.projectMarketListItem(market, view),
      );
      return response;
    }

    response.data.items = await Promise.all(
      items.map(async (market: any) => ({
        ...market,
        cashbox: await this.findUserCashbox(
          String(market?.id ?? ''),
          Cashbox_type.FOR_MARKET,
        ),
      })),
    );

    return response;
  }

  /**
   * GET /markets ko'rinishi (CODE-08 / C11):
   * - full: SUPERADMIN/ADMIN — to'liq qator + cashbox (o'zgarmagan);
   * - branch_staff: MANAGER/REGISTRATOR/BRANCH — buyurtma yaratish, filtr va
   *   mahsulot ekranlari market tanlashda id, nom, telefon va statusni
   *   ishlatadi (orders/create Step1Market, orders, products); yiFTzkzH:
   *   buyurtma yaratishda ikkala narxni (uyga/markazga) ko'rsatish uchun
   *   `tariff_home`, `tariff_center`, `default_tariff` ham (login/kassa yo'q);
   * - minimal: COURIER, LOGIST (iFAkvaht — logist buyurtmalari «Market»
   *   filtri) va boshqa har qanday rol — faqat filtr: id, nom, status.
   *   Telefon, username, tariflar, kassa — yo'q.
   */
  private marketListView(
    user: JwtUser | undefined,
  ): 'full' | 'branch_staff' | 'minimal' {
    const roles = new Set(
      (user?.roles ?? []).map((role) => String(role).toLowerCase()),
    );
    if (roles.has(RoleEnum.SUPERADMIN) || roles.has(RoleEnum.ADMIN)) {
      return 'full';
    }
    if (
      roles.has(RoleEnum.MANAGER) ||
      roles.has(RoleEnum.REGISTRATOR) ||
      roles.has(RoleEnum.BRANCH)
    ) {
      return 'branch_staff';
    }
    return 'minimal';
  }

  private projectMarketListItem(
    market: Record<string, unknown> | null | undefined,
    view: 'branch_staff' | 'minimal',
  ) {
    const base = {
      id: market?.id ?? null,
      name: market?.name ?? null,
      status: market?.status ?? null,
    };
    return view === 'branch_staff'
      ? {
          ...base,
          phone_number: market?.phone_number ?? null,
          // yiFTzkzH: tarif tanlash (CS-E) — uyga/markazga narx + sukut.
          tariff_home: market?.tariff_home ?? null,
          tariff_center: market?.tariff_center ?? null,
          default_tariff: market?.default_tariff ?? null,
          // KmWO9gTA: FALSE — faqat standart narx (vazn/hajm qo'shimchasiz).
          weight_volume_pricing: market?.weight_volume_pricing ?? true,
        }
      : base;
  }

  // ==================== Market Telegram tokeni (GvL6ZFAd) ====================
  // market_tg_token — bearer sir (order-bot / guruh ulash kaliti). U endi
  // HECH bir umumiy javobda yo'q (/users, /users/:id, /markets). Ko'rish va
  // almashtirish FAQAT shu SUPERADMIN-only marshrutlar orqali; ADMIN, MANAGER
  // va boshqalar — 403 (RolesGuard; identity ham requester.roles'ni qayta
  // tekshiradi). Har amal activity log'ga yoziladi, token qiymati — yo'q.
  // Javoblar `Cache-Control: no-store` — sir brauzer/proksi keshida qolmasin.
  //
  // ⚠️ TARTIB: statik `markets/tg-token/rotate-all` `markets/:id/...`
  // marshrutlaridan OLDIN e'lon qilinadi.

  @Post('markets/tg-token/rotate-all')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Rotate the Telegram token of EVERY active market in one transaction (SUPERADMIN only)',
    description:
      "Barcha faol (o'chirilmagan) marketlarning market_tg_token'i bitta tranzaksiyada yangilanadi. Tanada aniq tasdiq `{ \"confirm\": \"ROTATE_ALL\" }` shart (aks holda 400). Javobda faqat son (`rotated_count`), tokenlar YO'Q. ⚠️ Shundan keyin har bir market yangi tokenni admin'dan olishi kerak: order-bot'ga qayta ulanish va yangi guruh ulash faqat yangi token bilan; mavjud ulangan guruhlar ishlashda davom etadi.",
  })
  @ApiBody({ type: RotateAllMarketTgTokensRequestDto })
  @ApiOkResponse({ type: RotateAllMarketTgTokensResponseDto })
  @ApiBadRequestResponse({ description: "confirm yo'q yoki 'ROTATE_ALL' emas" })
  @ApiForbiddenResponse({ description: 'SUPERADMIN emas' })
  rotateAllMarketTgTokens(
    @Body() dto: RotateAllMarketTgTokensRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    // 30 s: identity barcha marketlarni bitta tranzaksiyada yangilaydi.
    return this.identityClient
      .send(
        { cmd: 'identity.market.rotate_all_tg_tokens' },
        { confirm: dto.confirm, requester: this.toRequester(req) },
      )
      .pipe(timeout(30000));
  }

  @Get('markets/:id/tg-token')
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get a market's Telegram token (SUPERADMIN only)",
    description:
      "Market sahifasidagi Telegram token kartasi uchun. Faqat SUPERADMIN; har ko'rish activity log'ga yoziladi (token qiymati yozilmaydi). Market: role=market, o'chirilmagan; aks holda 404.",
  })
  @ApiParam({ name: 'id', description: 'Market user ID' })
  @ApiOkResponse({ type: MarketTgTokenResponseDto })
  @ApiForbiddenResponse({ description: 'SUPERADMIN emas' })
  @ApiNotFoundResponse({ description: 'Market topilmadi' })
  getMarketTgToken(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    this.assertMarketIdParam(id);
    return this.identityClient
      .send(
        { cmd: 'identity.market.get_tg_token' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  @Post('markets/:id/tg-token/rotate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Rotate a market's Telegram token (SUPERADMIN only)",
    description:
      "Yangi token server tomonida yaratiladi (tanasi yo'q) va javobda qaytadi; eski token darhol yaroqsiz. Activity log'ga yoziladi (token qiymati yozilmaydi). Market: role=market, o'chirilmagan; aks holda 404.",
  })
  @ApiParam({ name: 'id', description: 'Market user ID' })
  @ApiOkResponse({ type: MarketTgTokenResponseDto })
  @ApiForbiddenResponse({ description: 'SUPERADMIN emas' })
  @ApiNotFoundResponse({ description: 'Market topilmadi' })
  rotateMarketTgToken(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    this.assertMarketIdParam(id);
    return this.identityClient
      .send(
        { cmd: 'identity.market.rotate_tg_token' },
        { id, requester: this.toRequester(req) },
      )
      .pipe(timeout(8000));
  }

  /** Market id — bigint PK; raqam bo'lmagan segment DB'ga bormaydi (404). */
  private assertMarketIdParam(id: string): void {
    if (!/^\d+$/.test(String(id ?? ''))) {
      throw new NotFoundException('Market topilmadi');
    }
  }

  @Patch('markets/:id/add-order')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update market add_order (true/false)' })
  @ApiParam({ name: 'id', description: 'Market user ID' })
  @ApiBody({ type: UpdateMarketAddOrderRequestDto })
  @ApiOkResponse({ description: 'Market add_order updated' })
  @ApiNotFoundResponse({ description: 'Market not found' })
  updateMarketAddOrder(
    @Param('id') id: string,
    @Body() dto: UpdateMarketAddOrderRequestDto,
  ) {
    return this.identityClient
      .send(
        { cmd: 'identity.market.update' },
        {
          id,
          dto: {
            add_order: dto.add_order,
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Patch('markets/:id/cancelled-handover-qr')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Update whether market cancelled-order handover requires market QR scan',
  })
  @ApiParam({ name: 'id', description: 'Market user ID' })
  @ApiBody({ type: UpdateMarketCancelledHandoverQrRequestDto })
  @ApiOkResponse({
    description: 'Market cancelled handover QR policy updated',
  })
  @ApiNotFoundResponse({ description: 'Market not found' })
  updateMarketCancelledHandoverQr(
    @Param('id') id: string,
    @Body() dto: UpdateMarketCancelledHandoverQrRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    const requesterRoles = (req.user.roles ?? []).map((role) =>
      String(role).toLowerCase(),
    );
    if (
      requesterRoles.includes(RoleEnum.MARKET) &&
      String(req.user.sub) !== id
    ) {
      throw new ForbiddenException(
        'Market faqat o‘z QR topshirish sozlamasini o‘zgartira oladi',
      );
    }

    return this.identityClient
      .send(
        { cmd: 'identity.market.update' },
        {
          id,
          dto: {
            cancelled_handover_qr_required: dto.cancelled_handover_qr_required,
          },
        },
      )
      .pipe(timeout(8000));
  }

  /**
   * (ysBqD9Nx, EGA QARORI 2026-09-20) Market Telegram guruhi kartasida mijoz
   * ismi/telefoni ko'rinadimi — kod o'zgartirmasdan market darajasida.
   * Market faqat o'zinikini, admin/superadmin — istalganini.
   */
  @Patch('markets/:id/telegram-group-pii')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Telegram guruh kartasida mijoz ismi/telefoni (tg_group_show_customer_pii; sukut true, false — niqoblangan)',
  })
  @ApiParam({ name: 'id', description: 'Market user ID' })
  @ApiBody({ type: UpdateMarketTelegramGroupPiiRequestDto })
  @ApiOkResponse({ description: 'Market Telegram group PII policy updated' })
  @ApiNotFoundResponse({ description: 'Market not found' })
  updateMarketTelegramGroupPii(
    @Param('id') id: string,
    @Body() dto: UpdateMarketTelegramGroupPiiRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    this.assertMarketIdParam(id);
    const requesterRoles = (req.user.roles ?? []).map((role) =>
      String(role).toLowerCase(),
    );
    if (
      requesterRoles.includes(RoleEnum.MARKET) &&
      String(req.user.sub) !== id
    ) {
      throw new ForbiddenException(
        "Market faqat o'z Telegram guruhi sozlamasini o'zgartira oladi",
      );
    }
    return this.identityClient
      .send(
        { cmd: 'identity.market.update' },
        {
          id,
          dto: { tg_group_show_customer_pii: dto.tg_group_show_customer_pii },
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }

  @Patch('markets/:id/expense-proof')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Set the situations in which this market requires file proof for sell/cancel',
  })
  @ApiParam({ name: 'id', description: 'Market user ID' })
  @ApiBody({ type: UpdateMarketExpenseProofRequestDto })
  @ApiOkResponse({ description: 'Market expense-proof policy updated' })
  @ApiNotFoundResponse({ description: 'Market not found' })
  updateMarketExpenseProof(
    @Param('id') id: string,
    @Body() dto: UpdateMarketExpenseProofRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.identityClient
      .send(
        { cmd: 'identity.market.update' },
        {
          id,
          dto: {
            expense_proof_conditions: dto.expense_proof_conditions,
          },
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }

  /**
   * w2bDrE3i — market bo'yicha qo'shimcha xarajatni ochish/yopish va tasdiq
   * talabini boshqarish. Faqat admin/superadmin (identity ham tekshiradi).
   * Sukut: yangi market — yopiq; mavjud marketlar migratsiya 114 da ochiq
   * qoldirilgan (ortga-moslik).
   */
  @Patch('admin/markets/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Market qo'shimcha xarajat sozlamasi (extra_cost_enabled, extra_cost_requires_approval)",
  })
  @ApiParam({ name: 'id', description: 'Market user ID' })
  @ApiBody({ type: UpdateMarketExtraCostRequestDto })
  @ApiOkResponse({ description: 'Market extra-cost policy updated' })
  @ApiNotFoundResponse({ description: 'Market not found' })
  updateMarketExtraCost(
    @Param('id') id: string,
    @Body() dto: UpdateMarketExtraCostRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    this.assertMarketIdParam(id);
    if (
      dto.extra_cost_enabled === undefined &&
      dto.extra_cost_requires_approval === undefined
    ) {
      throw new BadRequestException(
        'extra_cost_enabled yoki extra_cost_requires_approval dan kamida bittasi kerak',
      );
    }
    return this.identityClient
      .send(
        { cmd: 'identity.market.update' },
        {
          id,
          dto: {
            ...(dto.extra_cost_enabled !== undefined
              ? { extra_cost_enabled: dto.extra_cost_enabled }
              : {}),
            ...(dto.extra_cost_requires_approval !== undefined
              ? {
                  extra_cost_requires_approval:
                    dto.extra_cost_requires_approval,
                }
              : {}),
          },
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }

  /**
   * VRyloH62 — chekdagi operator raqami sozlamasi: majburiylik va doimiy
   * raqam. Market — faqat o'zi; admin/superadmin — istalgan market.
   */
  @Patch('markets/:id/operator-phone')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Market operator raqami sozlamasi (require_operator_phone, default_operator_phone)',
  })
  @ApiParam({ name: 'id', description: 'Market user ID' })
  @ApiBody({ type: UpdateMarketOperatorPhoneRequestDto })
  @ApiOkResponse({ description: 'Market operator phone policy updated' })
  @ApiNotFoundResponse({ description: 'Market not found' })
  updateMarketOperatorPhone(
    @Param('id') id: string,
    @Body() dto: UpdateMarketOperatorPhoneRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    this.assertMarketIdParam(id);
    const roles = (req.user.roles ?? []).map((role) =>
      String(role).toLowerCase(),
    );
    if (
      roles.includes(RoleEnum.MARKET) &&
      !roles.includes(RoleEnum.SUPERADMIN) &&
      !roles.includes(RoleEnum.ADMIN) &&
      String(req.user.sub) !== id
    ) {
      throw new ForbiddenException(
        "Market faqat o'z operator raqami sozlamasini o'zgartira oladi",
      );
    }
    if (
      dto.require_operator_phone === undefined &&
      dto.default_operator_phone === undefined
    ) {
      throw new BadRequestException(
        'require_operator_phone yoki default_operator_phone dan kamida bittasi kerak',
      );
    }
    return this.identityClient
      .send(
        { cmd: 'identity.market.update' },
        {
          id,
          dto: {
            ...(dto.require_operator_phone !== undefined
              ? { require_operator_phone: dto.require_operator_phone }
              : {}),
            ...(dto.default_operator_phone !== undefined
              ? { default_operator_phone: dto.default_operator_phone }
              : {}),
          },
          requester: this.toRequester(req),
        },
      )
      .pipe(timeout(8000));
  }
}
