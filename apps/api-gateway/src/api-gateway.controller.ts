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
  ErrorResponseDto,
} from './dto/user.swagger.dto';
import {
  CreateAdminRequestDto,
  CreateCourierRequestDto,
  CreateMarketRequestDto,
  DeleteEntityResponseDto,
  ListEntityResponseDto,
  SingleEntityResponseDto,
  UpdateAdminRequestDto,
  UpdateUserStatusRequestDto,
} from './dto/identity.swagger.dto';

@ApiTags('Identity')
@Controller()
export class ApiGatewayController {
  constructor(@Inject('IDENTITY') private readonly identityClient: ClientProxy) {}

  @Get()
  @ApiOperation({ summary: 'Gateway health check via identity service' })
  getHello() {
    return this.identityClient.send({ cmd: 'identity.health' }, {});
  }

  @Post('admins')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create admin' })
  @ApiBody({ type: CreateAdminRequestDto })
  @ApiCreatedResponse({ type: SingleEntityResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  createAdmin(@Body() dto: CreateAdminRequestDto) {
    return this.identityClient.send({ cmd: 'identity.user.create' }, { dto });
  }

  @Post('couriers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create courier' })
  @ApiBody({ type: CreateCourierRequestDto })
  @ApiCreatedResponse({ type: SingleEntityResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  createCourier(@Body() dto: CreateCourierRequestDto) {
    return this.identityClient.send({ cmd: 'identity.courier.create' }, { dto });
  }

  @Get('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all users with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'role', required: false, type: String, example: 'customer' })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'active' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ type: ListEntityResponseDto })
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
  @ApiOkResponse({ type: SingleEntityResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
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
  @ApiOkResponse({ type: SingleEntityResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  updateUser(@Param('id') id: string, @Body() dto: UpdateAdminRequestDto) {
    return this.identityClient.send({ cmd: 'identity.user.update' }, { id, dto });
  }

  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete user (all roles)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiOkResponse({ type: DeleteEntityResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  deleteUser(@Param('id') id: string) {
    return this.identityClient.send({ cmd: 'identity.user.delete' }, { id });
  }

  @Patch('users/:id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set user status (active/inactive)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiBody({ type: UpdateUserStatusRequestDto })
  @ApiOkResponse({ type: SingleEntityResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  updateUserStatus(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusRequestDto,
  ) {
    return this.identityClient.send({ cmd: 'identity.user.status' }, { id, status: dto.status });
  }

  @Post('markets')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create market' })
  @ApiBody({ type: CreateMarketRequestDto })
  @ApiCreatedResponse({ type: SingleEntityResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
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
  @ApiOkResponse({ type: ListEntityResponseDto })
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
