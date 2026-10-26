import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { executeAndAck, RmqService, WAREHOUSE_RPC } from '@app/common';
import { WarehouseService } from './warehouse.service';
import { WarehouseStockService } from './warehouse-stock.service';
import { rpcError, WarehouseScope } from './warehouse.util';

type Payloadish = Record<string, any> | null | undefined;

/**
 * hY7uacJu: ombor moduli RMQ naqshlari (`@app/common` `WAREHOUSE_RPC`).
 *
 * `scope` — gateway filial xodimi (MANAGER/BRANCH) uchun `{ branch_id }`
 * yuboradi; yo'q bo'lsa — cheklovsiz (SUPERADMIN/ADMIN, ichki servis).
 * Bo'sh/noto'g'ri `scope` — 403 (fail-closed).
 */
@Controller()
export class WarehouseController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly warehouses: WarehouseService,
    private readonly stock: WarehouseStockService,
  ) {}

  private run<T>(context: RmqContext, handler: () => Promise<T> | T) {
    return executeAndAck(this.rmqService, context, handler);
  }

  private scope(data: Payloadish): WarehouseScope | null {
    const raw: unknown = data?.scope;
    if (raw === undefined || raw === null) return null;
    const value = (raw as { branch_id?: unknown })?.branch_id;
    const branchId =
      typeof value === 'string' || typeof value === 'number'
        ? String(value).trim()
        : '';
    if (!/^\d+$/.test(branchId)) {
      rpcError(403, "Filial aniqlanmadi — ombor ma'lumotini ko'rib bo'lmaydi");
    }
    return { branch_id: branchId };
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.CREATE })
  create(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.warehouses.create(data?.dto ?? {}, data?.requester),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.UPDATE })
  update(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.warehouses.update(data?.id, data?.dto ?? {}, data?.requester),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.PAUSE })
  pause(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.warehouses.setStatus(
        data?.id,
        'PAUSED',
        data?.requester,
        data?.note,
      ),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.RESUME })
  resume(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.warehouses.setStatus(
        data?.id,
        'ACTIVE',
        data?.requester,
        data?.note,
      ),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.FIND_ALL })
  findAll(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.warehouses.findAll(data?.query ?? {}, this.scope(data)),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.FIND_BY_ID })
  findById(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.warehouses.findOne(data?.id, this.scope(data)),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.FIND_BY_IDS })
  findByIds(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () => this.warehouses.findByIds(data?.ids));
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.STOCK })
  listStock(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.warehouses.listStock(data?.id, data?.query ?? {}, this.scope(data)),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.MOVEMENTS })
  listMovements(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.warehouses.listMovements(
        data?.id,
        data?.query ?? {},
        this.scope(data),
      ),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.LOOKUP })
  lookup(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.warehouses.lookup(data?.id, data?.query ?? {}, this.scope(data)),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.STOCK_IN })
  stockIn(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.stock.stockIn({
        warehouse_id: data?.warehouse_id,
        lines: data?.lines,
        market_id: data?.market_id,
        note: data?.note,
        idempotency_key: data?.idempotency_key,
        actor: data?.actor ?? data?.requester,
      }),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.INVENTORY })
  inventory(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.stock.inventory({
        warehouse_id: data?.warehouse_id,
        lines: data?.lines,
        reason: data?.reason,
        market_id: data?.market_id,
        idempotency_key: data?.idempotency_key,
        actor: data?.actor ?? data?.requester,
      }),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.SET_THRESHOLD })
  setThreshold(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.stock.setThreshold({
        warehouse_id: data?.warehouse_id,
        product_id: data?.product_id,
        low_stock_threshold: data?.low_stock_threshold,
        actor: data?.actor ?? data?.requester,
      }),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.MARKET_STOCK })
  marketStock(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.warehouses.marketStock(data?.market_id, data?.query ?? {}),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.AVAILABILITY })
  availability(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () => this.warehouses.availability(data ?? {}));
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.RESOLVE_SOURCE })
  resolveSource(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () => this.warehouses.resolveSource(data ?? {}));
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.RESERVE })
  reserve(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.stock.reserve({
        order_id: data?.order_id,
        warehouse_id: data?.warehouse_id,
        items: data?.items,
        market_id: data?.market_id,
        actor: data?.actor ?? data?.requester,
      }),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.RELEASE })
  release(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.stock.release({
        order_id: data?.order_id,
        actor: data?.actor ?? data?.requester,
        note: data?.note,
        lenient: data?.lenient === true,
      }),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.OUT })
  out(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.stock.out({
        order_id: data?.order_id,
        actor: data?.actor ?? data?.requester,
        note: data?.note,
        lenient: data?.lenient === true,
      }),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.RETURN })
  returnToWarehouse(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.stock.return({
        order_id: data?.order_id,
        items: data?.items,
        idempotency_key: data?.idempotency_key,
        // hfkhYrGk: jurnalda ko'rsatiladigan buyurtma (qisman sotuv bolasi).
        ref_order_id: data?.ref_order_id,
        actor: data?.actor ?? data?.requester,
        note: data?.note,
      }),
    );
  }

  @MessagePattern({ cmd: WAREHOUSE_RPC.ORDER_STATE })
  orderState(@Payload() data: Payloadish, @Ctx() context: RmqContext) {
    return this.run(context, () =>
      this.stock.orderState({ order_id: data?.order_id }),
    );
  }
}
