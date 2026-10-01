import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { IntegrationServiceService } from './integration-service.service';

/**
 * fix3b (LC-13) — hamkor posilkasi `region_id` siz qolmaydi.
 *
 * `region_id` kontraktda ixtiyoriy edi va berilmasa NULL yozilardi. Filial
 * dispatch esa buyurtmaning `region_id` siga tayanadi — NULL da Postgres
 * 22P02 bilan yarim yo'lda yiqilardi. Endi:
 *   • raqamli `region_id` berilsa — o'sha (logistikaga so'rov yo'q);
 *   • yo'q yoki matn bo'lsa — tumandan (`logistics.district.find_by_id`:
 *     `assigned_region`, bo'lmasa tumanning `region_id` si);
 *   • tuman topilmasa / viloyatsiz — 400; logistika javob bermasa — 503.
 * Rad etilganda mijoz ham, buyurtma ham YARATILMAYDI.
 */

type Row = Record<string, any>;

function makeService(over: { logisticsSend?: jest.Mock | null } = {}) {
  const identitySend = jest.fn(() => of({ id: '77' }));
  const orderSend = jest.fn((pattern: { cmd: string }) =>
    pattern.cmd === 'order.find_by_qr'
      ? of(null)
      : of({ id: '900', status: 'new', qr_code_token: 'qr-abc' }),
  );
  const logisticsSend =
    over.logisticsSend === undefined
      ? jest.fn(() =>
          of({
            statusCode: 200,
            data: { id: '12', assigned_region: '7', region_id: '5' },
          }),
        )
      : over.logisticsSend;
  const svc = Object.create(IntegrationServiceService.prototype) as Row;
  svc.partnerShipmentRefRepo = {
    findOne: jest.fn(() => Promise.resolve(null)),
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: Row) => Promise.resolve({ id: '1', ...x })),
  };
  svc.partnerMarketRefRepo = {
    findOne: jest.fn().mockResolvedValue({ id: '1' }),
  };
  svc.identityClient = { send: identitySend };
  svc.orderClient = { send: orderSend };
  if (logisticsSend) {
    svc.logisticsClient = { send: logisticsSend };
  }
  const orderCreatePayload = (): Row | undefined =>
    (
      orderSend.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as { cmd: string }).cmd === 'order.create',
      ) as unknown[] | undefined
    )?.[1] as Row | undefined;
  return {
    svc: svc as unknown as IntegrationServiceService,
    identitySend,
    orderSend,
    logisticsSend,
    orderCreatePayload,
  };
}

const baseDto = {
  partner_id: '7',
  external_order_id: 'ord-9',
  elchi_market_id: '500',
  customer: { name: 'Ali', phone: '+998901234567' },
  district_id: '12',
  cod_amount: 0,
  subtotal: 200000,
};

async function rpcErrorOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
}

describe('fix3b — createPartnerShipment viloyati (LC-13)', () => {
  it('⭐ region_id berilmasa tumandan olinadi (assigned_region) va order.create ga ketadi', async () => {
    const h = makeService();

    await h.svc.createPartnerShipment({ ...baseDto });

    expect(h.logisticsSend).toHaveBeenCalledWith(
      { cmd: 'logistics.district.find_by_id' },
      { id: '12' },
    );
    expect(h.orderCreatePayload()?.dto).toMatchObject({
      region_id: '7',
      district_id: '12',
    });
  });

  it('assigned_region bo`lmasa tumanning o`z region_id si', async () => {
    const h = makeService({
      logisticsSend: jest.fn(() =>
        of({ data: { id: '12', assigned_region: null, region_id: '5' } }),
      ),
    });

    await h.svc.createPartnerShipment({ ...baseDto });

    expect(h.orderCreatePayload()?.dto.region_id).toBe('5');
  });

  it('raqamli region_id berilsa — o`sha, logistikaga so`rov YO`Q', async () => {
    const h = makeService();

    await h.svc.createPartnerShipment({ ...baseDto, region_id: '3' });

    expect(h.logisticsSend).not.toHaveBeenCalled();
    expect(h.orderCreatePayload()?.dto.region_id).toBe('3');
  });

  it('matn region_id ("Toshkent") — xom yozilmaydi, tumandan olinadi', async () => {
    const h = makeService();

    await h.svc.createPartnerShipment({ ...baseDto, region_id: 'Toshkent' });

    expect(h.orderCreatePayload()?.dto.region_id).toBe('7');
  });

  it('⭐ tuman topilmasa (404) — 400, mijoz ham buyurtma ham YARATILMAYDI', async () => {
    const h = makeService({
      logisticsSend: jest.fn(() =>
        throwError(() => ({ statusCode: 404, message: 'District not found' })),
      ),
    });

    const err = await rpcErrorOf(h.svc.createPartnerShipment({ ...baseDto }));

    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('region_id aniqlanmadi');
    expect(h.identitySend).not.toHaveBeenCalled();
    expect(h.orderCreatePayload()).toBeUndefined();
  });

  it('tumanda viloyat yo`q — 400', async () => {
    const h = makeService({
      logisticsSend: jest.fn(() => of({ data: { id: '12' } })),
    });

    const err = await rpcErrorOf(h.svc.createPartnerShipment({ ...baseDto }));

    expect(err.statusCode).toBe(400);
    expect(h.orderCreatePayload()).toBeUndefined();
  });

  it('⭐ logistika javob bermasa (5xx / transport) — 503 (hamkor qayta uradi), hech narsa yaratilmaydi', async () => {
    const h = makeService({
      logisticsSend: jest.fn(() =>
        throwError(() => new Error('Connection closed')),
      ),
    });

    const err = await rpcErrorOf(h.svc.createPartnerShipment({ ...baseDto }));

    expect(err.statusCode).toBe(503);
    expect(h.identitySend).not.toHaveBeenCalled();
    expect(h.orderCreatePayload()).toBeUndefined();
  });

  it('logistika klienti umuman yo`q — 503 (NULL yozilmaydi)', async () => {
    const h = makeService({ logisticsSend: null });

    const err = await rpcErrorOf(h.svc.createPartnerShipment({ ...baseDto }));

    expect(err.statusCode).toBe(503);
    expect(h.orderCreatePayload()).toBeUndefined();
  });

  it('idempotent takror (mavjud ref) — viloyat so`ralmaydi', async () => {
    const h = makeService();
    const svc = h.svc as unknown as Row;
    svc.partnerShipmentRefRepo.findOne = jest
      .fn()
      .mockResolvedValue({ order_id: '900' });
    svc.orderClient = {
      send: jest.fn(() => of({ data: { id: '900', qr_code_token: 'qr-abc' } })),
    };

    await h.svc.createPartnerShipment({ ...baseDto });

    expect(h.logisticsSend).not.toHaveBeenCalled();
  });

  it('prepaid summa avvalgidek uzatiladi (order-service endi uni saqlaydi)', async () => {
    const h = makeService();

    await h.svc.createPartnerShipment({ ...baseDto });

    expect(h.orderCreatePayload()?.dto).toMatchObject({
      total_price: 200000,
      to_be_paid: 0,
      paid_online_amount: 200000,
    });
    expect(h.orderCreatePayload()?.requester).toEqual({
      id: 'partner:7',
      roles: ['superadmin'],
    });
  });
});
