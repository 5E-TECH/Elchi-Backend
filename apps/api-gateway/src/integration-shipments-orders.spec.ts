import { of, throwError } from 'rxjs';
import { IntegrationGatewayController } from './integration-gateway.controller';

/**
 * Posilkalar jadvali: buyurtma xulosasi (tokhPLMP) — bitta so'rov, fail-soft.
 */

type Client = { send: jest.Mock };

const page = {
  statusCode: 200,
  data: {
    items: [
      { id: '1', order_id: '1001', internal_status: 'waiting' },
      { id: '2', order_id: '1001', internal_status: 'waiting' },
      { id: '3', order_id: '1002', internal_status: 'sold' },
    ],
    pagination: { total: 3, page: 1, limit: 20 },
    counts: { all: 3, not_sent: 0, failed: 0, delivered: 1, mismatch: null },
  },
};

const setup = (orderReply: () => unknown) => {
  const integrationClient: Client = {
    send: jest.fn(() => of(structuredClone(page))),
  };
  const orderClient: Client = { send: jest.fn(orderReply) };
  const controller = new IntegrationGatewayController(
    integrationClient as any,
    orderClient as any,
  );
  return { controller, integrationClient, orderClient };
};

describe('GET integrations/:id/shipments — buyurtma xulosasi', () => {
  it('takrorlanmas order_id lar BITTA order.summary_by_ids bilan so‘raladi va qatorlarga qo‘shiladi', async () => {
    const fx = setup(() =>
      of({
        data: [
          {
            id: '1001',
            order_number: '1001',
            customer_name: 'Ali',
            customer_phone: '+998901234567',
            total_price: 150000,
          },
          {
            id: '1002',
            order_number: '1002',
            customer_name: 'Vali',
            total_price: 90000,
          },
        ],
      }),
    );
    const res: any = await fx.controller.listProviderShipments(
      '7',
      undefined,
      undefined,
      '1',
      '20',
      'delivered',
    );

    expect(fx.orderClient.send).toHaveBeenCalledTimes(1);
    expect(fx.orderClient.send.mock.calls[0]).toEqual([
      { cmd: 'order.summary_by_ids' },
      { ids: ['1001', '1002'] },
    ]);
    expect(fx.integrationClient.send.mock.calls[0][1]).toMatchObject({
      filter: 'delivered',
    });
    expect(res.data.items[0].order.customer_name).toBe('Ali');
    expect(res.data.items[2].order.total_price).toBe(90000);
    expect(res.data.counts.delivered).toBe(1);
  });

  it('order-service yiqilsa jadval baribir qaytadi (order: null)', async () => {
    const fx = setup(() => throwError(() => new Error('timeout')));
    const res: any = await fx.controller.listProviderShipments('7');
    expect(res.data.items).toHaveLength(3);
    expect(res.data.items.every((row: any) => row.order === null)).toBe(true);
  });
});

describe('GET integrations/webhook-logs — imzo filtri', () => {
  it('invalid_signature=true integration-service ga boolean bo‘lib ketadi', () => {
    const integrationClient: Client = {
      send: jest.fn(() => of({ data: { items: [] } })),
    };
    const controller = new IntegrationGatewayController(
      integrationClient as any,
    );
    controller.webhookLogs('7', undefined, undefined, undefined, 'true');
    controller.webhookLogs('7');
    expect(integrationClient.send.mock.calls[0][1]).toMatchObject({
      invalid_signature: true,
    });
    expect(integrationClient.send.mock.calls[1][1]).toMatchObject({
      invalid_signature: false,
    });
  });
});

describe('GET integrations/status-catalog (JnHK6bgV)', () => {
  it('posilka katalogi Order_status dan, to‘lov katalogi alohida', () => {
    const controller = new IntegrationGatewayController({
      send: jest.fn(),
    } as any);
    const res = controller.statusCatalog();
    expect(res.data.shipment.map((e) => e.code)).toContain('cancelled (sent)');
    expect(res.data.shipment).toHaveLength(13);
    expect(res.data.payment.map((e) => e.code)).toEqual([
      'succeeded',
      'pending',
      'failed',
      'refunded',
    ]);
  });
});
