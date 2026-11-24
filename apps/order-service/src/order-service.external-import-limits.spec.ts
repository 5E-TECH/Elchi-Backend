/**
 * `rmqSend` — modul funksiyasi; import mijozni identity-service'da yaratadi.
 * Uni mock qilamiz, aks holda test RMQ ulanishini kutib qolardi.
 */
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: jest.fn() };
});

import { of } from 'rxjs';
import { getMetadataArgsStorage } from 'typeorm';
import { rmqSend as rmqSendFn } from '@app/common';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

const rmqSend = rmqSendFn as unknown as jest.Mock;

/**
 * SAYT IMPORTI — MASSIV `items` USTUN SIG'IMIGA KELTIRILADI.
 *
 * Saytdan kelgan `quantity: 1.5` yoki int4 ga sig'maydigan son, 255 belgidan
 * uzun nom `create()` ni yiqitardi. `receiveExternalOrders` tsikli esa
 * bittalab ketadi: yiqilgan qatorgacha buyurtmalar yaratilgan, undan keyingilari
 * yo'q, javob 400/500 — operator nima yaratilganini bilmaydi. Yiqilgan qatorning
 * mijozi `identity.customer.create` da allaqachon yaratilgan bo'ladi (yetim).
 *
 * Shu bois bu yerda `create()` MOCK QILINMAYDI: haqiqiy kod, bazaning o'rnida
 * esa ustun turini entity metama'lumotidan o'qib, Postgres kabi rad etadigan
 * soxta repo.
 */
type Row = Record<string, any>;

const columnOf = (entity: unknown, property: string) =>
  getMetadataArgsStorage().columns.find(
    (column) => column.target === entity && column.propertyName === property,
  )?.options;

/** Postgres kabi: `varchar(n)` — belgilar bo'yicha, `int` — butun va int4. */
const assertFits = (entity: unknown, row: Row) => {
  for (const [property, value] of Object.entries(row)) {
    const column = columnOf(entity, property);
    if (!column || value == null) continue;
    if (column.type === 'varchar' && column.length) {
      if (Array.from(String(value)).length > Number(column.length)) {
        throw new Error(
          `value too long for type character varying(${column.length})`,
        );
      }
    }
    if (column.type === 'int') {
      if (!Number.isInteger(value)) {
        throw new Error(`invalid input syntax for type integer: "${value}"`);
      }
      if (Math.abs(value) > 2_147_483_647) {
        throw new Error(`value "${value}" is out of range for type integer`);
      }
    }
  }
};

function makeService() {
  const orders: Row[] = [];
  const items: Row[] = [];
  let seq = 900;
  /** Tranzaksiya: rollback shu buyurtmaning qatorlarini ham qaytaradi. */
  let pending: { order?: Row; items: Row[] } = { items: [] };

  const manager = {
    getRepository: (entity: unknown) =>
      entity === Order
        ? {
            create: (value: Row) => value,
            save: (value: Row) => {
              seq += 1;
              pending.order = { product_quantity: 0, ...value, id: `${seq}` };
              return Promise.resolve(pending.order);
            },
            update: (_where: Row, patch: Row) => {
              assertFits(Order, patch);
              Object.assign(pending.order ?? {}, patch);
              return Promise.resolve();
            },
          }
        : {
            createQueryBuilder: () => ({
              insert: () => ({
                values: (rows: Row[]) => ({
                  execute: () => {
                    rows.forEach((row) => assertFits(entity, row));
                    pending.items.push(...rows);
                    return Promise.resolve();
                  },
                }),
              }),
            }),
          },
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(() => {
      pending = { items: [] };
    }),
    commitTransaction: jest.fn(() => {
      if (pending.order) orders.push(pending.order);
      items.push(...pending.items);
    }),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager,
  };

  rmqSend.mockReset();
  rmqSend.mockImplementation((_client: unknown, pattern: { cmd: string }) => {
    if (pattern.cmd === 'identity.customer.create') {
      return Promise.resolve({ data: { id: '801' } });
    }
    return Promise.reject(new Error(`kutilmagan RPC: ${pattern.cmd}`));
  });

  const service = Object.create(OrderLifecycleService.prototype) as Row;
  Object.assign(service, {
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
    orderRepo: { findOne: jest.fn().mockResolvedValue(null) },
    dataSource: { createQueryRunner: () => queryRunner },
    identityClient: {},
    branchClient: { send: jest.fn(() => of({ data: null })) },
    lookup: {
      getIntegrationById: jest.fn().mockResolvedValue({
        id: '5',
        slug: 'inhayat',
        market_id: '500',
        is_active: true,
        field_mapping: {},
      }),
      getDefaultDistrictId: jest.fn().mockResolvedValue('1'),
      resolveDistrictIdOrNull: jest.fn().mockResolvedValue('12'),
      resolveRegionIdForDistrict: jest.fn().mockResolvedValue('9'),
      getHqBranchId: jest.fn().mockResolvedValue('1'),
      getBranchAssignmentByUserStrict: jest.fn().mockResolvedValue(null),
    },
    custody: {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'system'),
      auditActor: jest.fn(() => ({})),
    },
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    captureOpenDeliveryQuote: jest.fn().mockResolvedValue(undefined),
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    findById: jest.fn((id: string) =>
      Promise.resolve(orders.find((order) => order.id === id)),
    ),
  });
  return { service, orders, items };
}

const order = (id: string, items: unknown) => ({
  id,
  phone: '+998901112233',
  total_price: 100000,
  items,
});

/** Uch buyurtma: o'rtadagisi nosoz — chetdagilar ham, o'zi ham yaratilsin. */
const importAround = async (brokenItems: unknown) => {
  const { service, orders, items } = makeService();
  const res = await service.receiveExternalOrders({
    integration_id: '5',
    orders: [
      order('A', [{ name: 'Soat', quantity: 2 }]),
      order('B', brokenItems),
      order('C', [{ name: 'Kamar', quantity: 1 }]),
    ],
  });
  const broken = orders.find((row) => row.external_id === 'B');
  return {
    res,
    orders,
    broken,
    brokenItems: items
      .filter((item) => item.order_id === broken?.id)
      .map(({ product_id, product_name, quantity }) => ({
        product_id,
        product_name,
        quantity,
      })),
    customers: rmqSend.mock.calls.length,
  };
};

describe("⭐ massiv `items` ustun sig'imiga keltiriladi — partiya uzilmaydi", () => {
  it('soxta baza chegarani haqiqiy ustundan oladi (aks holda spec hech narsani ko`rmaydi)', () => {
    expect(columnOf(OrderItem, 'product_name')).toMatchObject({
      type: 'varchar',
      length: 255,
    });
    expect(columnOf(OrderItem, 'quantity')?.type).toBe('int');
    expect(columnOf(Order, 'product_quantity')?.type).toBe('int');
  });

  it.each([
    ['kasr son', 1.5],
    ['kasr son (matn)', '2.5'],
    ['1 dan kichik kasr', 0.4],
    ['int4 dan katta', 2_147_483_648],
    ['shtrix-kod son maydonida', '4780012345678'],
    ['juda katta', 1e300],
  ])(
    '⭐ %s — qator 1 dona bilan yoziladi, uchala buyurtma ham yaratiladi',
    async (_label, quantity) => {
      const h = await importAround([{ name: 'Gilam', quantity }]);

      expect(h.orders.map((row) => row.external_id)).toEqual(['A', 'B', 'C']);
      expect(h.res.data.created).toHaveLength(3);
      expect(h.res.data.skipped).toEqual([]);
      // Yetim mijoz yo'q: har mijozga bitta buyurtma.
      expect(h.customers).toBe(3);
      expect(h.brokenItems).toEqual([
        { product_id: null, product_name: 'Gilam', quantity: 1 },
      ]);
      expect(h.broken?.product_quantity).toBe(1);
    },
  );

  it('⭐ 255 belgidan uzun nom kesiladi, uchala buyurtma ham yaratiladi', async () => {
    const h = await importAround([
      { name: `${'a'.repeat(255)}ortiqcha`, quantity: 3 },
    ]);

    expect(h.orders.map((row) => row.external_id)).toEqual(['A', 'B', 'C']);
    expect(h.customers).toBe(3);
    expect(h.brokenItems).toEqual([
      { product_id: null, product_name: 'a'.repeat(255), quantity: 3 },
    ]);
  });

  it('nom BELGILAR bo`yicha kesiladi — emoji yarmidan bo`linmaydi', async () => {
    const h = await importAround([
      { name: `${'a'.repeat(254)}🎁🎁`, quantity: 1 },
    ]);

    expect(h.brokenItems[0].product_name).toBe(`${'a'.repeat(254)}🎁`);
  });

  it('⭐ sonlar YIG`INDISI ham sig`adi (`orders.product_quantity` — int4)', async () => {
    const h = await importAround([
      { name: 'A', quantity: 2_000_000_000 },
      { name: 'B', quantity: 2_000_000_000 },
      { name: 'C', quantity: 5 },
    ]);

    expect(h.orders.map((row) => row.external_id)).toEqual(['A', 'B', 'C']);
    expect(h.brokenItems.map((item) => item.quantity)).toEqual([
      2_000_000_000, 1, 5,
    ]);
  });

  it('sig`adigan qatorlar O`ZGARMAYDI: 255 belgi, int4 chegarasi, sonli matn', async () => {
    const name = 'ё'.repeat(255);
    const h = await importAround([
      { name, quantity: 2_147_483_646 },
      { name: 'B', quantity: '1' },
    ]);

    expect(h.brokenItems).toEqual([
      { product_id: null, product_name: name, quantity: 2_147_483_646 },
      { product_id: null, product_name: 'B', quantity: 1 },
    ]);
    expect(h.broken?.product_quantity).toBe(2_147_483_647);
  });

  it('nom ichidagi bo`shliqlar saqlanadi (massiv yo`li matn kabi siqilmaydi)', async () => {
    const h = await importAround([{ name: '  Soat  qora ', quantity: 1 }]);

    expect(h.brokenItems[0].product_name).toBe('Soat  qora');
  });
});
