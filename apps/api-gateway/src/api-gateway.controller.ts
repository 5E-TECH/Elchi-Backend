import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { Cashbox_type, Roles as RoleEnum } from '@app/common';
import { firstValueFrom } from 'rxjs';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreateAdminRequestDto,
  CreateCourierRequestDto,
  CreateManagerRequestDto,
  CreateMarketRequestDto,
  CreateRegistratorRequestDto,
  UpdateAdminRequestDto,
  UpdateMarketAddOrderRequestDto,
  UpdateUserStatusRequestDto,
} from './dto/identity.swagger.dto';

interface JwtUser {
  sub: string;
  username: string;
  roles?: string[];
}

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
  constructor(
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
  ) {}

  private toRequester(req: { user: JwtUser }) {
    return {
      id: req.user.sub,
      roles: req.user.roles ?? [],
    };
  }

  private async resolveBranchAssignment(reqUser: JwtUser): Promise<BranchAssignment | null> {
    const response = await firstValueFrom(
      this.branchClient.send(
        { cmd: 'branch.user.find_by_user' },
        {
          user_id: reqUser.sub,
          requester: { id: reqUser.sub, roles: reqUser.roles ?? [] },
        },
      ),
    );

    return (response?.data ?? null) as BranchAssignment | null;
  }

  private async findUserCashbox(userId: string, cashboxType: Cashbox_type) {
    try {
      const response = await firstValueFrom(
        this.financeClient.send(
          { cmd: 'finance.cashbox.find_by_user' },
          { user_id: String(userId), cashbox_type: cashboxType },
        ),
      );

      if (Array.isArray(response?.data)) {
        return response.data.find((cashbox: any) => cashbox?.cashbox_type === cashboxType) ?? null;
      }

      return response?.data ?? null;
    } catch {
      return null;
    }
  }

  @Get()
  @ApiOperation({ summary: 'Gateway health check via identity service' })
  getHello() {
    return this.identityClient.send({ cmd: 'identity.health' }, {});
  }

  @Post('admins')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create admin' })
  @ApiBody({ type: CreateAdminRequestDto })
  @ApiCreatedResponse({ description: 'Admin created' })
  @ApiConflictResponse({ description: 'Conflict' })
  createAdmin(@Body() dto: CreateAdminRequestDto, @Req() req: { user: JwtUser }) {
    return this.identityClient.send(
      { cmd: 'identity.user.create' },
      { dto, requester: this.toRequester(req) },
    );
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
      String(role ?? '').trim().toLowerCase(),
    );
    const isManager = requesterRoles.includes(RoleEnum.MANAGER);

    // Manager'lar uchun branch_id'ni JWT yoki BranchUser orqali to'g'rilash;
    // boshqalar uchun body'dan keladi. HYBRID branch tekshiruvi ham shu yerda.
    // (Bu hozircha gateway'da qoladi — kelajakda branch-service'ga ko'chiriladi.)
    let resolvedBranchId = String(dto?.branch_id ?? '').trim();
    if (isManager) {
      const assignment = await this.resolveBranchAssignment(req.user);
      const branchId = String(assignment?.branch_id ?? '').trim();
      const branchType = String(assignment?.branch?.type ?? '').trim().toUpperCase();

      if (!branchId) {
        throw new ForbiddenException('Manager hech qaysi branchga biriktirilmagan');
      }
      if (branchType !== 'HYBRID') {
        throw new ForbiddenException("Faqat HYBRID branch manager'i registrator yarata oladi");
      }
      resolvedBranchId = branchId;
    }

    if (!resolvedBranchId) {
      throw new BadRequestException('branch_id majburiy');
    }

    // identity-service o'zi user.save + branch.user.assign saga'sini bajaradi
    // va fail bo'lsa user'ni o'chiradi. Gateway endi faqat transit qiladi.
    return firstValueFrom(
      this.identityClient.send(
        { cmd: 'identity.registrator.create' },
        {
          dto: { ...dto, branch_id: resolvedBranchId },
          requester: this.toRequester(req),
        },
      ),
    );
  }

  @Get('registrators')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List registrators with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'active' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'Registrator list' })
  getRegistrators(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.identityClient.send(
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
    );
  }

  @Get('admins')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List admins with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'active' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'Admin list' })
  getAdmins(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.identityClient.send(
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
    );
  }

  @Post('couriers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MANAGER, RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create courier' })
  @ApiBody({ type: CreateCourierRequestDto })
  @ApiCreatedResponse({ description: 'Courier created' })
  @ApiConflictResponse({ description: 'Conflict' })
  async createCourier(@Body() dto: CreateCourierRequestDto, @Req() req: { user: JwtUser }) {
    const requesterRoles = (req?.user?.roles ?? []).map((role) =>
      String(role ?? '').trim().toLowerCase(),
    );
    const isSystemPrivileged =
      requesterRoles.includes(RoleEnum.SUPERADMIN) || requesterRoles.includes(RoleEnum.ADMIN);

    // Branch selection: SUPERADMIN/ADMIN — HQ filial, qolganlar — o'z BranchUser
    // assignment'idan. region_id ham branch'dan keladi. (Hozircha gateway'da —
    // kelajakda branch-service'ga ko'chiriladi.)
    let branchId = '';
    if (isSystemPrivileged) {
      const hqBranch = await firstValueFrom(
        this.branchClient.send({ cmd: 'branch.find_by_code' }, { code: 'HQ-TSHKNT' }),
      );
      branchId = String(hqBranch?.data?.id ?? '').trim();
      if (!branchId) {
        throw new BadRequestException('HQ branch topilmadi (code=HQ-TSHKNT)');
      }
    } else {
      const assignment = await this.resolveBranchAssignment(req.user);
      branchId = String(assignment?.branch_id ?? '').trim();
      if (!branchId) {
        throw new ForbiddenException('Foydalanuvchi hech qaysi branchga biriktirilmagan');
      }
    }

    const branchResponse = await firstValueFrom(
      this.branchClient.send(
        { cmd: 'branch.find_by_id' },
        { id: branchId, requester: this.toRequester(req) },
      ),
    );
    const branchType = String(branchResponse?.data?.type ?? '').trim().toUpperCase();
    if (isSystemPrivileged && branchType !== 'HQ') {
      throw new BadRequestException("Admin/Superadmin uchun courier faqat HQ branch'da yaratiladi");
    }

    const branchRegionId = String(branchResponse?.data?.region_id ?? '').trim();
    if (!branchRegionId && !isSystemPrivileged) {
      throw new BadRequestException('Manager branchida region_id topilmadi');
    }

    // identity-service create + branch.user.assign saga'sini o'zi bajaradi.
    // Fail bo'lsa user'ni o'chiradi.
    return firstValueFrom(
      this.identityClient.send(
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
            branch_id: branchId,
          },
          requester: this.toRequester(req),
        },
      ),
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
  async createManager(@Body() dto: CreateManagerRequestDto, @Req() req: { user: JwtUser }) {
    // identity-service'ning createManager o'zi user.save + branch.user.assign
    // saga'sini bajaradi (branch_id DTO'da majburiy).
    return firstValueFrom(
      this.identityClient.send(
        { cmd: 'identity.manager.create' },
        { dto, requester: this.toRequester(req) },
      ),
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
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List couriers with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'active' })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({ name: 'regionId', required: false, type: String, description: 'Alias for region_id' })
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
    const roles = (req?.user?.roles ?? []).map((role) => String(role).toLowerCase());
    const isSystemPrivileged = roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN);

    let resolvedBranchId = String(branch_id ?? '').trim() || undefined;
    if (!isSystemPrivileged && req?.user?.sub) {
      const assignment = await this.resolveBranchAssignment(req.user);
      const assignedBranchId = String(assignment?.branch_id ?? '').trim();
      if (assignedBranchId) {
        resolvedBranchId = assignedBranchId;
      }
    }

    const response = await firstValueFrom(
      this.identityClient.send(
        { cmd: 'identity.courier.find_all' },
        {
          query: {
            search,
            status,
            region_id: resolvedRegionId,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
      ),
    );

    let items = Array.isArray(response?.data?.items) ? response.data.items : [];

    if (resolvedBranchId && req?.user) {
      const branchUsersResponse = await firstValueFrom(
        this.branchClient.send(
          { cmd: 'branch.user.find_by_branch' },
          {
            branch_id: resolvedBranchId,
            requester: this.toRequester(req),
          },
        ),
      );

      const branchUsers = Array.isArray(branchUsersResponse?.data) ? branchUsersResponse.data : [];
      const courierIdsInBranch = new Set(
        branchUsers
          .filter((row: any) => String(row?.role ?? '').toUpperCase() === 'COURIER')
          .map((row: any) => String(row?.user_id ?? '').trim())
          .filter(Boolean),
      );
      items = items.filter((courier: any) => courierIdsInBranch.has(String(courier?.id ?? '').trim()));
    }

    if (!items.length) {
      if (response?.data?.meta) {
        response.data.meta.total = 0;
        response.data.meta.totalPages = 1;
      }
      response.data.items = [];
      return response;
    }

    response.data.items = await Promise.all(
      items.map(async (courier: any) => ({
        ...courier,
        cashbox: await this.findUserCashbox(String(courier?.id ?? ''), Cashbox_type.FOR_COURIER),
      })),
    );

    return response;
  }

  @Get('managers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List managers with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'active' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'Manager list' })
  getManagers(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.identityClient.send(
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
    );
  }

  @Get('couriers/region/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List couriers by region id' })
  @ApiParam({ name: 'id', description: 'Region ID' })
  @ApiOkResponse({ description: 'Courier list by region' })
  getCouriersByRegion(@Param('id') id: string) {
    return this.identityClient.send(
      { cmd: 'identity.courier.find_all' },
      {
        query: {
          region_id: id,
        },
      },
    );
  }

  @Get('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all users with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'role', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'active' })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({ name: 'regionId', required: false, type: String, description: 'Alias for region_id' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'User list' })
  async getUsers(
    @Query('search') search?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('region_id') region_id?: string,
    @Query('regionId') regionId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const resolvedRegionId = region_id ?? regionId;
    const normalizedRole = String(role ?? '').trim().toLowerCase();
    const requesterRoles = (req?.user?.roles ?? []).map((item) => String(item ?? '').toLowerCase());
    const isSystemPrivileged =
      requesterRoles.includes(RoleEnum.SUPERADMIN) || requesterRoles.includes(RoleEnum.ADMIN);

    let scopedUserIds: string[] | undefined;
    let managerBranchUserIds: string[] | undefined;
    if (!isSystemPrivileged && requesterRoles.includes(RoleEnum.MANAGER) && req?.user?.sub) {
      const assignment = await this.resolveBranchAssignment(req.user);
      const branchId = String(assignment?.branch_id ?? '').trim();

      if (!branchId) {
        throw new ForbiddenException('Manager hech qaysi branchga biriktirilmagan');
      }

      const branchUsersResponse = await firstValueFrom(
        this.branchClient.send(
          { cmd: 'branch.user.find_by_branch' },
          { branch_id: branchId, requester: this.toRequester(req) },
        ),
      );
      const branchUsers = Array.isArray(branchUsersResponse?.data) ? branchUsersResponse.data : [];
      managerBranchUserIds = Array.from(
        new Set(
          branchUsers
            .map((row: any) => String(row?.user_id ?? '').trim())
            .filter(Boolean),
        ),
      );
      scopedUserIds = managerBranchUserIds;
    }

    const requesterCanHaveCourierScope =
      requesterRoles.includes(RoleEnum.MANAGER) ||
      requesterRoles.includes(RoleEnum.ADMIN) ||
      requesterRoles.includes(RoleEnum.SUPERADMIN);

    let branchCourierIds: string[] | undefined;
    let branchBoundUserIds: string[] | undefined;
    if (requesterCanHaveCourierScope && req?.user?.sub) {
      const assignment = await this.resolveBranchAssignment(req.user);
      let branchId = String(assignment?.branch_id ?? '').trim();

      if (!branchId && isSystemPrivileged) {
        const hqBranch = await firstValueFrom(
          this.branchClient.send({ cmd: 'branch.find_by_code' }, { code: 'HQ-TSHKNT' }),
        );
        branchId = String(hqBranch?.data?.id ?? '').trim();
      }

      if (!branchId) {
        throw new ForbiddenException("Foydalanuvchi courier ko'rish uchun branchga biriktirilmagan");
      }

      const branchUsersResponse = await firstValueFrom(
        this.branchClient.send(
          { cmd: 'branch.user.find_by_branch' },
          { branch_id: branchId, requester: this.toRequester(req) },
        ),
      );
      const branchUsers = Array.isArray(branchUsersResponse?.data) ? branchUsersResponse.data : [];
      branchBoundUserIds = Array.from(
        new Set(
          branchUsers
            .map((row: any) => String(row?.user_id ?? '').trim())
            .filter(Boolean),
        ),
      );
      branchCourierIds = Array.from(
        new Set(
          branchUsers
            .filter((row: any) => String(row?.role ?? '').trim().toUpperCase() === 'COURIER')
            .map((row: any) => String(row?.user_id ?? '').trim())
            .filter(Boolean),
        ),
      );
    }

    if (normalizedRole === RoleEnum.COURIER && Array.isArray(branchCourierIds)) {
      if (Array.isArray(scopedUserIds)) {
        const branchCourierSet = new Set(branchCourierIds);
        scopedUserIds = scopedUserIds.filter((id) => branchCourierSet.has(id));
      } else {
        scopedUserIds = branchCourierIds;
      }
    }

    const response = await firstValueFrom(
      this.identityClient.send(
        { cmd: 'identity.user.find_all' },
        {
          query: {
            search,
            role,
            status,
            region_id: resolvedRegionId,
            user_ids: scopedUserIds,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
      ),
    );

    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    if (!normalizedRole && Array.isArray(branchBoundUserIds)) {
      const allowedBranchBoundIds = new Set(branchBoundUserIds);
      const filteredItems = items.filter((row: any) => {
        const rowRole = String(row?.role ?? '').trim().toLowerCase();
        const shouldScopeByBranch =
          rowRole === RoleEnum.COURIER ||
          rowRole === RoleEnum.BRANCH ||
          rowRole === 'branch_admin';

        if (!shouldScopeByBranch) {
          return true;
        }
        return allowedBranchBoundIds.has(String(row?.id ?? '').trim());
      });

      if (response?.data) {
        response.data.items = filteredItems;
        if (response.data.meta) {
          response.data.meta.total = filteredItems.length;
          response.data.meta.totalUsers = filteredItems.length;
          const limitValue = Number(response.data.meta.limit ?? limit ?? 10);
          response.data.meta.totalPages =
            limitValue > 0 ? Math.max(1, Math.ceil(filteredItems.length / limitValue)) : 1;
        }
      }
    }

    if (requesterRoles.includes(RoleEnum.MANAGER) && req?.user?.sub && response?.data) {
      const allowed = new Set((managerBranchUserIds ?? []).map((id) => String(id)));
      const requesterId = String(req.user.sub);
      const branchScoped = (Array.isArray(response.data.items) ? response.data.items : []).filter((row: any) => {
        const userId = String(row?.id ?? '').trim();
        if (!allowed.has(userId)) {
          return false;
        }
        return userId !== requesterId;
      });

      response.data.items = branchScoped;
      if (response.data.meta) {
        response.data.meta.total = branchScoped.length;
        response.data.meta.totalUsers = branchScoped.length;
        const limitValue = Number(response.data.meta.limit ?? limit ?? 10);
        response.data.meta.totalPages =
          limitValue > 0 ? Math.max(1, Math.ceil(branchScoped.length / limitValue)) : 1;
      }
    }

    return response;
  }

  @Get('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user by id (admin/superadmin)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiOkResponse({ description: 'User by id' })
  @ApiNotFoundResponse({ description: 'Not found' })
  async getUserById(
    @Param('id') id: string,
    @Req() req?: { user?: JwtUser },
  ) {
    const requesterRoles = (req?.user?.roles ?? []).map((r) => String(r).toLowerCase());
    const requesterIsPrivileged =
      requesterRoles.includes(RoleEnum.SUPERADMIN) || requesterRoles.includes(RoleEnum.ADMIN);
    const requesterIsMarket = requesterRoles.includes(RoleEnum.MARKET);

    if (requesterIsMarket && !requesterIsPrivileged && req?.user?.sub !== id) {
      throw new ForbiddenException('Market faqat o‘z profilini ko‘ra oladi');
    }

    if (!requesterIsPrivileged && requesterRoles.includes(RoleEnum.MANAGER) && req?.user?.sub) {
      const assignment = await this.resolveBranchAssignment(req.user);
      const branchId = String(assignment?.branch_id ?? '').trim();
      const branchType = String(assignment?.branch?.type ?? '').trim().toUpperCase();

      if (!branchId) {
        throw new ForbiddenException('Manager hech qaysi branchga biriktirilmagan');
      }
      if (branchType !== 'REGIONAL' && branchType !== 'HYBRID') {
        throw new ForbiddenException('Bu branch type uchun userlarni ko‘rish ruxsati yo‘q');
      }

      const branchUsersResponse = await firstValueFrom(
        this.branchClient.send(
          { cmd: 'branch.user.find_by_branch' },
          { branch_id: branchId, requester: this.toRequester(req as { user: JwtUser }) },
        ),
      );
      const branchUsers = Array.isArray(branchUsersResponse?.data) ? branchUsersResponse.data : [];
      const branchUserIds = new Set(
        branchUsers
          .map((row: any) => String(row?.user_id ?? '').trim())
          .filter(Boolean),
      );

      if (!branchUserIds.has(String(id).trim())) {
        throw new ForbiddenException('Siz bu user ma’lumotini ko‘ra olmaysiz');
      }
    }

    return firstValueFrom(
      this.identityClient.send({ cmd: 'identity.user.find_by_id' }, { id }),
    );
  }

  @Patch('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update user (all roles)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiBody({ type: UpdateAdminRequestDto })
  @ApiOkResponse({ description: 'User updated' })
  @ApiConflictResponse({ description: 'Conflict' })
  @ApiNotFoundResponse({ description: 'Not found' })
  updateUser(
    @Param('id') id: string,
    @Body() dto: UpdateAdminRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.identityClient.send(
      { cmd: 'identity.user.update' },
      { id, dto, requester: this.toRequester(req) },
    );
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
    return this.identityClient.send(
      { cmd: 'identity.user.delete' },
      { id, requester: this.toRequester(req) },
    );
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
    return this.identityClient.send(
      { cmd: 'identity.user.status' },
      { id, status: dto.status, requester: this.toRequester(req) },
    );
  }

  @Post('markets')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create market' })
  @ApiBody({ type: CreateMarketRequestDto })
  @ApiCreatedResponse({ description: 'Market created' })
  @ApiConflictResponse({ description: 'Conflict' })
  createMarket(@Body() dto: CreateMarketRequestDto) {
    return this.identityClient.send(
      { cmd: 'identity.market.create' },
      {
        dto: {
          name: dto.name,
          phone_number: dto.phone_number,
          username: dto.username,
          password: dto.password,
          tariff_home: dto.tariff_home,
          tariff_center: dto.tariff_center,
          default_tariff: dto.default_tariff,
          add_order: dto.add_order,
        },
      },
    );
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
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List markets with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'active' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'Market list' })
  async getMarkets(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const response = await firstValueFrom(
      this.identityClient.send(
        { cmd: 'identity.market.find_all' },
        {
          query: {
            search,
            status,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        },
      ),
    );

    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    if (!items.length) {
      return response;
    }

    response.data.items = await Promise.all(
      items.map(async (market: any) => ({
        ...market,
        cashbox: await this.findUserCashbox(String(market?.id ?? ''), Cashbox_type.FOR_MARKET),
      })),
    );

    return response;
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
    return this.identityClient.send(
      { cmd: 'identity.market.update' },
      {
        id,
        dto: {
          add_order: dto.add_order,
        },
      },
    );
  }
}
