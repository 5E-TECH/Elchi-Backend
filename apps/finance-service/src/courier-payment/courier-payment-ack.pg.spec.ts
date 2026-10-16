import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { CourierPaymentAcks1716000000125 } from '../../../../migrations/1716000000125-CourierPaymentAcks';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { CourierPaymentAck } from '../entities/courier-payment-ack.entity';
import { CourierPaymentAckService } from './courier-payment-ack.service';
import { FinanceServiceService } from '../finance-service.service';

/**
 * 2crjWf7v #4 — kuryer kvitansiyasiga javob HAQIQIY Postgres'da (faqat lokal
 * test bazasi): migratsiya 125, kassa O'ZGARMAYDI, ikki marta bosish —
 * bitta yozuv, "❗️ Noto'g'ri" — xodim + filial boshlig'iga bildirishnoma.
 *
 *   BOT_PG_TEST_URI=postgres://postgres@127.0.0.1:55443/elchi_bot_test npx jest courier-payment-ack.pg
 */
const uri = process.env.BOT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return ['127.0.0.1', 'localhost'].includes(url.hostname);
})();
const DB = 'elchi_courier_ack_test';

(localTestDatabase ? describe : describe.skip)(
  'courier_payment_acks — lokal Postgres (2crjWf7v)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;
    let service: CourierPaymentAckService;
    let notifications: { paymentDisputed: jest.Mock };
    let activityLog: { log: jest.Mock };
    let paymentId: string;
    let otherPaymentId: string;

    const urlFor = () => {
      const url = new URL(uri!);
      url.pathname = `/${DB}`;
      return url.toString();
    };

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      const exists: unknown[] = await admin.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [DB],
      );
      if (!exists.length) await admin.query(`CREATE DATABASE ${DB}`);
      await admin.destroy();

      // Kassa jadvallari — entity'dan; ack jadvali — MIGRATSIYADAN (125).
      const schemaOnly = new DataSource({
        type: 'postgres',
        url: urlFor(),
        schema: 'finance_schema',
        entities: [Cashbox, CashboxHistory],
      });
      await schemaOnly.initialize();
      await schemaOnly.query('DROP SCHEMA IF EXISTS finance_schema CASCADE');
      await schemaOnly.query('CREATE SCHEMA finance_schema');
      await schemaOnly.synchronize();
      await schemaOnly.destroy();

      db = new DataSource({
        type: 'postgres',
        url: urlFor(),
        schema: 'finance_schema',
        entities: [Cashbox, CashboxHistory, CourierPaymentAck],
        extra: { max: 10 },
      });
      await db.initialize();
      const runner = db.createQueryRunner();
      try {
        await new CourierPaymentAcks1716000000125().up(runner);
        await new CourierPaymentAcks1716000000125().up(runner);
      } finally {
        await runner.release();
      }

      const cashboxes = db.getRepository(Cashbox);
      const histories = db.getRepository(CashboxHistory);
      const courierBox = await cashboxes.save(
        cashboxes.create({
          user_id: '44',
          cashbox_type: Cashbox_type.FOR_COURIER,
          balance: 500_000,
          balance_cash: 500_000,
          balance_card: 0,
        }),
      );
      const otherBox = await cashboxes.save(
        cashboxes.create({
          user_id: '45',
          cashbox_type: Cashbox_type.FOR_COURIER,
          balance: 0,
          balance_cash: 0,
          balance_card: 0,
        }),
      );
      const row = (cashbox_id: string) =>
        histories.create({
          operation_type: Operation_type.EXPENSE,
          cashbox_id,
          source_type: Source_type.COURIER_PAYMENT,
          amount: 400_000,
          balance_after: 500_000,
          balance_cash_after: 500_000,
          balance_card_after: 0,
          created_by: '7',
          payment_method: PaymentMethod.CASH,
          source_user_id: '44',
        });
      paymentId = String((await histories.save(row(courierBox.id))).id);
      otherPaymentId = String((await histories.save(row(otherBox.id))).id);

      notifications = {
        paymentDisputed: jest.fn().mockResolvedValue(undefined),
      };
      activityLog = { log: jest.fn().mockResolvedValue(undefined) };
      service = new CourierPaymentAckService(
        db.getRepository(CourierPaymentAck),
        db,
        activityLog as never,
        notifications as never,
      );
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS finance_schema CASCADE');
        await db.destroy();
      }
      jest.restoreAllMocks();
    });

    const snapshot = async () => ({
      cashboxes: await db.query(
        `SELECT id, balance, balance_cash, balance_card FROM finance_schema.cashboxes ORDER BY id`,
      ),
      history: Number(
        (
          await db.query(
            `SELECT count(*)::int AS n FROM finance_schema.cashbox_history`,
          )
        )[0].n,
      ),
    });

    it('⭐ 👍 Tasdiqlayman — courier_payment_acks ga yozuv, kassa qoldig‘i va tarix O‘ZGARMAYDI', async () => {
      const before = await snapshot();
      const res = await service.ack({
        payment_id: paymentId,
        courier_id: '44',
        ack: 'confirmed',
      });
      expect(res).toEqual({
        statusCode: 201,
        message: 'Javob qabul qilindi',
        data: { payment_id: paymentId, ack: 'confirmed', already: false },
      });
      expect(await snapshot()).toEqual(before);
      const acks: Array<{ ack: string; courier_id: string }> = await db.query(
        `SELECT ack, courier_id::text AS courier_id FROM finance_schema.courier_payment_acks WHERE payment_id = $1`,
        [paymentId],
      );
      expect(acks).toEqual([{ ack: 'confirmed', courier_id: '44' }]);
      expect(notifications.paymentDisputed).not.toHaveBeenCalled();
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'finance.courier_payment_ack' }),
      );
    });

    it('⭐ bir kvitansiyaga ikki (parallel) bosish — bitta yozuv qoladi', async () => {
      const results = await Promise.all(
        ['disputed', 'disputed', 'confirmed'].map((ack) =>
          service.ack({ payment_id: paymentId, courier_id: '44', ack }),
        ),
      );
      expect(results.every((r) => r.data.already)).toBe(true);
      const [{ n }]: Array<{ n: number }> = await db.query(
        `SELECT count(*)::int AS n FROM finance_schema.courier_payment_acks WHERE payment_id = $1`,
        [paymentId],
      );
      expect(n).toBe(1);
    });

    it('⭐ ❗️ Noto‘g‘ri — yozuv disputed, qabul qilgan xodim + filial boshlig‘iga bildirishnoma (o‘sha tranzaksiyada)', async () => {
      await db.query(`DELETE FROM finance_schema.courier_payment_acks`);
      const before = await snapshot();
      const res = await service.ack({
        payment_id: paymentId,
        courier_id: '44',
        ack: 'disputed',
        notify_user_ids: ['88', 'x'],
      });
      expect(res.data).toEqual({
        payment_id: paymentId,
        ack: 'disputed',
        already: false,
      });
      expect(notifications.paymentDisputed).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_id: paymentId,
          courier_id: '44',
          recipient_ids: ['7', '88'],
        }),
        expect.objectContaining({ queryRunner: expect.anything() }),
      );
      expect(await snapshot()).toEqual(before);
      expect((await service.flags([paymentId])).get(paymentId)).toBe(
        'disputed',
      );
    });

    it('⭐ hisobot ro‘yxatida flag: kuryer kassasidagi to‘lov qatori `courier_ack` oladi', async () => {
      const finance = Object.create(
        FinanceServiceService.prototype,
      ) as FinanceServiceService;
      Object.assign(finance, { courierAcks: service });
      jest
        .spyOn(
          finance as never as {
            loadUsersByIds: () => Promise<Map<string, unknown>>;
          },
          'loadUsersByIds',
        )
        .mockResolvedValue(new Map());
      const rows = await db
        .getRepository(CashboxHistory)
        .find({ relations: ['cashbox'], order: { id: 'ASC' } });
      const enriched = await (
        finance as never as {
          enrichHistoryWithUsers: (
            r: CashboxHistory[],
          ) => Promise<Array<{ id: string; courier_ack?: string | null }>>;
        }
      ).enrichHistoryWithUsers(rows);
      const flag = (id: string) =>
        enriched.find((row) => String(row.id) === id)?.courier_ack;
      expect(flag(paymentId)).toBe('disputed');
      expect(flag(otherPaymentId)).toBeNull();
    });

    it('boshqa kuryerning kvitansiyasi — 404 (mavjudligi oshkor emas), yozuv yo‘q', async () => {
      await expect(
        service.ack({
          payment_id: otherPaymentId,
          courier_id: '44',
          ack: 'confirmed',
        }),
      ).rejects.toMatchObject({ error: { statusCode: 404 } });
      await expect(
        service.ack({ payment_id: paymentId, courier_id: '44', ack: 'paid' }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
    });

    it('bildirishnoma yiqilsa — ack yozuvi ham qaytadi (bitta tranzaksiya)', async () => {
      await db.query(`DELETE FROM finance_schema.courier_payment_acks`);
      notifications.paymentDisputed.mockRejectedValueOnce(
        new Error('outbox down'),
      );
      await expect(
        service.ack({
          payment_id: paymentId,
          courier_id: '44',
          ack: 'disputed',
        }),
      ).rejects.toBeDefined();
      const [{ n }]: Array<{ n: number }> = await db.query(
        `SELECT count(*)::int AS n FROM finance_schema.courier_payment_acks`,
      );
      expect(n).toBe(0);
    });
  },
);
