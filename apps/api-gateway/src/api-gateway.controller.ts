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
import { Self } from './auth/self.decorator';
import { SelfGuard } from './auth/self.guard';
import {
  CreateUserRequestDto,
  DeleteUserResponseDto,
  ErrorResponseDto,
  SingleUserResponseDto,
  UpdateUserRequestDto,
  UserListResponseDto,
} from './dto/user.swagger.dto';

@ApiTags('Users')
@Controller()
export class ApiGatewayController {
  constructor(@Inject('IDENTITY') private readonly identityClient: ClientProxy) {}

  @Get()
  @ApiOperation({ summary: 'Gateway health check via identity service' })
  getHello() {
    return this.identityClient.send({ cmd: 'identity.health' }, {});
  }

  @Post('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create user' })
  @ApiBody({ type: CreateUserRequestDto })
  @ApiOkResponse({ type: SingleUserResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  createUser(
    @Body()
    dto: {
      name?: string;
      username: string;
      phone_number?: string;
      password: string;
      role?: string;
      status?: string;
    },
  ) {
    return this.identityClient.send({ cmd: 'identity.user.create' }, { dto });
  }

  @Patch('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, SelfGuard)
  @Roles(RoleEnum.CUSTOMER)
  @Self('id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update user' })
  @ApiParam({ name: 'id', description: 'User ID (uuid)' })
  @ApiBody({ type: UpdateUserRequestDto })
  @ApiOkResponse({ type: SingleUserResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  updateUser(
    @Param('id') id: string,
    @Body()
    dto: {
      name?: string;
      username?: string;
      phone_number?: string;
      password?: string;
      role?: string;
      status?: string;
    },
  ) {
    return this.identityClient.send({ cmd: 'identity.user.update' }, { id, dto });
  }

  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, SelfGuard)
  @Roles(RoleEnum.CUSTOMER)
  @Self('id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete user' })
  @ApiParam({ name: 'id', description: 'User ID (uuid)' })
  @ApiOkResponse({ type: DeleteUserResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  deleteUser(@Param('id') id: string) {
    return this.identityClient.send({ cmd: 'identity.user.delete' }, { id });
  }

  @Get('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, SelfGuard)
  @Roles(RoleEnum.CUSTOMER)
  @Self('id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user by id' })
  @ApiParam({ name: 'id', description: 'User ID (uuid)' })
  @ApiOkResponse({ type: SingleUserResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  getUserById(@Param('id') id: string) {
    return this.identityClient.send({ cmd: 'identity.user.find_by_id' }, { id });
  }

  @Get('users/by-username/:username')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user by username' })
  @ApiParam({ name: 'username', description: 'Username' })
  @ApiOkResponse({ type: SingleUserResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  getUserByUsername(@Param('username') username: string) {
    return this.identityClient.send({ cmd: 'identity.user.find_by_username' }, { username });
  }

  @Get('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List users with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'role', required: false, type: String, example: 'customer' })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'active' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ type: UserListResponseDto })
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
}
