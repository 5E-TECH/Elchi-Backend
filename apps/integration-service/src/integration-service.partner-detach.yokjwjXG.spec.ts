import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { IntegrationServiceService } from './integration-service.service';

/**
 * yokjwjXG — superadmin hamkor (BeePost) buyurtmasini pochtadan o'chirdi.
 * order-service outbox'i → `integration.partner.shipment.detach`:
 *   1. hamkorga `status: 'cancelled'` webhooki (mavjud enqueuePartnerWebhook);
 *   2. `partner_shipment_refs` bog'lanishi yopiladi;
 *   3. hamkor AYNI external_order_id bilan qayta yaratsa YANGI buyurtma
 *      ochiladi — eski o'chirilgan id "dublikat" sifatida QAYTMAYDI
 *      (na ref'dan, na order.create idempotency keshidan).
 */

interface RefRow {
  id: string;
  partner_id: string;
  external_order_id: string;
  order_id: string;
  isDeleted: boolean;
}

/** Xotiradagi `partner_shipment_refs` — partial unique (faqat faol qatorlar). */
function makeRefRepo(rows: RefRow[]) {
  let seq = Math.max(0, ...rows.map((r) => Number(r.id))) + 1;
  const matches = (row: RefRow, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([key, value]) => String((row as any)[key]) === String(value),
    );
  return {
    rows,
    findOne: jest.fn(
      (opts: {
        where: Record<string, unknown>;
        order?: { id?: 'ASC' | 'DESC' };
      }) => {
        const hits = rows.filter((row) => matches(row, opts.where));
        if (opts.order?.id === 'DESC') {
          hits.sort((a, b) => Number(b.id) - Number(a.id));
        }
        return Promise.resolve(hits[0] ? { ...hits[0] } : null);
      },
    ),
    create: jest.fn((x: Partial<RefRow>) => x),
    save: jest.fn((x: Partial<RefRow>) => {
      const clash = rows.some(
        (row) =>
          !row.isDeleted &&
          row.partner_id === x.partner_id &&
          row.external_order_id === x.external_order_id,
      );
      if (clash) {
        return Promise.reject(
          Object.assign(new Error('duplicate key'), { code: '23505' }),
        );
      }
      const saved = { id: String(seq++), isDeleted: false, ...x } as RefRow;
      rows.push(saved);
      return Promise.resolve(saved);
    }),
    update: jest.fn(
      (criteria: Record<string, unknown>, patch: Partial<RefRow>) => {
        const hits = rows.filter((row) => matches(row, criteria));
        hits.forEach((row) => Object.assign(row, patch));
        return Promise.resolve({ affected: hits.length });
      },
    ),
  };
}

function makeSvc(refs: RefRow[]) {
  const svc: any = Object.create(IntegrationServiceService.prototype);
  const refRepo = makeRefRepo(refs);
  const webhookRows: any[] = [];
  const calls: string[] = [];
  svc.partnerShipmentRefRepo = refRepo;
  refRepo.update.mockImplementation(((
    criteria: Record<string, unknown>,
    patch: Partial<RefRow>,
  ) => {
    calls.push('ref.update');
    const hits = refRepo.rows.filter((row) =>
      Object.entries(criteria).every(
        ([key, value]) => String((row as any)[key]) === String(value),
      ),
    );
    hits.forEach((row) => Object.assign(row, patch));
    return Promise.resolve({ affected: hits.length });
  }) as any);
  svc.partnerWebhookOutboxRepo = {
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: any) => {
      calls.push('webhook.save');
      webhookRows.push(x);
      return Promise.resolve({ id: String(webhookRows.length), ...x });
    }),
  };
  svc.processPendingPartnerWebhooks = jest.fn(() => Promise.resolve());
  svc.activityLog = { log: jest.fn(() => Promise.resolve()) };
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  svc.partnerMarketRefRepo = {
    findOne: jest.fn().mockResolvedValue({ id: '1' }),
  };
  svc.identityClient = { send: jest.fn(() => of({ id: '77' })) };
  let nextOrder = 950;
  svc.orderClient = {
    send: jest.fn(() =>
      of({ id: String(nextOrder++), status: 'new', qr_code_token: 'qr' }),
    ),
  };
  return {
    svc: svc as IntegrationServiceService,
    refRepo,
    webhookRows,
    calls,
    orderSend: svc.orderClient.send as jest.Mock,
    activityLog: svc.activityLog.log as jest.Mock,
  };
}

const ACTIVE: RefRow = {
  id: '31',
  partner_id: '7',
  external_order_id: 'BP-555',
  order_id: '900',
  isDeleted: false,
};

const detachDto = {
  order_id: '900',
  external_order_id: 'BP-555',
  old_status: 'received',
  reason: 'Market posilkani qaytarib oldi',
  post_id: '88',
  total_price: 120000,
  extra_cost: 0,
};

const shipmentDto = {
  partner_id: '7',
  external_order_id: 'BP-555',
  elchi_market_id: '500',
  customer: { name: 'Ali', phone: '+998901234567' },
  district_id: '10',
  region_id: '1',
  cod_amount: 0,
  subtotal: 30000,
};

describe('yokjwjXG — integration.partner.shipment.detach', () => {
  it("⭐ hamkorga 'cancelled' webhooki navbatga qo'yiladi, KEYIN ref yopiladi", async () => {
    const h = makeSvc([{ ...ACTIVE }]);

    const res: any = await h.svc.detachDeletedPartnerShipment(detachDto);

    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({
      ref_id: '31',
      partner_id: '7',
      external_order_id: 'BP-555',
    });
    expect(h.calls).toEqual(['webhook.save', 'ref.update']);
    expect(h.webhookRows).toHaveLength(1);
    expect(h.webhookRows[0]).toMatchObject({
      partner_id: '7',
      order_id: '900',
      external_order_id: 'BP-555',
      event_type: 'shipment.status_changed',
      new_status: 'cancelled',
      status: 'pending',
      payload: expect.objectContaining({
        status: 'cancelled',
        external_order_id: 'BP-555',
        shipment_id: '900',
        cod_collected: 0,
        collected_from_customer: null,
        elchi_fee: null,
        market_amount: null,
        total_price: 120000,
      }),
    });
    expect(h.refRepo.rows[0].isDeleted).toBe(true);
    expect(h.activityLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'PartnerShipmentRef',
        entity_id: '31',
        action: 'deleted',
        metadata: expect.objectContaining({
          reason: 'Market posilkani qaytarib oldi',
          post_id: '88',
        }),
      }),
    );
  });

  it('idempotent: outbox qayta yuborsa — skipped, ikkinchi webhook YO`Q', async () => {
    const h = makeSvc([{ ...ACTIVE }]);

    await h.svc.detachDeletedPartnerShipment(detachDto);
    const again: any = await h.svc.detachDeletedPartnerShipment(detachDto);

    expect(again.data).toEqual({
      skipped: 'not a partner order or already detached',
    });
    expect(h.webhookRows).toHaveLength(1);
  });

  it('hamkor buyurtmasi emas (ref yo`q) — no-op', async () => {
    const h = makeSvc([]);

    const res: any = await h.svc.detachDeletedPartnerShipment(detachDto);

    expect(res.data.skipped).toBeDefined();
    expect(h.webhookRows).toEqual([]);
    expect(h.refRepo.update).not.toHaveBeenCalled();
  });

  it("webhook navbatga qo'yilmasa (500) ref YOPILMAYDI — outbox qayta uradi", async () => {
    const h = makeSvc([{ ...ACTIVE }]);
    (h.svc as any).partnerWebhookOutboxRepo.save = jest.fn(() =>
      Promise.reject(new Error('db down')),
    );

    await expect(
      h.svc.detachDeletedPartnerShipment(detachDto),
    ).rejects.toBeInstanceOf(RpcException);
    expect(h.refRepo.rows[0].isDeleted).toBe(false);
  });

  it('⭐ yopilgandan keyin hamkor AYNI external_order_id bilan qayta yaratsa — YANGI buyurtma, eski id qaytmaydi', async () => {
    const h = makeSvc([{ ...ACTIVE }]);
    await h.svc.detachDeletedPartnerShipment(detachDto);

    const res: any = await h.svc.createPartnerShipment(shipmentDto);

    expect(res.statusCode).toBe(201);
    expect(res.data.shipment_id).toBe('950');
    expect(res.data.shipment_id).not.toBe('900');
    // order.create idempotency keshi (muddatsiz) eski javobni qaytarmasligi
    // uchun kalit yopilgan ref bilan farqlanadi.
    expect(h.orderSend).toHaveBeenCalledWith(
      { cmd: 'order.create' },
      expect.objectContaining({
        request_id: 'partner:7:BP-555:after-ref-31',
      }),
    );
    const active = h.refRepo.rows.filter((row) => !row.isDeleted);
    expect(active).toEqual([
      expect.objectContaining({ external_order_id: 'BP-555', order_id: '950' }),
    ]);
  });

  it('yopilmagan bo`lsa — avvalgidek idempotent: eski shipment_id, order.create chaqirilmaydi', async () => {
    const h = makeSvc([{ ...ACTIVE }]);

    const res: any = await h.svc.createPartnerShipment(shipmentDto);

    expect(res.data.shipment_id).toBe('900');
    expect(
      h.orderSend.mock.calls.some(
        ([pattern]: [{ cmd: string }]) => pattern.cmd === 'order.create',
      ),
    ).toBe(false);
  });

  it('hech qachon yopilmagan juftlik — asl kalit o`zgarmaydi (partner:<pid>:<ext>)', async () => {
    const h = makeSvc([]);

    await h.svc.createPartnerShipment(shipmentDto);

    expect(h.orderSend).toHaveBeenCalledWith(
      { cmd: 'order.create' },
      expect.objectContaining({ request_id: 'partner:7:BP-555' }),
    );
  });

  it('ikki marta yopilgan — kalit OXIRGI yopilgan ref bo`yicha (deterministik)', async () => {
    const h = makeSvc([
      { ...ACTIVE, id: '31', isDeleted: true },
      { ...ACTIVE, id: '44', order_id: '930', isDeleted: true },
    ]);

    await h.svc.createPartnerShipment(shipmentDto);

    expect(h.orderSend).toHaveBeenCalledWith(
      { cmd: 'order.create' },
      expect.objectContaining({ request_id: 'partner:7:BP-555:after-ref-44' }),
    );
  });
});
