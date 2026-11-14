import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { CarrierAccountService } from './carrier-account.service';

type Requester = { id?: string; roles?: string[] } | null;

/**
 * Carrier API akkauntlari — RMQ kirish nuqtalari.
 *
 * `validate_key` gateway'dagi `CarrierApiKeyGuard` dan, qolganlari
 * `/admin/carriers` (SUPERADMIN/ADMIN) dan chaqiriladi.
 */
@Controller()
export class CarrierAccountController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly carrierService: CarrierAccountService,
  ) {}

  private executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeAndAck(this.rmqService, context, handler);
  }

  @MessagePattern({ cmd: 'integration.carrier.validate_key' })
  validateKey(
    @Payload() data: { api_key?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.carrierService.validateKey(data?.api_key ?? ''),
    );
  }

  @MessagePattern({ cmd: 'integration.carrier.create' })
  create(
    @Payload()
    data: {
      name?: string;
      courier_id?: string | number;
      ip_allowlist?: string[] | null;
      requester?: Requester;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.carrierService.create(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'integration.carrier.list' })
  list(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.carrierService.list());
  }

  @MessagePattern({ cmd: 'integration.carrier.update' })
  update(
    @Payload()
    data: {
      id?: string;
      name?: string;
      ip_allowlist?: string[] | null;
      rollback_enabled?: boolean;
      requester?: Requester;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.carrierService.update(
        String(data?.id ?? ''),
        {
          name: data?.name,
          ip_allowlist: data?.ip_allowlist,
          rollback_enabled: data?.rollback_enabled,
        },
        data?.requester,
      ),
    );
  }

  @MessagePattern({ cmd: 'integration.carrier.rotate_key' })
  rotateKey(
    @Payload() data: { id?: string; requester?: Requester },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.carrierService.rotateKey(String(data?.id ?? ''), data?.requester),
    );
  }

  @MessagePattern({ cmd: 'integration.carrier.set_active' })
  setActive(
    @Payload()
    data: { id?: string; is_active?: boolean; requester?: Requester },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.carrierService.setActive(
        String(data?.id ?? ''),
        data?.is_active as boolean,
        data?.requester,
      ),
    );
  }
}
