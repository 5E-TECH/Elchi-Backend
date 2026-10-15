import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CancelReason } from '@app/common';
import { OrderAnalyticsService } from './order-analytics.service';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';

/**
 * PUvKXWVw — `GET /orders/cancel-reasons/stats` (`getCancelReasonStats`)
 * HAQIQIY Postgres'da: Toshkent kuni, bekor isboti (tracking), rollback,
 * bekor pochtasini qayta qabul qilish, CLOSED / RETURNED_TO_MARKET, filial
 * doirasi, yopiq sabablar ro'yxati.
 *
 * Faqat lokal test bazasi: CANCEL_REASON_STATS_PG_TEST_URI=
 *   postgres://postgres@127.0.0.1:<port>/elchi_oct6_sell_paid_test
 */
const uri = process.env.CANCEL_REASON_STATS_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_oct6_sell_paid_test'
  );
})();

/** Toshkent devor vaqti → UTC ISO (`+05:00`). */
const tash = (wall: string) => new Date(`${wall}+05:00`).toISOString();

(localTestDatabase ? describe : describe.skip)(
  'PUvKXWVw — bekor qilish sabablari statistikasi (haqiqiy Postgres)',
  () => {
    const schema = `spec_cancel_stats_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    let admin: DataSource;
    let db: DataSource;
    let analytics: OrderAnalyticsService;

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query('CREATE SCHEMA IF NOT EXISTS "branch_schema"');
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema,
        entities: [Order, OrderItem, OrderTracking, OrderCustodyEvent, Branch],
        synchronize: true,
      });
      await db.initialize();
      analytics = new OrderAnalyticsService(
        db.getRepository(Order),
        db.getRepository(OrderTracking),
        db.getRepository(OrderCustodyEvent),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );

      const order = (
        id: number,
        status: string,
        reason: string | null,
        extra: {
          market?: number;
          branch?: number;
          home?: number;
          deleted?: boolean;
        } = {},
      ) =>
        db.query(
          `INSERT INTO "${schema}".orders
             (id, market_id, customer_id, status, source, total_price,
              branch_id, home_branch_id, return_reason, is_deleted)
           VALUES ($1, $2, 801, $3, 'internal', 100000, $4, $5, $6, $7)`,
          [
            id,
            extra.market ?? 501,
            status,
            extra.branch ?? 15,
            extra.home ?? 1,
            reason,
            extra.deleted ?? false,
          ],
        );
      const track = (
        orderId: number,
        from: string | null,
        to: string,
        at: string,
      ) =>
        db.query(
          `INSERT INTO "${schema}".order_tracking
             (order_id, from_status, to_status, changed_by, changed_by_role, created_at)
           VALUES ($1, $2, $3, '26', 'courier', $4)`,
          [orderId, from, to, at],
        );

      // A — 15-kun 10:00, HQ'da yaratilgan (home 1), filial 15 kuryeri bekor qildi.
      await order(1, 'cancelled', CancelReason.CUSTOMER_REFUSED);
      await track(1, 'waiting', 'cancelled', tash('2026-10-15T10:00:00'));
      // B — 15-kun 23:30, keyin marketga topshirildi (F4: RETURNED_TO_MARKET).
      await order(2, 'returned_to_market', CancelReason.WRONG_ADDRESS);
      await track(2, 'waiting', 'cancelled', tash('2026-10-15T23:30:00'));
      await track(
        2,
        'cancelled',
        'returned_to_market',
        tash('2026-10-16T09:00:00'),
      );
      // C — 14-kun 23:30, eski topshirish (CLOSED).
      await order(3, 'closed', CancelReason.CUSTOMER_NO_ANSWER);
      await track(3, 'waiting', 'cancelled', tash('2026-10-14T23:30:00'));
      await track(3, 'cancelled', 'closed', tash('2026-10-15T12:00:00'));
      // D — 16-kun 00:30 (UTC'da hali 15-kun 19:30).
      await order(4, 'cancelled', CancelReason.PRICE_DISPUTE);
      await track(4, 'waiting', 'cancelled', tash('2026-10-16T00:30:00'));
      // E — qaytarish so'rovi bilan marketga qaytgan, HECH QACHON bekor emas.
      await order(5, 'returned_to_market', 'Mijoz qaytardi (erkin matn)');
      await track(
        5,
        'waiting',
        'returned_to_market',
        tash('2026-10-15T11:00:00'),
      );
      // F — bekor → rollback → sotildi.
      await order(6, 'sold', CancelReason.DEFECTIVE_PRODUCT);
      await track(6, 'waiting', 'cancelled', tash('2026-10-15T09:00:00'));
      await track(6, 'cancelled', 'waiting', tash('2026-10-15T09:10:00'));
      await track(6, 'waiting', 'sold', tash('2026-10-15T09:20:00'));
      // G — bekor → rollback → yana bekor (OTHER) — bir marta.
      await order(7, 'cancelled', CancelReason.OTHER);
      await track(7, 'waiting', 'cancelled', tash('2026-10-15T08:00:00'));
      await track(7, 'cancelled', 'waiting', tash('2026-10-15T08:05:00'));
      await track(7, 'waiting', 'cancelled', tash('2026-10-15T08:30:00'));
      // H / I — eski bekorlar: sababsiz va ro'yxatda yo'q erkin matn.
      await order(8, 'cancelled', null);
      await track(8, 'waiting', 'cancelled', tash('2026-10-15T13:00:00'));
      await order(9, 'cancelled (sent)', 'eski erkin matn');
      await track(9, 'waiting', 'cancelled', tash('2026-10-15T14:00:00'));
      await track(
        9,
        'cancelled',
        'cancelled (sent)',
        tash('2026-10-15T15:00:00'),
      );
      // J — 13-kun bekor; 15-kun bekor pochtasi qayta qabul qilindi.
      await order(10, 'cancelled', CancelReason.CUSTOMER_REFUSED);
      await track(10, 'waiting', 'cancelled', tash('2026-10-13T10:00:00'));
      await track(
        10,
        'cancelled',
        'cancelled (sent)',
        tash('2026-10-14T10:00:00'),
      );
      await track(
        10,
        'cancelled (sent)',
        'cancelled',
        tash('2026-10-15T16:00:00'),
      );
      // K — boshqa market, boshqa filial (yaratilgan ham, joriy ham 33).
      await order(11, 'cancelled', CancelReason.CUSTOMER_REFUSED, {
        market: 777,
        branch: 33,
        home: 33,
      });
      await track(11, 'waiting', 'cancelled', tash('2026-10-15T17:00:00'));
      // L — o'chirilgan.
      await order(12, 'cancelled', CancelReason.CUSTOMER_REFUSED, {
        deleted: true,
      });
      await track(12, 'waiting', 'cancelled', tash('2026-10-15T17:30:00'));
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.query('DROP SCHEMA IF EXISTS "branch_schema" CASCADE');
        await admin.destroy();
      }
    });

    const counts = (res: {
      by_reason: Array<{ reason: string; count: number }>;
    }) =>
      Object.fromEntries(
        res.by_reason
          .filter((row) => row.count > 0)
          .map((row) => [row.reason, row.count]),
      );

    it('⭐ Toshkent kuni (15-oktabr): A, B, G, H, I, K — D (16-kun 00:30), C (14-kun), J (qayta qabul), E (bekor emas), F (rollback), L (o`chirilgan) yo`q', async () => {
      const res = await analytics.getCancelReasonStats({
        startDate: '2026-10-15',
        endDate: '2026-10-15',
      });

      expect(counts(res)).toEqual({
        [CancelReason.CUSTOMER_REFUSED]: 2, // A, K
        [CancelReason.WRONG_ADDRESS]: 1, // B (RETURNED_TO_MARKET)
        [CancelReason.OTHER]: 1, // G (bir marta)
        UNKNOWN: 2, // H (null), I (ro'yxatda yo'q matn)
      });
      expect(res.total).toBe(6);
      expect(res.applied_range).toEqual({
        from: '2026-10-14T19:00:00.000Z',
        to: '2026-10-15T18:59:59.999Z',
        timezone: 'Asia/Tashkent',
      });
    });

    it('yopiq ro`yxat: har sabab (0 bo`lsa ham) yorlig`i bilan; UNKNOWN faqat bo`lsa', async () => {
      const res = await analytics.getCancelReasonStats({
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        market_id: '777',
      });
      expect(res.total).toBe(1);
      expect(res.by_reason.map((row) => row.reason).sort()).toEqual(
        Object.values(CancelReason).sort(),
      );
      expect(res.by_reason[0]).toEqual({
        reason: CancelReason.CUSTOMER_REFUSED,
        label: 'Mijoz rad etdi',
        count: 1,
      });
    });

    it('14-kun: C (CLOSED, eski topshirish) — hisobotdan yo`qolmaydi; J ning qayta qabuli sanalmaydi', async () => {
      const res = await analytics.getCancelReasonStats({
        startDate: '2026-10-14',
        endDate: '2026-10-14',
      });
      expect(counts(res)).toEqual({ [CancelReason.CUSTOMER_NO_ANSWER]: 1 });
    });

    it('16-kun: D (00:30 Toshkent) shu kunga tushadi', async () => {
      const res = await analytics.getCancelReasonStats({
        startDate: '2026-10-16',
        endDate: '2026-10-16',
      });
      expect(counts(res)).toEqual({ [CancelReason.PRICE_DISPUTE]: 1 });
    });

    it('⭐ davrsiz: barcha haqiqiy bekorlar (E, F, L yo`q; J bir marta)', async () => {
      const res = await analytics.getCancelReasonStats({});
      expect(counts(res)).toEqual({
        [CancelReason.CUSTOMER_REFUSED]: 3, // A, J, K
        [CancelReason.WRONG_ADDRESS]: 1,
        [CancelReason.CUSTOMER_NO_ANSWER]: 1,
        [CancelReason.PRICE_DISPUTE]: 1,
        [CancelReason.OTHER]: 1,
        UNKNOWN: 2,
      });
      expect(res.applied_range).toEqual({
        from: null,
        to: null,
        timezone: 'Asia/Tashkent',
      });
    });

    it('⭐ filial doirasi: HQ`da yaratilib filial 15 da bekor qilingan buyurtma filial 15 ga ko`rinadi; filial 33 faqat o`zinikini', async () => {
      const branch15 = await analytics.getCancelReasonStats({
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        branch_id: '15',
      });
      expect(branch15.total).toBe(5); // A, B, G, H, I (K — filial 33)
      const branch33 = await analytics.getCancelReasonStats({
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        branch_id: '33',
      });
      expect(counts(branch33)).toEqual({ [CancelReason.CUSTOMER_REFUSED]: 1 });
    });

    it('group_by=market — sabab × market, UNKNOWN yig`iladi', async () => {
      const res = await analytics.getCancelReasonStats({
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        group_by: 'market',
      });
      expect(res.rows).toEqual(
        expect.arrayContaining([
          { reason: CancelReason.CUSTOMER_REFUSED, key: '501', count: 1 },
          { reason: CancelReason.CUSTOMER_REFUSED, key: '777', count: 1 },
          { reason: 'UNKNOWN', key: '501', count: 2 },
        ]),
      );
      expect(res.rows).toHaveLength(5);
    });

    it.each([
      [{ startDate: 'kecha' }, "Sana noto'g'ri formatda: kecha"],
      [{ startDate: '2026-02-30' }, "Sana noto'g'ri formatda: 2026-02-30"],
      [
        { startDate: '2026-10-16', endDate: '2026-10-15' },
        "startDate endDate dan keyin bo'lmasligi kerak",
      ],
      [
        { group_by: 'tuman' },
        "group_by faqat 'market', 'region' yoki 'courier' bo'lishi mumkin",
      ],
    ])('%p — 400', async (input, message) => {
      await expect(
        analytics.getCancelReasonStats(input as never),
      ).rejects.toMatchObject({ error: { statusCode: 400, message } });
    });
  },
);
