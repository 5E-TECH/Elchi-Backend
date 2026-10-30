import { Order_status } from '@app/common';
import {
  ORDER_STATUS_TRANSITIONS,
  isValidPaymentReversalStatusTransition,
  isValidRollbackStatusTransition,
  isValidStatusTransition,
  mapInitialStatusForTracking,
} from './order-status.machine';

// Audit (Testing P1): the order lifecycle state machine had no test. It gates
// every status write in the service, so its rules are exercised directly here.
describe('order status machine', () => {
  describe('isValidStatusTransition', () => {
    it('allows a same-status (idempotent) transition for every status', () => {
      for (const s of Object.values(Order_status)) {
        expect(isValidStatusTransition(s, s)).toBe(true);
      }
    });

    it('permits the core happy-path sale flow', () => {
      expect(
        isValidStatusTransition(
          Order_status.RECEIVED,
          Order_status.ON_THE_ROAD,
        ),
      ).toBe(true);
      expect(
        isValidStatusTransition(Order_status.ON_THE_ROAD, Order_status.WAITING),
      ).toBe(true);
      expect(
        isValidStatusTransition(Order_status.WAITING, Order_status.SOLD),
      ).toBe(true);
      expect(
        isValidStatusTransition(Order_status.SOLD, Order_status.PAID),
      ).toBe(true);
      expect(
        isValidStatusTransition(Order_status.PAID, Order_status.CLOSED),
      ).toBe(true);
    });

    it('permits the settlement-rollback and re-open edges', () => {
      // Rollback a sale back to WAITING (money reversal path).
      expect(
        isValidStatusTransition(Order_status.SOLD, Order_status.WAITING),
      ).toBe(true);
      expect(
        isValidStatusTransition(Order_status.PARTLY_PAID, Order_status.WAITING),
      ).toBe(true);
      // Re-open a CLOSED order.
      expect(
        isValidStatusTransition(Order_status.CLOSED, Order_status.WAITING),
      ).toBe(true);
    });

    it('blocks illegal jumps', () => {
      // Cannot sell an order that never went out for delivery.
      expect(
        isValidStatusTransition(Order_status.CREATED, Order_status.SOLD),
      ).toBe(false);
      // RETURNED_TO_MARKET is terminal.
      expect(
        isValidStatusTransition(
          Order_status.RETURNED_TO_MARKET,
          Order_status.WAITING,
        ),
      ).toBe(false);
      // Cannot skip straight from RECEIVED to PAID.
      expect(
        isValidStatusTransition(Order_status.RECEIVED, Order_status.PAID),
      ).toBe(false);
    });

    it('RETURNED_TO_MARKET is a terminal state (no outgoing transitions)', () => {
      expect(ORDER_STATUS_TRANSITIONS[Order_status.RETURNED_TO_MARKET]).toEqual(
        [],
      );
    });
  });

  // y2RarzlT: rollback «Bekor qilish» — faqat rollback yo'lida.
  describe('isValidRollbackStatusTransition', () => {
    const soldLike = [
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
      Order_status.CLOSED,
    ];

    it('⭐ sold / paid / partly_paid / closed → cancelled rollbackda ruxsat', () => {
      for (const from of soldLike) {
        expect(
          isValidRollbackStatusTransition(from, Order_status.CANCELLED),
        ).toBe(true);
      }
    });

    it('umumiy mashina bu qirralarni ochmaydi (PATCH / finance yo`li)', () => {
      for (const from of soldLike) {
        expect(isValidStatusTransition(from, Order_status.CANCELLED)).toBe(
          false,
        );
      }
    });

    it('umumiy qirralar rollbackda ham amal qiladi, boshqalari yopiq', () => {
      expect(
        isValidRollbackStatusTransition(
          Order_status.SOLD,
          Order_status.WAITING,
        ),
      ).toBe(true);
      expect(
        isValidRollbackStatusTransition(
          Order_status.RETURNED_TO_MARKET,
          Order_status.CANCELLED,
        ),
      ).toBe(false);
      expect(
        isValidRollbackStatusTransition(
          Order_status.SOLD,
          Order_status.CANCELLED_SENT,
        ),
      ).toBe(false);
    });
  });

  // T6-BE-3: faqat `order.payment_reversal.apply` yo'li.
  describe('isValidPaymentReversalStatusTransition', () => {
    it('PAID → PARTLY_PAID / SOLD, PARTLY_PAID → SOLD; umumiy mashinada yo`q', () => {
      for (const [from, to] of [
        [Order_status.PAID, Order_status.PARTLY_PAID],
        [Order_status.PAID, Order_status.SOLD],
        [Order_status.PARTLY_PAID, Order_status.SOLD],
      ] as const) {
        expect(isValidPaymentReversalStatusTransition(from, to)).toBe(true);
        expect(isValidStatusTransition(from, to)).toBe(false);
      }
      expect(
        isValidPaymentReversalStatusTransition(
          Order_status.CLOSED,
          Order_status.SOLD,
        ),
      ).toBe(false);
      expect(
        isValidPaymentReversalStatusTransition(
          Order_status.PAID,
          Order_status.CANCELLED,
        ),
      ).toBe(false);
    });
  });

  describe('mapInitialStatusForTracking', () => {
    it('normalises NEW to CREATED and leaves other statuses unchanged', () => {
      expect(mapInitialStatusForTracking(Order_status.NEW)).toBe(
        Order_status.CREATED,
      );
      expect(mapInitialStatusForTracking(Order_status.RECEIVED)).toBe(
        Order_status.RECEIVED,
      );
    });
  });
});
