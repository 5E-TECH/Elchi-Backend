import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Observable, of, throwError } from 'rxjs';
import { WAREHOUSE_RPC } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreateWarehouseRequestDto,
  WarehouseInventoryRequestDto,
  WarehouseStockInRequestDto,
  WarehouseThresholdRequestDto,
} from './dto/warehouse.swagger.dto';
import { WarehouseGatewayController } from './warehouse-gateway.controller';

/**
 * hY7uacJu — ombor moduli gateway'i: RBAC (kirim/tuzatish/ombor/pauza —
 * faqat SUPERADMIN/ADMIN; filial menejeri — faqat o'z filiali, o'qish;
 * market — faqat o'z qoldig'i), so'rov shakli (Idempotency-Key, aktyor,
 * scope), DTO validatsiyasi va marshrut tartibi.
 */
type Send = jest.Mock<Observable<unknown>, [{ cmd: string }, any]>;

const setup = (
  options: { branchReply?: unknown; operatorMarket?: string | null } = {},
) => {
  const catalogSend: Send = jest.fn(() => of({ data: [] }));
  const branchSend: Send = jest.fn(() =>
    options.branchReply instanceof Error
      ? throwError(() => options.branchReply)
      : of(options.branchReply ?? { data: { branch_id: '11' } }),
  );
  const identitySend: Send = jest.fn((pattern: { cmd: string }) =>
    of(
      pattern.cmd === 'identity.user.find_by_id'
        ? { data: { market_id: options.operatorMarket ?? null } }
        : { statusCode: 200, data: {} },
    ),
  );
  const controller = new WarehouseGatewayController(
    { send: catalogSend } as never,
    { send: branchSend } as never,
    { send: identitySend } as never,
  );
  return { controller, catalogSend, branchSend, identitySend };
};

const user = (
  sub: string,
  roles: string[],
  extra: Record<string, unknown> = {},
) => ({
  user: { sub, roles, ...extra },
});

const SUPERADMIN = user('1', ['superadmin']);
const ADMIN = user('2', ['admin']);
const MANAGER = user('31', ['manager']);
const MARKET = user('121', ['market']);
const OPERATOR = user('140', ['market_operator']);
const REGISTRATOR = user('5', ['registrator']);

const handlerOf = (method: keyof WarehouseGatewayController) =>
  Object.getOwnPropertyDescriptor(WarehouseGatewayController.prototype, method)
    ?.value as object;

const rolesOf = (method: keyof WarehouseGatewayController): string[] =>
  [...(Reflect.getMetadata(ROLES_KEY, handlerOf(method)) as string[])].sort();

const errors = async (cls: new () => object, body: unknown) =>
  validate(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('hY7uacJu — WarehouseGatewayController', () => {
  describe('RBAC metama`lumoti', () => {
    it('class darajasida JwtAuthGuard + RolesGuard', () => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        WarehouseGatewayController,
      ) as unknown[];
      expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
    });

    it('⭐ yozish (ombor, kirim, inventarizatsiya, chegara, pauza, kalit) — faqat superadmin/admin', () => {
      const adminOnly: Array<keyof WarehouseGatewayController> = [
        'create',
        'update',
        'pause',
        'resume',
        'stockIn',
        'inventory',
        'setThreshold',
        'lookup',
        'updateMarketWarehouseOrder',
      ];
      for (const method of adminOnly) {
        expect({ method, roles: rolesOf(method) }).toEqual({
          method,
          roles: ['admin', 'superadmin'],
        });
      }
    });

    it('⭐ o`qish — superadmin, admin, filial menejeri, filial; registrator/market/kuryer yo`q', () => {
      for (const method of [
        'findAll',
        'findOne',
        'listStock',
        'listMovements',
        'exportStock',
      ] as const) {
        expect({ method, roles: rolesOf(method) }).toEqual({
          method,
          roles: ['admin', 'branch', 'manager', 'superadmin'],
        });
      }
    });

    it('buyurtma formasi — superadmin, admin, registrator, market, market operatori', () => {
      for (const method of ['resolveSource', 'availability'] as const) {
        expect(rolesOf(method)).toEqual([
          'admin',
          'market',
          'market_operator',
          'registrator',
          'superadmin',
        ]);
      }
      expect(rolesOf('marketStock')).toEqual([
        'admin',
        'market',
        'market_operator',
        'superadmin',
      ]);
    });

    it('statik yo`llar (`resolve-source`, `availability`) `:id` dan OLDIN e`lon qilingan', () => {
      const names = Object.getOwnPropertyNames(
        WarehouseGatewayController.prototype,
      );
      expect(names.indexOf('availability')).toBeLessThan(
        names.indexOf('findOne'),
      );
      expect(names.indexOf('resolveSource')).toBeLessThan(
        names.indexOf('findOne'),
      );
    });
  });

  describe('filial doirasi (scope)', () => {
    it('⭐ admin — scope yuborilmaydi; menejer — branch-service`dagi o`z filiali', async () => {
      const admin = setup();
      await admin.controller.findAll(ADMIN as never);
      expect(admin.catalogSend.mock.calls[0][1]).not.toHaveProperty('scope');
      expect(admin.branchSend).not.toHaveBeenCalled();

      const manager = setup({ branchReply: { data: { branch_id: '11' } } });
      await manager.controller.findOne('3', MANAGER as never);
      expect(manager.catalogSend).toHaveBeenCalledWith(
        { cmd: WAREHOUSE_RPC.FIND_BY_ID },
        { id: '3', scope: { branch_id: '11' } },
      );
      await manager.controller.listStock('3', MANAGER as never, '121', 'low');
      expect(manager.catalogSend.mock.calls[1][1]).toMatchObject({
        scope: { branch_id: '11' },
        query: { market_id: '121', level: 'low' },
      });
    });

    it('branch-service javob bermasa — tokendagi branch_id; u ham yo`q — 403 (fail-closed)', async () => {
      const fallback = setup({ branchReply: new Error('down') });
      await expect(
        fallback.controller.resolveScope({
          sub: '31',
          roles: ['manager'],
          branch_id: '12',
        }),
      ).resolves.toEqual({ branch_id: '12' });

      const none = setup({ branchReply: { data: null } });
      await expect(
        none.controller.listMovements('3', MANAGER as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(none.catalogSend).not.toHaveBeenCalled();
    });

    it('noto`g`ri ombor id — 404 (catalog`ga bormaydi)', async () => {
      const { controller, catalogSend } = setup();
      await expect(
        controller.findOne('abc', ADMIN as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(catalogSend).not.toHaveBeenCalled();
    });
  });

  describe('market qoldig`i (IDOR)', () => {
    it('⭐ market — faqat o`zi (tokendan); boshqa market_id — 403', async () => {
      const { controller, catalogSend } = setup();
      await controller.marketStock(MARKET as never);
      expect(catalogSend).toHaveBeenCalledWith(
        { cmd: WAREHOUSE_RPC.MARKET_STOCK },
        expect.objectContaining({ market_id: '121' }),
      );
      await expect(
        controller.marketStock(MARKET as never, '999'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(catalogSend).toHaveBeenCalledTimes(1);
    });

    it('market operatori — biriktirilgan marketi; biriktirilmagan — 400', async () => {
      const bound = setup({ operatorMarket: '121' });
      await bound.controller.marketStock(OPERATOR as never);
      expect(bound.catalogSend.mock.calls[0][1]).toMatchObject({
        market_id: '121',
      });
      await expect(
        bound.controller.marketStock(OPERATOR as never, '122'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const unbound = setup({ operatorMarket: null });
      await expect(
        unbound.controller.marketStock(OPERATOR as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('admin — market_id majburiy', async () => {
      const { controller } = setup();
      await expect(
        controller.marketStock(ADMIN as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      await controller.marketStock(
        SUPERADMIN as never,
        '121',
        'shapka',
        'true',
      );
    });
  });

  describe('buyurtma formasi', () => {
    it('⭐ market — market_id tokendan, requester rollari bilan (catalog kalitni tekshiradi)', async () => {
      const { controller, catalogSend } = setup();
      await controller.resolveSource(
        {
          district_id: '45',
          items: [{ product_id: '142', quantity: 1 }],
        } as never,
        MARKET as never,
      );
      expect(catalogSend).toHaveBeenCalledWith(
        { cmd: WAREHOUSE_RPC.RESOLVE_SOURCE },
        {
          district_id: '45',
          region_id: undefined,
          market_id: '121',
          items: [{ product_id: '142', quantity: 1 }],
          requester: { id: '121', roles: ['market'] },
        },
      );
      await expect(
        controller.resolveSource(
          { market_id: '999', items: [] } as never,
          MARKET as never,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('registrator — istalgan market; availability market_id yoki product_ids talab qiladi', async () => {
      const { controller, catalogSend } = setup();
      await controller.resolveSource(
        { region_id: '7', market_id: '121', items: [] } as never,
        REGISTRATOR as never,
      );
      expect(catalogSend.mock.calls[0][1]).toMatchObject({ market_id: '121' });
      await expect(
        controller.availability(REGISTRATOR as never, '45'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await controller.availability(
        REGISTRATOR as never,
        '45',
        undefined,
        undefined,
        '1,2',
      );
      expect(catalogSend.mock.calls[1]).toEqual([
        { cmd: WAREHOUSE_RPC.AVAILABILITY },
        {
          district_id: '45',
          region_id: undefined,
          market_id: undefined,
          product_ids: '1,2',
        },
      ]);
    });
  });

  describe('yozish so`rovlari', () => {
    it('⭐ kirim — Idempotency-Key va aktyor catalog`ga uzatiladi', async () => {
      const { controller, catalogSend } = setup();
      await controller.stockIn(
        '3',
        { lines: [{ code: 'ELC-P-000142', qty: 2 }], note: 'Yuk' } as never,
        'key-12345678',
        ADMIN as never,
      );
      expect(catalogSend).toHaveBeenCalledWith(
        { cmd: WAREHOUSE_RPC.STOCK_IN },
        {
          warehouse_id: '3',
          lines: [{ code: 'ELC-P-000142', qty: 2 }],
          market_id: undefined,
          note: 'Yuk',
          idempotency_key: 'key-12345678',
          actor: { id: '2', roles: ['admin'] },
        },
      );
    });

    it('inventarizatsiya, chegara, pauza — to`g`ri naqsh va requester', async () => {
      const { controller, catalogSend } = setup();
      await controller.inventory(
        '3',
        { lines: [{ product_id: '9', counted: 0 }], reason: 'Sanash' } as never,
        'key-87654321',
        SUPERADMIN as never,
      );
      await controller.setThreshold(
        '3',
        '9',
        { low_stock_threshold: null },
        ADMIN as never,
      );
      await controller.pause('3', { note: 'Mavsum' }, ADMIN as never);
      await controller.resume('3', {}, ADMIN as never);
      expect(catalogSend.mock.calls.map((call) => call[0].cmd)).toEqual([
        WAREHOUSE_RPC.INVENTORY,
        WAREHOUSE_RPC.SET_THRESHOLD,
        WAREHOUSE_RPC.PAUSE,
        WAREHOUSE_RPC.RESUME,
      ]);
      expect(catalogSend.mock.calls[1][1]).toEqual({
        warehouse_id: '3',
        product_id: '9',
        low_stock_threshold: null,
        actor: { id: '2', roles: ['admin'] },
      });
      expect(catalogSend.mock.calls[2][1]).toEqual({
        id: '3',
        note: 'Mavsum',
        requester: { id: '2', roles: ['admin'] },
      });
    });

    it('⭐ «Ombordan buyurtma yaratish» kaliti — identity.market.update, requester bilan; noto`g`ri id — 404', async () => {
      const { controller, identitySend } = setup();
      await controller.updateMarketWarehouseOrder(
        '37',
        { can_order_from_warehouse: true },
        ADMIN as never,
      );
      expect(identitySend).toHaveBeenCalledWith(
        { cmd: 'identity.market.update' },
        {
          id: '37',
          dto: { can_order_from_warehouse: true },
          requester: { id: '2', roles: ['admin'] },
        },
      );
      expect(() =>
        controller.updateMarketWarehouseOrder(
          'x',
          { can_order_from_warehouse: true },
          ADMIN as never,
        ),
      ).toThrow(NotFoundException);
    });

    it('Excel eksport — xlsx fayl, sahifasiz so`rov', async () => {
      const { controller, catalogSend } = setup();
      catalogSend.mockReturnValueOnce(
        of({
          warehouse: { name: 'Samarqand' },
          data: [
            {
              product: {
                name: 'Shapka',
                code: { value: 'ELC-P-000118', kind: 'sku', format: 'ELC' },
                chargeable_weight_kg: 1,
                chargeable_basis: 'volumetric',
              },
              market: { id: '121', name: 'Baraka' },
              on_hand: 3,
              reserved: 1,
              available: 2,
              threshold: 5,
              level: 'low',
            },
          ],
        }),
      );
      const res = { set: jest.fn(), end: jest.fn() };
      await controller.exportStock('3', ADMIN as never, res as never);
      expect(catalogSend.mock.calls[0][1]).toMatchObject({
        id: '3',
        query: { all: true },
      });
      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Disposition': 'attachment; filename="ombor-3-qoldiq.xlsx"',
        }),
      );
      const buffer = res.end.mock.calls[0][0] as Buffer;
      expect(buffer.subarray(0, 2).toString()).toBe('PK');
    });
  });

  describe('DTO validatsiyasi (whitelist)', () => {
    it('kirim: qty butun ≥ 1, qatorlar 1..200, ortiqcha maydon — xato', async () => {
      expect(
        await errors(WarehouseStockInRequestDto, {
          lines: [{ product_id: '1', qty: 2 }],
        }),
      ).toHaveLength(0);
      expect(
        await errors(WarehouseStockInRequestDto, { lines: [] }),
      ).not.toHaveLength(0);
      expect(
        await errors(WarehouseStockInRequestDto, {
          lines: [{ product_id: '1', qty: 0 }],
        }),
      ).not.toHaveLength(0);
      expect(
        await errors(WarehouseStockInRequestDto, {
          lines: [{ product_id: '1', qty: 1.5 }],
        }),
      ).not.toHaveLength(0);
      expect(
        await errors(WarehouseStockInRequestDto, {
          lines: [{ product_id: '1', qty: 1 }],
          hack: 1,
        }),
      ).not.toHaveLength(0);
      expect(
        await errors(WarehouseStockInRequestDto, {
          lines: Array.from({ length: 201 }, () => ({
            product_id: '1',
            qty: 1,
          })),
        }),
      ).not.toHaveLength(0);
    });

    it('inventarizatsiya: sabab majburiy (≥3), counted ≥ 0', async () => {
      expect(
        await errors(WarehouseInventoryRequestDto, {
          lines: [{ product_id: '1', counted: 0 }],
          reason: 'Sanash',
        }),
      ).toHaveLength(0);
      expect(
        await errors(WarehouseInventoryRequestDto, {
          lines: [{ product_id: '1', counted: 0 }],
        }),
      ).not.toHaveLength(0);
      expect(
        await errors(WarehouseInventoryRequestDto, {
          lines: [{ product_id: '1', counted: -1 }],
          reason: 'Sanash',
        }),
      ).not.toHaveLength(0);
    });

    it('ombor ochish: branch_id raqamli; chegara: son yoki null (majburiy)', async () => {
      expect(
        await errors(CreateWarehouseRequestDto, { branch_id: '11' }),
      ).toHaveLength(0);
      expect(
        await errors(CreateWarehouseRequestDto, { branch_id: '0x1' }),
      ).not.toHaveLength(0);
      expect(
        await errors(CreateWarehouseRequestDto, {
          branch_id: '11',
          status: 'PAUSED',
        }),
      ).not.toHaveLength(0);
      expect(
        await errors(WarehouseThresholdRequestDto, {
          low_stock_threshold: null,
        }),
      ).toHaveLength(0);
      expect(await errors(WarehouseThresholdRequestDto, {})).not.toHaveLength(
        0,
      );
    });
  });
});
