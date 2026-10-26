import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import {
  addDays,
  dayEnd,
  dayKeysBetween,
  dayStart,
  daysBetween,
  parseDayKey,
  tashkentDayKey,
} from './finance-day.util';
import { FinanceDailySnapshotService } from './finance-daily-snapshot.service';
import { FinanceDailyService } from './finance-daily.service';

/**
 * qzjTMWPb — Postgres'siz qism: Toshkent kun chegaralari, oraliq tekshiruvi
 * va snapshot job'ining yurish qoidalari (bugun yozilmaydi, jonli qarz faqat
 * kecha uchun va 6 soat ichida, o'chirish env'i, bir vaqtda bitta tick).
 * SQL'ning o'zi — finance-daily.qzjTMWPb.pg.spec.ts (haqiqiy Postgres).
 */
describe('qzjTMWPb — Toshkent kun yordamchilari', () => {
  it('kun kaliti Toshkent bo‘yicha: 19:00Z = ertasi kun 00:00', () => {
    expect(tashkentDayKey(new Date('2026-09-30T18:59:59.999Z'))).toBe(
      '2026-09-30',
    );
    expect(tashkentDayKey(new Date('2026-09-30T19:00:00.000Z'))).toBe(
      '2026-10-01',
    );
  });

  it('kun chegaralari: 00:00:00.000 — 23:59:59.999 (UTC+5)', () => {
    expect(dayStart('2026-10-01').toISOString()).toBe(
      '2026-09-30T19:00:00.000Z',
    );
    expect(dayEnd('2026-10-01').toISOString()).toBe('2026-10-01T18:59:59.999Z');
  });

  it('parseDayKey — faqat haqiqiy YYYY-MM-DD', () => {
    expect(parseDayKey('2026-10-01')).toBe('2026-10-01');
    expect(parseDayKey(' 2026-10-01 ')).toBe('2026-10-01');
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-1-5',
      '2026-10-01T00:00:00Z',
      '',
      5,
      null,
    ]) {
      expect(parseDayKey(bad)).toBeNull();
    }
  });

  it('kunlar ro‘yxati va farqi (oy/yil chegarasi)', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(dayKeysBetween('2026-09-29', '2026-10-02')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    expect(daysBetween('2026-10-01', '2026-10-15')).toBe(14);
  });
});

describe('qzjTMWPb — FinanceDailyService.resolveRange', () => {
  const service = new FinanceDailyService({} as never);
  const now = new Date('2026-10-26T07:00:00Z'); // 12:00 Toshkent

  it('sukut — oxirgi 14 kun bugun bilan', () => {
    expect(service.resolveRange({}, now)).toEqual({
      from: '2026-10-13',
      to: '2026-10-26',
      today: '2026-10-26',
    });
  });

  it('noto‘g‘ri sana, teskari oraliq, 366 kundan ortiq — 400', () => {
    expect(() => service.resolveRange({ from_date: 'x' }, now)).toThrow(
      BadRequestException,
    );
    expect(() =>
      service.resolveRange(
        { from_date: '2026-10-05', to_date: '2026-10-01' },
        now,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      service.resolveRange(
        { from_date: '2025-10-01', to_date: '2026-10-02' },
        now,
      ),
    ).toThrow(BadRequestException);
    expect(
      service.resolveRange(
        { from_date: '2025-10-02', to_date: '2026-10-02' },
        now,
      ).from,
    ).toBe('2025-10-02');
  });
});

describe('qzjTMWPb — FinanceDailySnapshotService yurish qoidalari', () => {
  const build = (env: Record<string, unknown> = {}) => {
    const order = {
      send: jest.fn(() => of({ data: { chain_receivable: 10 } })),
    };
    const integration = {
      send: jest.fn(() => of({ data: { outstanding_amount: 5 } })),
    };
    const service = new FinanceDailySnapshotService(
      {} as never,
      { get: (key: string) => env[key] } as never,
      order as never,
      integration as never,
    );
    const days: Array<[string, unknown]> = [];
    jest
      .spyOn(service, 'snapshotDay')
      .mockImplementation((day: string, live: unknown) => {
        days.push([day, live]);
        return Promise.resolve('done');
      });
    return { service, days, order, integration };
  };

  afterEach(() => jest.useRealTimers());

  it('oxirgi snapshot’dan KECHAGACHA; bugun yozilmaydi; jonli qarz faqat kechaga', async () => {
    const { service, days } = build();
    jest.spyOn(service, 'lastSnapshotDate').mockResolvedValue('2026-10-23');
    const run = await service.catchUp(new Date('2026-10-25T19:30:00Z')); // 26.10 00:30
    expect(run.processed).toEqual(['2026-10-24', '2026-10-25']);
    expect(days).toEqual([
      ['2026-10-24', null],
      ['2026-10-25', { chain_receivable: 10, provider_receivable: 5 }],
    ]);
  });

  it('kun tugaganiga 6 soatdan ko‘p bo‘lsa — jonli qarz olinmaydi (backfill)', async () => {
    const { service, days, order } = build();
    jest.spyOn(service, 'lastSnapshotDate').mockResolvedValue('2026-10-24');
    await service.catchUp(new Date('2026-10-26T05:00:00Z')); // 26.10 10:00
    expect(days).toEqual([['2026-10-25', null]]);
    expect(order.send).not.toHaveBeenCalled();
  });

  it('jadval bo‘sh — tarixning birinchi kunidan; tarix yo‘q — hech narsa', async () => {
    const { service, days } = build();
    jest.spyOn(service, 'lastSnapshotDate').mockResolvedValue(null);
    const first = jest
      .spyOn(service, 'firstActivityDay')
      .mockResolvedValue('2026-10-23');
    await service.catchUp(new Date('2026-10-26T05:00:00Z'));
    expect(days.map(([day]) => day)).toEqual([
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
    first.mockResolvedValue(null);
    days.length = 0;
    expect(
      (await service.catchUp(new Date('2026-10-26T05:00:00Z'))).processed,
    ).toEqual([]);
    expect(days).toEqual([]);
  });

  it('qulf band (boshqa replika) — shu yugurish to‘xtaydi', async () => {
    const { service } = build();
    jest.spyOn(service, 'lastSnapshotDate').mockResolvedValue('2026-10-20');
    (service.snapshotDay as jest.Mock)
      .mockResolvedValueOnce('done')
      .mockResolvedValueOnce('locked');
    const run = await service.catchUp(new Date('2026-10-26T05:00:00Z'));
    expect(run).toEqual({
      processed: ['2026-10-21'],
      skipped: [],
      stopped: 'locked',
    });
  });

  it('tick: bir vaqtda bitta yugurish; xato yutiladi (servis yiqilmaydi)', async () => {
    const { service } = build();
    let release: () => void = () => undefined;
    jest.spyOn(service, 'catchUp').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ processed: [], skipped: [], stopped: null });
        }),
    );
    const first = service.tick();
    expect(await service.tick()).toBeNull();
    release();
    await first;
    (service.catchUp as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    expect(await service.tick()).toBeNull();
  });

  it('FINANCE_DAILY_SNAPSHOT_DISABLED=true — taymer qo‘yilmaydi', () => {
    jest.useFakeTimers();
    const { service } = build({ FINANCE_DAILY_SNAPSHOT_DISABLED: true });
    const tick = jest.spyOn(service, 'tick');
    service.onModuleInit();
    jest.advanceTimersByTime(60 * 60_000);
    expect(tick).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });
});
