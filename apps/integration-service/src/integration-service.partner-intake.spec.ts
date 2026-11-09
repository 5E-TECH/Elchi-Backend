import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { ORDER_INTAKE_CLOSED } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

/**
 * BUGUNGI QABUL VAQTI (ega 2026-11-09) — hamkor API (`POST /partner/shipments`):
 *  • order-service 409 `ORDER_INTAKE_CLOSED` — hamkorga INGLIZCHA 409
 *    (`reopens_at`, `cutoff_time`); avval `rmqRequest` uni yutib 502 berardi;
 *  • bog'lanish (ref) yozilmaydi — `reopens_at` dan keyin ayni
 *    `external_order_id` yangi buyurtma yaratadi;
 *  • takroriy so'rov (shipment allaqachon bor) — order-service'ga bormaydi;
 *  • boshqa xato — avvalgidek 502.
 */

const CLOSED_ERROR = {
  statusCode: 409,
  message: 'Bugungi buyurtma qabuli yopilgan (10:00 gacha edi)',
  code: ORDER_INTAKE_CLOSED,
  reopens_at: '2026-11-09T19:00:00.000Z',
  cutoff_time: '10:00',
};

function makeService(
  orderCreate: 'closed' | 'ok' | 'broken',
  existing = false,
) {
  const ref = {
    findOne: jest.fn(() =>
      Promise.resolve(existing ? { order_id: '900' } : null),
    ),
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: Record<string, unknown>) =>
      Promise.resolve({ id: '1', ...x }),
    ),
  };
  const orderSend = jest.fn(() => {
    if (orderCreate === 'closed') return throwError(() => CLOSED_ERROR);
    if (orderCreate === 'broken') return throwError(() => new Error('down'));
    return of({ id: '900', status: 'new', qr_code_token: 'qr-abc' });
  });
  const svc = Object.create(
    IntegrationServiceService.prototype,
  ) as IntegrationServiceService & Record<string, unknown>;
  svc.partnerShipmentRefRepo = ref;
  svc.partnerMarketRefRepo = {
    findOne: jest.fn().mockResolvedValue({ id: '1' }),
  };
  svc.identityClient = { send: jest.fn(() => of({ id: '77' })) };
  svc.orderClient = { send: orderSend };
  return { svc, ref, orderSend };
}

const dto = {
  partner_id: '7',
  external_order_id: 'ord-9',
  elchi_market_id: '500',
  customer: { name: 'Ali', phone: '+998901234567' },
  district_id: '10',
  region_id: '1',
  cod_amount: 0,
  subtotal: 30000,
};

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as Record<string, unknown>;
  }
  throw new Error('xato kutilgan edi');
};

describe('createPartnerShipment — bugungi qabul vaqti', () => {
  it('yopiq — inglizcha 409 ORDER_INTAKE_CLOSED, bog`lanish yozilmaydi', async () => {
    const { svc, ref } = makeService('closed');
    const body = await errorOf(svc.createPartnerShipment(dto));
    expect(body).toMatchObject({
      statusCode: 409,
      code: ORDER_INTAKE_CLOSED,
      reopens_at: CLOSED_ERROR.reopens_at,
      cutoff_time: '10:00',
    });
    expect(String(body.message)).toContain('Order intake is closed for today');
    expect(String(body.message)).toContain(CLOSED_ERROR.reopens_at);
    expect(ref.save).not.toHaveBeenCalled();
  });

  it('takroriy so`rov — mavjud shipment qaytadi, order.create chaqirilmaydi', async () => {
    const { svc, orderSend } = makeService('closed', true);
    const res = (await svc.createPartnerShipment(dto)) as {
      data: { shipment_id: string };
    };
    expect(res.data.shipment_id).toBe('900');
    // Faqat mavjud buyurtmani o'qish (`order.find_by_id`), yaratish yo'q.
    expect(
      orderSend.mock.calls.map((c: unknown[]) => (c[0] as { cmd: string }).cmd),
    ).not.toContain('order.create');
  });

  it('ochiq — avvalgidek 201', async () => {
    const { svc, orderSend } = makeService('ok');
    const res = (await svc.createPartnerShipment(dto)) as {
      statusCode: number;
    };
    expect(res.statusCode).toBe(201);
    expect(orderSend).toHaveBeenCalledTimes(1);
  });

  it('boshqa xato — avvalgidek 502', async () => {
    const { svc } = makeService('broken');
    const body = await errorOf(svc.createPartnerShipment(dto));
    expect(body.statusCode).toBe(502);
    expect(body).not.toHaveProperty('code');
  });
});
