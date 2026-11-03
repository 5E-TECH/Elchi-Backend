import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { ScanGatewayController } from './scan-gateway.controller';

/**
 * anKpzwxk (ega qarori 7) — BEGONA QR `GET /scan/:token` (buyurtma tokeni)
 * yo'lida ham: `GET /orders/qr-code/:token` bilan AYNI filial doirasi.
 * Ilgari bu yo'l faqat market qoidasini qo'llardi — begona filial
 * menejeri/kuryeri to'liq buyurtmani (manzil, summa, mijoz) olardi.
 */
type Handlers = Record<string, unknown>;

const HQ_BRANCH_ID = '1';
const OWN_BRANCH_ID = '5';
const FOREIGN_BRANCH_ID = '6';

function makeClient(handlers: Handlers = {}) {
  return {
    send: jest.fn((pattern: { cmd: string }) => {
      const handler = handlers[pattern.cmd];
      if (handler instanceof Error) {
        return throwError(() => handler);
      }
      return of(handler ?? { statusCode: 200, data: null });
    }),
  };
}

function setup(opts: { order?: Handlers; branch?: Handlers } = {}) {
  const order = makeClient(opts.order);
  const branch = makeClient({
    'branch.find_hq': { statusCode: 200, data: { id: HQ_BRANCH_ID } },
    ...opts.branch,
  });
  const logistics = makeClient();
  const controller = new ScanGatewayController(
    order as any,
    branch as any,
    logistics as any,
  );
  return { controller, order, branch };
}

const cmds = (client: { send: jest.Mock }) =>
  (client.send.mock.calls as unknown[][]).map(
    (args) => (args[0] as { cmd: string }).cmd,
  );

const req = (sub: string, roles: string[], branchId?: string) =>
  ({
    user: { sub, roles, ...(branchId ? { branch_id: branchId } : {}) },
  }) as any;

const fullOrder = (overrides: Record<string, unknown> = {}) => ({
  id: '77',
  market_id: '201',
  branch_id: OWN_BRANCH_ID,
  holder_branch_id: OWN_BRANCH_ID,
  holder_courier_id: null,
  courier_id: null,
  current_batch_id: null,
  total_price: 150000,
  address: 'Urgut, Mustaqillik 1',
  customer: { id: '9', name: 'Mijoz', phone_number: '+998901234567' },
  ...overrides,
});

const foreign = () =>
  fullOrder({
    branch_id: FOREIGN_BRANCH_ID,
    holder_branch_id: FOREIGN_BRANCH_ID,
  });

const LIGHT = {
  statusCode: 200,
  data: { id: '77', market_id: '201', customer_name: 'Mijoz' },
};

const rejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('kutilgan rad etish yo`q');
    },
    (error: unknown) => error,
  );

const courierBranch = (branchId: string) => ({
  'branch.user.find_by_user': {
    statusCode: 200,
    data: { branch_id: branchId, role: 'COURIER' },
  },
});

describe('anKpzwxk — GET /scan/:token begona filial buyurtmasi', () => {
  it.each([
    ['menejer', req('50', ['manager'], OWN_BRANCH_ID), {}],
    ['kuryer', req('70', ['courier']), courierBranch(OWN_BRANCH_ID)],
  ])(
    '%s: begona filial -> 403 order_not_in_your_branch, ma`lumotsiz, qop qidirilmaydi',
    async (_l, request, branch) => {
      const { controller, order } = setup({
        order: { 'order.find_by_qr': { statusCode: 200, data: foreign() } },
        branch,
      });
      const error = await rejection(controller.scan('ORD-x', request));
      expect(error).toBeInstanceOf(ForbiddenException);
      const body = (error as ForbiddenException).getResponse();
      expect(body).toEqual({
        statusCode: 403,
        message: 'Bu buyurtma sizning filialingizda emas',
        data: { reason: 'order_not_in_your_branch' },
      });
      expect(JSON.stringify(body)).not.toMatch(/Mijoz|Urgut|150000|\+998/);
      expect(cmds(order)).not.toContain('order.find_batch_by_external_token');
    },
  );

  it('menejer: ?view=light — doira AVVAL, rad etilsa yengil javob olinmaydi', async () => {
    const { controller, order } = setup({
      order: {
        'order.find_by_qr': { statusCode: 200, data: foreign() },
        'order.find_by_qr_light': LIGHT,
      },
    });
    const error = await rejection(
      controller.scan('ORD-x', req('50', ['manager'], OWN_BRANCH_ID), 'light'),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      data: { reason: 'order_not_in_your_branch' },
    });
    expect(cmds(order)).toEqual(['order.find_by_qr']);
  });

  it('menejer: o`z filiali — to`liq va yengil javob', async () => {
    const { controller, order } = setup({
      order: {
        'order.find_by_qr': { statusCode: 200, data: fullOrder() },
        'order.find_by_qr_light': LIGHT,
      },
    });
    await expect(
      controller.scan('ORD-x', req('50', ['manager'], OWN_BRANCH_ID)),
    ).resolves.toMatchObject({ type: 'order', data: { id: '77' } });
    await expect(
      controller.scan('ORD-x', req('50', ['manager'], OWN_BRANCH_ID), 'light'),
    ).resolves.toMatchObject({ type: 'order', data: { id: '77' } });
    expect(cmds(order)).toEqual([
      'order.find_by_qr',
      'order.find_by_qr',
      'order.find_by_qr_light',
    ]);
  });

  it('kuryer: o`zidagi buyurtma (begona filialda bo`lsa ham) -> ko`rinadi', async () => {
    const { controller, branch } = setup({
      order: {
        'order.find_by_qr': {
          statusCode: 200,
          data: fullOrder({
            branch_id: FOREIGN_BRANCH_ID,
            holder_branch_id: null,
            holder_courier_id: '70',
            courier_id: '70',
          }),
        },
      },
    });
    await expect(
      controller.scan('ORD-x', req('70', ['courier'])),
    ).resolves.toMatchObject({ type: 'order', data: { id: '77' } });
    expect(cmds(branch)).not.toContain('branch.user.find_by_user');
  });

  it.each([
    ['HQ menejeri', req('60', ['manager'], HQ_BRANCH_ID), {}],
    ['HQ kuryeri', req('61', ['courier']), courierBranch(HQ_BRANCH_ID)],
    ['superadmin', req('1', ['superadmin']), {}],
    ['admin', req('2', ['admin']), {}],
  ])(
    '%s: begona filial buyurtmasi -> cheklanmaydi',
    async (_l, request, branch) => {
      const { controller } = setup({
        order: { 'order.find_by_qr': { statusCode: 200, data: foreign() } },
        branch,
      });
      await expect(controller.scan('ORD-x', request)).resolves.toMatchObject({
        type: 'order',
        data: { id: '77', address: expect.any(String) },
      });
    },
  );

  it('HQ registratori ?view=light — qo`shimcha buyurtma so`rovi yo`q', async () => {
    const { controller, order } = setup({
      order: { 'order.find_by_qr_light': LIGHT },
    });
    await expect(
      controller.scan(
        'ORD-x',
        req('60', ['registrator'], HQ_BRANCH_ID),
        'light',
      ),
    ).resolves.toMatchObject({ type: 'order' });
    expect(cmds(order)).toEqual(['order.find_by_qr_light']);
  });

  it('MARKET: o`zgarmagan — o`ziniki OK (filial so`ralmaydi), begona -> eski 403', async () => {
    const own = setup({
      order: { 'order.find_by_qr': { statusCode: 200, data: foreign() } },
    });
    await expect(
      own.controller.scan('ORD-x', req('201', ['market'])),
    ).resolves.toMatchObject({ type: 'order', data: { id: '77' } });
    expect(own.branch.send).not.toHaveBeenCalled();

    const other = setup({
      order: { 'order.find_by_qr': { statusCode: 200, data: fullOrder() } },
    });
    const error = await rejection(
      other.controller.scan('ORD-x', req('202', ['market'])),
    );
    expect((error as ForbiddenException).message).toBe(
      "Bu buyurtmani ko'rishga ruxsat yo'q",
    );
  });

  it('kuryer: filialga biriktirilmagan -> 403 branch_not_assigned', async () => {
    const { controller } = setup({
      order: { 'order.find_by_qr': { statusCode: 200, data: fullOrder() } },
    });
    const error = await rejection(
      controller.scan('ORD-x', req('70', ['courier'])),
    );
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      statusCode: 403,
      data: { reason: 'branch_not_assigned' },
    });
  });

  it('kuryer: filial xizmati yiqildi -> 503 (fail-closed), qop qidirilmaydi', async () => {
    const { controller, order } = setup({
      order: { 'order.find_by_qr': { statusCode: 200, data: fullOrder() } },
      branch: { 'branch.user.find_by_user': new Error('branch down') },
    });
    await expect(
      controller.scan('ORD-x', req('70', ['courier'])),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(cmds(order)).not.toContain('order.find_batch_by_external_token');
  });

  it('menejer: buyurtma topilmadi (404) -> avvalgidek qop qidiruvi', async () => {
    const notFound = Object.assign(new Error('nf'), { statusCode: 404 });
    const { controller, order } = setup({
      order: {
        'order.find_by_qr': notFound,
        'order.find_batch_by_external_token': {
          statusCode: 200,
          data: { external_batch_token: 'BAG1' },
        },
      },
    });
    await expect(
      controller.scan('BAG1', req('50', ['manager'], OWN_BRANCH_ID), 'light'),
    ).resolves.toMatchObject({ type: 'batch' });
    expect(cmds(order)).toEqual([
      'order.find_by_qr',
      'order.find_batch_by_external_token',
    ]);
  });
});
