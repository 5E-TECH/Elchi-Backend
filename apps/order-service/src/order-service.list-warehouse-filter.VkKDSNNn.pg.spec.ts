import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { OrderServiceService } from './order-service.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { Branch } from './entities/branch.entity';

/**
 * VkKDSNNn — GET /orders ombor filtrlari HAQIQIY Postgres'da (`findAll` +
 * `statusCounts`, bigint ustunlar va satr parametrlar):
 *   - `warehouse_kind=HQ` — faqat Markaziy ombor buyurtmalari
 *     (WAREHOUSE + home_branch_id = HQ, I2);
 *   - `warehouse_kind=REGIONAL` — viloyat ombori (home ≠ HQ yoki NULL);
 *     oddiy HQ oqimi (fulfillment_source=HQ) hech qaysi turga kirmaydi;
 *   - `warehouse_id` — aniq ombor; boshqa filtrlar bilan AND;
 *   - `fulfillment_source=HQ` + `warehouse_kind=HQ` — bo'sh (parametrlar
 *     bir-birini yozib yubormaydi);
 *   - HQ id aniqlanmasa — 503; filtrsiz — hamma qatorlar (bugungidek).
 *
 * Faqat lokal `/elchi_e_test`:
 *   ORDER_WAREHOUSE_PG_TEST_URI=postgres://postgres:root@127.0.0.1:5432/elchi_e_test
 */
const uri = process.env.ORDER_WAREHOUSE_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_e_test'
  );
})();

const SCHEMA = `owlf_order_${process.pid}`;
const HQ_BRANCH = '1';
const BRANCH_SAM = '11';
const HQ_WAREHOUSE = '50';
const SAM_WAREHOUSE = '60';

(localTestDatabase ? describe : describe.skip)(
  'VkKDSNNn — ombor filtrlari, haqiqiy Postgres (pg)',
  () => {
    let db: DataSource;
    let service: OrderServiceService;
    let hqBranchId: string | null = HQ_BRANCH;
    const ids: Record<string, string> = {};

    const insert = async (
      key: string,
      row: {
        fulfillment_source: 'HQ' | 'WAREHOUSE';
        warehouse_id: string | null;
        home_branch_id: string | null;
        status?: string;
      },
    ) => {
      const [created] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "${SCHEMA}".orders
           (market_id, customer_id, status, fulfillment_source, warehouse_id, home_branch_id)
         VALUES (121, 801, $1, $2, $3, $4)
         RETURNING id::text AS id`,
        [
          row.status ?? 'new',
          row.fulfillment_source,
          row.warehouse_id,
          row.home_branch_id,
        ],
      );
      ids[key] = created.id;
    };

    const listIds = async (query: Record<string, unknown>) => {
      const result = await service.findAll({ ...query, limit: 100 });
      return result.data.map((row) => String(row.id)).sort();
    };
    const idsOf = (...keys: string[]) => keys.map((key) => ids[key]).sort();

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: SCHEMA,
        entities: [Order, OrderItem, OrderTracking, OrderCustodyEvent, Branch],
      });
      await db.initialize();
      await db.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await db.query(`CREATE SCHEMA "${SCHEMA}"`);
      await db.query('CREATE SCHEMA IF NOT EXISTS "branch_schema"');
      await db.synchronize();

      service = Object.create(
        OrderServiceService.prototype,
      ) as OrderServiceService;
      Object.assign(service as object, {
        orderRepo: db.getRepository(Order),
        logger: new Logger('spec'),
        lookup: { getHqBranchId: jest.fn(() => Promise.resolve(hqBranchId)) },
      });

      // Oddiy HQ oqimi (ombor emas) — HQ va viloyat filialida.
      await insert('hqFlow', {
        fulfillment_source: 'HQ',
        warehouse_id: null,
        home_branch_id: HQ_BRANCH,
      });
      await insert('hqFlowSam', {
        fulfillment_source: 'HQ',
        warehouse_id: null,
        home_branch_id: BRANCH_SAM,
      });
      // Markaziy ombor (WAREHOUSE + home = HQ).
      await insert('central', {
        fulfillment_source: 'WAREHOUSE',
        warehouse_id: HQ_WAREHOUSE,
        home_branch_id: HQ_BRANCH,
      });
      await insert('centralSold', {
        fulfillment_source: 'WAREHOUSE',
        warehouse_id: HQ_WAREHOUSE,
        home_branch_id: HQ_BRANCH,
        status: 'sold',
      });
      // Viloyat ombori — home = viloyat filiali va eski (home NULL) qator.
      await insert('regional', {
        fulfillment_source: 'WAREHOUSE',
        warehouse_id: SAM_WAREHOUSE,
        home_branch_id: BRANCH_SAM,
      });
      await insert('regionalNoHome', {
        fulfillment_source: 'WAREHOUSE',
        warehouse_id: SAM_WAREHOUSE,
        home_branch_id: null,
      });
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        await db.destroy();
      }
    });

    beforeEach(() => {
      hqBranchId = HQ_BRANCH;
    });

    it('⭐ filtrsiz — hamma qatorlar (bugungidek)', async () => {
      expect(await listIds({})).toEqual(
        idsOf(
          'hqFlow',
          'hqFlowSam',
          'central',
          'centralSold',
          'regional',
          'regionalNoHome',
        ),
      );
    });

    it('⭐ warehouse_kind=HQ — faqat Markaziy ombor buyurtmalari', async () => {
      expect(await listIds({ warehouse_kind: 'HQ' })).toEqual(
        idsOf('central', 'centralSold'),
      );
    });

    it('⭐ warehouse_kind=REGIONAL — viloyat ombori (home NULL ham), oddiy HQ oqimi kirmaydi', async () => {
      expect(await listIds({ warehouse_kind: 'regional' })).toEqual(
        idsOf('regional', 'regionalNoHome'),
      );
    });

    it('warehouse_id — aniq ombor; tur va holat bilan AND', async () => {
      expect(await listIds({ warehouse_id: SAM_WAREHOUSE })).toEqual(
        idsOf('regional', 'regionalNoHome'),
      );
      expect(
        await listIds({ warehouse_id: SAM_WAREHOUSE, warehouse_kind: 'HQ' }),
      ).toEqual([]);
      expect(
        await listIds({ warehouse_id: HQ_WAREHOUSE, status: ['sold'] }),
      ).toEqual(idsOf('centralSold'));
      expect(await listIds({ warehouse_id: '999' })).toEqual([]);
    });

    it('fulfillment_source bilan: HQ + tur HQ — bo`sh; WAREHOUSE + tur HQ — Markaziy ombor', async () => {
      expect(
        await listIds({ fulfillment_source: 'HQ', warehouse_kind: 'HQ' }),
      ).toEqual([]);
      expect(
        await listIds({
          fulfillment_source: 'WAREHOUSE',
          warehouse_kind: 'HQ',
        }),
      ).toEqual(idsOf('central', 'centralSold'));
    });

    it('⭐ statusCounts — findAll `total`i bilan bir xil', async () => {
      const counts = await service.statusCounts({
        query: { warehouse_kind: 'HQ' },
      });
      expect(counts.by_status).toEqual({ new: 1, sold: 1 });
      expect(counts.total).toBe(2);
      const regional = await service.statusCounts({
        query: { warehouse_kind: 'REGIONAL', warehouse_id: SAM_WAREHOUSE },
      });
      expect(regional.total).toBe(
        (
          await service.findAll({
            warehouse_kind: 'REGIONAL',
            warehouse_id: SAM_WAREHOUSE,
          })
        ).total,
      );
      expect(regional.total).toBe(2);
    });

    it('⭐ HQ id aniqlanmasa — 503 (findAll va statusCounts)', async () => {
      hqBranchId = null;
      await expect(
        service.findAll({ warehouse_kind: 'HQ' }),
      ).rejects.toBeInstanceOf(RpcException);
      await expect(
        service.statusCounts({ query: { warehouse_kind: 'REGIONAL' } }),
      ).rejects.toMatchObject({ error: { statusCode: 503 } });
      // Tursiz filtr HQ id'ga bog'liq emas.
      expect(await listIds({ warehouse_id: HQ_WAREHOUSE })).toEqual(
        idsOf('central', 'centralSold'),
      );
    });
  },
);
