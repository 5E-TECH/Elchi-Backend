import { RpcException } from '@nestjs/microservices';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order_status } from '@app/common';

// Audit money P1: a courier/manager rolling a PARTLY_PAID order back to WAITING
// flipped the status WITHOUT reversing the credited market/courier/branch cash
// (doSaleReversal only reverses PARTLY_PAID for superadmin), leaving a
// double-credit realised on re-sell. The guard now forbids it at the permission
// layer.
describe('rollbackOrderToWaiting PARTLY_PAID guard', () => {
  function makeService() {
    return new OrderLifecycleService(
      {} as any, // dataSource
      {} as any, // orderRepo
      {} as any, // orderItemRepo
      {} as any, // orderTrackingRepo
      {} as any, // orderCustodyEventRepo
      {} as any, // transferBatchRepo
      {} as any, // searchClient
      {} as any, // identityClient
      {} as any, // catalogClient
      {} as any, // financeClient
      {} as any, // integrationClient
      {} as any, // branchClient
      {} as any, // fileClient
      {} as any, // outbox
      { log: jest.fn().mockResolvedValue(undefined) } as any, // activityLog
      {
        getHqBranchId: jest.fn().mockResolvedValue('1'),
        getMarketsByIds: jest.fn().mockResolvedValue([]),
        getCouriersByIds: jest.fn().mockResolvedValue([]),
        getUserById: jest.fn().mockResolvedValue(null),
        getCashboxByUser: jest.fn().mockResolvedValue(null),
        resolveBranchShare: jest.fn().mockResolvedValue(0),
        ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
        resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
        getIntegrationById: jest.fn().mockResolvedValue(null),
        getDefaultDistrictId: jest.fn().mockResolvedValue(null),
        resolveDistrictId: jest.fn().mockResolvedValue(null),
      } as any, // lookup (OrderLookupService)
    );
  }

  it('rejects a non-superadmin manager rolling back a PARTLY_PAID order', async () => {
    const service = makeService();
    jest
      .spyOn(service, 'findById')
      .mockResolvedValue({
        id: '900',
        status: Order_status.PARTLY_PAID,
      } as any);

    const err = await service
      .rollbackOrderToWaiting(
        { id: '5', roles: ['manager'], branch_id: '7' },
        '900',
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(RpcException);
    expect((err as RpcException).getError()).toMatchObject({
      message: expect.stringContaining('superadmin'),
    });
  });

  it('lets superadmin past the PARTLY_PAID guard (rejection, if any, is downstream not the guard)', async () => {
    const service = makeService();
    jest
      .spyOn(service, 'findById')
      .mockResolvedValue({
        id: '900',
        status: Order_status.PARTLY_PAID,
      } as any);

    const err = await service
      .rollbackOrderToWaiting({ id: '1', roles: ['superadmin'] }, '900')
      .catch((e) => e);

    // Superadmin passes the guard; any error here is from later lookups on the
    // empty mocks — it must NOT be the PARTLY_PAID superadmin-only message.
    const message =
      err instanceof RpcException
        ? JSON.stringify((err as RpcException).getError())
        : String(err ?? '');
    expect(message).not.toContain('faqat superadmin WAITING');
  });
});
