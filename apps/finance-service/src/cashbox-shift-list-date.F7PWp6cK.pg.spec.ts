import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift, ShiftStatus } from './entities/shift.entity';
import { CashboxCard } from './entities/cashbox-card.entity';
import { CashboxCardMovement } from './entities/cashbox-card-movement.entity';

/**
 * F7PWp6cK (BE-D, D1) — HAQIQIY Postgres'da `GET /finance/shift`
 * (`finance.shift.find_all`) sana filtri: 'YYYY-MM-DD' — butun Toshkent
 * kalendar kuni, ikki chet ham kiradi (00:00:00.000 … 23:59:59.999 +05:00),
 * smena OCHILGAN vaqti (`opened_at`) bo'yicha. Ilgari `new Date('YYYY-MM-DD')`
 * = UTC yarim tuni = Toshkent 05:00 edi: bitta kun so'rovi ~0 qaytarar, `to`
 * kuni amalda tushib qolardi (Smenalar sahifasi va AI `get_shift_summaries`).
 * To'liq ISO vaqt — o'zgarishsiz (aniq lahza).
 *
 * Env (`FINANCE_PG_TEST_URI` yoki `FINANCE_OPERATOR_PG_TEST_URI`) berilmasa skip.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg(
  'F7PWp6cK — smena ro‘yxati: Toshkent kuni bo‘yicha sana filtri (Postgres)',
  () => {
    const schema = `spec_shiftdate_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    let service: FinanceServiceService;

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: pgUri });
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      db = new DataSource({
        type: 'postgres',
        url: pgUri,
        schema,
        entities: [
          Cashbox,
          CashboxHistory,
          Shift,
          CashboxCard,
          CashboxCardMovement,
        ],
        synchronize: true,
        extra: { max: 5 },
      });
      await db.initialize();
      service = new FinanceServiceService(
        db.getRepository(Cashbox),
        db.getRepository(CashboxHistory),
        db.getRepository(Shift),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        db,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
        { send: jest.fn(() => of({ statusCode: 200 })) } as never,
        { send: jest.fn() } as never,
        // identity — ismlar shart emas (bo'sh javob).
        { send: jest.fn(() => of({ statusCode: 200, data: [] })) } as never,
        { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
      );
      jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);
    }, 30_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.destroy();
      }
    });

    /** Toshkent mahalliy vaqti (+05:00) → Date. */
    const tz = (local: string) => new Date(`${local}+05:00`);
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      const seed: Array<[string, string, Partial<Shift>]> = [
        // 30-sentabr kechqurun — 1-oktabr so'roviga KIRMAYDI.
        ['sep30Late', '2026-09-30T23:50:00', {}],
        // 1-oktabr 00:30 (UTC 30-sentabr 19:30) — ilgari 1-oktabrdan tushardi.
        ['oct1Early', '2026-10-01T00:30:00', {}],
        // 1-oktabr kunduzi (= UTC 05:00 — eski oynaning aynan chegarasi).
        ['oct1Day', '2026-10-01T10:00:00', { cashbox_user_id: '15' }],
        // 1-oktabr 23:30 (UTC 18:30).
        ['oct1Late', '2026-10-01T23:30:00', { status: ShiftStatus.OPEN }],
        // 2-oktabr 00:10 (UTC 1-oktabr 19:10) — 1-oktabrga KIRMAYDI.
        ['oct2Early', '2026-10-02T00:10:00', {}],
        ['oct3Noon', '2026-10-03T12:00:00', {}],
      ];
      const saved = await db.getRepository(Shift).save(
        seed.map(([, local, extra], i) =>
          db.getRepository(Shift).create({
            opened_by: String(100 + i),
            cashbox_user_id: '0',
            status: ShiftStatus.CLOSED,
            opening_balance_cash: 0,
            opening_balance_card: 0,
            opened_at: tz(local),
            closed_at: extra.status === ShiftStatus.OPEN ? null : tz(local),
            ...extra,
          }),
        ),
      );
      seed.forEach(([key], i) => {
        ids[key] = String(saved[i].id);
      });
    });

    const find = async (dto: Record<string, unknown>) => {
      const res: any = await service.findAllShifts({ limit: 100, ...dto });
      return {
        total: res.data.pagination.total as number,
        ids: (res.data.items as Array<{ id: string }>)
          .map((row) => String(row.id))
          .sort((a, b) => Number(a) - Number(b)),
      };
    };
    const idsOf = (...keys: string[]) =>
      keys.map((k) => ids[k]).sort((a, b) => Number(a) - Number(b));

    it('bitta kun (from = to) — shu Toshkent kunida ochilgan BARCHA smenalar (ilgari 0)', async () => {
      const res = await find({
        from_date: '2026-10-01',
        to_date: '2026-10-01',
      });

      expect(res).toEqual({
        total: 3,
        ids: idsOf('oct1Early', 'oct1Day', 'oct1Late'),
      });
    });

    it('oraliq — `to` kuni to‘liq kiradi, `from` kunining 00:00–05:00 ham', async () => {
      const res = await find({
        from_date: '2026-10-01',
        to_date: '2026-10-02',
      });

      expect(res).toEqual({
        total: 4,
        ids: idsOf('oct1Early', 'oct1Day', 'oct1Late', 'oct2Early'),
      });
    });

    it('faqat from_date / faqat to_date — Toshkent kun chegarasi', async () => {
      expect(await find({ from_date: '2026-10-02' })).toEqual({
        total: 2,
        ids: idsOf('oct2Early', 'oct3Noon'),
      });
      expect(await find({ to_date: '2026-09-30' })).toEqual({
        total: 1,
        ids: idsOf('sep30Late'),
      });
    });

    it('status / cashbox_user_id filtrlari bilan birga — AYNI kun oynasi', async () => {
      expect(
        await find({
          from_date: '2026-10-01',
          to_date: '2026-10-01',
          status: ShiftStatus.CLOSED,
        }),
      ).toEqual({ total: 2, ids: idsOf('oct1Early', 'oct1Day') });
      expect(
        await find({
          from_date: '2026-10-01',
          to_date: '2026-10-01',
          cashbox_user_id: '15',
        }),
      ).toEqual({ total: 1, ids: idsOf('oct1Day') });
    });

    it('to‘liq ISO vaqt — o‘zgarishsiz: aniq lahzalar, ikki chet ham kiradi', async () => {
      const res = await find({
        from_date: '2026-10-01T05:00:00.000Z',
        to_date: '2026-10-01T18:30:00.000Z',
      });

      expect(res).toEqual({ total: 2, ids: idsOf('oct1Day', 'oct1Late') });
    });

    it('yaroqsiz sana — 400', async () => {
      await expect(
        service.findAllShifts({ from_date: '2026-13-45' }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
    });
  },
);
