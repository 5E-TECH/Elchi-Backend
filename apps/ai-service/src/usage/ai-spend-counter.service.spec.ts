import type { Repository } from 'typeorm';
import { AiSpendCounter } from '../entities/ai-spend-counter.entity';
import {
  AI_SPEND_ADD_OVERRIDE_SQL,
  AI_SPEND_ADD_SQL,
  AI_SPEND_MARK_EXCEEDED_SQL,
  AI_SPEND_MARK_WARNED_SQL,
  AI_SPEND_READ_SQL,
  AiSpendCounterService,
} from './ai-spend-counter.service';

/** SQL'ni bitta qatorga (bo'shliqlar siqilgan) keltiradi. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function setup() {
  const query = jest.fn();
  const repo = { query } as unknown as Repository<AiSpendCounter>;
  return { service: new AiSpendCounterService(repo), query };
}

const PERIOD = '2026-09-27';

describe('AiSpendCounterService (lYVuADRE #9, wFSMEIIy #3/#20)', () => {
  describe('add()', () => {
    it('#9: BITTA atomik UPSERT — ON CONFLICT ... DO UPDATE SET cost_usd = ai_spend_counter.cost_usd + EXCLUDED.cost_usd', () => {
      const sql = flat(AI_SPEND_ADD_SQL);
      expect(sql).toContain('INSERT INTO ai_schema.ai_spend_counter');
      expect(sql).toMatch(
        /ON CONFLICT \(scope, period_key\) DO UPDATE SET cost_usd = ai_spend_counter\.cost_usd \+ EXCLUDED\.cost_usd/,
      );
      expect(sql).toContain(
        'cost_uzs = ai_spend_counter.cost_uzs + EXCLUDED.cost_uzs',
      );
      expect(sql).toContain('calls = ai_spend_counter.calls + 1');
      expect(sql).toContain(
        'RETURNING cost_usd::float8 AS cost_usd, override_usd::float8 AS override_usd, warned_at, exceeded_at',
      );
      // O'qish-keyin-yozish (SELECT ... UPDATE) YO'Q — bitta statement.
      expect(sql).not.toMatch(/\bSELECT\b/);
    });

    it('bitta query, parametrlar yaxlitlangan; RETURNING son bo`lib qaytadi', async () => {
      const { service, query } = setup();
      query.mockResolvedValue([
        {
          cost_usd: '1.2345',
          override_usd: '0',
          warned_at: null,
          exceeded_at: null,
        },
      ]);
      const res = await service.add(PERIOD, 0.12345678, 1580.234);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(AI_SPEND_ADD_SQL, [
        PERIOD,
        0.123457,
        1580.23,
      ]);
      expect(res).toEqual({
        cost_usd: 1.2345,
        override_usd: 0,
        warned_at: null,
        exceeded_at: null,
      });
      expect(typeof res.cost_usd).toBe('number');
    });

    it('yaroqsiz period_key → throw, SQL ketmaydi', async () => {
      const { service, query } = setup();
      await expect(service.add('2026-13-01', 1, 1)).rejects.toThrow(
        /period_key/,
      );
      expect(query).not.toHaveBeenCalled();
    });

    it('DB xatosi yutilmaydi (yuqoriga chiqadi)', async () => {
      const { service, query } = setup();
      query.mockRejectedValue(new Error('db down'));
      await expect(service.add(PERIOD, 1, 1)).rejects.toThrow('db down');
    });
  });

  describe('read()', () => {
    it('wFSMEIIy #20: kunlik jami BITTA PK lookup bilan o`qiladi (jadval skanerlanmaydi)', async () => {
      const { service, query } = setup();
      query.mockResolvedValue([
        {
          period_key: PERIOD,
          cost_usd: '12.5',
          cost_uzs: '160000.00',
          calls: 7,
          override_usd: '5.00',
          warned_at: null,
          exceeded_at: null,
        },
      ]);
      const row = await service.read(PERIOD);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(AI_SPEND_READ_SQL, [PERIOD]);
      const sql = flat(AI_SPEND_READ_SQL);
      expect(sql).toContain("WHERE scope = 'global' AND period_key = $1::date");
      expect(sql).not.toMatch(/\bSUM\(|ai_usage_log|GROUP BY/);
      expect(row).toEqual({
        period_key: PERIOD,
        cost_usd: 12.5,
        cost_uzs: 160000,
        calls: 7,
        override_usd: 5,
        warned_at: null,
        exceeded_at: null,
      });
    });

    it('qator yo`q → null (bugun hali xarajat yo`q)', async () => {
      const { service, query } = setup();
      query.mockResolvedValue([]);
      await expect(service.read(PERIOD)).resolves.toBeNull();
    });
  });

  describe('markWarned() / markExceeded()', () => {
    it('WHERE ... IS NULL RETURNING 1 — faqat birinchi chaqiruv g`olib', async () => {
      const { service, query } = setup();
      // TypeORM postgres UPDATE natijasi: [rows, rowCount].
      query
        .mockResolvedValueOnce([[{ won: 1 }], 1])
        .mockResolvedValueOnce([[], 0]);
      await expect(service.markWarned(PERIOD)).resolves.toBe(true);
      await expect(service.markWarned(PERIOD)).resolves.toBe(false);
      expect(flat(AI_SPEND_MARK_WARNED_SQL)).toContain(
        'SET warned_at = now(), "updatedAt" = now() WHERE scope = \'global\' AND period_key = $1::date AND warned_at IS NULL RETURNING 1',
      );
    });

    it('markExceeded — exceeded_at IS NULL sharti', async () => {
      const { service, query } = setup();
      query
        .mockResolvedValueOnce([[{ won: 1 }], 1])
        .mockResolvedValueOnce([[], 0]);
      await expect(service.markExceeded(PERIOD)).resolves.toBe(true);
      await expect(service.markExceeded(PERIOD)).resolves.toBe(false);
      expect(query).toHaveBeenCalledWith(AI_SPEND_MARK_EXCEEDED_SQL, [PERIOD]);
      expect(flat(AI_SPEND_MARK_EXCEEDED_SQL)).toContain(
        'AND exceeded_at IS NULL RETURNING 1',
      );
    });
  });

  describe('addOverride()', () => {
    it('atomik override_usd += extra, RETURNING', async () => {
      const { service, query } = setup();
      query.mockResolvedValue([
        {
          cost_usd: '51',
          override_usd: '20.00',
          warned_at: new Date('2026-09-27T05:00:00Z'),
          exceeded_at: null,
        },
      ]);
      const res = await service.addOverride(PERIOD, 20.004);
      expect(query).toHaveBeenCalledWith(AI_SPEND_ADD_OVERRIDE_SQL, [
        PERIOD,
        20,
      ]);
      expect(flat(AI_SPEND_ADD_OVERRIDE_SQL)).toContain(
        'override_usd = ai_spend_counter.override_usd + EXCLUDED.override_usd',
      );
      expect(res.override_usd).toBe(20);
      expect(res.cost_usd).toBe(51);
      expect(res.warned_at).toBeInstanceOf(Date);
    });
  });
});
