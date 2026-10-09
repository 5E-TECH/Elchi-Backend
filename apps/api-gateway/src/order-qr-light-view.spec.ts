import { ForbiddenException, GatewayTimeoutException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';
import { isOrderQrLightView, sendOrderQrLight } from './order-qr-light-view';
import { ScanGatewayController } from './scan-gateway.controller';

/**
 * D148eHMA — skaner uchun YENGIL javob (`?view=light`), gateway qatlami.
 *
 * 2026-10-09 prod UI testi: skaner ekranlari `GET /orders/qr-code/:token`
 * dan TO'LIQ buyurtmani (~4.5 KB) olardi; gateway `?view=` ni umuman
 * tanimasdi — yengil javob so'rashning yo'li yo'q edi.
 *
 * Kontrakt: parametrsiz so'rov AYNAN avvalgidek (to'liq javob); faqat
 * `view=light` da `order.find_by_qr_light` chaqiriladi.
 */

type Handlers = Record<string, unknown>;

function makeClient(handlers: Handlers = {}) {
  return {
    send: jest.fn((pattern: { cmd: string }) => {
      const handler = handlers[pattern.cmd];
      if (handler === undefined) {
        // Order-service eski versiyasi: bu naqsh uchun handler yo'q.
        return throwError(
          () =>
            'There is no matching message handler defined in the remote service.',
        );
      }
      if (
        handler instanceof Error ||
        (handler as { statusCode?: number })?.statusCode === 404
      ) {
        return throwError(() => handler);
      }
      return of(handler);
    }),
  };
}

const LIGHT = {
  statusCode: 200,
  message: 'Order by QR code (light)',
  data: { id: '77', market_id: '201', market: { id: '201', name: 'M' } },
};
const FULL = {
  statusCode: 200,
  message: 'Order by QR code',
  data: {
    id: '77',
    market_id: '201',
    market_tariff: 25000,
    branch: { id: '3' },
  },
};
const NOT_FOUND = { statusCode: 404, message: 'Order not found' };

const user = (sub: string, roles: string[]) => ({
  user: { sub, username: `u${sub}`, roles },
});

const cmds = (client: { send: jest.Mock }) =>
  (client.send.mock.calls as unknown[][]).map(
    (args) => (args[0] as { cmd: string }).cmd,
  );

function orderGateway(handlers: Handlers) {
  const order = makeClient(handlers);
  const other = makeClient();
  const controller = new OrderGatewayController(
    order as any,
    other as any,
    other as any,
    other as any,
  );
  return { controller, order };
}

function scanGateway(handlers: Handlers) {
  const order = makeClient(handlers);
  const other = makeClient();
  const controller = new ScanGatewayController(
    order as any,
    other as any,
    other as any,
  );
  return { controller, order };
}

describe('D148eHMA — GET /orders/qr-code/:token?view=light', () => {
  const both = {
    'order.find_by_qr_light': LIGHT,
    'order.find_by_qr_enriched': FULL,
  };

  it('view=light -> order.find_by_qr_light (yengil javob)', async () => {
    const { controller, order } = orderGateway(both);

    const res = await controller.findByQrCode(
      'tok-1',
      user('1', ['superadmin']),
      'light',
    );

    expect(res).toEqual(LIGHT);
    expect(order.send).toHaveBeenCalledTimes(1);
    expect(order.send).toHaveBeenCalledWith(
      { cmd: 'order.find_by_qr_light' },
      { token: 'tok-1' },
    );
  });

  it('parametrsiz (va noma`lum view) — AYNAN avvalgidek: to`liq javob', async () => {
    for (const view of [undefined, '', 'full', 'lightx']) {
      const { controller, order } = orderGateway(both);

      const res = await controller.findByQrCode(
        'tok-1',
        user('1', ['superadmin']),
        view,
      );

      expect(res).toEqual(FULL);
      expect(cmds(order)).toEqual(['order.find_by_qr_enriched']);
    }
  });

  it('MARKET: yengil javobda ham begona posilka -> 403, o`zinikiga -> OK', async () => {
    const foreign = orderGateway(both);
    await expect(
      foreign.controller.findByQrCode(
        'tok-1',
        user('202', ['market']),
        'light',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const own = orderGateway(both);
    await expect(
      own.controller.findByQrCode('tok-1', user('201', ['market']), 'light'),
    ).resolves.toEqual(LIGHT);
  });

  it('404 qayta so`ralmaydi (ikkinchi DB so`rovi va ikki baravar kutish yo`q)', async () => {
    const { controller, order } = orderGateway({
      'order.find_by_qr_light': NOT_FOUND,
      'order.find_by_qr_enriched': FULL,
    });

    await expect(
      controller.findByQrCode('yoq', user('1', ['admin']), 'light'),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(cmds(order)).toEqual(['order.find_by_qr_light']);
  });

  it('order-service eski (handler yo`q) -> to`liq javobga qaytadi, frontend sinmaydi', async () => {
    const { controller, order } = orderGateway({
      'order.find_by_qr_enriched': FULL,
    });

    const res = await controller.findByQrCode(
      'tok-1',
      user('1', ['admin']),
      'light',
    );

    expect(res).toEqual(FULL);
    expect(cmds(order)).toEqual([
      'order.find_by_qr_light',
      'order.find_by_qr_enriched',
    ]);
  });
});

describe('D148eHMA — GET /scan/:token?view=light (buyurtma tokeni)', () => {
  const req = { user: { sub: 'u1', roles: ['admin'] } } as any;

  it('view=light -> order.find_by_qr_light, javob shakli {type:order, data}', async () => {
    const { controller, order } = scanGateway({
      'order.find_by_qr_light': LIGHT,
    });

    const res = await controller.scan(' ORD-abc ', req, 'light');

    expect(res).toEqual({ type: 'order', data: LIGHT.data });
    expect(order.send).toHaveBeenCalledWith(
      { cmd: 'order.find_by_qr_light' },
      { token: 'ORD-abc' },
    );
  });

  it('parametrsiz — AYNAN avvalgidek: order.find_by_qr', async () => {
    const { controller, order } = scanGateway({
      'order.find_by_qr': { data: { id: '11' } },
    });

    const res = await controller.scan('ORD-abc', req);

    expect(res).toEqual({ type: 'order', data: { id: '11' } });
    expect(cmds(order)).toEqual(['order.find_by_qr']);
  });

  it('yengil yo`lda 404 -> QOP qidiruvi (CyCV4XHR) saqlanadi', async () => {
    const { controller, order } = scanGateway({
      'order.find_by_qr_light': NOT_FOUND,
      'order.find_batch_by_external_token': { data: { count: 2 } },
    });

    const res = await controller.scan('QOP-1', req, 'light');

    expect(res).toEqual({ type: 'batch', data: { count: 2 } });
    expect(cmds(order)).toEqual([
      'order.find_by_qr_light',
      'order.find_batch_by_external_token',
    ]);
  });

  it('MARKET: yengil javobda ham begona posilka -> 403', async () => {
    const { controller } = scanGateway({ 'order.find_by_qr_light': LIGHT });

    await expect(
      controller.scan(
        'ORD-abc',
        { user: { sub: '202', roles: ['market'] } } as any,
        'light',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('D148eHMA — sendOrderQrLight / isOrderQrLightView', () => {
  it('faqat `light` (registr/bo`shliqqa befarq) yengil hisoblanadi', () => {
    expect(isOrderQrLightView('light')).toBe(true);
    expect(isOrderQrLightView(' LIGHT ')).toBe(true);
    for (const value of [undefined, null, '', 'full', ['light'], 1]) {
      expect(isOrderQrLightView(value)).toBe(false);
    }
  });

  it('timeout qayta so`ralmaydi', async () => {
    const send = jest.fn(() =>
      Promise.reject(new GatewayTimeoutException('timeout')),
    );

    await expect(
      sendOrderQrLight(send, { cmd: 'order.find_by_qr_enriched' }),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('RpcException ko`rinishidagi 404 ham qayta so`ralmaydi', async () => {
    const rpc404 = new RpcException({ statusCode: 404, message: 'yo`q' });
    const send = jest.fn(() => Promise.reject(rpc404));

    await expect(
      sendOrderQrLight(send, { cmd: 'order.find_by_qr_enriched' }),
    ).rejects.toBe(rpc404);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
