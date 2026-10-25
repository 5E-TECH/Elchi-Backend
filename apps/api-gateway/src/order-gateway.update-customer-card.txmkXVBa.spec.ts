import { ForbiddenException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * txmkXVBa (ega qarori 2026-10-19 S5) — POST /orders `update_customer_card`.
 *  - `false` / berilmasa («Faqat shu buyurtmada»): karta o'zgarmaydi (telefon
 *    yo'lida ham — identity `update_existing: false`), manzil / tuman /
 *    qo'shimcha raqam buyurtmaning o'z ustunlariga;
 *  - `true` («Kartani ham yangilash»): buyurtma yaratilgach
 *    `identity.customer.update` (customer_id yo'lida ham), javobda
 *    `customer_card_updated` + `customer_card_changed_fields`;
 *  - market / operator — faqat o'z marketida buyurtmasi bor mijoz kartasi
 *    (aks holda 403, buyurtma yaratilmaydi); admin — cheklovsiz;
 *  - bot yo'li — avvalgi xulq (identity j70YS4zJ patch).
 * IR2OHIiN: payload doim mahsulot + tuman + viloyat bilan.
 */
describe('txmkXVBa — POST /orders: update_customer_card', () => {
  const customerObj = {
    name: 'Ali Yangi',
    phone_number: '+998901112233',
    district_id: '5',
    address: 'Yangi manzil 7',
    extra_number: '93-111-22-33',
  };
  const baseDto = {
    market_id: '999',
    total_price: 120000,
    district_id: '5',
    region_id: '2',
    items: [{ product_id: '10', quantity: 1 }],
  };

  const makeController = (opts: {
    inScope?: string[];
    /** identity.customer.create javobi statusCode (201 — yangi mijoz). */
    createStatus?: number;
    card?: Record<string, unknown>;
    update?: { changed: string[] } | 'error';
  }) => {
    const orderClient = {
      send: jest.fn(
        (pattern: { cmd: string }, payload: { customer_ids?: string[] }) => {
          if (pattern.cmd === 'order.customer.market_summary') {
            return of({
              statusCode: 200,
              data: {
                items: (payload.customer_ids ?? [])
                  .filter((id) => (opts.inScope ?? []).includes(id))
                  .map((id) => ({ customer_id: id, orders: 2, new_orders: 0 })),
              },
            });
          }
          return of({ statusCode: 201, message: 'ok', data: { id: '500' } });
        },
      ),
    };
    const identityClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        switch (pattern.cmd) {
          case 'identity.customer.create':
            return of({
              statusCode: opts.createStatus ?? 200,
              data: { id: '153' },
            });
          case 'identity.customer.find_by_id':
            return opts.card
              ? of({ statusCode: 200, data: opts.card })
              : throwError(() => new Error('Customer topilmadi'));
          case 'identity.customer.update':
            return opts.update === 'error'
              ? throwError(() => new Error('identity down'))
              : of({
                  statusCode: 200,
                  data: {
                    id: '153',
                    changed_fields: opts.update?.changed ?? [],
                  },
                });
          case 'identity.market.find_by_id':
            return of({ data: { status: 'active', add_order: true } });
          case 'identity.user.find_by_id':
            return of({ data: { market_id: '37', name: 'Op' } });
          default:
            return of({});
        }
      }),
    };
    const controller = new OrderGatewayController(
      orderClient as any,
      identityClient as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({ data: null })) } as any,
    );
    const calls = (client: { send: jest.Mock }, cmd: string) =>
      (client.send.mock.calls as unknown[][]).filter(
        (args) => (args[0] as { cmd?: string } | undefined)?.cmd === cmd,
      );
    const createdDto = () => {
      const call = calls(orderClient, 'order.create')[0];
      expect(call).toBeDefined();
      return (call[1] as { dto: Record<string, unknown> }).dto;
    };
    return { controller, orderClient, identityClient, calls, createdDto };
  };

  const userReq = (sub: string, roles: string[]) =>
    ({ user: { sub, username: 'u', roles } }) as any;
  const MARKET = () => userReq('37', ['market']);

  it('⭐ «Faqat shu buyurtmada» (bayroq yo`q): telefon yo`lida karta yozilmaydi, manzil/tuman/qo`shimcha raqam buyurtmaga', async () => {
    const fx = makeController({ inScope: ['153'] });

    const res: any = await fx.controller.create(
      { ...baseDto, customer: customerObj } as any,
      MARKET(),
    );

    expect(
      fx.calls(fx.identityClient, 'identity.customer.create')[0][1],
    ).toEqual({ dto: customerObj, update_existing: false });
    expect(
      fx.calls(fx.identityClient, 'identity.customer.update'),
    ).toHaveLength(0);
    expect(fx.createdDto()).toMatchObject({
      customer_id: '153',
      address: 'Yangi manzil 7',
      extra_number: '93-111-22-33',
      district_id: '5',
    });
    expect(fx.createdDto()).not.toHaveProperty('update_customer_card');
    expect(res.customer_card_updated).toBe(false);
    expect(res.customer_card_changed_fields).toEqual([]);
  });

  it('⭐ «Faqat shu buyurtmada» (false) — customer_id yo`lida ham karta o`zgarmaydi', async () => {
    const fx = makeController({ inScope: ['153'] });

    const res: any = await fx.controller.create(
      {
        ...baseDto,
        customer_id: '153',
        customer: customerObj,
        update_customer_card: false,
      } as any,
      MARKET(),
    );

    expect(
      fx.calls(fx.identityClient, 'identity.customer.update'),
    ).toHaveLength(0);
    expect(fx.createdDto()).toMatchObject({
      customer_id: '153',
      address: 'Yangi manzil 7',
      extra_number: '93-111-22-33',
    });
    expect(res.customer_card_updated).toBe(false);
  });

  it('⭐ «Kartani ham yangilash» — telefon yo`li (mavjud mijoz, shu marketda): buyurtmadan KEYIN identity.customer.update, javobda o`zgargan maydonlar', async () => {
    const fx = makeController({
      inScope: ['153'],
      update: { changed: ['name', 'address'] },
    });

    const res: any = await fx.controller.create(
      { ...baseDto, customer: customerObj, update_customer_card: true } as any,
      MARKET(),
    );

    const [updateCall] = fx.calls(
      fx.identityClient,
      'identity.customer.update',
    );
    expect(updateCall[1]).toEqual({
      id: '153',
      dto: {
        name: 'Ali Yangi',
        district_id: '5',
        address: 'Yangi manzil 7',
        extra_number: '93-111-22-33',
      },
      order_id: '500',
      market_id: '37',
    });
    // Tartib: avval buyurtma, keyin karta (activity log'da buyurtma id si).
    const createOrder = fx.orderClient.send.mock.invocationCallOrder.at(-1)!;
    const updateOrder = fx.identityClient.send.mock.invocationCallOrder.at(-1)!;
    expect(updateOrder).toBeGreaterThan(createOrder);
    expect(res.customer_card_updated).toBe(true);
    expect(res.customer_card_changed_fields).toEqual(['name', 'address']);
    // Buyurtmaga ham yoziladi.
    expect(fx.createdDto()).toMatchObject({ address: 'Yangi manzil 7' });
  });

  it('⭐ «Kartani ham yangilash» — customer_id yo`lida ham karta yangilanadi', async () => {
    const fx = makeController({
      inScope: ['153'],
      update: { changed: ['extra_number'] },
    });

    const res: any = await fx.controller.create(
      {
        ...baseDto,
        customer_id: '153',
        customer: customerObj,
        update_customer_card: true,
      } as any,
      MARKET(),
    );

    expect(
      fx.calls(fx.identityClient, 'identity.customer.create'),
    ).toHaveLength(0);
    expect(
      fx.calls(fx.identityClient, 'identity.customer.update')[0][1],
    ).toMatchObject({ id: '153', order_id: '500' });
    expect(res.customer_card_updated).toBe(true);
  });

  it('⭐ ruxsat: market boshqa market mijozi kartasini yangilay olmaydi (customer_id, telefon mos) → 403, buyurtma ham, karta ham yo`q', async () => {
    const fx = makeController({
      inScope: [],
      card: { id: '153', phone_number: '+998901112233' },
    });

    await expect(
      fx.controller.create(
        {
          ...baseDto,
          customer_id: '153',
          customer: customerObj,
          update_customer_card: true,
        } as any,
        MARKET(),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(fx.calls(fx.orderClient, 'order.create')).toHaveLength(0);
    expect(
      fx.calls(fx.identityClient, 'identity.customer.update'),
    ).toHaveLength(0);
  });

  it('⭐ ruxsat: market operatori — telefon yo`lida topilgan, o`z marketida buyurtmasi yo`q mijoz → 403 matn bilan', async () => {
    const fx = makeController({ inScope: [] });

    await expect(
      fx.controller.create(
        {
          ...baseDto,
          customer: customerObj,
          update_customer_card: true,
        } as any,
        userReq('501', ['market_operator']),
      ),
    ).rejects.toThrow(/Mijoz kartasini yangilab bo'lmaydi/);
    expect(fx.calls(fx.orderClient, 'order.create')).toHaveLength(0);
  });

  it('ruxsat: admin boshqa market mijozi kartasini yangilay oladi', async () => {
    const fx = makeController({ inScope: [], update: { changed: ['name'] } });

    const res: any = await fx.controller.create(
      {
        ...baseDto,
        customer_id: '153',
        customer: customerObj,
        update_customer_card: true,
      } as any,
      userReq('1', ['admin']),
    );

    expect(
      fx.calls(fx.orderClient, 'order.customer.market_summary'),
    ).toHaveLength(0);
    expect(res.customer_card_updated).toBe(true);
  });

  it('yangi mijoz (identity 201) — karta formadan yaratilgan, update chaqirilmaydi, 403 ham yo`q', async () => {
    const fx = makeController({ inScope: [], createStatus: 201 });

    const res: any = await fx.controller.create(
      { ...baseDto, customer: customerObj, update_customer_card: true } as any,
      MARKET(),
    );

    expect(
      fx.calls(fx.identityClient, 'identity.customer.update'),
    ).toHaveLength(0);
    expect(res.customer_card_updated).toBe(false);
  });

  it('karta yangilash xatosi buyurtmani bekor qilmaydi — customer_card_updated: false', async () => {
    const fx = makeController({ inScope: ['153'], update: 'error' });

    const res: any = await fx.controller.create(
      { ...baseDto, customer: customerObj, update_customer_card: true } as any,
      MARKET(),
    );

    expect(res.data).toEqual({ id: '500' });
    expect(res.customer_card_updated).toBe(false);
  });

  it('bot yo`li — avvalgi xulq: identity telefon bo`yicha patch qiladi (update_existing yuborilmaydi), javob o`zgarmaydi', async () => {
    const fx = makeController({ inScope: [] });

    const res: any = await fx.controller.botOrderCreate(
      {
        name: 'Ali',
        phone_number: '+998901112233',
        district_id: '5',
        address: 'Bot manzil',
        total_price: 1000,
        order_item_info: [{ product_id: '10', quantity: 1 }],
      } as any,
      userReq('501', ['market_operator']),
    );

    expect(
      fx.calls(fx.identityClient, 'identity.customer.create')[0][1],
    ).toEqual({
      dto: {
        name: 'Ali',
        phone_number: '+998901112233',
        district_id: '5',
        extra_number: undefined,
        address: 'Bot manzil',
      },
    });
    expect(res).not.toHaveProperty('customer_card_updated');
    expect(fx.createdDto()).not.toHaveProperty('extra_number');
  });
});
