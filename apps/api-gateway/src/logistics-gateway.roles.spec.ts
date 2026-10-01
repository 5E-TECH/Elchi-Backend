import 'reflect-metadata';
import { GatewayTimeoutException } from '@nestjs/common';
import { of, throwError, TimeoutError } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * C9 — PATCH /post/:id (logistics sendPost) REGISTRATOR uchun YOPIQ.
 *
 * sendPost na post holatini, na filialni tekshiradi: istalgan filial
 * registratori istalgan pochtani istalgan kuryerga berib, HQ buyurtmasini
 * filial kuryeriga tushirardi (settlement qatori branch_id NULL bilan filial
 * kuryerida paydo bo'lib, pul zanjiri buzilardi). Frontend bu endpointni
 * chaqirmaydi.
 */
describe('LogisticsGatewayController — PATCH post/:id rollari', () => {
  const rolesOf = (method: keyof LogisticsGatewayController) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      LogisticsGatewayController.prototype,
      method,
    );
    return Reflect.getMetadata(ROLES_KEY, descriptor?.value) as string[];
  };

  it('faqat superadmin va admin; registrator yo‘q', () => {
    const roles = rolesOf('sendPost');

    expect(roles).toEqual(['superadmin', 'admin']);
    expect(roles).not.toContain('registrator');
  });
});

/**
 * ITEM 8 — Pochta → Qaytarish menejer uchun ham ishlaydi (filial doirasida).
 * Ilgari uchala route faqat superadmin/admin/registrator edi va menejer tabni
 * ochishi bilan 403 olardi. Doira logistics tomonida, shuning uchun gateway
 * so'rovchining `branch_id`sini uzatishi SHART.
 */
describe('LogisticsGatewayController — Pochta → Qaytarish', () => {
  const rolesOf = (method: keyof LogisticsGatewayController) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      LogisticsGatewayController.prototype,
      method,
    );
    return Reflect.getMetadata(ROLES_KEY, descriptor?.value) as string[];
  };

  const managerReq = {
    user: { sub: '198', roles: ['manager'], branch_id: '15' },
  };

  const buildController = (options?: {
    returnRequestsResponse?: unknown;
    logisticsError?: unknown;
  }) => {
    const logisticsClient = {
      send: jest.fn((pattern: { cmd: string }, payload: { id?: string }) => {
        if (options?.logisticsError) {
          return throwError(() => options.logisticsError);
        }
        if (pattern.cmd === 'logistics.post.return_requests') {
          return of(options?.returnRequestsResponse ?? { data: {} });
        }
        if (pattern.cmd === 'logistics.district.find_by_id') {
          return of({
            data: {
              id: payload.id,
              name: `District ${payload.id}`,
              region: { id: '1', name: 'Toshkent' },
            },
          });
        }
        return of({ statusCode: 200, data: { ok: true } });
      }),
    };
    const identityClient = {
      send: jest.fn((pattern: { cmd: string }, payload: { id?: string }) => {
        if (pattern.cmd === 'identity.customer.find_by_id') {
          return of({
            data: { id: payload.id, name: `Customer ${payload.id}` },
          });
        }
        if (pattern.cmd === 'identity.market.find_by_id') {
          return of({ data: { id: payload.id, name: `Market ${payload.id}` } });
        }
        return of({ data: null });
      }),
    };
    const controller = new LogisticsGatewayController(
      logisticsClient as any,
      identityClient as any,
    );
    return { controller, logisticsClient, identityClient };
  };

  it.each([
    'getReturnRequests',
    'approveReturnRequests',
    'rejectReturnRequests',
  ] as const)(
    '%s: superadmin, admin, registrator va manager; kuryer yo‘q',
    (method) => {
      const roles = rolesOf(method);

      expect(roles).toEqual(['superadmin', 'admin', 'registrator', 'manager']);
      expect(roles).not.toContain('courier');
      expect(roles).not.toContain('market');
    },
  );

  it('list: so‘rovchi (branch_id bilan) uzatiladi va qatorlar mijoz/tuman/market bilan boyitiladi', async () => {
    const { controller, logisticsClient } = buildController({
      returnRequestsResponse: {
        statusCode: 200,
        message: "Qaytarish so'rovlari",
        data: {
          total: 3,
          scope: { type: 'BRANCH', branch_id: '15' },
          groups: [
            {
              courier: { id: '209', name: 'Ali' },
              courier_id: '209',
              orders: [
                {
                  id: '101',
                  customer_id: '5',
                  district_id: '3',
                  market_id: '7',
                },
                {
                  id: '102',
                  customer_id: '6',
                  district_id: '4',
                  market_id: '7',
                },
              ],
            },
            {
              courier: { id: '210', name: 'Vali' },
              courier_id: '210',
              orders: [
                {
                  id: '103',
                  customer_id: '8',
                  district_id: '3',
                  market_id: '9',
                },
              ],
            },
          ],
        },
      },
    });

    const result: any = await controller.getReturnRequests(managerReq);

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.post.return_requests' },
      { requester: { id: '198', roles: ['manager'], branch_id: '15' } },
    );
    expect(result.data.scope).toEqual({ type: 'BRANCH', branch_id: '15' });
    // Guruhlar o'z tartibi va o'z qatorlari bilan qaytadi.
    expect(result.data.groups.map((g: any) => g.courier_id)).toEqual([
      '209',
      '210',
    ]);
    expect(
      result.data.groups.map((g: any) => g.orders.map((o: any) => o.id)),
    ).toEqual([['101', '102'], ['103']]);

    const first = result.data.groups[0].orders[0];
    expect(first.customer).toEqual({ id: '5', name: 'Customer 5' });
    expect(first.district).toEqual(
      expect.objectContaining({ id: '3', name: 'District 3' }),
    );
    expect(first.market).toEqual({ id: '7', name: 'Market 7' });
    expect(result.data.groups[1].orders[0].customer).toEqual({
      id: '8',
      name: 'Customer 8',
    });
  });

  it('list: bo‘sh guruhlar — boyitish chaqirilmaydi, javob o‘zgarmaydi', async () => {
    const empty = {
      statusCode: 200,
      data: { total: 0, scope: { type: 'HQ', branch_id: '1' }, groups: [] },
    };
    const { controller, identityClient } = buildController({
      returnRequestsResponse: empty,
    });

    const result = await controller.getReturnRequests({
      user: { sub: '1', roles: ['superadmin'] },
    });

    expect(result).toEqual(empty);
    expect(identityClient.send).not.toHaveBeenCalled();
  });

  it('list: logistics javob bermasa 504', async () => {
    const { controller } = buildController({
      logisticsError: new TimeoutError(),
    });

    await expect(
      controller.getReturnRequests(managerReq),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it.each([
    ['approveReturnRequests', 'logistics.post.return_requests.approve'],
    ['rejectReturnRequests', 'logistics.post.return_requests.reject'],
  ] as const)(
    '%s: {dto, requester:{id, roles, branch_id}} uzatiladi',
    async (method, cmd) => {
      const { controller, logisticsClient } = buildController();
      const dto = { order_ids: ['101'] };

      await controller[method](dto, managerReq);

      expect(logisticsClient.send).toHaveBeenCalledWith(
        { cmd },
        {
          dto,
          requester: { id: '198', roles: ['manager'], branch_id: '15' },
        },
      );
    },
  );

  it('approve: JWT da branch_id bo‘lmasa null uzatiladi', async () => {
    const { controller, logisticsClient } = buildController();

    await controller.approveReturnRequests(
      { order_ids: ['101'] },
      { user: { sub: '5', roles: ['registrator'] } },
    );

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.post.return_requests.approve' },
      {
        dto: { order_ids: ['101'] },
        requester: { id: '5', roles: ['registrator'], branch_id: null },
      },
    );
  });
});
