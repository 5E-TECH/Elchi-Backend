import { OrderLifecycleService } from './order-lifecycle.service';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';

/**
 * Carrier API ultracode review — qisman sotuv rollback'ida bola buyurtma
 * qatorlari ota buyurtmaga qaytariladi (`mergePartialChildrenBack`).
 *
 * BUG: kalit `String(item.product_id)` edi — katalogsiz (nomli) qatorlarning
 * hammasi `"null"` kalitiga tushib BITTA ota qatorga yig'ilardi.
 */
const REQUESTER = { id: '55' };

describe('mergePartialChildrenBack — katalogsiz qatorlar aralashmaydi', () => {
  type ItemRow = {
    id: string;
    order_id: string;
    product_id: string | null;
    product_name: string | null;
    quantity: number;
  };

  function setup(parentItems: ItemRow[], childItems: ItemRow[]) {
    const items = [...parentItems, ...childItems];
    const parent = {
      id: '900',
      total_price: 100000,
      product_quantity: 1,
    } as unknown as Order;
    const child = {
      id: '901',
      total_price: 200000,
      product_quantity: 2,
      parent_order_id: '900',
    };
    const orderRepo = {
      findOne: jest.fn(() => Promise.resolve(parent)),
      find: jest.fn(() => Promise.resolve([child])),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
    };
    let nextId = 100;
    const itemRepo = {
      find: jest.fn(({ where }: { where: { order_id: string } }) =>
        Promise.resolve(items.filter((i) => i.order_id === where.order_id)),
      ),
      create: jest.fn((v: Partial<ItemRow>) => ({ ...v })),
      save: jest.fn((v: ItemRow) => {
        if (!v.id) {
          v.id = String(nextId++);
          items.push(v);
        }
        return Promise.resolve(v);
      }),
    };
    const manager = {
      getRepository: (entity: unknown) =>
        entity === Order ? orderRepo : entity === OrderItem ? itemRepo : null,
    };
    const svc = Object.create(OrderLifecycleService.prototype) as {
      mergePartialChildrenBack: (
        m: unknown,
        o: Order,
        requester: { id: string },
      ) => Promise<number>;
      removeOrderFromSearch: jest.Mock;
      syncOrderToSearch: jest.Mock;
      voidOpenExtraCostApprovals: jest.Mock;
    };
    svc.removeOrderFromSearch = jest.fn(() => Promise.resolve());
    svc.syncOrderToSearch = jest.fn(() => Promise.resolve());
    // (hwTkXsGi) qoldiqdagi ochiq qo'shimcha xarajat yopilishi — bu yerda tekshirilmaydi.
    svc.voidOpenExtraCostApprovals = jest.fn(() => Promise.resolve());
    return { svc, manager, parent, items, itemRepo, orderRepo };
  }

  it('⭐ ikkita nomli (product_id null) qator — har biri O‘Z qatoriga qaytadi', async () => {
    const ctx = setup(
      [
        {
          id: '1',
          order_id: '900',
          product_id: null,
          product_name: 'Kurtka',
          quantity: 1,
        },
        {
          id: '2',
          order_id: '900',
          product_id: null,
          product_name: 'Shim',
          quantity: 0,
        },
      ],
      [
        {
          id: '3',
          order_id: '901',
          product_id: null,
          product_name: 'Kurtka',
          quantity: 1,
        },
        {
          id: '4',
          order_id: '901',
          product_id: null,
          product_name: 'Shim',
          quantity: 1,
        },
      ],
    );

    await expect(
      ctx.svc.mergePartialChildrenBack(ctx.manager, ctx.parent, REQUESTER),
    ).resolves.toBe(1);

    const parentLines = ctx.items.filter((i) => i.order_id === '900');
    expect(parentLines.map((i) => [i.product_name, i.quantity])).toEqual([
      ['Kurtka', 2],
      ['Shim', 1],
    ]);
  });

  it('ota qatori yo‘q nomli bola qatori — product_id null + nomi bilan qayta yaratiladi', async () => {
    const ctx = setup(
      [
        {
          id: '1',
          order_id: '900',
          product_id: '7',
          product_name: null,
          quantity: 1,
        },
      ],
      [
        {
          id: '3',
          order_id: '901',
          product_id: null,
          product_name: 'Sumka',
          quantity: 2,
        },
      ],
    );
    await ctx.svc.mergePartialChildrenBack(ctx.manager, ctx.parent, REQUESTER);
    const recreated = ctx.items.find(
      (i) => i.order_id === '900' && i.product_name === 'Sumka',
    );
    expect(recreated).toMatchObject({ product_id: null, quantity: 2 });
    // `"null"` satri bigint ustunga ketmaydi.
    expect(ctx.items.some((i) => i.product_id === 'null')).toBe(false);
  });

  it('katalog mahsuloti (product_id bor) — avvalgidek product_id bo‘yicha', async () => {
    const ctx = setup(
      [
        {
          id: '1',
          order_id: '900',
          product_id: '7',
          product_name: null,
          quantity: 1,
        },
      ],
      [
        {
          id: '3',
          order_id: '901',
          product_id: '7',
          product_name: null,
          quantity: 2,
        },
      ],
    );
    await ctx.svc.mergePartialChildrenBack(ctx.manager, ctx.parent, REQUESTER);
    expect(
      ctx.items.filter((i) => i.order_id === '900').map((i) => i.quantity),
    ).toEqual([3]);
  });

  it('⭐ qaytarish pochtasiga tushgan qoldiq (canceled_post_id) ota buyurtmaga QO‘SHILMAYDI', async () => {
    const ctx = setup([], []);
    await ctx.svc.mergePartialChildrenBack(ctx.manager, ctx.parent, REQUESTER);
    const where = (
      ctx.orderRepo.find.mock.calls[0][0] as {
        where: Record<string, unknown>;
      }
    ).where;
    // TypeORM IsNull() — FindOperator 'isNull'.
    expect(where.canceled_post_id).toMatchObject({ _type: 'isNull' });
  });

  it('nom katta-kichik harfi farqli qatorlar alohida qoladi', async () => {
    const ctx = setup(
      [
        {
          id: '1',
          order_id: '900',
          product_id: null,
          product_name: 'iPhone',
          quantity: 0,
        },
        {
          id: '2',
          order_id: '900',
          product_id: null,
          product_name: 'IPHONE',
          quantity: 0,
        },
      ],
      [
        {
          id: '3',
          order_id: '901',
          product_id: null,
          product_name: 'iPhone',
          quantity: 1,
        },
      ],
    );
    await ctx.svc.mergePartialChildrenBack(ctx.manager, ctx.parent, REQUESTER);
    expect(
      ctx.items
        .filter((i) => i.order_id === '900')
        .map((i) => [i.product_name, i.quantity]),
    ).toEqual([
      ['iPhone', 1],
      ['IPHONE', 0],
    ]);
  });
});
