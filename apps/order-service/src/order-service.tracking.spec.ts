import { OrderServiceService } from './order-service.service';
import { Order_status } from '@app/common';

function createService() {
  const orderRepo = {
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    findOne: jest.fn(),
  };
  const orderItemRepo = {
    createQueryBuilder: jest.fn(),
    delete: jest.fn(),
  };
  const trackingRepo = {
    create: jest.fn((payload) => payload),
    save: jest.fn(),
    find: jest.fn(),
  };

  const qb = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  orderItemRepo.createQueryBuilder.mockReturnValue(qb);

  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: { name: string }) => {
        if (entity.name === 'Order') return orderRepo;
        if (entity.name === 'OrderItem') return orderItemRepo;
        return trackingRepo;
      }),
    },
  };

  const dataSource = {
    createQueryRunner: jest.fn(() => queryRunner),
  };

  const nullClient = { send: jest.fn() };
  const outbox = { enqueue: jest.fn() };
  // OrderServiceService konstruktori — 16 ta pozitsion bog'liqlik.
  const service = new OrderServiceService(
    dataSource as any, // dataSource
    orderRepo as any, // orderRepo
    orderItemRepo as any, // orderItemRepo
    trackingRepo as any, // orderTrackingRepo
    {} as any, // orderCustodyEventRepo
    {} as any, // transferBatchRepo
    {} as any, // transferBatchItemRepo
    {} as any, // transferBatchHistoryRepo
    nullClient as any, // searchClient
    nullClient as any, // identityClient
    nullClient as any, // logisticsClient
    nullClient as any, // catalogClient
    nullClient as any, // financeClient
    nullClient as any, // integrationClient
    nullClient as any, // branchClient
    nullClient as any, // fileClient
    outbox as any, // outbox
  );

  jest.spyOn<any, any>(service as any, 'syncOrderToSearch').mockResolvedValue(undefined);

  return { service, orderRepo, trackingRepo, queryRunner };
}

describe('Order tracking lifecycle', () => {
  it('create -> tracking created event', async () => {
    const { service, orderRepo, trackingRepo, queryRunner } = createService();

    const savedOrder = {
      id: '101',
      status: Order_status.NEW,
      product_quantity: 0,
    };
    orderRepo.create.mockReturnValue(savedOrder);
    orderRepo.save.mockResolvedValue(savedOrder);
    orderRepo.update.mockResolvedValue(undefined);
    jest.spyOn(service, 'findById').mockResolvedValue({ ...savedOrder, items: [] } as any);

    await service.create(
      {
        market_id: '1',
        customer_id: '2',
      },
      // JWT branch_id — yangi kod order uchun branch_id'ni hal qilishni talab qiladi.
      { id: '900', roles: ['admin'], branch_id: '10' },
    );

    expect(queryRunner.startTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(trackingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: '101',
        from_status: null,
        to_status: Order_status.CREATED,
      }),
    );
  });

  it('update status -> tracking row added', async () => {
    const { service, orderRepo, trackingRepo } = createService();

    const baseOrder = {
      id: '202',
      status: Order_status.WAITING,
      market_id: '1',
      customer_id: '2',
      where_deliver: 'center',
      total_price: 100,
      to_be_paid: 0,
      paid_amount: 0,
      return_requested: false,
      comment: null,
      operator: null,
      post_id: null,
      canceled_post_id: null,
      sold_at: null,
      district_id: null,
      region_id: null,
      address: null,
      qr_code_token: null,
      external_id: null,
      source: 'internal',
      isDeleted: false,
    };

    jest
      .spyOn(service, 'findById')
      .mockResolvedValueOnce({ ...baseOrder, items: [] } as any)
      .mockResolvedValueOnce({ ...baseOrder, status: Order_status.SOLD, items: [] } as any);

    orderRepo.save.mockResolvedValue(undefined);

    await service.updateFull(
      '202',
      { status: Order_status.SOLD },
      { id: '55', roles: ['courier'], note: 'sold by courier' },
    );

    expect(trackingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: '202',
        from_status: Order_status.WAITING,
        to_status: Order_status.SOLD,
        changed_by: '55',
        changed_by_role: 'courier',
      }),
    );
  });

  it('closed -> final tracking exists', async () => {
    const { service, orderRepo, trackingRepo } = createService();

    const baseOrder = {
      id: '303',
      status: Order_status.WAITING,
      market_id: '1',
      customer_id: '2',
      where_deliver: 'center',
      total_price: 100,
      to_be_paid: 0,
      paid_amount: 0,
      return_requested: false,
      comment: null,
      operator: null,
      post_id: null,
      canceled_post_id: null,
      sold_at: null,
      district_id: null,
      region_id: null,
      address: null,
      qr_code_token: null,
      external_id: null,
      source: 'internal',
      isDeleted: false,
    };

    jest
      .spyOn(service, 'findById')
      .mockResolvedValueOnce({ ...baseOrder, items: [] } as any)
      .mockResolvedValueOnce({ ...baseOrder, status: Order_status.CLOSED, items: [] } as any);

    orderRepo.save.mockResolvedValue(undefined);

    await service.updateFull(
      '303',
      { status: Order_status.CLOSED },
      { id: '1', roles: ['admin'], note: 'closed manually' },
    );

    expect(trackingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: '303',
        from_status: Order_status.WAITING,
        to_status: Order_status.CLOSED,
      }),
    );
  });

  it('create supports BRANCH source with branch/courier fields', async () => {
    const { service, orderRepo } = createService();

    orderRepo.create.mockImplementation((payload: any) => payload);
    orderRepo.save.mockImplementation(async (payload: any) => ({ ...payload, id: '404' }));
    orderRepo.update.mockResolvedValue(undefined);
    jest.spyOn(service, 'findById').mockResolvedValue({ id: '404', items: [] } as any);

    await service.create(
      {
        market_id: '1',
        customer_id: '2',
        source: 'branch' as any,
        branch_id: '22',
        current_batch_id: '33',
        courier_id: '44',
        assigned_at: '2026-04-25T10:30:00+05:00',
        return_reason: 'old return',
      },
      { id: '900', roles: ['admin'] },
    );

    expect(orderRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'branch',
        branch_id: '22',
        current_batch_id: '33',
        courier_id: '44',
        return_reason: 'old return',
      }),
    );
  });

  it('normalizeUpdatePayload normalizes source and assigned_at', () => {
    const { service } = createService();

    const payload = service.normalizeUpdatePayload({
      source: 'BRANCH',
      status: 'WAITING_CUSTOMER',
      assigned_at: '2026-04-25T10:30:00+05:00',
    });

    expect(payload.source).toBe('branch');
    expect(payload.status).toBe('waiting_customer');
    expect(payload.assigned_at).toBeInstanceOf(Date);
  });
});

describe('markByProvider (status-only provider transition)', () => {
  it('sell → SOLD with a tracking event, no finance emit', async () => {
    const { service, orderRepo, trackingRepo, queryRunner } = createService();
    const order = { id: '500', status: Order_status.WAITING, sold_at: null };
    jest
      .spyOn(service, 'findById')
      .mockResolvedValueOnce(order as any)
      .mockResolvedValueOnce({ ...order, status: Order_status.SOLD } as any);
    orderRepo.save.mockResolvedValue(order);

    const res = await service.markByProvider({
      order_id: '500',
      action: 'sell',
      provider_slug: 'acme-cargo',
      external_ref: 'ACME-9',
    });

    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: Order_status.SOLD }),
    );
    expect(trackingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        to_status: Order_status.SOLD,
        changed_by_role: 'system',
      }),
    );
    expect(res.data).toMatchObject({ status: Order_status.SOLD });
  });

  it('cancel → CANCELLED', async () => {
    const { service, orderRepo } = createService();
    const order = { id: '501', status: Order_status.ON_THE_ROAD, sold_at: null };
    jest
      .spyOn(service, 'findById')
      .mockResolvedValueOnce(order as any)
      .mockResolvedValueOnce({ ...order, status: Order_status.CANCELLED } as any);
    orderRepo.save.mockResolvedValue(order);

    const res = await service.markByProvider({ order_id: '501', action: 'cancel' });
    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: Order_status.CANCELLED }),
    );
    expect(res.data).toMatchObject({ status: Order_status.CANCELLED });
  });

  it('return → CLOSED', async () => {
    const { service, orderRepo } = createService();
    const order = { id: '502', status: Order_status.WAITING, sold_at: null };
    jest
      .spyOn(service, 'findById')
      .mockResolvedValueOnce(order as any)
      .mockResolvedValueOnce({ ...order, status: Order_status.CLOSED } as any);
    orderRepo.save.mockResolvedValue(order);

    const res = await service.markByProvider({ order_id: '502', action: 'return' });
    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: Order_status.CLOSED }),
    );
    expect(res.data).toMatchObject({ status: Order_status.CLOSED });
  });

  it('is idempotent — selling an already-sold order is a no-op', async () => {
    const { service, orderRepo, queryRunner } = createService();
    const order = { id: '503', status: Order_status.SOLD, sold_at: '123' };
    jest.spyOn(service, 'findById').mockResolvedValueOnce(order as any);

    const res = await service.markByProvider({ order_id: '503', action: 'sell' });

    expect(res.data).toMatchObject({ skipped: true, status: Order_status.SOLD });
    expect(orderRepo.save).not.toHaveBeenCalled();
    expect(queryRunner.startTransaction).not.toHaveBeenCalled();
  });
});
