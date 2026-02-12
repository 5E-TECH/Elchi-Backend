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
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBody,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
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
  constructor(@Inject('USER') private readonly userClient: ClientProxy) {}

  @Get()
  @ApiOperation({ summary: 'Gateway health check via user service' })
  getHello() {
    return this.userClient.send({ cmd: 'salom_ber' }, {});
  }

  @Post('users')
  @ApiOperation({ summary: 'Create user' })
  @ApiBody({ type: CreateUserRequestDto })
  @ApiOkResponse({ type: SingleUserResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  createUser(@Body() dto: { username: string; password: string }) {
    return this.userClient.send({ cmd: 'user.create' }, { dto });
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Update user' })
  @ApiParam({ name: 'id', description: 'User ID (uuid)' })
  @ApiBody({ type: UpdateUserRequestDto })
  @ApiOkResponse({ type: SingleUserResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  updateUser(
    @Param('id') id: string,
    @Body() dto: { username?: string; password?: string },
  ) {
    return this.userClient.send({ cmd: 'user.update' }, { id, dto });
  }

  @Delete('users/:id')
  @ApiOperation({ summary: 'Delete user' })
  @ApiParam({ name: 'id', description: 'User ID (uuid)' })
  @ApiOkResponse({ type: DeleteUserResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  deleteUser(@Param('id') id: string) {
    return this.userClient.send({ cmd: 'user.delete' }, { id });
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Get user by id' })
  @ApiParam({ name: 'id', description: 'User ID (uuid)' })
  @ApiOkResponse({ type: SingleUserResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  getUserById(@Param('id') id: string) {
    return this.userClient.send({ cmd: 'user.find_by_id' }, { id });
  }

  @Get('users/by-username/:username')
  @ApiOperation({ summary: 'Get user by username' })
  @ApiParam({ name: 'username', description: 'Username' })
  @ApiOkResponse({ type: SingleUserResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  getUserByUsername(@Param('username') username: string) {
    return this.userClient.send({ cmd: 'user.find_by_username' }, { username });
  }

  @Get('users')
  @ApiOperation({ summary: 'List users with filtering and pagination' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiOkResponse({ type: UserListResponseDto })
  getUsers(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.userClient.send(
      { cmd: 'user.find_all' },
      {
        query: {
          search,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }
}
