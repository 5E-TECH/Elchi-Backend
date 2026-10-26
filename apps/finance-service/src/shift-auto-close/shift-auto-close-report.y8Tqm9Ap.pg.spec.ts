import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of, throwError } from 'rxjs';
import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
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
 * y8Tqm9Ap + gWI4gYkw — HAQIQIY Postgres'da:
 *  - avtomatik yopish: o'chiq — hech narsa; slot kelganda yopiladi
 *    (close_reason=auto, closed_by NULL, discrepancy NULL, kartalar
 *    tasdiqlanmagan); 2 replika (2 scheduler + parallel autoClose) — BIR
 *    marta; ogohlantirish slot uchun bir marta; qamrov main / main+branches;
 *    pul balanslari o'zgarmaydi;
 *  - hisobot: kuryer / market faqat o'z bo'lagi, superadmin — fayl bilan;
 *    Telegram ulanmagan — faqat tizim + «Telegram ulanmagan»; takroriy
 *    deliver — yangi outbox yo'q; resend — faqat superadmin, yangi raund.
 * Haqiqiy Telegram / SMS / push YO'Q: outbox, identity, file, notification
 * mijozlari mock. Env (`FINANCE_PG_TEST_URI`) berilmasa skip.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

type OutboxCall = [string, string, Record<string, any>, unknown?];

const rpcError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { getError?: () => unknown }).getError?.() as {
      statusCode: number;
      message: string;
    };
  }
  throw new Error('kutilgan xato chiqmadi');
};

describePg(
  'y8Tqm9Ap / gWI4gYkw — smena avto-yopish va hisobot (Postgres)',
  () => {
    const schema = `spec_shiftauto_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    let service: FinanceServiceService;
    let checks: ShiftAccountCheckService;
    let reports: ShiftReportService;
    let schedulerA: ShiftAutoCloseScheduler;
    let schedulerB: ShiftAutoCloseScheduler;
    const outbox = { enqueue: jest.fn() };
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    /** Telegram ulangan: superadmin 1, kuryer 501; kuryer 502 — ulanmagan. */
    const linked: Record<string, string> = { '1': '1001', '501': '5501' };
    let identityDown = false;
    const identity = {
      send: jest.fn((pattern: { cmd: string }, payload: any) => {
        switch (pattern.cmd) {
          case 'identity.user.active_ids_by_role':
            return identityDown
              ? throwError(() => new Error('identity down'))
              : of({ data: [{ user_id: '1', telegram_linked: true }] });
          case 'identity.telegram.resolve_many':
            return of({
              data: Object.fromEntries(
                (payload.user_ids as string[]).map((id) => [
                  id,
                  linked[id] ?? null,
                ]),
              ),
            });
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
    const file = {
      send: jest.fn((pattern: { cmd: string }, payload: any) =>
        of({
          data: {
            key: `shift-report-${randomUUID()}-${String(payload.file_name)}`,
          },
        }),
      ),
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
        file as never,
      );
      // deliverSoon — testda fon ishi yo'q (aniq `deliver` chaqiriladi).
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
        { send: jest.fn(() => of({ statusCode: 200, data: [] })) } as never,
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

    let mainCashboxId: string;
    let mainShiftId: string;

    const outboxCalls = () => outbox.enqueue.mock.calls as OutboxCall[];
    const realtimeEvents = (event: string) =>
      outboxCalls().filter(
        ([target, pattern, payload]) =>
          target === 'GATEWAY' &&
          pattern === 'realtime.notify' &&
          payload.event === event,
      );
    const dispatches = (type?: string) =>
      outboxCalls()
        .filter(
          ([target, pattern]) =>
            target === 'NOTIFICATION' && pattern === 'notification.dispatch',
        )
        .map(([, , payload]) => payload)
        .filter((payload) => !type || payload.type === type);

    const settings = (patch: Record<string, unknown>) =>
      checks.updateSettings({
        requester_id: '1',
        requester_roles: ['superadmin'],
        ...patch,
      });

    const balances = async () => ({
      cashboxes: await db.query(
        `SELECT id, balance, balance_cash, balance_card FROM "${schema}".cashboxes ORDER BY id`,
      ),
      cards: await db.query(
        `SELECT id, balance FROM "${schema}".cashbox_cards ORDER BY id`,
      ),
    });

    beforeEach(async () => {
      outbox.enqueue.mockReset();
      outbox.enqueue.mockResolvedValue(undefined);
      activityLog.log.mockClear();
      identity.send.mockClear();
      file.send.mockClear();
      for (const table of [
        'shift_report_deliveries',
        'shift_schedule_claims',
        'shift_account_checks',
        'finance_settings',
        'cashbox_history',
        'cashbox_cards',
        'shifts',
        'cashboxes',
      ]) {
        await db.query(
          `TRUNCATE TABLE "${schema}"."${table}" RESTART IDENTITY CASCADE`,
        );
      }
      const cashboxRepo = db.getRepository(Cashbox);
      const main = await cashboxRepo.save(
        cashboxRepo.create({
          user_id: '0',
          cashbox_type: Cashbox_type.MAIN,
          balance: 900_000,
          balance_cash: 600_000,
          balance_card: 300_000,
        } as Partial<Cashbox>),
      );
      mainCashboxId = String(main.id);
      await cashboxRepo.save([
        cashboxRepo.create({
          user_id: '501',
          cashbox_type: Cashbox_type.FOR_COURIER,
          balance: 50_000,
        } as Partial<Cashbox>),
        cashboxRepo.create({
          user_id: '502',
          cashbox_type: Cashbox_type.FOR_COURIER,
          balance: 0,
        } as Partial<Cashbox>),
        cashboxRepo.create({
          user_id: '601',
          cashbox_type: Cashbox_type.FOR_MARKET,
          balance: 880_000,
        } as Partial<Cashbox>),
        cashboxRepo.create({
          user_id: '602',
          cashbox_type: Cashbox_type.FOR_MARKET,
          balance: 20_000,
        } as Partial<Cashbox>),
      ]);
      const cardRepo = db.getRepository(CashboxCard);
      await cardRepo.save([
        cardRepo.create({
          cashbox_id: mainCashboxId,
          name: 'Asosiy karta',
          balance: 0,
          is_default: true,
        }),
        cardRepo.create({
          cashbox_id: mainCashboxId,
          name: 'Humo',
          balance: 100_000,
          last4: '1234',
          sort_order: 1,
        }),
      ]);
      const shift = await db.getRepository(Shift).save(
        db.getRepository(Shift).create({
          opened_by: '25',
          cashbox_user_id: '0',
          status: ShiftStatus.OPEN,
          opened_at: new Date(Date.now() - 2 * 3_600_000),
          opening_balance_cash: 600_000,
          opening_balance_card: 300_000,
        }),
      );
      mainShiftId = String(shift.id);
    });

    /** Joriy daqiqadan bir daqiqa oldingi Toshkent vaqti — slot "hozir keldi". */
    const slotJustPassed = () => tashkentClock(new Date(Date.now() - 60_000));

    describe('y8Tqm9Ap — avtomatik yopish', () => {
      it("o'chirilgan bo'lsa hech narsa yopilmaydi (vaqt kelgan bo'lsa ham)", async () => {
        await settings({
          auto_close: { enabled: false, times: [slotJustPassed()] },
        });
        const result = await schedulerA.tick();
        expect(result.locked).toBe(true);
        expect(result.enabled).toBe(false);
        expect(result.closed).toEqual([]);
        const shift = await db.getRepository(Shift).findOneByOrFail({
          id: mainShiftId,
        });
        expect(shift.status).toBe(ShiftStatus.OPEN);
        expect(realtimeEvents('finance.shift.auto_closed')).toHaveLength(0);
      });

      it('23:00 slot (Toshkent): 2 instansiya (parallel tick) — smena BIR marta yopiladi, pul o‘zgarmaydi', async () => {
        await settings({
          account_check_enabled: true,
          auto_close: { enabled: true, times: ['14:00', '23:00'] },
        });
        // Smena 25-oktabr 15:00 (Toshkent) da ochilgan; tick — 23:00:30 Toshkent
        // (= 18:00:30 UTC). 23:00 UTC (= 04:00 Toshkent) da hech narsa yopilmaydi.
        await db
          .getRepository(Shift)
          .update(
            { id: mainShiftId },
            { opened_at: new Date('2026-10-25T10:00:00Z') },
          );
        const before = await balances();
        const wrongZone = await schedulerA.tick(
          new Date('2026-10-25T23:00:30Z'),
        );
        expect(wrongZone.closed).toEqual([]);
        const now = new Date('2026-10-25T18:00:30Z');
        const [a, b] = await Promise.all([
          schedulerA.tick(now),
          schedulerB.tick(now),
        ]);
        // ikkinchi tick — qulf band yoki smena allaqachon yopilgan.
        expect([...a.closed, ...b.closed]).toEqual([mainShiftId]);
        // Takroriy tick (keyingi daqiqa, catch-up oynasi) — qayta yopmaydi.
        const again = await schedulerA.tick(new Date('2026-10-25T18:01:30Z'));
        expect(again.closed).toEqual([]);

        const shift = await db.getRepository(Shift).findOneByOrFail({
          id: mainShiftId,
        });
        expect(shift.status).toBe(ShiftStatus.CLOSED);
        expect(shift.close_reason).toBe('auto');
        expect(shift.closed_by_system).toBe(true);
        expect(shift.closed_by).toBeNull();
        expect(shift.discrepancy_cash).toBeNull();
        expect(shift.discrepancy_card).toBeNull();
        expect(shift.expected_balance_cash).toBe(600_000);
        expect(shift.closed_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
        expect(shift.report_status).toBe('pending');

        const claims = await db.getRepository(ShiftScheduleClaim).find();
        expect(claims).toHaveLength(1);
        expect(claims[0].key).toBe(
          `auto_close:${mainShiftId}:2026-10-25T23:00`,
        );

        // Kartalar: tasdiqlanmagan snapshot.
        const rows = await db.getRepository(ShiftAccountCheck).find({
          order: { cashbox_card_id: 'ASC' },
        });
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.entered_balance).toBeNull();
          expect(row.difference).toBeNull();
          expect(row.ai_status).toBe('not_required');
          expect(row.confirmed_by).toBeNull();
        }
        expect(rows.map((row) => row.expected_balance)).toEqual([
          200_000, 100_000,
        ]);

        // Realtime `finance.shift.auto_closed` — bir marta, closed_at bilan.
        const events = realtimeEvents('finance.shift.auto_closed');
        expect(events).toHaveLength(1);
        expect(events[0][2].payload).toMatchObject({
          shift_id: mainShiftId,
          close_reason: 'auto',
          closed_by: null,
        });
        expect(Date.parse(events[0][2].payload.closed_at)).not.toBeNaN();
        expect(realtimeEvents('finance.shift.closed')).toHaveLength(0);

        // Activity-log «tizim tomonidan avtomatik yopildi» — bir marta.
        const logs = activityLog.log.mock.calls
          .map(([entry]) => entry)
          .filter((entry) => entry.action === 'finance.shift_auto_closed');
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
          entity_id: mainShiftId,
          user_id: null,
        });
        expect(logs[0].metadata.description).toBe(
          'Smena tizim tomonidan avtomatik yopildi',
        );

        // Hisobot: avtomatik yopilganlik bayrog'i va banner.
        const report = (await service.getShiftReport({
          shift_id: mainShiftId,
        })) as any;
        expect(report.data.close_reason).toBe('auto');
        expect(report.data.auto_close.label).toMatch(
          /^Avtomatik yopildi — \d{2}:\d{2}, kassir yopmagan$/,
        );
        // ⚠️ PUL INVARIANTI.
        expect(await balances()).toEqual(before);
      });

      it('2 replika bir vaqtda autoCloseShift (qulfsiz) — bittasi yopadi, ikkinchisi rad', async () => {
        const slotAt = new Date(Date.now() - 60_000);
        const results = await Promise.all(
          [1, 2, 3].map(() =>
            service.autoCloseShift({
              shift_id: mainShiftId,
              slot_key: '2026-10-26T23:00',
              slot_at: slotAt,
            }),
          ),
        );
        expect(results.filter((r) => r.closed)).toHaveLength(1);
        expect(
          results
            .filter((r) => !r.closed)
            .map((r) => r.reason)
            .sort(),
        ).toEqual(['not_open', 'not_open']);
        expect(realtimeEvents('finance.shift.auto_closed')).toHaveLength(1);
      });

      it("slotdan keyin ochilgan smena yopilmaydi; qamrov: main — filial yo'q, main+branches — bor", async () => {
        const shiftRepo = db.getRepository(Shift);
        const branch = await shiftRepo.save(
          shiftRepo.create({
            opened_by: '26',
            cashbox_user_id: '3',
            status: ShiftStatus.OPEN,
            opened_at: new Date(Date.now() - 3_600_000),
          }),
        );
        await settings({
          auto_close: {
            enabled: true,
            times: [slotJustPassed()],
            scope: 'main',
          },
        });
        // MAIN smenasi slotdan KEYIN ochilgan deb belgilaymiz.
        await shiftRepo.update(
          { id: mainShiftId },
          { opened_at: new Date(Date.now() + 1_000) },
        );
        const first = await schedulerA.tick();
        expect(first.closed).toEqual([]);
        await settings({ auto_close: { scope: 'main+branches' } });
        const second = await schedulerA.tick();
        expect(second.closed).toEqual([String(branch.id)]);
        expect(
          (await shiftRepo.findOneByOrFail({ id: mainShiftId })).status,
        ).toBe(ShiftStatus.OPEN);
        // Filial smenasi hodisasi — faqat shu filial menejerlariga.
        const event = realtimeEvents('finance.shift.auto_closed')[0][2];
        expect(event.targets).toContainEqual({
          role: 'manager',
          branch_id: '3',
        });
        expect(event.targets).not.toContainEqual({ role: 'superadmin' });
      });

      it('ogohlantirish: warn_before_min oynasida ochgan xodimga BIR marta (2 tick)', async () => {
        const slot = tashkentClock(new Date(Date.now() + 10 * 60_000));
        await settings({
          auto_close: { enabled: true, times: [slot], warn_before_min: 15 },
        });
        const a = await schedulerA.tick();
        const b = await schedulerB.tick();
        expect(a.warned).toEqual([mainShiftId]);
        expect(b.warned).toEqual([]);
        expect(a.closed).toEqual([]);
        const warnings = dispatches('finance.shift_auto_close_warning');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({
          recipient_ids: ['25'],
          channels: ['in_app', 'realtime', 'telegram'],
        });
        expect(warnings[0].client_request_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(
          (await db.getRepository(Shift).findOneByOrFail({ id: mainShiftId }))
            .status,
        ).toBe(ShiftStatus.OPEN);
      });
    });

    describe('gWI4gYkw — hisobot yuborish', () => {
      const seedOperations = async () => {
        const repo = db.getRepository(CashboxHistory);
        const row = (patch: Partial<CashboxHistory>) =>
          repo.create({
            cashbox_id: mainCashboxId,
            balance_after: 0,
            payment_method: PaymentMethod.CASH,
            ...patch,
          } as Partial<CashboxHistory>);
        await repo.save([
          row({
            operation_type: Operation_type.INCOME,
            source_type: Source_type.COURIER_PAYMENT,
            source_user_id: '501',
            amount: 150_000,
          }),
          row({
            operation_type: Operation_type.INCOME,
            source_type: Source_type.COURIER_PAYMENT,
            source_user_id: '501',
            amount: 250_000,
          }),
          row({
            operation_type: Operation_type.INCOME,
            source_type: Source_type.COURIER_PAYMENT,
            source_user_id: '502',
            amount: 300_000,
          }),
          row({
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.MARKET_PAYMENT,
            source_user_id: '601',
            amount: 120_000,
          }),
          row({
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.MARKET_PAYMENT,
            source_user_id: '602',
            amount: 180_000,
            payment_method: PaymentMethod.CLICK,
          }),
        ]);
      };

      const closeManually = async () => {
        const res = (await service.closeShift({
          closed_by: '25',
          closing_balance_cash: 1_000_000,
        } as never)) as any;
        expect(res.data.close_reason).toBe('manual');
        expect(res.data.report_status).toBe('pending');
      };

      it("qo'lda yopildi → superadmin (fayl), kuryer/market faqat o'zi; Telegram ulanmagan — faqat tizim", async () => {
        await seedOperations();
        await closeManually();
        const result = await reports.deliver(mainShiftId);
        expect(result).toMatchObject({
          claimed: true,
          status: 'sent',
          round: 1,
        });
        expect(result.recipients).toBe(5);

        const sent = dispatches('finance.shift_closed');
        expect(sent).toHaveLength(5);
        const byRecipient = new Map(
          sent.map((payload) => [payload.recipient_ids[0], payload]),
        );
        // Superadmin — to'liq + fayl ilovasi.
        const sa = byRecipient.get('1');
        expect(sa.data.telegram_media).toHaveLength(1);
        expect(sa.channels).toEqual(['in_app', 'realtime', 'telegram']);
        expect(sa.body).toContain("Kuryerlar: 2 ta, 700 000 so'm");
        expect(file.send).toHaveBeenCalledTimes(1);
        expect(file.send.mock.calls[0][1]).toMatchObject({
          mime_type: 'application/pdf',
          folder: 'shift-report',
        });
        // Kuryer 501 — faqat o'z 400 000 (2 ta), boshqa kuryer summasi yo'q.
        const c1 = byRecipient.get('501');
        expect(c1.body).toContain("400 000 so'm (2 ta to'lov)");
        expect(JSON.stringify(c1)).not.toContain('300 000');
        expect(JSON.stringify(c1)).not.toContain('502');
        // Kuryer 502 — Telegram ulanmagan: faqat tizim.
        const c2 = byRecipient.get('502');
        expect(c2.channels).toEqual(['in_app', 'realtime']);
        expect(JSON.stringify(c2)).not.toContain('400 000');
        // Market 601 — faqat o'z to'lovi; guruh relay'i (matn + havola).
        const m1 = byRecipient.get('601');
        expect(m1.body).toContain("120 000 so'm — naqd");
        expect(JSON.stringify(m1)).not.toContain('180 000');
        expect(m1.telegram).toMatchObject({ market_id: '601' });
        const m2 = byRecipient.get('602');
        expect(JSON.stringify(m2)).not.toContain('120 000');

        const deliveries = await reports.listDeliveries(mainShiftId);
        const failed = deliveries.filter((row) => row.status === 'failed');
        expect(failed).toEqual([
          expect.objectContaining({
            recipient_id: '502',
            channel: 'telegram',
            failed_reason: 'Telegram ulanmagan',
          }),
        ]);
        expect(
          deliveries.filter((row) => row.channel === 'telegram_group'),
        ).toHaveLength(2);

        const shift = await db.getRepository(Shift).findOneByOrFail({
          id: mainShiftId,
        });
        expect(shift.report_status).toBe('sent');
        expect(shift.report_file_format).toBe('pdf');
      });

      it('takroriy deliver / scheduler — yangi outbox yo‘q (idempotent)', async () => {
        await seedOperations();
        await closeManually();
        await reports.deliver(mainShiftId);
        const count = dispatches().length;
        expect(await reports.deliver(mainShiftId)).toMatchObject({
          claimed: false,
        });
        expect(
          await reports.processPending(new Date(Date.now() + 3_600_000)),
        ).toBe(0);
        expect(dispatches()).toHaveLength(count);
        // Har dispatch deterministik client_request_id bilan (notification dedup).
        const ids = dispatches().map((payload) => payload.client_request_id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('outbox xatosi — hech narsa yozilmaydi, scheduler keyin qayta yuboradi', async () => {
        await seedOperations();
        await closeManually();
        outbox.enqueue.mockRejectedValueOnce(new Error('db down'));
        await expect(reports.deliver(mainShiftId)).rejects.toThrow('db down');
        expect(await db.getRepository(ShiftReportDelivery).count()).toBe(0);
        const shift = await db.getRepository(Shift).findOneByOrFail({
          id: mainShiftId,
        });
        expect(shift.report_status).toBe('pending');
        expect(
          await reports.processPending(new Date(Date.now() + 60_000)),
        ).toBe(1);
        expect(
          await db.getRepository(ShiftReportDelivery).count(),
        ).toBeGreaterThan(0);
      });

      it('avtomatik yopilgan smena — finance.shift_auto_closed turi', async () => {
        await seedOperations();
        await service.autoCloseShift({
          shift_id: mainShiftId,
          slot_key: '2026-10-26T23:00',
          slot_at: new Date(),
        });
        await reports.deliver(mainShiftId);
        expect(dispatches('finance.shift_auto_closed')).toHaveLength(5);
        expect(dispatches('finance.shift_closed')).toHaveLength(0);
        const sa = dispatches().find((p) => p.recipient_ids[0] === '1');
        expect(sa.title).toContain('avtomatik yopildi');
      });

      it('sozlama: kuryerlar o‘chiq, format xlsx — kuryerga yuborilmaydi', async () => {
        await seedOperations();
        await settings({
          report: {
            recipients: { couriers: { telegram: false, in_app: false } },
            format: 'xlsx',
          },
        });
        await closeManually();
        await reports.deliver(mainShiftId);
        const recipients = dispatches()
          .map((p) => p.recipient_ids[0])
          .sort();
        expect(recipients).toEqual(['1', '601', '602']);
        expect(file.send.mock.calls[0][1].mime_type).toBe(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
      });

      it('operatsiyasiz kuryer / market — yuborilmaydi (faqat superadmin)', async () => {
        await closeManually();
        const result = await reports.deliver(mainShiftId);
        expect(result.recipients).toBe(1);
        expect(dispatches().map((p) => p.recipient_ids[0])).toEqual(['1']);
      });

      it('resend — faqat superadmin, yangi raund; holat sinxronlanadi', async () => {
        await seedOperations();
        await closeManually();
        await reports.deliver(mainShiftId);
        const forbidden = await rpcError(
          reports.resend({
            shift_id: mainShiftId,
            requester_id: '25',
            requester_roles: ['admin'],
          }),
        );
        expect(forbidden.statusCode).toBe(403);
        const res = (await reports.resend({
          shift_id: mainShiftId,
          requester_id: '1',
          requester_roles: ['superadmin'],
        })) as any;
        expect(res.data.round).toBe(2);
        expect(dispatches('finance.shift_closed')).toHaveLength(10);
        const rounds = new Set(
          dispatches().map((payload) => payload.data.round),
        );
        expect(rounds).toEqual(new Set(['1', '2']));

        // Sinxron: notification-service holati → sent / Telegram ulanmagan.
        const rows = await db.getRepository(ShiftReportDelivery).find({
          where: { round: 2, channel: 'telegram' },
        });
        const sa = rows.find((row) => row.recipient_id === '1')!;
        const c502 = await db
          .getRepository(ShiftReportDelivery)
          .findOneByOrFail({
            round: 2,
            channel: 'in_app',
            recipient_id: '502',
          });
        const synced = (await reports.applyDeliveryStatuses({
          shift_id: mainShiftId,
          found: [
            {
              dispatch_id: sa.dispatch_id,
              recipient_id: '1',
              delivery: { in_app: 'sent', telegram: 'sent' },
            },
            {
              // boshqa qabul qiluvchi bilan aralashmaydi (dispatch:recipient).
              dispatch_id: sa.dispatch_id,
              recipient_id: '502',
              delivery: { telegram: 'failed', telegram_error: 'x' },
            },
            {
              dispatch_id: c502.dispatch_id,
              recipient_id: '502',
              delivery: { in_app: 'sent' },
            },
          ],
        })) as any;
        const list = synced.data.deliveries as Array<Record<string, unknown>>;
        expect(
          list.find(
            (row) =>
              row.round === 2 &&
              row.recipient_id === '1' &&
              row.channel === 'telegram',
          ),
        ).toMatchObject({ status: 'sent' });
        expect(
          list.find(
            (row) =>
              row.round === 2 &&
              row.recipient_id === '502' &&
              row.channel === 'in_app',
          ),
        ).toMatchObject({ status: 'sent' });
        // Ulanmagan kuryer Telegram qatori — o'zgarmaydi (allaqachon failed).
        expect(
          list.find(
            (row) =>
              row.round === 2 &&
              row.recipient_id === '502' &&
              row.channel === 'telegram',
          ),
        ).toMatchObject({
          status: 'failed',
          failed_reason: 'Telegram ulanmagan',
        });
        // 1-raund qatorlariga tegilmadi (boshqa dispatch_id).
        expect(
          list.filter((row) => row.round === 1 && row.status === 'sent'),
        ).toHaveLength(0);

        // Ochiq smena uchun resend — 400.
        const shiftRepo = db.getRepository(Shift);
        const open = await shiftRepo.save(
          shiftRepo.create({
            opened_by: '27',
            cashbox_user_id: '0',
            status: ShiftStatus.OPEN,
            opened_at: new Date(),
          }),
        );
        const bad = await rpcError(
          reports.resend({
            shift_id: String(open.id),
            requester_id: '1',
            requester_roles: ['superadmin'],
          }),
        );
        expect(bad.statusCode).toBe(400);
      });

      it('superadmin ro‘yxati olinmasa — "sent" yozilmaydi, keyin qayta', async () => {
        await closeManually();
        identityDown = true;
        try {
          await expect(reports.deliver(mainShiftId)).rejects.toThrow();
        } finally {
          identityDown = false;
        }
        const shift = await db.getRepository(Shift).findOneByOrFail({
          id: mainShiftId,
        });
        expect(shift.report_status).toBe('pending');
        expect(dispatches()).toHaveLength(0);
      });
    });
  },
);
