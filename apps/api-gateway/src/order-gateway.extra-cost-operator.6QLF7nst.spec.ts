import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * 6QLF7nst — `GET /orders/extra-cost-approvals` MARKET_OPERATOR uchun faqat
 * o'qish. Operator marketi identity'dan (`user.market_id`) — so'rovdan
 * olinmaydi; approve/reject operatorga yopiq (RolesGuard 403).
 */
type Handlers = Record<string, unknown>;

function makeClient(handlers: Handlers = {}) {
  return {
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      const handler = handlers[pattern.cmd];
      const value =
        typeof handler === 'function'
          ? (handler as (p: unknown) => unknown)(payload)
          : handler;
      return of(value ?? { statusCode: 200, data: [] });
    }),
  };
}

function setup(identity: Handlers = {}) {
  const order = makeClient();
  const identityClient = makeClient(identity);
  const controller = new OrderGatewayController(
    order as never,
    identityClient as never,
    makeClient() as never,
    makeClient() as never,
  );
  return { controller, order, identity: identityClient };
}

const req = (sub: string, roles: string[]) =>
  ({ user: { sub, username: 'u', roles } }) as never;

const listPayload = (order: { send: jest.Mock }) => {
  const call = (order.send.mock.calls as unknown[][]).find(
    (args) =>
      (args[0] as { cmd: string }).cmd === 'order.extra_cost_approval.list',
  );
  return call?.[1] as Record<string, any> | undefined;
};

describe('6QLF7nst — extra-cost approvals: MARKET_OPERATOR faqat o‘qish', () => {
  const handler = (name: keyof OrderGatewayController) =>
    Object.getOwnPropertyDescriptor(OrderGatewayController.prototype, name)
      ?.value as object;
  const rolesOf = (name: keyof OrderGatewayController) =>
    Reflect.getMetadata(ROLES_KEY, handler(name)) as string[];

  it('GET ro‘yxat — market_operator ruxsat etilgan (market/SA/admin qoladi)', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, handler('listExtraCostApprovals')),
    ).toContain(RolesGuard);
    expect(rolesOf('listExtraCostApprovals').sort()).toEqual(
      ['admin', 'market', 'market_operator', 'superadmin'].sort(),
    );
  });

  it.each([['approveExtraCostApproval'], ['rejectExtraCostApproval']] as Array<
    [keyof OrderGatewayController]
  >)('%s — market_operator YO‘Q (403)', (name) => {
    expect(rolesOf(name)).not.toContain('market_operator');
    expect(rolesOf(name).sort()).toEqual(['admin', 'market', 'superadmin']);
  });

  it('⭐ operator — market identity’dan, requester.market_id bilan uzatiladi', async () => {
    const { controller, order, identity } = setup({
      'identity.user.find_by_id': { data: { id: '26', market_id: '501' } },
    });

    await controller.listExtraCostApprovals(
      'pending',
      req('26', ['market_operator']),
    );

    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      { id: '26' },
    );
    expect(listPayload(order)).toEqual({
      status: 'pending',
      auto_approved: undefined,
      requester: { id: '26', roles: ['market_operator'], market_id: '501' },
    });
  });

  it('operator marketga biriktirilmagan — 403, order-service chaqirilmaydi', async () => {
    const { controller, order } = setup({
      'identity.user.find_by_id': { data: { id: '26', market_id: null } },
    });

    await expect(
      controller.listExtraCostApprovals(
        undefined,
        req('26', ['market_operator']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(listPayload(order)).toBeUndefined();
  });

  it('market — o‘zgarishsiz: identity chaqirilmaydi, market_id qo‘shilmaydi', async () => {
    const { controller, order, identity } = setup();

    await controller.listExtraCostApprovals(
      undefined,
      req('501', ['market']),
      'true',
    );

    expect(identity.send).not.toHaveBeenCalled();
    expect(listPayload(order)).toEqual({
      status: undefined,
      auto_approved: true,
      requester: { id: '501', roles: ['market'] },
    });
  });
});
