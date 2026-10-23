import { DataSource } from 'typeorm';
import { CreateNotifications1716000000008 } from '../../../../migrations/1716000000008-CreateNotifications';
import { Notification } from '../entities/notification.entity';
import {
  type DmDeliveryReport,
  TelegramDmDeliveryReportService,
} from './telegram-dm-delivery-report.service';

/**
 * (2crjWf7v) DM yetkazish hisobotining SQL'i HAQIQIY Postgres'da (faqat
 * lokal test bazasi): tur filtri, davr chegarasi, Toshkent kuni, DM
 * so'ralmagan qatorlar chiqarilishi, holat/sabab/rol guruhlari.
 *
 *   BOT_PG_TEST_URI=postgres://postgres@127.0.0.1:55443/elchi_bot_test \
 *     npx jest telegram-dm-delivery-report.2crjWf7v.pg --runInBand
 * (spec yonma-yon `elchi_dm_delivery_test` bazasini yaratadi.)
 */
const uri = process.env.BOT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return ['127.0.0.1', 'localhost'].includes(url.hostname);
})();
const DB = 'elchi_dm_delivery_test';

(localTestDatabase ? describe : describe.skip)(
  '2crjWf7v — DM yetkazish hisoboti, lokal Postgres',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;
    let service: TelegramDmDeliveryReportService;

    const insert = (
      type: string,
      role: string | null,
      createdAt: string,
      delivery: Record<string, string> | null,
    ) =>
      db.query(
        `INSERT INTO notification_schema.notifications
           (recipient_id, recipient_role, type, title, delivery, "createdAt")
         VALUES (26, $1, $2, 'Pul qabul qilindi', $3::jsonb, $4::timestamptz)`,
        [role, type, delivery ? JSON.stringify(delivery) : null, createdAt],
      );

    beforeAll(async () => {
      const admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      const exists: unknown[] = await admin.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [DB],
      );
      if (!exists.length) await admin.query(`CREATE DATABASE ${DB}`);
      await admin.destroy();
      const url = new URL(uri!);
      url.pathname = `/${DB}`;
      db = new DataSource({
        type: 'postgres',
        url: url.toString(),
        schema: 'notification_schema',
        entities: [Notification],
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
      const runner = db.createQueryRunner();
      try {
        await new CreateNotifications1716000000008().up(runner);
      } finally {
        await runner.release();
      }
      service = new TelegramDmDeliveryReportService(
        db.getRepository(Notification),
      );

      const R = 'finance.payment_received';
      // 2026-10-21 (Toshkent) — kuryer kvitansiyalari.
      await insert(R, 'courier', '2026-10-21T05:00:00Z', { telegram: 'sent' });
      await insert(R, 'courier', '2026-10-21T06:00:00Z', { telegram: 'sent' });
      await insert(R, 'courier', '2026-10-21T07:00:00Z', {
        telegram: 'failed',
        telegram_error: 'blocked_by_user: Forbidden',
      });
      await insert(R, 'courier', '2026-10-21T08:00:00Z', {
        telegram: 'skipped',
        telegram_reason: 'no_telegram_id',
      });
      // UTC 21-oktabr 19:30 = Toshkent 22-oktabr 00:30 → kun '2026-10-22'.
      await insert(R, 'market', '2026-10-21T19:30:00Z', {
        realtime: 'emitted',
        telegram: 'queued',
      });
      await insert(R, 'market', '2026-10-22T09:00:00Z', {
        telegram: 'skipped',
        telegram_reason: 'bot_blocked',
      });
      // Hisobga KIRMAYDI: DM so'ralmagan, boshqa tur, davrdan tashqarida.
      await insert(R, 'courier', '2026-10-22T10:00:00Z', {
        realtime: 'emitted',
      });
      await insert(R, 'courier', '2026-10-22T10:30:00Z', null);
      await insert('finance.cash_reminder', 'courier', '2026-10-22T11:00:00Z', {
        telegram: 'sent',
      });
      await insert(R, 'courier', '2026-10-19T12:00:00Z', { telegram: 'sent' });
      await insert(R, 'courier', '2026-10-23T12:00:00Z', { telegram: 'sent' });
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
        await db.destroy();
      }
    });

    it('⭐ kvitansiya: davr, tur va DM filtri bilan sanoq va nisbatlar', async () => {
      const res = await service.report({
        from: '2026-10-21',
        to: '2026-10-22',
      });
      const data = res.data as DmDeliveryReport;

      expect(data.type).toBe('finance.payment_received');
      expect(data.from).toBe('2026-10-20T19:00:00.000Z');
      expect(data.to).toBe('2026-10-22T19:00:00.000Z');
      expect(data.totals).toEqual({
        total: 6,
        sent: 2,
        failed: 1,
        pending: 1,
        skipped: 2,
        no_provider: 0,
        other: 0,
        delivery_ratio: 0.5, // 2 / (2 + 1 + 1)
        reach_ratio: 0.333, // 2 / 6
      });
      expect(data.skipped_reasons).toEqual({
        no_telegram_id: 1,
        bot_blocked: 1,
      });
      expect(data.by_role.map((r) => [r.role, r.total, r.sent])).toEqual([
        ['courier', 4, 2],
        ['market', 2, 0],
      ]);
      expect(data.days.map((d) => [d.day, d.total])).toEqual([
        ['2026-10-21', 4],
        ['2026-10-22', 2],
      ]);
    });

    it('boshqa tur (`finance.cash_reminder`) — alohida', async () => {
      const res = await service.report({
        from: '2026-10-21',
        to: '2026-10-22',
        type: 'finance.cash_reminder',
      });
      const data = res.data as DmDeliveryReport;
      expect(data.totals).toMatchObject({
        total: 1,
        sent: 1,
        delivery_ratio: 1,
        reach_ratio: 1,
      });
    });
  },
);
