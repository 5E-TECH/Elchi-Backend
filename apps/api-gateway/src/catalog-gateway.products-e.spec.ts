import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { lastValueFrom, Observable, of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  buildProductListQuery,
  CatalogGatewayController,
  PRODUCT_LIST_MAX_LIMIT,
} from './catalog-gateway.controller';

/**
 * Mahsulotlar katalogi (guruh E, 2026-10-14):
 *   3qDsJpfW — my-products / market/:marketId search/page/limit uzatadi;
 *   tsEevElW — market_operator o'z marketining katalogi bilan ishlaydi;
 *   QjkMUMIR — registrator ruxsat matritsasi (POST/PATCH/DELETE) izchil.
 */

type Send = jest.Mock<Observable<unknown>, [{ cmd: string }, unknown]>;

const OPERATOR = { sub: '501', roles: ['market_operator'] };
const MARKET = { sub: '121', roles: ['market'] };

const setup = (opts?: {
  product?: Record<string, unknown>;
  operatorMarketId?: string | null;
}) => {
  const catalogSend: Send = jest.fn((pattern: { cmd: string }) =>
    pattern.cmd === 'catalog.product.find_by_id'
      ? of(opts?.product ?? null)
      : of({ data: [], total: 0, page: 1, limit: 10 }),
  );
  const identitySend: Send = jest.fn(() =>
    of({
      data: {
        id: OPERATOR.sub,
        role: 'market_operator',
        market_id:
          opts && 'operatorMarketId' in opts ? opts.operatorMarketId : '121',
      },
    }),
  );
  const controller = new CatalogGatewayController(
    { send: catalogSend } as any,
    { send: jest.fn() } as any,
    { send: identitySend } as any,
  );
  return { controller, catalogSend, identitySend };
};

const rolesOf = (method: keyof CatalogGatewayController): string[] => {
  const handler = Object.getOwnPropertyDescriptor(
    CatalogGatewayController.prototype,
    method,
  )?.value as object;
  expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  return Reflect.getMetadata(ROLES_KEY, handler) as string[];
};

const sentQuery = (send: Send) => {
  const call = send.mock.calls.find(
    ([pattern]) => pattern.cmd === 'catalog.product.find_all',
  );
  return (call?.[1] as { query: Record<string, unknown> }).query;
};

describe('3qDsJpfW — mahsulot ro`yxatlari search/page/limit uzatadi', () => {
  it('⭐ TC1/TC3: GET /product/my-products?page=2&limit=50&search=olma — catalog so`roviga uzatiladi', async () => {
    const { controller, catalogSend } = setup();
    await controller.getMyProducts({ user: MARKET }, ' olma ', '2', '50');
    expect(sentQuery(catalogSend)).toEqual({
      user_id: '121',
      search: 'olma',
      page: 2,
      limit: 50,
    });
  });

  it('⭐ TC4: GET /product/market/:marketId?limit=15 — limit uzatiladi', async () => {
    const { controller, catalogSend } = setup();
    await lastValueFrom(
      controller.getByMarketId('3', undefined, undefined, '15'),
    );
    expect(sentQuery(catalogSend)).toEqual({
      user_id: '3',
      search: undefined,
      page: undefined,
      limit: 15,
    });
  });

  it('parametrsiz — avvalgi sukut (catalog: page=1, limit=10) o`zgarmaydi', async () => {
    const { controller, catalogSend } = setup();
    await controller.getMyProducts({ user: MARKET });
    expect(sentQuery(catalogSend)).toEqual({
      user_id: '121',
      search: undefined,
      page: undefined,
      limit: undefined,
    });
  });

  it('noto`g`ri page/limit — sukutga tushadi, limit 500 bilan cheklanadi', () => {
    expect(buildProductListQuery('1', '', 'abc', '-5')).toEqual({
      user_id: '1',
      search: undefined,
      page: undefined,
      limit: undefined,
    });
    expect(buildProductListQuery('1', undefined, '0', '1.5').page).toBe(
      undefined,
    );
    expect(buildProductListQuery('1', undefined, '1', '100000').limit).toBe(
      PRODUCT_LIST_MAX_LIMIT,
    );
  });

  it('GET /product (admin) — xuddi shu builder', async () => {
    const { controller, catalogSend } = setup();
    await lastValueFrom(
      controller.findAll('7', undefined, 'x', '3', '20', {
        user: { sub: '1', roles: ['admin'] },
      }),
    );
    expect(sentQuery(catalogSend)).toEqual({
      user_id: '7',
      search: 'x',
      page: 3,
      limit: 20,
    });
  });
});

describe('tsEevElW — market_operator mahsulot katalogida', () => {
  it('rollar: POST, my-products, PATCH my/:id, GET :id da bor; GET /product, PATCH :id, DELETE da yo`q', () => {
    for (const method of [
      'create',
      'getMyProducts',
      'updateMyProduct',
      'findById',
    ] as const) {
      expect(rolesOf(method)).toContain('market_operator');
    }
    for (const method of ['findAll', 'update', 'remove'] as const) {
      expect(rolesOf(method)).not.toContain('market_operator');
    }
  });

  it('⭐ TC1: my-products — biriktirilgan marketning mahsulotlari (token sub EMAS)', async () => {
    const { controller, catalogSend, identitySend } = setup({
      operatorMarketId: '121',
    });
    await controller.getMyProducts({ user: OPERATOR }, undefined, '1', '10');
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      { id: '501' },
    );
    expect(sentQuery(catalogSend)).toMatchObject({ user_id: '121' });
  });

  it('⭐ TC2: POST /product — user_id = bog`langan market, tanadagi market_id e`tiborsiz', async () => {
    const { controller, catalogSend } = setup({ operatorMarketId: '121' });
    await controller.create(
      undefined,
      { name: 'Olma', market_id: '999' },
      { user: OPERATOR },
    );
    expect(catalogSend).toHaveBeenCalledWith(
      { cmd: 'catalog.product.create' },
      { dto: { name: 'Olma', image_url: undefined, user_id: '121' } },
    );
  });

  it('⭐ TC4: biriktirilmagan operator — POST /product 400 (catalog chaqirilmaydi)', async () => {
    const { controller, catalogSend } = setup({ operatorMarketId: null });
    await expect(
      controller.create(undefined, { name: 'Olma' }, { user: OPERATOR }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.getMyProducts({ user: OPERATOR }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(catalogSend).not.toHaveBeenCalled();
  });

  it('identity javob bermasa — fail-closed 400', async () => {
    const { controller, identitySend, catalogSend } = setup();
    identitySend.mockImplementation(
      () =>
        new Observable((sub) => {
          sub.error(new Error('down'));
        }),
    );
    await expect(
      controller.create(undefined, { name: 'Olma' }, { user: OPERATOR }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(catalogSend).not.toHaveBeenCalled();
  });

  it('⭐ TC3: PATCH /product/my/:id — update_own user_id = bog`langan market, aktyor operator', async () => {
    const { controller, catalogSend } = setup({ operatorMarketId: '121' });
    await lastValueFrom(
      await controller.updateMyProduct(
        '5',
        undefined,
        { name: 'Yangi' },
        { user: OPERATOR },
      ),
    );
    expect(catalogSend).toHaveBeenCalledWith(
      { cmd: 'catalog.product.update_own' },
      {
        id: '5',
        user_id: '121',
        dto: { name: 'Yangi', image_url: undefined },
        actor: { id: '501', role: 'market_operator' },
      },
    );
  });

  it('PATCH my/:id — market uchun avvalgidek (sub, aktyorsiz)', async () => {
    const { controller, catalogSend, identitySend } = setup();
    await lastValueFrom(
      await controller.updateMyProduct(
        '5',
        undefined,
        { name: 'Yangi' },
        { user: MARKET },
      ),
    );
    expect(identitySend).not.toHaveBeenCalled();
    expect(catalogSend).toHaveBeenCalledWith(
      { cmd: 'catalog.product.update_own' },
      { id: '5', user_id: '121', dto: { name: 'Yangi', image_url: undefined } },
    );
  });

  it('GET /product/:id — o`z marketi OK, begona 403, biriktirilmagan 403', async () => {
    const own = setup({ product: { id: '5', user_id: '121' } });
    await expect(
      own.controller.findById('5', { user: OPERATOR }),
    ).resolves.toMatchObject({ id: '5' });

    const foreign = setup({ product: { id: '6', user_id: '202' } });
    await expect(
      foreign.controller.findById('6', { user: OPERATOR }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const unattached = setup({
      product: { id: '5', user_id: '121' },
      operatorMarketId: null,
    });
    await expect(
      unattached.controller.findById('5', { user: OPERATOR }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

/**
 * QjkMUMIR: Elchi-Frontend `canManageProducts` (src/app/lib/routes.tsx) va
 * `canCreateProducts` (src/app/lib/access.ts) — ed6c7ee holati. Frontend
 * boshqa repoda, shuning uchun ro'yxat shu yerda qayd etiladi: frontend
 * mahsulot sahifasini ochadigan HAR BIR rol backendda ro'yxat, yaratish,
 * tahrirlash va o'chirish yo'liga ega bo'lishi shart (403 boshi berk ko'cha
 * qaytmasin). Frontend ro'yxati o'zgarsa — shu konstanta ham yangilanadi.
 */
const FRONTEND_CAN_MANAGE_PRODUCTS = [
  'admin',
  'superadmin',
  'market',
  'registrator',
  'manager',
];

describe('QjkMUMIR — mahsulot ruxsat matritsasi (frontend bilan izchil)', () => {
  it('⭐ TC4: canManageProducts dagi har rol — ro`yxat, POST, tahrirlash va DELETE yo`liga ega', () => {
    const listRoles = [...rolesOf('findAll'), ...rolesOf('getMyProducts')];
    const editRoles = [...rolesOf('update'), ...rolesOf('updateMyProduct')];
    for (const role of FRONTEND_CAN_MANAGE_PRODUCTS) {
      expect({ role, list: listRoles.includes(role) }).toEqual({
        role,
        list: true,
      });
      expect({ role, create: rolesOf('create').includes(role) }).toEqual({
        role,
        create: true,
      });
      expect({ role, edit: editRoles.includes(role) }).toEqual({
        role,
        edit: true,
      });
      expect({ role, remove: rolesOf('remove').includes(role) }).toEqual({
        role,
        remove: true,
      });
    }
  });

  it('⭐ TC1: registrator POST /product — market_id bilan catalog.product.create ga ketadi (201 yo`li)', async () => {
    const { controller, catalogSend } = setup();
    await controller.create(
      undefined,
      { name: 'Olma', market_id: '121' },
      { user: { sub: '77', roles: ['registrator'] } },
    );
    expect(catalogSend).toHaveBeenCalledWith(
      { cmd: 'catalog.product.create' },
      { dto: { name: 'Olma', image_url: undefined, user_id: '121' } },
    );
  });

  it('registrator market_id siz — 400 (403 emas)', async () => {
    const { controller, catalogSend } = setup();
    await expect(
      controller.create(
        undefined,
        { name: 'Olma' },
        { user: { sub: '77', roles: ['registrator'] } },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(catalogSend).not.toHaveBeenCalled();
  });

  it('⭐ TC3: registrator PATCH /product/:id va DELETE /product/:id da hamon bor (regressiya)', () => {
    expect(rolesOf('update')).toContain('registrator');
    expect(rolesOf('remove')).toContain('registrator');
  });
});
