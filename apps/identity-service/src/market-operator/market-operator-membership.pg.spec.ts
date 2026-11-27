import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { MarketOperatorMemberships1716000000255 } from '../../../../migrations/1716000000255-MarketOperatorMemberships';
import { MarketOperatorMembership } from '../entities/market-operator-membership.entity';
import { MarketOperatorMembershipService } from './market-operator-membership.service';

/**
 * Bitta operator — bir nechta market, 1-bosqich: migratsiya 255
 * (`identity_schema.market_operator_markets`, seed, `admins` triggeri) va
 * `MarketOperatorMembershipService` HAQIQIY Postgres'da.
 *
 * Asosiy talab: o'tish davrida jadval `admins` ning aniq ko'zgusi — operator
 * qatorini o'zgartiradigan har yo'l (yaratish, komissiya, ombor, holat,
 * o'chirish, market almashishi, rol almashishi) a'zolikka tushadi va
 * trigger `admins` yozuvini HECH QACHON yiqitmaydi.
 *
 * O'z vaqtinchalik bazasi (oxirida o'chiriladi); faqat lokal xost:
 *   IDENTITY_MEMBERSHIP_PG_TEST_URI=postgres://postgres@127.0.0.1:55499/postgres
 */
const pgUri = process.env.IDENTITY_MEMBERSHIP_PG_TEST_URI;
const localHost = (() => {
  if (!pgUri) return false;
  return ['127.0.0.1', 'localhost'].includes(new URL(pgUri).hostname);
})();
const describePg = localHost ? describe : describe.skip;

type Row = Record<string, unknown>;

const MARKET_A = '10';
const MARKET_B = '20';
const MARKET_C = '30';
const COURIER = '40';

describePg(
  'market_operator_markets — migratsiya 255, trigger, RPC (pg)',
  () => {
    const dbName = `spec_mom_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    let admin: DataSource;
    let db: DataSource;
    let service: MarketOperatorMembershipService;
    const migration = new MarketOperatorMemberships1716000000255();

    const dbUrl = () => {
      const url = new URL(pgUri!);
      url.pathname = `/${dbName}`;
      return url.toString();
    };

    const runMigration = async (direction: 'up' | 'down' = 'up') => {
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await migration[direction](runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    };

    /** Ochiq va yopiq a'zoliklar — taqqoslash uchun barqaror tartibda. */
    const memberships = () =>
      db.query<Row[]>(
        `SELECT operator_id::text, market_id::text, status, is_primary,
              commission_type, commission_value::text AS commission_value,
              can_view_warehouse_stock, removed_at IS NOT NULL AS removed
         FROM identity_schema.market_operator_markets
        ORDER BY operator_id, market_id, id`,
      );

    const insertAdmin = (row: {
      id: string;
      role: string;
      market_id?: string | null;
      status?: string;
      is_deleted?: boolean;
      commission_type?: string | null;
      commission_value?: number | null;
      can_view_warehouse_stock?: boolean;
      name?: string;
      created_at?: string;
    }) =>
      db.query(
        `INSERT INTO identity_schema.admins
         (id, role, name, status, market_id, is_deleted, commission_type,
          commission_value, can_view_warehouse_stock, "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6,
               $7::identity_schema.admins_commission_type_enum, $8, $9,
               COALESCE($10::timestamptz, now()))`,
        [
          row.id,
          row.role,
          row.name ?? `TEST ${row.id}`,
          row.status ?? 'active',
          row.market_id ?? null,
          row.is_deleted ?? false,
          row.commission_type ?? null,
          row.commission_value ?? null,
          row.can_view_warehouse_stock ?? false,
          row.created_at ?? null,
        ],
      );

    const updateAdmin = (id: string, set: string, params: unknown[] = []) =>
      db.query(
        `UPDATE identity_schema.admins SET ${set} WHERE id = $${params.length + 1}`,
        [...params, id],
      );

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: pgUri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      db = new DataSource({
        type: 'postgres',
        url: dbUrl(),
        entities: [MarketOperatorMembership],
      });
      await db.initialize();
      service = new MarketOperatorMembershipService(
        db.getRepository(MarketOperatorMembership),
      );
    });

    afterAll(async () => {
      await db?.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.destroy();
      }
    });

    beforeEach(async () => {
      await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
      await db.query('CREATE SCHEMA identity_schema');
      // Prod'dagi kabi: komissiya turi — enum (trigger `::text` bilan o'qiydi).
      await db.query(
        `CREATE TYPE identity_schema.admins_commission_type_enum
         AS ENUM ('percent', 'fixed')`,
      );
      await db.query(
        `CREATE TABLE identity_schema.admins (
         id bigserial PRIMARY KEY,
         role varchar NOT NULL,
         name varchar(100),
         status varchar NOT NULL DEFAULT 'active',
         market_id bigint NULL,
         add_order boolean NOT NULL DEFAULT false,
         is_deleted boolean NOT NULL DEFAULT false,
         commission_type identity_schema.admins_commission_type_enum NULL,
         commission_value numeric(14,2) NULL,
         can_view_warehouse_stock boolean NOT NULL DEFAULT false,
         "createdAt" timestamptz NOT NULL DEFAULT now(),
         "updatedAt" timestamptz NOT NULL DEFAULT now())`,
      );
      await insertAdmin({ id: MARKET_A, role: 'market', name: 'Beta do`kon' });
      await insertAdmin({ id: MARKET_B, role: 'market', name: 'alfa market' });
      await insertAdmin({ id: MARKET_C, role: 'market', name: 'Gamma' });
      await insertAdmin({ id: COURIER, role: 'courier' });
    });

    it('seed: o`chirilmagan, mavjud marketga bog`langan har operator — bitta asosiy a`zolik (holat, komissiya, ombor kaliti nusxa); qayta yurgizish dublikat qilmaydi', async () => {
      await insertAdmin({
        id: '101',
        role: 'market_operator',
        market_id: MARKET_A,
        commission_type: 'percent',
        commission_value: 5.5,
        can_view_warehouse_stock: true,
        created_at: '2026-10-01T08:00:00Z',
      });
      await insertAdmin({
        id: '102',
        role: 'market_operator',
        market_id: MARKET_B,
        status: 'inactive',
      });
      // Yozilmaydi: o'chirilgan, marketsiz, begona market id, market emas.
      await insertAdmin({
        id: '103',
        role: 'market_operator',
        market_id: MARKET_A,
        is_deleted: true,
      });
      await insertAdmin({ id: '104', role: 'market_operator' });
      await insertAdmin({
        id: '105',
        role: 'market_operator',
        market_id: '999',
      });
      await insertAdmin({
        id: '106',
        role: 'market_operator',
        market_id: COURIER,
      });
      // Boshqa rol market_id bilan ham — yozilmaydi.
      await insertAdmin({
        id: '107',
        role: 'registrator',
        market_id: MARKET_A,
      });

      await runMigration();

      const expected = [
        {
          operator_id: '101',
          market_id: MARKET_A,
          status: 'active',
          is_primary: true,
          commission_type: 'percent',
          commission_value: '5.50',
          can_view_warehouse_stock: true,
          removed: false,
        },
        {
          operator_id: '102',
          market_id: MARKET_B,
          status: 'inactive',
          is_primary: true,
          commission_type: null,
          commission_value: null,
          can_view_warehouse_stock: false,
          removed: false,
        },
      ];
      expect(await memberships()).toEqual(expected);
      const [seeded] = await db.query<Row[]>(
        `SELECT accepted_at FROM identity_schema.market_operator_markets
        WHERE operator_id = 101`,
      );
      expect(seeded.accepted_at).toEqual(new Date('2026-10-01T08:00:00Z'));

      await runMigration();
      expect(await memberships()).toEqual(expected);
    });

    it('trigger: yangi operator, komissiya, ombor kaliti va holat a`zolikka tushadi; operatorga aloqasiz ustun (ism) yoki boshqa rol a`zolik yozmaydi', async () => {
      await runMigration();

      await insertAdmin({
        id: '201',
        role: 'market_operator',
        market_id: MARKET_A,
      });
      await updateAdmin(
        '201',
        `commission_type = 'fixed', commission_value = 3000`,
      );
      await updateAdmin('201', 'can_view_warehouse_stock = true');
      await updateAdmin('201', `status = 'inactive'`);
      await updateAdmin('201', `name = 'Yangi ism'`);
      await insertAdmin({ id: '202', role: 'courier', market_id: MARKET_A });

      expect(await memberships()).toEqual([
        {
          operator_id: '201',
          market_id: MARKET_A,
          status: 'inactive',
          is_primary: true,
          commission_type: 'fixed',
          commission_value: '3000.00',
          can_view_warehouse_stock: true,
          removed: false,
        },
      ]);

      await updateAdmin(
        '201',
        `status = 'active', commission_type = NULL, commission_value = NULL`,
      );
      expect(await memberships()).toEqual([
        expect.objectContaining({
          status: 'active',
          commission_type: null,
          commission_value: null,
        }),
      ]);
    });

    it('trigger: market almashsa eski a`zolik `removed` (tarix), yangisi asosiy; qaytsa — yangi ochiq qator, eski tarix qoladi', async () => {
      await insertAdmin({
        id: '301',
        role: 'market_operator',
        market_id: MARKET_A,
      });
      await runMigration();

      await updateAdmin('301', 'market_id = $1', [MARKET_B]);
      expect(await memberships()).toEqual([
        expect.objectContaining({
          market_id: MARKET_A,
          status: 'removed',
          is_primary: false,
          removed: true,
        }),
        expect.objectContaining({
          market_id: MARKET_B,
          status: 'active',
          is_primary: true,
          removed: false,
        }),
      ]);

      await updateAdmin('301', 'market_id = $1', [MARKET_A]);
      const rows = await memberships();
      expect(rows).toHaveLength(3);
      expect(rows.filter((row) => row.status !== 'removed')).toEqual([
        expect.objectContaining({
          market_id: MARKET_A,
          status: 'active',
          is_primary: true,
        }),
      ]);
      const [{ primaries }] = await db.query<Row[]>(
        `SELECT count(*)::int AS primaries
         FROM identity_schema.market_operator_markets
        WHERE operator_id = 301 AND is_primary`,
      );
      expect(primaries).toBe(1);
    });

    it('trigger: o`chirish, marketdan uzish (NULL) va rol almashishi a`zolikni yopadi; operator roliga qaytsa — yangi a`zolik', async () => {
      await insertAdmin({
        id: '401',
        role: 'market_operator',
        market_id: MARKET_A,
      });
      await insertAdmin({
        id: '402',
        role: 'market_operator',
        market_id: MARKET_A,
      });
      await insertAdmin({
        id: '403',
        role: 'market_operator',
        market_id: MARKET_B,
      });
      await runMigration();

      await updateAdmin('401', 'is_deleted = true');
      await updateAdmin('402', 'market_id = NULL');
      await updateAdmin('403', `role = 'registrator'`);
      const open = (await memberships()).filter(
        (row) => row.status !== 'removed',
      );
      expect(open).toEqual([]);

      await updateAdmin('403', `role = 'market_operator'`);
      expect(
        (await memberships()).filter((row) => row.status !== 'removed'),
      ).toEqual([
        expect.objectContaining({
          operator_id: '403',
          market_id: MARKET_B,
          status: 'active',
        }),
      ]);
    });

    it('trigger `admins` yozuvini yiqitmaydi: begona market id yoki market bo`lmagan id — a`zolik yozilmaydi, operator qatori saqlanadi', async () => {
      await runMigration();

      await insertAdmin({
        id: '501',
        role: 'market_operator',
        market_id: '999',
      });
      await insertAdmin({
        id: '502',
        role: 'market_operator',
        market_id: COURIER,
      });
      await insertAdmin({
        id: '503',
        role: 'market_operator',
        market_id: MARKET_A,
      });
      await updateAdmin('503', 'market_id = $1', ['999']);

      const [{ count }] = await db.query<Row[]>(
        `SELECT count(*)::int AS count FROM identity_schema.admins
        WHERE id IN (501, 502, 503)`,
      );
      expect(count).toBe(3);
      expect(await memberships()).toEqual([
        expect.objectContaining({
          operator_id: '503',
          market_id: MARKET_A,
          status: 'removed',
        }),
      ]);
    });

    it('RPC o`qishi: asosiy birinchi, keyin market nomi; market ma`lumoti; `include_removed`; noto`g`ri id — bo`sh', async () => {
      await insertAdmin({
        id: '601',
        role: 'market_operator',
        market_id: MARKET_C,
        commission_type: 'percent',
        commission_value: 7,
      });
      await runMigration();
      // Keyingi bosqichlar (taklif / admin bog'lashi) yozadigan qo'shimcha
      // a'zoliklar — trigger ularga tegmaydi.
      await db.query(
        `INSERT INTO identity_schema.market_operator_markets
         (operator_id, market_id, status, is_primary)
       VALUES (601, ${MARKET_A}, 'active', false),
              (601, ${MARKET_B}, 'pending', false)`,
      );
      await updateAdmin(MARKET_B, 'add_order = true');
      await updateAdmin('601', `commission_value = 8`);

      const items = await service.listForOperator('601');
      expect(items.map((item) => [item.market_id, item.status])).toEqual([
        [MARKET_C, 'active'],
        [MARKET_B, 'pending'],
        [MARKET_A, 'active'],
      ]);
      expect(items[0]).toEqual({
        market_id: MARKET_C,
        status: 'active',
        is_primary: true,
        commission_type: 'percent',
        commission_value: 8,
        can_view_warehouse_stock: false,
        accepted_at: expect.any(String),
        market: {
          id: MARKET_C,
          name: 'Gamma',
          status: 'active',
          add_order: false,
          is_deleted: false,
        },
      });
      expect(items[1].market).toEqual(
        expect.objectContaining({ name: 'alfa market', add_order: true }),
      );
      // Asosiy bo'lmagan a'zoliklarga trigger tegmagan.
      expect(items[2]).toEqual(
        expect.objectContaining({ is_primary: false, commission_value: null }),
      );

      await updateAdmin('601', 'market_id = $1', [MARKET_B]);
      expect(
        (await service.listForOperator(601)).map((item) => item.market_id),
      ).toEqual([MARKET_B, MARKET_A]);
      expect(
        (await service.listForOperator('601', { include_removed: true })).map(
          (item) => [item.market_id, item.status],
        ),
      ).toEqual([
        [MARKET_B, 'active'],
        [MARKET_A, 'active'],
        [MARKET_C, 'removed'],
      ]);

      for (const bad of ['', 'abc', '-1', '99999999999999999999', null, {}]) {
        await expect(service.listForOperator(bad)).resolves.toEqual([]);
      }
      await expect(service.listForOperator('777')).resolves.toEqual([]);
    });

    it('down(): trigger, funksiya va jadval o`chadi; `admins` yozuvlari odatdagidek ishlaydi', async () => {
      await insertAdmin({
        id: '701',
        role: 'market_operator',
        market_id: MARKET_A,
      });
      await runMigration();
      await runMigration('down');

      const [{ table }] = await db.query<Row[]>(
        `SELECT to_regclass('identity_schema.market_operator_markets') AS table`,
      );
      expect(table).toBeNull();
      const fn = await db.query<Row[]>(
        `SELECT 1 FROM pg_proc
        WHERE proname = 'sync_market_operator_primary_membership'`,
      );
      expect(fn).toEqual([]);
      await updateAdmin('701', 'market_id = $1', [MARKET_B]);
      await insertAdmin({
        id: '702',
        role: 'market_operator',
        market_id: MARKET_A,
      });
    });
  },
);
