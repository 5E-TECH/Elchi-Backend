import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { IntegrationServiceService } from './integration-service.service';

/** createPartnerShipment (C2.1) — prototip orqali (og'ir konstruktorsiz). */
function makeService(
  over: {
    refFindOne?: jest.Mock;
    identitySend?: jest.Mock;
    orderSend?: jest.Mock;
    saved?: any[];
  } = {},
) {
  const saved = over.saved ?? [];
  const ref: any = {
    findOne: over.refFindOne ?? jest.fn(() => Promise.resolve(null)),
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: any) => {
      saved.push(x);
      return Promise.resolve({ id: '1', ...x });
    }),
  };
  const identitySend = over.identitySend ?? jest.fn(() => of({ id: '77' }));
  const orderSend =
    over.orderSend ??
    jest.fn(() => of({ id: '900', status: 'new', qr_code_token: 'qr-abc' }));
  const svc = Object.create(IntegrationServiceService.prototype);
  svc.partnerShipmentRefRepo = ref;
  svc.identityClient = { send: identitySend };
  svc.orderClient = { send: orderSend };
  return {
    svc: svc as IntegrationServiceService,
    ref,
    identitySend,
    orderSend,
    saved,
  };
}

const baseDto = {
  partner_id: '7',
  external_order_id: 'ord-9',
  elchi_market_id: '500',
  customer: { name: 'Ali', phone: '+998901234567' },
  district_id: '10',
  region_id: '1',
};

describe('IntegrationServiceService.createPartnerShipment (C2.1)', () => {
  it('TC1: shipment -> order.create + ref saqlanadi + shipment_id qaytadi', async () => {
    const { svc, identitySend, orderSend, saved } = makeService();

    const res: any = await svc.createPartnerShipment({
      ...baseDto,
      cod_amount: 0,
      subtotal: 30000,
    });

    expect(res.statusCode).toBe(201);
    expect(res.data.shipment_id).toBe('900');
    expect(res.data.order_status).toBe('new');
    expect(res.data.qr_code_token).toBe('qr-abc');
    // customer avval yaratiladi
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.customer.create' },
      {
        dto: { name: 'Ali', phone_number: '+998901234567', district_id: '10' },
      },
    );
    // order.create source=external + external_id + total_price
    expect(orderSend).toHaveBeenCalledWith(
      { cmd: 'order.create' },
      expect.objectContaining({
        dto: expect.objectContaining({
          market_id: '500',
          customer_id: '77',
          source: 'external',
          external_id: 'ord-9',
          total_price: 30000,
        }),
        // Idempotency key is partner-scoped so two partners can reuse the same
        // external_order_id without colliding on order.create.
        request_id: 'partner:7:ord-9',
      }),
    );
    // ref (partner_id, external_order_id, order_id)
    expect(saved[0]).toEqual({
      partner_id: '7',
      external_order_id: 'ord-9',
      order_id: '900',
    });
  });

  it('C2.5 TC1: external item name+qty bilan product_id=null saqlashga uzatiladi', async () => {
    const { svc, orderSend } = makeService();

    await svc.createPartnerShipment({
      ...baseDto,
      cod_amount: 0,
      items: [{ name: 'Telefon g‘ilofi', quantity: 2 }],
    });

    expect(orderSend).toHaveBeenCalledWith(
      { cmd: 'order.create' },
      expect.objectContaining({
        dto: expect.objectContaining({
          items: [
            {
              product_id: null,
              product_name: 'Telefon g‘ilofi',
              quantity: 2,
            },
          ],
        }),
      }),
    );
  });

  it('TC2: cod_amount=0 -> to_be_paid=0 (prepaid)', async () => {
    const { svc, orderSend } = makeService();
    await svc.createPartnerShipment({ ...baseDto, cod_amount: 0 });
    expect(orderSend).toHaveBeenCalledWith(
      { cmd: 'order.create' },
      expect.objectContaining({
        dto: expect.objectContaining({ to_be_paid: 0 }),
      }),
    );
  });

  it('TC3: cod_amount=50000 -> to_be_paid=50000 (COD)', async () => {
    const { svc, orderSend } = makeService();
    await svc.createPartnerShipment({ ...baseDto, cod_amount: 50000 });
    expect(orderSend).toHaveBeenCalledWith(
      { cmd: 'order.create' },
      expect.objectContaining({
        dto: expect.objectContaining({ to_be_paid: 50000 }),
      }),
    );
  });

  it('TC4: idempotent — mavjud ref bo‘lsa yangi order YARATILMAYDI', async () => {
    const { svc, identitySend, orderSend } = makeService({
      refFindOne: jest.fn(() => Promise.resolve({ order_id: '900' })),
    });

    const res: any = await svc.createPartnerShipment({
      ...baseDto,
      cod_amount: 0,
    });

    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({ shipment_id: '900', idempotent: true });
    expect(identitySend).not.toHaveBeenCalled();
    expect(orderSend).not.toHaveBeenCalled();
  });

  it('external_order_id yo‘q -> 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.createPartnerShipment({
        ...baseDto,
        external_order_id: '',
        cod_amount: 0,
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });
});
