import { RpcException } from '@nestjs/microservices';
import { Order_status } from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';

type ServiceHarness = OrderLifecycleService & Record<string, any>;

const requester = { id: '1', roles: ['superadmin'] };

function makeHarness(overrides: Record<string, unknown> = {}) {
  const row = {
    id: '700',
    status: Order_status.RECEIVED,
    market_id: '10',
    post_id: '88',
    canceled_post_id: null,
    total_price: 100_000,
    paid_amount: 0,
    paid_online_amount: 0,
    sold_at: null,
    ...overrides,
  };
  const save = jest.fn().mockResolvedValue(row);
  const query = jest.fn().mockResolvedValue([{ id: '88', status: 'new' }]);
  const tx = {
    query,
    getRepository: jest.fn(() => ({ save })),
  };
  const transaction = jest.fn(
    (work: (manager: typeof tx) => Promise<unknown>) => work(tx),
  );
  const service = Object.create(
    OrderLifecycleService.prototype,
  ) as ServiceHarness;
  Object.assign(service, {
    findById: jest.fn().mockResolvedValue(row),
    dataSource: { transaction },
    removeOrderFromSearch: jest.fn().mockResolvedValue(undefined),
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
  });
  return { service, query, transaction, save };
}

async function statusCode(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return Number((error.getError() as { statusCode?: number }).statusCode);
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

describe("yokjwjXG - superadmin buyurtmani pochtadan xavfsiz o'chiradi", () => {
  it("order va pochta sanog'i/summasi bitta tranzaksiyada yangilanadi", async () => {
    const h = makeHarness();

    await expect(h.service.remove('700', requester)).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(
      h.query.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE "logistics_schema"."posts"'),
      ),
    ).toBe(true);
  });

  it("jo'natilgan pochta buyurtmasini o'chirmaydi", async () => {
    const h = makeHarness();
    h.query.mockResolvedValueOnce([{ id: '88', status: 'sent' }]);

    expect(await statusCode(h.service.remove('700', requester))).toBe(409);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("holat parallel o'zgargan bo'lsa (UPDATE 0 qator) 409, pochta sanog'iga tegilmaydi", async () => {
    const h = makeHarness();
    h.query
      .mockResolvedValueOnce([{ id: '88', status: 'new' }])
      .mockResolvedValueOnce([]);

    expect(await statusCode(h.service.remove('700', requester))).toBe(409);
    expect(
      h.query.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE "logistics_schema"."posts"'),
      ),
    ).toBe(false);
  });

  it("kuryer qo'lidagi buyurtmani o'chirmaydi", async () => {
    const h = makeHarness({ holder_type: 'COURIER' });

    expect(await statusCode(h.service.remove('700', requester))).toBe(409);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("pochtasiz received buyurtma avvalgi yo'l bilan o'chadi (pochta SQL yo'q)", async () => {
    const h = makeHarness({ post_id: null });

    await expect(h.service.remove('700', requester)).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '700', isDeleted: true }),
    );
    expect(h.query).not.toHaveBeenCalled();
  });

  it("oldindan to'langan buyurtmani moliyaviy qaytarishsiz o'chirmaydi", async () => {
    const h = makeHarness({ paid_online_amount: 25_000 });

    expect(await statusCode(h.service.remove('700', requester))).toBe(409);
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
