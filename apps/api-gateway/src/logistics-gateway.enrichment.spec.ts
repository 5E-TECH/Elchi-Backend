import 'reflect-metadata';
import { of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import {
  LogisticsGatewayController,
  POST_ORDER_CUSTOMER_FIELDS,
  POST_ORDER_DISTRICT_FIELDS,
  POST_ORDER_MARKET_FIELDS,
  POST_ORDER_REGION_FIELDS,
} from './logistics-gateway.controller';

/**
 * (VfgcnxDa) Pochta detali javobida market/mijozning maxfiy maydonlari.
 *
 * identity `admins` jadvalining TO'LIQ qatori (market ham, mijoz ham shu
 * jadvalda) mock qilinadi — real javobdagi barcha kalitlar bilan. Oq ro'yxat
 * tushib qolsa yoki yangi kalit qo'shilsa testlar yiqiladi.
 */
const SECRET_KEYS = /market_tg_token|salary|username|settings|commission_/;

// identity User entity'sining barcha ustunlari (apps/identity-service/src/entities/user.entity.ts)
const fullAdminRow = (overrides: Record<string, unknown>) => ({
  id: '0',
  name: 'X',
  phone_number: '+998900000000',
  extra_number: '+998901234567',
  address: 'Toshkent, Chilonzor 5',
  username: 'yandex',
  password: '$2b$10$hash',
  refresh_token: 'refresh-secret',
  salary: 0,
  payment_day: 5,
  region_id: '5',
  district_id: '4',
  market_tg_token: 'group_token-SECRET',
  market_id: null,
  telegram_id: '123456',
  avatar_id: null,
  role: 'market',
  status: 'active',
  tariff_home: 80000,
  tariff_center: 50000,
  compensation_mode: 'per_order',
  add_order: true,
  can_add_extra_cost: false,
  can_sell_cancel: false,
  cancelled_handover_qr_required: true,
  expense_proof_conditions: null,
  default_tariff: 'center',
  commission_type: 'percent',
  commission_value: 20,
  settings: { notify: true },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isDeleted: false,
  ...overrides,
});

const market = fullAdminRow({
  id: '2',
  name: 'Market',
  phone_number: '+998901112233',
});
const customer = fullAdminRow({
  id: '3',
  name: 'Customer',
  phone_number: '+998907778899',
  role: 'customer',
});
const regionEntity = (id: string, name: string) => ({
  id,
  name,
  sato_code: '1726',
  logist_id: '77',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isDeleted: false,
});
const district = {
  id: '4',
  name: 'District',
  sato_code: '1726262',
  region_id: '5',
  assigned_region: '6',
  region: regionEntity('5', 'Region'),
  assignedToRegion: regionEntity('6', 'Assigned'),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isDeleted: false,
};

const row = {
  id: '10',
  market_id: '2',
  customer_id: '3',
  district_id: '4',
  region_id: '5',
  status: 'received',
  total_price: 100000,
};

const build = () => {
  const logistics = {
    send: jest.fn((pattern: { cmd: string }) => {
      if (pattern.cmd === 'logistics.post.orders_by_post') {
        return of({
          statusCode: 200,
          data: {
            allOrdersByPostId: [row],
            homeOrders: { homeOrders: 0, homeOrdersTotalPrice: 0 },
            centerOrders: { centerOrders: 1, centerOrdersTotalPrice: 100000 },
          },
        });
      }
      if (pattern.cmd === 'logistics.post.rejected_orders_by_post') {
        return of({ statusCode: 200, data: [row] });
      }
      if (pattern.cmd === 'logistics.post.return_requests') {
        return of({
          statusCode: 200,
          data: {
            total: 1,
            scope: { type: 'HQ', branch_id: null },
            groups: [{ courier: null, courier_id: null, orders: [row] }],
          },
        });
      }
      return of({ data: district });
    }),
  };
  const identity = {
    send: jest.fn((pattern: { cmd: string }) =>
      of({
        data: pattern.cmd === 'identity.market.find_by_id' ? market : customer,
      }),
    ),
  };
  return new LogisticsGatewayController(logistics as any, identity as any);
};

const sortedKeys = (value: unknown) =>
  Object.keys(value as Record<string, unknown>).sort();

describe('VfgcnxDa - pochta buyurtmalarining xavfsiz boyitilishi', () => {
  it.each(['superadmin', 'admin', 'manager', 'courier'])(
    'TC1/TC2: GET /post/orders/:id (%s) maxfiy maydonlarni hech qayerda chiqarmaydi',
    async (role) => {
      const result = await build().getOrdersByPost('1', {
        user: { sub: '9', roles: [role] },
      });
      const json = JSON.stringify(result);

      expect(json).not.toMatch(SECRET_KEYS);
      expect(json).not.toMatch(/password|refresh_token|tariff_|telegram_id/);
      const enriched = result.data.allOrdersByPostId[0];
      expect(enriched.market).toEqual({
        id: '2',
        name: 'Market',
        phone_number: '+998901112233',
      });
    },
  );

  it('TC3: boyitilgan obyektlar kalitlari qotirilgan (yangi kalit — test yiqiladi)', async () => {
    const result = await build().getOrdersByPost('1', {
      user: { sub: '9', roles: ['superadmin'] },
    });
    const enriched = result.data.allOrdersByPostId[0];

    expect(sortedKeys(enriched)).toEqual(
      [...Object.keys(row), 'market', 'customer', 'district'].sort(),
    );
    expect(sortedKeys(enriched.market)).toEqual(
      ['id', 'name', 'phone_number'].sort(),
    );
    expect(sortedKeys(enriched.customer)).toEqual(
      [
        'id',
        'name',
        'phone_number',
        'extra_number',
        'address',
        'district_id',
        'region_id',
      ].sort(),
    );
    expect(sortedKeys(enriched.district)).toEqual(
      [
        'id',
        'name',
        'sato_code',
        'region_id',
        'assigned_region',
        'region',
        'assignedToRegion',
      ].sort(),
    );
    expect(sortedKeys(enriched.district.region)).toEqual(
      ['id', 'name', 'sato_code'].sort(),
    );
    expect(sortedKeys(enriched.district.assignedToRegion)).toEqual(
      ['id', 'name', 'sato_code'].sort(),
    );
    // Konstantalar ham qotiriladi: ro'yxatga kalit qo'shish — ongli qaror.
    expect([...POST_ORDER_MARKET_FIELDS]).toEqual([
      'id',
      'name',
      'phone_number',
    ]);
    expect(POST_ORDER_CUSTOMER_FIELDS).toHaveLength(7);
    expect(POST_ORDER_DISTRICT_FIELDS).toHaveLength(7);
    expect(POST_ORDER_REGION_FIELDS).toHaveLength(3);
  });

  it("pochta detali ishlatadigan maxfiy bo'lmagan maydonlar saqlanadi (LC-09, chop etish)", async () => {
    const result = await build().getOrdersByPost('1', {
      user: { sub: '9', roles: ['manager'] },
    });
    const enriched = result.data.allOrdersByPostId[0];

    // printMode.ts — yorliqdagi qo'shimcha raqam
    expect(enriched.customer.extra_number).toBe('+998901234567');
    // dispatchRegion.ts — tuman qayta biriktirilgan viloyat
    expect(enriched.district.assigned_region).toBe('6');
    expect(enriched.district.assignedToRegion).toEqual({
      id: '6',
      name: 'Assigned',
      sato_code: '1726',
    });
    expect(enriched.district.region.name).toBe('Region');
    // javobning qolgan qismi (home/center hisoblari) o'zgarmaydi
    expect(result.data.centerOrders).toEqual({
      centerOrders: 1,
      centerOrdersTotalPrice: 100000,
    });
  });

  it('courier roli pochta detali marshrutida ruxsat etilgan', () => {
    const route = Object.getOwnPropertyDescriptor(
      LogisticsGatewayController.prototype,
      'getOrdersByPost',
    );
    expect(Reflect.getMetadata(ROLES_KEY, route?.value)).toContain('courier');
  });

  it('rad etilgan buyurtmalarda ham bir xil oq royxat ishlaydi', async () => {
    const result = await build().getRejectedOrdersByPost('1', {
      user: { sub: '9', roles: ['courier'] },
    });
    expect(JSON.stringify(result)).not.toMatch(SECRET_KEYS);
    expect(result.data[0].market).toEqual({
      id: '2',
      name: 'Market',
      phone_number: '+998901112233',
    });
  });

  it("⭐ qaytarish so'rovlari guruhidagi kuryer — faqat id, name, phone_number (2026-10-19 prod: salary/tarif/komissiya menejerga chiqardi)", async () => {
    const courier = fullAdminRow({
      id: '26',
      name: 'TEST Claude Kuryer',
      phone_number: '+998887009102',
      role: 'courier',
    });
    const withCourier = (orders: unknown[]) => {
      const logistics = {
        send: jest.fn((pattern: { cmd: string }) =>
          pattern.cmd === 'logistics.post.return_requests'
            ? of({
                statusCode: 200,
                data: {
                  total: orders.length,
                  scope: { type: 'BRANCH', branch_id: '3' },
                  groups: [{ courier, courier_id: '26', orders }],
                },
              })
            : of({ data: district }),
        ),
      };
      const identity = {
        send: jest.fn((pattern: { cmd: string }) =>
          of({
            data:
              pattern.cmd === 'identity.market.find_by_id' ? market : customer,
          }),
        ),
      };
      return new LogisticsGatewayController(logistics as any, identity as any);
    };

    for (const orders of [[row], []]) {
      const result = (await withCourier(orders).getReturnRequests({
        user: { sub: '25', roles: ['manager'] },
      })) as {
        data: { groups: Array<{ courier: unknown; orders: unknown[] }> };
      };
      const group = result.data.groups[0];
      expect(group.courier).toEqual({
        id: '26',
        name: 'TEST Claude Kuryer',
        phone_number: '+998887009102',
      });
      expect(JSON.stringify(result)).not.toMatch(SECRET_KEYS);
      expect(group.orders).toHaveLength(orders.length);
    }
  });

  it("qaytarish so'rovlari (bir xil enrichOrderRows) ham oq ro'yxatdan o'tadi", async () => {
    const result = (await build().getReturnRequests({
      user: { sub: '9', roles: ['manager'] },
    })) as { data: { groups: Array<{ orders: unknown[] }> } };
    expect(JSON.stringify(result.data.groups[0].orders)).not.toMatch(
      SECRET_KEYS,
    );
  });
});
