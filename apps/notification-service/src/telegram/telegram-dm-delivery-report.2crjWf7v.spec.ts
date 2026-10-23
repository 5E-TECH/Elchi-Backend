import { RpcException } from '@nestjs/microservices';
import type { Repository } from 'typeorm';
import type { Notification } from '../entities/notification.entity';
import {
  buildDmDeliveryReport,
  type DmDeliveryRow,
  TelegramDmDeliveryReportService,
} from './telegram-dm-delivery-report.service';

/**
 * (2crjWf7v) «Yozildi ≠ yetadi» — kvitansiya yetkazish hisoboti
 * (`notification.telegram.dm_delivery`): holatlar guruhlanishi, nisbatlar,
 * davr (Toshkent kunlari) va kirish validatsiyasi. Haqiqiy SQL —
 * `telegram-dm-delivery-report.2crjWf7v.pg.spec.ts`.
 */
describe('2crjWf7v — DM yetkazish hisoboti', () => {
  const FROM = new Date('2026-10-20T19:00:00.000Z');
  const TO = new Date('2026-10-22T19:00:00.000Z');
  const meta = {
    type: 'finance.payment_received' as const,
    from: FROM,
    to: TO,
  };

  const row = (
    day: string,
    role: string | null,
    status: string | null,
    count: number | string,
    reason: string | null = null,
  ): DmDeliveryRow => ({ day, role, status, reason, count });

  describe('buildDmDeliveryReport', () => {
    const rows: DmDeliveryRow[] = [
      row('2026-10-21', 'courier', 'sent', 6),
      row('2026-10-21', 'courier', 'failed', 1),
      row('2026-10-21', 'courier', 'skipped', 2, 'no_telegram_id'),
      row('2026-10-22', 'courier', 'sent', '3'), // pg COUNT matn bo'lsa ham
      row('2026-10-22', 'courier', 'sending', 1),
      row('2026-10-22', 'market', 'sent', 2),
      row('2026-10-22', 'market', 'queued', 1),
      row('2026-10-22', 'market', 'skipped', 1, 'bot_blocked'),
      row('2026-10-22', 'market', 'skipped', 1, null),
      row('2026-10-22', null, 'no_provider', 1),
      row('2026-10-22', 'market', 'not_eligible', 1),
      row('2026-10-22', 'market', 'sent', 0),
    ];
    const report = buildDmDeliveryReport(rows, meta);

    it('jami: holatlar guruhlarga (pending = queued|sending|pending), hech narsa yo‘qolmaydi', () => {
      expect(report.totals).toEqual({
        total: 20,
        sent: 11,
        failed: 1,
        pending: 2,
        skipped: 4,
        no_provider: 1,
        other: 1,
        // 11 / (11 + 1 + 2)
        delivery_ratio: 0.786,
        // 11 / 20 — ulanmaganlar ham maxrajda («yozildi ≠ yetadi»)
        reach_ratio: 0.55,
      });
    });

    it('skipped sabablari: sababsiz — `unknown`', () => {
      expect(report.skipped_reasons).toEqual({
        no_telegram_id: 2,
        bot_blocked: 1,
        unknown: 1,
      });
    });

    it('rol bo‘yicha (alifbo), rolsiz — `unknown`; har birida o‘z nisbatlari', () => {
      expect(report.by_role.map((r) => r.role)).toEqual([
        'courier',
        'market',
        'unknown',
      ]);
      expect(report.by_role[0]).toMatchObject({
        role: 'courier',
        total: 13,
        sent: 9,
        failed: 1,
        pending: 1,
        skipped: 2,
        delivery_ratio: 0.818, // 9 / 11
        reach_ratio: 0.692, // 9 / 13
      });
      expect(report.by_role[2]).toMatchObject({
        role: 'unknown',
        total: 1,
        no_provider: 1,
        delivery_ratio: null, // maxraj 0
        reach_ratio: 0,
      });
    });

    it('kunlar o‘sish tartibida', () => {
      expect(report.days.map((d) => [d.day, d.total, d.sent])).toEqual([
        ['2026-10-21', 9, 6],
        ['2026-10-22', 11, 5],
      ]);
    });

    it('davr va tur javobda', () => {
      expect(report).toMatchObject({
        type: 'finance.payment_received',
        from: '2026-10-20T19:00:00.000Z',
        to: '2026-10-22T19:00:00.000Z',
      });
    });

    it("ma'lumot yo'q — nollar, nisbatlar null (0% deb ko'rsatilmaydi)", () => {
      const empty = buildDmDeliveryReport([], meta);
      expect(empty.totals).toEqual({
        total: 0,
        sent: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
        no_provider: 0,
        other: 0,
        delivery_ratio: null,
        reach_ratio: null,
      });
      expect(empty.by_role).toEqual([]);
      expect(empty.days).toEqual([]);
      expect(empty.skipped_reasons).toEqual({});
    });
  });

  describe('TelegramDmDeliveryReportService.report', () => {
    const make = (rows: unknown = []) => {
      const query = jest.fn().mockResolvedValue(rows);
      const service = new TelegramDmDeliveryReportService({
        query,
      } as unknown as Repository<Notification>);
      return { service, query };
    };

    const rpcStatus = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        expect(error).toBeInstanceOf(RpcException);
        return (error as RpcException).getError() as { statusCode: number };
      }
      throw new Error('RpcException kutilgan edi');
    };

    it("sukut: kvitansiya turi, oxirgi 30 kun; faqat O'QISH (SELECT)", async () => {
      const { service, query } = make([
        row('2026-10-22', 'courier', 'sent', 1),
      ]);
      const res = await service.report({});

      expect(res.statusCode).toBe(200);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql.trim()).toMatch(/^SELECT/);
      expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
      expect(sql).toContain(`"delivery" ? 'telegram'`);
      expect(params[0]).toBe('finance.payment_received');
      const [from, to] = params.slice(1) as Date[];
      expect(to.getTime() - from.getTime()).toBeGreaterThanOrEqual(
        30 * 24 * 60 * 60 * 1000,
      );
      expect((res.data as { totals: { sent: number } }).totals.sent).toBe(1);
    });

    it('faqat sana — Toshkent kuni chegaralari (to — shu kun oxirigacha)', async () => {
      const { service, query } = make();
      await service.report({
        from: '2026-10-01',
        to: '2026-10-23',
        type: 'finance.cash_reminder',
      });
      const [, params] = query.mock.calls[0] as [string, unknown[]];
      expect(params[0]).toBe('finance.cash_reminder');
      expect((params[1] as Date).toISOString()).toBe(
        '2026-09-30T19:00:00.000Z',
      );
      expect((params[2] as Date).toISOString()).toBe(
        '2026-10-23T19:00:00.000Z',
      );
    });

    it.each(['order.sold', 'finance.balance_topup', 'x'])(
      'ruxsat etilmagan tur (%s) → 400, SQL yo‘q',
      async (type) => {
        const { service, query } = make();
        expect((await rpcStatus(service.report({ type }))).statusCode).toBe(
          400,
        );
        expect(query).not.toHaveBeenCalled();
      },
    );

    it('from >= to yoki buzuq sana → 400', async () => {
      const { service, query } = make();
      expect(
        (
          await rpcStatus(
            service.report({ from: '2026-10-23', to: '2026-10-01' }),
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (await rpcStatus(service.report({ from: 'kecha' }))).statusCode,
      ).toBe(400);
      expect(query).not.toHaveBeenCalled();
    });
  });
});
