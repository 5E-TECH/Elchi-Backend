import type { RmqContext } from '@nestjs/microservices';
import { RpcException } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { BranchTransferBatch } from '../entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from '../entities/branch-transfer-batch-item.entity';
import { BranchTransferBatchHistory } from '../entities/branch-transfer-batch-history.entity';
import { OrderServiceController } from '../order-service.controller';
import {
  OPEN_CUSTODY_DEFAULT_LIMIT,
  OPEN_CUSTODY_MAX_DISTRICT_IDS,
  OPEN_CUSTODY_MAX_LIMIT,
  OPEN_CUSTODY_STATUSES,
  OpenCustodyByDistrictService,
  normalizeOpenCustodyPayload,
} from './open-custody-by-district.service';

/**
 * `order.open_custody_by_district` — logistika tuman ko'chganda eski filial
 * custody'sidagi buyurtmalarni shu javobdan aniqlaydi. Payload tekshiruvi,
 * SQL shakli (haqiqiy TypeORM metadata, bazasiz) va javob shakli. Semantika
 * haqiqiy Postgres'da — open-custody-by-district.pg.spec.ts.
 */
function rpcStatus(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return ((error as RpcException).getError() as { statusCode?: number })
      .statusCode;
  }
  return undefined;
}

describe('normalizeOpenCustodyPayload', () => {
  it('sukut: after_id null, limit 1000; takror tumanlar olib tashlanadi', () => {
    expect(
      normalizeOpenCustodyPayload({ district_ids: ['7', '3', '7'] }),
    ).toEqual({
      districtIds: ['7', '3'],
      afterId: null,
      limit: OPEN_CUSTODY_DEFAULT_LIMIT,
    });
    expect(OPEN_CUSTODY_DEFAULT_LIMIT).toBe(1000);
  });

  it('after_id va limit qabul qilinadi (null — sukut)', () => {
    expect(
      normalizeOpenCustodyPayload({
        district_ids: ['9223372036854775807'],
        after_id: '120',
        limit: 1,
      }),
    ).toEqual({
      districtIds: ['9223372036854775807'],
      afterId: '120',
      limit: 1,
    });
    expect(
      normalizeOpenCustodyPayload({
        district_ids: ['1'],
        after_id: null,
        limit: null,
      }),
    ).toEqual({ districtIds: ['1'], afterId: null, limit: 1000 });
  });

  it.each([[undefined], [null], ['x'], [['1']], [5]])(
    'payload obyekt emas (%p) — 400',
    (raw) => {
      expect(rpcStatus(() => normalizeOpenCustodyPayload(raw))).toBe(400);
    },
  );

  it.each([[undefined], [null], ['1'], [{ 0: '1' }]])(
    'district_ids massiv emas (%p) — 400',
    (ids) => {
      expect(
        rpcStatus(() => normalizeOpenCustodyPayload({ district_ids: ids })),
      ).toBe(400);
    },
  );

  it('district_ids bo`sh — 400', () => {
    expect(
      rpcStatus(() => normalizeOpenCustodyPayload({ district_ids: [] })),
    ).toBe(400);
  });

  it(`district_ids ko'pi bilan ${OPEN_CUSTODY_MAX_DISTRICT_IDS} ta`, () => {
    const ids = Array.from(
      { length: OPEN_CUSTODY_MAX_DISTRICT_IDS + 1 },
      (_, i) => String(i + 1),
    );
    expect(
      rpcStatus(() => normalizeOpenCustodyPayload({ district_ids: ids })),
    ).toBe(400);
    expect(
      normalizeOpenCustodyPayload({ district_ids: ids.slice(1) }).districtIds,
    ).toHaveLength(OPEN_CUSTODY_MAX_DISTRICT_IDS);
  });

  it.each([
    ['0'],
    ['05'],
    [' 5'],
    ['5 '],
    ['-1'],
    ['1.5'],
    ['abc'],
    [''],
    [5],
    [null],
    [{}],
    ['9223372036854775808'],
    ['1'.repeat(20)],
  ])('kanonik bo`lmagan tuman id (%p) — 400 (jim tashlanmaydi)', (bad) => {
    expect(
      rpcStatus(() =>
        normalizeOpenCustodyPayload({ district_ids: ['1', bad] }),
      ),
    ).toBe(400);
  });

  it.each([['0'], ['007'], [7], ['x'], [''], [{}], ['9223372036854775808']])(
    'noto`g`ri after_id (%p) — 400',
    (afterId) => {
      expect(
        rpcStatus(() =>
          normalizeOpenCustodyPayload({
            district_ids: ['1'],
            after_id: afterId,
          }),
        ),
      ).toBe(400);
    },
  );

  it.each([[0], [-1], [1001], [1.5], ['10'], [Number.NaN], [Infinity], [{}]])(
    'noto`g`ri limit (%p) — 400',
    (limit) => {
      expect(
        rpcStatus(() =>
          normalizeOpenCustodyPayload({ district_ids: ['1'], limit }),
        ),
      ).toBe(400);
    },
  );

  it(`limit chegarasi ${OPEN_CUSTODY_MAX_LIMIT} qabul qilinadi`, () => {
    expect(
      normalizeOpenCustodyPayload({
        district_ids: ['1'],
        limit: OPEN_CUSTODY_MAX_LIMIT,
      }).limit,
    ).toBe(OPEN_CUSTODY_MAX_LIMIT);
  });
});

describe('OpenCustodyByDistrictService.findOpenCustodyByDistrict (SQL)', () => {
  type Captured = { sql: string; params: unknown[] };
  let dataSource: DataSource;
  let captured: Captured[];
  let rawResult: Array<Record<string, unknown>>;

  beforeAll(async () => {
    // Prod kabi: order-service `DB_SCHEMA=order_schema`.
    dataSource = new DataSource({
      type: 'postgres',
      schema: 'order_schema',
      entities: [
        Order,
        OrderItem,
        OrderTracking,
        OrderCustodyEvent,
        Branch,
        BranchTransferBatch,
        BranchTransferBatchItem,
        BranchTransferBatchHistory,
      ],
    });
    await (
      dataSource as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();
  });

  beforeEach(() => {
    captured = [];
    rawResult = [];
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getRawMany')
      .mockImplementation(function (this: SelectQueryBuilder<Order>) {
        const [sql, params] = this.getQueryAndParameters();
        captured.push({ sql, params });
        return Promise.resolve(rawResult);
      });
  });

  afterEach(() => jest.restoreAllMocks());

  const service = () =>
    new OpenCustodyByDistrictService(dataSource.getRepository(Order));

  it('ochiq holatlar: cancelled va sold kiradi; paid/partly_paid/closed, cancelled (sent) — yo`q', () => {
    // Ushlab turgan filial/kuryer cancelled va sold ni WAITING ga qaytara
    // oladi (rollbackOrderToWaiting) — imtiyoz ularni ham qamrashi kerak.
    expect([...OPEN_CUSTODY_STATUSES]).toEqual([
      'new',
      'received',
      'waiting',
      'waiting_customer',
      'on the road',
      'cancelled',
      'sold',
    ]);
  });

  it('faqat ro`yxatdagi ustunlar (matn), filtr, id tartibi, limit', async () => {
    await service().findOpenCustodyByDistrict({
      district_ids: ['11', '12'],
      limit: 25,
    });
    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0];
    const select = sql.slice(0, sql.indexOf(' FROM '));
    for (const column of [
      'id',
      'district_id',
      'region_id',
      'status',
      'holder_type',
      'holder_branch_id',
      'holder_courier_id',
      'branch_id',
      'courier_id',
      'current_batch_id',
    ]) {
      expect(select).toContain(`CAST("o"."${column}" AS text) AS "${column}"`);
    }
    expect(select).toContain(
      'CAST("b"."destination_branch_id" AS text) AS "batch_destination_branch_id"',
    );
    // Faqat shu 11 ustun — relation yoki boshqa ustun yo'q.
    expect(select.match(/ AS "/g)).toHaveLength(11);
    // Yagona JOIN — partiya, faqat SENT (yo'nalish shartsiz).
    expect(sql.match(/JOIN/gi)).toHaveLength(1);
    expect(sql).toContain(
      'LEFT JOIN "order_schema"."branch_transfer_batches" "b" ON "b"."id" = "o"."current_batch_id" AND "b"."status" = $1',
    );
    expect(sql).not.toContain('direction');
    expect(sql).toContain('FROM "order_schema"."orders" "o"');
    expect(sql).toContain('"o"."is_deleted" = false');
    expect(sql).toContain('"o"."deleted_at" IS NULL');
    expect(sql).toContain('"o"."district_id" IN ($2, $3)');
    expect(sql).toContain('"o"."status" IN ($4, $5, $6, $7, $8, $9, $10)');
    expect(sql).toContain(`"o"."holder_type" IS DISTINCT FROM 'MARKET'`);
    expect(sql).not.toContain('"o"."id" >');
    expect(sql).toMatch(/ORDER BY "o"\."id" ASC LIMIT 25$/);
    expect(params).toEqual([
      'SENT',
      '11',
      '12',
      'new',
      'received',
      'waiting',
      'waiting_customer',
      'on the road',
      'cancelled',
      'sold',
    ]);
  });

  it('after_id — keyset sharti `o.id > :afterId`', async () => {
    await service().findOpenCustodyByDistrict({
      district_ids: ['11'],
      after_id: '500',
    });
    const { sql, params } = captured[0];
    expect(sql).toContain('"o"."id" > $10');
    expect(params[9]).toBe('500');
    expect(sql).toMatch(/LIMIT 1000$/);
  });

  it('noto`g`ri payload — 400, SQL yuborilmaydi', async () => {
    await expect(
      service().findOpenCustodyByDistrict({ district_ids: ['05'] }),
    ).rejects.toBeInstanceOf(RpcException);
    expect(captured).toHaveLength(0);
  });

  it('javob shakli: id`lar satr, null saqlanadi; to`liq sahifa — next_after_id', async () => {
    rawResult = [
      {
        id: '10',
        district_id: '11',
        region_id: '2',
        status: 'waiting',
        holder_type: 'COURIER',
        holder_branch_id: '4',
        holder_courier_id: '90',
        branch_id: '4',
        courier_id: '90',
        current_batch_id: null,
        batch_destination_branch_id: null,
      },
      {
        id: 12,
        district_id: 11,
        region_id: null,
        status: 'new',
        holder_type: 'HQ',
        holder_branch_id: null,
        holder_courier_id: null,
        branch_id: null,
        courier_id: null,
        current_batch_id: 7,
        batch_destination_branch_id: 8,
      },
    ];
    const res = await service().findOpenCustodyByDistrict({
      district_ids: ['11'],
      limit: 2,
    });
    expect(res).toEqual({
      statusCode: 200,
      message: 'Open custody orders by district',
      data: {
        rows: [
          {
            id: '10',
            district_id: '11',
            region_id: '2',
            status: 'waiting',
            holder_type: 'COURIER',
            holder_branch_id: '4',
            holder_courier_id: '90',
            branch_id: '4',
            courier_id: '90',
            current_batch_id: null,
            batch_destination_branch_id: null,
          },
          {
            id: '12',
            district_id: '11',
            region_id: null,
            status: 'new',
            holder_type: 'HQ',
            holder_branch_id: null,
            holder_courier_id: null,
            branch_id: null,
            courier_id: null,
            current_batch_id: '7',
            batch_destination_branch_id: '8',
          },
        ],
        next_after_id: '12',
      },
    });
  });

  it('sahifa to`lmasa — next_after_id null', async () => {
    rawResult = [{ id: '10', status: 'new' }];
    const res = await service().findOpenCustodyByDistrict({
      district_ids: ['11'],
      limit: 2,
    });
    expect(res.data.next_after_id).toBeNull();
    expect(res.data.rows).toHaveLength(1);
    // Ustun kelmasa (undefined) — null, maydon tushib qolmaydi.
    expect(res.data.rows[0].batch_destination_branch_id).toBeNull();
  });
});

describe('order.open_custody_by_district handleri', () => {
  const handler = Object.getOwnPropertyDescriptor(
    OrderServiceController.prototype,
    'findOpenCustodyByDistrict',
  )?.value as (data: unknown, context: RmqContext) => Promise<unknown>;
  // Haqiqiy `executeAndAck` kabi async: sinxron xato rad etilgan promise.
  const executeAndAck = async (
    _ctx: RmqContext,
    fn: () => Promise<unknown>,
  ): Promise<unknown> => fn();

  it("naqsh AYNAN { cmd: 'order.open_custody_by_district' }", () => {
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: 'order.open_custody_by_district' },
    ]);
  });

  it('payload servisga o`zgarishsiz uzatiladi', async () => {
    const result = {
      statusCode: 200,
      message: 'ok',
      data: { rows: [], next_after_id: null },
    };
    const openCustodyByDistrict = {
      findOpenCustodyByDistrict: jest.fn().mockResolvedValue(result),
    };
    const payload = { district_ids: ['5'], after_id: '9', limit: 10 };
    await expect(
      handler.call({ executeAndAck, openCustodyByDistrict }, payload, {}),
    ).resolves.toBe(result);
    expect(
      openCustodyByDistrict.findOpenCustodyByDistrict,
    ).toHaveBeenCalledWith(payload);
  });

  it('servis ulanmagan — 503 (jim bo`sh javob emas)', async () => {
    await expect(
      handler.call({ executeAndAck }, { district_ids: ['5'] }, {}),
    ).rejects.toMatchObject({
      error: { statusCode: 503 },
    });
  });
});
