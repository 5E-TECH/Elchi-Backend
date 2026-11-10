import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { OrderServiceService } from './order-service.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { Branch } from './entities/branch.entity';
import { MarketCancelledHandoverSession } from './entities/market-cancelled-handover-session.entity';

/**
 * «BEKOR QILINGANLAR → TOPSHIRILGAN» (2026-11-10) — partiyalar HAQIQIY Postgres'da:
 *   - bitta «Marketga jo'natish» (bir xil market + vaqt + xodim) = bitta karta; aralash usulda asosiy usul
 *     qo'lda bo'lmaganiniki, `manual_count` alohida;
 *   - faqat HQ'da ommaviy yo'l: market QR sessiyasi shu vaqtda yopilgan (± 5 s — migratsiya 155 to'ldirgan
 *     eski qatorlar). Bittalab «Marketga qaytarish» (sessiya yopilmagan), filial partiyasi, ombor qaytishi,
 *     keyin market qo'lidan chiqqan qator — kirmaydi;
 *   - Toshkent kuni (`day`), sana oralig'i, market nomi / telefoni bo'yicha qidiruv, sahifalash, `totals`;
 *   - bitta partiya: mikrosekundli kalit, xodimsiz (eski) partiya, begona / buzuq kalit — 404 / 400;
 *   - HQ id noma'lum — 503.
 *
 * Faqat lokal `/elchi_e_test`:
 *   ORDER_WAREHOUSE_PG_TEST_URI=postgres://postgres@127.0.0.1:5432/elchi_e_test
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

const SCHEMA = `chb_order_${process.pid}`;
const HQ = '1';
const BRANCH_SAM = '11';

const MARKETS = [
  { id: '121', name: 'Baraka Shop', phone_number: '+998901234567' },
  { id: '122', name: 'Nur Market', phone_number: '+998935557788' },
  { id: '123', name: 'Zamon Savdo', phone_number: '+998977771122' },
];
const USERS = [
  { id: '520', name: 'Aziz Karimov' },
  { id: '521', name: 'Malika Rasulova' },
];

// Vaqtlar (UTC). Toshkent = UTC+5.
const T_A = '2026-11-10T11:42:00.123456Z'; // 16:42 Toshkent, 10-noyabr
const T_B = '2026-11-09T07:31:00.5Z'; // 12:31, 9-noyabr
const T_C = '2026-11-08T06:00:00.000Z'; // eski (to'ldirilgan) partiya
const T_F = '2026-11-09T19:30:00Z'; // 00:30 Toshkent, 10-noyabr (UTC'da hali 9-noyabr)
const T_SINGLE = '2026-11-10T09:00:00Z';
const T_BRANCH = '2026-11-10T08:00:00Z';

const us = (iso: string) => {
  const [whole, frac = ''] = iso.replace('Z', '').split('.');
  const ms = Date.parse(`${whole}Z`);
  return String(BigInt(ms) * 1000n + BigInt((frac + '000000').slice(0, 6)));
};

(localTestDatabase ? describe : describe.skip)(
  '«Topshirilgan» partiyalari — haqiqiy Postgres (pg)',
  () => {
    let db: DataSource;
    let service: OrderServiceService;
    let hqBranchId: string | null = HQ;
    let qrSeq = 0;

    const order = async (row: {
      market: string;
      at: string | null;
      by?: string | null;
      method?: string | null;
      branch?: string | null;
      status?: string;
      holder?: string;
      price?: number;
    }) => {
      const [created] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "${SCHEMA}".orders
           (market_id, customer_id, status, holder_type, total_price,
            market_handover_at, market_handover_by, market_handover_method, market_handover_branch_id)
         VALUES ($1, 801, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id::text AS id`,
        [
          row.market,
          row.status ?? 'returned_to_market',
          row.holder ?? 'MARKET',
          row.price ?? 100_000,
          row.at,
          row.by === undefined ? '520' : row.by,
          row.method === undefined ? 'qr' : row.method,
          row.branch === undefined ? HQ : row.branch,
        ],
      );
      return created.id;
    };

    const session = async (market: string, consumedAt: string | null) => {
      qrSeq += 1;
      await db.query(
        `INSERT INTO "${SCHEMA}".market_cancelled_handover_sessions
           (market_id, qr_token_hash, qr_expires_at, consumed_at, authorized_via)
         VALUES ($1, $2, now(), $3, 'qr')`,
        [market, `hash-${qrSeq}`, consumedAt],
      );
    };

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: SCHEMA,
        entities: [
          Order,
          OrderItem,
          OrderTracking,
          OrderCustodyEvent,
          Branch,
          MarketCancelledHandoverSession,
        ],
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
        identityClient: {
          send: jest.fn(
            (pattern: { cmd: string }, payload: { ids?: string[] }) => {
              const ids = new Set((payload?.ids ?? []).map(String));
              if (pattern.cmd === 'identity.market.find_by_ids') {
                return of({ data: MARKETS.filter((m) => ids.has(m.id)) });
              }
              if (pattern.cmd === 'identity.user.find_by_ids') {
                return of({ data: USERS.filter((u) => ids.has(u.id)) });
              }
              return of({ data: [] });
            },
          ),
        },
        // Boyitish (mijoz, tuman, …) bu yerda tekshirilmaydi — qatorlar o'zi.
        enrichOrders: jest.fn((rows: Order[]) => Promise.resolve(rows)),
      });

      // A — HQ, Baraka Shop, 3 ta (biri qo'lda), QR; sessiya AYNAN shu vaqtda yopilgan.
      await order({ market: '121', at: T_A, price: 96_000 });
      await order({ market: '121', at: T_A, price: 245_000 });
      await order({ market: '121', at: T_A, method: 'manual', price: 420_000 });
      await session('121', T_A);
      // B — HQ, Nur Market, 2 ta, parol orqali, boshqa xodim, kecha.
      await order({ market: '122', at: T_B, by: '521', method: 'pin' });
      await order({ market: '122', at: T_B, by: '521', method: 'pin' });
      await session('122', T_B);
      // C — eski partiya (migratsiya 155): xodim va usul yo'q, sessiya 0.8 s farq bilan.
      await order({ market: '121', at: T_C, by: null, method: null });
      await order({ market: '121', at: T_C, by: null, method: null });
      await session('121', '2026-11-08T06:00:00.800Z');
      // F — SA/admin, HQ id o'sha payt aniqlanmagan (branch NULL); Toshkent kuni UTC'dan farq qiladi.
      await order({ market: '123', at: T_F, branch: null, price: 50_000 });
      await session('123', T_F);

      // Kirmaydiganlar:
      // bittalab «Marketga qaytarish» — sessiya bor, lekin yopilmagan;
      await order({ market: '121', at: T_SINGLE });
      await session('121', null);
      // filialda ommaviy topshirish;
      await order({ market: '122', at: T_BRANCH, branch: BRANCH_SAM });
      await session('122', T_BRANCH);
      // ombor qaytishi (vaqt yo'q) va keyin market qo'lidan chiqqan eski qator (A vaqti bilan).
      await order({ market: '121', at: null, by: null, method: null });
      await order({
        market: '121',
        at: T_A,
        status: 'waiting',
        holder: 'COURIER',
      });
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        await db.destroy();
      }
    });

    beforeEach(() => {
      hqBranchId = HQ;
    });

    it('partiyalar: eng yangisi birinchi, faqat HQ ommaviy topshirishlar', async () => {
      const result = await service.findCancelledHandoverBatches({});
      expect(result.data.map((b) => b.id)).toEqual([
        `121_${us(T_A)}_520`,
        `123_${us(T_F)}_520`,
        `122_${us(T_B)}_521`,
        `121_${us(T_C)}_0`,
      ]);
      expect(result.total).toBe(4);
      expect(result.totals).toEqual({
        batches: 4,
        orders: 8,
        amount: 96_000 + 245_000 + 420_000 + 4 * 100_000 + 50_000,
      });
    });

    it('karta: market, xodim, vaqt, Toshkent kuni, usul va qo‘lda soni', async () => {
      const { data } = await service.findCancelledHandoverBatches({});
      const [a, f, b, c] = data;
      expect(a).toEqual({
        id: `121_${us(T_A)}_520`,
        market_id: '121',
        market: {
          id: '121',
          name: 'Baraka Shop',
          phone_number: '+998901234567',
        },
        handed_at: '2026-11-10T11:42:00.123Z',
        day: '2026-11-10',
        handed_by: { id: '520', name: 'Aziz Karimov' },
        method: 'qr',
        manual_count: 1,
        orders_count: 3,
        total_price_sum: 761_000,
      });
      expect(f.day).toBe('2026-11-10');
      expect(b).toEqual(
        expect.objectContaining({
          method: 'pin',
          manual_count: 0,
          orders_count: 2,
          handed_by: { id: '521', name: 'Malika Rasulova' },
        }),
      );
      expect(c).toEqual(
        expect.objectContaining({
          method: null,
          handed_by: null,
          day: '2026-11-08',
          orders_count: 2,
        }),
      );
    });

    it('sana oralig‘i Toshkent kunlari bo‘yicha (F 10-noyabrga tushadi)', async () => {
      const result = await service.findCancelledHandoverBatches({
        start_day: '2026-11-10',
        end_day: '2026-11-10',
      });
      expect(result.data.map((b) => b.market_id)).toEqual(['121', '123']);
      expect(result.totals.orders).toBe(4);
      const nov9 = await service.findCancelledHandoverBatches({
        start_day: '2026-11-09',
        end_day: '2026-11-09',
      });
      expect(nov9.data.map((b) => b.market_id)).toEqual(['122']);
    });

    it('qidiruv: market nomi va telefon raqami; topilmasa — bo‘sh', async () => {
      const byName = await service.findCancelledHandoverBatches({
        search: 'baraka',
      });
      expect(byName.data.map((b) => b.market_id)).toEqual(['121', '121']);
      expect(byName.totals.orders).toBe(5);
      const byPhone = await service.findCancelledHandoverBatches({
        search: '93 555',
      });
      expect(byPhone.data.map((b) => b.market_id)).toEqual(['122']);
      const none = await service.findCancelledHandoverBatches({
        search: 'yo‘q market',
      });
      expect(none).toEqual(
        expect.objectContaining({
          data: [],
          total: 0,
          totals: { batches: 0, orders: 0, amount: 0 },
        }),
      );
    });

    it('sahifalash: limit 2, 2-sahifa — keyingi ikkitasi, totals butun filtr bo‘yicha', async () => {
      const page2 = await service.findCancelledHandoverBatches({
        page: 2,
        limit: 2,
      });
      expect(page2.data.map((b) => b.market_id)).toEqual(['122', '121']);
      expect(page2).toEqual(
        expect.objectContaining({ total: 4, page: 2, limit: 2 }),
      );
      expect(page2.totals.batches).toBe(4);
    });

    it('noto‘g‘ri sana — 400; HQ noma‘lum — 503', async () => {
      await expect(
        service.findCancelledHandoverBatches({ start_day: 'kecha' }),
      ).rejects.toBeInstanceOf(RpcException);
      hqBranchId = null;
      const error = await service
        .findCancelledHandoverBatches({})
        .catch((e: RpcException) => e);
      expect((error as RpcException).getError()).toEqual(
        expect.objectContaining({ statusCode: 503 }),
      );
    });

    it('bitta partiya: buyurtmalar va karta (mikrosekundli kalit)', async () => {
      const { data } = await service.findCancelledHandoverBatches({});
      const result = await service.findCancelledHandoverBatch(data[0].id);
      expect(result.batch).toEqual(data[0]);
      expect(result.total).toBe(3);
      expect(result.data.map((o) => Number(o.total_price)).sort()).toEqual([
        245_000, 420_000, 96_000,
      ]);
    });

    it('bitta partiya: xodimsiz eski partiya ham ochiladi', async () => {
      const result = await service.findCancelledHandoverBatch(
        `121_${us(T_C)}_0`,
      );
      expect(result.total).toBe(2);
      expect(result.batch.handed_by).toBeNull();
    });

    it('bitta partiya: bittalab / filial kaliti — 404, buzuq kalit — 400', async () => {
      const status = (id: string) =>
        service
          .findCancelledHandoverBatch(id)
          .then(() => 200)
          .catch(
            (e: RpcException) =>
              (e.getError() as { statusCode: number }).statusCode,
          );
      expect(await status(`121_${us(T_SINGLE)}_520`)).toBe(404);
      expect(await status(`122_${us(T_BRANCH)}_520`)).toBe(404);
      expect(await status('121-abc')).toBe(400);
    });
  },
);
