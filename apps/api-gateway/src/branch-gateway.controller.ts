import {
  BadRequestException,
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
import { firstValueFrom } from 'rxjs';
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
  CreateReturnBatchesRequestDto,
  CreateBranchRequestDto,
  ReceiveTransferBatchOrdersRequestDto,
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

  private async resolveSourceBranchIdForDispatch(
    req: { user?: { sub?: string; roles?: string[] } },
  ): Promise<string> {
    const requester = this.toRequester(req);
    const requesterRoles = (requester.roles ?? []).map((role) => String(role ?? '').toLowerCase());
    const isSystemPrivileged =
      requesterRoles.includes(RoleEnum.SUPERADMIN) || requesterRoles.includes(RoleEnum.ADMIN);

    if (isSystemPrivileged) {
      const hqResponse = await firstValueFrom(
        this.branchClient.send({ cmd: 'branch.find_by_code' }, { code: 'HQ-TSHKNT' }),
      );
      const hqBranchId = String(hqResponse?.data?.id ?? '').trim();
      if (!hqBranchId) {
        throw new BadRequestException('HQ branch topilmadi (code=HQ-TSHKNT)');
      }
      return hqBranchId;
    }

    const assignmentResponse = await firstValueFrom(
      this.branchClient.send(
        { cmd: 'branch.user.find_by_user' },
        { user_id: requester.id, requester },
      ),
    );
    const assignedBranchId = String(assignmentResponse?.data?.branch_id ?? '').trim();
    if (!assignedBranchId) {
      throw new BadRequestException('Foydalanuvchi hech qaysi branchga biriktirilmagan');
    }

    return assignedBranchId;
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

  @Get('branches/with-sent-batches')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'List branches that have SENT transfer batches' })
  @ApiQuery({ name: 'direction', required: false, enum: ['FORWARD', 'RETURN'] })
  @ApiQuery({ name: 'side', required: false, enum: ['source', 'destination'] })
  findBranchesWithSentBatches(
    @Query('direction') direction: string | undefined,
    @Query('side') side: 'source' | 'destination' | undefined,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.transfer_batches.sent_branches' },
      {
        requester: this.toRequester(req),
        query: { direction, side },
      },
    );
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

  @Get('branches/:id/analytics/markets')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
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

  @Get('branches/new-orders')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'Branches that currently have NEW orders' })
  findBranchesWithNewOrders(
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.new_orders.branches' },
      { requester: this.toRequester(req) },
    );
  }

  @Post('branches/transfer-batches')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: "Create transfer batches from requester's branch by order_ids" })
  @ApiBody({ type: CreateBranchTransferBatchesRequestDto })
  createTransferBatches(
    @Body() dto: CreateBranchTransferBatchesRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.transfer_batches.create' },
      { dto, requester: this.toRequester(req) },
    );
  }

  @Post('branches/:id/return-batches')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'Create return batches grouped by original branch (direction=RETURN, QR=BTR-*)' })
  @ApiParam({ name: 'id', description: 'Source branch ID (HQ / current branch)' })
  @ApiBody({ type: CreateReturnBatchesRequestDto })
  createReturnBatches(
    @Param('id') id: string,
    @Body() dto: CreateReturnBatchesRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.return_batches.create' },
      { id, dto, requester: this.toRequester(req) },
    );
  }

  @Patch('transfer-batches/:id/send')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'Mark transfer batch as sent with vehicle info' })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  @ApiBody({ type: SendTransferBatchRequestDto })
  sendTransferBatchPatch(
    @Param('id') id: string,
    @Body() dto: SendTransferBatchRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.transfer_batches.send' },
      { id, dto, requester: this.toRequester(req) },
    );
  }

  @Get('transfer-batches')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'List transfer batches' })
  @ApiQuery({ name: 'source_branch_id', required: false, type: String })
  @ApiQuery({ name: 'destination_branch_id', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'SENT', 'RECEIVED', 'CANCELLED'] })
  @ApiQuery({ name: 'direction', required: false, enum: ['FORWARD', 'RETURN'] })
  @ApiQuery({ name: 'period', required: false, enum: ['today', 'week', 'month'] })
  @ApiQuery({ name: 'date', required: false, type: String, description: 'YYYY-MM-DD or ISO datetime' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findTransferBatches(
    @Query('source_branch_id') sourceBranchId: string | undefined,
    @Query('destination_branch_id') destinationBranchId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('direction') direction: string | undefined,
    @Query('period') period: string | undefined,
    @Query('date') date: string | undefined,
    @Query('page') page: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.transfer_batches.find_all' },
      {
        requester: this.toRequester(req),
        query: {
          source_branch_id: sourceBranchId,
          destination_branch_id: destinationBranchId,
          status,
          direction,
          period,
          date,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }

  @Get('transfer-batches/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'Get transfer batch by id' })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  findTransferBatchById(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.transfer_batches.find_by_id' },
      { id, requester: this.toRequester(req) },
    );
  }

  @Get('transfer-batches/:id/remaining')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'Get remaining (not sent) items of transfer batch by id' })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  findRemainingTransferBatchById(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.transfer_batches.find_remaining' },
      { id, requester: this.toRequester(req) },
    );
  }

  @Post('transfer-batches/:id/receive')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
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

  @Post('transfer-batches/:id/receive-orders')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'Receive selected orders from transfer batch by destination branch staff' })
  @ApiParam({ name: 'id', description: 'Transfer batch ID (bigint string)' })
  @ApiBody({ type: ReceiveTransferBatchOrdersRequestDto })
  receiveTransferBatchOrders(
    @Param('id') id: string,
    @Body() dto: ReceiveTransferBatchOrdersRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return this.branchClient.send(
      { cmd: 'branch.transfer_batches.receive_orders' },
      { id, dto, requester: this.toRequester(req) },
    );
  }

  @Post('transfer-batches/:id/cancel')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
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

  @Post('branches/posts/:postId/dispatch')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiOperation({ summary: 'Dispatch HQ post to destination branch' })
  @ApiParam({ name: 'postId', description: 'Logistics post ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['destination_branch_id', 'order_ids'],
      properties: {
        destination_branch_id: {
          type: 'string',
          example: '12',
          description: 'Destination branch ID',
        },
        order_ids: {
          type: 'array',
          items: { type: 'string' },
          example: ['101', '102'],
          description: 'Optional: only selected orders from post are dispatched',
        },
      },
    },
  })
  async dispatchPostToBranch(
    @Param('postId') postId: string,
    @Body('destination_branch_id') destinationBranchId: string,
    @Body('order_ids') orderIds: string[] | undefined,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    const normalizedOrderIds = Array.isArray(orderIds)
      ? orderIds.map((id) => String(id ?? '').trim()).filter(Boolean)
      : [];
    if (!normalizedOrderIds.length) {
      throw new BadRequestException('order_ids is required');
    }

    const sourceBranchId = await this.resolveSourceBranchIdForDispatch(req);
    return this.branchClient.send(
      { cmd: 'branch.post.dispatch' },
      {
        source_branch_id: sourceBranchId,
        post_id: postId,
        destination_branch_id: destinationBranchId,
        order_ids: normalizedOrderIds,
        requester: this.toRequester(req),
      },
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
