import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { Post_status, Roles } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';
import { Post } from './entities/post.entity';
import { Region } from './entities/region.entity';
import { District } from './entities/district.entity';

/**
 * YfrqN70i + kA70Rban — "Eski pochtalar" HAQIQIY Postgres'da:
 * - region_id / courier_id / startDate / endDate where'ga yetadi (avval
 *   jimgina tashlanardi va har doim 59 qaytardi);
 * - sana — Toshkent kuni (31-avgust 23:59 Toshkent = 18:59Z kiradi,
 *   1-sentabr 00:30 Toshkent = 31-avgust 19:30Z kirmaydi);
 * - 150 pochta: 2-sahifa (limit 100) → 101-150, `limit_capped` faqat
 *   100 dan oshganda; limit=10000 → limit 100 + limit_capped: true.
 *
 * Ishga tushirish: LOGISTICS_POST_LIST_PG_TEST_URI=postgres://...@127.0.0.1:PORT/elchi_g_test
 * (faqat lokal *_test baza — prod'ga tegmaydi).
 */
const uri = process.env.LOGISTICS_POST_LIST_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();

const HQ_BRANCH_ID = '1';
const superadmin = { id: '1', roles: [Roles.SUPERADMIN] };

(localTestDatabase ? describe : describe.skip)(
  'YfrqN70i/kA70Rban — eski pochtalar filtrlari va sahifalash (haqiqiy Postgres)',
  () => {
    let db: DataSource;
    let service: LogisticsServiceService;
    let schemaCreated = false;
    let bukhara: Region;
    let samarkand: Region;

    const rows = (res: { data: { data: Post[] } }) => res.data.data;

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'logistics_schema',
        entities: [Post, Region, District],
        synchronize: false,
      });
      await db.initialize();
      await db.query(`CREATE SCHEMA "logistics_schema"`);
      schemaCreated = true;
      await db.synchronize();

      const regionRepo = db.getRepository(Region);
      bukhara = await regionRepo.save(
        regionRepo.create({ name: 'Buxoro', sato_code: 'B1' } as never),
      );
      samarkand = await regionRepo.save(
        regionRepo.create({ name: 'Samarqand', sato_code: 'S1' } as never),
      );

      // 150 ta RECEIVED pochta (Samarqand, kuryer 200), har biri 1 daqiqa
      // farq bilan — tartib barqaror.
      await db.query(
        `INSERT INTO logistics_schema.posts
           (courier_id, post_total_price, order_quantity, region_id, branch_id, status, "createdAt")
         SELECT 200, 1000, 1, $1, 5, 'received',
           '2026-06-01T00:00:00Z'::timestamptz + (n || ' minutes')::interval
         FROM generate_series(1, 150) AS n`,
        [samarkand.id],
      );
      // Buxoro + kuryer 119 — avgust chegaralari (Toshkent UTC+5).
      const special: Array<[string, string, number, string]> = [
        // [courier, createdAt (UTC), order_quantity, status]
        ['119', '2026-07-31T18:59:00Z', 2, 'received'], // 31-iyul 23:59 Tsh — KIRMAYDI
        ['119', '2026-07-31T19:00:00Z', 2, 'received'], // 1-avgust 00:00 Tsh — kiradi
        ['119', '2026-08-31T18:59:00Z', 3, 'received'], // 31-avgust 23:59 Tsh — kiradi
        ['119', '2026-08-31T19:30:00Z', 1, 'received'], // 1-sentabr 00:30 Tsh — KIRMAYDI
        ['300', '2026-08-15T10:00:00Z', 0, 'received'], // bo'sh pochta, boshqa kuryer
      ];
      for (const [courier, createdAt, qty, status] of special) {
        await db.query(
          `INSERT INTO logistics_schema.posts
             (courier_id, post_total_price, order_quantity, region_id, branch_id, status, "createdAt")
           VALUES ($1, 500, $2, $3, 5, $4, $5)`,
          [courier, qty, bukhara.id, status, createdAt],
        );
      }
      // NEW pochta ro'yxatga hech qachon kirmaydi.
      await db.query(
        `INSERT INTO logistics_schema.posts
           (courier_id, post_total_price, order_quantity, region_id, branch_id, status, "createdAt")
         VALUES (119, 0, 4, $1, 5, 'new', '2026-08-10T10:00:00Z')`,
        [bukhara.id],
      );

      const branchClient = {
        send: jest.fn(() => of({ data: { id: HQ_BRANCH_ID } })),
      };
      service = new LogisticsServiceService(
        db.getRepository(Post),
        db.getRepository(Region),
        db.getRepository(District),
        { send: jest.fn(() => of({ data: [] })) } as never,
        branchClient as never,
        { send: jest.fn(() => of({})) } as never,
        { send: jest.fn(() => of({})) } as never,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
      );
    }, 30_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        if (schemaCreated) {
          await db.query(`DROP SCHEMA "logistics_schema" CASCADE`);
        }
        await db.destroy();
      }
    });

    it('region_id → faqat shu viloyat, total mos keladi', async () => {
      const res = await service.findAllPosts(
        1,
        100,
        { region_id: String(bukhara.id) },
        superadmin,
      );
      expect(res.data.total).toBe(5);
      expect(rows(res).every((p) => p.region_id === String(bukhara.id))).toBe(
        true,
      );
    });

    it("courier_id=119 → barcha qatorlarda courier_id === '119'", async () => {
      const res = await service.findAllPosts(
        1,
        100,
        { courier_id: '119' },
        superadmin,
      );
      expect(res.data.total).toBe(4);
      expect(rows(res).map((p) => String(p.courier_id))).toEqual(
        Array(4).fill('119'),
      );
    });

    it("startDate/endDate — Toshkent bo'yicha avgust, 31-avgust 23:59 kiradi", async () => {
      const res = await service.findAllPosts(
        1,
        100,
        {
          region_id: String(bukhara.id),
          courier_id: '119',
          startDate: '2026-08-01',
          endDate: '2026-08-31',
        },
        superadmin,
      );
      expect(rows(res).map((p) => new Date(p.createdAt).toISOString())).toEqual(
        ['2026-08-31T18:59:00.000Z', '2026-07-31T19:00:00.000Z'],
      );
      expect(res.data.total).toBe(2);
    });

    it("mavjud bo'lmagan region_id (raqam yoki UUID) → 0 qator", async () => {
      for (const regionId of [
        '999999999',
        '99999999-9999-9999-9999-999999999999',
      ]) {
        const res = await service.findAllPosts(
          1,
          5,
          { region_id: regionId },
          superadmin,
        );
        expect(res.data.total).toBe(0);
        expect(rows(res)).toEqual([]);
      }
    });

    it("has_orders=true — bo'sh pochta (order_quantity 0) chiqmaydi", async () => {
      const all = await service.findAllPosts(
        1,
        100,
        { region_id: String(bukhara.id) },
        superadmin,
      );
      const withOrders = await service.findAllPosts(
        1,
        100,
        { region_id: String(bukhara.id), has_orders: 'true' },
        superadmin,
      );
      expect(all.data.total).toBe(5);
      expect(withOrders.data.total).toBe(4);
      expect(rows(withOrders).every((p) => p.order_quantity > 0)).toBe(true);
    });

    it('150 pochta: 2-sahifa (limit 100) → 101-150, limit javobda 100', async () => {
      const page1 = await service.findAllPosts(
        1,
        100,
        { region_id: String(samarkand.id) },
        superadmin,
      );
      const page2 = await service.findAllPosts(
        2,
        100,
        { region_id: String(samarkand.id) },
        superadmin,
      );
      expect(page1.data).toMatchObject({
        total: 150,
        totalPages: 2,
        limit: 100,
        limit_capped: false,
      });
      expect(rows(page1)).toHaveLength(100);
      expect(rows(page2)).toHaveLength(50);
      const ids = new Set([...rows(page1), ...rows(page2)].map((p) => p.id));
      expect(ids.size).toBe(150);
    });

    it('limit=10000 → limit 100 va limit_capped: true (jimgina kesilmaydi)', async () => {
      const res = await service.findAllPosts(1, 10000, {}, superadmin);
      expect(res.data).toMatchObject({
        limit: 100,
        limit_capped: true,
        max_limit: 100,
        total: 155,
        totalPages: 2,
      });
      expect(rows(res)).toHaveLength(100);
      expect(rows(res).some((p) => p.status === Post_status.NEW)).toBe(false);
    });

    it('kuryer eski pochtalari: region/status/sana filtrlari va limit_capped', async () => {
      const courier = { id: '119', roles: [Roles.COURIER] };
      const august = await service.oldPostsForCourier(1, 500, courier, {
        startDate: '2026-08-01',
        endDate: '2026-08-31',
      });
      expect(august.data).toMatchObject({
        total: 2,
        limit: 100,
        limit_capped: true,
      });
      const otherRegion = await service.oldPostsForCourier(1, 8, courier, {
        region_id: String(samarkand.id),
      });
      expect(otherRegion.data.total).toBe(0);
      const sent = await service.oldPostsForCourier(1, 8, courier, {
        status: 'sent',
      });
      expect(sent.data.total).toBe(0);
      const received = await service.oldPostsForCourier(1, 8, courier, {
        status: 'received',
      });
      expect(received.data.total).toBe(4);
    });

    it('(tveJKICY) orders_total / amount_total — joriy filtr bo‘yicha, sahifadan qat’i nazar', async () => {
      // Buxoro: 5 pochta, order_quantity 2+2+3+1+0 = 8, har biri 500 so'm.
      const bukharaRes = await service.findAllPosts(
        1,
        2,
        { region_id: String(bukhara.id) },
        superadmin,
      );
      expect(rows(bukharaRes)).toHaveLength(2);
      expect(bukharaRes.data).toMatchObject({
        total: 5,
        orders_total: 8,
        amount_total: 2500,
      });
      // 2-sahifa — yig'indi o'zgarmaydi (150 × 1 ta, 150 × 1000 so'm).
      const page2 = await service.findAllPosts(
        2,
        100,
        { region_id: String(samarkand.id) },
        superadmin,
      );
      expect(page2.data).toMatchObject({
        orders_total: 150,
        amount_total: 150000,
      });
      // Filtrsiz (SUPERADMIN — OR tarmoqli where): NEW (4 ta) kirmaydi.
      const all = await service.findAllPosts(1, 10, {}, superadmin);
      expect(all.data).toMatchObject({
        total: 155,
        orders_total: 158,
        amount_total: 152500,
      });
      // Imkonsiz filtr — 0.
      const none = await service.findAllPosts(
        1,
        5,
        { region_id: '99999999-9999-9999-9999-999999999999' },
        superadmin,
      );
      expect(none.data).toMatchObject({ orders_total: 0, amount_total: 0 });
      // Kuryer eski pochtalari (avgust): 2 + 3 = 5 buyurtma, 1000 so'm.
      const courier = { id: '119', roles: [Roles.COURIER] };
      const august = await service.oldPostsForCourier(1, 1, courier, {
        startDate: '2026-08-01',
        endDate: '2026-08-31',
      });
      expect(august.data).toMatchObject({
        total: 2,
        orders_total: 5,
        amount_total: 1000,
      });
      const sent = await service.oldPostsForCourier(1, 8, courier, {
        status: 'sent',
      });
      expect(sent.data).toMatchObject({ orders_total: 0, amount_total: 0 });
    });
  },
);
