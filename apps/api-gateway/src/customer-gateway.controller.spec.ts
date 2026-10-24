import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Observable, of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CUSTOMER_SUGGEST_CANDIDATES,
  CUSTOMER_SUGGEST_LIMIT,
  CustomerGatewayController,
} from './customer-gateway.controller';

/**
 * hiqRNhkI — GET /customers/suggest: telefon bo'yicha mijoz taklifi.
 * Doira: market/operator/filial xodimi — faqat shu marketda buyurtmasi
 * bo'lgan mijozlar; admin — hammasi.
 */
type Send = jest.Mock<Observable<unknown>, [{ cmd: string }, any]>;

const customer = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Mijoz ${id}`,
  phone_number: '+998991330152',
  extra_number: '+998901112233',
  address: 'Chilonzor 5',
  region_id: '1',
  district_id: '11',
  role: 'customer',
  username: null,
  salary: 0,
  tariff_home: null,
  telegram_id: 'tg-secret',
  ...extra,
});

const setup = (opts?: {
  customers?: Array<Record<string, unknown>>;
  summary?: Array<Record<string, unknown>>;
  operatorMarketId?: string | null;
}) => {
  const identitySend: Send = jest.fn<
    Observable<unknown>,
    [{ cmd: string }, any]
  >((pattern) => {
    if (pattern.cmd === 'identity.customer.search') {
      return of({ success: true, data: opts?.customers ?? [] });
    }
    return of({
      data: {
        id: '501',
        market_id:
          opts && 'operatorMarketId' in opts ? opts.operatorMarketId : '121',
      },
    });
  });
  const orderSend: Send = jest.fn<Observable<unknown>, [{ cmd: string }, any]>(
    () => of({ statusCode: 200, data: { items: opts?.summary ?? [] } }),
  );
  const controller = new CustomerGatewayController(
    { send: identitySend } as any,
    { send: orderSend } as any,
  );
  return { controller, identitySend, orderSend };
};

const MARKET = { sub: '121', roles: ['market'] };
const ADMIN = { sub: '1', roles: ['admin'] };
const OPERATOR = { sub: '501', roles: ['market_operator'] };
const REGISTRATOR = { sub: '77', roles: ['registrator'] };

const searchCall = (send: Send) =>
  send.mock.calls.find(([p]) => p.cmd === 'identity.customer.search')?.[1];

describe('hiqRNhkI — GET /customers/suggest', () => {
  it('rollar: buyurtma yaratuvchilar; kuryer/mijoz/investor/logist/ichki operator yo`q', () => {
    const handler = Object.getOwnPropertyDescriptor(
      CustomerGatewayController.prototype,
      'suggest',
    )?.value as object;
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[];
    expect(roles).toEqual(
      expect.arrayContaining([
        'superadmin',
        'admin',
        'registrator',
        'manager',
        'branch',
        'market',
        'market_operator',
      ]),
    );
    for (const denied of [
      'courier',
      'customer',
      'investor',
      'logist',
      'operator',
    ]) {
      expect(roles).not.toContain(denied);
    }
  });

  it('telefon emas / juda qisqa — 400, identity chaqirilmaydi', async () => {
    const { controller, identitySend } = setup();
    for (const bad of [undefined, '', 'Ali', '99133', '99 13a 30152']) {
      await expect(
        controller.suggest(bad, undefined, { user: MARKET }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(identitySend).not.toHaveBeenCalled();
  });

  it('⭐ TC1/TC2: market — mavjud mijoz taklifi, autofill maydonlari (ism/viloyat/tuman/manzil/qo`shimcha raqam)', async () => {
    const { controller, identitySend, orderSend } = setup({
      customers: [customer('153')],
      summary: [{ customer_id: '153', orders: 2, new_orders: 0 }],
    });
    const res = await controller.suggest('991330152', '999', { user: MARKET });
    expect(searchCall(identitySend)).toEqual({
      search: '991330152',
      limit: CUSTOMER_SUGGEST_CANDIDATES,
      // 9444UAa8: qo'shimcha raqam bo'yicha ham.
      match_extra_number: true,
    });
    // query'dagi market_id E'TIBORSIZ — doim o'z marketi.
    expect(orderSend).toHaveBeenCalledWith(
      { cmd: 'order.customer.market_summary' },
      { market_id: '121', customer_ids: ['153'] },
    );
    expect(res.data).toEqual([
      {
        id: '153',
        name: 'Mijoz 153',
        phone_number: '+998991330152',
        extra_number: '+998901112233',
        address: 'Chilonzor 5',
        region_id: '1',
        district_id: '11',
        orders_count: 2,
        new_orders_count: 0,
        has_new_orders: false,
        new_order_ids: [],
        last_order_at: null,
        // 9444UAa8: identity `matched_by` bermasa — sukut `phone`.
        matched_by: 'phone',
      },
    ]);
  });

  it('javob oq ro`yxat — username/salary/telegram_id/role va h.k. yo`q', async () => {
    const { controller } = setup({
      customers: [customer('153', { password: 'hash' })],
      summary: [{ customer_id: '153', orders: 1, new_orders: 0 }],
    });
    const res = await controller.suggest('991330152', undefined, {
      user: MARKET,
    });
    expect(JSON.stringify(res.data)).not.toMatch(
      /username|salary|telegram_id|tariff|password|"role"/,
    );
  });

  it('⭐ TC5 / maxfiylik: market — o`z marketida buyurtmasi yo`q mijoz taklif QILINMAYDI', async () => {
    const { controller } = setup({
      customers: [customer('153'), customer('154')],
      summary: [{ customer_id: '154', orders: 1, new_orders: 0 }],
    });
    const res = await controller.suggest('+998 99 133 01 52', undefined, {
      user: MARKET,
    });
    expect(res.data.map((row) => row.id)).toEqual(['154']);
  });

  it('⭐ TC5: yangi raqam — identity bo`sh, order-service chaqirilmaydi, bo`sh ro`yxat', async () => {
    const { controller, orderSend } = setup({ customers: [] });
    const res = await controller.suggest('901234567', undefined, {
      user: MARKET,
    });
    expect(res.data).toEqual([]);
    expect(orderSend).not.toHaveBeenCalled();
  });

  it('⭐ TC4: shu marketda `new` buyurtma bo`lsa — has_new_orders va id`lar', async () => {
    const { controller } = setup({
      customers: [customer('153')],
      summary: [
        {
          customer_id: '153',
          orders: 3,
          new_orders: 1,
          new_order_ids: ['9001'],
          last_order_at: '2026-10-14T05:00:00.000Z',
        },
      ],
    });
    const res = await controller.suggest('991330152', undefined, {
      user: MARKET,
    });
    expect(res.data[0]).toMatchObject({
      has_new_orders: true,
      new_orders_count: 1,
      new_order_ids: ['9001'],
      last_order_at: '2026-10-14T05:00:00.000Z',
    });
  });

  it('market_operator — biriktirilgan market; biriktirilmagan — 400', async () => {
    const ok = setup({
      customers: [customer('153')],
      summary: [{ customer_id: '153', orders: 1, new_orders: 0 }],
    });
    await ok.controller.suggest('991330152', '999', { user: OPERATOR });
    expect(ok.orderSend).toHaveBeenCalledWith(
      { cmd: 'order.customer.market_summary' },
      { market_id: '121', customer_ids: ['153'] },
    );

    const none = setup({ operatorMarketId: null });
    await expect(
      none.controller.suggest('991330152', undefined, { user: OPERATOR }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('registrator — market_id majburiy (400), berilsa shu market bilan cheklanadi', async () => {
    const none = setup();
    await expect(
      none.controller.suggest('991330152', undefined, { user: REGISTRATOR }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      none.controller.suggest('991330152', '12;drop', { user: REGISTRATOR }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const ok = setup({
      customers: [customer('153'), customer('154')],
      summary: [{ customer_id: '153', orders: 1, new_orders: 0 }],
    });
    const res = await ok.controller.suggest('991330152', '3', {
      user: REGISTRATOR,
    });
    expect(ok.orderSend).toHaveBeenCalledWith(
      { cmd: 'order.customer.market_summary' },
      { market_id: '3', customer_ids: ['153', '154'] },
    );
    expect(res.data.map((row) => row.id)).toEqual(['153']);
  });

  it('admin — market_id siz: barcha mijozlar, order-service chaqirilmaydi, statistika null', async () => {
    const { controller, identitySend, orderSend } = setup({
      customers: [customer('153')],
    });
    const res = await controller.suggest('991330152', undefined, {
      user: ADMIN,
    });
    expect(searchCall(identitySend)).toEqual({
      search: '991330152',
      limit: CUSTOMER_SUGGEST_LIMIT,
      // 9444UAa8: qo'shimcha raqam bo'yicha ham.
      match_extra_number: true,
    });
    expect(orderSend).not.toHaveBeenCalled();
    expect(res.data[0]).toMatchObject({
      id: '153',
      orders_count: null,
      new_orders_count: null,
      has_new_orders: false,
    });
  });

  it('admin — market_id bilan: filtrlanmaydi, xulosa qo`shiladi', async () => {
    const { controller } = setup({
      customers: [customer('153'), customer('154')],
      summary: [{ customer_id: '154', orders: 2, new_orders: 1 }],
    });
    const res = await controller.suggest('991330152', '121', { user: ADMIN });
    expect(
      res.data.map((row) => [row.id, row.orders_count, row.has_new_orders]),
    ).toEqual([
      ['153', 0, false],
      ['154', 2, true],
    ]);
  });

  it(`ko'pi bilan ${CUSTOMER_SUGGEST_LIMIT} ta taklif`, async () => {
    const ids = Array.from({ length: 30 }, (_, i) => String(100 + i));
    const { controller } = setup({
      customers: ids.map((id) => customer(id)),
      summary: ids.map((id) => ({
        customer_id: id,
        orders: 1,
        new_orders: 0,
      })),
    });
    const res = await controller.suggest('9913301', undefined, {
      user: MARKET,
    });
    expect(res.data).toHaveLength(CUSTOMER_SUGGEST_LIMIT);
  });
});
