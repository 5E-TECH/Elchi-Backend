import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { OrderServiceService } from './order-service.service';

/**
 * VkKDSNNn — GET /orders ombor filtrlari (`buildOrderListQuery`):
 *   - `warehouse_id` — `order.warehouse_id = :warehouse_id` (musbat bigint,
 *     aks holda 400, bazaga yetmaydi);
 *   - `warehouse_kind` — HQ (WAREHOUSE + home_branch_id = HQ) | REGIONAL
 *     (WAREHOUSE + home_branch_id NULL yoki ≠ HQ); noto'g'ri — 400;
 *   - HQ id FAQAT `warehouse_kind` berilganda so'raladi (findAll va
 *     statusCounts); aniqlanmasa — 503 (fail-closed). Chaqiruvchi bergan
 *     `warehouse_hq_branch_id` ga ishonilmaydi;
 *   - filtrlar berilmasa so'rov bugungidek (lookup chaqirilmaydi).
 */
type Qb = Record<string, jest.Mock>;

const HQ = '1';

const andWhereCalls = (qb: Qb) =>
  qb.andWhere.mock.calls as Array<[string, Record<string, unknown>?]>;
const andWhereSql = (qb: Qb) => andWhereCalls(qb).map(([sql]) => String(sql));
/** Barcha `andWhere` parametrlari bitta obyektda (TypeORM ham shunday birlashtiradi). */
const mergedParams = (qb: Qb) =>
  andWhereCalls(qb).reduce<Record<string, unknown>>(
    (acc, [, params]) => ({ ...acc, ...(params ?? {}) }),
    {},
  );

function setup(
  opts: {
    hq?: string | null | Error;
    noLookup?: boolean;
  } = {},
) {
  const service = Object.create(
    OrderServiceService.prototype,
  ) as OrderServiceService;
  const qbs: Qb[] = [];
  const makeQb = () => {
    const qb: Qb = {};
    for (const name of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'orWhere',
      'groupBy',
      'leftJoinAndSelect',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
    ]) {
      qb[name] = jest.fn(() => qb);
    }
    qb.clone = jest.fn(() => qb);
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    qb.getCount = jest.fn().mockResolvedValue(0);
    qb.getMany = jest.fn().mockResolvedValue([]);
    qbs.push(qb);
    return qb;
  };
  const orderRepo = { createQueryBuilder: jest.fn(makeQb) };
  const hq = opts.hq === undefined ? HQ : opts.hq;
  const getHqBranchId = jest.fn(() =>
    hq instanceof Error ? Promise.reject(hq) : Promise.resolve(hq),
  );
  Object.assign(service as object, {
    orderRepo,
    identityClient: { send: jest.fn(() => of({ data: [] })) },
    logger: new Logger('spec'),
    ...(opts.noLookup ? {} : { lookup: { getHqBranchId } }),
  });
  return { service, orderRepo, qbs, getHqBranchId };
}

const rpcStatus = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
  }
  throw new Error('RpcException kutilgan edi');
};

describe('VkKDSNNn — buyurtmalar ro`yxati: ombor filtrlari (order-service)', () => {
  it('⭐ filtrlar berilmasa — so`rov bugungidek: ombor sharti yo`q, HQ lookup chaqirilmaydi', async () => {
    const { service, qbs, getHqBranchId } = setup();
    await service.findAll({ market_id: '37', page: 1, limit: 10 });
    await service.statusCounts({ query: { market_id: '37' } });
    expect(getHqBranchId).not.toHaveBeenCalled();
    for (const qb of qbs) {
      const sql = andWhereSql(qb).join(' | ');
      expect(sql).not.toMatch(/warehouse|home_branch_id|fulfillment_source/);
    }
  });

  it('⭐ warehouse_id → order.warehouse_id = :warehouse_id (bo`shliqlar kesiladi), lookup yo`q', async () => {
    const { service, qbs, getHqBranchId } = setup();
    await service.findAll({ warehouse_id: ' 42 ', page: 1, limit: 10 });
    const [qb] = qbs;
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.warehouse_id = :warehouse_id',
      { warehouse_id: '42' },
    );
    expect(getHqBranchId).not.toHaveBeenCalled();
    // Bigint chegarasi — o'tadi.
    await service.findAll({ warehouse_id: '9223372036854775807' });
    expect(mergedParams(qbs[1]).warehouse_id).toBe('9223372036854775807');
  });

  it.each([
    '0',
    '-3',
    '007',
    'abc',
    '1.5',
    '1e3',
    '42; DROP TABLE orders',
    '9223372036854775808',
    '99999999999999999999',
  ])('warehouse_id=%p — 400, so`rov bazaga yetmaydi', async (warehouse_id) => {
    const { service, qbs } = setup();
    const error = await rpcStatus(service.findAll({ warehouse_id }));
    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/warehouse_id/);
    expect(qbs.every((qb) => !qb.getMany.mock.calls.length)).toBe(true);
  });

  it('⭐ warehouse_kind=hq → WAREHOUSE + home_branch_id = HQ (I2), HQ id lookup`dan', async () => {
    const { service, qbs, getHqBranchId } = setup();
    await service.findAll({ warehouse_kind: 'hq', page: 1, limit: 10 });
    expect(getHqBranchId).toHaveBeenCalledTimes(1);
    const [qb] = qbs;
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.fulfillment_source = :warehouse_kind_source',
      { warehouse_kind_source: 'WAREHOUSE' },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.home_branch_id = :warehouse_hq_branch_id',
      { warehouse_hq_branch_id: HQ },
    );
    expect(andWhereSql(qb).join(' | ')).not.toMatch(/IS NULL OR/);
  });

  it('⭐ warehouse_kind=REGIONAL → WAREHOUSE + (home_branch_id NULL yoki ≠ HQ)', async () => {
    const { service, qbs } = setup();
    await service.findAll({ warehouse_kind: ' Regional ' });
    const [qb] = qbs;
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.fulfillment_source = :warehouse_kind_source',
      { warehouse_kind_source: 'WAREHOUSE' },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      '(order.home_branch_id IS NULL OR order.home_branch_id <> :warehouse_hq_branch_id)',
      { warehouse_hq_branch_id: HQ },
    );
    expect(andWhereSql(qb)).not.toContain(
      'order.home_branch_id = :warehouse_hq_branch_id',
    );
  });

  it('warehouse_kind noto`g`ri — 400, HQ lookup`ga bormaydi', async () => {
    for (const warehouse_kind of ['markaziy', 'BRANCH', 'WAREHOUSE']) {
      const { service, getHqBranchId } = setup();
      const error = await rpcStatus(service.findAll({ warehouse_kind }));
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('warehouse_kind — HQ yoki REGIONAL');
      expect(getHqBranchId).not.toHaveBeenCalled();
    }
  });

  it.each<[string, { hq?: string | null | Error; noLookup?: boolean }]>([
    ['lookup null qaytardi', { hq: null }],
    ['lookup bo`sh satr qaytardi', { hq: '  ' }],
    ['lookup xato berdi (branch-service uzilgan)', { hq: new Error('rmq') }],
    ['lookup servisi yo`q', { noLookup: true }],
  ])(
    '⭐ HQ id aniqlanmasa (%s) — 503, so`rov bazaga yetmaydi (I3)',
    async (_name, opts) => {
      const { service, qbs } = setup(opts);
      for (const warehouse_kind of ['HQ', 'REGIONAL']) {
        const error = await rpcStatus(service.findAll({ warehouse_kind }));
        expect(error).toEqual({
          statusCode: 503,
          message: "Markaziy filial aniqlanmadi — qayta urinib ko'ring",
        });
      }
      expect(qbs.every((qb) => !qb.getMany.mock.calls.length)).toBe(true);
    },
  );

  it('⭐ chaqiruvchi bergan warehouse_hq_branch_id`ga ishonilmaydi — doim lookup', async () => {
    const forged = setup();
    await forged.service.findAll({
      warehouse_kind: 'HQ',
      warehouse_hq_branch_id: '999',
    });
    expect(mergedParams(forged.qbs[0]).warehouse_hq_branch_id).toBe(HQ);

    const failClosed = setup({ hq: null });
    const error = await rpcStatus(
      failClosed.service.findAll({
        warehouse_kind: 'HQ',
        warehouse_hq_branch_id: '999',
      }),
    );
    expect(error.statusCode).toBe(503);
  });

  it('fulfillment_source bilan birga — parametrlar bir-birini yozib yubormaydi (AND)', async () => {
    const { service, qbs } = setup();
    await service.findAll({
      fulfillment_source: 'HQ',
      warehouse_kind: 'HQ',
      warehouse_id: '7',
    });
    const [qb] = qbs;
    expect(mergedParams(qb)).toMatchObject({
      fulfillment_source: 'HQ',
      warehouse_kind_source: 'WAREHOUSE',
      warehouse_hq_branch_id: HQ,
      warehouse_id: '7',
    });
    const sql = andWhereSql(qb);
    expect(sql).toContain('order.fulfillment_source = :fulfillment_source');
    expect(sql).toContain('order.fulfillment_source = :warehouse_kind_source');
    expect(sql).toContain('order.warehouse_id = :warehouse_id');
  });

  it('⭐ statusCounts: findAll bilan AYNI shartlar (asosiy + bekor tabi), HQ id lookup`dan', async () => {
    const { service, qbs, getHqBranchId } = setup();
    const query = {
      branch_id: '3',
      warehouse_kind: 'REGIONAL',
      warehouse_id: '60',
    };
    await service.statusCounts({
      query,
      cancelled_query: { ...query, status: ['cancelled'] },
    });
    await service.findAll({ ...query, page: 1, limit: 10 });
    expect(getHqBranchId).toHaveBeenCalledTimes(3);
    const [base, cancelled, list] = [
      qbs.find((qb) => qb.groupBy.mock.calls.length)!,
      qbs.find(
        (qb) =>
          !qb.groupBy.mock.calls.length &&
          andWhereSql(qb).includes('order.status IN (:...statuses)'),
      )!,
      qbs[qbs.length - 1],
    ];
    for (const qb of [base, cancelled]) {
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(order.home_branch_id IS NULL OR order.home_branch_id <> :warehouse_hq_branch_id)',
        { warehouse_hq_branch_id: HQ },
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'order.warehouse_id = :warehouse_id',
        { warehouse_id: '60' },
      );
    }
    expect(andWhereSql(list)).toEqual(andWhereSql(base));
  });

  it('statusCounts: HQ id aniqlanmasa — 503 (RpcException o`zgarishsiz), noto`g`ri tur — 400', async () => {
    const down = setup({ hq: null });
    const error = await rpcStatus(
      down.service.statusCounts({ query: { warehouse_kind: 'HQ' } }),
    );
    expect(error.statusCode).toBe(503);

    const bad = setup();
    const badError = await rpcStatus(
      bad.service.statusCounts({ query: { warehouse_kind: 'ombor' } }),
    );
    expect(badError.statusCode).toBe(400);
    expect(bad.getHqBranchId).not.toHaveBeenCalled();
  });
});

describe('VkKDSNNn — marketga topshirishga tayyor bekorlar: Markaziy ombor buyurtmasi chiqariladi', () => {
  const EXCLUDE_HQ_SQL =
    '(order.fulfillment_source <> :exclude_hq_wh_source OR order.home_branch_id IS NULL OR order.home_branch_id <> :exclude_hq_wh_branch_id)';
  const EXCLUDE_ALL_SQL = 'order.fulfillment_source <> :exclude_hq_wh_source';

  it('⭐ topshirish ro`yxati (bosqichsiz) va market guruhlari — WAREHOUSE + home = HQ chiqariladi (HQ id lookup`dan)', async () => {
    const { service, qbs, getHqBranchId } = setup();
    await service.findCancelledOrdersByMarket('16', {
      holder_type: 'BRANCH' as never,
      branch_id: '12',
    });
    await service.findCancelledMarkets({ branch_id: '12' });
    expect(getHqBranchId).toHaveBeenCalledTimes(2);
    for (const qb of qbs) {
      expect(qb.andWhere).toHaveBeenCalledWith(EXCLUDE_HQ_SQL, {
        exclude_hq_wh_source: 'WAREHOUSE',
        exclude_hq_wh_branch_id: HQ,
      });
    }
  });

  it('HQ id noma`lum — barcha ombor buyurtmalari chiqariladi (topshirish ham 503); 503 emas', async () => {
    for (const hq of [null, new Error('branch down')]) {
      const { service, qbs } = setup({ hq });
      await service.findCancelledOrdersByMarket('16', {
        holder_type: 'HQ' as never,
      });
      await service.findCancelledMarkets({});
      for (const qb of qbs) {
        expect(qb.andWhere).toHaveBeenCalledWith(EXCLUDE_ALL_SQL, {
          exclude_hq_wh_source: 'WAREHOUSE',
        });
        expect(andWhereSql(qb)).not.toContain(EXCLUDE_HQ_SQL);
      }
    }
  });

  it('market bosqich ko`rinishi (stage) va oddiy GET /orders — o`zgarmagan (chiqarish yo`q)', async () => {
    const { service, qbs, getHqBranchId } = setup();
    await service.findCancelledOrdersByMarket('16', {
      stages: ['branch'] as never,
    });
    await service.findAll({ status: 'cancelled' as never });
    expect(getHqBranchId).not.toHaveBeenCalled();
    for (const qb of qbs) {
      expect(andWhereSql(qb).join(' | ')).not.toMatch(/exclude_hq_wh/);
    }
  });
});
