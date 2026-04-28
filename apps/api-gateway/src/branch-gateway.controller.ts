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
  CancelTransferBatchRequestDto,
  CreateBranchTransferBatchesRequestDto,
  CreateBranchRequestDto,
  SendTransferBatchRequestDto,
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

  private toRequester(req: { user?: { sub?: string; roles?: string[] } }) {
    return {
      id: String(req?.user?.sub ?? ''),
      roles: req?.user?.roles ?? [],
    };
  }

  @Post('branches')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create branch' })
  @ApiBody({ type: CreateBranchRequestDto })
  createBranch(
    @Body() dto: CreateBranchRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send({ cmd: 'branch.create' }, { dto, requester: this.toRequester(req) });
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
    @Req() req?: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.find_all' },
      {
        requester: this.toRequester(req ?? {}),
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
  findBranchById(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send({ cmd: 'branch.find_by_id' }, { id, requester: this.toRequester(req) });
  }

  @Get('branches/:id/descendants')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get all descendants of a branch (flat list)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  findBranchDescendants(@Param('id') id: string) {
    return this.branchClient.send({ cmd: 'branch.descendants' }, { id });
  }

  @Get('branches/:id/stats')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.OPERATOR)
  @ApiOperation({ summary: 'Branch operational stats (today/week/orders/batches/couriers)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  findBranchStats(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.stats' },
      { id, requester: this.toRequester(req) },
    );
  }

  @Get('branches/:id/analytics/markets')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.OPERATOR)
  @ApiOperation({ summary: 'Branch market analytics (orders, delivered, total price)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  findBranchMarketsAnalytics(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.analytics.markets' },
      { id, requester: this.toRequester(req) },
    );
  }

  @Get('branches/:id/dashboard')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.OPERATOR)
  @ApiOperation({ summary: 'Branch dashboard cards (orders, markets, packages, couriers)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  findBranchDashboard(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.dashboard' },
      { id, requester: this.toRequester(req) },
    );
  }

  @Get('branches/new-orders')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.OPERATOR)
  @ApiOperation({ summary: 'Branches that currently have NEW orders' })
  findBranchesWithNewOrders(
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.new_orders.branches' },
      { requester: this.toRequester(req) },
    );
  }

  @Post('branches/:id/transfer-batches')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.OPERATOR)
  @ApiOperation({ summary: 'Create transfer batches by unassigned orders grouped by region' })
  @ApiParam({ name: 'id', description: 'Source branch ID (bigint string)' })
  @ApiBody({ type: CreateBranchTransferBatchesRequestDto })
  createTransferBatches(
    @Param('id') id: string,
    @Body() dto: CreateBranchTransferBatchesRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.transfer_batches.create' },
      { id, dto, requester: this.toRequester(req) },
    );
  }

  @Post('transfer-batches/:id/send')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.OPERATOR)
  @ApiOperation({ summary: 'Mark transfer batch as sent with vehicle info' })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  @ApiBody({ type: SendTransferBatchRequestDto })
  sendTransferBatch(
    @Param('id') id: string,
    @Body() dto: SendTransferBatchRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.transfer_batches.send' },
      { id, dto, requester: this.toRequester(req) },
    );
  }

  @Post('transfer-batches/:id/receive')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.OPERATOR)
  @ApiOperation({ summary: 'Receive transfer batch by destination branch staff' })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  receiveTransferBatch(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.transfer_batches.receive' },
      { id, requester: this.toRequester(req) },
    );
  }

  @Post('transfer-batches/:id/cancel')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.OPERATOR)
  @ApiOperation({ summary: 'Cancel transfer batch and unassign its orders' })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  @ApiBody({ type: CancelTransferBatchRequestDto })
  cancelTransferBatch(
    @Param('id') id: string,
    @Body() dto: CancelTransferBatchRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.transfer_batches.cancel' },
      { id, dto, requester: this.toRequester(req) },
    );
  }

  @Patch('branches/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiBody({ type: UpdateBranchRequestDto })
  updateBranch(
    @Param('id') id: string,
    @Body() dto: UpdateBranchRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send({ cmd: 'branch.update' }, { id, dto, requester: this.toRequester(req) });
  }

  @Delete('branches/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete branch (soft delete)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  deleteBranch(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send({ cmd: 'branch.delete' }, { id, requester: this.toRequester(req) });
  }

  @Post('branches/:id/users')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Assign user to branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiBody({ type: AssignBranchUserRequestDto })
  assignUserToBranch(
    @Param('id') id: string,
    @Body() dto: AssignBranchUserRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.user.assign' },
      { requester: this.toRequester(req), dto: { branch_id: id, ...dto } },
    );
  }

  @Delete('branches/:id/users/:userId')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Remove user from branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiParam({ name: 'userId', description: 'User ID (bigint string)' })
  removeUserFromBranch(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.user.remove' },
      { branch_id: id, user_id: userId, requester: this.toRequester(req) },
    );
  }

  @Get('branches/:id/users')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get users assigned to branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  getBranchUsers(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.user.find_by_branch' },
      { branch_id: id, requester: this.toRequester(req) },
    );
  }

  @Get('branches/:id/config')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get branch config list' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  getBranchConfig(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send({ cmd: 'branch.config.get' }, { branch_id: id, requester: this.toRequester(req) });
  }

  @Post('branches/:id/config')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Set branch config' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiBody({ type: SetBranchConfigRequestDto })
  setBranchConfig(
    @Param('id') id: string,
    @Body() dto: SetBranchConfigRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.config.set' },
      { requester: this.toRequester(req), dto: { branch_id: id, ...dto } },
    );
  }

  @Get('branches/:id/config/:key')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Get single branch config by key' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiParam({ name: 'key', description: 'Config key' })
  getBranchConfigByKey(
    @Param('id') id: string,
    @Param('key') key: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.config.find_one' },
      { branch_id: id, config_key: key, requester: this.toRequester(req) },
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
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.config.update' },
      { requester: this.toRequester(req), dto: { branch_id: id, config_key: key, ...dto } },
    );
  }

  @Delete('branches/:id/config/:key')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete branch config by key (soft delete)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiParam({ name: 'key', description: 'Config key' })
  deleteBranchConfigByKey(
    @Param('id') id: string,
    @Param('key') key: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.config.delete' },
      { branch_id: id, config_key: key, requester: this.toRequester(req) },
    );
  }
}
