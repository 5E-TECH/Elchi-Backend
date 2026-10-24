import { ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * nCAFnqIe — `GET /orders/markets/:marketId/new` MARKET_OPERATOR ga, FAQAT
 * o'zi biriktirilgan market uchun (identity `user.market_id`). Tanlov:
 * backend yo'li ochildi (frontend `GET /orders?status=new` ga o'tmaydi).
 * Javob market roli bilan bir xil: `source='branch'` siz, kuryer
 * tarifi/ulushi va filial ulushisiz.
 */
type Handlers = Record<string, unknown>;

function makeClient(handlers: Handlers = {}) {
  return {
    send: jest.fn((pattern: { cmd: string }) => {
      const value = handlers[pattern.cmd];
      return of(value ?? { statusCode: 200, data: [] });
    }),
  };
}

const NEW_ORDERS = {
  statusCode: 200,
  data: [
    {
      id: '76',
      market_id: '501',
      status: 'new',
      market_tariff: 20000,
      courier_tariff: 15000,
      courier_share: 15000,
      branch_share: 3000,
    },
  ],
};

function setup(operatorMarketId: string | null = '501') {
  const order = makeClient({
    'order.find_new_by_market_enriched': NEW_ORDERS,
  });
  const identity = makeClient({
    'identity.user.find_by_id': {
      data: { id: '26', market_id: operatorMarketId },
    },
  });
  const branch = makeClient();
  const controller = new OrderGatewayController(
    order as any,
    identity as any,
    makeClient() as any,
    branch as any,
  );
  return { controller, order, identity, branch };
}

const req = (sub: string, roles: string[]) =>
  ({ user: { sub, username: 'u', roles } }) as any;

const sentTo = (client: { send: jest.Mock }, cmd: string) =>
  (client.send.mock.calls as unknown[][]).filter(
    (args) => (args[0] as { cmd: string }).cmd === cmd,
  );

describe('nCAFnqIe — markets/:marketId/new MARKET_OPERATOR (faqat o‘z marketi)', () => {
  it('@Roles ga market_operator qo‘shilgan', () => {
    const handler = Object.getOwnPropertyDescriptor(
      OrderGatewayController.prototype,
      'findNewOrdersByMarket',
    )?.value as object;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toContain(
      'market_operator',
    );
  });

  it('⭐ o‘z marketi — 200, market kabi payload, moliyaviy proyeksiya (MARKET_HIDDEN)', async () => {
    const { controller, order, identity, branch } = setup('501');

    const res: any = await controller.findNewOrdersByMarket(
      '501',
      req('26', ['market_operator']),
    );

    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      { id: '26' },
    );
    expect(sentTo(order, 'order.find_new_by_market_enriched')[0][1]).toEqual({
      market_id: '501',
      branch_id: undefined,
      exclude_branch_source: true,
    });
    // Filial biriktiruvi so'ralmaydi (operator filial xodimi emas).
    expect(branch.send).not.toHaveBeenCalled();
    const row = res.data[0];
    expect(row.market_tariff).toBe(20000);
    for (const hidden of ['courier_tariff', 'courier_share', 'branch_share']) {
      expect(row).not.toHaveProperty(hidden);
    }
  });

  it('⭐ boshqa market id si — 403, order-service chaqirilmaydi', async () => {
    const { controller, order } = setup('501');

    await expect(
      controller.findNewOrdersByMarket('502', req('26', ['market_operator'])),
    ).rejects.toThrow(
      new ForbiddenException(
        'market_operator role cannot query other market_id',
      ),
    );
    expect(sentTo(order, 'order.find_new_by_market_enriched')).toHaveLength(0);
  });

  it('marketga biriktirilmagan operator — 403', async () => {
    const { controller, order } = setup(null);

    await expect(
      controller.findNewOrdersByMarket('501', req('26', ['market_operator'])),
    ).rejects.toThrow(
      new ForbiddenException('Operator hech qaysi marketga biriktirilmagan'),
    );
    expect(sentTo(order, 'order.find_new_by_market_enriched')).toHaveLength(0);
  });

  it('market roli — o‘zgarishsiz (identity chaqirilmaydi)', async () => {
    const { controller, identity } = setup();

    await controller.findNewOrdersByMarket('501', req('501', ['market']));

    expect(identity.send).not.toHaveBeenCalled();
  });

  it('superadmin — o‘zgarishsiz (har qanday market, identity chaqirilmaydi)', async () => {
    const { controller, identity, order } = setup();

    await controller.findNewOrdersByMarket('777', req('1', ['superadmin']));

    expect(identity.send).not.toHaveBeenCalled();
    expect(
      sentTo(order, 'order.find_new_by_market_enriched')[0][1].market_id,
    ).toBe('777');
  });
});
