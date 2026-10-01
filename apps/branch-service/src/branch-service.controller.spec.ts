import 'reflect-metadata';
import { RpcException } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { BranchServiceController } from './branch-service.controller';

/**
 * C5 — `branch.dispatch_destinations` RPC'si gateway yukini (query +
 * requester) servisga to'g'ri uzatadi va xabarni ack qiladi.
 */
describe('BranchServiceController — branch.dispatch_destinations', () => {
  function setup() {
    const rmqService = { ack: jest.fn(), nackForError: jest.fn() };
    const branchService = {
      findDispatchDestinations: jest.fn().mockResolvedValue({
        statusCode: 200,
        message: 'ok',
        data: { items: [], total: 0 },
      }),
    };
    const controller = new BranchServiceController(
      rmqService as never,
      branchService as never,
    );
    const context = {
      getPattern: () => 'branch.dispatch_destinations',
      getMessage: () => ({ fields: { redelivered: false } }),
      getChannelRef: () => ({ ack: jest.fn(), nack: jest.fn() }),
    };
    return { controller, rmqService, branchService, context };
  }

  it('cmd metadata', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      BranchServiceController.prototype,
      'findDispatchDestinations',
    );
    expect(Reflect.getMetadata(PATTERN_METADATA, descriptor?.value)).toEqual([
      { cmd: 'branch.dispatch_destinations' },
    ]);
  });

  it('query va requester servisga uzatiladi, xabar ack qilinadi', async () => {
    const { controller, rmqService, branchService, context } = setup();
    const requester = { id: '269', roles: ['registrator'] };

    const res = await controller.findDispatchDestinations(
      { query: { region_id: '7' }, requester },
      context as never,
    );

    expect(branchService.findDispatchDestinations).toHaveBeenCalledWith(
      { region_id: '7' },
      requester,
    );
    expect(rmqService.ack).toHaveBeenCalledWith(context);
    expect(res).toEqual(expect.objectContaining({ statusCode: 200 }));
  });

  it("query yo'q bo'lsa bo'sh obyekt uzatiladi", async () => {
    const { controller, branchService, context } = setup();

    await controller.findDispatchDestinations({}, context as never);

    expect(branchService.findDispatchDestinations).toHaveBeenCalledWith(
      {},
      undefined,
    );
  });
});

/**
 * R3 — kuryerni filialdan filialga o'tkazish RPC'lari. Gateway va identity
 * (deleteUser) aynan shu nomlarni yuboradi — nom o'zgarsa o'tkazish ham,
 * kuryerni o'chirish ham 503 bilan to'xtab qoladi.
 */
describe('BranchServiceController — kuryer o`tkazish (R3)', () => {
  function setup() {
    const rmqService = { ack: jest.fn(), nackForError: jest.fn() };
    const branchService = {
      courierTransferCheck: jest.fn().mockResolvedValue({
        statusCode: 200,
        message: "Kuryer o'tkazish tekshiruvi",
        data: { reasons: [], can_transfer: true },
      }),
      transferCourierToBranch: jest.fn().mockResolvedValue({
        statusCode: 200,
        message: "Kuryer 'Samarqand' filialiga o'tkazildi",
        data: { user_id: '263', from_branch_id: '1', to_branch_id: '15' },
      }),
    };
    const controller = new BranchServiceController(
      rmqService as never,
      branchService as never,
    );
    const context = {
      getPattern: () => 'branch.user.transfer_courier',
      getMessage: () => ({ fields: { redelivered: false } }),
      getChannelRef: () => ({ ack: jest.fn(), nack: jest.fn() }),
    };
    return { controller, rmqService, branchService, context };
  }

  const patternOf = (method: keyof BranchServiceController) =>
    Reflect.getMetadata(
      PATTERN_METADATA,
      Object.getOwnPropertyDescriptor(BranchServiceController.prototype, method)
        ?.value,
    );

  it('cmd metadata', () => {
    expect(patternOf('courierTransferCheck')).toEqual([
      { cmd: 'branch.user.courier_transfer_check' },
    ]);
    expect(patternOf('transferCourier')).toEqual([
      { cmd: 'branch.user.transfer_courier' },
    ]);
  });

  it('tekshiruv: ({user_id}, requester) uzatiladi, ortiqcha kalitlar yo`q, ack', async () => {
    const { controller, rmqService, branchService, context } = setup();
    const requester = { id: '1', roles: ['superadmin'] };

    const res = await controller.courierTransferCheck(
      { user_id: '263', branch_id: '15', requester },
      context as never,
    );

    expect(branchService.courierTransferCheck).toHaveBeenCalledWith(
      { user_id: '263' },
      requester,
    );
    expect(rmqService.ack).toHaveBeenCalledWith(context);
    expect(res).toEqual(expect.objectContaining({ statusCode: 200 }));
  });

  it("o'tkazish: ({user_id, branch_id}, requester) uzatiladi, ack", async () => {
    const { controller, rmqService, branchService, context } = setup();
    const requester = { id: '2', roles: ['admin'] };

    const res = await controller.transferCourier(
      { user_id: '263', branch_id: '15', role: 'MANAGER', requester },
      context as never,
    );

    expect(branchService.transferCourierToBranch).toHaveBeenCalledWith(
      { user_id: '263', branch_id: '15' },
      requester,
    );
    expect(rmqService.ack).toHaveBeenCalledWith(context);
    expect(res).toEqual(
      expect.objectContaining({
        statusCode: 200,
        data: expect.objectContaining({ to_branch_id: '15' }),
      }),
    );
  });

  it('servis RpcException otsa — nack qilinadi (qayta navbat yo`q) va xato qaytadi', async () => {
    const { controller, rmqService, branchService, context } = setup();
    const error = new RpcException({
      statusCode: 409,
      message: "Kuryerni boshqa filialga o'tkazib bo'lmaydi: …",
    });
    branchService.transferCourierToBranch.mockRejectedValue(error);

    await expect(
      controller.transferCourier(
        { user_id: '263', branch_id: '15' },
        context as never,
      ),
    ).rejects.toBe(error);
    expect(rmqService.nackForError).toHaveBeenCalledWith(context, error);
    expect(rmqService.ack).not.toHaveBeenCalled();
  });
});
