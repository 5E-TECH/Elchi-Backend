import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of, throwError } from 'rxjs';
import { Cashbox_type } from '@app/common';
import { FinanceServiceService } from '../finance-service.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { Shift, ShiftStatus } from '../entities/shift.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { CashboxCardMovement } from '../entities/cashbox-card-movement.entity';
import { ShiftAccountCheck } from '../entities/shift-account-check.entity';
import { FinanceSetting } from '../entities/finance-setting.entity';
import { ShiftScheduleClaim } from '../entities/shift-schedule-claim.entity';
import { ShiftReportDelivery } from '../entities/shift-report-delivery.entity';
import { FinanceRealtimeService } from '../realtime/finance-realtime.service';
import { FinanceNotificationService } from '../notification/finance-notification.service';
import { ShiftAccountCheckService } from '../shift-account-check/shift-account-check.service';
import { ShiftReportService } from '../shift-report/shift-report.service';
import { ShiftAutoCloseScheduler } from './shift-auto-close.scheduler';
import { tashkentClock } from './shift-schedule.rules';

/**
 * «KUN TARTIBI» (ega 2026-11-11) — HAQIQIY Postgres'da:
 *  - avtomatik OCHISH: slot kelganda kassada ochiq smena yo'q — tizim ochadi
 *    (`opened_by` NULL, `opened_by_system`, ochilish qoldig'i jonli), realtime
 *    `finance.shift.auto_opened`; ochiq smena bor — hech narsa; 2 replika —
 *    BIR marta; qamrov main / main+branches; tizim smenasini kassir yopa oladi;
 *  - KECHIKISH xabari: ochish slotidan keyin smena yo'q / yopish slotidan keyin
 *    hali ochiq — superadminlarga BIR marta; avtomatik ochish xatosi — darhol,
 *    sababi bilan;
 *  - sozlamalar: GET/PATCH `auto_open`, `late_alert`; ochish ∩ yopish — 400
 *    `SHIFT_SCHEDULE_CONFLICT`.
 * Env (`FINANCE_PG_TEST_URI`) berilmasa skip.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

type OutboxCall = [string, string, Record<string, any>, unknown?];

const rpcError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { getError?: () => unknown }).getError?.() as Record<
      string,
      unknown
    >;
  }
  throw new Error('kutilgan xato chiqmadi');
};

describePg(
  '«Kun tartibi» — smena avtomatik ochish va kechikish xabari (Postgres)',
  () => {
    const schema = `spec_kuntartibi_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    let service: FinanceServiceService;
    let checks: ShiftAccountCheckService;
    let schedulerA: ShiftAutoCloseScheduler;
    let schedulerB: ShiftAutoCloseScheduler;
    const outbox = { enqueue: jest.fn() };
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const identity = {
      send: jest.fn((pattern: { cmd: string }, payload: any) => {
        switch (pattern.cmd) {
          case 'identity.user.active_ids_by_role':
            return of({ data: [{ user_id: '1' }, { user_id: '2' }] });
          case 'identity.user.find_by_ids':
            return of({
              data: (payload.ids as string[]).map((id) => ({
                id,
                name: `User ${id}`,
              })),
            });
          default:
            return throwError(() => new Error(`kutilmagan ${pattern.cmd}`));
        }
      }),
    };

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
          ShiftAccountCheck,
          FinanceSetting,
          ShiftScheduleClaim,
          ShiftReportDelivery,
        ],
        synchronize: true,
        extra: { max: 8 },
      });
      await db.initialize();
      // Migratsiya 216 dagi CHECK — entity'da yo'q, shu yerda qo'shiladi.
      await db.query(
        `ALTER TABLE "${schema}"."shifts" ADD CONSTRAINT "CHK_SHIFT_OPENED_BY_OR_SYSTEM" CHECK ("opened_by" IS NOT NULL OR "opened_by_system" = true)`,
      );
      const realtime = new FinanceRealtimeService(
        outbox as never,
        { get: () => 'gateway_queue' } as never,
      );
      const notifications = new FinanceNotificationService(outbox as never);
      checks = new ShiftAccountCheckService(db, activityLog as never, realtime);
      const reports = new ShiftReportService(
        db,
        activityLog as never,
        checks,
        notifications,
        identity as never,
        { send: jest.fn() } as never,
      );
      const trigger = {
        deliverSoon: jest.fn(),
        listDeliveries: (id: string) => reports.listDeliveries(id),
      };
      service = new FinanceServiceService(
        db.getRepository(Cashbox),
        db.getRepository(CashboxHistory),
        db.getRepository(Shift),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        db,
        activityLog as never,
        { send: jest.fn(() => of({ statusCode: 200 })) } as never,
        { send: jest.fn() } as never,
        identity as never,
        { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
        notifications,
        undefined,
        undefined,
        realtime,
        checks,
        trigger,
      );
      const makeScheduler = () =>
        new ShiftAutoCloseScheduler(
          db,
          service,
          checks,
          notifications,
          reports,
        );
      schedulerA = makeScheduler();
      schedulerB = makeScheduler();
      for (const target of [service, reports, schedulerA, schedulerB]) {
        for (const level of ['warn', 'log', 'error'] as const) {
          jest
            .spyOn((target as any).logger, level)
            .mockImplementation(() => undefined);
        }
      }
    }, 30_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.destroy();
      }
    });

    const outboxCalls = () => outbox.enqueue.mock.calls as OutboxCall[];
    const realtimeEvents = (event: string) =>
      outboxCalls()
        .filter(
          ([target, pattern, payload]) =>
            target === 'GATEWAY' &&
            pattern === 'realtime.notify' &&
            payload.event === event,
        )
        .map(([, , payload]) => payload);
    const dispatches = (type: string) =>
      outboxCalls()
        .filter(
          ([target, pattern, payload]) =>
            target === 'NOTIFICATION' &&
            pattern === 'notification.dispatch' &&
            payload.type === type,
        )
        .map(([, , payload]) => payload);

    const settings = (patch: Record<string, unknown>) =>
      checks.updateSettings({
        requester_id: '1',
        requester_roles: ['superadmin'],
        ...patch,
      });

    /** Joriy daqiqadan bir daqiqa oldingi Toshkent vaqti — slot "hozir keldi". */
    const slotJustPassed = () => tashkentClock(new Date(Date.now() - 60_000));
    /** Boshqa (to'qnashmaydigan) vaqt. */
    const otherTime = () => tashkentClock(new Date(Date.now() + 6 * 3_600_000));

    const shifts = () => db.getRepository(Shift).find({ order: { id: 'ASC' } });

    beforeEach(async () => {
      outbox.enqueue.mockReset();
      outbox.enqueue.mockResolvedValue(undefined);
      activityLog.log.mockClear();
      identity.send.mockClear();
      for (const table of [
        'shift_schedule_claims',
        'finance_settings',
        'shifts',
        'cashboxes',
      ]) {
        await db.query(
          `TRUNCATE TABLE "${schema}"."${table}" RESTART IDENTITY CASCADE`,
        );
      }
      const cashboxRepo = db.getRepository(Cashbox);
      await cashboxRepo.save([
        cashboxRepo.create({
          user_id: '0',
          cashbox_type: Cashbox_type.MAIN,
          balance: 900_000,
          balance_cash: 600_000,
          balance_card: 300_000,
        } as Partial<Cashbox>),
        cashboxRepo.create({
          user_id: '13',
          cashbox_type: Cashbox_type.BRANCH,
          balance: 70_000,
          balance_cash: 70_000,
          balance_card: 0,
        } as Partial<Cashbox>),
      ]);
    });

    describe('sozlamalar', () => {
      it('GET sukut: auto_open o`chiq (09:00, main), late_alert o`chiq (15 daq, in_app)', async () => {
        const res: any = await checks.getSettings({});
        expect(res.data.auto_open).toEqual({
          enabled: false,
          times: ['09:00'],
          scope: 'main',
        });
        expect(res.data.late_alert).toEqual({
          enabled: false,
          grace_min: 15,
          channels: { telegram: false, in_app: true },
        });
      });

      it('PATCH saqlanadi; channels qisman birlashtiriladi', async () => {
        await settings({
          auto_open: {
            enabled: true,
            times: ['09:00', '08:30'],
            scope: 'main+branches',
          },
          late_alert: {
            enabled: true,
            grace_min: 20,
            channels: { telegram: true },
          },
        });
        const res: any = await checks.getSettings({});
        expect(res.data.auto_open).toEqual({
          enabled: true,
          times: ['08:30', '09:00'],
          scope: 'main+branches',
        });
        expect(res.data.late_alert).toEqual({
          enabled: true,
          grace_min: 20,
          channels: { telegram: true, in_app: true },
        });
      });

      it('ochish va yopish vaqti bir xil — 400 SHIFT_SCHEDULE_CONFLICT, hech narsa yozilmaydi', async () => {
        await settings({ auto_close: { times: ['23:00'] } });
        const error = await rpcError(
          settings({ auto_open: { enabled: true, times: ['09:00', '23:00'] } }),
        );
        expect(error).toMatchObject({
          statusCode: 400,
          code: 'SHIFT_SCHEDULE_CONFLICT',
          times: '23:00',
        });
        const res: any = await checks.getSettings({});
        expect(res.data.auto_open.enabled).toBe(false);
      });

      it.each([
        [{ auto_open: { enabled: true, times: [] } }],
        [{ late_alert: { enabled: true, channels: { in_app: false } } }],
        [{ late_alert: { grace_min: 181 } }],
        [{ late_alert: { channels: { sms: true } } }],
        [{ auto_open: { scope: 'all' } }],
      ])('yaroqsiz %p — 400', async (patch) => {
        const error = await rpcError(settings(patch));
        expect(error.statusCode).toBe(400);
      });
    });

    describe('avtomatik ochish', () => {
      it('⭐ slot keldi, kassada ochiq smena yo`q — tizim ochadi, realtime, BIR marta', async () => {
        await settings({
          auto_open: { enabled: true, times: [slotJustPassed()] },
        });
        const [a, b] = await Promise.all([
          schedulerA.tick(),
          schedulerB.tick(),
        ]);
        const again = await schedulerA.tick();
        const all = await shifts();
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({
          cashbox_user_id: '0',
          status: ShiftStatus.OPEN,
          opened_by: null,
          opened_by_system: true,
          opening_balance_cash: 600_000,
          opening_balance_card: 300_000,
        });
        expect([...a.opened, ...b.opened, ...again.opened]).toEqual([
          String(all[0].id),
        ]);
        const events = realtimeEvents('finance.shift.auto_opened');
        expect(events).toHaveLength(1);
        expect(events[0].payload).toMatchObject({
          shift_id: String(all[0].id),
          cashbox_type: 'main',
          branch_id: null,
          open_reason: 'auto',
        });
        expect(events[0].targets).toEqual(
          expect.arrayContaining([{ role: 'superadmin' }, { role: 'admin' }]),
        );
        expect(activityLog.log).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'finance.shift_auto_opened' }),
        );
      });

      it('kassada ochiq smena bor — tizim hech narsa qilmaydi', async () => {
        await db.getRepository(Shift).save(
          db.getRepository(Shift).create({
            opened_by: '25',
            cashbox_user_id: '0',
            status: ShiftStatus.OPEN,
            opened_at: new Date(Date.now() - 3_600_000),
          }),
        );
        await settings({
          auto_open: { enabled: true, times: [slotJustPassed()] },
        });
        const result = await schedulerA.tick();
        expect(result.opened).toEqual([]);
        expect(await shifts()).toHaveLength(1);
      });

      it('o`chiq — vaqt kelgan bo`lsa ham ochilmaydi', async () => {
        await settings({
          auto_open: { enabled: false, times: [slotJustPassed()] },
        });
        expect((await schedulerA.tick()).opened).toEqual([]);
        expect(await shifts()).toHaveLength(0);
      });

      it('main+branches — filial kassasi ham ochiladi', async () => {
        await settings({
          auto_open: {
            enabled: true,
            times: [slotJustPassed()],
            scope: 'main+branches',
          },
        });
        await schedulerA.tick();
        const all = await shifts();
        expect(all.map((s) => s.cashbox_user_id).sort()).toEqual(['0', '13']);
        const branch = realtimeEvents('finance.shift.auto_opened').find(
          (event) => event.payload.cashbox_type === 'branch',
        );
        expect(branch?.targets).toEqual([{ role: 'manager', branch_id: '13' }]);
      });

      it('tizim ochgan smenani kassir odatdagidek yopa oladi', async () => {
        await settings({
          auto_open: { enabled: true, times: [slotJustPassed()] },
        });
        await schedulerA.tick();
        // BE-A: asosiy kassada kartalarni tasdiqlash qoidasi — bu test faqat
        // «tizim smenasini kassir topib yopa oladi»ni tekshiradi.
        await settings({ account_check_enabled: false });
        const res: any = await service.closeShift({
          closed_by: '25',
          closing_balance_cash: 600_000,
        });
        expect(res.statusCode).toBe(200);
        const [shift] = await shifts();
        expect(shift).toMatchObject({
          status: ShiftStatus.CLOSED,
          closed_by: '25',
          opened_by_system: true,
        });
      });
    });

    describe('kechikish xabari', () => {
      it('⭐ ochish vaqtidan keyin smena yo`q — superadminlarga BIR marta (avtomatika o`chiq bo`lsa ham)', async () => {
        await settings({
          auto_open: { enabled: false, times: [slotJustPassed()] },
          late_alert: {
            enabled: true,
            grace_min: 0,
            channels: { telegram: true, in_app: true },
          },
        });
        const first = await schedulerA.tick();
        const second = await schedulerB.tick();
        const alerts = dispatches('finance.shift_late');
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
          title: '⚠️ Smena vaqtida ochilmadi',
          recipient_ids: ['1', '2'],
          channels: ['in_app', 'realtime', 'telegram'],
          data: expect.objectContaining({ kind: 'open', cashbox_user_id: '0' }),
        });
        expect(first.late).toHaveLength(1);
        expect(second.late).toEqual([]);
      });

      it('smena vaqtida ochilgan — xabar yo`q', async () => {
        await db.getRepository(Shift).save(
          db.getRepository(Shift).create({
            opened_by: '25',
            cashbox_user_id: '0',
            status: ShiftStatus.OPEN,
            opened_at: new Date(),
          }),
        );
        await settings({
          auto_open: { times: [slotJustPassed()] },
          late_alert: { enabled: true, grace_min: 0 },
        });
        await schedulerA.tick();
        expect(dispatches('finance.shift_late')).toEqual([]);
      });

      it('yopish vaqtidan keyin smena hali ochiq — «vaqtida yopilmadi»', async () => {
        const open = await db.getRepository(Shift).save(
          db.getRepository(Shift).create({
            opened_by: '25',
            cashbox_user_id: '0',
            status: ShiftStatus.OPEN,
            opened_at: new Date(Date.now() - 3 * 3_600_000),
          }),
        );
        await settings({
          auto_open: { times: [otherTime()] },
          auto_close: { enabled: false, times: [slotJustPassed()] },
          late_alert: { enabled: true, grace_min: 0 },
        });
        await schedulerA.tick();
        await schedulerA.tick();
        const alerts = dispatches('finance.shift_late');
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
          title: '⚠️ Smena vaqtida yopilmadi',
          channels: ['in_app', 'realtime'],
          data: expect.objectContaining({
            kind: 'close',
            shift_id: String(open.id),
          }),
        });
      });

      it('tizim ocha olmadi — darhol, sababi bilan (muddat kutilmaydi)', async () => {
        await settings({
          auto_open: { enabled: true, times: [slotJustPassed()] },
          late_alert: { enabled: true, grace_min: 60 },
        });
        const spy = jest
          .spyOn(service, 'autoOpenShift')
          .mockRejectedValue(new Error('kassa qulfi band'));
        try {
          await schedulerA.tick();
          await schedulerA.tick();
        } finally {
          spy.mockRestore();
        }
        const alerts = dispatches('finance.shift_late');
        expect(alerts).toHaveLength(1);
        expect(alerts[0].body).toContain('tizim ocha olmadi: kassa qulfi band');
        expect(alerts[0].data).toMatchObject({ kind: 'open', failed: true });
      });

      it('o`chiq — hech narsa yuborilmaydi', async () => {
        await settings({
          auto_open: { times: [slotJustPassed()] },
          late_alert: { enabled: false, grace_min: 0 },
        });
        await schedulerA.tick();
        expect(dispatches('finance.shift_late')).toEqual([]);
      });
    });
  },
);
