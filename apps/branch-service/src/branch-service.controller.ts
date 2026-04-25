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
    return this.executeAndAck(context, () => this.branchService.findAllBranches(data?.query ?? data));
  }

  @MessagePattern({ cmd: 'branch.find_by_id' })
  findById(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.branchService.findBranchById(data?.id));
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

  @MessagePattern({ cmd: 'branch.update' })
  update(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.updateBranch(data?.id, data?.dto ?? data),
    );
  }

  @MessagePattern({ cmd: 'branch.delete' })
  remove(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.branchService.deleteBranch(data?.id));
  }

  // --- BranchUser ---
  @MessagePattern({ cmd: 'branch.user.assign' })
  assignUser(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.assignUserToBranch(data?.dto ?? data),
    );
  }

  @MessagePattern({ cmd: 'branch.user.remove' })
  removeUser(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.removeUserFromBranch({
        branch_id: data?.branch_id ?? data?.id,
        user_id: data?.user_id,
      }),
    );
  }

  @MessagePattern({ cmd: 'branch.user.find_by_branch' })
  findUsersByBranch(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.findUsersByBranch(data?.branch_id ?? data?.id),
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
      }),
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
      }),
    );
  }

  @MessagePattern({ cmd: 'branch.config.get' })
  getConfig(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.getBranchConfig(data?.branch_id ?? data?.id),
    );
  }

  // Alias for compatibility with older/newer callers
  @MessagePattern({ cmd: 'branch.config.find_by_branch' })
  findConfigByBranch(
    @Payload() data: Record<string, any>,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.branchService.getBranchConfig(data?.branch_id ?? data?.id),
    );
  }

  @MessagePattern({ cmd: 'branch.config.find_one' })
  getConfigByKey(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.getBranchConfigByKey({
        branch_id: data?.branch_id ?? data?.id,
        config_key: data?.config_key ?? data?.key,
      }),
    );
  }

  @MessagePattern({ cmd: 'branch.config.update' })
  updateConfig(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.updateBranchConfig({
        branch_id: data?.branch_id ?? data?.id,
        config_key: data?.config_key ?? data?.key,
        config_value: data?.dto?.config_value ?? data?.config_value,
      }),
    );
  }

  @MessagePattern({ cmd: 'branch.config.delete' })
  deleteConfig(@Payload() data: Record<string, any>, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.branchService.deleteBranchConfig({
        branch_id: data?.branch_id ?? data?.id,
        config_key: data?.config_key ?? data?.key,
      }),
    );
  }
}
