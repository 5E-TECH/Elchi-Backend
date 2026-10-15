import { randomUUID } from 'node:crypto';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { CreatePartnerTables1716000000018 } from '../../../migrations/1716000000018-CreatePartnerTables';
import { PartnerShipmentRefUniqueActiveOnly1716000000098 } from '../../../migrations/1716000000098-PartnerShipmentRefUniqueActiveOnly';
import { PartnerShipmentRef } from './entities/partner-shipment-ref.entity';
import { IntegrationServiceService } from './integration-service.service';

/**
 * yokjwjXG — migratsiya 098 + bog'lanishni yopish HAQIQIY Postgres'da
 * (INTEGRATION_PG_TEST_URI bo'lmasa skip; alohida vaqtinchalik BAZA).
 *
 *  • 018 dagi to'liq unique indeks yopilgan ref'ni ham "band" deb hisoblardi —
 *    hamkor qayta yaratsa INSERT yiqilardi (buyurtma yetim qolardi);
 *  • 098: faqat faol qatorlar unique; ikki FAOL dublikat hamon taqiqlangan;
 *  • detach → createPartnerShipment: yangi ref va YANGI order id.
 */
const pgUri = process.env.INTEGRATION_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg(
  'yokjwjXG — partner_shipment_refs partial unique (098) — haqiqiy Postgres',
  () => {
    const dbName = `spec_yok_psr_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    let admin: DataSource;
    let db: DataSource;
    const m018 = new CreatePartnerTables1716000000018();
    const m098 = new PartnerShipmentRefUniqueActiveOnly1716000000098();

    const run = async (fn: (runner: any) => Promise<void>) => {
      const runner = db.createQueryRunner();
      try {
        await fn(runner);
      } finally {
        await runner.release();
      }
    };
    const indexDef = async (): Promise<string | null> => {
      const rows: Array<{ indexdef: string }> = await db.query(
        `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'integration_schema'
          AND indexname = 'IDX_PSR_PARTNER_EXTERNAL'`,
      );
      return rows[0]?.indexdef ?? null;
    };
    const insertRef = (orderId: number, isDeleted = false) =>
      db.query(
        `INSERT INTO integration_schema.partner_shipment_refs
        (partner_id, external_order_id, order_id, is_deleted)
       VALUES (7, 'BP-555', $1, $2)`,
        [orderId, isDeleted],
      );

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: pgUri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      const url = new URL(pgUri!);
      url.pathname = `/${dbName}`;
      db = new DataSource({
        type: 'postgres',
        url: url.toString(),
        schema: 'integration_schema',
        entities: [PartnerShipmentRef],
        synchronize: false,
      });
      await db.initialize();
      await db.query('CREATE SCHEMA IF NOT EXISTS "integration_schema"');
      await run((runner) => m018.up(runner));
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        await admin.destroy();
      }
    });

    beforeEach(async () => {
      await db.query('TRUNCATE integration_schema.partner_shipment_refs');
    });

    it("018 holati (098 siz): yopilgan ref bo'lsa ham ayni juftlikni qayta yozib BO'LMAYDI — muammo", async () => {
      expect(await indexDef()).not.toContain('WHERE');
      await insertRef(900, true);
      await expect(insertRef(950)).rejects.toThrow(/duplicate key/);
    });

    describe('098 qo`llangandan keyin', () => {
      beforeAll(async () => {
        await run((runner) => m098.up(runner));
      });

      it('indeks partial: WHERE is_deleted = false', async () => {
        expect(await indexDef()).toMatch(
          /UNIQUE INDEX .*WHERE \(is_deleted = false\)/,
        );
      });

      it('yopilgan + faol ayni juftlik yonma-yon yashaydi; ikki FAOL — hamon taqiqlangan', async () => {
        await insertRef(900, true);
        await insertRef(950);
        await expect(insertRef(960)).rejects.toThrow(/duplicate key/);
      });

      it('⭐ detach → hamkor qayta yaratadi → YANGI ref, YANGI order id (eski o`chirilgan 900 qaytmaydi)', async () => {
        await insertRef(900);
        const svc: any = Object.create(IntegrationServiceService.prototype);
        svc.partnerShipmentRefRepo = db.getRepository(PartnerShipmentRef);
        svc.partnerWebhookOutboxRepo = {
          create: jest.fn((x: unknown) => x),
          save: jest.fn((x: any) => Promise.resolve({ id: '1', ...x })),
        };
        svc.processPendingPartnerWebhooks = jest.fn(() => Promise.resolve());
        svc.activityLog = { log: jest.fn(() => Promise.resolve()) };
        svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
        svc.partnerMarketRefRepo = {
          findOne: jest.fn().mockResolvedValue({ id: '1' }),
        };
        svc.identityClient = { send: jest.fn(() => of({ id: '77' })) };
        const orderSend = jest.fn(() =>
          of({ id: '950', status: 'new', qr_code_token: 'qr' }),
        );
        svc.orderClient = { send: orderSend };

        await svc.detachDeletedPartnerShipment({
          order_id: '900',
          old_status: 'received',
          reason: 'test',
        });
        const res: any = await svc.createPartnerShipment({
          partner_id: '7',
          external_order_id: 'BP-555',
          elchi_market_id: '500',
          customer: { name: 'Ali', phone: '+998901234567' },
          district_id: '10',
          region_id: '1',
          cod_amount: 0,
          subtotal: 30000,
        });

        expect(res.statusCode).toBe(201);
        expect(res.data.shipment_id).toBe('950');
        const refs: Array<{ order_id: string; is_deleted: boolean }> =
          await db.query(
            `SELECT order_id, is_deleted FROM integration_schema.partner_shipment_refs
            ORDER BY id`,
          );
        expect(refs).toEqual([
          { order_id: '900', is_deleted: true },
          { order_id: '950', is_deleted: false },
        ]);
        const createCall = (orderSend.mock.calls as unknown[][]).find(
          (c) => (c[0] as { cmd: string }).cmd === 'order.create',
        );
        expect((createCall?.[1] as { request_id: string }).request_id).toMatch(
          /^partner:7:BP-555:after-ref-\d+$/,
        );
      });

      it("down(): yopilgan dublikat bo'lsa partial indeks qoladi (yiqilmaydi); bo'lmasa to'liq indeks qaytadi; up() qayta ishlaydi", async () => {
        await insertRef(900, true);
        await insertRef(950);
        await run((runner) => m098.down(runner));
        expect(await indexDef()).toContain('WHERE');

        await db.query('TRUNCATE integration_schema.partner_shipment_refs');
        await run((runner) => m098.down(runner));
        expect(await indexDef()).not.toContain('WHERE');

        await run((runner) => m098.up(runner));
        expect(await indexDef()).toContain('WHERE');
      });
    });
  },
);
