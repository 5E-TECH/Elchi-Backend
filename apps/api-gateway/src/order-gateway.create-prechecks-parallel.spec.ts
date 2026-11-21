import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { of, Subject } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';
import { CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE } from './order-create/order-chosen-operator';
import { OPERATOR_PHONE_REQUIRED_MESSAGE } from './order-create/order-operator-phone';

/**
 * `createOrderInternal` — mijoz yaratilishidan OLDINgi tekshiruvlar (market,
 * mahsulotlar, tanlangan operator, operator ismi) BIRDANIGA ishga tushadi,
 * lekin xato TARTIBI avvalgidek: market → mahsulotlar → operator raqami →
 * tanlangan operator. Keyingi tekshiruv tezroq yiqilsa ham birinchi (tartib
 * bo'yicha) xato qaytadi.
 */

const MARKET = '201';
const PRECHECK_CMDS = [
  'identity.market.find_by_id',
  'catalog.product.find_by_ids',
  'identity.market_operator.selectable',
] as const;
type PrecheckCmd = (typeof PRECHECK_CMDS)[number];

const dto = {
  customer: { name: 'Ali', phone_number: '+998901112233', district_id: '5' },
  total_price: 120000,
  district_id: '5',
  region_id: '2',
  address: 'Chilonzor',
  operator_id: '31',
  items: [{ product_id: '10', quantity: 1 }],
};

const ACTIVE_MARKET = {
  data: { id: MARKET, status: 'active', add_order: true },
};
const OWNED_PRODUCTS = { data: [{ id: '10', user_id: MARKET }] };
const SELECTABLE = { data: { items: [{ id: '31', name: 'Dilnoza' }] } };

function makeController() {
  const pending = new Map<PrecheckCmd, Subject<unknown>>();
  const subjectFor = (cmd: PrecheckCmd) => {
    const subject = new Subject<unknown>();
    pending.set(cmd, subject);
    return subject.asObservable();
  };
  const orderClient = {
    send: jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'order.create'
        ? of({ statusCode: 201, data: { id: '500' } })
        : of({}),
    ),
  };
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }) => {
      if (pattern.cmd === 'identity.customer.create') {
        return of({ statusCode: 201, data: { id: 'c-new' } });
      }
      if ((PRECHECK_CMDS as readonly string[]).includes(pattern.cmd)) {
        return subjectFor(pattern.cmd as PrecheckCmd);
      }
      return of({});
    }),
  };
  const catalogClient = {
    send: jest.fn(() => subjectFor('catalog.product.find_by_ids')),
  };
  const none = { send: jest.fn(() => of({})) };
  const controller = new OrderGatewayController(
    orderClient as never,
    identityClient as never,
    none as never,
    none as never,
    undefined,
    undefined,
    catalogClient as never,
  );

  const answer = (cmd: PrecheckCmd, value: unknown) => {
    const subject = pending.get(cmd);
    if (!subject) throw new Error(`${cmd} yuborilmagan`);
    subject.next(value);
    subject.complete();
  };
  const fail = (cmd: PrecheckCmd, error: unknown) => {
    const subject = pending.get(cmd);
    if (!subject) throw new Error(`${cmd} yuborilmagan`);
    subject.error(error);
  };
  const create = (body: Record<string, unknown> = dto) =>
    controller.create(body as never, {
      user: { sub: MARKET, username: 'm', roles: ['market'] },
    });
  const created = () =>
    orderClient.send.mock.calls.filter(
      (call: unknown[]) => (call[0] as { cmd: string }).cmd === 'order.create',
    );
  const customerCreated = () =>
    identityClient.send.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { cmd: string }).cmd === 'identity.customer.create',
    );
  return { pending, answer, fail, create, created, customerCreated };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createOrderInternal — oldindan tekshiruvlar parallel', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeAll(() => process.on('unhandledRejection', onUnhandled));
  afterAll(() => process.off('unhandledRejection', onUnhandled));
  beforeEach(() => {
    unhandled.length = 0;
  });

  it('market, mahsulot va operator so‘rovlari BIRDANIGA yuboriladi (javob kutmasdan)', async () => {
    const t = makeController();
    const pending = t.create();
    await flush();

    // Hech biri hali javob bermagan — uchala RPC allaqachon yo'lda.
    expect([...t.pending.keys()].sort()).toEqual([...PRECHECK_CMDS].sort());

    t.answer('identity.market_operator.selectable', SELECTABLE);
    t.answer('catalog.product.find_by_ids', OWNED_PRODUCTS);
    t.answer('identity.market.find_by_id', ACTIVE_MARKET);
    await expect(pending).resolves.toBeDefined();
    expect(t.created()).toHaveLength(1);
  });

  it('mahsulot tekshiruvi OLDINROQ yiqilsa ham market xatosi qaytadi (tartib saqlanadi)', async () => {
    const t = makeController();
    const pending = t.create();
    const assertion = expect(pending).rejects.toThrow(
      new NotFoundException('Market topilmadi'),
    );
    await flush();

    t.fail('catalog.product.find_by_ids', new Error('catalog down'));
    t.fail('identity.market_operator.selectable', { statusCode: 500 });
    await flush();
    t.answer('identity.market.find_by_id', { data: null });

    await assertion;
    expect(t.customerCreated()).toHaveLength(0);
    expect(t.created()).toHaveLength(0);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('market to‘g‘ri: operator xatosi oldin kelsa ham mahsulot xatosi qaytadi', async () => {
    const t = makeController();
    const pending = t.create();
    const assertion = expect(pending).rejects.toThrow(
      new ServiceUnavailableException(
        "Mahsulotlarni tekshirib bo'lmadi — keyinroq qayta urinib ko'ring",
      ),
    );
    await flush();

    t.answer('identity.market_operator.selectable', { data: { items: [] } });
    await flush();
    t.fail('catalog.product.find_by_ids', new Error('catalog down'));
    t.answer('identity.market.find_by_id', ACTIVE_MARKET);

    await assertion;
    expect(t.customerCreated()).toHaveLength(0);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('operator raqami majburiy bo‘lsa — tanlangan operator xatosidan OLDIN', async () => {
    const t = makeController();
    const pending = t.create();
    const assertion = expect(pending).rejects.toMatchObject({
      response: expect.objectContaining({
        message: OPERATOR_PHONE_REQUIRED_MESSAGE,
      }) as unknown,
    });
    await flush();

    t.answer('identity.market_operator.selectable', { data: { items: [] } });
    t.answer('catalog.product.find_by_ids', OWNED_PRODUCTS);
    t.answer('identity.market.find_by_id', {
      data: { ...ACTIVE_MARKET.data, require_operator_phone: true },
    });

    await assertion;
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('qolgani to‘g‘ri — tanlangan operator xatosi (400) avvalgidek', async () => {
    const t = makeController();
    const pending = t.create();
    const assertion = expect(pending).rejects.toThrow(
      new BadRequestException(CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE),
    );
    await flush();

    t.answer('identity.market.find_by_id', ACTIVE_MARKET);
    t.answer('catalog.product.find_by_ids', OWNED_PRODUCTS);
    await flush();
    t.answer('identity.market_operator.selectable', { data: { items: [] } });

    await assertion;
    expect(t.customerCreated()).toHaveLength(0);
  });
});
