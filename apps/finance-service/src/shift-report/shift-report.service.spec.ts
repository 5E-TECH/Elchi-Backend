import { Shift } from '../entities/shift.entity';
import {
  AUTO_CLOSE_DEFAULTS,
  REPORT_DEFAULTS,
  type ReportSettings,
} from '../shift-auto-close/shift-schedule.rules';
import { ShiftReportService } from './shift-report.service';

/**
 * gWI4gYkw (reliz-9 review) — `deliver` sozlamani snapshot'dan OLDIN
 * tekshiradi: hisobot o'chiq (sukut) bo'lsa snapshot / fayl QURILMAYDI va
 * smena darhol `skipped` — qurish xatosi qatorni `pending` ga qaytarib har
 * daqiqa qayta urinmaydi. Haqiqiy Postgres sinovi:
 * shift-auto-close-report.y8Tqm9Ap.pg.spec.ts.
 */

/** TypeORM query builder zanjiri — har metod o'zini qaytaradi. */
type FakeQb = Record<
  'update' | 'set' | 'where' | 'andWhere' | 'returning' | 'execute',
  jest.Mock
>;

const makeQb = (): FakeQb => {
  const qb = {} as FakeQb;
  for (const name of ['update', 'set', 'where', 'andWhere', 'returning']) {
    qb[name as keyof FakeQb] = jest.fn(() => qb);
  }
  qb.execute = jest.fn().mockResolvedValue({ raw: [{ report_round: 1 }] });
  return qb;
};

const setup = (report: ReportSettings) => {
  const builders: FakeQb[] = [];
  const manager = {
    createQueryBuilder: jest.fn(() => {
      const qb = makeQb();
      builders.push(qb);
      return qb;
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn().mockResolvedValue({ id: '9', status: 'closed' }),
  };
  const checks = {
    loadAutomationSettings: jest
      .fn()
      .mockResolvedValue({ auto_close: AUTO_CLOSE_DEFAULTS, report }),
  };
  const identity = { send: jest.fn() };
  const file = { send: jest.fn() };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new ShiftReportService(
    { manager, transaction: jest.fn() } as never,
    activityLog as never,
    checks as never,
    {} as never,
    identity as never,
    file as never,
  );
  // Snapshot qurish (kassa tarixi so'rovlari) yiqiladi — o'chiq hisobotda
  // bu yo'lga umuman kirilmasligi kerak.
  const buildSnapshot = jest
    .spyOn(
      service as unknown as { buildSnapshot: () => Promise<unknown> },
      'buildSnapshot',
    )
    .mockRejectedValue(new Error('snapshot qurilmadi'));
  /** `report_status` ni qayta `pending` ga qaytargan (release) chaqiruvlar. */
  const releasedToPending = () =>
    builders.filter((qb) =>
      qb.set.mock.calls.some(
        ([patch]) =>
          (patch as { report_status?: string })?.report_status === 'pending',
      ),
    ).length;
  return {
    service,
    manager,
    identity,
    file,
    activityLog,
    buildSnapshot,
    releasedToPending,
  };
};

describe('ShiftReportService.deliver — sozlama snapshot’dan OLDIN (gWI4gYkw)', () => {
  it("hisobot o'chiq (sukut): snapshot qurilmaydi, darhol skipped — qurish xatosi pending'ga qaytarmaydi", async () => {
    const fx = setup(REPORT_DEFAULTS);
    const result = await fx.service.deliver('9');
    expect(result).toEqual({
      claimed: true,
      shift_id: '9',
      round: 1,
      status: 'skipped',
      recipients: 0,
    });
    expect(fx.buildSnapshot).not.toHaveBeenCalled();
    expect(fx.manager.findOne).not.toHaveBeenCalled();
    expect(fx.manager.update).toHaveBeenCalledWith(
      Shift,
      { id: '9' },
      { report_status: 'skipped' },
    );
    expect(fx.releasedToPending()).toBe(0);
    expect(fx.identity.send).not.toHaveBeenCalled();
    expect(fx.file.send).not.toHaveBeenCalled();
    expect(fx.activityLog.log).not.toHaveBeenCalled();
  });

  it("scheduler: o'chiq hisobotli qolib ketgan smena bir marta skipped bo'ladi (har daqiqa qayta urinilmaydi)", async () => {
    const fx = setup(REPORT_DEFAULTS);
    // processPending ro'yxati: bitta `pending` smena.
    const listQb = {
      select: jest.fn(() => listQb),
      where: jest.fn(() => listQb),
      andWhere: jest.fn(() => listQb),
      orderBy: jest.fn(() => listQb),
      limit: jest.fn(() => listQb),
      getRawMany: jest.fn().mockResolvedValue([{ id: '9' }]),
    };
    fx.manager.createQueryBuilder.mockImplementationOnce(() => listQb as never);
    await expect(fx.service.processPending()).resolves.toBe(1);
    expect(fx.buildSnapshot).not.toHaveBeenCalled();
    expect(fx.releasedToPending()).toBe(0);
    expect(fx.manager.update).toHaveBeenCalledWith(
      Shift,
      { id: '9' },
      { report_status: 'skipped' },
    );
  });

  it('hisobot yoqilgan: oqim o‘zgarmagan — snapshot quriladi, xatoda da’vo pending’ga qaytadi', async () => {
    const fx = setup({
      ...REPORT_DEFAULTS,
      recipients: {
        ...REPORT_DEFAULTS.recipients,
        superadmin: { telegram: false, in_app: true },
      },
    });
    await expect(fx.service.deliver('9')).rejects.toThrow('snapshot qurilmadi');
    expect(fx.manager.findOne).toHaveBeenCalledTimes(1);
    expect(fx.buildSnapshot).toHaveBeenCalledTimes(1);
    expect(fx.releasedToPending()).toBe(1);
    expect(fx.manager.update).not.toHaveBeenCalled();
  });

  it('faqat bitta guruhning bitta kanali (market Telegram) yoqilgan bo‘lsa ham snapshot quriladi', async () => {
    const fx = setup({
      ...REPORT_DEFAULTS,
      recipients: {
        ...REPORT_DEFAULTS.recipients,
        markets: { telegram: true, in_app: false },
      },
    });
    await expect(fx.service.deliver('9')).rejects.toThrow('snapshot qurilmadi');
    expect(fx.buildSnapshot).toHaveBeenCalledTimes(1);
  });
});
