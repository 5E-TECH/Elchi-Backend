import {
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
  CreateMarketRequestDto,
  UpdateAdminRequestDto,
  UpdateMarketAddOrderRequestDto,
  UpdateUserStatusRequestDto,
} from './dto/identity.swagger.dto';

interface JwtUser {
  sub: string;
  username: string;
  roles?: string[];
}

@ApiTags('Identity')
@Controller()
export class ApiGatewayController {
  constructor(
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
  ) {}

  private toRequester(req: { user: JwtUser }) {
    return {
      id: req.user.sub,
      roles: req.user.roles ?? [],
    };
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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create courier' })
  @ApiBody({ type: CreateCourierRequestDto })
  @ApiCreatedResponse({ description: 'Courier created' })
  @ApiConflictResponse({ description: 'Conflict' })
  createCourier(@Body() dto: CreateCourierRequestDto) {
    return this.identityClient.send({ cmd: 'identity.courier.create' }, { dto });
  }

  @Get('couriers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List couriers with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'active' })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({ name: 'regionId', required: false, type: String, description: 'Alias for region_id' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'Courier list' })
  async getCouriers(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('region_id') region_id?: string,
    @Query('regionId') regionId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const resolvedRegionId = region_id ?? regionId;
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

    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    if (!items.length) {
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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
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
  getUsers(
    @Query('search') search?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('region_id') region_id?: string,
    @Query('regionId') regionId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const resolvedRegionId = region_id ?? regionId;
    return this.identityClient.send(
      { cmd: 'identity.user.find_all' },
      {
        query: {
          search,
          role,
          status,
          region_id: resolvedRegionId,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }

  @Get('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR, RoleEnum.COURIER)
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
