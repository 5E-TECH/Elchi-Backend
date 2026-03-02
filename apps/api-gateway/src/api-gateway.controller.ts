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
import { Roles as RoleEnum } from '@app/common';
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
  constructor(@Inject('IDENTITY') private readonly identityClient: ClientProxy) {}

  private toRequester(req: { user: JwtUser }) {
    return {
      id: req.user.sub,
      roles: req.user.roles ?? [],
    };
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
  @ApiCreatedResponse({ description: 'Created' })
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
  @ApiOkResponse({ description: 'OK' })
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
  @ApiCreatedResponse({ description: 'Created' })
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
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'OK' })
  getCouriers(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.identityClient.send(
      { cmd: 'identity.courier.find_all' },
      {
        query: {
          search,
          status,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
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
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'OK' })
  getUsers(
    @Query('search') search?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.identityClient.send(
      { cmd: 'identity.user.find_all' },
      {
        query: {
          search,
          role,
          status,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }

  @Get('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user by id (all roles)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiOkResponse({ description: 'OK' })
  @ApiNotFoundResponse({ description: 'Not found' })
  getUserById(@Param('id') id: string) {
    return this.identityClient.send({ cmd: 'identity.user.find_by_id' }, { id });
  }

  @Patch('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update user (all roles)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiBody({ type: UpdateAdminRequestDto })
  @ApiOkResponse({ description: 'OK' })
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
  @ApiOkResponse({ description: 'Deleted' })
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
  @ApiOkResponse({ description: 'OK' })
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
  @ApiCreatedResponse({ description: 'Created' })
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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List markets with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'active' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ description: 'OK' })
  getMarkets(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.identityClient.send(
      { cmd: 'identity.market.find_all' },
      {
        query: {
          search,
          status,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }
}
