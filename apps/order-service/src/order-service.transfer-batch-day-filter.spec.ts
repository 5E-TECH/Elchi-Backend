import { RpcException } from '@nestjs/microservices';
import { BranchTransferBatchService } from './transfer-batch/branch-transfer-batch.service';

/**
 * SqVMuhKo. GET /transfer-batches `date` va `period` filtrlari — Toshkent kuni.
 * Ilgari `date` server TZ'idagi setHours bilan UTC kuni edi, `period` esa
 * qo'lda +5/-5 soat va mahalliy setHours/getDay bilan hisoblanardi (faqat
 * konteyner UTC'da bo'lganda to'g'ri).
 */
describe('BranchTransferBatchService transfer batch day filter (SqVMuhKo)', () => {
  function setup() {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    const transferBatchRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    const transferBatchItemRepo = {
      find: jest.fn().mockResolvedValue([]),
    };

    // BranchTransferBatchService(dataSource, transferBatchRepo,
    // transferBatchItemRepo, transferBatchHistoryRepo, orderRepo,
    // orderTrackingRepo, orderCustodyEventRepo, activityLog, custody).
    const service = new BranchTransferBatchService(
      {} as any, // dataSource
      transferBatchRepo as any, // transferBatchRepo
      transferBatchItemRepo as any, // transferBatchItemRepo
      {} as any, // transferBatchHistoryRepo
      {} as any, // orderRepo
      {} as any, // orderTrackingRepo
      {} as any, // orderCustodyEventRepo
      {} as any, // activityLog
      {} as any, // custody
    );

    return { service, qb };
  }

  const createdAtCalls = (qb: { andWhere: jest.Mock }) =>
    qb.andWhere.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('batch.createdAt'),
    );

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('date', () => {
    it.each([
      // Oddiy sana — Toshkent kunining 00:00 .. 23:59:59.999 i.
      ['2026-10-01', '2026-09-30T19:00:00.000Z', '2026-10-01T18:59:59.999Z'],
      // Toshkentda 1-oktabr 01:00, UTC bo'yicha hali 30-sentabr.
      [
        '2026-10-01T01:00:00+05:00',
        '2026-09-30T19:00:00.000Z',
        '2026-10-01T18:59:59.999Z',
      ],
      // Yil chegarasi.
      ['2027-01-01', '2026-12-31T19:00:00.000Z', '2027-01-01T18:59:59.999Z'],
    ])('%s → Toshkent kuni', async (date, dayStart, dayEnd) => {
      const { service, qb } = setup();

      await service.findBranchTransferBatches({ date });

      expect(createdAtCalls(qb)).toEqual([
        [
          'batch.createdAt BETWEEN :dayStart AND :dayEnd',
          { dayStart: new Date(dayStart), dayEnd: new Date(dayEnd) },
        ],
      ]);
    });

    it('yaroqsiz sana — avvalgidek 400', async () => {
      const { service, qb } = setup();

      const error: unknown = await service
        .findBranchTransferBatches({ date: 'bad' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RpcException);
      expect((error as RpcException).getError()).toEqual({
        statusCode: 400,
        message: 'date is invalid date format',
      });
      expect(qb.getManyAndCount).not.toHaveBeenCalled();
    });

    it('date va period birga kelsa — date ustun', async () => {
      const { service, qb } = setup();

      await service.findBranchTransferBatches({
        date: '2026-10-01',
        period: 'month',
      });

      expect(createdAtCalls(qb)).toEqual([
        [
          'batch.createdAt BETWEEN :dayStart AND :dayEnd',
          {
            dayStart: new Date('2026-09-30T19:00:00.000Z'),
            dayEnd: new Date('2026-10-01T18:59:59.999Z'),
          },
        ],
      ]);
    });
  });

  describe('period', () => {
    it.each([
      // Toshkentda 2-oktabr 01:30 — "bugun" allaqachon 2-oktabr.
      [
        'today',
        '2026-10-01T20:30:00.000Z',
        '2026-10-01T19:00:00.000Z',
        '2026-10-02T18:59:59.999Z',
      ],
      // Payshanba — hafta dushanba 28-sentabrdan.
      [
        'week',
        '2026-10-01T10:00:00.000Z',
        '2026-09-27T19:00:00.000Z',
        '2026-10-01T18:59:59.999Z',
      ],
      // Toshkentda dushanba 01:00, UTC bo'yicha hali yakshanba.
      [
        'week',
        '2026-10-04T20:00:00.000Z',
        '2026-10-04T19:00:00.000Z',
        '2026-10-05T18:59:59.999Z',
      ],
      // Toshkentda 1-noyabr 00:30 — oy noyabr, oxiri 30-noyabr.
      [
        'month',
        '2026-10-31T19:30:00.000Z',
        '2026-10-31T19:00:00.000Z',
        '2026-11-30T18:59:59.999Z',
      ],
      // Toshkentda 2027-yil 1-yanvar 00:30 — yil chegarasi.
      [
        'month',
        '2026-12-31T19:30:00.000Z',
        '2026-12-31T19:00:00.000Z',
        '2027-01-31T18:59:59.999Z',
      ],
    ])(
      '%s (hozir %s) → Toshkent chegaralari',
      async (period, now, periodStart, periodEnd) => {
        jest.useFakeTimers().setSystemTime(new Date(now));
        const { service, qb } = setup();

        await service.findBranchTransferBatches({ period });

        expect(createdAtCalls(qb)).toEqual([
          [
            'batch.createdAt BETWEEN :periodStart AND :periodEnd',
            {
              periodStart: new Date(periodStart),
              periodEnd: new Date(periodEnd),
            },
          ],
        ]);
      },
    );

    it("noma'lum period — avvalgidek 400", async () => {
      const { service, qb } = setup();

      const error: unknown = await service
        .findBranchTransferBatches({ period: 'year' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RpcException);
      expect((error as RpcException).getError()).toEqual({
        statusCode: 400,
        message: 'period must be one of: today, week, month',
      });
      expect(qb.getManyAndCount).not.toHaveBeenCalled();
    });

    /**
     * `period` eski kodda ham UTC konteynerda to'g'ri edi — natija o'zgarmasligi
     * shart. Oracle: eski kod, UTC konteynerdagidek (mahalliy vaqt = UTC)
     * ko'chirilgan.
     */
    it('natija eski kodning UTC konteynerdagi natijasi bilan aynan bir xil', async () => {
      const HOUR_MS = 60 * 60 * 1000;
      const UZ_OFFSET_MS = 5 * HOUR_MS;
      const legacyInUtcContainer = (period: string, nowMs: number) => {
        const uzNow = new Date(nowMs + UZ_OFFSET_MS);
        const periodStartUz = new Date(uzNow);
        periodStartUz.setUTCHours(0, 0, 0, 0);
        let periodEndUz = new Date(uzNow);
        periodEndUz.setUTCHours(23, 59, 59, 999);
        if (period === 'week') {
          const day = periodStartUz.getUTCDay();
          const diffToMonday = day === 0 ? 6 : day - 1;
          periodStartUz.setUTCDate(periodStartUz.getUTCDate() - diffToMonday);
        }
        if (period === 'month') {
          periodStartUz.setUTCDate(1);
          periodEndUz = new Date(
            Date.UTC(
              periodStartUz.getUTCFullYear(),
              periodStartUz.getUTCMonth() + 1,
              0,
              23,
              59,
              59,
              999,
            ),
          );
        }
        return {
          periodStart: new Date(periodStartUz.getTime() - UZ_OFFSET_MS),
          periodEnd: new Date(periodEndUz.getTime() - UZ_OFFSET_MS),
        };
      };

      // Har 30 daqiqada — Toshkent yarim tuni (19:00Z) ham tushadi. Oynalar:
      // ishga tushirish kuni + oy chegarasi, yil chegarasi, kabisa fevrali.
      const windows: Array<[string, string]> = [
        ['2026-09-26T00:00:00.000Z', '2026-10-06T00:00:00.000Z'],
        ['2026-12-27T00:00:00.000Z', '2027-01-04T00:00:00.000Z'],
        ['2028-02-26T00:00:00.000Z', '2028-03-02T00:00:00.000Z'],
      ];
      const mismatches: string[] = [];
      for (const [from, to] of windows) {
        for (
          let nowMs = new Date(from).getTime();
          nowMs <= new Date(to).getTime();
          nowMs += HOUR_MS / 2
        ) {
          for (const period of ['today', 'week', 'month']) {
            jest.useFakeTimers().setSystemTime(nowMs);
            const { service, qb } = setup();
            await service.findBranchTransferBatches({ period });
            const [, actual] = createdAtCalls(qb)[0] as [
              string,
              { periodStart: Date; periodEnd: Date },
            ];
            const expected = legacyInUtcContainer(period, nowMs);
            if (
              actual.periodStart.getTime() !== expected.periodStart.getTime() ||
              actual.periodEnd.getTime() !== expected.periodEnd.getTime()
            ) {
              mismatches.push(
                `${period} @ ${new Date(nowMs).toISOString()}: ${actual.periodStart.toISOString()}..${actual.periodEnd.toISOString()} != ${expected.periodStart.toISOString()}..${expected.periodEnd.toISOString()}`,
              );
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  it("sana filtrisiz (barcha vaqt) — createdAt sharti yo'q, avvalgidek", async () => {
    const { service, qb } = setup();

    await service.findBranchTransferBatches({});

    expect(createdAtCalls(qb)).toEqual([]);
    expect(qb.getManyAndCount).toHaveBeenCalled();
  });
});
