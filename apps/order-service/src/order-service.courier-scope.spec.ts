import type { RmqContext } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { OrderServiceController } from './order-service.controller';

/**
 * B4 — `order.settlement.courier_scope` RMQ handleri. Gateway (superadmin/admin
 * kuryerdan pul olishi, kuryer kassasi sahifasi) aynan shu nomni yuboradi —
 * nom o'zgarsa to'lov 503 bilan to'xtab qoladi, shuning uchun qat'iy tekshiriladi.
 */
describe('order.settlement.courier_scope handleri', () => {
  const handler = Object.getOwnPropertyDescriptor(
    OrderServiceController.prototype,
    'settlementCourierScope',
  )?.value as (
    data: { courier_id?: string | null } | undefined,
    context: RmqContext,
  ) => Promise<unknown>;

  it("naqsh AYNAN { cmd: 'order.settlement.courier_scope' }", () => {
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: 'order.settlement.courier_scope' },
    ]);
  });

  it('payload servisga o`zgarishsiz uzatiladi, javob qaytadi', async () => {
    const scope = { data: { branch_pending_count: 0 } };
    const settlementService = {
      getCourierSettlementScope: jest.fn().mockResolvedValue(scope),
    };
    const executeAndAck = jest.fn(
      (_ctx: RmqContext, fn: () => Promise<unknown>) => fn(),
    );
    const ctx = {} as RmqContext;

    const res = await handler.call(
      { executeAndAck, settlementService },
      { courier_id: '263' },
      ctx,
    );

    expect(res).toBe(scope);
    expect(executeAndAck).toHaveBeenCalledWith(ctx, expect.any(Function));
    expect(settlementService.getCourierSettlementScope).toHaveBeenCalledWith({
      courier_id: '263',
    });
  });

  it('payload bo`lmasa bo`sh obyekt uzatiladi', async () => {
    const settlementService = {
      getCourierSettlementScope: jest.fn().mockResolvedValue({ data: {} }),
    };

    await handler.call(
      {
        executeAndAck: (_ctx: RmqContext, fn: () => Promise<unknown>) => fn(),
        settlementService,
      },
      undefined,
      {} as RmqContext,
    );

    expect(settlementService.getCourierSettlementScope).toHaveBeenCalledWith(
      {},
    );
  });
});
