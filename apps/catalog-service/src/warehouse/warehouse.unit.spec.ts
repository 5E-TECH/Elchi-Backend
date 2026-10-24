import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import {
  warehouseChargeableWeight,
  warehouseDisplayCode,
  warehouseStockLevel,
} from '@app/common';
import { WarehouseController } from './warehouse.controller';
import { WarehouseDirectoryService } from './warehouse-directory.service';
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
 * boshqa servislar javobini o'qish (filial yaroqliligi, tuman → hudud,
 * market kaliti). DB oqimlari — `warehouse.pg.spec.ts`.
 */
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

  it('⭐ filial yaroqliligi: faqat FAOL REGIONAL/HYBRID; HQ/PICKUP/nofaol — yo`q', async () => {
    for (const [type, status, eligible] of [
      ['REGIONAL', 'active', true],
      ['HYBRID', 'active', true],
      ['HQ', 'active', false],
      ['PICKUP', 'active', false],
      ['REGIONAL', 'inactive', false],
    ] as const) {
      const { service } = make({
        'branch.find_by_id': () => ({
          data: {
            id: '11',
            name: 'F',
            type,
            status,
            region: { id: '7', name: 'Samarqand' },
          },
        }),
      });
      await expect(service.getBranch('11')).resolves.toMatchObject({
        eligible,
        region_id: '7',
        region: { id: '7', name: 'Samarqand' },
      });
    }
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
