/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { of } from 'rxjs';
import { OrderServiceService } from '../order-service.service';
import {
  buildCancelReturnView,
  parseCancelReturnStages,
  resolveCancelReturnStage,
  type CancelReturnContext,
  type CancelReturnStage,
  cancelReturnStageSql,
} from './cancel-return';

/**
 * 5Yy6r6UI (BG1) — bekor bosqichi va joy. Bosqich jadvali Elchi-Frontend
 * `cancelReturnStage.test.ts` (§3.2) bilan bir xil — FE backend qiymatini
 * o'qiydi, ikki tomon farq qilmasligi kerak.
 */
describe('5Yy6r6UI — resolveCancelReturnStage (FE §3.2 jadvali bilan bir xil)', () => {
  it.each<[string, Record<string, unknown>, CancelReturnStage | null]>([
    [
      "kuryer qo'lida",
      { status: 'cancelled', holder_type: 'COURIER', holder_courier_id: '7' },
      'courier',
    ],
    [
      "eski yozuv: holder yo'q, kuryer id bor",
      { status: 'cancelled', holder_courier_id: '7' },
      'courier',
    ],
    [
      "'0' kuryer sentineli — kuryer emas",
      { status: 'cancelled', holder_courier_id: '0' },
      null,
    ],
    [
      "yo'lda (HQ ga)",
      { status: 'cancelled (sent)', holder_type: 'HQ' },
      'in_transit',
    ],
    [
      "yo'lda (filialga)",
      { status: 'cancelled (sent)', holder_type: 'BRANCH' },
      'in_transit',
    ],
    [
      'filialda (qabul qilingan, bekor pochtasiz)',
      {
        status: 'cancelled',
        holder_type: 'BRANCH',
        post_id: '8',
        canceled_post_id: null,
      },
      'branch',
    ],
    [
      'filialda, lekin pochtaga biriktirilgan — aniqlanmaydi',
      {
        status: 'cancelled',
        holder_type: 'BRANCH',
        post_id: '8',
        canceled_post_id: '41',
      },
      null,
    ],
    ["HQ'da", { status: 'cancelled', holder_type: 'HQ', post_id: '8' }, 'hq'],
    [
      "HQ'da — bekor pochtasi bilan qabul qilingan",
      {
        status: 'cancelled',
        holder_type: 'HQ',
        post_id: null,
        canceled_post_id: '41',
      },
      'hq',
    ],
    [
      'qabulgacha bekor: holder HQ, post_id yo`q — bosqich yo`q',
      { status: 'cancelled', holder_type: 'HQ', post_id: null },
      null,
    ],
    [
      'qabulgacha bekor: holder BRANCH, post_id yo`q — bosqich yo`q',
      {
        status: 'cancelled',
        holder_type: 'BRANCH',
        holder_branch_id: '12',
        post_id: null,
      },
      null,
    ],
    [
      'topshirilgan',
      { status: 'returned_to_market', holder_type: 'MARKET' },
      'market',
    ],
    ["topshirilgan (holder yo'q)", { status: 'returned_to_market' }, 'market'],
    [
      'bekor + holder MARKET',
      { status: 'cancelled', holder_type: 'MARKET' },
      'market',
    ],
    ["bekor, holder noma'lum", { status: 'cancelled' }, null],
    ['bekor emas', { status: 'waiting', holder_type: 'COURIER' }, null],
    [
      'eski topshirish: closed + holder MARKET (F4 dan oldin)',
      { status: 'closed', holder_type: 'MARKET' },
      'market',
    ],
    [
      'yopilgan (holder MARKET emas)',
      { status: 'closed', holder_type: 'HQ' },
      null,
    ],
  ])('%s', (_name, order, expected) => {
    expect(resolveCancelReturnStage(order)).toBe(expected);
  });

  it('buzuq kirish yiqitmaydi', () => {
    expect(resolveCancelReturnStage(null)).toBeNull();
    expect(resolveCancelReturnStage(undefined)).toBeNull();
    expect(resolveCancelReturnStage({})).toBeNull();
  });
});

describe('5Yy6r6UI — buildCancelReturnView (joy, vaqt)', () => {
  const ctx = (
    overrides: Partial<CancelReturnContext> = {},
  ): CancelReturnContext => ({
    hqBranchId: '1',
    branchNames: new Map([
      ['1', 'Toshkent HQ'],
      ['12', 'Urgut filiali'],
    ]),
    courierNames: new Map([['26', 'Claude Kuryer']]),
    receivedAt: new Map(),
    ...overrides,
  });

  it('bekor emas — null', () => {
    expect(buildCancelReturnView({ status: 'sold' }, ctx())).toBeNull();
  });

  it('kuryerda — ushlab turgan kuryer ismi, vaqtlar yo`q', () => {
    expect(
      buildCancelReturnView(
        {
          id: '5',
          status: 'cancelled',
          holder_type: 'COURIER',
          holder_courier_id: '26',
          courier_id: null,
          last_handover_at: new Date('2026-10-20T09:00:00Z'),
        },
        ctx(),
      ),
    ).toEqual({
      stage: 'courier',
      place_type: 'COURIER',
      place_id: '26',
      place_name: 'Claude Kuryer',
      received_at: null,
      sent_at: null,
      handed_over_at: null,
      handover_method: null,
    });
  });

  it('yo`lda HQ ga — joy maqsad (HQ), jo`natilgan vaqt', () => {
    expect(
      buildCancelReturnView(
        {
          status: 'cancelled (sent)',
          holder_type: 'HQ',
          holder_branch_id: null,
          branch_id: '1',
          last_handover_at: new Date('2026-10-21T10:00:00Z'),
        },
        ctx(),
      ),
    ).toEqual(
      expect.objectContaining({
        stage: 'in_transit',
        place_type: 'HQ',
        place_id: '1',
        place_name: 'Toshkent HQ',
        sent_at: '2026-10-21T10:00:00.000Z',
        received_at: null,
      }),
    );
  });

  it('yo`lda filialga — joy maqsad filial', () => {
    expect(
      buildCancelReturnView(
        {
          status: 'cancelled (sent)',
          holder_type: 'BRANCH',
          holder_branch_id: '12',
          branch_id: '12',
        },
        ctx(),
      ),
    ).toEqual(
      expect.objectContaining({
        place_type: 'BRANCH',
        place_id: '12',
        place_name: 'Urgut filiali',
      }),
    );
  });

  it('HQ`da — qabul vaqti `cancelled_post_received` dan (jo`natish vaqtidan keyin)', () => {
    const view = buildCancelReturnView(
      {
        id: '7',
        status: 'cancelled',
        holder_type: 'HQ',
        holder_branch_id: null,
        post_id: '41',
        branch_id: '1',
        last_handover_at: new Date('2026-10-21T10:00:00Z'),
      },
      ctx({
        receivedAt: new Map([['7', new Date('2026-10-22T06:30:00Z')]]),
      }),
    );
    expect(view).toEqual(
      expect.objectContaining({
        stage: 'hq',
        place_type: 'HQ',
        place_id: '1',
        place_name: 'Toshkent HQ',
        received_at: '2026-10-22T06:30:00.000Z',
      }),
    );
  });

  it('filialda — eski qabul hodisasi (custody o`zgarishidan oldin) e`tiborsiz, custody vaqti olinadi', () => {
    const view = buildCancelReturnView(
      {
        id: '8',
        status: 'cancelled',
        holder_type: 'BRANCH',
        holder_branch_id: '12',
        branch_id: '12',
        post_id: '41',
        last_handover_at: new Date('2026-10-23T08:00:00Z'),
      },
      ctx({
        receivedAt: new Map([['8', new Date('2026-10-01T08:00:00Z')]]),
      }),
    );
    expect(view).toEqual(
      expect.objectContaining({
        stage: 'branch',
        place_type: 'BRANCH',
        place_name: 'Urgut filiali',
        received_at: '2026-10-23T08:00:00.000Z',
      }),
    );
  });

  it('marketga topshirilgan — joy, vaqt va usul BG2 ustunlaridan', () => {
    expect(
      buildCancelReturnView(
        {
          status: 'returned_to_market',
          holder_type: 'MARKET',
          branch_id: '12',
          market_handover_branch_id: '1',
          market_handover_at: new Date('2026-10-24T12:00:00Z'),
          market_handover_method: 'manual',
          last_handover_at: new Date('2026-10-01T00:00:00Z'),
        },
        ctx(),
      ),
    ).toEqual({
      stage: 'market',
      place_type: 'HQ',
      place_id: '1',
      place_name: 'Toshkent HQ',
      received_at: null,
      sent_at: null,
      handed_over_at: '2026-10-24T12:00:00.000Z',
      handover_method: 'manual',
    });
  });

  it('eski topshirish (BG2 ustunlarisiz) — `branch_id` va `last_handover_at`, usul null', () => {
    expect(
      buildCancelReturnView(
        {
          status: 'closed',
          holder_type: 'MARKET',
          branch_id: '12',
          last_handover_at: '2026-10-02T00:00:00.000Z',
          market_handover_method: 'random',
        },
        ctx(),
      ),
    ).toEqual(
      expect.objectContaining({
        stage: 'market',
        place_type: 'BRANCH',
        place_id: '12',
        handed_over_at: '2026-10-02T00:00:00.000Z',
        handover_method: null,
      }),
    );
  });

  it('nom topilmasa — id qoladi, nom null (taxmin yo`q)', () => {
    expect(
      buildCancelReturnView(
        {
          status: 'cancelled',
          holder_type: 'BRANCH',
          holder_branch_id: '99',
          post_id: '1',
        },
        ctx(),
      ),
    ).toEqual(expect.objectContaining({ place_id: '99', place_name: null }));
  });
});

describe('5Yy6r6UI — enrichOrders: return_stage + cancel_return', () => {
  function setup(opts: { branchQueryFails?: boolean } = {}) {
    const dataSource = {
      query: jest.fn((sql: string, params: unknown[]) => {
        if (sql.includes('"branch_schema"."branches"')) {
          if (opts.branchQueryFails) {
            return Promise.reject(new Error('permission denied'));
          }
          const names: Record<string, string> = {
            '1': 'Toshkent HQ',
            '12': 'Urgut filiali',
          };
          return Promise.resolve(
            (params[0] as string[])
              .filter((id) => names[id])
              .map((id) => ({ id, name: names[id] })),
          );
        }
        return Promise.resolve([]);
      }),
    };
    const trackingQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([
          { order_id: '3', received_at: new Date('2026-10-22T06:30:00Z') },
        ]),
    };
    const identitySend = jest.fn((pattern: { cmd: string }, payload: any) =>
      of(
        pattern.cmd === 'identity.user.find_by_ids'
          ? {
              data: (payload.ids as string[]).map((id) => ({
                id,
                name: `Kuryer ${id}`,
                phone_number: '+998900000000',
              })),
            }
          : { data: [] },
      ),
    );
    const getHqBranchId = jest.fn().mockResolvedValue('1');
    const empty = { send: jest.fn(() => of({ data: [] })) };
    const service = Object.create(OrderServiceService.prototype);
    Object.assign(service, {
      dataSource,
      orderTrackingRepo: { createQueryBuilder: jest.fn(() => trackingQb) },
      lookup: { getHqBranchId },
      identityClient: { send: identitySend },
      logisticsClient: empty,
      catalogClient: empty,
      logger: { warn: jest.fn() },
    });
    const enrich = (
      rows: Array<Record<string, unknown>>,
    ): Promise<Array<Record<string, any>>> => service.enrichOrders(rows);
    return { enrich, dataSource, trackingQb, getHqBranchId };
  }

  const order = (overrides: Record<string, unknown>) => ({
    id: '1',
    market_id: null,
    customer_id: null,
    district_id: null,
    region_id: null,
    courier_id: null,
    post_id: null,
    items: [],
    ...overrides,
  });

  it('har qatorga bosqich va joy; bekor bo`lmaganda ikkalasi null', async () => {
    const h = setup();
    const rows = await h.enrich([
      order({ id: '1', status: 'waiting', courier_id: '26' }),
      order({
        id: '2',
        status: 'cancelled',
        holder_type: 'COURIER',
        holder_courier_id: '26',
      }),
      order({
        id: '3',
        status: 'cancelled',
        holder_type: 'HQ',
        post_id: '41',
        branch_id: '1',
        last_handover_at: new Date('2026-10-21T10:00:00Z'),
      }),
      order({
        id: '4',
        status: 'cancelled (sent)',
        holder_type: 'BRANCH',
        holder_branch_id: '12',
        branch_id: '12',
      }),
    ]);

    expect(rows[0].return_stage).toBeNull();
    expect(rows[0].cancel_return).toBeNull();
    expect(rows[1]).toEqual(
      expect.objectContaining({
        return_stage: 'courier',
        cancel_return: expect.objectContaining({
          place_type: 'COURIER',
          place_name: 'Kuryer 26',
        }),
      }),
    );
    expect(rows[2].cancel_return).toEqual(
      expect.objectContaining({
        stage: 'hq',
        place_name: 'Toshkent HQ',
        received_at: '2026-10-22T06:30:00.000Z',
      }),
    );
    expect(rows[3].cancel_return).toEqual(
      expect.objectContaining({
        stage: 'in_transit',
        place_type: 'BRANCH',
        place_name: 'Urgut filiali',
      }),
    );
    // Qabul vaqti faqat filial/HQ bosqichidagi qatorlar uchun so'raladi.
    expect(h.trackingQb.where).toHaveBeenCalledWith(
      'tracking.order_id IN (:...orderIds)',
      { orderIds: ['3'] },
    );
    expect(h.trackingQb.andWhere).toHaveBeenCalledWith(
      'tracking.action = :action',
      { action: 'cancelled_post_received' },
    );
  });

  it('bekor qatori yo`q — qo`shimcha so`rov yo`q', async () => {
    const h = setup();
    const rows = await h.enrich([order({ id: '1', status: 'sold' })]);
    expect(rows[0].cancel_return).toBeNull();
    expect(h.getHqBranchId).not.toHaveBeenCalled();
    expect(h.trackingQb.getRawMany).not.toHaveBeenCalled();
    expect(h.dataSource.query).not.toHaveBeenCalledWith(
      expect.stringContaining('branch_schema'),
      expect.anything(),
    );
  });

  it('filial nomlari o`qilmasa boyitish yiqilmaydi — nom null', async () => {
    const h = setup({ branchQueryFails: true });
    const [row] = await h.enrich([
      order({
        id: '3',
        status: 'cancelled',
        holder_type: 'HQ',
        post_id: '41',
      }),
    ]);
    expect(row.cancel_return).toEqual(
      expect.objectContaining({
        stage: 'hq',
        place_id: '1',
        place_name: null,
      }),
    );
  });
});

describe('M0EPcJVf — parseCancelReturnStages (`stage` so`rov parametri)', () => {
  it('vergulli ro`yxat, massiv, harf farqsiz, takrorsiz', () => {
    expect(parseCancelReturnStages(' HQ, market ,hq')).toEqual({
      stages: ['hq', 'market'],
      invalid: [],
    });
    expect(parseCancelReturnStages(['courier', 'in_transit,branch'])).toEqual({
      stages: ['courier', 'in_transit', 'branch'],
      invalid: [],
    });
  });

  it('bo`sh — filtr yo`q; noma`lum qiymat alohida qaytadi', () => {
    for (const raw of [undefined, null, '', ' , ', [], {}]) {
      expect(parseCancelReturnStages(raw)).toEqual({
        stages: null,
        invalid: [],
      });
    }
    expect(parseCancelReturnStages('hq,yolda')).toEqual({
      stages: ['hq'],
      invalid: ['yolda'],
    });
  });
});

describe('review 2026-10-25 — ombor buyurtmasining omborga qaytishi marketga topshirish emas', () => {
  it('WAREHOUSE + returned_to_market + market_handover_at yo`q → null', () => {
    expect(
      resolveCancelReturnStage({
        status: 'returned_to_market',
        holder_type: 'MARKET',
        fulfillment_source: 'WAREHOUSE',
        market_handover_at: null,
      }),
    ).toBeNull();
  });
  it('WAREHOUSE, lekin marketga haqiqatan topshirilgan → market', () => {
    expect(
      resolveCancelReturnStage({
        status: 'returned_to_market',
        fulfillment_source: 'WAREHOUSE',
        market_handover_at: new Date('2026-10-25T10:00:00Z'),
      }),
    ).toBe('market');
  });
  it('HQ buyurtmasi → market (avvalgidek)', () => {
    expect(
      resolveCancelReturnStage({
        status: 'returned_to_market',
        fulfillment_source: 'HQ',
      }),
    ).toBe('market');
  });
  it('SQL market sharti ombor qaytishini chiqarib tashlaydi', () => {
    expect(cancelReturnStageSql('market')).toContain(
      "fulfillment_source = 'WAREHOUSE' AND order.market_handover_at IS NULL",
    );
  });
});
