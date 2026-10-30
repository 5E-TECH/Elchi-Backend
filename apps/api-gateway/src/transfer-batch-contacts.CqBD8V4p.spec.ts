import { firstValueFrom, isObservable, of, throwError } from 'rxjs';
import { BranchGatewayController } from './branch-gateway.controller';
import { ProblemContactsService } from './contacts/problem-contacts.service';
import { LogisticsGatewayController } from './logistics-gateway.controller';
import { ScanGatewayController } from './scan-gateway.controller';

/**
 * CqBD8V4p (T7-2, karta 2-bandi) — `problem_contacts` qolib ketgan ikki joy:
 *  - `GET /transfer-batches/:id` va `/remaining`: `items[].order` (FE paket
 *    sahifasi ham chop etadi);
 *  - `GET /scan/POST-…`: `orders[]` qisqa shaklda (`market_id`/`customer_id`
 *    yo'q, `order_number` + `region_id`/`district_id` bor).
 * Sahifaga BITTA RPC (N+1 yo'q), proyeksiyadan OLDIN.
 */
const LOGIST = { name: 'Logist', phone: '+998901112233', source: 'logist' };
const SUPPORT = { name: null, phone: '+998712001122', source: 'support' };

const identityReply = {
  statusCode: 200,
  data: {
    regions: { '1': [LOGIST], '6': [LOGIST] },
    districts: { '10': [LOGIST] },
    fallback: [SUPPORT],
  },
};

const contacts = (reply: unknown = identityReply) => {
  const identity = { send: jest.fn(() => of(reply)) };
  return {
    identity,
    service: new ProblemContactsService(identity as never),
  };
};

const fullOrder = (id: number, over: Record<string, unknown> = {}) => ({
  id: String(id),
  market_id: '37',
  customer_id: '29',
  region_id: '1',
  district_id: '10',
  operator_phone: '+998901234500',
  market: { id: '37', phone_number: '+998901234567' },
  ...over,
});

const batch = (count: number) => ({
  id: '501',
  target_region_id: '1',
  items: Array.from({ length: count }, (_, index) => ({
    id: String(9000 + index),
    order_id: String(100 + index),
    order: fullOrder(100 + index),
  })),
});

const user = (roles: string[]) => ({ user: { sub: '25', roles } });

const unwrap = (value: unknown): Promise<any> =>
  isObservable(value) ? firstValueFrom(value) : Promise.resolve(value);

const logistScope = { regionIds: jest.fn(() => Promise.resolve(['1'])) };

describe('CqBD8V4p — GET /transfer-batches/:id va /remaining', () => {
  const build = (
    problem: ProblemContactsService | undefined,
    data: unknown = batch(14),
  ) =>
    new BranchGatewayController(
      { send: jest.fn(() => of(data)) } as never,
      logistScope as never,
      problem,
    );

  it.each([
    ['findTransferBatchById', ['superadmin']],
    ['findTransferBatchById', ['manager']],
    ['findTransferBatchById', ['registrator']],
    ['findRemainingTransferBatchById', ['admin']],
    ['findRemainingTransferBatchById', ['branch']],
  ] as const)(
    '⭐ %s %j: har items[].order da problem_contacts, 14 buyurtmaga bitta RPC',
    async (method, roles) => {
      const { service, identity } = contacts();
      const res = await unwrap(build(service)[method]('501', user([...roles])));
      expect(res.items).toHaveLength(14);
      for (const item of res.items) {
        expect(item.order.problem_contacts).toEqual([LOGIST]);
      }
      expect(identity.send).toHaveBeenCalledTimes(1);
    },
  );

  it('logist yo`li — problem_contacts bor, pul maydonlari yo`q', async () => {
    const { service } = contacts();
    const data = batch(1);
    data.items[0].order = fullOrder(100, { market_tariff: 20000 });
    const res = await unwrap(
      build(service, data).findTransferBatchById('501', user(['logist'])),
    );
    expect(res.items[0].order.problem_contacts).toEqual([LOGIST]);
    expect(res.items[0].order).not.toHaveProperty('market_tariff');
  });

  it('menejer: market/operator telefoni baribir yo`q (proyeksiya keyin)', async () => {
    const { service } = contacts();
    const res = await unwrap(
      build(service).findTransferBatchById('501', user(['manager'])),
    );
    const order = res.items[0].order;
    expect(order).not.toHaveProperty('operator_phone');
    expect(order.market).not.toHaveProperty('phone_number');
  });

  it('identity javob bermadi — paket javobi buzilmaydi, maydon yo`q', async () => {
    const identity = { send: jest.fn(() => throwError(() => new Error('x'))) };
    const service = new ProblemContactsService(identity as never);
    const res = await unwrap(
      build(service).findTransferBatchById('501', user(['admin'])),
    );
    expect(res.items[0].order).not.toHaveProperty('problem_contacts');
    expect(res.items).toHaveLength(14);
  });

  it('`order: null` qator (xulosa olinmagan) yiqilmaydi', async () => {
    const { service } = contacts();
    const data = { id: '501', items: [{ id: '1', order: null }] };
    const res = await unwrap(
      build(service, data).findRemainingTransferBatchById(
        '501',
        user(['admin']),
      ),
    );
    expect(res.items[0].order).toBeNull();
  });

  it('servis berilmagan (eski spec`lar) — avvalgidek', async () => {
    const res = await unwrap(
      build(undefined).findTransferBatchById('501', user(['admin'])),
    );
    expect(res.items[0].order).not.toHaveProperty('problem_contacts');
  });
});

describe('CqBD8V4p — GET /scan/POST-… orders[] qisqa shakl', () => {
  const TOKEN = 'POST-mh3k2x9a-4f7q1z8c';
  const shortOrder = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    order_number: `EL-${id}`,
    status: 'on the road',
    total_price: 65000,
    where_deliver: 'address',
    customer: { name: 'Ali', phone_number: '+998901234567' },
    region: 'Buxoro viloyati',
    district: 'Buxoro tumani',
    region_id: '6',
    district_id: '60',
    special_categories: [],
    ...over,
  });
  const scan = async (orders: unknown[], problem: ProblemContactsService) => {
    const logistics = {
      send: jest.fn(() =>
        of({
          statusCode: 200,
          data: { id: '90', region_id: '6', orders },
        }),
      ),
    };
    const controller = new ScanGatewayController(
      { send: jest.fn() } as never,
      { send: jest.fn() } as never,
      logistics as never,
      problem,
    );
    return (await controller.scan(TOKEN, {
      user: { sub: '26', roles: ['courier'] },
    })) as any;
  };

  it('⭐ viloyat logisti: har qisqa qatorga, 100 qatorga bitta RPC', async () => {
    const { service, identity } = contacts();
    const orders = Array.from({ length: 100 }, (_, index) =>
      shortOrder(String(700 + index)),
    );
    const res = await scan(orders, service);
    for (const order of res.data.orders) {
      expect(order.problem_contacts).toEqual([LOGIST]);
    }
    expect(identity.send).toHaveBeenCalledTimes(1);
    expect(identity.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ region_ids: ['6'], district_ids: [] }),
    );
  });

  it('`region_id` yo`q — tuman viloyati', async () => {
    const { service, identity } = contacts();
    const res = await scan(
      [shortOrder('700', { region_id: null, district_id: '10' })],
      service,
    );
    expect(res.data.orders[0].problem_contacts).toEqual([LOGIST]);
    expect(identity.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ region_ids: [], district_ids: ['10'] }),
    );
  });

  it('pochta qatorining o`zi buyurtma deb hisoblanmaydi', async () => {
    const { service } = contacts();
    const res = await scan([shortOrder('700')], service);
    expect(res.data).not.toHaveProperty('problem_contacts');
    expect(res.data.orders[0].customer).not.toHaveProperty('problem_contacts');
  });

  it('logist yo`q viloyat — zaxira raqam', async () => {
    const { service } = contacts();
    const res = await scan(
      [shortOrder('700', { region_id: '99', district_id: '990' })],
      service,
    );
    expect(res.data.orders[0].problem_contacts).toEqual([SUPPORT]);
  });

  it('GET /post/scan/:id ham bir xil javob', async () => {
    const { service } = contacts();
    const logistics = {
      send: jest.fn(() =>
        of({
          statusCode: 200,
          data: { id: '90', orders: [shortOrder('700')] },
        }),
      ),
    };
    const controller = new LogisticsGatewayController(
      logistics as never,
      { send: jest.fn() } as never,
      undefined,
      service,
    );
    const res = await unwrap(
      controller.getPostByScan(TOKEN, {
        user: { sub: '26', roles: ['courier'] },
      }),
    );
    expect(res.data.orders[0].problem_contacts).toEqual([LOGIST]);
  });
});
