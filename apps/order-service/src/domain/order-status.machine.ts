import { Order_status } from '@app/common';

/**
 * Order lifecycle state machine.
 *
 * Extracted from OrderServiceService (Audit: "order-service is a 10k-line god
 * object") so the transition rules are a single, pure, unit-testable source of
 * truth instead of being buried inside the service. Behaviour is identical to
 * the previous inline `isValidStatusTransition`.
 *
 * A `from` status maps to the set of statuses it may legally move to. A
 * same-status transition is always allowed (idempotent status writes).
 */
export const ORDER_STATUS_TRANSITIONS: Record<Order_status, Order_status[]> = {
  [Order_status.CREATED]: [
    Order_status.NEW,
    Order_status.RECEIVED,
    Order_status.CANCELLED,
  ],
  [Order_status.NEW]: [Order_status.RECEIVED, Order_status.CANCELLED],
  [Order_status.RECEIVED]: [
    Order_status.ON_THE_ROAD,
    Order_status.WAITING,
    Order_status.CANCELLED,
  ],
  [Order_status.ON_THE_ROAD]: [
    Order_status.WAITING,
    Order_status.WAITING_CUSTOMER,
    Order_status.CANCELLED,
  ],
  [Order_status.WAITING_CUSTOMER]: [
    Order_status.ON_THE_ROAD,
    Order_status.WAITING,
    Order_status.RETURNED_TO_MARKET,
    Order_status.CANCELLED,
  ],
  [Order_status.WAITING]: [
    Order_status.ON_THE_ROAD,
    Order_status.SOLD,
    Order_status.PARTLY_PAID,
    Order_status.PAID,
    Order_status.CANCELLED,
    Order_status.RETURNED_TO_MARKET,
    Order_status.CLOSED,
  ],
  [Order_status.SOLD]: [
    Order_status.PAID,
    Order_status.WAITING,
    Order_status.CLOSED,
  ],
  [Order_status.PARTLY_PAID]: [
    Order_status.PAID,
    Order_status.WAITING,
    Order_status.CLOSED,
  ],
  [Order_status.PAID]: [Order_status.WAITING, Order_status.CLOSED],
  [Order_status.CANCELLED]: [
    Order_status.WAITING,
    Order_status.CANCELLED_SENT,
    Order_status.CLOSED,
  ],
  [Order_status.RETURNED_TO_MARKET]: [],
  [Order_status.CANCELLED_SENT]: [Order_status.CANCELLED, Order_status.CLOSED],
  [Order_status.CLOSED]: [Order_status.WAITING],
};

/** True when `to` is a legal next status from `from` (same-status is allowed). */
export function isValidStatusTransition(
  from: Order_status,
  to: Order_status,
): boolean {
  if (from === to) return true;
  return ORDER_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * The status a brand-new order is recorded under on the tracking timeline: NEW
 * is normalised to CREATED so the timeline starts from a stable initial state.
 */
export function mapInitialStatusForTracking(
  status: Order_status,
): Order_status {
  return status === Order_status.NEW ? Order_status.CREATED : status;
}
