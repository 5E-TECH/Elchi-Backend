/**
 * `rmqSend` — modul funksiyasi; import mijozni identity-service'da yaratadi.
 * Uni mock qilamiz, aks holda test RMQ ulanishini kutib qolardi.
 */
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: jest.fn() };
});

import { of, TimeoutError } from 'rxjs';
import { getMetadataArgsStorage } from 'typeorm';
import { normalizePersonName, rmqSend as rmqSendFn } from '@app/common';
import { User } from '../../identity-service/src/entities/user.entity';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

const rmqSend = rmqSendFn as unknown as jest.Mock;

/**
 * SAYT IMPORTI — BITTA NOSOZ QATOR PARTIYANI UZMASIN.
 *
 * `receiveExternalOrders` tsikli bittalab ketadi: qator yiqilsa, undan oldingi
 * buyurtmalar yaratilgan, keyingilari yo'q, javob 400/409/500 — operator nima
 * yaratilganini bilmaydi. Yiqilgan (yoki rad etilgan) qatorning mijozi esa
 * `identity.customer.create` da allaqachon yaratilgan / yangilangan bo'ladi.
 *
 * Uch manba: massiv `items` (kasr / int4 dan katta son, uzun nom), narx
 * (`numeric(14,2)` ga sig'maydi), mijoz (telefon xodimniki, uzun ism / manzil /
 * qo'shimcha raqam).
 *
 * Shu bois bu yerda `create()` MOCK QILINMAYDI: haqiqiy kod, bazaning o'rnida
 * esa ustun turini entity metama'lumotidan o'qib, Postgres kabi rad etadigan
 * soxta repo; identity ham `users` ustunlari bilan shunday rad etadi.
 */
type Row = Record<string, any>;

const columnOf = (entity: unknown, property: string) =>
  getMetadataArgsStorage().columns.find(
    (column) => column.target === entity && column.propertyName === property,
  )?.options;

/**
 * Postgres kabi: `varchar(n)` — belgilar bo'yicha, `int` — butun va int4,
 * `numeric(p,s)` — s xonagacha yaxlitlab, 10^(p-s) dan kichik.
 */
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
    if (column.type === 'numeric') {
      const limit = 10 ** (Number(column.precision) - Number(column.scale));
      if (Math.abs(Number(Number(value).toFixed(column.scale))) >= limit) {
        throw new Error('numeric field overflow');
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

/** Boshqa servis xatosi `Error` emas, oddiy obyekt (`rmq-client.helper.ts`). */
const rpcError = (payload: Error) => Promise.reject(payload);

/** Xodimning raqami: identity mijoz yaratmaydi — 409. */
const STAFF_PHONE = '+998907777777';

function makeService() {
  const orders: Row[] = [];
  const items: Row[] = [];
  /** identity'da yaratilgan / yangilangan mijozlar. */
  const customers: Row[] = [];
  let seq = 900;
  /** Tranzaksiya: rollback shu buyurtmaning qatorlarini ham qaytaradi. */
  let pending: { order?: Row; items: Row[] } = { items: [] };

  const manager = {
    getRepository: (entity: unknown) =>
      entity === Order
        ? {
            create: (value: Row) => value,
            save: (value: Row) => {
              assertFits(Order, value);
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
  rmqSend.mockImplementation(
    (_client: unknown, pattern: { cmd: string }, payload: { dto: Row }) => {
      if (pattern.cmd !== 'identity.customer.create') {
        return Promise.reject(new Error(`kutilmagan RPC: ${pattern.cmd}`));
      }
      const { name, phone_number, extra_number, address } = payload.dto;
      if (phone_number === STAFF_PHONE) {
        return rpcError({
          statusCode: 409,
          message: 'Bu telefon band',
        } as Row as Error);
      }
      const row = {
        name: normalizePersonName(String(name)),
        phone_number,
        extra_number,
        address,
      };
      try {
        assertFits(User, row);
      } catch {
        return rpcError({
          status: 'error',
          message: 'Internal server error',
        } as Row as Error);
      }
      customers.push(row);
      return Promise.resolve({ data: { id: '801' } });
    },
  );

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
      resolveExternalDistrict: jest
        .fn()
        .mockResolvedValue({ id: '12', sato_code: null }),
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
  return { service, orders, items, customers };
}

const order = (id: string, items: unknown) => ({
  id,
  phone: '+998901112233',
  total_price: 100000,
  items,
});

/** Uch buyurtma: o'rtadagisi nosoz, chetdagilari butun. */
const importBroken = async (
  broken: Row,
  prepare?: (service: Row) => void,
  options?: { strict?: boolean },
) => {
  const harness = makeService();
  prepare?.(harness.service);
  const res = await harness.service.receiveExternalOrders({
    integration_id: '5',
    orders: [
      order('A', [{ name: 'Soat', quantity: 2 }]),
      { ...order('B', [{ name: 'Gilam', quantity: 1 }]), ...broken },
      order('C', [{ name: 'Kamar', quantity: 1 }]),
    ],
    options,
  });
  return { ...harness, res };
};

/** Nosoz `items`: chetdagilar ham, o'zi ham yaratilsin. */
const importAround = async (brokenItems: unknown) => {
  const { res, orders, items } = await importBroken({ items: brokenItems });
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

describe("⭐ narx `numeric(14,2)` ga sig'masa — qator tashlanadi, partiya uzilmaydi", () => {
  it('soxta baza chegarani haqiqiy ustundan oladi', () => {
    expect(columnOf(Order, 'total_price')).toMatchObject({
      type: 'numeric',
      precision: 14,
      scale: 2,
    });
  });

  it.each([
    ['1e15', { total_price: 1e15 }],
    ['matn', { total_price: '1000000000000000' }],
    ['chegaraning o`zi', { total_price: 1e12 }],
    ['yaxlitlansa chegaraga chiqadi', { total_price: 999_999_999_999.999 }],
    ['yetkazish narxi', { delivery_price: 1e13 }],
    [
      'yig`indi',
      { total_price: 600_000_000_000, delivery_price: 600_000_000_000 },
    ],
    ['cheksizlik', { total_price: 1e308, delivery_price: 1e308 }],
  ])('⭐ %s — price_invalid, qolganlari yaratiladi', async (_label, price) => {
    const h = await importBroken(price);

    expect(h.orders.map((row) => row.external_id)).toEqual(['A', 'C']);
    expect(h.res.data.skipped).toEqual([
      { external_id: 'B', reason: 'price_invalid' },
    ]);
    expect(h.customers).toHaveLength(2);
  });

  it('sig`adigan eng katta narx O`ZGARMAYDI', async () => {
    const h = await importBroken({ total_price: '999999999999.99' });

    expect(h.orders.map((row) => row.external_id)).toEqual(['A', 'B', 'C']);
    expect(h.orders[1].total_price).toBe(999_999_999_999.99);
  });
});

describe('⭐ rad etilgan buyurtma mijoz YARATMAYDI va YANGILAMAYDI', () => {
  it.each([
    ['narx', { total_price: '99,000' }, 'price_invalid'],
    ['yetkazish narxi', { delivery_price: 'bepul' }, 'price_invalid'],
  ])('⭐ %s noto`g`ri', async (_label, broken, reason) => {
    const h = await importBroken({ ...broken, phone: '+998935554433' });

    expect(h.res.data.skipped).toEqual([{ external_id: 'B', reason }]);
    expect(h.customers.map((row) => row.phone_number)).toEqual([
      '+998901112233',
      '+998901112233',
    ]);
  });

  it('⭐ QR boshqa buyurtmaniki', async () => {
    const h = await importBroken(
      { qr_code: 'BAND', phone: '+998935554433' },
      (service) => {
        service.orderRepo.findOne.mockImplementation(
          ({ where }: { where: Row }) =>
            Promise.resolve(
              where.qr_code_token === 'BAND' ? { id: '7' } : null,
            ),
        );
      },
    );

    expect(h.res.data.skipped).toEqual([
      { external_id: 'B', reason: 'qr_code_conflict' },
    ]);
    expect(h.customers).toHaveLength(2);
  });

  it('⭐ qat`iy rejim: narx berilmagan', async () => {
    const h = await importBroken(
      { total_price: undefined, phone: '+998935554433' },
      undefined,
      { strict: true },
    );

    expect(h.res.data.skipped).toEqual([
      { external_id: 'B', reason: 'price_missing' },
    ]);
    expect(h.customers).toHaveLength(2);
  });
});

describe('⭐ mijoz yaratilmasa — faqat shu qator tashlanadi', () => {
  it('⭐ telefon xodimniki (identity 409) — customer_create_failed', async () => {
    const h = await importBroken({ phone: STAFF_PHONE });

    expect(h.orders.map((row) => row.external_id)).toEqual(['A', 'C']);
    expect(h.res.data.skipped).toEqual([
      { external_id: 'B', reason: 'customer_create_failed' },
    ]);
  });

  it('sabab logda, telefon raqami esa YO`Q', async () => {
    const h = await importBroken({ phone: STAFF_PHONE });

    const logged = JSON.stringify(h.service.logger.warn.mock.calls);
    expect(logged).toContain('409');
    expect(logged).toContain('inhayat');
    expect(logged).not.toContain(STAFF_PHONE.slice(1));
  });

  /**
   * Identity javob bermasa yoki yiqilsa hamma qatorni «mijoz yaratilmadi» deb
   * tashlab, 201 qaytarish noto'g'ri: chaqiruvchi xatoni ko'rib qayta yuboradi
   * (yaratilganlari `already_exists` bo'ladi).
   */
  it.each([
    ['timeout', new TimeoutError()],
    ['503', { statusCode: 503, message: 'band' }],
    ['ichki xato', { status: 'error', message: 'Internal server error' }],
  ])(
    'identity nosoz (%s) — xato avvalgidek yuqoriga',
    async (_label, error) => {
      const { service } = makeService();
      rmqSend.mockReset();
      rmqSend.mockRejectedValue(error);

      await expect(
        service.receiveExternalOrders({
          integration_id: '5',
          orders: [order('A', [])],
        }),
      ).rejects.toBe(error);
    },
  );
});

describe("⭐ mijoz kartasi `users` ustunlariga sig'diriladi", () => {
  it('soxta identity chegarani haqiqiy ustundan oladi', () => {
    expect(columnOf(User, 'name')?.length).toBe(100);
    expect(columnOf(User, 'address')?.length).toBe(255);
    expect(columnOf(User, 'extra_number')?.length).toBe(20);
  });

  it('⭐ 100 belgidan uzun ism kesiladi, uchala buyurtma ham yaratiladi', async () => {
    const h = await importBroken({ full_name: `${'a'.repeat(99)}🎁ortiqcha` });

    expect(h.orders.map((row) => row.external_id)).toEqual(['A', 'B', 'C']);
    expect(h.customers[1].name).toBe(`A${'a'.repeat(98)}🎁`);
  });

  it('⭐ uzun manzil: mijoz kartasida kesiladi, buyurtmada TO`LIQ qoladi', async () => {
    const address = 'Toshkent, '.repeat(40);
    const h = await importBroken({ address });

    expect(h.orders.map((row) => row.external_id)).toEqual(['A', 'B', 'C']);
    expect(h.customers[1].address).toBe(address.slice(0, 255));
    expect(h.orders[1].address).toBe(address);
  });

  it.each([
    ['bezakli bitta raqam', '+998 (90) 111 - 22 - 33', '+998901112233'],
    ['ikki raqam', '+998901112233, +998935554433', undefined],
    ['massiv', ['+998901112233', '+998935554433'], undefined],
  ])(
    '⭐ sig`maydigan qo`shimcha raqam (%s) KESILMAYDI: boshqa odamniki chiqib qolmasin',
    async (_label, additional_phone, expected) => {
      const h = await importBroken({ additional_phone });

      expect(h.orders.map((row) => row.external_id)).toEqual(['A', 'B', 'C']);
      expect(h.customers[1].extra_number).toBe(expected);
    },
  );

  it('sig`adigan qiymatlar identity ga AYNAN ketadi', async () => {
    await importBroken({
      full_name: '  ali   valiyev ',
      address: 'a'.repeat(255),
      additional_phone: '90 111 22 33',
    });

    expect(rmqSend.mock.calls[1][2].dto).toMatchObject({
      name: '  ali   valiyev ',
      address: 'a'.repeat(255),
      extra_number: '90 111 22 33',
    });
  });

  it('berilmagan manzil va qo`shimcha raqam — yuborilmaydi (kartadagisi o`chmasin)', async () => {
    await importBroken({});

    expect(rmqSend.mock.calls[1][2].dto.address).toBeUndefined();
    expect(rmqSend.mock.calls[1][2].dto.extra_number).toBeUndefined();
  });
});
