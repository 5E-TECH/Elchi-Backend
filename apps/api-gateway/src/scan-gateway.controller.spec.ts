import { NotFoundException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { ScanGatewayController } from './scan-gateway.controller';

describe('ScanGatewayController', () => {
  const req = { user: { sub: 'u1', roles: ['admin'] } } as any;

  function setup() {
    const orderClient = { send: jest.fn() };
    const branchClient = { send: jest.fn() };
    const logisticsClient = { send: jest.fn() };
    const controller = new ScanGatewayController(
      orderClient as any,
      branchClient as any,
      logisticsClient as any,
    );

    return { controller, orderClient, branchClient, logisticsClient };
  }

  it('routes ORD- token to order-service and returns type=order', async () => {
    const { controller, orderClient } = setup();
    orderClient.send.mockReturnValue(of({ data: { id: '11' } }));

    const res = await controller.scan('ORD-abc123', req);

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.find_by_qr' },
      { token: 'ORD-abc123' },
    );
    expect(res).toEqual({ type: 'order', data: { id: '11' } });
  });

  it('routes BTB/BTR tokens to branch-service and returns type=batch', async () => {
    const { controller, branchClient } = setup();
    branchClient.send.mockReturnValue(of({ data: { id: '501', qr_code_token: 'BTB-x' } }));

    const res = await controller.scan('BTB-x', req);

    expect(branchClient.send).toHaveBeenCalledWith(
      { cmd: 'branch.transfer_batch.find_by_token' },
      { token: 'BTB-x', requester: { id: 'u1', roles: ['admin'] } },
    );
    expect(res.type).toBe('batch');
  });

  it('routes PST- token to logistics-service and returns type=post', async () => {
    const { controller, logisticsClient } = setup();
    logisticsClient.send.mockReturnValue(of({ data: { id: '91', qr_code_token: 'PST-z' } }));

    const res = await controller.scan('PST-z', req);

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.post.find_by_scan' },
      { id: 'PST-z' },
    );
    expect(res.type).toBe('post');
  });

  it('routes legacy prefixless token to order-service', async () => {
    const { controller, orderClient } = setup();
    orderClient.send.mockReturnValue(of({ data: { id: '77' } }));

    const res = await controller.scan('legacyToken123', req);

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.find_by_qr' },
      { token: 'legacyToken123' },
    );
    expect(res.type).toBe('order');
  });

  it('propagates not found from downstream service', async () => {
    const { controller, orderClient } = setup();
    orderClient.send.mockReturnValue(throwError(() => new NotFoundException('Topilmadi')));

    await expect(controller.scan('ORD-notfound', req)).rejects.toBeInstanceOf(NotFoundException);
  });
});
