import { OrderServiceService } from './order-service.service';
import { Roles } from '@app/common';

/**
 * Money-integrity regression guard (Faza 1a).
 *
 * The cashbox `dedup_epoch` for sell/cancel/partly/rollback MUST be derived
 * from the caller's `request_id` so that an RMQ redelivery / idempotency-retry
 * of the SAME operation reuses the SAME epoch — finance's unique idempotency
 * index then collapses the duplicate and the cash is never posted twice,
 * independently of the controller-level idempotency cache.
 *
 * Before the fix the epoch was `String(Date.now())`, so a retry minted a fresh
 * epoch and defeated finance-side dedup. This test fails if the code ever
 * silently regresses back to a wall-clock epoch.
 */
describe('OrderServiceService dedup epoch (Faza 1a)', () => {
  function makeService(): OrderServiceService {
    // Pure helper under test — no dependency is touched, so every constructor
    // arg can be a stub. Mirrors the construction in the settlement spec.
    return new OrderServiceService(
      {} as any, // dataSource
      {} as any, // orderRepo
      {} as any, // orderItemRepo
      {} as any, // orderTrackingRepo
      {} as any, // orderCustodyEventRepo
      {} as any, // orderSettlementRepo
      {} as any, // transferBatchRepo
      {} as any, // transferBatchItemRepo
      {} as any, // transferBatchHistoryRepo
      {} as any, // searchClient
      {} as any, // identityClient
      {} as any, // logisticsClient
      {} as any, // catalogClient
      {} as any, // financeClient
      {} as any, // integrationClient
      {} as any, // branchClient
      {} as any, // fileClient
      {} as any, // outbox
      {} as any, // activityLog
    );
  }

  const resolve = (requestId?: string): string =>
    (makeService() as any).resolveDedupEpoch(requestId) as string;

  it('derives a stable token from request_id (same id → same epoch)', () => {
    const a = resolve('req-uuid-123');
    const b = resolve('req-uuid-123');
    expect(a).toBe(b);
    expect(a).toBe('req:req-uuid-123');
  });

  it('produces distinct epochs for distinct request_ids (re-sell after rollback)', () => {
    expect(resolve('first-attempt')).not.toBe(resolve('second-attempt'));
  });

  it('is NOT a wall-clock value when a request_id is present', () => {
    const epoch = resolve('abc');
    // A Date.now() epoch would be all digits; the request-derived token is not.
    expect(/^\d+$/.test(epoch)).toBe(false);
  });

  it('falls back to a wall-clock epoch only when request_id is absent', () => {
    for (const missing of [undefined, '', '   ']) {
      const epoch = resolve(missing);
      expect(/^\d+$/.test(epoch)).toBe(true);
    }
  });

  it('allows courier rollback actor resolution from order holder when post is missing', () => {
    const service = makeService() as any;

    expect(
      service.resolveActorCourierId(
        { id: '7', roles: [Roles.COURIER] },
        { courier_id: null, holder_courier_id: '7' },
        null,
      ),
    ).toBe('7');
  });
});
