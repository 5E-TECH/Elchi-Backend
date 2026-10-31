import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { Source_type } from '@app/common';
import { PickupVisit } from '../entities/pickup-visit.entity';

/** Tarix qatoriga qo'shiladigan tashrif maydonlari (`source_type=pickup_fee`). */
export interface PickupHistoryView {
  pickup_visit_id: string;
  parcel_count: number;
  is_free: boolean;
  courier_id: string;
  occurred_at: Date;
}

/**
 * B824gOu5 — pickup haqi va market to'lovi FIFO'si orasidagi ko'prik.
 *
 * ⚠️ NEGA KERAK. Haq market kassasidan chiqim bo'lib tushadi, buyurtmalarga esa
 * TEGMAYDI. Natijada kassa (`B`) ochiq buyurtmalar yig'indisidan (`U`) haq
 * summasiga kam turadi. To'lov `B` dan oshmaydi (M9 qo'riqchisi), FIFO esa
 * yalpi buyurtma summalari bilan ishlaydi: hovuz to'lovning o'ziga teng
 * bo'lsa, marketga hamma pul to'langandan keyin ham oxirgi buyurtmalar haq
 * summasiga ochiq qolardi («oxirgi buyurtmalar yopilmaydi» nuqsoni,
 * `marketOrderRemaining` izohi) va har haq `reconcile-strict` da soxta
 * nomuvofiqlik bo'lardi.
 *
 * Yechim: haq tashrif paytida FIFO'ga tegmaydi. Keyingi market to'lovi uni
 * (market kassasi qulfi ostida, bir marta) o'z hovuziga oladi: market naqd
 * `P` va haq hisobidan `F` — jami `P + F` qiymatni olgan, FIFO shu summani
 * yopadi. Invariant: `B = U − qoldiq − ochiq haqlar`. Pickup yozuvi yo'q
 * marketda hovuz o'zgarmaydi — to'lov avvalgidek.
 */
@Injectable()
export class PickupFifoService {
  private readonly logger = new Logger(PickupFifoService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Marketning hali FIFO'ga olinmagan haqlari yig'indisi; qatorlar shu
   * `transferId` ga belgilanadi. Chaqiruvchi market kassasini qulflagan
   * (`record` bilan ketma-ket), xato to'lovni qaytaradi — pul va belgi birga.
   */
  async claimInTx(
    manager: EntityManager,
    marketId: string,
    transferId: string,
  ): Promise<number> {
    const claimable = await manager.find(PickupVisit, {
      where: {
        market_id: String(marketId),
        is_free: false,
        fifo_applied_at: IsNull(),
        isDeleted: false,
      },
      select: { id: true, fee: true },
    });
    if (!claimable.length) {
      return 0;
    }
    await manager.update(
      PickupVisit,
      { id: In(claimable.map((row) => String(row.id))) },
      { fifo_applied_at: new Date(), fifo_transfer_id: transferId },
    );
    const tiyin = claimable.reduce(
      (sum, row) => sum + Math.round(Number(row.fee) * 100),
      0,
    );
    return tiyin / 100;
  }

  /**
   * `pickup_fee` tarix qatorlariga tashrif maydonlari (bitta batch so'rov).
   * Boshqa turdagi qatorlar o'zgarmaydi; bunday qator bo'lmasa so'rov ham yo'q.
   * FAIL-OPEN: o'qish xatosi ro'yxatni yiqitmaydi.
   */
  async attachToHistory<
    T extends { id: string; source_type?: unknown; source_id?: unknown },
  >(rows: T[]): Promise<Array<T & { pickup_visit?: unknown }>> {
    const isPickup = (row: T) =>
      row?.source_type === Source_type.PICKUP_FEE && row?.source_id != null;
    const ids = rows.filter(isPickup).map((row) => String(row.source_id));
    if (!ids.length) {
      return rows;
    }
    let visits: PickupVisit[] = [];
    try {
      visits = await this.dataSource.manager.find(PickupVisit, {
        where: { id: In(ids) },
      });
    } catch (error) {
      this.logger.warn(
        `tarixga pickup ma'lumoti qo'shilmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const byId = new Map(visits.map((visit) => [String(visit.id), visit]));
    return rows.map((row) => {
      if (!isPickup(row)) {
        return row;
      }
      const visit = byId.get(String(row.source_id));
      return {
        ...row,
        parcel_count: visit?.parcel_count ?? null,
        is_free: visit?.is_free ?? null,
        pickup_visit: visit
          ? ({
              pickup_visit_id: String(visit.id),
              parcel_count: visit.parcel_count,
              is_free: visit.is_free,
              courier_id: String(visit.courier_id),
              occurred_at: visit.occurred_at,
            } satisfies PickupHistoryView)
          : null,
      };
    });
  }
}
