import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { BranchServiceService } from './branch-service.service';

@Controller()
export class BranchServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly branchService: BranchServiceService,
  ) {}

  private getRequester(data: Record<string, any>) {
    return data?.requester;
  }

  private async executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    try {
      const result = await handler();
      this.rmqService.ack(context);
      return result;
    } catch (error) {
      this.rmqService.nack(context);
      throw error;
    }
  }

  @MessagePattern({ cmd: 'branch.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      service: 'branch-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    }));
  }

  // --- Branch ---
  @MessagePattern({ cmd: 'branch.create' })
  create(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.branchService.createBranch(data?.dto ?? data));
  }

  @MessagePattern({ cmd: 'branch.find_all' })
  findAll(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.findAllBranches(data?.query ?? data, this.getRequester(data)),
    );
  }

  @MessagePattern({ cmd: 'branch.find_by_id' })
  findById(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.findBranchById(data?.id, this.getRequester(data)),
    );
  }

  @MessagePattern({ cmd: 'branch.tree' })
  findTree(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.branchService.findBranchTree());
  }

  @MessagePattern({ cmd: 'branch.descendants' })
  findDescendants(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.findBranchDescendants(data?.id),
    );
  }

  @MessagePattern({ cmd: 'branch.stats' })
  getStats(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.getBranchStats(data?.id, this.getRequester(data)),
    );
  }

  @MessagePattern({ cmd: 'branch.analytics.markets' })
  getMarketsAnalytics(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.getBranchMarketsAnalytics(data?.id, this.getRequester(data)),
    );
  }

  @MessagePattern({ cmd: 'branch.transfer_batches.create' })
  createTransferBatches(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.createTransferBatches(
        data?.id,
        data?.dto ?? data,
        this.getRequester(data),
      ),
    );
  }

  @MessagePattern({ cmd: 'branch.transfer_batches.send' })
  sendTransferBatch(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.sendTransferBatch(
        data?.id,
        data?.dto ?? data,
        this.getRequester(data),
      ),
    );
  }

  @MessagePattern({ cmd: 'branch.transfer_batch.find_by_token' })
  findTransferBatchByToken(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.findTransferBatchByToken(
        data?.token,
        this.getRequester(data),
      ),
    );
  }

  @MessagePattern({ cmd: 'branch.transfer_batches.receive' })
  receiveTransferBatch(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.receiveTransferBatch(
        data?.id,
        this.getRequester(data),
      ),
    );
  }

  @MessagePattern({ cmd: 'branch.transfer_batches.cancel' })
  cancelTransferBatch(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.cancelTransferBatch(
        data?.id,
        data?.dto ?? data,
        this.getRequester(data),
      ),
    );
  }

  @MessagePattern({ cmd: 'branch.update' })
  update(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.updateBranch(data?.id, data?.dto ?? data, this.getRequester(data)),
    );
  }

  @MessagePattern({ cmd: 'branch.delete' })
  remove(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.deleteBranch(data?.id, this.getRequester(data)),
    );
  }

  // --- BranchUser ---
  @MessagePattern({ cmd: 'branch.user.assign' })
  assignUser(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.assignUserToBranch(data?.dto ?? data, this.getRequester(data)),
    );
  }

  @MessagePattern({ cmd: 'branch.user.remove' })
  removeUser(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.removeUserFromBranch({
        branch_id: data?.branch_id ?? data?.id,
        user_id: data?.user_id,
      }, this.getRequester(data)),
    );
  }

  @MessagePattern({ cmd: 'branch.user.find_by_branch' })
  findUsersByBranch(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.findUsersByBranch(data?.branch_id ?? data?.id, this.getRequester(data)),
    );
  }

  @MessagePattern({ cmd: 'branch.user.find_by_user' })
  findUserBranch(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.findUserBranch(
        data?.user_id,
        this.getRequester(data),
      ),
    );
  }

  // --- BranchConfig ---
  @MessagePattern({ cmd: 'branch.config.set' })
  setConfig(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.setBranchConfig({
        branch_id: data?.branch_id ?? data?.id,
        config_key: data?.dto?.config_key ?? data?.config_key,
        config_value: data?.dto?.config_value ?? data?.config_value,
      }, this.getRequester(data)),
    );
  }

  // Alias for compatibility with older/newer callers
  @MessagePattern({ cmd: 'branch.config.create' })
  createConfig(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.setBranchConfig({
        branch_id: data?.branch_id ?? data?.id,
        config_key: data?.dto?.config_key ?? data?.config_key,
        config_value: data?.dto?.config_value ?? data?.config_value,
      }, this.getRequester(data)),
    );
  }

  @MessagePattern({ cmd: 'branch.config.get' })
  getConfig(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.getBranchConfig(data?.branch_id ?? data?.id, this.getRequester(data)),
    );
  }

  // Alias for compatibility with older/newer callers
  @MessagePattern({ cmd: 'branch.config.find_by_branch' })
  findConfigByBranch(
    @Payload() data: Record<string, any>,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.branchService.getBranchConfig(data?.branch_id ?? data?.id, this.getRequester(data)),
    );
  }

  @MessagePattern({ cmd: 'branch.config.find_one' })
  getConfigByKey(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.getBranchConfigByKey({
        branch_id: data?.branch_id ?? data?.id,
        config_key: data?.config_key ?? data?.key,
      }, this.getRequester(data)),
    );
  }

  @MessagePattern({ cmd: 'branch.config.update' })
  updateConfig(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.updateBranchConfig({
        branch_id: data?.branch_id ?? data?.id,
        config_key: data?.config_key ?? data?.key,
        config_value: data?.dto?.config_value ?? data?.config_value,
      }, this.getRequester(data)),
    );
  }

  @MessagePattern({ cmd: 'branch.config.delete' })
  deleteConfig(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.deleteBranchConfig({
        branch_id: data?.branch_id ?? data?.id,
        config_key: data?.config_key ?? data?.key,
      }, this.getRequester(data)),
    );
  }
}
