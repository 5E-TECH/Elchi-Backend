import { OrderServiceService } from './order-service.service';

/**
 * `order.external.import_stats` — saytdan olingan buyurtmalar soni buyurtmalarning
 * o'zidan (2026-11-25: 49 ta buyurtma olingan sayt «0 ta» ko'rinardi).
 */
type Row = Record<string, any>;

function svc(rows: Row[]) {
  const calls: Array<[string, Row | undefined]> = [];
  const qb: Row = {};
  for (const name of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) {
    qb[name] = jest.fn((sql: string, params?: Row) => {
      calls.push([sql, params]);
      return qb;
    });
  }
  qb.setParameter = jest.fn(() => qb);
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  const createQueryBuilder = jest.fn(() => qb);
  const s = Object.create(OrderServiceService.prototype) as Row;
  s.orderRepo = { createQueryBuilder };
  return { s, calls, createQueryBuilder };
}

describe('findExternalImportStats', () => {
  it('⭐ slug bo`yicha son, bugungisi va oxirgisi', async () => {
    const { s, calls } = svc([
      {
        operator: 'external_lidershop',
        total: '49',
        today: '1',
        last_at: new Date('2026-11-24T18:57:57Z'),
      },
    ]);
    await expect(
      s.findExternalImportStats(['lidershop', 'alion']),
    ).resolves.toEqual([
      {
        slug: 'lidershop',
        total: 49,
        today: 1,
        last_at: '2026-11-24T18:57:57.000Z',
      },
    ]);
    expect(calls).toContainEqual([
      'order.operator IN (:...operators)',
      { operators: ['external_lidershop', 'external_alion'] },
    ]);
    // O'chirilgan va ichki buyurtma sanalmaydi.
    expect(calls.map(([sql]) => sql)).toEqual(
      expect.arrayContaining([
        'order.isDeleted = :isDeleted',
        'order.source = :source',
      ]),
    );
  });

  it.each([undefined, null, [], ['', '  '], [1, {}], 'lidershop'])(
    'slug yo`q (%p) — so`rov ketmaydi',
    async (input) => {
      const { s, createQueryBuilder } = svc([]);
      await expect(s.findExternalImportStats(input)).resolves.toEqual([]);
      expect(createQueryBuilder).not.toHaveBeenCalled();
    },
  );
});
