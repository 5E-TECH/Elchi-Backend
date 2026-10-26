import { RpcException } from '@nestjs/microservices';
import { isObservable, of, Subject, throwError } from 'rxjs';
import {
  warehouseChargeableWeight,
  warehouseDisplayCode,
  warehouseStockLevel,
} from '@app/common';
import { WarehouseController } from './warehouse.controller';
import {
  HQ_ID_READ_WAIT_MS,
  WarehouseDirectoryService,
} from './warehouse-directory.service';
import { WarehouseService } from './warehouse.service';
import {
  normalizeActor,
  normalizeOrderItems,
  normalizeStockLines,
  requireIdempotencyKey,
  returnedRows,
} from './warehouse.util';

/**
 * hY7uacJu — ombor modulining sof qismlari (DB'siz): «Hisob vazni», holat,
 * kod yorlig'i, kirish normalizatsiyasi, RMQ `scope` (fail-closed) va
 * boshqa servislar javobini o'qish (filial yaroqliligi — ombor ochish va
 * viloyat nomzodi, HQ id, tuman → hudud, market kaliti). DB oqimlari — `warehouse.pg.spec.ts`.
 */
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const rpc = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as Record<string, unknown>;
  }
  throw new Error('xato kutilgan edi');
};

describe('hY7uacJu — ombor yordamchilari', () => {
  it('⭐ hisob vazni = max(og`irlik, U×K×B/5000); hajm o`chiq — faqat og`irlik', () => {
    expect(
      warehouseChargeableWeight({
        weight_kg: 30,
        length_cm: 60,
        width_cm: 60,
        height_cm: 85,
      }),
    ).toEqual({
      chargeable_weight_kg: 61.2,
      volumetric_weight_kg: 61.2,
      chargeable_basis: 'volumetric',
      measure_missing: false,
    });
    expect(
      warehouseChargeableWeight({
        weight_kg: '0.4',
        length_cm: 10,
        width_cm: 5,
        height_cm: 2,
      }),
    ).toMatchObject({ chargeable_weight_kg: 0.4, chargeable_basis: 'actual' });
    expect(
      warehouseChargeableWeight({
        weight_kg: 2,
        length_cm: 60,
        width_cm: 60,
        height_cm: 85,
        volumetric_enabled: false,
      }),
    ).toMatchObject({ chargeable_weight_kg: 2, volumetric_weight_kg: null });
    expect(warehouseChargeableWeight({})).toEqual({
      chargeable_weight_kg: null,
      volumetric_weight_kg: null,
      chargeable_basis: null,
      measure_missing: true,
    });
    expect(
      warehouseChargeableWeight({ length_cm: 50, width_cm: 50, height_cm: 50 }),
    ).toMatchObject({ chargeable_weight_kg: 25, measure_missing: true });
  });

  it('AQ9lkgVB: «Hisob vazni» hajm chegarasiz — chegara faqat jo`natma yig`indisida (narx dvigateli)', () => {
    // 20×20×20 sm, 0,5 kg: bitta dona hajmli 1,6 kg. Chegara 3 da 1 donali
    // buyurtma og'irlik bo'yicha, 2 donali (3,2 kg) hajm bo'yicha — bitta
    // dona ko'rinishi buni aks ettira olmaydi, shuning uchun chegarasiz.
    expect(
      warehouseChargeableWeight({
        weight_kg: 0.5,
        length_cm: 20,
        width_cm: 20,
        height_cm: 20,
      }),
    ).toEqual({
      chargeable_weight_kg: 1.6,
      volumetric_weight_kg: 1.6,
      chargeable_basis: 'volumetric',
      measure_missing: false,
    });
    // Og'irlik yo'q, hajm kichik — hajm qiymati ko'rsatiladi (null emas).
    expect(
      warehouseChargeableWeight({ length_cm: 20, width_cm: 20, height_cm: 20 }),
    ).toEqual({
      chargeable_weight_kg: 1.6,
      volumetric_weight_kg: 1.6,
      chargeable_basis: 'volumetric',
      measure_missing: true,
    });
  });

  it('holat MAVJUD bo`yicha: ≤0 — out, ≤ chegara — low, aks holda ok', () => {
    expect(warehouseStockLevel(0, 10)).toBe('out');
    expect(warehouseStockLevel(5, 5)).toBe('low');
    expect(warehouseStockLevel(10, 3)).toBe('ok');
  });

  it('kod yorlig`i: zavod kodi ustun, aks holda ELC-P', () => {
    expect(
      warehouseDisplayCode({
        barcode: '8806095501239',
        sku_code: 'ELC-P-000001',
      }),
    ).toEqual({
      value: '8806095501239',
      kind: 'barcode',
      format: 'EAN-13',
    });
    expect(
      warehouseDisplayCode({ barcode: null, sku_code: 'ELC-P-000142' }),
    ).toEqual({
      value: 'ELC-P-000142',
      kind: 'sku',
      format: 'ELC',
    });
    expect(
      warehouseDisplayCode({ barcode: 'https://qr.example/x' }).format,
    ).toBe('TEXT');
  });

  it('kirim qatorlari: product_id YOKI code, butun son; noto`g`ri — 400', () => {
    expect(
      normalizeStockLines([{ code: ' ELC-P-1 ', qty: '3' }], 'qty', 1),
    ).toEqual([{ index: 0, product_id: null, code: 'ELC-P-1', value: 3 }]);
    expect(rpc(() => normalizeStockLines([], 'qty', 1))).toMatchObject({
      statusCode: 400,
    });
    expect(
      rpc(() => normalizeStockLines([{ qty: 1 }], 'qty', 1)),
    ).toMatchObject({ statusCode: 400 });
    expect(
      rpc(() =>
        normalizeStockLines([{ product_id: '1', code: 'x', qty: 1 }], 'qty', 1),
      ),
    ).toMatchObject({ statusCode: 400 });
    expect(
      rpc(() => normalizeStockLines([{ product_id: '1', qty: 0 }], 'qty', 1)),
    ).toMatchObject({
      statusCode: 400,
    });
    expect(
      normalizeStockLines([{ product_id: '1', counted: 0 }], 'counted', 0)[0]
        .value,
    ).toBe(0);
  });

  it('buyurtma qatorlari: bir mahsulot qo`shiladi, id bo`yicha tartib (qulf tartibi)', () => {
    expect(
      normalizeOrderItems([
        { product_id: '10', quantity: 1 },
        { product_id: '9', quantity: 2 },
        { product_id: '10', quantity: 3 },
      ]),
    ).toEqual([
      { product_id: '9', quantity: 2 },
      { product_id: '10', quantity: 4 },
    ]);
    expect(normalizeOrderItems(undefined)).toEqual([]);
    expect(
      rpc(() => normalizeOrderItems([{ product_id: 'abc', quantity: 1 }])),
    ).toMatchObject({
      statusCode: 400,
    });
  });

  it('Idempotency-Key shakli; aktyor — faqat raqamli id', () => {
    expect(requireIdempotencyKey('550e8400-e29b-41d4')).toBe(
      '550e8400-e29b-41d4',
    );
    expect(rpc(() => requireIdempotencyKey('short'))).toMatchObject({
      statusCode: 400,
    });
    expect(rpc(() => requireIdempotencyKey(undefined))).toMatchObject({
      statusCode: 400,
    });
    expect(normalizeActor({ id: 'system', roles: ['superadmin'] })).toEqual({
      id: null,
      role: 'superadmin',
    });
    expect(normalizeActor({ id: 77, role: 'Courier' })).toEqual({
      id: '77',
      role: 'courier',
    });
  });

  it('UPDATE … RETURNING natijasi ([rows, count]) va oddiy qatorlar', () => {
    expect(returnedRows([[{ id: 1 }], 1])).toEqual([{ id: 1 }]);
    expect(returnedRows([[], 0])).toEqual([]);
    expect(returnedRows([{ id: 2 }])).toEqual([{ id: 2 }]);
  });
});

describe('hY7uacJu — WarehouseController scope', () => {
  const controller = new WarehouseController(
    { ack: jest.fn(), nackForError: jest.fn() } as never,
    {
      findAll: jest.fn((query: unknown, scope: unknown) => ({ query, scope })),
    } as never,
    {} as never,
  );
  const context = { getPattern: () => 'catalog.warehouse.find_all' } as never;

  it('⭐ scope yo`q — cheklovsiz; to`g`ri — o`tadi; bo`sh/noto`g`ri — 403 (fail-closed)', async () => {
    await expect(controller.findAll({ query: {} }, context)).resolves.toEqual({
      query: {},
      scope: null,
    });
    await expect(
      controller.findAll({ query: {}, scope: { branch_id: '11' } }, context),
    ).resolves.toEqual({ query: {}, scope: { branch_id: '11' } });
    for (const scope of [{}, { branch_id: '' }, { branch_id: 'x' }]) {
      const error: unknown = await controller
        .findAll({ query: {}, scope }, context)
        .catch((e: unknown) => e);
      expect((error as RpcException).getError()).toMatchObject({
        statusCode: 403,
      });
    }
  });
});

describe('hY7uacJu — WarehouseDirectoryService', () => {
  const make = (handlers: Record<string, () => unknown>) => {
    const client = {
      send: jest.fn((pattern: { cmd: string }) => {
        const handler = handlers[pattern.cmd];
        if (!handler) return throwError(() => new Error(`no ${pattern.cmd}`));
        const value = handler();
        if (isObservable(value)) return value;
        return value instanceof Error ? throwError(() => value) : of(value);
      }),
    };
    return {
      client,
      service: new WarehouseDirectoryService(
        client as never,
        client as never,
        client as never,
      ),
    };
  };

  it('⭐ Pa1KaXmj: ombor ochish — FAOL REGIONAL/HYBRID/HQ; viloyat nomzodi — faqat REGIONAL/HYBRID (HQ hech qachon); PICKUP/nofaol — yo`q', async () => {
    for (const [type, status, deleted, can_host_warehouse, regional, is_hq] of [
      ['REGIONAL', 'active', false, true, true, false],
      ['HYBRID', 'active', false, true, true, false],
      ['HQ', 'active', false, true, false, true],
      ['HQ', 'inactive', false, false, false, true],
      ['HQ', 'active', true, false, false, true],
      ['PICKUP', 'active', false, false, false, false],
      ['REGIONAL', 'inactive', false, false, false, false],
    ] as const) {
      const { service } = make({
        'branch.find_by_id': () => ({
          data: {
            id: '11',
            name: 'F',
            type,
            status,
            is_deleted: deleted,
            region: { id: '7', name: 'Samarqand' },
          },
        }),
      });
      const branch = await service.getBranch('11');
      expect(branch).toMatchObject({
        can_host_warehouse,
        regional,
        is_hq,
        region_id: '7',
        region: { id: '7', name: 'Samarqand' },
      });
      expect(branch).not.toHaveProperty('eligible');
    }
  });

  it('⭐ Pa1KaXmj: HQ filial id — `branch.find_hq` dan; topilgani MUDDATSIZ keshda (HQ turi qulflangan, tizimda bitta)', async () => {
    const { service, client } = make({
      'branch.find_hq': () => ({
        statusCode: 200,
        data: { id: 1, type: 'HQ' },
      }),
    });
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await expect(service.getHqBranchId()).resolves.toBe('1');
      // Bir soatdan keyin ham — RPC'siz (avval 5 daqiqalik TTL bor edi).
      now.mockReturnValue(1_000 + 60 * 60_000);
      await expect(service.getHqBranchId()).resolves.toBe('1');
      await expect(service.getHqBranchId({ maxWaitMs: 0 })).resolves.toBe('1');
      expect(client.send).toHaveBeenCalledTimes(1);
      expect(client.send).toHaveBeenCalledWith({ cmd: 'branch.find_hq' }, {});
    } finally {
      now.mockRestore();
    }
  });

  it('⭐ Pa1KaXmj: HQ id topilmasa (404) yoki servis javob bermasa — null va 30 s qayta so`ralmaydi (har o`qish RPC kutmasin)', async () => {
    for (const failure of [
      () => Object.assign(new Error('x'), { statusCode: 404 }),
      () => new Error('timeout'),
      () => ({ data: null }),
    ]) {
      let up = false;
      const { service, client } = make({
        'branch.find_hq': () => (up ? { data: { id: '1' } } : failure()),
      });
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
      try {
        await expect(service.getHqBranchId()).resolves.toBeNull();
        now.mockReturnValue(1_000 + 29_000);
        await expect(service.getHqBranchId()).resolves.toBeNull();
        expect(client.send).toHaveBeenCalledTimes(1);
        // Backoff tugagach — qayta uriniladi, topilgani keshga tushadi.
        up = true;
        now.mockReturnValue(1_000 + 30_000);
        await expect(service.getHqBranchId()).resolves.toBe('1');
        await expect(service.getHqBranchId()).resolves.toBe('1');
        expect(client.send).toHaveBeenCalledTimes(2);
      } finally {
        now.mockRestore();
      }
    }
  });

  it('⭐ Pa1KaXmj: parallel chaqiruvlar bitta `branch.find_hq` ni ulashadi; `maxWaitMs` — osilgan RPC kutilmaydi, so`rov fonda keshni to`ldiradi', async () => {
    const reply = new Subject<unknown>();
    const { service, client } = make({ 'branch.find_hq': () => reply });

    const started = Date.now();
    const [a, b, bounded] = await Promise.all([
      Promise.race([service.getHqBranchId(), wait(60).then(() => 'pending')]),
      Promise.race([service.getHqBranchId(), wait(60).then(() => 'pending')]),
      service.getHqBranchId({ maxWaitMs: 20 }),
    ]);
    expect(bounded).toBeNull();
    expect([a, b]).toEqual(['pending', 'pending']);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(client.send).toHaveBeenCalledTimes(1);

    // Kutish tugadi, lekin so'rov tirik: javob kelgach — keshda.
    const late = service.getHqBranchId();
    reply.next({ data: { id: '1' } });
    await expect(late).resolves.toBe('1');
    await expect(service.getHqBranchId({ maxWaitMs: 0 })).resolves.toBe('1');
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('filial keshlanadi; 404 — null; yozish yo`lida servis xatosi — 503', async () => {
    const { service, client } = make({
      'branch.find_by_id': () => ({
        data: { id: '11', name: 'F', type: 'REGIONAL', status: 'active' },
      }),
    });
    await service.getBranch('11');
    await service.getBranch('11');
    expect(client.send).toHaveBeenCalledTimes(1);

    const missing = make({
      'branch.find_by_id': () =>
        Object.assign(new Error('x'), { statusCode: 404 }),
    });
    await expect(
      missing.service.getBranch('99', { strict: true }),
    ).resolves.toBeNull();

    const down = make({ 'branch.find_by_id': () => new Error('timeout') });
    const error: unknown = await down.service
      .getBranch('11', { strict: true })
      .catch((e: unknown) => e);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 503,
    });
    await expect(down.service.getBranch('12')).resolves.toBeNull();
  });

  it('tuman → hudud: avval assigned_region, keyin region_id; xatoda null', async () => {
    const assigned = make({
      'logistics.district.find_by_id': () => ({
        data: { assigned_region: '8', region_id: '7' },
      }),
    });
    await expect(assigned.service.regionForDistrict('45')).resolves.toBe('8');
    const own = make({
      'logistics.district.find_by_id': () => ({
        data: { assigned_region: null, region_id: '7' },
      }),
    });
    await expect(own.service.regionForDistrict('45')).resolves.toBe('7');
    const down = make({});
    await expect(down.service.regionForDistrict('45')).resolves.toBeNull();
    await expect(down.service.regionForDistrict('abc')).resolves.toBeNull();
  });

  it('⭐ market kaliti: faqat aniq `true`; identity javob bermasa — null (HQ)', async () => {
    const on = make({
      'identity.market.find_by_id': () => ({
        success: true,
        data: { id: '121', name: 'B', can_order_from_warehouse: true },
      }),
    });
    await expect(on.service.getMarket('121')).resolves.toMatchObject({
      can_order_from_warehouse: true,
    });
    const off = make({
      'identity.market.find_by_id': () => ({
        success: true,
        data: { id: '121', name: 'B', can_order_from_warehouse: 'yes' },
      }),
    });
    await expect(off.service.getMarket('121')).resolves.toMatchObject({
      can_order_from_warehouse: false,
    });
    const down = make({});
    await expect(down.service.getMarket('121')).resolves.toBeNull();
  });

  it('menejerlar ro`yxati — faqat MANAGER rolidagilar', async () => {
    const { service } = make({
      'branch.user.find_by_branch': () => ({
        data: [
          { user_id: '31', role: 'MANAGER' },
          { user_id: '40', role: 'COURIER' },
        ],
      }),
    });
    await expect(service.getBranchManagerIds('11')).resolves.toEqual(['31']);
  });

  it('⭐ XtcEyQjb: birinchi FAOL menejer — id bo`yicha (son sifatida); nofaol/topilmagan — o`tkaziladi; yo`q — null', async () => {
    const { service } = make({
      'branch.user.find_by_branch': () => ({
        data: [
          { user_id: '120', role: 'MANAGER', user: { status: 'active' } },
          { user_id: '9', role: 'MANAGER', user: { status: 'inactive' } },
          { user_id: '31', role: 'MANAGER', user: { status: 'active' } },
          { user_id: '5', role: 'COURIER', user: { status: 'active' } },
          { user_id: '7', role: 'MANAGER', user: null },
        ],
      }),
    });
    await expect(service.getFirstActiveBranchManagerId('11')).resolves.toBe(
      '31',
    );
    // Tanlov tekshiruvi hamma menejerlarni (nofaolini ham) ko'radi.
    await expect(service.getBranchManagerIds('11')).resolves.toEqual([
      '120',
      '9',
      '31',
      '7',
    ]);

    const none = make({
      'branch.user.find_by_branch': () => ({
        data: [{ user_id: '9', role: 'MANAGER', user: { status: 'inactive' } }],
      }),
    });
    await expect(
      none.service.getFirstActiveBranchManagerId('11'),
    ).resolves.toBeNull();

    const down = make({});
    const error: unknown = await down.service
      .getFirstActiveBranchManagerId('11')
      .catch((e: unknown) => e);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 503,
    });
  });
});

/**
 * Pa1KaXmj: asosiy invariant — Markaziy ombor (HQ) HECH QACHON
 * `resolve_source`/`availability` nomzodi emas (HQ'ning `region_id` si mos
 * kelsa ham). `warehouse.pg.spec.ts` dagi xuddi shu tekshiruv CI'da yurmaydi
 * (CATALOG_PG_TEST_URI berilmagan — skip), shuning uchun bu yerda DB'siz:
 * haqiqiy `WarehouseDirectoryService` (filial bayroqlari `toBranch` dan) +
 * soxta ombor repozitoriysi va SQL. `candidatesForRegion` filtri
 * `can_host_warehouse` ga almashtirilsa — shu testlar yiqiladi.
 */
describe('Pa1KaXmj — WarehouseService: Markaziy ombor manba nomzodi emas (DB`siz)', () => {
  const REGION = '7';
  const HQ_BRANCH = '1';
  const SAM_BRANCH = '11';
  const HQ_WH = '5';
  const SAM_WH = '6';
  const PRODUCT = '900';
  const MARKET = '121';

  const branchRows: Record<string, Record<string, unknown>> = {
    // HQ'ning ham shu hududi bor — baribir nomzod emas.
    [HQ_BRANCH]: {
      id: HQ_BRANCH,
      name: 'HQ',
      type: 'HQ',
      status: 'active',
      region: { id: REGION, name: 'Samarqand' },
    },
    [SAM_BRANCH]: {
      id: SAM_BRANCH,
      name: 'Samarqand filiali',
      type: 'REGIONAL',
      status: 'active',
      region: { id: REGION, name: 'Samarqand' },
    },
  };

  const warehouseRow = (id: string, branchId: string, status = 'ACTIVE') => ({
    id,
    name: `Ombor ${id}`,
    status,
    branch_id: branchId,
    isDeleted: false,
  });

  const make = (
    warehouses: Array<ReturnType<typeof warehouseRow>>,
    hqReply: () => unknown = () => ({ data: { id: HQ_BRANCH } }),
  ) => {
    const client = {
      send: jest.fn((pattern: { cmd: string }, payload: { id?: string }) => {
        if (pattern.cmd === 'branch.find_hq') {
          const value = hqReply();
          return isObservable(value) ? value : of(value);
        }
        if (pattern.cmd === 'branch.find_by_id') {
          const row = branchRows[String(payload?.id)];
          return row
            ? of({ data: row })
            : throwError(() =>
                Object.assign(new Error('x'), { statusCode: 404 }),
              );
        }
        return throwError(() => new Error(`no ${pattern.cmd}`));
      }),
    };
    const directory = new WarehouseDirectoryService(
      client as never,
      client as never,
      client as never,
    );
    // Har ombor shu mahsulotdan 10 dona — yetishmovchilik sabab bo'lmasin.
    const query = jest.fn((sql: string, params: unknown[]) => {
      if (sql.includes('"WarehouseStock"')) {
        return Promise.resolve([
          { product_id: PRODUCT, on_hand: 10, reserved: 0, w: params[0] },
        ]);
      }
      if (sql.includes('"Product"')) {
        return Promise.resolve([
          {
            id: PRODUCT,
            name: 'Mahsulot',
            user_id: MARKET,
            is_deleted: false,
          },
        ]);
      }
      return Promise.reject(new Error(`kutilmagan SQL: ${sql}`));
    });
    const manager = {
      query,
      connection: {
        getMetadata: (entity: { name: string }) => ({
          schema: 'catalog',
          tableName: entity.name,
        }),
      },
    };
    const repo = { find: jest.fn(() => Promise.resolve(warehouses)) };
    const service = new WarehouseService(
      repo as never,
      { manager } as never,
      directory,
      { log: jest.fn(), logChange: jest.fn() } as never,
    );
    /** Qoldig'i so'ralgan omborlar (SQL `$1`). */
    const stockQueriedFor = () =>
      query.mock.calls
        .filter(([sql]) => sql.includes('"WarehouseStock"'))
        .map(([, params]) => String(params[0]));
    return { service, client, repo, stockQueriedFor };
  };

  const resolve = (service: WarehouseService) =>
    service.resolveSource({
      region_id: REGION,
      market_id: MARKET,
      items: [{ product_id: PRODUCT, quantity: 2 }],
    });
  const availability = (service: WarehouseService) =>
    service.availability({ region_id: REGION, market_id: MARKET });

  it('⭐ hududda faqat Markaziy ombor (FAOL, qoldig`i yetarli, `region_id` mos) — NO_WAREHOUSE, `warehouse: null`', async () => {
    const { service, stockQueriedFor } = make([warehouseRow(HQ_WH, HQ_BRANCH)]);

    await expect(resolve(service)).resolves.toMatchObject({
      source: 'HQ',
      reason: 'NO_WAREHOUSE',
      region_id: REGION,
      warehouse: null,
    });
    await expect(availability(service)).resolves.toEqual({
      region_id: REGION,
      warehouse: null,
      items: [],
    });
    expect(stockQueriedFor()).toEqual([]);
  });

  it('⭐ Markaziy ombor FAOL, viloyat ombori to`xtatilgan — WAREHOUSE_PAUSED viloyat ombori bilan (HQ «birinchi FAOL» bo`lib o`tib ketmaydi)', async () => {
    const { service, stockQueriedFor } = make([
      warehouseRow(HQ_WH, HQ_BRANCH),
      warehouseRow(SAM_WH, SAM_BRANCH, 'PAUSED'),
    ]);

    await expect(resolve(service)).resolves.toMatchObject({
      source: 'HQ',
      reason: 'WAREHOUSE_PAUSED',
      warehouse: { id: SAM_WH, kind: 'REGIONAL', branch_id: SAM_BRANCH },
    });
    await expect(availability(service)).resolves.toMatchObject({
      region_id: REGION,
      warehouse: { id: SAM_WH, status: 'PAUSED', kind: 'REGIONAL' },
      items: [],
    });
    expect(stockQueriedFor()).toEqual([]);
  });

  it('⭐ ikkalasi FAOL va yetarli — faqat viloyat ombori (qoldig`i ham faqat unda so`raladi), natija o`zgarmagan', async () => {
    const { service, stockQueriedFor } = make([
      warehouseRow(HQ_WH, HQ_BRANCH),
      warehouseRow(SAM_WH, SAM_BRANCH),
    ]);

    await expect(resolve(service)).resolves.toMatchObject({
      source: 'WAREHOUSE',
      reason: 'OK',
      region_id: REGION,
      warehouse: {
        id: SAM_WH,
        kind: 'REGIONAL',
        branch_id: SAM_BRANCH,
        region_id: REGION,
      },
      shortages: [],
    });
    await expect(availability(service)).resolves.toMatchObject({
      warehouse: { id: SAM_WH, kind: 'REGIONAL' },
      items: [{ product_id: PRODUCT, available: 10 }],
    });
    expect(stockQueriedFor()).toEqual([SAM_WH, SAM_WH]);
  });

  it('⭐ find_by_ids: branch-service osilsa ham tez qaytadi (HQ id ko`pi bilan HQ_ID_READ_WAIT_MS); id kelgach `kind: HQ` — keshdan, RPC`siz', async () => {
    const reply = new Subject<unknown>();
    const { service, client } = make(
      [warehouseRow(HQ_WH, HQ_BRANCH), warehouseRow(SAM_WH, SAM_BRANCH)],
      () => reply,
    );

    const started = Date.now();
    const cold = await service.findByIds([HQ_WH, SAM_WH]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(HQ_ID_READ_WAIT_MS + 1_000);
    // Order-service timeout'i (3 s) va RPC timeout'i (5 s) dan ancha kichik.
    expect(HQ_ID_READ_WAIT_MS).toBeLessThanOrEqual(1_000);
    expect(cold.data).toEqual([
      expect.objectContaining({
        id: HQ_WH,
        kind: 'REGIONAL',
        branch_id: HQ_BRANCH,
      }),
      expect.objectContaining({ id: SAM_WH, kind: 'REGIONAL' }),
    ]);

    reply.next({ data: { id: HQ_BRANCH } });
    const hqCalls = () =>
      client.send.mock.calls.filter(([p]) => p.cmd === 'branch.find_hq').length;
    // Fondagi so'rov tugaguncha kutamiz (u bitta, ulashilgan).
    await (
      service as unknown as { directory: WarehouseDirectoryService }
    ).directory.getHqBranchId();

    const warm = await service.findByIds([HQ_WH, SAM_WH]);
    expect(warm.data.map((w) => [w.id, w.kind])).toEqual([
      [HQ_WH, 'HQ'],
      [SAM_WH, 'REGIONAL'],
    ]);
    expect(hqCalls()).toBe(1);
  });
});

/**
 * VkKDSNNn: Markaziy ombor — buyurtma manbasining 2-pog'onasi (kalit
 * `WAREHOUSE_HQ_TIER_ENABLED`). DB'siz: kalit o'qilishi va asosiy
 * invariantlar — viloyat ombori tanlansa Markaziy omborga umuman qaralmaydi,
 * kalit o'chiq bo'lsa javobda yangi maydon yo'q. To'liq oqim —
 * `warehouse.pg.spec.ts` («manba: markaziy ombor»).
 */
describe('VkKDSNNn — WarehouseService: Markaziy ombor pog`onasi (DB`siz)', () => {
  const REGION = '7';
  const FAR_REGION = '8';
  const HQ_BRANCH = '1';
  const SAM_BRANCH = '11';
  const HQ_WH = '5';
  const SAM_WH = '6';
  const PRODUCT = '900';
  const MARKET = '121';
  const BASE_KEYS = [
    'source',
    'reason',
    'region_id',
    'warehouse',
    'items',
    'shortages',
  ];

  const branchRows: Record<string, Record<string, unknown>> = {
    [HQ_BRANCH]: {
      id: HQ_BRANCH,
      name: 'HQ',
      type: 'HQ',
      status: 'active',
      region: { id: '1', name: 'Toshkent' },
    },
    [SAM_BRANCH]: {
      id: SAM_BRANCH,
      name: 'Samarqand filiali',
      type: 'REGIONAL',
      status: 'active',
      region: { id: REGION, name: 'Samarqand' },
    },
  };

  const warehouseRow = (id: string, branchId: string, status = 'ACTIVE') => ({
    id,
    name: `Ombor ${id}`,
    status,
    branch_id: branchId,
    isDeleted: false,
  });

  /**
   * `config` — ConfigService o'rnida (`undefined` — 4 arg, config yo'q).
   * `stockOf` — ombor bo'yicha qoldiq (sukut 10 dona).
   */
  const make = (
    warehouses: Array<ReturnType<typeof warehouseRow>>,
    options: {
      config?: { get: jest.Mock };
      stockOf?: Record<string, number>;
      hqReply?: () => unknown;
      /** Mahsulot egasi / o'chirilgani (sukut — MARKET, o'chirilmagan). */
      product?: { user_id?: string; is_deleted?: boolean };
      /** Filial qatorini almashtirish (masalan HQ nofaol). */
      branchOverride?: Record<string, Record<string, unknown>>;
      /** `branch.find_by_id` shu id'lar uchun xato beradi (servis uzilgan). */
      branchDown?: string[];
    } = {},
  ) => {
    const client = {
      send: jest.fn((pattern: { cmd: string }, payload: { id?: string }) => {
        if (pattern.cmd === 'branch.find_hq') {
          const value = (
            options.hqReply ?? (() => ({ data: { id: HQ_BRANCH } }))
          )();
          return isObservable(value) ? value : of(value);
        }
        if (pattern.cmd === 'branch.find_by_id') {
          if (options.branchDown?.includes(String(payload?.id))) {
            return throwError(() => new Error('branch-service uzilgan'));
          }
          const row = {
            ...branchRows,
            ...(options.branchOverride ?? {}),
          }[String(payload?.id)];
          return row
            ? of({ data: row })
            : throwError(() =>
                Object.assign(new Error('x'), { statusCode: 404 }),
              );
        }
        return throwError(() => new Error(`no ${pattern.cmd}`));
      }),
    };
    const directory = new WarehouseDirectoryService(
      client as never,
      client as never,
      client as never,
    );
    const query = jest.fn((sql: string, params: unknown[]) => {
      if (sql.includes('"WarehouseStock"')) {
        const onHand = options.stockOf?.[String(params[0])] ?? 10;
        return Promise.resolve([
          { product_id: PRODUCT, on_hand: onHand, reserved: 0 },
        ]);
      }
      if (sql.includes('"Product"')) {
        return Promise.resolve([
          {
            id: PRODUCT,
            name: 'Mahsulot',
            user_id: options.product?.user_id ?? MARKET,
            is_deleted: options.product?.is_deleted ?? false,
          },
        ]);
      }
      return Promise.reject(new Error(`kutilmagan SQL: ${sql}`));
    });
    const manager = {
      query,
      connection: {
        getMetadata: (entity: { name: string }) => ({
          schema: 'catalog',
          tableName: entity.name,
        }),
      },
    };
    const repo = {
      find: jest.fn(() => Promise.resolve(warehouses)),
      findOne: jest.fn(
        ({ where }: { where: { branch_id: string; isDeleted: boolean } }) =>
          Promise.resolve(
            warehouses.find(
              (w) => w.branch_id === where.branch_id && !w.isDeleted,
            ) ?? null,
          ),
      ),
    };
    const args = [
      repo as never,
      { manager } as never,
      directory,
      { log: jest.fn(), logChange: jest.fn() } as never,
    ] as const;
    const service = options.config
      ? new WarehouseService(...args, options.config as never)
      : new WarehouseService(...args);
    const stockQueriedFor = () =>
      query.mock.calls
        .filter(([sql]) => sql.includes('"WarehouseStock"'))
        .map(([, params]) => String(params[0]));
    const hqCalls = () =>
      client.send.mock.calls.filter(([p]) => p.cmd === 'branch.find_hq').length;
    return { service, repo, stockQueriedFor, hqCalls };
  };

  const configOf = (value: unknown) => ({ get: jest.fn(() => value) });
  const enabled = (service: WarehouseService) =>
    (service as unknown as { hqTierEnabled(): boolean }).hqTierEnabled();
  const resolve = (service: WarehouseService, region = REGION, quantity = 2) =>
    service.resolveSource({
      region_id: region,
      market_id: MARKET,
      items: [{ product_id: PRODUCT, quantity }],
    });

  it('⭐ kalit: boolean yoki satr true/1/yes (katta-kichik harf, bo`shliq farqsiz); qolgani va config yo`q — o`chiq', () => {
    for (const value of [true, 'true', 'TRUE', ' Yes ', '1', 'yes']) {
      const config = configOf(value);
      expect(enabled(make([], { config }).service)).toBe(true);
      expect(config.get).toHaveBeenCalledWith('WAREHOUSE_HQ_TIER_ENABLED');
    }
    for (const value of [
      false,
      'false',
      '0',
      'no',
      '',
      'on',
      'y',
      undefined,
      null,
      1,
      {},
    ]) {
      expect(enabled(make([], { config: configOf(value) }).service)).toBe(
        false,
      );
    }
    // Mavjud spec'lar kabi 4 arg — config yo'q, o'chiq.
    expect(enabled(make([]).service)).toBe(false);
  });

  it('⭐ kalit yoqiq, viloyat omborida yetarli — natija kalit o`chiq bilan AYNAN bir xil; HQ id, Markaziy ombor va uning qoldig`iga qaralmaydi', async () => {
    const warehouses = [
      warehouseRow(HQ_WH, HQ_BRANCH),
      warehouseRow(SAM_WH, SAM_BRANCH),
    ];
    const on = make(warehouses, { config: configOf(true) });
    const off = make(warehouses);

    const result = await resolve(on.service);
    expect(result).toEqual(await resolve(off.service));
    expect(result).toMatchObject({
      source: 'WAREHOUSE',
      reason: 'OK',
      warehouse: { id: SAM_WH, kind: 'REGIONAL' },
    });
    expect(Object.keys(result)).toEqual(BASE_KEYS);
    expect(on.hqCalls()).toBe(0);
    expect(on.repo.findOne).not.toHaveBeenCalled();
    expect(on.stockQueriedFor()).toEqual([SAM_WH]);
  });

  it('⭐ kalit o`chiq — viloyat ombori yo`q/yetmasa ham javob 1-bosqichdagidek (yangi maydon yo`q, Markaziy omborga qaralmaydi)', async () => {
    for (const warehouses of [
      [warehouseRow(HQ_WH, HQ_BRANCH)],
      [warehouseRow(HQ_WH, HQ_BRANCH), warehouseRow(SAM_WH, SAM_BRANCH)],
    ]) {
      for (const config of [undefined, configOf(false), configOf('0')]) {
        const off = make(warehouses, { config, stockOf: { [SAM_WH]: 1 } });
        const result = await resolve(off.service);
        expect(result.source).toBe('HQ');
        expect(Object.keys(result)).toEqual(BASE_KEYS);
        expect(off.hqCalls()).toBe(0);
        expect(off.repo.findOne).not.toHaveBeenCalled();
        expect(off.stockQueriedFor()).not.toContain(HQ_WH);
        const availability = await off.service.availability({
          region_id: REGION,
          market_id: MARKET,
        });
        expect(Object.keys(availability)).toEqual([
          'region_id',
          'warehouse',
          'items',
        ]);
      }
    }
  });

  it('⭐ kalit yoqiq: viloyat ombori yo`q — Markaziy ombor (`kind: HQ`), viloyat sababi `regional_*` da', async () => {
    const { service, stockQueriedFor } = make(
      [warehouseRow(HQ_WH, HQ_BRANCH), warehouseRow(SAM_WH, SAM_BRANCH)],
      { config: configOf('true') },
    );
    await expect(resolve(service, FAR_REGION)).resolves.toEqual({
      source: 'WAREHOUSE',
      reason: 'OK',
      region_id: FAR_REGION,
      warehouse: {
        id: HQ_WH,
        name: `Ombor ${HQ_WH}`,
        status: 'ACTIVE',
        kind: 'HQ',
        branch_id: HQ_BRANCH,
        branch_name: 'HQ',
        region_id: '1',
        region_name: 'Toshkent',
      },
      items: [
        {
          product_id: PRODUCT,
          name: 'Mahsulot',
          required: 2,
          available: 10,
          enough: true,
        },
      ],
      shortages: [],
      regional_reason: 'NO_WAREHOUSE',
      regional_warehouse: null,
      regional_shortages: [],
    });
    expect(stockQueriedFor()).toEqual([HQ_WH]);
  });

  it('⭐ kalit yoqiq, HQ id kelmasa (branch-service osilgan) — tez NO_HQ_WAREHOUSE (fail-closed), viloyat natijasi o`zgarmagan', async () => {
    const reply = new Subject<unknown>();
    const { service, repo, stockQueriedFor } = make(
      [warehouseRow(HQ_WH, HQ_BRANCH)],
      { config: configOf(true), hqReply: () => reply },
    );
    const started = Date.now();
    await expect(resolve(service)).resolves.toEqual({
      source: 'HQ',
      reason: 'NO_WAREHOUSE',
      region_id: REGION,
      warehouse: null,
      items: [],
      shortages: [],
      hq_reason: 'NO_HQ_WAREHOUSE',
    });
    expect(Date.now() - started).toBeLessThan(HQ_ID_READ_WAIT_MS + 1_000);
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(stockQueriedFor()).toEqual([]);

    // Fondagi so'rov tugagach (id keshda) — Markaziy ombor tanlanadi.
    reply.next({ data: { id: HQ_BRANCH } });
    await (
      service as unknown as { directory: WarehouseDirectoryService }
    ).directory.getHqBranchId();
    await expect(resolve(service)).resolves.toMatchObject({
      source: 'WAREHOUSE',
      warehouse: { id: HQ_WH, kind: 'HQ' },
      regional_reason: 'NO_WAREHOUSE',
    });
  });

  // --- 2-pog'ona RAD etish shoxlari (CI pg spec'larni o'tkazib yuboradi) ---

  const TIER_KEYS = [
    'regional_reason',
    'regional_warehouse',
    'regional_shortages',
    'hq_reason',
    'hq_warehouse',
    'hq_shortages',
  ];
  const hqView = (status = 'ACTIVE') => ({
    id: HQ_WH,
    name: `Ombor ${HQ_WH}`,
    status,
    kind: 'HQ',
    branch_id: HQ_BRANCH,
    branch_name: 'HQ',
    region_id: '1',
    region_name: 'Toshkent',
  });
  /** Viloyat ombori yo'q hudud (FAR) — 1-pog'ona natijasi. */
  const noRegional = {
    source: 'HQ',
    reason: 'NO_WAREHOUSE',
    region_id: FAR_REGION,
    warehouse: null,
    items: [],
    shortages: [],
  };

  it('⭐ Markaziy ombor TO`XTATILGAN — HQ_WAREHOUSE_PAUSED + hq_warehouse; qoldiq/mahsulot o`qilmaydi', async () => {
    const { service, stockQueriedFor } = make(
      [warehouseRow(HQ_WH, HQ_BRANCH, 'PAUSED')],
      { config: configOf(true) },
    );
    await expect(resolve(service, FAR_REGION)).resolves.toEqual({
      ...noRegional,
      hq_reason: 'HQ_WAREHOUSE_PAUSED',
      hq_warehouse: hqView('PAUSED'),
    });
    expect(stockQueriedFor()).toEqual([]);
  });

  it('⭐ Markaziyda ham yetmaydi — viloyat natijasi + HQ_INSUFFICIENT_STOCK, hq_warehouse, hq_shortages', async () => {
    const { service, stockQueriedFor } = make(
      [warehouseRow(HQ_WH, HQ_BRANCH), warehouseRow(SAM_WH, SAM_BRANCH)],
      { config: configOf(true), stockOf: { [SAM_WH]: 1, [HQ_WH]: 1 } },
    );
    const result = await resolve(service, REGION, 2);
    expect(result).toMatchObject({
      source: 'HQ',
      reason: 'INSUFFICIENT_STOCK',
      region_id: REGION,
      warehouse: { id: SAM_WH, kind: 'REGIONAL' },
      shortages: [
        { product_id: PRODUCT, name: 'Mahsulot', required: 2, available: 1 },
      ],
      hq_reason: 'HQ_INSUFFICIENT_STOCK',
      hq_warehouse: hqView(),
      hq_shortages: [
        { product_id: PRODUCT, name: 'Mahsulot', required: 2, available: 1 },
      ],
    });
    expect(result).not.toHaveProperty('regional_reason');
    expect(stockQueriedFor()).toEqual([SAM_WH, HQ_WH]);
  });

  it('⭐ 2-pog`onada begona yoki o`chirilgan mahsulot — PRODUCT_INVALID (invalid_product_ids), pog`ona kalitlarisiz; Markaziy qoldig`i o`qilmaydi', async () => {
    for (const product of [{ user_id: '999' }, { is_deleted: true }]) {
      const { service, stockQueriedFor } = make(
        [warehouseRow(HQ_WH, HQ_BRANCH)],
        { config: configOf(true), product },
      );
      const result = await resolve(service, FAR_REGION);
      expect(result).toEqual({
        source: 'HQ',
        reason: 'PRODUCT_INVALID',
        region_id: FAR_REGION,
        warehouse: null,
        items: [],
        shortages: [],
        invalid_product_ids: [PRODUCT],
      });
      for (const key of TIER_KEYS) expect(result).not.toHaveProperty(key);
      expect(stockQueriedFor()).toEqual([]);
    }
  });

  it('⭐ NO_HQ_WAREHOUSE (fail-closed): HQ filiali olinmadi, nofaol, `find_hq` HQ bo`lmagan (omborli) filial, Markaziy ombor yo`q', async () => {
    const cases: Array<Parameters<typeof make>> = [
      // branch-service HQ filialini bermadi.
      [
        [warehouseRow(HQ_WH, HQ_BRANCH)],
        { config: configOf(true), branchDown: [HQ_BRANCH] },
      ],
      // HQ filiali nofaol — ombor ochishga yaroqsiz.
      [
        [warehouseRow(HQ_WH, HQ_BRANCH)],
        {
          config: configOf(true),
          branchOverride: {
            [HQ_BRANCH]: { ...branchRows[HQ_BRANCH], status: 'inactive' },
          },
        },
      ],
      // `find_hq` viloyat filialini qaytardi — o'sha filialda qoldiqli FAOL
      // ombor BOR, lekin u Markaziy emas (is_hq tekshiruvi).
      [
        [warehouseRow(SAM_WH, SAM_BRANCH)],
        {
          config: configOf(true),
          hqReply: () => ({ data: { id: SAM_BRANCH } }),
        },
      ],
      // HQ aniq, lekin Markaziy ombor ochilmagan.
      [[], { config: configOf(true) }],
    ];
    for (const [warehouses, options] of cases) {
      const { service, stockQueriedFor } = make(warehouses, options);
      await expect(resolve(service, FAR_REGION)).resolves.toEqual({
        ...noRegional,
        hq_reason: 'NO_HQ_WAREHOUSE',
      });
      expect(stockQueriedFor()).toEqual([]);
    }
  });

  it('⭐ availability (kalit yoqiq): Markaziy ombor FAOL — hq_warehouse + hq_items; to`xtatilgan/yo`q — qo`shimcha maydon yo`q', async () => {
    const active = make(
      [warehouseRow(HQ_WH, HQ_BRANCH), warehouseRow(SAM_WH, SAM_BRANCH)],
      { config: configOf(true), stockOf: { [HQ_WH]: 7 } },
    );
    await expect(
      active.service.availability({ region_id: REGION, market_id: MARKET }),
    ).resolves.toEqual({
      region_id: REGION,
      warehouse: expect.objectContaining({ id: SAM_WH, kind: 'REGIONAL' }),
      items: [{ product_id: PRODUCT, on_hand: 10, reserved: 0, available: 10 }],
      hq_warehouse: hqView(),
      hq_items: [
        { product_id: PRODUCT, on_hand: 7, reserved: 0, available: 7 },
      ],
    });

    for (const warehouses of [
      [warehouseRow(HQ_WH, HQ_BRANCH, 'PAUSED')],
      [warehouseRow(SAM_WH, SAM_BRANCH)],
    ]) {
      const { service } = make(warehouses, { config: configOf(true) });
      const result = await service.availability({
        region_id: REGION,
        market_id: MARKET,
      });
      expect(Object.keys(result)).toEqual(['region_id', 'warehouse', 'items']);
    }
  });
});
