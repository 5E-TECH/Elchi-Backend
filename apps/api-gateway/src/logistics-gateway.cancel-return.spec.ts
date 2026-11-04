import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { ReturnCanceledOrdersRequestDto } from './dto/logistics.swagger.dto';
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * HQ «Filialga qaytarish» — `POST /post/cancel/return/:id`. Rollar qabul
 * (`post/cancel/receive/:id`) bilan bir xil, doira logistics tomonida (faqat
 * HQ ga kelgan pochta), shuning uchun so'rovchining `branch_id`si uzatiladi.
 */
describe('LogisticsGatewayController — bekor pochtani filialga qaytarish', () => {
  const rolesOf = (method: keyof LogisticsGatewayController) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      LogisticsGatewayController.prototype,
      method,
    );
    return Reflect.getMetadata(ROLES_KEY, descriptor?.value) as string[];
  };

  it('rollar qabul bilan bir xil; kuryer, market va logist yo‘q', () => {
    const roles = rolesOf('returnCanceledOrdersToSender');

    expect(roles).toEqual(rolesOf('receiveCanceledPost'));
    expect(roles).toEqual(['manager', 'registrator', 'admin', 'superadmin']);
    expect(roles).not.toContain('courier');
    expect(roles).not.toContain('market');
    expect(roles).not.toContain('logist');
  });

  it('logistics.post.cancel.return ga id, dto va so‘rovchi doirasini uzatadi', async () => {
    const logisticsClient = {
      send: jest.fn(() =>
        of({ statusCode: 200, data: { post_closed: false } }),
      ),
    };
    const controller = new LogisticsGatewayController(
      logisticsClient as any,
      { send: jest.fn(() => of({ data: null })) } as any,
    );

    await controller.returnCanceledOrdersToSender(
      '77',
      { order_ids: ['102'] },
      { user: { sub: '5', roles: ['registrator'], branch_id: '1' } as any },
    );

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.post.cancel.return' },
      {
        id: '77',
        dto: { order_ids: ['102'] },
        requester: { id: '5', roles: ['registrator'], branch_id: '1' },
      },
    );
  });

  it.each([
    ['bo‘sh ro‘yxat', { order_ids: [] }],
    ['takror id', { order_ids: ['1', '1'] }],
    ['son emas', { order_ids: ['abc'] }],
    ['massiv emas', { order_ids: '1' }],
  ])('DTO: %s rad etiladi', async (_label, body) => {
    const errors = await validate(
      plainToInstance(ReturnCanceledOrdersRequestDto, body),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('DTO: JSON sonlar satrga keltiriladi', async () => {
    const dto = plainToInstance(ReturnCanceledOrdersRequestDto, {
      order_ids: [101, '102'],
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.order_ids).toEqual(['101', '102']);
  });
});

describe('LogisticsGatewayController — kuryer «buyurtma kelmagan» so‘rovi', () => {
  const rolesOf = (method: keyof LogisticsGatewayController) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      LogisticsGatewayController.prototype,
      method,
    );
    return Reflect.getMetadata(ROLES_KEY, descriptor?.value) as string[];
  };

  it('kuryer va filial menejeri (2026-11-04); registrator, admin — yo‘q', () => {
    const roles = rolesOf('requestCourierOrderReturn');
    expect(roles).toEqual(['courier', 'manager']);
    expect(roles).not.toContain('registrator');
    expect(roles).not.toContain('admin');
    expect(roles).not.toContain('superadmin');
  });

  it('logistics.post.return_request.create ga pochta, buyurtma va kuryerni uzatadi', async () => {
    const logisticsClient = {
      send: jest.fn(() => of({ statusCode: 200, data: {} })),
    };
    const controller = new LogisticsGatewayController(
      logisticsClient as any,
      { send: jest.fn(() => of({ data: null })) } as any,
    );

    await controller.requestCourierOrderReturn('98', '101', {
      user: { sub: 'c1', roles: ['courier'], branch_id: '10' } as any,
    });

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.post.return_request.create' },
      {
        post_id: '98',
        order_id: '101',
        requester: { id: 'c1', roles: ['courier'], branch_id: '10' },
      },
    );
  });

  it('menejer — o‘sha buyruq, JWT filiali bilan (doira logistics tomonida)', async () => {
    const logisticsClient = {
      send: jest.fn(() => of({ statusCode: 200, data: {} })),
    };
    const controller = new LogisticsGatewayController(
      logisticsClient as any,
      { send: jest.fn(() => of({ data: null })) } as any,
    );

    await controller.requestCourierOrderReturn('98', '101', {
      user: { sub: 'm1', roles: ['manager'], branch_id: '10' },
    });

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.post.return_request.create' },
      {
        post_id: '98',
        order_id: '101',
        requester: { id: 'm1', roles: ['manager'], branch_id: '10' },
      },
    );
  });
});
