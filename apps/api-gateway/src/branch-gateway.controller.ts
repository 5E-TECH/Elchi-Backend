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
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  AssignBranchUserRequestDto,
  CreateBranchRequestDto,
  SetBranchConfigRequestDto,
  UpdateBranchConfigRequestDto,
  UpdateBranchRequestDto,
} from './dto/branch.swagger.dto';

@ApiTags('Branch')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class BranchGatewayController {
  constructor(@Inject('BRANCH') private readonly branchClient: ClientProxy) {}

  @Post('branches')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create branch' })
  @ApiBody({ type: CreateBranchRequestDto })
  createBranch(@Body() dto: CreateBranchRequestDto) {
    return this.branchClient.send({ cmd: 'branch.create' }, { dto });
  }

  @Get('branches')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List branches (pagination + search + status)' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'inactive'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAllBranches(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.branchClient.send(
      { cmd: 'branch.find_all' },
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

  @Get('branches/tree')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get full branch tree (nested)' })
  findBranchTree() {
    return this.branchClient.send({ cmd: 'branch.tree' }, {});
  }

  @Get('branches/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Find branch by id' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  findBranchById(@Param('id') id: string) {
    return this.branchClient.send({ cmd: 'branch.find_by_id' }, { id });
  }

  @Get('branches/:id/descendants')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get all descendants of a branch (flat list)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  findBranchDescendants(@Param('id') id: string) {
    return this.branchClient.send({ cmd: 'branch.descendants' }, { id });
  }

  @Patch('branches/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiBody({ type: UpdateBranchRequestDto })
  updateBranch(@Param('id') id: string, @Body() dto: UpdateBranchRequestDto) {
    return this.branchClient.send({ cmd: 'branch.update' }, { id, dto });
  }

  @Delete('branches/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete branch (soft delete)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  deleteBranch(@Param('id') id: string) {
    return this.branchClient.send({ cmd: 'branch.delete' }, { id });
  }

  @Post('branches/:id/users')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Assign user to branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiBody({ type: AssignBranchUserRequestDto })
  assignUserToBranch(
    @Param('id') id: string,
    @Body() dto: AssignBranchUserRequestDto,
  ) {
    return this.branchClient.send(
      { cmd: 'branch.user.assign' },
      { dto: { branch_id: id, ...dto } },
    );
  }

  @Delete('branches/:id/users/:userId')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Remove user from branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiParam({ name: 'userId', description: 'User ID (bigint string)' })
  removeUserFromBranch(@Param('id') id: string, @Param('userId') userId: string) {
    return this.branchClient.send(
      { cmd: 'branch.user.remove' },
      { branch_id: id, user_id: userId },
    );
  }

  @Get('branches/:id/users')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get users assigned to branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  getBranchUsers(@Param('id') id: string) {
    return this.branchClient.send(
      { cmd: 'branch.user.find_by_branch' },
      { branch_id: id },
    );
  }

  @Get('branches/:id/config')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get branch config list' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  getBranchConfig(@Param('id') id: string) {
    return this.branchClient.send({ cmd: 'branch.config.get' }, { branch_id: id });
  }

  @Post('branches/:id/config')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Set branch config' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiBody({ type: SetBranchConfigRequestDto })
  setBranchConfig(@Param('id') id: string, @Body() dto: SetBranchConfigRequestDto) {
    return this.branchClient.send(
      { cmd: 'branch.config.set' },
      { dto: { branch_id: id, ...dto } },
    );
  }

  @Get('branches/:id/config/:key')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get single branch config by key' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiParam({ name: 'key', description: 'Config key' })
  getBranchConfigByKey(@Param('id') id: string, @Param('key') key: string) {
    return this.branchClient.send(
      { cmd: 'branch.config.find_one' },
      { branch_id: id, config_key: key },
    );
  }

  @Patch('branches/:id/config/:key')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update branch config by key' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiParam({ name: 'key', description: 'Config key' })
  @ApiBody({ type: UpdateBranchConfigRequestDto })
  updateBranchConfigByKey(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: UpdateBranchConfigRequestDto,
  ) {
    return this.branchClient.send(
      { cmd: 'branch.config.update' },
      { dto: { branch_id: id, config_key: key, ...dto } },
    );
  }

  @Delete('branches/:id/config/:key')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete branch config by key (soft delete)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiParam({ name: 'key', description: 'Config key' })
  deleteBranchConfigByKey(@Param('id') id: string, @Param('key') key: string) {
    return this.branchClient.send(
      { cmd: 'branch.config.delete' },
      { branch_id: id, config_key: key },
    );
  }
}
