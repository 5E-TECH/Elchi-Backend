import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Order_status, OutboxService } from '@app/common';
import { Order } from '../entities/order.entity';
import {
  NOTIFICATION_OUTBOX_TARGET,
  TELEGRAM_ORDER_STATUS_PATTERN,
  type TrackingTransition,
} from './order-notification.service';

const CREATION: readonly (Order_status | null)[] = [null, Order_status.CREATED];

/**
 * (h9newLsd #5 / ysBqD9Nx #4) Holat o'zgarishi → notification-service
 * Telegram KARTALARINI tahrirlaydi (yangi xabar emas). HAR o'tish — hatto
 * bildirishnoma turi bo'lmagan ichki holatlar ham (kuryer kartasidagi
 * tugmalar holatga bog'liq). Kuzatuv qatori bilan BITTA tranzaksiyada,
 * faqat outbox (fire-and-forget): rollback bo'lsa hodisa ham yo'q.
 *
 * Hodisa kichik (id + holatlar, PII yo'q). `market_id` faqat YARATILISHDA
 * o'qiladi (guruhga birinchi karta) — boshqa o'tishlarda qo'shimcha so'rov
 * yo'q ("Sotildi" sekinlashmaydi).
 */
@Injectable()
export class OrderTelegramCardPublisher {
  private readonly logger = new Logger(OrderTelegramCardPublisher.name);

  constructor(
    private readonly outbox: OutboxService,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
  ) {}

  async onStatusChange(
    transition: TrackingTransition,
    manager?: EntityManager,
  ): Promise<void> {
    if (transition.from_status === transition.to_status) return;
    const inTransaction = Boolean(manager?.queryRunner?.isTransactionActive);
    try {
      const creation =
        CREATION.includes(transition.from_status ?? null) &&
        (transition.to_status === Order_status.CREATED ||
          transition.to_status === Order_status.NEW);
      let marketId: string | null = null;
      if (creation) {
        const repo = manager ? manager.getRepository(Order) : this.orderRepo;
        const order = await repo.findOne({
          where: { id: String(transition.order_id) },
          select: ['id', 'market_id'],
        });
        marketId = order?.market_id ? String(order.market_id) : null;
      }
      await this.outbox.enqueue(
        NOTIFICATION_OUTBOX_TARGET,
        TELEGRAM_ORDER_STATUS_PATTERN,
        {
          order_id: String(transition.order_id),
          from_status: transition.from_status ?? null,
          to_status: transition.to_status,
          market_id: marketId,
        },
        manager ? { manager } : {},
      );
    } catch (err) {
      // Tranzaksiya ichidagi DB xatosi — chaqiruvchi rollback qilsin;
      // tranzaksiyasiz — karta sinxroni biznes amalini yiqitmaydi.
      if (inTransaction) throw err;
      this.logger.warn(
        `telegram karta hodisasi (order=${transition.order_id}) outbox'ga yozilmadi: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }
}
