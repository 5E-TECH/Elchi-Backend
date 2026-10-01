/**
 * fix3c (MONEY-01) — KARGO QARZI = KARGO HAQIQATAN YIG'GAN NAQD.
 *
 * Kargo `sell` webhookidan keyin qarz (`provider_receivables`) ilgari
 * `order.provider.mark` javobidagi `total_price` dan yozilardi. Dispatch esa
 * kargoga `total − paid_online_amount` ni yig'ishni aytadi: prepaid
 * posilkada kargo hech qachon ushlamagan pulga qarzdor bo'lib, qarz abadiy
 * ochiq qolardi.
 *
 * Endi order-service `cod_collected` (yig'ilgan qism) qaytaradi va qarz
 * SHUNDAN yoziladi; 0 bo'lsa (to'liq prepaid) mavjud `<= 0` tarmog'i qarz
 * yozmaydi. Eski order-service javobida `cod_collected` yo'q — avvalgidek
 * `total_price`.
 *
 * Hamkor tomoni (`GET /partner/shipments/:id`) `collected_from_customer` ni
 * buyurtma snapshotidan (`sale_collectible_amount`) o'qiydi — kargo sotuvi
 * yozgan qator bilan u ham yig'ilgan qismni ko'rsatadi.
 */
import { IntegrationServiceService } from './integration-service.service';

type Row = Record<string, unknown>;
type Svc = IntegrationServiceService & Record<string, any>;

const INTEGRATION = {
  id: '5',
  slug: 'acme-cargo',
  webhook_payload_paths: {
    external_ref: 'data.order_id',
    tracking_number: 'data.tracking',
    status: 'data.status.code',
  },
  inbound_status_mapping: {
    DELIVERED: { status: 'sold', action: 'sell' },
  },
};

const DELIVERED = {
  data: {
    order_id: 'ACME-9',
    tracking: 'TRK-9',
    status: { code: 'DELIVERED' },
  },
};

function makeSvc(markReply: unknown) {
  const receivables: Row[] = [];
  const shipment: Row = {
    id: 'shp1',
    order_id: '1001',
    integration_id: '5',
    internal_status: 'in_transit',
    external_ref: 'ACME-9',
    send_attempts: 0,
  };
  const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const s = Object.create(IntegrationServiceService.prototype) as Svc;
  Object.assign(s, {
    logger,
    orderClient: {},
    shipmentRepo: {
      findOne: jest.fn().mockResolvedValue(shipment),
      create: jest.fn((row: Row) => ({ ...row })),
      save: jest.fn((row: Row) => Promise.resolve({ id: 'shp1', ...row })),
    },
    receivableRepo: {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: Row) => ({ ...row })),
      save: jest.fn((row: Row) => {
        receivables.push(row);
        return Promise.resolve({ id: 'rcv1', ...row });
      }),
    },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
  });
  const rmqSpy = jest
    .spyOn(s as any, 'rmqRequest')
    .mockResolvedValue(markReply as never);
  return { s, receivables, rmqSpy, logger };
}

async function deliver(markReply: unknown) {
  const h = makeSvc(markReply);
  const outcome = (await h.s.applyWebhookToShipment(
    INTEGRATION,
    DELIVERED,
  )) as Row;
  return { ...h, outcome };
}

const skippedReason = (activityLog: { log: jest.Mock }) =>
  activityLog.log.mock.calls
    .map((call: unknown[]) => call[0] as Row)
    .filter(
      (entry) => (entry.new_value as Row | undefined)?.receivable === 'skipped',
    )
    .map((entry) => (entry.new_value as Row).reason);

describe('fix3c — kargo qarzi `cod_collected` dan (MONEY-01)', () => {
  it('⭐ qisman prepaid (COD 100 000 / 300 000): qarz 100 000, total EMAS', async () => {
    const h = await deliver({
      statusCode: 200,
      data: {
        id: '1001',
        status: 'sold',
        total_price: 300000,
        cod_collected: 100000,
      },
    });

    expect(h.outcome).toMatchObject({ outcome: 'updated', action: 'sell' });
    expect(h.rmqSpy).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.provider.mark' },
      expect.objectContaining({ order_id: '1001', action: 'sell' }),
    );
    expect(h.receivables).toEqual([
      expect.objectContaining({
        integration_id: '5',
        order_id: '1001',
        amount: '100000.00',
        status: 'pending',
      }),
    ]);
  });

  it('⭐ to`liq prepaid (cod_collected 0): qarz YOZILMAYDI, sabab — nothing_collected', async () => {
    const h = await deliver({
      statusCode: 200,
      data: {
        id: '1001',
        status: 'sold',
        total_price: 200000,
        cod_collected: 0,
      },
    });

    expect(h.receivables).toEqual([]);
    expect(skippedReason(h.s.activityLog)).toEqual(['nothing_collected']);
    // Bu xato emas — "summa o'qilmadi" ogohlantirishi chiqmaydi.
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.logger.log).toHaveBeenCalledWith(
      expect.stringContaining("kargo naqd yig'magan"),
    );
  });

  it('regressiya: prepaid emas — qarz = to`liq summa', async () => {
    const h = await deliver({
      statusCode: 200,
      data: {
        id: '1001',
        status: 'sold',
        total_price: 200000,
        cod_collected: 200000,
      },
    });

    expect(h.receivables).toEqual([
      expect.objectContaining({ amount: '200000.00', status: 'pending' }),
    ]);
  });

  it('eski order-service javobi (cod_collected yo`q) — avvalgidek total_price', async () => {
    const h = await deliver({
      statusCode: 200,
      data: { id: '1001', status: 'sold', total_price: 200000 },
    });

    expect(h.receivables).toEqual([
      expect.objectContaining({ amount: '200000.00' }),
    ]);
  });

  it.each([
    ['order-service javob bermadi (null)', null],
    ['javobda summa yo`q (idempotent sotuv)', { data: { skipped: true } }],
    ['summa null', { data: { total_price: null, cod_collected: null } }],
  ])(
    '%s — qarz yozilmaydi, sabab amount_unreadable (avvalgidek)',
    async (_label, reply) => {
      const h = await deliver(reply);

      expect(h.receivables).toEqual([]);
      expect(skippedReason(h.s.activityLog)).toEqual(['amount_unreadable']);
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("summa o'qilmadi"),
      );
    },
  );
});

describe('fix3c — hamkor GET: collected_from_customer = yig`ilgan qism', () => {
  function makePartnerSvc(order: Row) {
    const s = Object.create(IntegrationServiceService.prototype) as Svc;
    Object.assign(s, {
      orderClient: {},
      partnerShipmentRefRepo: {
        findOne: jest.fn().mockResolvedValue({
          partner_id: '7',
          order_id: '1001',
          external_order_id: 'EXT-1',
        }),
      },
    });
    jest
      .spyOn(s as any, 'rmqRequest')
      .mockResolvedValue({ statusCode: 200, data: order } as never);
    return s;
  }

  it.each([
    // [label, kargo sotuvi yozgan snapshot, collected, market_amount]
    [
      'to`liq prepaid',
      { sale_collectible_amount: 0, to_be_paid: 0 },
      0,
      -30000,
    ],
    [
      'qisman prepaid',
      { sale_collectible_amount: 100000, to_be_paid: 70000 },
      100000,
      70000,
    ],
  ])('%s', async (_label, snapshot, collected, marketAmount) => {
    const s = makePartnerSvc({
      id: '1001',
      status: 'sold',
      total_price: 300000,
      market_tariff: 30000,
      paid_amount: 0,
      extra_cost: 0,
      ...snapshot,
    });

    const res = (await s.getPartnerShipment({
      partner_id: '7',
      shipment_id: '1001',
    })) as { data: Row };

    expect(res.data).toMatchObject({
      collected_from_customer: collected,
      elchi_fee: 30000,
      market_amount: marketAmount,
      // `to_be_paid` manfiy emas (sellOrder dagi kabi) — hamkorga manfiy COD
      // ketmaydi.
      cod_amount: snapshot.to_be_paid,
    });
  });
});
