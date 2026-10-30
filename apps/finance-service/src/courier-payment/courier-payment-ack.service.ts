import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import {
  ActivityLogService,
  Cashbox_type,
  Operation_type,
  PAYMENT_CORRECTION_ERROR_CODES,
  Source_type,
} from '@app/common';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import {
  COURIER_PAYMENT_ACKS,
  CourierPaymentAck,
  type CourierPaymentAckValue,
} from '../entities/courier-payment-ack.entity';
import { FinanceNotificationService } from '../notification/finance-notification.service';

export interface CourierPaymentAckInput {
  payment_id?: unknown;
  /** So'rovchi kuryer (gateway JWT `sub`) — boshqa kuryer kvitansiyasi 404. */
  courier_id?: unknown;
  ack?: unknown;
  comment?: unknown;
  /** Gateway aniqlagan filial boshlig'i (kuryer filiali `manager_id`). */
  notify_user_ids?: unknown;
}

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/**
 * (2crjWf7v #4) Kuryerning kvitansiyaga javobi — FAQAT AUDIT yozuvi.
 *
 * ⚠️ KASSAGA TA'SIR YO'Q: `cashboxes` / `cashbox_history` ga hech narsa
 * yozilmaydi (bitta pul harakatiga ikkinchi yozuvchi paydo bo'lmasin —
 * mavjud Idempotency-Key + dedup_epoch himoyasi o'z joyida). Faqat
 * `courier_payment_acks` (bir kvitansiyaga BITTA yozuv, UQ indeks).
 * "❗️ Noto'g'ri" — qabul qilgan xodim + filial boshlig'iga
 * `finance.payment_disputed` (outbox, ack yozuvi bilan BITTA tranzaksiyada).
 */
@Injectable()
export class CourierPaymentAckService {
  private readonly logger = new Logger(CourierPaymentAckService.name);

  constructor(
    @InjectRepository(CourierPaymentAck)
    private readonly acks: Repository<CourierPaymentAck>,
    private readonly dataSource: DataSource,
    private readonly activityLog: ActivityLogService,
    @Optional() private readonly notifications?: FinanceNotificationService,
  ) {}

  async ack(input: CourierPaymentAckInput) {
    try {
      const paymentId = text(input?.payment_id);
      const courierId = text(input?.courier_id);
      const ack = text(input?.ack) as CourierPaymentAckValue;
      if (!/^\d{1,20}$/.test(paymentId) || !/^\d{1,20}$/.test(courierId)) {
        throw new BadRequestException('payment_id / courier_id noto‘g‘ri');
      }
      if (!COURIER_PAYMENT_ACKS.includes(ack)) {
        throw new BadRequestException("ack: 'confirmed' yoki 'disputed'");
      }
      const comment = text(input?.comment).slice(0, 500) || null;
      const notify = Array.isArray(input?.notify_user_ids)
        ? input.notify_user_ids.map(text).filter((id) => /^\d{1,20}$/.test(id))
        : [];

      const result = await this.dataSource.transaction(async (manager) => {
        const history = await manager.getRepository(CashboxHistory).findOne({
          where: {
            id: paymentId,
            source_type: Source_type.COURIER_PAYMENT,
            operation_type: Operation_type.EXPENSE,
            isDeleted: false,
          },
          relations: ['cashbox'],
        });
        // Boshqa kuryerning kvitansiyasi ham "topilmadi" (mavjudligi oshkor emas).
        if (
          !history ||
          history.cashbox?.cashbox_type !== Cashbox_type.FOR_COURIER ||
          String(history.cashbox.user_id) !== courierId
        ) {
          throw new NotFoundException('Kvitansiya topilmadi');
        }
        // T6: qaytarilgan / tuzatilgan to'lov kvitansiyasi — javob qabul
        // qilinmaydi (kuryerga yangi holat bildirishnoma bilan borgan).
        const corrected = await manager.getRepository(CashboxHistory).findOne({
          where: { reverses_history_id: paymentId, isDeleted: false },
          select: ['id'],
        });
        if (corrected) {
          throw new RpcException({
            statusCode: 409,
            code: PAYMENT_CORRECTION_ERROR_CODES.PAYMENT_CORRECTED,
            message:
              "To'lov qaytarilgan yoki tuzatilgan — kvitansiyaga javob berib bo'lmaydi",
          });
        }
        const inserted: unknown = await manager.query(
          `INSERT INTO "finance_schema"."courier_payment_acks"
             ("payment_id", "courier_id", "ack", "comment")
           VALUES ($1, $2, $3, $4)
           ON CONFLICT ("payment_id", "courier_id") DO NOTHING
           RETURNING "id"`,
          [paymentId, courierId, ack, comment],
        );
        if (!Array.isArray(inserted) || !inserted.length) {
          const existing = await manager
            .getRepository(CourierPaymentAck)
            .findOne({
              where: { payment_id: paymentId, courier_id: courierId },
            });
          return { already: true, ack: existing?.ack ?? ack, history };
        }
        if (ack === 'disputed') {
          await this.notifications?.paymentDisputed(
            {
              payment_id: paymentId,
              courier_id: courierId,
              amount: history.amount,
              recipient_ids: [history.created_by, ...notify],
            },
            manager,
          );
        }
        return { already: false, ack, history };
      });

      if (!result.already) {
        await this.activityLog
          .log({
            entity_type: 'CashboxHistory',
            entity_id: paymentId,
            action: 'finance.courier_payment_ack',
            user_id: courierId,
            user_role: 'courier',
            new_value: { ack: result.ack },
            metadata: {
              payment_id: paymentId,
              ack: result.ack,
              amount: Number(result.history.amount),
              ...(comment ? { has_comment: true } : {}),
            },
          })
          .catch((error: unknown) =>
            this.logger.warn(
              `courier ack audit (#${paymentId}): ${error instanceof Error ? error.message : 'error'}`,
            ),
          );
      }
      return {
        statusCode: result.already ? 200 : 201,
        message: result.already
          ? 'Kvitansiyaga allaqachon javob berilgan'
          : 'Javob qabul qilindi',
        data: {
          payment_id: paymentId,
          ack: result.ack,
          already: result.already,
        },
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      if (error instanceof NotFoundException) {
        throw new RpcException({ statusCode: 404, message: error.message });
      }
      if (error instanceof BadRequestException) {
        throw new RpcException({ statusCode: 400, message: error.message });
      }
      throw new RpcException({
        statusCode: 500,
        message:
          error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }

  /** Hisobot ro'yxati flag'i: kuryer kassasidagi to'lov qatori → javob. */
  async flags(
    paymentIds: string[],
  ): Promise<Map<string, CourierPaymentAckValue>> {
    const ids = [...new Set(paymentIds.filter((id) => /^\d{1,20}$/.test(id)))];
    const map = new Map<string, CourierPaymentAckValue>();
    if (!ids.length) return map;
    const rows = await this.acks.find({
      where: { payment_id: In(ids) },
      select: ['payment_id', 'ack'],
    });
    for (const row of rows) map.set(String(row.payment_id), row.ack);
    return map;
  }
}
