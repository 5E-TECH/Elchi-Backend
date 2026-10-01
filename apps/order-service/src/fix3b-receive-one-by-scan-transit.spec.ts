/**
 * fix3b (CODE-11) — P1b `receiveOneOrderByScan`: TRANZIT buyurtma.
 *
 * Butun paketni qabul qilish (`receiveBranchTransferBatch`) paket hududidagi
 * (`target_region_id`) buyurtmani RECEIVED, boshqa hududnikini (tranzit) NEW
 * qiladi — u bu filialda faqat qayta jo'natilguncha turadi. Kuryer skani esa
 * HAR DOIM RECEIVED qilardi va tranzit buyurtma shu filial kuryeriga
 * yetkazishga chiqib ketardi. Endi skan ham AYNI qoidani qo'llaydi va
 * tranzitda `received: false, reason: 'transit'` qaytaradi — logistika skani
 * `received` false bo'lsa kuryerga biriktirmaydi.
 */
import {
  BranchTransferBatchStatus,
  BranchTransferDirection,
  Order_status,
} from '@app/common';
import { OrderHolderType } from './entities/order.entity';
import { BranchTransferBatchService } from './transfer-batch/branch-transfer-batch.service';

type Row = Record<string, unknown>;

function chainableQb() {
  const setCalls: Row[] = [];
  const qb: Record<string, unknown> = {};
  const chain = () => qb;
  Object.assign(qb, {
    update: jest.fn(chain),
    set: jest.fn((payload: Row) => {
      setCalls.push(payload);
      return qb;
    }),
    where: jest.fn(chain),
    andWhere: jest.fn(chain),
    execute: jest.fn(() => Promise.resolve({ affected: 1 })),
  });
  return { qb, setCalls };
}

function setup(options: { order?: Row; batch?: Row; remainingItems?: number }) {
  const order = {
    id: '900',
    status: Order_status.ON_THE_ROAD,
    region_id: '5',
    current_batch_id: '700',
    holder_type: OrderHolderType.HQ,
    holder_branch_id: null,
    holder_courier_id: null,
    ...options.order,
  };
  const batch = {
    id: '700',
    status: BranchTransferBatchStatus.SENT,
    direction: BranchTransferDirection.FORWARD,
    destination_branch_id: '10',
    source_branch_id: '1',
    target_region_id: '5',
    ...options.batch,
  };
  const item = {
    id: 'i1',
    batch_id: '700',
    order_id: '900',
    sent_at: new Date(),
  };

  const orderQb = chainableQb();
  const itemQb = chainableQb();
  const orderRepo = {
    findOne: jest.fn(() => Promise.resolve(order)),
    createQueryBuilder: jest.fn(() => orderQb.qb),
  };
  const batchRepo = {
    findOne: jest.fn(() => Promise.resolve(batch)),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
  };
  const itemRepo = {
    findOne: jest.fn(() => Promise.resolve(item)),
    createQueryBuilder: jest.fn(() => itemQb.qb),
    count: jest.fn(() => Promise.resolve(options.remainingItems ?? 0)),
  };
  const historyRepo = {
    create: jest.fn((x: Row) => x),
    save: jest.fn((x: Row) => Promise.resolve(x)),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: { name: string }) => {
        switch (entity.name) {
          case 'Order':
            return orderRepo;
          case 'BranchTransferBatch':
            return batchRepo;
          case 'BranchTransferBatchItem':
            return itemRepo;
          case 'BranchTransferBatchHistory':
            return historyRepo;
          default:
            return { create: jest.fn((x: Row) => x), save: jest.fn() };
        }
      }),
    },
  };
  const custody = {
    toTrackingRole: jest.fn(() => 'courier'),
    auditActor: jest.fn(() => ({ user_id: '5', user_role: 'courier' })),
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    createCustodyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };

  const service = new BranchTransferBatchService(
    { createQueryRunner: jest.fn(() => queryRunner) } as never,
    batchRepo as never,
    itemRepo as never,
    historyRepo as never,
    orderRepo as never,
    {} as never,
    {} as never,
    activityLog as never,
    custody as never,
  );
  return {
    service,
    orderSet: orderQb.setCalls,
    batchRepo,
    historyRepo,
    custody,
    activityLog,
    queryRunner,
  };
}

const CALL = {
  order_id: '900',
  courier_branch_id: '10',
  requester_id: '5',
  requester_roles: ['courier'],
};

type ReplyData = Record<string, unknown>;
const dataOf = (res: unknown): ReplyData => (res as { data: ReplyData }).data;

describe('fix3b — receiveOneOrderByScan: tranzit buyurtma NEW bo`ladi', () => {
  it('⭐ boshqa hudud buyurtmasi: filialga qabul (custody), holat NEW, kuryerga BIRIKTIRILMAYDI', async () => {
    const h = setup({ order: { region_id: '7' }, remainingItems: 2 });

    const res = await h.service.receiveOneOrderByScan(CALL);

    expect(h.orderSet[0]).toEqual(
      expect.objectContaining({
        current_batch_id: null,
        branch_id: '10',
        status: Order_status.NEW,
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: '10',
        holder_courier_id: null,
      }),
    );
    expect(dataOf(res)).toMatchObject({
      received: false,
      reason: 'transit',
      order_id: '900',
      branch_id: '10',
      status: Order_status.NEW,
      batch_closed: false,
    });
    // Tracking — butun paket qabulidagi tranzit yozuvi bilan bir xil.
    expect(h.custody.createTrackingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: '900',
        from_status: Order_status.ON_THE_ROAD,
        to_status: Order_status.NEW,
        action: 'branch_batch_requeued',
      }),
      expect.anything(),
    );
    // Custody zanjiri baribir uzilmaydi: posilka jismonan filialda.
    expect(h.custody.createCustodyEvent).toHaveBeenCalledTimes(1);
    expect(h.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        new_value: { status: Order_status.NEW },
        metadata: expect.objectContaining({ transit: true }),
      }),
    );
    expect(h.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('viloyati yo`q buyurtma ham tranzit (butun paket qabuli kabi)', async () => {
    const h = setup({ order: { region_id: null } });

    const res = await h.service.receiveOneOrderByScan(CALL);

    expect(h.orderSet[0]).toMatchObject({ status: Order_status.NEW });
    expect(dataOf(res)).toMatchObject({ received: false, reason: 'transit' });
  });

  it('oxirgi element tranzit bo`lsa ham paket yopiladi', async () => {
    const h = setup({ order: { region_id: '7' }, remainingItems: 0 });

    const res = await h.service.receiveOneOrderByScan(CALL);

    expect(dataOf(res)).toMatchObject({ batch_closed: true });
    expect(h.batchRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: BranchTransferBatchStatus.RECEIVED }),
    );
  });

  it('paket hududidagi buyurtma — avvalgidek RECEIVED, received: true (regressiya)', async () => {
    const h = setup({ order: { region_id: '5' }, remainingItems: 1 });

    const res = await h.service.receiveOneOrderByScan(CALL);

    expect(h.orderSet[0]).toMatchObject({ status: Order_status.RECEIVED });
    expect(dataOf(res)).toMatchObject({ received: true, branch_id: '10' });
    expect(dataOf(res)).not.toHaveProperty('reason');
    expect(h.custody.createTrackingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        to_status: Order_status.RECEIVED,
        action: 'branch_batch_received_by_scan',
      }),
      expect.anything(),
    );
  });

  it('allaqachon NEW bo`lgan tranzit buyurtmada ortiqcha tracking yozilmaydi', async () => {
    const h = setup({
      order: { region_id: '7', status: Order_status.NEW },
      remainingItems: 1,
    });

    await h.service.receiveOneOrderByScan(CALL);

    expect(h.custody.createTrackingEvent).not.toHaveBeenCalled();
  });
});
