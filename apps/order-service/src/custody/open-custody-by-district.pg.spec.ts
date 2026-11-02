import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { BranchTransferBatch } from '../entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from '../entities/branch-transfer-batch-item.entity';
import { BranchTransferBatchHistory } from '../entities/branch-transfer-batch-history.entity';
import {
  OpenCustodyByDistrictService,
  type OpenCustodyRow,
} from './open-custody-by-district.service';

/**
 * `order.open_custody_by_district` HAQIQIY Postgres'da
 * (ORDER_OPEN_CUSTODY_PG_TEST_URI bo'lmasa skip). URI bazasi nomi `_test`
 * bilan tugashi SHART (aks holda spec yiqiladi — boshqa bazaga tegmaydi).
 * O'z vaqtinchalik `spec_ocd_<tasodifiy>_test` bazasini yaratadi va oxirida
 * o'chiradi; `orders` va `branch_transfer_batches` jadvallari entity'lardan
 * (synchronize).
 *
 *  • filtr: faqat so'ralgan tumanlar, ochiq holatlar (new, received,
 *    waiting, waiting_customer, on the road, cancelled, sold); MARKET
 *    custody (bekor bo'lsa ham), paid / partly_paid / closed /
 *    returned_to_market, `cancelled (sent)`, `created`, o'chirilgan
 *    (is_deleted / deleted_at) — chiqmaydi;
 *  • `batch_destination_branch_id`: faqat SENT partiya (FORWARD va RETURN)
 *    manzili; PENDING / RECEIVED / CANCELLED / mavjud bo'lmagan partiya —
 *    null; JOIN qatorni ko'paytirmaydi;
 *  • tartib va keyset — bigint bo'yicha (9 < 10 < 100, matn emas), 2^53 dan
 *    katta id'lar aniq satr;
 *  • sahifalash limit chegaralarida (1, 2, 3, aniq karrali, ortiq).
 */
const pgUri = process.env.ORDER_OPEN_CUSTODY_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const D1 = '11';
const D2 = '9007199254740995'; // 2^53 dan katta — aniqlik tekshiruvi
const D_OTHER = '13';
const BIG_ID = '9007199254740993'; // 2^53 + 1 — Number'da yo'qolardi

type Seed = {
  id: string;
  status: string;
  district_id: string | null;
  region_id?: string | null;
  holder_type?: 'HQ' | 'BRANCH' | 'COURIER' | 'MARKET';
  holder_branch_id?: string | null;
  holder_courier_id?: string | null;
  branch_id?: string | null;
  courier_id?: string | null;
  current_batch_id?: string | null;
  is_deleted?: boolean;
  deleted_at?: string | null;
  /** Kutilgan javob qiymati (bazaga yozilmaydi — partiyadan keladi). */
  batch_destination_branch_id?: string | null;
};

/** Partiyalar: holat × yo'nalish (har biri bitta buyurtmaga biriktirilgan). */
type BatchSeed = {
  id: string;
  status: 'PENDING' | 'SENT' | 'RECEIVED' | 'CANCELLED';
  direction: 'FORWARD' | 'RETURN';
  source_branch_id: string;
  destination_branch_id: string;
};

const BATCHES: BatchSeed[] = [
  // HQ → S0 (FORWARD) jo'natilgan — buyurtma S0 ga ketyapti.
  {
    id: '801',
    status: 'SENT',
    direction: 'FORWARD',
    source_branch_id: '1',
    destination_branch_id: '6',
  },
  // Eski filial → HQ (RETURN) jo'natilgan — buyurtma HQ ga ketyapti.
  {
    id: '802',
    status: 'SENT',
    direction: 'RETURN',
    source_branch_id: '4',
    destination_branch_id: '1',
  },
  // Hali jo'natilmagan — buyurtma jismonan manbada.
  {
    id: '803',
    status: 'PENDING',
    direction: 'FORWARD',
    source_branch_id: '1',
    destination_branch_id: '6',
  },
  // Yopilgan partiyalar.
  {
    id: '804',
    status: 'RECEIVED',
    direction: 'FORWARD',
    source_branch_id: '1',
    destination_branch_id: '6',
  },
  {
    id: '805',
    status: 'CANCELLED',
    direction: 'RETURN',
    source_branch_id: '4',
    destination_branch_id: '1',
  },
];

/** Kutilgan qatorlar (id bo'yicha tartiblangan). */
const OPEN: Seed[] = [
  {
    id: '9',
    status: 'new',
    district_id: D1,
    region_id: '2',
    holder_type: 'HQ',
  },
  {
    id: '10',
    status: 'on the road',
    district_id: D1,
    region_id: '2',
    holder_type: 'BRANCH',
    holder_branch_id: '4',
    branch_id: '4',
    // Mavjud bo'lmagan partiya — LEFT JOIN null beradi, qator yo'qolmaydi.
    current_batch_id: '799',
  },
  // Ushlab turgan kuryer / filial WAITING ga qaytara oladi — kiradi.
  {
    id: '30',
    status: 'sold',
    district_id: D1,
    region_id: '2',
    holder_type: 'COURIER',
    holder_branch_id: '4',
    holder_courier_id: '90',
    branch_id: '4',
    courier_id: '90',
  },
  {
    id: '40',
    status: 'cancelled',
    district_id: D1,
    region_id: '2',
    holder_type: 'BRANCH',
    holder_branch_id: '4',
    branch_id: '4',
  },
  {
    id: '100',
    status: 'waiting',
    district_id: D2,
    region_id: '3',
    holder_type: 'COURIER',
    holder_branch_id: '4',
    holder_courier_id: '90',
    branch_id: '4',
    courier_id: '90',
  },
  {
    id: '101',
    status: 'received',
    district_id: D1,
    region_id: null,
    holder_type: 'BRANCH',
    holder_branch_id: '5',
    branch_id: '5',
  },
  // Partiyadagi buyurtmalar (BATCHES): faqat SENT — manzil.
  {
    id: '110',
    status: 'on the road',
    district_id: D1,
    region_id: '2',
    holder_type: 'BRANCH',
    holder_branch_id: '6',
    branch_id: '6',
    current_batch_id: '801',
    batch_destination_branch_id: '6',
  },
  {
    id: '111',
    status: 'on the road',
    district_id: D1,
    region_id: '2',
    holder_type: 'HQ',
    branch_id: '4',
    current_batch_id: '802',
    batch_destination_branch_id: '1',
  },
  {
    id: '112',
    status: 'received',
    district_id: D1,
    region_id: '2',
    holder_type: 'HQ',
    current_batch_id: '803',
  },
  {
    id: '113',
    status: 'received',
    district_id: D1,
    region_id: '2',
    holder_type: 'BRANCH',
    holder_branch_id: '6',
    branch_id: '6',
    current_batch_id: '804',
  },
  {
    id: '114',
    status: 'waiting',
    district_id: D1,
    region_id: '2',
    holder_type: 'BRANCH',
    holder_branch_id: '4',
    branch_id: '4',
    current_batch_id: '805',
  },
  {
    id: '205',
    status: 'waiting_customer',
    district_id: D2,
    region_id: '3',
    holder_type: 'COURIER',
    holder_branch_id: '5',
    holder_courier_id: '91',
    branch_id: '5',
    courier_id: '91',
  },
  {
    id: BIG_ID,
    status: 'waiting',
    district_id: D1,
    region_id: '2',
    holder_type: 'BRANCH',
    holder_branch_id: '4',
    branch_id: '4',
  },
];

/** Chiqmasligi kerak bo'lganlar (har biri bitta sabab bilan). */
const EXCLUDED: Seed[] = [
  // MARKET custody — ochiq holatda (bekor / sotilgan ham) bo'lsa ham.
  { id: '20', status: 'waiting', district_id: D1, holder_type: 'MARKET' },
  { id: '21', status: 'new', district_id: D2, holder_type: 'MARKET' },
  { id: '22', status: 'cancelled', district_id: D1, holder_type: 'MARKET' },
  { id: '23', status: 'sold', district_id: D2, holder_type: 'MARKET' },
  // Pul yopilgan / marketga qaytgan (rollback faqat superadmin'ga).
  { id: '31', status: 'paid', district_id: D1, holder_type: 'BRANCH' },
  { id: '32', status: 'partly_paid', district_id: D1, holder_type: 'BRANCH' },
  { id: '33', status: 'closed', district_id: D2, holder_type: 'HQ' },
  {
    id: '34',
    status: 'returned_to_market',
    district_id: D1,
    holder_type: 'MARKET',
  },
  // Marketga jo'natilgan bekor.
  {
    id: '41',
    status: 'cancelled (sent)',
    district_id: D2,
    holder_type: 'BRANCH',
  },
  // Qoralama.
  { id: '50', status: 'created', district_id: D1, holder_type: 'HQ' },
  // O'chirilgan — ikkala yo'l.
  {
    id: '60',
    status: 'waiting',
    district_id: D1,
    holder_type: 'BRANCH',
    is_deleted: true,
  },
  {
    id: '61',
    status: 'received',
    district_id: D2,
    holder_type: 'BRANCH',
    deleted_at: '2026-10-01T00:00:00Z',
  },
  // Boshqa tuman / tumansiz.
  { id: '70', status: 'waiting', district_id: D_OTHER, holder_type: 'BRANCH' },
  { id: '71', status: 'new', district_id: null, holder_type: 'HQ' },
];

const toRow = (seed: Seed): OpenCustodyRow => ({
  id: seed.id,
  district_id: seed.district_id,
  region_id: seed.region_id ?? null,
  status: seed.status,
  holder_type: seed.holder_type ?? 'HQ',
  holder_branch_id: seed.holder_branch_id ?? null,
  holder_courier_id: seed.holder_courier_id ?? null,
  branch_id: seed.branch_id ?? null,
  courier_id: seed.courier_id ?? null,
  current_batch_id: seed.current_batch_id ?? null,
  batch_destination_branch_id: seed.batch_destination_branch_id ?? null,
});

const EXPECTED_IDS = OPEN.map((seed) => seed.id);

describePg('order.open_custody_by_district — haqiqiy Postgres', () => {
  const dbName = `spec_ocd_${randomUUID().replace(/-/g, '').slice(0, 12)}_test`;
  let admin: DataSource | undefined;
  let db: DataSource | undefined;
  let service: OpenCustodyByDistrictService;

  beforeAll(async () => {
    const adminUrl = new URL(pgUri as string);
    if (!decodeURIComponent(adminUrl.pathname).endsWith('_test')) {
      throw new Error(
        `ORDER_OPEN_CUSTODY_PG_TEST_URI bazasi '_test' bilan tugashi kerak: ${adminUrl.pathname}`,
      );
    }
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri as string);
    url.pathname = `/${dbName}`;
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'order_schema',
      entities: [
        Order,
        OrderItem,
        OrderTracking,
        OrderCustodyEvent,
        Branch,
        BranchTransferBatch,
        BranchTransferBatchItem,
        BranchTransferBatchHistory,
      ],
      synchronize: false,
    });
    await db.initialize();
    for (const schema of ['order_schema', 'branch_schema']) {
      await db.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    }
    await db.synchronize();

    for (const batch of BATCHES) {
      const prefix = batch.direction === 'FORWARD' ? 'BTB' : 'BTR';
      await db.query(
        `INSERT INTO order_schema.branch_transfer_batches (
           id, qr_code_token, source_branch_id, request_key,
           destination_branch_id, direction, target_region_id, status
         ) VALUES ($1, $2, $3, $4, $5, $6, 2, $7)`,
        [
          batch.id,
          `${prefix}-SPEC${batch.id}`,
          batch.source_branch_id,
          `spec-${batch.id}`,
          batch.destination_branch_id,
          batch.direction,
          batch.status,
        ],
      );
    }

    // Tartibsiz kiritiladi — natija tartibi INSERT tartibiga bog'liq emas.
    const all = [...EXCLUDED, ...OPEN].sort((a, b) => a.id.localeCompare(b.id));
    for (const seed of all) {
      await db.query(
        `INSERT INTO order_schema.orders (
           id, market_id, customer_id, status, district_id, region_id,
           holder_type, holder_branch_id, holder_courier_id, branch_id,
           courier_id, current_batch_id, is_deleted, deleted_at
         ) VALUES ($1, 500, 77, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          seed.id,
          seed.status,
          seed.district_id,
          seed.region_id ?? null,
          seed.holder_type ?? 'HQ',
          seed.holder_branch_id ?? null,
          seed.holder_courier_id ?? null,
          seed.branch_id ?? null,
          seed.courier_id ?? null,
          seed.current_batch_id ?? null,
          seed.is_deleted ?? false,
          seed.deleted_at ?? null,
        ],
      );
    }
    service = new OpenCustodyByDistrictService(db.getRepository(Order));
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  const page = async (payload: Record<string, unknown>) =>
    (await service.findOpenCustodyByDistrict(payload)).data;

  it('faqat ochiq custody qatorlari, id (bigint) tartibida, aniq shaklda', async () => {
    const res = await service.findOpenCustodyByDistrict({
      district_ids: [D1, D2],
    });
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({
      rows: OPEN.map(toRow),
      next_after_id: null,
    });
    // 2^53 dan katta id va tuman — satr sifatida aniq.
    expect(res.data.rows.map((row) => row.id)).toContain(BIG_ID);
    expect(res.data.rows.map((row) => row.district_id)).toContain(D2);
  });

  it('MARKET / paid / cancelled (sent) / created / o`chirilgan / boshqa tuman chiqmaydi', async () => {
    const { rows } = await page({ district_ids: [D1, D2, D_OTHER] });
    const ids = rows.map((row) => row.id);
    for (const seed of EXCLUDED.filter((s) => s.district_id !== D_OTHER)) {
      expect(ids).not.toContain(seed.id);
    }
    // D_OTHER so'ralganda uning ochiq qatori chiqadi — filtr tuman bo'yicha.
    expect(ids).toEqual(
      [...EXPECTED_IDS.slice(0, 2), '70', ...EXPECTED_IDS.slice(2)].sort(
        (a, b) => (BigInt(a) < BigInt(b) ? -1 : 1),
      ),
    );
  });

  it('cancelled / sold (filial yoki kuryerda) kiradi; MARKET dagi bekor va paid — yo`q', async () => {
    const { rows } = await page({ district_ids: [D1, D2] });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('30')).toMatchObject({
      status: 'sold',
      holder_type: 'COURIER',
      holder_courier_id: '90',
    });
    expect(byId.get('40')).toMatchObject({
      status: 'cancelled',
      holder_type: 'BRANCH',
      holder_branch_id: '4',
    });
    for (const id of ['22', '23', '31', '32', '33', '41']) {
      expect(byId.has(id)).toBe(false);
    }
  });

  it('batch_destination_branch_id: faqat SENT partiya (FORWARD/RETURN) — manzil, qolgani null', async () => {
    const { rows } = await page({ district_ids: [D1, D2] });
    const dest = Object.fromEntries(
      rows
        .filter((row) => row.current_batch_id !== null)
        .map((row) => [row.id, row.batch_destination_branch_id]),
    );
    expect(dest).toEqual({
      '10': null, // partiya mavjud emas
      '110': '6', // SENT FORWARD (HQ → S0)
      '111': '1', // SENT RETURN (eski filial → HQ)
      '112': null, // PENDING — hali manbada
      '113': null, // RECEIVED
      '114': null, // CANCELLED
    });
    // Partiyasizlarda — doim null.
    expect(
      rows
        .filter((row) => row.current_batch_id === null)
        .every((row) => row.batch_destination_branch_id === null),
    ).toBe(true);
    // JOIN qatorni ko'paytirmaydi.
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it('bitta tuman so`ralsa — faqat o`sha tuman', async () => {
    const { rows } = await page({ district_ids: [D2] });
    expect(rows.map((row) => row.id)).toEqual(['100', '205']);
    expect(rows.every((row) => row.district_id === D2)).toBe(true);
  });

  it('keyset bigint bo`yicha: after_id 9 → 10 dan (matn tartibi emas)', async () => {
    const { rows, next_after_id } = await page({
      district_ids: [D1, D2],
      after_id: '9',
    });
    expect(rows.map((row) => row.id)).toEqual(EXPECTED_IDS.slice(1));
    expect(next_after_id).toBeNull();
    const tail = await page({ district_ids: [D1, D2], after_id: BIG_ID });
    expect(tail).toEqual({ rows: [], next_after_id: null });
  });

  it.each([1, 2, 3, 5, 13, 14])(
    'limit %p bilan sahifalash — har qator bir marta, tartib saqlanadi',
    async (limit) => {
      const seen: string[] = [];
      let afterId: string | null = null;
      let calls = 0;
      for (;;) {
        calls += 1;
        expect(calls).toBeLessThan(20);
        const res = await page({
          district_ids: [D1, D2],
          after_id: afterId,
          limit,
        });
        expect(res.rows.length).toBeLessThanOrEqual(limit);
        seen.push(...res.rows.map((row) => row.id));
        if (res.rows.length === limit) {
          // To'liq sahifa — davomi bor deb hisoblanadi (oxirgi id).
          expect(res.next_after_id).toBe(res.rows[res.rows.length - 1].id);
        } else {
          expect(res.next_after_id).toBeNull();
        }
        if (res.next_after_id === null) break;
        afterId = res.next_after_id;
      }
      expect(seen).toEqual(EXPECTED_IDS);
      // 13 qator: limit 1/13 — aniq karrali, oxirida bo'sh sahifa
      // (next_after_id null); 2/3/5 — oxirgi sahifa to'liqmas; limit 14 —
      // bitta to'liqmas sahifa.
      const total = EXPECTED_IDS.length;
      expect(total).toBe(13);
      expect(calls).toBe(
        total % limit === 0 ? total / limit + 1 : Math.ceil(total / limit),
      );
    },
  );
});
