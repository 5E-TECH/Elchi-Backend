/**
 * Buyurtma formasidagi «Operator» tanlovi — order-service tomoni.
 *
 * Gateway tanlangan operatorni (`POST /orders` `operator_id`) buyurtma
 * marketi bo'yicha tekshiradi va `order.create` payloadining YUQORI
 * darajasida `verified_operator_id` bilan yuboradi. Bu spec qotiradi:
 *  1) controller faqat raqamli `verified_operator_id` ni lifecycle'ga
 *     `opts.verifiedOperatorId` bo'lib o'tkazadi (boshqasi — e'tiborsiz,
 *     opts umuman uzatilmaydi);
 *  2) lifecycle `operator_id` ni FAQAT shu ishonchli qiymatdan oladi:
 *     admin bo'lmagan so'rovchining xom `dto.operator_id` si avvalgidek
 *     olib tashlanadi (gateway'ni chetlab o'tgan yo'llar uchun himoya);
 *  3) tanlov bo'lmasa — avvalgi xulq (registrator / market operatori —
 *     o'zi, market — null, admin — DTO'dagi qiymat).
 */
import type { RmqContext } from '@nestjs/microservices';
import { of } from 'rxjs';
import { OrderServiceController } from './order-service.controller';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order } from './entities/order.entity';

type Row = Record<string, unknown>;
type Svc = OrderLifecycleService & Record<string, any>;

/** Test dubli — kerakli tipga keltiriladi (faqat ishlatilgan metodlar bor). */
const stub = <T>(value: unknown): T => value as T;

const HQ_ID = '1';
const MARKET = { id: '501', roles: ['market'] };
const MARKET_OPERATOR = { id: '77', roles: ['market_operator'] };
const REGISTRATOR = { id: '301', roles: ['registrator'] };
const ADMIN = { id: '2', roles: ['admin'] };

const DTO = {
  market_id: '501',
  customer_id: '801',
  total_price: 150000,
  district_id: '12',
  region_id: '3',
  items: [{ product_id: '41', quantity: 1 }],
};

// ───────────────────────── controller ─────────────────────────

function setupController() {
  const lifecycle = {
    create: jest.fn().mockResolvedValue({
      statusCode: 201,
      message: 'success',
      data: { id: '9001' },
    }),
  };
  const controller = new OrderServiceController(
    stub({ ack: jest.fn(), nack: jest.fn(), nackForError: jest.fn() }),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
    stub(lifecycle),
    stub({}),
    stub({ resolve: jest.fn() }),
  );
  return { controller, lifecycle };
}

const ctx = stub<RmqContext>({});

describe('order.create — verified_operator_id (controller)', () => {
  it('⭐ raqamli id → lifecycle.create(dto, requester, { verifiedOperatorId })', async () => {
    const { controller, lifecycle } = setupController();

    await controller.create(
      { dto: DTO, requester: MARKET, verified_operator_id: '26' },
      ctx,
    );

    expect(lifecycle.create).toHaveBeenCalledWith(DTO, MARKET, {
      verifiedOperatorId: '26',
    });
  });

  it.each([['abc'], [''], ['26; drop'], [26], [null], [undefined]])(
    'verified_operator_id=%p → opts uzatilmaydi (oddiy yo`l o`zgarmaydi)',
    async (value) => {
      const { controller, lifecycle } = setupController();

      await controller.create(
        {
          dto: DTO,
          requester: MARKET,
          verified_operator_id: value as string,
        },
        ctx,
      );

      expect(lifecycle.create).toHaveBeenCalledWith(DTO, MARKET);
    },
  );

  it('bot kanali bilan birga — ikkala opts ham', async () => {
    const { controller, lifecycle } = setupController();

    await controller.create(
      {
        dto: DTO,
        requester: MARKET_OPERATOR,
        created_via: 'bot',
        verified_operator_id: '77',
      },
      ctx,
    );

    expect(lifecycle.create).toHaveBeenCalledWith(DTO, MARKET_OPERATOR, {
      createdVia: 'bot',
      verifiedOperatorId: '77',
    });
  });
});

// ───────────────────────── lifecycle ─────────────────────────

/** Yaratish oqimi — faqat `orderRepo.create` ushlanadi (fix3-lifecycle-scope kabi). */
function makeCreateHarness() {
  const orderCreate = jest.fn((value: Row) => value);
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: unknown) =>
        entity === Order
          ? {
              create: orderCreate,
              save: jest.fn((value: Row) =>
                Promise.resolve({ id: '900', product_quantity: 0, ...value }),
              ),
              update: jest.fn(),
            }
          : {
              createQueryBuilder: () => ({
                insert: () => ({ values: () => ({ execute: jest.fn() }) }),
              }),
            },
      ),
    },
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    branchClient: { send: jest.fn(() => of({ data: null })) },
    lookup: { getHqBranchId: jest.fn().mockResolvedValue(HQ_ID) },
    custody: {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'market'),
      auditActor: jest.fn(() => ({})),
    },
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    activityLog,
    findById: jest.fn().mockResolvedValue({ id: '900' }),
  });
  const createdRow = (): Row => {
    expect(orderCreate).toHaveBeenCalledTimes(1);
    return orderCreate.mock.calls[0][0];
  };
  return { s, createdRow, activityLog };
}

describe('lifecycle.create — operator_id faqat ishonchli yo`ldan', () => {
  it('⭐ market: xom dto.operator_id olib tashlanadi (null); tekshirilgan id — yoziladi', async () => {
    const raw = makeCreateHarness();
    await raw.s.create({ ...DTO, operator_id: '5', operator: 'Matn' }, MARKET);
    expect(raw.createdRow()).toMatchObject({
      operator_id: null,
      operator: 'Matn',
    });

    const verified = makeCreateHarness();
    await verified.s.create(
      { ...DTO, operator_id: '5', operator: 'Dilnoza' },
      MARKET,
      { verifiedOperatorId: '26' },
    );
    expect(verified.createdRow()).toMatchObject({
      operator_id: '26',
      operator: 'Dilnoza',
    });
  });

  it('⭐ registrator: tekshirilgan id so`rovchidan USTUN; xom dto.operator_id — so`rovchi o`zi', async () => {
    const verified = makeCreateHarness();
    await verified.s.create(DTO, REGISTRATOR, {
      verifiedOperatorId: '26',
    });
    expect(verified.createdRow().operator_id).toBe('26');

    const raw = makeCreateHarness();
    await raw.s.create({ ...DTO, operator_id: '5' }, REGISTRATOR);
    expect(raw.createdRow().operator_id).toBe(REGISTRATOR.id);
  });

  it('market operatori: tanlovsiz — o`zi (avvalgidek), xom dto.operator_id e`tiborsiz', async () => {
    const h = makeCreateHarness();
    await h.s.create({ ...DTO, operator_id: '5' }, MARKET_OPERATOR);
    expect(h.createdRow().operator_id).toBe(MARKET_OPERATOR.id);
  });

  it('admin: DTO qiymati avvalgidek; tekshirilgan id bo`lsa — u ustun', async () => {
    const plain = makeCreateHarness();
    await plain.s.create({ ...DTO, operator_id: '5' }, ADMIN);
    expect(plain.createdRow().operator_id).toBe('5');

    const verified = makeCreateHarness();
    await verified.s.create({ ...DTO, operator_id: null }, ADMIN, {
      verifiedOperatorId: '26',
    });
    expect(verified.createdRow().operator_id).toBe('26');
  });

  it('audit (CREATED) metadata`sida ham o`sha operator', async () => {
    const h = makeCreateHarness();
    await h.s.create(DTO, MARKET, { verifiedOperatorId: '26' });
    const [entry] = h.activityLog.log.mock.calls[0] as [
      { metadata?: Record<string, unknown> },
    ];
    expect(entry.metadata).toMatchObject({ operator_id: '26' });
  });
});
