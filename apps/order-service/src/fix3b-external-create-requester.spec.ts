/**
 * fix3b — POST /orders/external (`order.external.create`).
 *
 *   1. Handler gateway uzatgan so'rovchini `createExternalOrder` ga
 *      UZATADI (ilgari tashlab yuborardi — SA/ADMIN ham imtiyozsiz bo'lib
 *      qolardi).
 *   2. Filial xodimi (registrator/menejer/filial) — buyurtma o'z biriktirilgan
 *      filialida yaratiladi (`createOrderInternal` bilan AYNI), `source`
 *      EXTERNAL bo'lib qoladi. Market — avvalgidek HQ.
 */
import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Order_status } from '@app/common';
import { OrderServiceController } from './order-service.controller';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order, OrderHolderType, Order_source } from './entities/order.entity';

type Row = Record<string, unknown>;
type Svc = OrderLifecycleService & Record<string, any>;
type RpcBody = { statusCode?: number; message?: string };

const HQ_ID = '1';
const REGISTRATOR = { id: '301', roles: ['registrator'] };
const MANAGER = { id: '201', roles: ['manager'] };
const MARKET = { id: '501', roles: ['market'] };
const SUPERADMIN = { id: '1', roles: ['superadmin'] };

async function rpcError(promise: Promise<unknown>): Promise<RpcBody> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as RpcBody;
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

function makeHarness(
  assignment: Row | null | Error = { branch_id: '22', role: 'REGISTRATOR' },
) {
  const mocks = {
    orderCreate: jest.fn((value: Row) => value),
    orderSave: jest.fn((value: Row) =>
      Promise.resolve({ id: '900', product_quantity: 0, ...value }),
    ),
    getBranchAssignmentByUserStrict: jest.fn(() =>
      assignment instanceof Error
        ? Promise.reject(assignment)
        : Promise.resolve(assignment),
    ),
    branchSend: jest.fn(() => of({ data: null })),
  };
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
              create: mocks.orderCreate,
              save: mocks.orderSave,
              update: jest.fn(),
            }
          : {},
      ),
    },
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    branchClient: { send: mocks.branchSend },
    lookup: {
      getHqBranchId: jest.fn().mockResolvedValue(HQ_ID),
      getBranchAssignmentByUserStrict: mocks.getBranchAssignmentByUserStrict,
    },
    custody: {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'system'),
      auditActor: jest.fn(() => ({})),
    },
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    findById: jest.fn().mockResolvedValue({ id: '900' }),
  });
  const createdRow = (): Row => {
    expect(mocks.orderCreate).toHaveBeenCalledTimes(1);
    return mocks.orderCreate.mock.calls[0][0];
  };
  return { s, mocks, createdRow };
}

type ExternalDto = Parameters<OrderLifecycleService['createExternalOrder']>[0];

const ABUSIVE = {
  market_id: '501',
  customer_id: '801',
  total_price: 150000,
  status: Order_status.RECEIVED,
  post_id: '9001',
  courier_id: '289',
  branch_id: '99',
  source: Order_source.BRANCH,
  external_id: 'ext-7',
} as unknown as ExternalDto;

describe('fix3b — order.external.create handleri so`rovchini uzatadi', () => {
  const handler = Object.getOwnPropertyDescriptor(
    OrderServiceController.prototype,
    'createExternal',
  )?.value as (data: unknown, context: RmqContext) => Promise<unknown>;

  it('⭐ data.requester createExternalOrder ga ikkinchi argument bo`lib boradi', async () => {
    const lifecycleService = {
      createExternalOrder: jest.fn().mockResolvedValue({ id: '900' }),
    };
    const executeAndAck = jest.fn(
      (_ctx: RmqContext, fn: () => Promise<unknown>) => fn(),
    );
    const dto = { market_id: '501', customer_id: '801' };

    await handler.call(
      { executeAndAck, lifecycleService },
      { dto, requester: REGISTRATOR },
      {} as RmqContext,
    );

    expect(lifecycleService.createExternalOrder).toHaveBeenCalledWith(
      dto,
      REGISTRATOR,
    );
  });
});

describe('fix3b — createExternalOrder: filial xodimi o`z filialida', () => {
  it('⭐ registrator: branch_id = biriktirilgan filial, source EXTERNAL, holat NEW, hayot sikli maydonlari yo`q', async () => {
    const h = makeHarness({ branch_id: '22', role: 'REGISTRATOR' });

    await h.s.createExternalOrder(ABUSIVE, REGISTRATOR);

    expect(h.mocks.getBranchAssignmentByUserStrict).toHaveBeenCalledWith('301');
    expect(h.createdRow()).toMatchObject({
      branch_id: '22',
      home_branch_id: '22',
      source: Order_source.EXTERNAL,
      status: Order_status.NEW,
      post_id: null,
      courier_id: null,
      external_id: 'ext-7',
      holder_type: OrderHolderType.BRANCH,
      holder_branch_id: '22',
    });
  });

  it('menejer ham xuddi shunday (biriktiruv roli MANAGER)', async () => {
    const h = makeHarness({ branch_id: '23', role: 'MANAGER' });

    await h.s.createExternalOrder(ABUSIVE, MANAGER);

    expect(h.createdRow()).toMatchObject({
      branch_id: '23',
      source: Order_source.EXTERNAL,
      status: Order_status.NEW,
    });
  });

  it('JWT da branch_id bo`lsa RMQ so`ralmaydi', async () => {
    const h = makeHarness();

    await h.s.createExternalOrder(ABUSIVE, { ...REGISTRATOR, branch_id: '24' });

    expect(h.mocks.getBranchAssignmentByUserStrict).not.toHaveBeenCalled();
    expect(h.createdRow()).toMatchObject({ branch_id: '24' });
  });

  it('HQ registratori — HQ (avvalgi natija o`zgarmaydi)', async () => {
    const h = makeHarness({ branch_id: HQ_ID, role: 'REGISTRATOR' });

    await h.s.createExternalOrder(ABUSIVE, REGISTRATOR);

    expect(h.createdRow()).toMatchObject({
      branch_id: HQ_ID,
      holder_type: OrderHolderType.HQ,
      source: Order_source.EXTERNAL,
    });
  });

  it('biriktiruv yo`q — createOrderInternal kabi HQ', async () => {
    const h = makeHarness(null);

    await h.s.createExternalOrder(ABUSIVE, REGISTRATOR);

    expect(h.createdRow()).toMatchObject({ branch_id: HQ_ID });
  });

  it('biriktiruv filialsiz (xodim roli bor) — 400, buyurtma yaratilmaydi', async () => {
    const h = makeHarness({ branch_id: null, role: 'REGISTRATOR' });

    const error = await rpcError(h.s.createExternalOrder(ABUSIVE, REGISTRATOR));

    expect(error).toMatchObject({
      statusCode: 400,
      message: 'Filial xodimi hech qaysi filialga biriktirilmagan',
    });
    expect(h.mocks.orderCreate).not.toHaveBeenCalled();
  });

  it('⭐ branch-service javob bermasa — 503 (jimgina HQ ga tushmaydi)', async () => {
    const h = makeHarness(new Error('timeout'));

    const error = await rpcError(h.s.createExternalOrder(ABUSIVE, REGISTRATOR));

    expect(error.statusCode).toBe(503);
    expect(h.mocks.orderCreate).not.toHaveBeenCalled();
  });

  it('market — filial so`ralmaydi, HQ, holat NEW', async () => {
    const h = makeHarness();

    await h.s.createExternalOrder(ABUSIVE, MARKET);

    expect(h.mocks.getBranchAssignmentByUserStrict).not.toHaveBeenCalled();
    expect(h.createdRow()).toMatchObject({
      branch_id: HQ_ID,
      status: Order_status.NEW,
      source: Order_source.EXTERNAL,
    });
  });

  it('⭐ superadmin — o`z maydonlari (status, filial, pochta) saqlanadi, filial so`ralmaydi', async () => {
    const h = makeHarness();

    await h.s.createExternalOrder(ABUSIVE, SUPERADMIN);

    expect(h.mocks.getBranchAssignmentByUserStrict).not.toHaveBeenCalled();
    expect(h.createdRow()).toMatchObject({
      status: Order_status.RECEIVED,
      branch_id: '99',
      post_id: '9001',
      source: Order_source.EXTERNAL,
    });
  });
});
