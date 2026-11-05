import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { of } from 'rxjs';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * GykuOz8f — `GET /orders/extra-costs` va
 * `GET /orders/extra-costs/:id/proofs/:index` (gateway).
 *
 *  - rollar: kuryer, menejer, market, market operatori; admin / superadmin
 *    yo'q (RolesGuard 403);
 *  - so'rovchi FAQAT tokendan (`sub`, rollar, JWT `branch_id`); operator
 *    marketi identity'dan, biriktirilmagan — 403;
 *  - tab / limit tekshiruvi, sahifalash meta javobga qo'shiladi;
 *  - isbot baytlari `files/:key/content` sarlavhalari bilan.
 */
type Handlers = Record<string, unknown>;

function makeClient(handlers: Handlers = {}) {
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

function setup(
  orderHandlers: Handlers = {},
  identity: Handlers = {},
  file: ReturnType<typeof makeClient> | null = makeClient({
    'file.read': {
      data: {
        body_base64: Buffer.from('rasm-baytlari').toString('base64'),
        mime_type: 'image/jpeg',
      },
    },
  }),
) {
  const order = makeClient(orderHandlers);
  const identityClient = makeClient(identity);
  const controller = new OrderGatewayController(
    order as never,
    identityClient as never,
    makeClient() as never,
    makeClient() as never,
    (file ?? undefined) as never,
  );
  return { controller, order, identity: identityClient, file };
}

const req = (
  sub: string,
  roles: string[],
  extra: Record<string, unknown> = {},
) => ({ user: { sub, username: 'u', roles, ...extra } }) as never;

const sentTo = (order: { send: jest.Mock }, cmd: string) =>
  (order.send.mock.calls as unknown[][])
    .filter((args) => (args[0] as { cmd: string }).cmd === cmd)
    .map((args) => args[1] as Record<string, unknown>);

const handler = (name: keyof OrderGatewayController) =>
  Object.getOwnPropertyDescriptor(OrderGatewayController.prototype, name)
    ?.value as object;

describe('GykuOz8f — GET /orders/extra-costs (gateway)', () => {
  it.each([['pageExtraCosts'], ['getExtraCostProof']] as Array<
    [keyof OrderGatewayController]
  >)(
    '%s — kuryer, menejer, market, operator; admin / superadmin YO‘Q',
    (name) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toEqual([
        JwtAuthGuard,
        RolesGuard,
      ]);
      const roles = Reflect.getMetadata(ROLES_KEY, handler(name)) as string[];
      expect([...roles].sort()).toEqual(
        ['courier', 'manager', 'market', 'market_operator'].sort(),
      );
    },
  );

  it('⭐ so‘rovchi tokendan (JWT branch_id bilan), tab / page / limit uzatiladi, meta qo‘shiladi', async () => {
    const { controller, order, identity } = setup({
      'order.extra_cost.page': {
        statusCode: 200,
        message: 'Extra costs',
        data: {
          items: [{ id: '7' }],
          total: 23,
          page: 2,
          limit: 10,
          counts: { all: 30, pending: 23, approved: 5, cancelled: 2 },
        },
      },
    });

    const res = (await controller.pageExtraCosts(
      req('201', ['Manager'], { branch_id: 77 }),
      'Pending',
      '2',
      '10',
    )) as {
      statusCode: number;
      message: string;
      data: Record<string, unknown>;
    };

    expect(sentTo(order, 'order.extra_cost.page')).toEqual([
      {
        tab: 'pending',
        page: 2,
        limit: 10,
        requester: { id: '201', roles: ['manager'], branch_id: '77' },
      },
    ]);
    expect(identity.send).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      statusCode: 200,
      message: 'Extra costs',
      data: {
        items: [{ id: '7' }],
        total: 23,
        page: 2,
        limit: 10,
        counts: { all: 30, pending: 23, approved: 5, cancelled: 2 },
        total_pages: 3,
        totalPages: 3,
        from: 11,
        to: 20,
        has_next: true,
        has_prev: true,
      },
    });
  });

  it('tab berilmasa — all; kuryerda filial yo‘q — branch_id null', async () => {
    const { controller, order } = setup();

    await controller.pageExtraCosts(req('301', ['courier']));

    expect(sentTo(order, 'order.extra_cost.page')).toEqual([
      {
        tab: 'all',
        page: 1,
        limit: 10,
        requester: { id: '301', roles: ['courier'], branch_id: null },
      },
    ]);
  });

  it('⭐ noma’lum tab — 400 «Noto‘g‘ri tab»; ruxsatsiz limit — 400; order-service chaqirilmaydi', async () => {
    const { controller, order } = setup();

    await expect(
      controller.pageExtraCosts(req('301', ['courier']), 'rejected'),
    ).rejects.toThrow(new BadRequestException("Noto'g'ri tab"));
    await expect(
      controller.pageExtraCosts(req('301', ['courier']), 'all', '1', '500'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(order.send).not.toHaveBeenCalled();
  });

  it('⭐ market operatori — market identity’dan; biriktirilmagan — 403', async () => {
    const assigned = setup(
      {},
      { 'identity.user.find_by_id': { data: { id: '26', market_id: '501' } } },
    );
    await assigned.controller.pageExtraCosts(
      req('26', ['market_operator'], { market_id: '999' }),
      'all',
    );
    expect(assigned.identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      { id: '26' },
    );
    expect(
      sentTo(assigned.order, 'order.extra_cost.page')[0].requester,
    ).toEqual({
      id: '26',
      roles: ['market_operator'],
      branch_id: null,
      market_id: '501',
    });

    const unassigned = setup(
      {},
      { 'identity.user.find_by_id': { data: { id: '26', market_id: null } } },
    );
    await expect(
      unassigned.controller.pageExtraCosts(req('26', ['market_operator'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(unassigned.order.send).not.toHaveBeenCalled();
  });

  it('market — identity chaqirilmaydi, market_id qo‘shilmaydi (order-service doirasi: market_id = sub)', async () => {
    const { controller, order, identity } = setup();

    await controller.pageExtraCosts(req('501', ['market']), 'cancelled');

    expect(identity.send).not.toHaveBeenCalled();
    expect(sentTo(order, 'order.extra_cost.page')[0]).toEqual({
      tab: 'cancelled',
      page: 1,
      limit: 10,
      requester: { id: '501', roles: ['market'], branch_id: null },
    });
  });
});

describe('GykuOz8f — GET /orders/extra-costs/:id/proofs/:index (gateway)', () => {
  const response = () => {
    const headers: Record<string, string> = {};
    const res = {
      headers,
      setHeader: jest.fn((name: string, value: string) => {
        headers[name] = value;
      }),
      send: jest.fn((body: unknown) => body),
    };
    return res;
  };

  it('⭐ ko‘rinadigan isbot — baytlar, `files/:key/content` sarlavhalari bilan', async () => {
    const { controller, order, file } = setup({
      'order.extra_cost.proof': {
        statusCode: 200,
        data: { key: 'proofs/301/a.jpg', index: 1, count: 2 },
      },
    });
    const res = response();

    await controller.getExtraCostProof(
      '7',
      '1',
      req('301', ['courier']),
      res as never,
    );

    expect(sentTo(order, 'order.extra_cost.proof')).toEqual([
      {
        id: '7',
        index: 1,
        requester: { id: '301', roles: ['courier'], branch_id: null },
      },
    ]);
    expect(file!.send).toHaveBeenCalledWith(
      { cmd: 'file.read' },
      { key: 'proofs/301/a.jpg' },
    );
    expect(res.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'Content-Length': String(Buffer.from('rasm-baytlari').length),
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    expect((res.send.mock.calls[0][0] as Buffer).toString()).toBe(
      'rasm-baytlari',
    );
  });

  it('⭐ id / raqam noto‘g‘ri — 404, order-service va fayl xizmati chaqirilmaydi', async () => {
    const { controller, order, file } = setup();

    await expect(
      controller.getExtraCostProof(
        'abc',
        '0',
        req('301', ['courier']),
        response() as never,
      ),
    ).rejects.toThrow(new NotFoundException("So'rov topilmadi"));
    await expect(
      controller.getExtraCostProof(
        '7',
        '-1',
        req('301', ['courier']),
        response() as never,
      ),
    ).rejects.toThrow(new NotFoundException('Isbot fayli topilmadi'));
    expect(order.send).not.toHaveBeenCalled();
    expect(file!.send).not.toHaveBeenCalled();
  });

  it('kalit qaytmadi — 404; fayl xizmati sozlanmagan — 503', async () => {
    const empty = setup({ 'order.extra_cost.proof': { data: {} } });
    await expect(
      empty.controller.getExtraCostProof(
        '7',
        '0',
        req('501', ['market']),
        response() as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(empty.file!.send).not.toHaveBeenCalled();

    const noFile = setup(
      { 'order.extra_cost.proof': { data: { key: 'proofs/a.jpg' } } },
      {},
      null,
    );
    await expect(
      noFile.controller.getExtraCostProof(
        '7',
        '0',
        req('501', ['market']),
        response() as never,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('operator biriktirilmagan — 403, order-service chaqirilmaydi', async () => {
    const { controller, order } = setup(
      {},
      { 'identity.user.find_by_id': { data: { id: '26', market_id: null } } },
    );

    await expect(
      controller.getExtraCostProof(
        '7',
        '0',
        req('26', ['market_operator']),
        response() as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(order.send).not.toHaveBeenCalled();
  });
});
