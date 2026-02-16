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
  CreateMarketRequestDto,
  DeleteEntityResponseDto,
  ListEntityResponseDto,
  SingleEntityResponseDto,
  UpdateAdminRequestDto,
  UpdateMarketRequestDto,
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

  @Patch('admins/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update admin' })
  @ApiParam({ name: 'id', description: 'Admin ID (uuid)' })
  @ApiBody({ type: UpdateAdminRequestDto })
  @ApiOkResponse({ type: SingleEntityResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  updateAdmin(
    @Param('id') id: string,
    @Body() dto: UpdateAdminRequestDto,
  ) {
    return this.identityClient.send({ cmd: 'identity.user.update' }, { id, dto });
  }

  @Delete('admins/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete admin' })
  @ApiParam({ name: 'id', description: 'Admin ID (uuid)' })
  @ApiOkResponse({ type: DeleteEntityResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  deleteAdmin(@Param('id') id: string) {
    return this.identityClient.send({ cmd: 'identity.user.delete' }, { id });
  }

  @Get('admins/by-username/:username')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get admin by username' })
  @ApiParam({ name: 'username', description: 'Username' })
  @ApiOkResponse({ type: SingleEntityResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  getAdminByUsername(@Param('username') username: string) {
    return this.identityClient.send({ cmd: 'identity.user.find_by_username' }, { username });
  }

  @Get('admins/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get admin by id' })
  @ApiParam({ name: 'id', description: 'Admin ID (uuid)' })
  @ApiOkResponse({ type: SingleEntityResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  getAdminById(@Param('id') id: string) {
    return this.identityClient.send({ cmd: 'identity.user.find_by_id' }, { id });
  }

  @Get('admins')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List admins with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'role', required: false, type: String, example: 'admin' })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'active' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ type: ListEntityResponseDto })
  getAdmins(
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
          password: dto.password,
          tariff_home: dto.tariff_home ?? dto.tariffHome,
          tariff_center: dto.tariff_center ?? dto.tariffCenter,
          default_tariff: dto.default_tariff ?? dto.defaultTariff,
        },
      },
    );
  }

  @Patch('markets/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update market' })
  @ApiParam({ name: 'id', description: 'Market ID (uuid)' })
  @ApiBody({ type: UpdateMarketRequestDto })
  @ApiOkResponse({ type: SingleEntityResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  updateMarket(@Param('id') id: string, @Body() dto: UpdateMarketRequestDto) {
    return this.identityClient.send(
      { cmd: 'identity.market.update' },
      {
        id,
        dto: {
          name: dto.name,
          phone_number: dto.phone_number,
          password: dto.password,
          status: dto.status,
          tariff_home: dto.tariff_home ?? dto.tariffHome,
          tariff_center: dto.tariff_center ?? dto.tariffCenter,
          default_tariff: dto.default_tariff ?? dto.defaultTariff,
        },
      },
    );
  }

  @Delete('markets/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete market' })
  @ApiParam({ name: 'id', description: 'Market ID (uuid)' })
  @ApiOkResponse({ type: DeleteEntityResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  deleteMarket(@Param('id') id: string) {
    return this.identityClient.send({ cmd: 'identity.market.delete' }, { id });
  }

  @Get('markets/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get market by id' })
  @ApiParam({ name: 'id', description: 'Market ID (uuid)' })
  @ApiOkResponse({ type: SingleEntityResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  getMarketById(@Param('id') id: string) {
    return this.identityClient.send({ cmd: 'identity.market.find_by_id' }, { id });
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
