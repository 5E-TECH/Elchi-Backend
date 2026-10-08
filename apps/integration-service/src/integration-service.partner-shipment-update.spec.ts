/**
 * PARTNER POSILKASINI YANGILASH + TELEFON NORMALLASHTIRISH.
 *
 *   Fnu6PRya — Partner API'da yangilash yo'li yo'q edi: idempotent POST
 *              birinchi narx/manzilni abadiy muzlatardi, javob esa farqni
 *              aytmasdi. Endi `PATCH /partner/shipments/:id` va idempotent
 *              javobda `mismatched_fields`.
 *   zfPNDCCr — telefon xom satr sifatida saqlanardi: bitta odam formatiga
 *              qarab bir nechta mijozga bo'linardi, "not-a-phone" ham
 *              o'tardi.
 */
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { IntegrationServiceService } from './integration-service.service';

type Row = Record<string, unknown>;

async function rpcError(
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; message?: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as { statusCode?: number; message?: string };
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

function makeService(order: Row) {
  const orderSend = jest.fn((pattern: { cmd: string }) => {
    if (pattern.cmd === 'order.find_by_id') return of({ data: order });
    if (pattern.cmd === 'order.update_full') return of({ data: order });
    if (pattern.cmd === 'order.create') {
      return of({ id: '900', status: 'new', qr_code_token: 'qr-abc' });
    }
    return of(null);
  });
  const identitySend = jest.fn(() => of({ id: '77' }));
  const svc = Object.create(IntegrationServiceService.prototype) as Record<
    string,
    any
  >;
  svc.partnerShipmentRefRepo = {
    findOne: jest.fn().mockResolvedValue({
      partner_id: '7',
      order_id: '1251133',
      external_order_id: 'ord-9',
    }),
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
  };
  svc.partnerMarketRefRepo = {
    findOne: jest.fn().mockResolvedValue({ id: '1' }),
  };
  svc.orderClient = { send: orderSend };
  svc.identityClient = { send: identitySend };
  svc.logisticsClient = {
    send: jest.fn(() => of({ data: { id: '12', assigned_region: '3' } })),
  };
  const updateCall = () =>
    orderSend.mock.calls.find(
      ([pattern]) => pattern.cmd === 'order.update_full',
    )?.[1] as { dto: Row } | undefined;
  return {
    svc: svc as unknown as IntegrationServiceService,
    orderSend,
    identitySend,
    updateCall,
  };
}

const NEW_ORDER = {
  id: '1251133',
  status: 'new',
  total_price: 200000,
  paid_online_amount: 0,
  to_be_paid: 200000,
  market_id: '500',
  district_id: '10',
  qr_code_token: 'qr-abc',
};

describe('Fnu6PRya — PATCH /partner/shipments/:id', () => {
  it('⭐ NEW posilka: narx yaratishdagi qoida bilan yoziladi', async () => {
    const { svc, updateCall } = makeService(NEW_ORDER);

    const res: any = await svc.updatePartnerShipment({
      partner_id: '7',
      shipment_id: '1251133',
      cod_amount: 777777,
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.updated_fields).toEqual(['cod_amount', 'subtotal']);
    // Prepaid qismsiz posilka — qiymat COD bilan birga o'zgaradi.
    expect(updateCall()?.dto).toEqual({
      total_price: 777777,
      to_be_paid: 777777,
      paid_online_amount: 0,
    });
  });

  it('prepaid qismli posilka: faqat COD o`zgarsa total saqlanadi', async () => {
    const { svc, updateCall } = makeService({
      ...NEW_ORDER,
      total_price: 300000,
      paid_online_amount: 100000,
      to_be_paid: 200000,
    });

    await svc.updatePartnerShipment({
      partner_id: '7',
      shipment_id: '1251133',
      cod_amount: 150000,
    });

    expect(updateCall()?.dto).toEqual({
      total_price: 300000,
      to_be_paid: 150000,
      paid_online_amount: 150000,
    });
  });

  it('cod_amount > subtotal — 400', async () => {
    const { svc, updateCall } = makeService(NEW_ORDER);

    const error = await rpcError(
      svc.updatePartnerShipment({
        partner_id: '7',
        shipment_id: '1251133',
        cod_amount: 300000,
        subtotal: 200000,
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(updateCall()).toBeUndefined();
  });

  it.each([['received'], ['waiting'], ['on the road']])(
    '⭐ %s: narx o`zgarishi — 409 (qabul qilingan posilka)',
    async (status) => {
      const { svc, updateCall } = makeService({ ...NEW_ORDER, status });

      const error = await rpcError(
        svc.updatePartnerShipment({
          partner_id: '7',
          shipment_id: '1251133',
          cod_amount: 1000,
        }),
      );

      expect(error.statusCode).toBe(409);
      expect(updateCall()).toBeUndefined();
    },
  );

  it('qabul qilingan posilkada manzil o`zgarishi o`tadi', async () => {
    const { svc, updateCall } = makeService({
      ...NEW_ORDER,
      status: 'waiting',
    });

    await svc.updatePartnerShipment({
      partner_id: '7',
      shipment_id: '1251133',
      address: "Yangi ko'cha 5",
      district_id: '12',
    });

    expect(updateCall()?.dto).toEqual({
      address: "Yangi ko'cha 5",
      district_id: '12',
      region_id: '3',
    });
  });

  it.each([['sold'], ['cancelled'], ['paid'], ['returned_to_market']])(
    'yakuniy holat (%s) — 409',
    async (status) => {
      const { svc } = makeService({ ...NEW_ORDER, status });

      const error = await rpcError(
        svc.updatePartnerShipment({
          partner_id: '7',
          shipment_id: '1251133',
          comment: 'x',
        }),
      );

      expect(error.statusCode).toBe(409);
    },
  );

  it('hech qanday maydon yo`q — 400', async () => {
    const { svc } = makeService(NEW_ORDER);

    const error = await rpcError(
      svc.updatePartnerShipment({ partner_id: '7', shipment_id: '1251133' }),
    );

    expect(error.statusCode).toBe(400);
  });
});

describe('Fnu6PRya — idempotent POST farqni aytadi', () => {
  it('⭐ boshqa narx bilan takror — mismatched_fields + Elchi`dagi narx', async () => {
    const { svc } = makeService(NEW_ORDER);

    const res: any = await svc.createPartnerShipment({
      partner_id: '7',
      external_order_id: 'ord-9',
      elchi_market_id: '500',
      customer: { name: 'Ali', phone: '+998901234567' },
      district_id: '10',
      cod_amount: 777777,
    });

    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({
      idempotent: true,
      qr_code_token: 'qr-abc',
      order_status: 'new',
      cod_amount: 200000,
      total_price: 200000,
      mismatched_fields: ['cod_amount', 'subtotal'],
    });
    expect(res.message).toContain('PATCH');
  });

  it('ayni narx bilan takror — mismatched_fields bo`sh', async () => {
    const { svc } = makeService(NEW_ORDER);

    const res: any = await svc.createPartnerShipment({
      partner_id: '7',
      external_order_id: 'ord-9',
      elchi_market_id: '500',
      customer: { name: 'Ali', phone: '+998901234567' },
      district_id: '10',
      cod_amount: 200000,
    });

    expect(res.data.mismatched_fields).toEqual([]);
    expect(res.message).toBe('shipment already exists');
  });
});

describe('zfPNDCCr — telefon kanonik shaklda', () => {
  const create = (phone: string) => {
    const harness = makeService(NEW_ORDER);
    (
      harness.svc as unknown as {
        partnerShipmentRefRepo: { findOne: jest.Mock };
      }
    ).partnerShipmentRefRepo.findOne.mockResolvedValue(null);
    const promise = harness.svc.createPartnerShipment({
      partner_id: '7',
      external_order_id: 'ord-new',
      elchi_market_id: '500',
      customer: { name: 'Ali', phone },
      district_id: '10',
      region_id: '3',
      cod_amount: 100000,
    });
    return { ...harness, promise };
  };

  it.each([['998900000001'], ['900000001'], ['+998 90 000 00 01']])(
    '⭐ %p -> +998900000001 (bitta mijoz)',
    async (phone) => {
      const { promise, identitySend } = create(phone);
      await promise;

      expect(identitySend).toHaveBeenCalledWith(
        { cmd: 'identity.customer.create' },
        expect.objectContaining({
          dto: expect.objectContaining({ phone_number: '+998900000001' }),
        }),
      );
    },
  );

  it.each([['not-a-phone'], ['12345'], ['+1 202 555 0100']])(
    '%p — 400, mijoz yaratilmaydi',
    async (phone) => {
      const { promise, identitySend } = create(phone);

      const error = await rpcError(promise);

      expect(error.statusCode).toBe(400);
      expect(identitySend).not.toHaveBeenCalled();
    },
  );
});

/**
 * M4ViM9jz — hamkor solishtiruvchisi 100 tagacha posilkani BITTA so'rovda
 * oladi (ilgari har biri alohida GET; parallel qilinsa limitga urilardi).
 */
describe('M4ViM9jz — ko`p posilka holati bitta so`rovda', () => {
  it('⭐ items GET shaklida, topilmagani not_found, tartib saqlanadi', async () => {
    const { svc } = makeService(NEW_ORDER);
    const refRepo = (svc as unknown as Record<string, any>)
      .partnerShipmentRefRepo;
    refRepo.findOne.mockImplementation(({ where }: { where: Row }) =>
      Promise.resolve(
        where.order_id === '1251133' || where.external_order_id === 'ord-9'
          ? { partner_id: '7', order_id: '1251133', external_order_id: 'ord-9' }
          : null,
      ),
    );

    const res: any = await svc.getPartnerShipmentsBulk({
      partner_id: '7',
      shipment_ids: ['ord-9', 'missing-1', '1251133', 'ord-9'],
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.items).toHaveLength(2);
    expect(res.data.items[0]).toMatchObject({
      shipment_id: '1251133',
      external_order_id: 'ord-9',
      status: 'new',
      cod_amount: 200000,
    });
    expect(res.data.not_found).toEqual(['missing-1']);
    expect(res.data.failed).toEqual([]);
  });

  it('100 tadan ko`p yoki bo`sh ro`yxat — 400', async () => {
    const { svc } = makeService(NEW_ORDER);

    expect(
      (
        await rpcError(
          svc.getPartnerShipmentsBulk({ partner_id: '7', shipment_ids: [] }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await rpcError(
          svc.getPartnerShipmentsBulk({
            partner_id: '7',
            shipment_ids: Array.from({ length: 101 }, (_, i) => `id-${i}`),
          }),
        )
      ).statusCode,
    ).toBe(400);
  });
});
