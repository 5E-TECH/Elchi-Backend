import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderHolderType } from '../entities/order.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Order_status, Roles } from '@app/common';

/**
 * Order tracking + custody event writers, plus the pure tracking-label
 * renderers and actor helpers. Extracted so the query, lifecycle and
 * transfer-batch services share ONE implementation instead of duplicated copies
 * (which risked drift). The write helpers accept an optional repository so a
 * caller inside a transaction passes its own queryRunner-scoped repo; without
 * one they fall back to the injected repos.
 */
@Injectable()
export class OrderCustodyService {
  constructor(
    @InjectRepository(OrderTracking)
    private readonly orderTrackingRepo: Repository<OrderTracking>,
    @InjectRepository(OrderCustodyEvent)
    private readonly orderCustodyEventRepo: Repository<OrderCustodyEvent>,
  ) {}

  inferTrackingAction(
    fromStatus: Order_status | null,
    toStatus: Order_status,
    note?: string | null,
  ): string {
    const normalizedNote = String(note ?? '').toLowerCase();
    if (normalizedNote.includes('partly')) {
      return 'partly_sold';
    }
    if (normalizedNote.includes('rollback')) {
      return 'rollback';
    }

    if (!fromStatus) {
      return toStatus === Order_status.CREATED || toStatus === Order_status.NEW
        ? 'created'
        : 'status_change';
    }

    if (fromStatus === toStatus) {
      return 'note';
    }

    const byTarget: Partial<Record<Order_status, string>> = {
      [Order_status.CREATED]: 'created',
      [Order_status.NEW]: 'created',
      [Order_status.RECEIVED]: 'received',
      [Order_status.ON_THE_ROAD]: 'sent',
      [Order_status.WAITING]: 'waiting',
      [Order_status.WAITING_CUSTOMER]: 'waiting_customer',
      [Order_status.SOLD]: 'sold',
      [Order_status.PAID]: 'paid',
      [Order_status.PARTLY_PAID]: 'partly_paid',
      [Order_status.CANCELLED]: 'cancelled',
      [Order_status.CANCELLED_SENT]: 'cancelled_sent',
      [Order_status.RETURNED_TO_MARKET]: 'returned_to_market',
      [Order_status.CLOSED]: 'closed',
    };

    return byTarget[toStatus] ?? 'status_change';
  }


  describeTrackingAction(
    action: string,
    fromStatus: Order_status | null,
    toStatus: Order_status,
  ): string {
    const descriptions: Record<string, string> = {
      created: 'Buyurtma yaratildi',
      received: 'Buyurtma qabul qilindi',
      sent: "Buyurtma yo'lga chiqdi",
      waiting: 'Buyurtma kutilmoqda holatiga qaytarildi',
      waiting_customer: "Mijoz kutilmoqda holatiga o'tkazildi",
      sold: 'Buyurtma sotildi',
      paid: "Buyurtma to'landi",
      partly_sold: 'Buyurtma qisman sotildi',
      partly_paid: 'Buyurtma qisman sotildi',
      cancelled: 'Buyurtma bekor qilindi',
      cancelled_sent: "Bekor qilingan buyurtma jo'natildi",
      returned_to_market: 'Buyurtma marketga qaytarildi',
      closed: 'Buyurtma yopildi',
      rollback: 'Buyurtma oldingi holatga qaytarildi',
      note: 'Buyurtma trackingiga izoh yozildi',
    };

    return (
      descriptions[action] ??
      `${fromStatus ?? 'empty'} holatidan ${toStatus} holatiga o'zgartirildi`
    );
  }


  describeTrackingNote(note?: string | null): string | null {
    const normalized = String(note ?? '')
      .trim()
      .toLowerCase();
    if (!normalized) return null;

    const descriptions: Record<string, string> = {
      'order created': 'Buyurtma yaratildi',
      'order sold': 'Buyurtma sotildi',
      'order partly sold': 'Buyurtma qisman sotildi',
      'order canceled': 'Buyurtma bekor qilindi',
      'rollback to waiting': 'Buyurtma kutilmoqda holatiga qaytarildi',
      'rollback to cancelled': 'Buyurtma bekor qilingan holatiga qaytarildi',
      'rollback to cancelled_sent': "Buyurtma bekor qilinib pochtaga qo'shildi",
      'order assigned to post': 'Buyurtma pochtaga biriktirildi',
      'branch canceled post sent to hq':
        "Branch bekor qilingan pochtani HQga jo'natdi",
      'canceled order received by hq and held for market handover':
        'HQ bekor qilingan pochtani qabul qildi',
      'canceled order received by branch manager':
        'Branch manager bekor qilingan pochtani qabul qildi',
      'canceled post created':
        "Courier bekor qilingan pochtani branchga jo'natdi",
      'partly-sell unsold items canceled':
        'Qisman sotishdan qolgan mahsulotlar bekor qilindi',
      'partly-sell canceled items custody assigned':
        'Qisman sotishdan bekor qilingan buyurtma egasi belgilandi',
    };

    return descriptions[normalized] ?? note ?? null;
  }


  // ===== lifecycle mutation surface (moved verbatim) =====
  /**
   * Normalise the RMQ `requester` payload into the actor fields the
   * activity-log expects. `user_name` is not carried in `requester`, so it is
   * left null (the audit table denormalises it but tolerates absence); the
   * user_id + role pair is enough to attribute every action.
   */
  auditActor(requester?: { id?: string; roles?: string[] } | null): {
    user_id: string | null;
    user_role: string | null;
  } {
    const roles = requester?.roles ?? [];
    return {
      user_id: requester?.id ? String(requester.id) : null,
      user_role: roles.length ? roles.join(',') : null,
    };
  }

  /**
   * Resolve the branch_id to attach to a new order.
   * Priority: explicit dto.branch_id → requester's assigned branch → HQ fallback.
   * Throws RpcException 500 if all paths fail — refuse to persist an order
   * with NULL branch_id (the audit identified this as a long-term data risk).
   */

  toTrackingRole(roles?: string[]): string {
    const normalized = (roles ?? [])
      .map((role) =>
        String(role ?? '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);

    const priority = [
      Roles.SUPERADMIN,
      Roles.ADMIN,
      Roles.MANAGER,
      Roles.REGISTRATOR,
      Roles.OPERATOR,
      Roles.COURIER,
      Roles.MARKET,
      Roles.MARKET_OPERATOR,
      Roles.BRANCH,
      Roles.INVESTOR,
      Roles.CUSTOMER,
    ].map((role) => String(role).toLowerCase());

    return (
      priority.find((role) => normalized.includes(role)) ??
      normalized[0] ??
      'system'
    );
  }


  async createTrackingEvent(
    data: {
      order_id: string;
      from_status: Order_status | null;
      to_status: Order_status;
      changed_by: string;
      changed_by_role: string;
      action?: string | null;
      old_value?: Record<string, unknown> | null;
      new_value?: Record<string, unknown> | null;
      description?: string | null;
      metadata?: Record<string, unknown> | null;
      note?: string | null;
    },
    repository?: Repository<OrderTracking>,
  ) {
    const repo = repository ?? this.orderTrackingRepo;
    const action =
      data.action ??
      this.inferTrackingAction(data.from_status, data.to_status, data.note);
    const entity = repo.create({
      order_id: data.order_id,
      from_status: data.from_status,
      to_status: data.to_status,
      action,
      old_value:
        data.old_value ??
        (data.from_status ? { status: data.from_status } : null),
      new_value: data.new_value ?? { status: data.to_status },
      description:
        data.description ??
        this.describeTrackingNote(data.note) ??
        this.describeTrackingAction(action, data.from_status, data.to_status),
      changed_by: data.changed_by,
      changed_by_role: data.changed_by_role,
      metadata: data.metadata ?? null,
      note: data.note ?? null,
    });
    await repo.save(entity);
  }


  async createCustodyEvent(
    data: {
      order_id: string;
      from_holder_type: OrderHolderType | null;
      to_holder_type: OrderHolderType;
      from_branch_id: string | null;
      to_branch_id: string | null;
      from_courier_id: string | null;
      to_courier_id: string | null;
      changed_by: string;
      changed_by_role: string;
      note?: string | null;
    },
    repository?: Repository<OrderCustodyEvent>,
  ) {
    const repo = repository ?? this.orderCustodyEventRepo;
    const entity = repo.create({
      order_id: data.order_id,
      from_holder_type: data.from_holder_type,
      to_holder_type: data.to_holder_type,
      from_branch_id: data.from_branch_id,
      to_branch_id: data.to_branch_id,
      from_courier_id: data.from_courier_id,
      to_courier_id: data.to_courier_id,
      changed_by: data.changed_by,
      changed_by_role: data.changed_by_role,
      note: data.note ?? null,
    });
    await repo.save(entity);
  }

}
