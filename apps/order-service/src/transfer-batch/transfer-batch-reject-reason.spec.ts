/**
 * Skan auditi 2026-11-23 (#88) — paketga qo'shib bo'lmagan buyurtma SABABI bilan.
 *
 * Ilgari har sabab bitta matn edi («…topilmadi, … yoki allaqachon boshqa
 * paketga biriktirilgan») — filial skanerida frontend «allaqachon» ni ko'rib
 * topilmagan yoki begona buyurtmani «allaqachon qabul qilingan» deb
 * yashirardi. Endi faqat haqiqatan paketda turgan buyurtma matnida
 * «allaqachon» bor.
 */
import { RpcException } from '@nestjs/microservices';
import { Order_status } from '@app/common';
import { BranchTransferBatchService } from './branch-transfer-batch.service';

type Row = Record<string, unknown>;

const svcWith = (rows: Row[]) => {
  const svc = Object.create(BranchTransferBatchService.prototype) as Record<
    string,
    unknown
  >;
  svc.orderRepo = { find: jest.fn(() => Promise.resolve(rows)) };
  return svc as unknown as {
    rejectUnassignableOrders: (
      source: string,
      selected: string[],
      assignable: string[],
    ) => Promise<never>;
  };
};

const errorOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode: number;
    code: string;
    message: string;
    details: Row;
  };
};

describe('transfer batch — qo‘shib bo‘lmagan buyurtma sababi (#88)', () => {
  it('bazada yo‘q — ORDER_NOT_FOUND, matnda «allaqachon» yo‘q', async () => {
    const svc = svcWith([]);
    const error = await errorOf(svc.rejectUnassignableOrders('7', ['11'], []));
    expect(error).toMatchObject({ statusCode: 400, code: 'ORDER_NOT_FOUND' });
    expect(error.message).not.toMatch(/allaqachon/i);
  });

  it('begona filial — ORDER_OTHER_BRANCH', async () => {
    const svc = svcWith([
      { id: '11', branch_id: '9', status: Order_status.NEW },
    ]);
    const error = await errorOf(svc.rejectUnassignableOrders('7', ['11'], []));
    expect(error.code).toBe('ORDER_OTHER_BRANCH');
    expect(error.message).not.toMatch(/allaqachon/i);
  });

  it('⭐ allaqachon paketda — ORDER_ALREADY_IN_BATCH, «allaqachon» va paket id', async () => {
    const svc = svcWith([
      {
        id: '11',
        branch_id: '7',
        status: Order_status.NEW,
        current_batch_id: '55',
      },
    ]);
    const error = await errorOf(
      svc.rejectUnassignableOrders('7', ['10', '11'], ['10']),
    );
    expect(error.code).toBe('ORDER_ALREADY_IN_BATCH');
    expect(error.message).toMatch(/allaqachon/);
    expect(error.details).toEqual({ order_id: '11', batch_id: '55' });
  });

  it('yangi emas — ORDER_NOT_NEW (holat bilan), «allaqachon» yo‘q', async () => {
    const svc = svcWith([
      { id: '11', branch_id: '7', status: Order_status.RECEIVED },
    ]);
    const error = await errorOf(svc.rejectUnassignableOrders('7', ['11'], []));
    expect(error.code).toBe('ORDER_NOT_NEW');
    expect(error.details).toEqual({
      order_id: '11',
      status: Order_status.RECEIVED,
    });
    expect(error.message).not.toMatch(/allaqachon/i);
  });
});
