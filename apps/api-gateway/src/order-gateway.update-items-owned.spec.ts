/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { NotFoundException } from '@nestjs/common';
import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * Buyurtmani tahrirlash oynasida «Mahsulot qo'shish» (Qabul va yaratish):
 * PATCH /orders/:id/full da QO'SHILGAN mahsulot aynan shu buyurtma
 * marketiniki bo'lishi shart (yaratishdagi UER0MpMX bilan bir xil). Buyurtmada
 * allaqachon turgan mahsulot qayta tekshirilmaydi.
 */
type Handler = unknown;

function client(handlers: Record<string, Handler> = {}) {
  return {
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      const handler = handlers[pattern.cmd];
      const value =
        typeof handler === 'function'
          ? (handler as (p: unknown) => unknown)(payload)
          : handler;
      return of(value ?? { statusCode: 200, data: {} });
    }),
  };
}

const ORDER_ROW = {
  id: '60',
  market_id: '77',
  status: 'new',
  items: [{ id: 'i1', product_id: '501', quantity: 1 }],
};

function setup(catalogRows: Array<Record<string, unknown>>) {
  const order = client({
    'order.find_by_id': ORDER_ROW,
    'order.update_from_api': { statusCode: 200, data: { id: '60' } },
  });
  const catalog = client({
    'catalog.product.find_by_ids': (payload: { ids: string[] }) => ({
      statusCode: 200,
      data: catalogRows.filter((row) => payload.ids.includes(String(row.id))),
    }),
  });
  const controller = new OrderGatewayController(
    order as any,
    client() as any,
    client() as any,
    client() as any,
    undefined,
    undefined,
    catalog as any,
  );
  return { controller, order, catalog };
}

const admin = { user: { sub: '1', username: 'a', roles: ['admin'] } } as any;
const cmds = (c: { send: jest.Mock }) =>
  c.send.mock.calls.map(([pattern]) => (pattern as { cmd: string }).cmd);

describe("PATCH /orders/:id/full — qo'shilgan mahsulot shu marketniki", () => {
  it("shu marketning mahsuloti qo'shiladi; mavjud mahsulot tekshirilmaydi", async () => {
    const { controller, order, catalog } = setup([
      { id: '502', user_id: '77' },
    ]);
    await controller.updateFull(
      '60',
      {
        items: [
          { product_id: '501', quantity: 1 },
          { product_id: '502', quantity: 2 },
        ],
      },
      admin,
    );
    expect(catalog.send).toHaveBeenCalledTimes(1);
    expect(catalog.send.mock.calls[0][1]).toEqual({ ids: ['502'] });
    expect(cmds(order)).toContain('order.update_from_api');
  });

  it("boshqa marketning mahsuloti — 404, buyurtma o'zgarmaydi", async () => {
    const { controller, order } = setup([{ id: '999', user_id: '12' }]);
    await expect(
      controller.updateFull(
        '60',
        { items: [{ product_id: '999', quantity: 1 }] },
        admin,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(cmds(order)).not.toContain('order.update_from_api');
  });

  it("faqat son o'zgarsa (yangi mahsulot yo'q) — katalog so'ralmaydi", async () => {
    const { controller, catalog, order } = setup([]);
    await controller.updateFull(
      '60',
      { items: [{ product_id: '501', quantity: 3 }] },
      admin,
    );
    expect(catalog.send).not.toHaveBeenCalled();
    expect(cmds(order)).toContain('order.update_from_api');
  });

  it("items yuborilmasa — tekshiruv yo'q (izoh, summa)", async () => {
    const { controller, catalog, order } = setup([]);
    await controller.updateFull('60', { comment: 'x' }, admin);
    expect(catalog.send).not.toHaveBeenCalled();
    expect(cmds(order)).toEqual(['order.update_from_api']);
  });
});
