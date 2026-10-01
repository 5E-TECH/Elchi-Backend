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
    branchClient.send.mockReturnValue(
      of({ data: { id: '501', qr_code_token: 'BTB-x' } }),
    );

    const res = await controller.scan('BTB-x', req);

    expect(branchClient.send).toHaveBeenCalledWith(
      { cmd: 'branch.transfer_batch.find_by_token' },
      { token: 'BTB-x', requester: { id: 'u1', roles: ['admin'] } },
    );
    expect(res.type).toBe('batch');
  });

  it('routes PST- token to logistics-service and returns type=post', async () => {
    const { controller, logisticsClient } = setup();
    logisticsClient.send.mockReturnValue(
      of({ data: { id: '91', qr_code_token: 'PST-z' } }),
    );

    const res = await controller.scan('PST-z', req);

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.post.find_by_scan' },
      { id: 'PST-z' },
    );
    expect(res.type).toBe('post');
  });

  it('routes market cancelled QR to its state-changing scan endpoint', async () => {
    const { controller, orderClient } = setup();
    orderClient.send.mockReturnValue(
      of({
        data: {
          market_id: '16',
          authorization_token: 'MHA-token',
          remaining_seconds: 300,
        },
      }),
    );

    const res = await controller.scanMarketCancelledHandover(
      { qr_token: 'MCR-token' },
      req,
    );

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.market_cancelled_handover.scan_qr' },
      {
        qr_token: 'MCR-token',
        requester: { id: 'u1', roles: ['admin'] },
      },
    );
    expect(res.type).toBe('market_cancelled_handover');
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
    orderClient.send.mockReturnValue(
      throwError(() => new NotFoundException('Topilmadi')),
    );

    await expect(controller.scan('ORD-notfound', req)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('CyCV4XHR: prefiksiz QOP tokeni — order 404 bo`lsa external_batch_token bo`yicha qidiradi (type=batch)', async () => {
    const { controller, orderClient } = setup();
    orderClient.send
      // 1) order.find_by_qr -> 404 (posilka emas, qop yorlig'i)
      .mockReturnValueOnce(
        throwError(() => ({ statusCode: 404, message: 'Order not found' })),
      )
      // 2) order.find_batch_by_external_token -> qop a'zolari
      .mockReturnValueOnce(
        of({
          data: {
            external_batch_token: 'QOP-1',
            is_external_batch: true,
            count: 2,
            members: [{ id: '1' }, { id: '2' }],
          },
        }),
      );

    const res = await controller.scan('QOP-1', req);

    expect(orderClient.send).toHaveBeenNthCalledWith(
      1,
      { cmd: 'order.find_by_qr' },
      { token: 'QOP-1' },
    );
    expect(orderClient.send).toHaveBeenNthCalledWith(
      2,
      { cmd: 'order.find_batch_by_external_token' },
      { token: 'QOP-1' },
    );
    expect(res.type).toBe('batch');
    expect((res.data as any).count).toBe(2);
  });

  it('CyCV4XHR: order ham, qop ham topilmasa 404 propagatsiya qilinadi', async () => {
    const { controller, orderClient } = setup();
    orderClient.send
      .mockReturnValueOnce(
        throwError(() => ({ statusCode: 404, message: 'Order not found' })),
      )
      .mockReturnValueOnce(
        throwError(() => ({ statusCode: 404, message: 'Batch not found' })),
      );

    await expect(controller.scan('unknownTok', req)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(orderClient.send).toHaveBeenCalledTimes(2);
  });

  it('CyCV4XHR: 404 BO`LMAGAN xato (500) qop qidiruvini BOSHLAMAYDI', async () => {
    const { controller, orderClient } = setup();
    orderClient.send.mockReturnValueOnce(
      throwError(() => ({ statusCode: 500, message: 'boom' })),
    );

    await expect(controller.scan('tok500', req)).rejects.toMatchObject({
      statusCode: 500,
    });
    // Qop lookup BOSHLANMADI — faqat bitta (order) chaqiruv.
    expect(orderClient.send).toHaveBeenCalledTimes(1);
  });
});
