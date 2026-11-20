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

/**
 * KUN ALMASHISHI va O'TKAZIB YUBORILGAN YOPISH — HAQIQIY Postgres'da, soat
 * soxtalashtirilgan (faqat `Date`; pg taymerlariga tegilmaydi):
 *  - kun 1 → kun 2: 09:00 ochiladi (main + filial), 23:00 yopiladi, ertasi
 *    09:00 yangi smena; ochilish qoldig'i — jonli qoldiq;
 *  - yarim tun: yopish 23:59 + ochish 00:00 — bitta tickda;
 *  - server yopish vaqtida 10 daqiqadan ko'p ishlamagan — qayta ishga
 *    tushgandagi birinchi tickda kechikib yopiladi (yurak urishi);
 *  - yurak urishi yo'q (birinchi ishga tushish) yoki slotdan keyin tick
 *    bo'lgan (avtomatika keyin yoqilgan) — o'tib ketgan slot quvlanmaydi.
 * Env (`FINANCE_PG_TEST_URI`) berilmasa skip.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

type OutboxCall = [string, string, Record<string, any>, unknown?];

describePg(
  'Kun almashishi va o‘tkazib yuborilgan avto-yopish (Postgres)',
  () => {
    const schema = `spec_missedslot_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    let service: FinanceServiceService;
    let checks: ShiftAccountCheckService;
    let schedulerA: ShiftAutoCloseScheduler;
    let schedulerB: ShiftAutoCloseScheduler;
    let reports: ShiftReportService;
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
      reports = new ShiftReportService(
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

    /** Toshkent vaqti → UTC lahza. */
    const T = (local: string) => new Date(`${local.replace(' ', 'T')}+05:00`);
    /** Soat `local` ga suriladi va tick (A replika). */
    const at = async (local: string) => {
      jest.setSystemTime(T(local));
      return schedulerA.tick(T(local));
    };
    /** Kassaga naqd KIRIM (balans + tarix qatori `local` vaqtida). */
    const income = async (
      cashboxUserId: string,
      amount: number,
      local: string,
    ) => {
      const repo = db.getRepository(Cashbox);
      const cashbox = await repo.findOneByOrFail({ user_id: cashboxUserId });
      cashbox.balance_cash = Number(cashbox.balance_cash) + amount;
      cashbox.balance = Number(cashbox.balance) + amount;
      await repo.save(cashbox);
      await db.getRepository(CashboxHistory).save(
        db.getRepository(CashboxHistory).create({
          operation_type: 'income',
          cashbox_id: cashbox.id,
          source_type: 'manual_income',
          amount,
          balance_after: Number(cashbox.balance),
          payment_method: 'cash',
          createdAt: T(local),
        } as never),
      );
    };
    const withStatus = async (status: ShiftStatus) =>
      (await shifts()).filter((shift) => shift.status === status);
    const claimKeys = async () =>
      (await db.getRepository(ShiftScheduleClaim).find()).map((c) => c.key);

    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      });
      jest.setSystemTime(T('2026-11-20 08:00'));
    });
    afterEach(() => jest.useRealTimers());

    const fullSchedule = () =>
      settings({
        auto_open: { enabled: true, times: ['09:00'], scope: 'main+branches' },
        auto_close: {
          enabled: true,
          times: ['23:00'],
          scope: 'main+branches',
          warn_before_min: 15,
        },
        late_alert: { enabled: true, grace_min: 15 },
      });

    it('kun 1 → kun 2: 09:00 ochiladi, 23:00 yopiladi, ertasi 09:00 yangi smena (main + filial)', async () => {
      await fullSchedule();
      expect((await at('2026-11-20 08:59:30')).opened).toEqual([]);
      expect((await at('2026-11-20 09:00:30')).opened).toHaveLength(2);
      expect((await at('2026-11-20 09:01:30')).opened).toEqual([]);
      expect((await at('2026-11-20 09:16:00')).late).toEqual([]);

      await income('0', 200_000, '2026-11-20 12:00');
      await income('13', 30_000, '2026-11-20 13:00');

      expect((await at('2026-11-20 22:50:00')).closed).toEqual([]);
      expect((await at('2026-11-20 23:00:30')).closed).toHaveLength(2);
      expect((await at('2026-11-20 23:05:00')).closed).toEqual([]);
      expect((await at('2026-11-20 23:16:00')).late).toEqual([]);

      const closed = await withStatus(ShiftStatus.CLOSED);
      const main1 = closed.find((shift) => shift.cashbox_user_id === '0')!;
      const branch1 = closed.find((shift) => shift.cashbox_user_id === '13')!;
      expect(main1).toMatchObject({
        close_reason: 'auto',
        closed_by_system: true,
        opening_balance_cash: 600_000,
        total_income_cash: 200_000,
        expected_balance_cash: 800_000,
        expected_balance_card: 300_000,
      });
      expect(new Date(main1.closed_at!).toISOString()).toBe(
        T('2026-11-20 23:00:30').toISOString(),
      );
      expect(branch1).toMatchObject({
        opening_balance_cash: 70_000,
        expected_balance_cash: 100_000,
      });

      // Smenalar orasida (tunda) kirim — keyingi smenaning ochilish qoldig'ida.
      await income('0', 50_000, '2026-11-20 23:30');

      expect((await at('2026-11-21 09:00:30')).opened).toHaveLength(2);
      const main2 = (await withStatus(ShiftStatus.OPEN)).find(
        (shift) => shift.cashbox_user_id === '0',
      )!;
      expect(main2.opening_balance_cash).toBe(850_000);
      expect(main2.opening_balance_card).toBe(300_000);
      expect(await claimKeys()).toEqual(
        expect.arrayContaining([
          'auto_open:0:2026-11-20T09:00',
          'auto_open:13:2026-11-20T09:00',
          'auto_open:0:2026-11-21T09:00',
          'auto_open:13:2026-11-21T09:00',
          `auto_close:${main1.id}:2026-11-20T23:00`,
          `auto_close:${branch1.id}:2026-11-20T23:00`,
        ]),
      );
      expect(dispatches('finance.shift_late')).toHaveLength(0);

      // Kun 2 yopilgach: tungi (smenasiz) 50 000 hisobotda alohida ko'rinadi.
      expect((await at('2026-11-21 23:00:30')).closed).toHaveLength(2);
      const day2 = await db
        .getRepository(Shift)
        .findOneByOrFail({ id: main2.id });
      const snapshot = await reports.buildSnapshot(day2, 1);
      expect(snapshot.between_shifts).toMatchObject({
        income: 50_000,
        expense: 0,
        count: 1,
      });
      expect(new Date(snapshot.between_shifts!.from).toISOString()).toBe(
        T('2026-11-20 23:00:30').toISOString(),
      );
      // Filialda smenasiz harakat yo'q — null.
      const branch2 = (await shifts()).find(
        (shift) => shift.cashbox_user_id === '13' && shift.id !== branch1.id,
      )!;
      expect((await reports.buildSnapshot(branch2, 1)).between_shifts).toBe(
        null,
      );
    });

    it('yarim tun: yopish 23:59, ochish 00:00 — bitta tickda eski yopiladi, yangisi ochiladi', async () => {
      await settings({
        auto_open: { enabled: true, times: ['00:00'], scope: 'main' },
        auto_close: {
          enabled: true,
          times: ['23:59'],
          scope: 'main',
          warn_before_min: 0,
        },
      });
      expect((await at('2026-11-20 00:00:30')).opened).toHaveLength(1);
      await income('0', 10_000, '2026-11-20 15:00');
      const tick = await at('2026-11-21 00:00:30');
      expect(tick.closed).toHaveLength(1);
      expect(tick.opened).toHaveLength(1);
      const all = await shifts();
      expect(all).toHaveLength(2);
      expect(all[0]).toMatchObject({
        status: ShiftStatus.CLOSED,
        expected_balance_cash: 610_000,
      });
      expect(all[1]).toMatchObject({
        status: ShiftStatus.OPEN,
        opening_balance_cash: 610_000,
      });
      expect(await claimKeys()).toEqual(
        expect.arrayContaining([
          `auto_close:${all[0].id}:2026-11-20T23:59`,
          'auto_open:0:2026-11-21T00:00',
        ]),
      );
    });

    it('⭐ server 22:59 → 23:12 ishlamadi: birinchi tickda kechikib yopiladi, ertasi 09:00 yangi smena', async () => {
      await fullSchedule();
      expect((await at('2026-11-20 09:00:30')).opened).toHaveLength(2);
      await at('2026-11-20 22:59:00');
      // 23:00–23:10 catch-up oynasida tick yo'q (server o'chiq).
      const back = await at('2026-11-20 23:12:00');
      expect(back.closed).toHaveLength(2);
      const closed = await withStatus(ShiftStatus.CLOSED);
      expect(closed).toHaveLength(2);
      for (const shift of closed) {
        expect(shift).toMatchObject({
          close_reason: 'auto',
          closed_by_system: true,
        });
        expect(new Date(shift.closed_at!).toISOString()).toBe(
          T('2026-11-20 23:12:00').toISOString(),
        );
      }
      expect(await claimKeys()).toEqual(
        expect.arrayContaining(
          closed.map((shift) => `auto_close:${shift.id}:2026-11-20T23:00`),
        ),
      );
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'finance.shift_auto_closed',
          metadata: expect.objectContaining({
            slot: '2026-11-20T23:00',
            missed_slot: true,
            late_by_min: 12,
          }),
        }),
      );
      // Takror yopilmaydi, «vaqtida yopilmadi» xabari ham yo'q (yopilgan).
      expect((await at('2026-11-20 23:13:00')).closed).toEqual([]);
      expect((await at('2026-11-20 23:16:00')).late).toEqual([]);
      // Kun almashadi: ertasi 09:00 da yangi smenalar.
      expect((await at('2026-11-21 09:00:30')).opened).toHaveLength(2);
    });

    it("yurak urishi yo'q (birinchi ishga tushish) — o'tib ketgan slot quvlanmaydi", async () => {
      const open = await db.getRepository(Shift).save(
        db.getRepository(Shift).create({
          opened_by: '25',
          cashbox_user_id: '0',
          status: ShiftStatus.OPEN,
          opened_at: T('2026-11-20 09:00'),
        }),
      );
      await settings({
        auto_close: { enabled: true, times: ['23:00'], warn_before_min: 0 },
      });
      expect((await at('2026-11-20 23:12:00')).closed).toEqual([]);
      expect((await at('2026-11-20 23:13:00')).closed).toEqual([]);
      expect(
        (await db.getRepository(Shift).findOneByOrFail({ id: open.id })).status,
      ).toBe(ShiftStatus.OPEN);
      // Keyingi slotda odatdagidek yopiladi.
      expect((await at('2026-11-21 23:00:30')).closed).toEqual([
        String(open.id),
      ]);
    });

    it("avtomatika slotdan KEYIN yoqildi (scheduler ishlab turgan) — o'tib ketgan slot quvlanmaydi", async () => {
      const open = await db.getRepository(Shift).save(
        db.getRepository(Shift).create({
          opened_by: '25',
          cashbox_user_id: '0',
          status: ShiftStatus.OPEN,
          opened_at: T('2026-11-20 09:00'),
        }),
      );
      await settings({
        auto_close: { enabled: false, times: ['23:00'], warn_before_min: 0 },
      });
      await at('2026-11-20 22:59:00');
      await at('2026-11-20 23:05:00'); // o'chiq — faqat yurak urishi
      await settings({ auto_close: { enabled: true } });
      expect((await at('2026-11-20 23:20:00')).closed).toEqual([]);
      expect(
        (await db.getRepository(Shift).findOneByOrFail({ id: open.id })).status,
      ).toBe(ShiftStatus.OPEN);
    });
  },
);
