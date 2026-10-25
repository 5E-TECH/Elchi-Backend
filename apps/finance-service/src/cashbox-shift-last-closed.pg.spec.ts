import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of, throwError } from 'rxjs';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift, ShiftStatus } from './entities/shift.entity';
import { CashboxCard } from './entities/cashbox-card.entity';
import { CashboxCardMovement } from './entities/cashbox-card-movement.entity';

/**
 * 8OYPuz7J — HAQIQIY Postgres'da smena o'qish kontrakti:
 *  - `currentShift` → `last_closed` (shu kassaning eng oxirgi yopilgan smenasi,
 *    closed_at DESC; boshqa kassa smenasi aralashmaydi);
 *  - `findAllShifts` → `cashbox_user_id` filtri ('0' = MAIN), `sort_by=closed_at|
 *    opened_at` + `sort_dir` (ochiq smena closed_at bo'yicha har doim oxirida);
 *  - `opened_by_name` / `closed_by_name` — identity'ga BITTA batch so'rov.
 * Env (`FINANCE_PG_TEST_URI`) berilmasa skip.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg(
  '8OYPuz7J — smena: last_closed, filtr, saralash, ismlar (Postgres)',
  () => {
    const schema = `spec_shiftlc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    let service: FinanceServiceService;
    const identity = { send: jest.fn() };

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
        identity as never,
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

    const at = (iso: string) => new Date(iso);
    const shiftRow = (row: Partial<Shift>) =>
      db.getRepository(Shift).create({
        opening_balance_cash: 0,
        opening_balance_card: 0,
        ...row,
      });

    let ids: Record<string, string> = {};

    beforeEach(async () => {
      identity.send.mockReset();
      identity.send.mockImplementation(() =>
        of({
          statusCode: 200,
          data: [
            { id: '1', name: 'Ravshan Ortiqov' },
            { id: '2', name: 'Dilnoza Karimova' },
            { id: '25', name: 'Menejer Urgut' },
          ],
        }),
      );
      await db.query(
        `TRUNCATE TABLE "${schema}".shifts RESTART IDENTITY CASCADE`,
      );
      const saved = await db.getRepository(Shift).save([
        // MAIN: ikki yopilgan (eskisi va yangisi) + bitta ochiq.
        shiftRow({
          opened_by: '1',
          closed_by: '2',
          cashbox_user_id: '0',
          status: ShiftStatus.CLOSED,
          opened_at: at('2026-10-20T03:00:00Z'),
          closed_at: at('2026-10-20T13:00:00Z'),
          expected_balance_cash: 100_000,
          closing_balance_cash: 120_000,
          discrepancy_cash: 20_000,
          comment: 'eski',
        }),
        shiftRow({
          // Kechroq OCHILGAN, lekin ertaroq YOPILGAN — closed_at saralashi
          // opened_at saralashidan farq qilishi shu qator bilan tekshiriladi.
          opened_by: '2',
          closed_by: '1',
          cashbox_user_id: '0',
          status: ShiftStatus.CLOSED,
          opened_at: at('2026-10-21T03:00:00Z'),
          closed_at: at('2026-10-21T05:00:00Z'),
          comment: 'qisqa',
        }),
        shiftRow({
          opened_by: '1',
          closed_by: '99',
          cashbox_user_id: '0',
          status: ShiftStatus.CLOSED,
          opened_at: at('2026-10-20T14:00:00Z'),
          closed_at: at('2026-10-22T13:00:00Z'),
          expected_balance_cash: 200_000,
          expected_balance_card: 5_000,
          closing_balance_cash: 180_000,
          closing_balance_card: 5_000,
          discrepancy_cash: -20_000,
          discrepancy_card: 0,
          comment: 'oxirgi MAIN',
        }),
        shiftRow({
          opened_by: '2',
          cashbox_user_id: '0',
          status: ShiftStatus.OPEN,
          opened_at: at('2026-10-23T03:00:00Z'),
        }),
        // Filial 15: MAIN dan KEYIN yopilgan smena — MAIN ning last_closed iga
        // aralashmasligi kerak.
        shiftRow({
          opened_by: '25',
          closed_by: '25',
          cashbox_user_id: '15',
          status: ShiftStatus.CLOSED,
          opened_at: at('2026-10-23T03:00:00Z'),
          closed_at: at('2026-10-23T12:00:00Z'),
          comment: 'filial',
        }),
      ]);
      ids = {
        mainOld: String(saved[0].id),
        mainShort: String(saved[1].id),
        mainLast: String(saved[2].id),
        mainOpen: String(saved[3].id),
        branch: String(saved[4].id),
      };
    });

    describe('currentShift — last_closed', () => {
      it('MAIN: ochiq smena + shu kassaning eng oxirgi yopilgan smenasi (filial smenasi aralashmaydi), ismlar bilan', async () => {
        const res: any = await service.currentShift({});

        expect(res.statusCode).toBe(200);
        expect(res.data).toMatchObject({
          cashbox_user_id: '0',
          shift: {
            id: ids.mainOpen,
            status: ShiftStatus.OPEN,
            opened_by_name: 'Dilnoza Karimova',
            closed_by_name: null,
          },
          last_closed: {
            id: ids.mainLast,
            status: ShiftStatus.CLOSED,
            closed_by: '99',
            expected_balance_cash: 200_000,
            expected_balance_card: 5_000,
            closing_balance_cash: 180_000,
            closing_balance_card: 5_000,
            discrepancy_cash: -20_000,
            discrepancy_card: 0,
            comment: 'oxirgi MAIN',
            opened_by_name: 'Ravshan Ortiqov',
            // identity'da topilmagan xodim — null (xato emas).
            closed_by_name: null,
          },
        });
        expect(res.data.last_closed.closed_at).toEqual(
          at('2026-10-22T13:00:00Z'),
        );
        // Ochiq smena VA last_closed — bitta batch so'rov.
        expect(identity.send).toHaveBeenCalledTimes(1);
        const [pattern, payload] = identity.send.mock.calls[0];
        expect(pattern).toEqual({ cmd: 'identity.user.find_by_ids' });
        expect([...payload.ids].sort()).toEqual(['1', '2', '99']);
      });

      it('filial 15: o`z yopilgan smenasi; ochiq smena yo`q → shift null, last_closed bor', async () => {
        const res: any = await service.currentShift({ cashbox_user_id: '15' });

        expect(res.data.shift).toBeNull();
        expect(res.data.last_closed).toMatchObject({
          id: ids.branch,
          cashbox_user_id: '15',
          comment: 'filial',
          closed_by_name: 'Menejer Urgut',
        });
      });

      it('kassada yopilgan smena umuman yo`q → last_closed null', async () => {
        const res: any = await service.currentShift({ cashbox_user_id: '16' });

        expect(res.data).toMatchObject({
          shift: null,
          last_closed: null,
          cashbox_user_id: '16',
        });
        expect(identity.send).not.toHaveBeenCalled();
      });

      it('identity javob bermasa — ismlar null, javob baribir 200', async () => {
        identity.send.mockImplementation(() =>
          throwError(() => new Error('identity down')),
        );

        const res: any = await service.currentShift({});

        expect(res.statusCode).toBe(200);
        expect(res.data.last_closed).toMatchObject({
          id: ids.mainLast,
          opened_by_name: null,
          closed_by_name: null,
        });
      });
    });

    describe('findAllShifts — cashbox_user_id, sort_by/sort_dir, ismlar', () => {
      const idsOf = (res: any) =>
        (res.data.items as Array<{ id: string }>).map((row) => String(row.id));

      it('cashbox_user_id=0 — faqat MAIN smenalari; 15 — faqat filial', async () => {
        const main: any = await service.findAllShifts({ cashbox_user_id: '0' });
        const branch: any = await service.findAllShifts({
          cashbox_user_id: '15',
        });

        expect(main.data.pagination.total).toBe(4);
        expect(
          (main.data.items as Shift[]).every((s) => s.cashbox_user_id === '0'),
        ).toBe(true);
        expect(idsOf(branch)).toEqual([ids.branch]);
      });

      it('sukut — opened_at DESC (avvalgidek)', async () => {
        const res: any = await service.findAllShifts({ cashbox_user_id: '0' });

        expect(idsOf(res)).toEqual([
          ids.mainOpen,
          ids.mainShort,
          ids.mainLast,
          ids.mainOld,
        ]);
      });

      it('sort_by=closed_at (desc) — eng oxirgi yopilgan birinchi, ochiq smena oxirida', async () => {
        const res: any = await service.findAllShifts({
          cashbox_user_id: '0',
          sort_by: 'closed_at',
        });

        expect(idsOf(res)).toEqual([
          ids.mainLast,
          ids.mainShort,
          ids.mainOld,
          ids.mainOpen,
        ]);
      });

      it('sort_by=closed_at&sort_dir=asc — o`suvchi, ochiq smena baribir oxirida', async () => {
        const res: any = await service.findAllShifts({
          cashbox_user_id: '0',
          sort_by: 'closed_at',
          sort_dir: 'asc',
        });

        expect(idsOf(res)).toEqual([
          ids.mainOld,
          ids.mainShort,
          ids.mainLast,
          ids.mainOpen,
        ]);
      });

      it('status=closed + closed_at desc + limit=1 — MAIN ning oxirgi yopilgan smenasi bitta so`rovda', async () => {
        const res: any = await service.findAllShifts({
          cashbox_user_id: '0',
          status: ShiftStatus.CLOSED,
          sort_by: 'closed_at',
          sort_dir: 'desc',
          limit: 1,
        });

        expect(idsOf(res)).toEqual([ids.mainLast]);
        expect(res.data.pagination).toMatchObject({
          total: 3,
          limit: 1,
          totalPages: 3,
        });
      });

      it('qatorlarda opened_by_name / closed_by_name — sahifaga BITTA identity so`rovi', async () => {
        const res: any = await service.findAllShifts({ cashbox_user_id: '0' });

        expect(identity.send).toHaveBeenCalledTimes(1);
        const byId = new Map(
          (res.data.items as any[]).map((row) => [String(row.id), row]),
        );
        expect(byId.get(ids.mainOld)).toMatchObject({
          opened_by_name: 'Ravshan Ortiqov',
          closed_by_name: 'Dilnoza Karimova',
        });
        expect(byId.get(ids.mainOpen)).toMatchObject({
          opened_by_name: 'Dilnoza Karimova',
          closed_by_name: null,
        });
      });

      it('noto`g`ri cashbox_user_id → 400', async () => {
        await expect(
          service.findAllShifts({ cashbox_user_id: 'abc' }),
        ).rejects.toMatchObject({ error: { statusCode: 400 } });
      });
    });
  },
);
