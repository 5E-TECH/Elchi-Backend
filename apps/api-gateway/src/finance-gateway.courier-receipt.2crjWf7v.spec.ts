import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { of, throwError } from 'rxjs';
import { FinanceGatewayController } from './finance-gateway.controller';
import { NotificationGatewayController } from './notification-gateway.controller';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { CourierPaymentAckRequestDto } from './dto/finance.swagger.dto';

/**
 * 2crjWf7v — kuryer moliyada faqat O'QUVCHI; kvitansiyaga javob — faqat audit.
 *  - `POST /finance/cashbox/payment/courier` kuryer akkaunti bilan → 403
 *    (rol o'zgarmagan);
 *  - `POST /finance/cashbox/payment/courier/:id/ack` — faqat COURIER,
 *    `courier_id` JWT'dan (body'dan emas), "disputed" — filial boshlig'i
 *    gateway'da aniqlanadi;
 *  - TgYRqaTk #2: `POST /notifications/send` — deprecated.
 */
/** Handler funksiyasi (metadata kaliti) — `this` siz, faqat Reflect uchun. */
const handlerOf = (target: object, name: string) =>
  Reflect.get(target, name) as (...args: never[]) => unknown;

const guardAllows = (
  handler: (...args: never[]) => unknown,
  roles: string[],
): boolean => {
  const context = {
    getHandler: () => handler,
    getClass: () => FinanceGatewayController,
    switchToHttp: () => ({
      getRequest: () => ({ user: { sub: '44', username: 'c', roles } }),
    }),
  };
  return new RolesGuard(new Reflector()).canActivate(context as never);
};

const setup = () => {
  const finance = {
    send: jest.fn(() => of({ statusCode: 201, data: { already: false } })),
  };
  const identity = { send: jest.fn() };
  const branch = {
    send: jest.fn((pattern: { cmd: string }) => {
      if (pattern.cmd === 'branch.user.find_by_user') {
        return of({ data: { branch_id: '12', role: 'COURIER' } });
      }
      if (pattern.cmd === 'branch.find_by_id') {
        return of({ data: { id: '12', manager_id: '88' } });
      }
      return throwError(() => new Error(`kutilmagan ${pattern.cmd}`));
    }),
  };
  const controller = new FinanceGatewayController(
    finance as never,
    identity as never,
    branch as never,
    { send: jest.fn() } as never,
  );
  return { controller, finance, branch };
};
const courierReq = {
  user: { sub: '44', username: 'courier', roles: ['courier'] },
};

describe('2crjWf7v — kuryer: faqat o‘quvchi', () => {
  it('⭐ kuryer akkaunti bilan POST /finance/cashbox/payment/courier → 403 (RolesGuard rad)', () => {
    const handler = handlerOf(
      FinanceGatewayController.prototype,
      'paymentFromCourier',
    );
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[];
    expect(roles).not.toContain('courier');
    expect(roles).toEqual(
      expect.arrayContaining(['superadmin', 'admin', 'manager']),
    );
    expect(guardAllows(handler, ['courier'])).toBe(false);
    expect(guardAllows(handler, ['manager'])).toBe(true);
  });

  it('ack endpointi — FAQAT kuryer', () => {
    const handler = handlerOf(
      FinanceGatewayController.prototype,
      'courierPaymentAck',
    );
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['courier']);
    expect(guardAllows(handler, ['courier'])).toBe(true);
    expect(guardAllows(handler, ['manager'])).toBe(false);
  });
});

describe('2crjWf7v — POST /finance/cashbox/payment/courier/:id/ack', () => {
  it('⭐ confirmed — courier_id JWT’dan, filial so‘ralmaydi, finance RPC: courier_payment_ack', async () => {
    const { controller, finance, branch } = setup();
    await controller.courierPaymentAck(courierReq as never, '701', {
      ack: 'confirmed',
    });
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.courier_payment_ack' },
      {
        payment_id: '701',
        courier_id: '44',
        ack: 'confirmed',
        notify_user_ids: [],
      },
    );
    expect(branch.send).not.toHaveBeenCalled();
  });

  it('⭐ disputed — kuryer filialining boshlig‘i (manager_id) bildirishnoma qabul qiluvchisi', async () => {
    const { controller, finance, branch } = setup();
    await controller.courierPaymentAck(courierReq as never, '701', {
      ack: 'disputed',
      comment: 'Summa kam',
    });
    expect(branch.send).toHaveBeenCalledWith(
      { cmd: 'branch.find_by_id' },
      expect.objectContaining({
        id: '12',
        requester: expect.objectContaining({ id: '44' }),
      }),
    );
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.courier_payment_ack' },
      expect.objectContaining({
        ack: 'disputed',
        comment: 'Summa kam',
        notify_user_ids: ['88'],
      }),
    );
  });

  it('filial xizmati javob bermasa — e’tiroz baribir yoziladi (boshliqsiz)', async () => {
    const { controller, finance, branch } = setup();
    branch.send.mockImplementation(() => throwError(() => new Error('down')));
    await controller.courierPaymentAck(courierReq as never, '701', {
      ack: 'disputed',
    });
    expect(finance.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ notify_user_ids: [] }),
    );
  });

  it('noto‘g‘ri id — 400; DTO: ack faqat confirmed|disputed, izoh ≤500', async () => {
    const { controller } = setup();
    await expect(
      controller.courierPaymentAck(courierReq as never, '7x', {
        ack: 'confirmed',
      }),
    ).rejects.toThrow("To'lov id si noto'g'ri");
    const errors = async (body: object) =>
      (await validate(plainToInstance(CourierPaymentAckRequestDto, body))).map(
        (e) => e.property,
      );
    expect(await errors({ ack: 'confirmed' })).toEqual([]);
    expect(await errors({ ack: 'paid' })).toEqual(['ack']);
    expect(await errors({ ack: 'disputed', comment: 'x'.repeat(501) })).toEqual(
      ['comment'],
    );
  });
});

describe('TgYRqaTk #2 — POST /notifications/send eskirgan (deprecated)', () => {
  it('Swagger operatsiyasi deprecated: true', () => {
    const operation = Reflect.getMetadata(
      // @nestjs/swagger DECORATORS.API_OPERATION
      'swagger/apiOperation',
      handlerOf(NotificationGatewayController.prototype, 'sendNotification'),
    ) as { deprecated?: boolean; summary?: string };
    expect(operation.deprecated).toBe(true);
    expect(operation.summary).toContain('notification.dispatch');
  });
});
