import { getMetadataArgsStorage } from 'typeorm';
import { numericTransformer } from '@app/common';
import { AiSpendCounter } from '../entities/ai-spend-counter.entity';
import { AiUsageLog } from '../entities/ai-usage-log.entity';

type ColumnMetadataArgs = ReturnType<
  typeof getMetadataArgsStorage
>['columns'][number];

/** Entity (va uning BaseEntity ajdodlari) ustun metama'lumoti. */
function columnsOf(target: object): ColumnMetadataArgs[] {
  const chain: unknown[] = [];
  let proto: unknown = target;
  while (typeof proto === 'function' && proto !== Function.prototype) {
    chain.push(proto);
    proto = Object.getPrototypeOf(proto);
  }
  return getMetadataArgsStorage().columns.filter((c) =>
    chain.includes(c.target),
  );
}

function column(target: object, name: string): ColumnMetadataArgs {
  const found = columnsOf(target).find((c) => c.propertyName === name);
  if (!found) throw new Error(`ustun topilmadi: ${name}`);
  return found;
}

const USAGE_NUMERIC = [
  'cost_usd',
  'cache_saved_usd',
  'cost_uzs',
  'usd_uzs_rate',
  'applied_price_uzs',
];
const COUNTER_NUMERIC = ['cost_usd', 'cost_uzs', 'override_usd'];

describe('AiUsageLog / AiSpendCounter entity (lYVuADRE #2/#14/#15)', () => {
  it.each(USAGE_NUMERIC)(
    '#2/#14: ai_usage_log.%s — numeric + numericTransformer ustun metama`lumotida',
    (name) => {
      const col = column(AiUsageLog, name);
      expect(col.options.type).toBe('numeric');
      expect(col.options.transformer).toBe(numericTransformer);
    },
  );

  it.each(COUNTER_NUMERIC)(
    'ai_spend_counter.%s — numeric + numericTransformer',
    (name) => {
      const col = column(AiSpendCounter, name);
      expect(col.options.type).toBe('numeric');
      expect(col.options.transformer).toBe(numericTransformer);
    },
  );

  it('HAR numeric ustunda transformer bor (yangi ustun unutilmasin)', () => {
    for (const target of [AiUsageLog, AiSpendCounter]) {
      const numeric = columnsOf(target).filter(
        (c) => c.options.type === 'numeric',
      );
      expect(numeric.length).toBeGreaterThan(0);
      for (const c of numeric) {
        expect({ col: c.propertyName, t: c.options.transformer }).toEqual({
          col: c.propertyName,
          t: numericTransformer,
        });
      }
    }
  });

  it('#14: pg satri NUMBER bo`lib o`qiladi — from("0.016698") === 0.016698', () => {
    const value = numericTransformer.from('0.016698');
    expect(value).toBe(0.016698);
    expect(typeof value).toBe('number');
    expect(numericTransformer.from(null)).toBeNull();
  });

  it('#15: ikki qator yig`indisi son — satr konkatenatsiyasi yo`q', () => {
    const a = numericTransformer.from('0.1');
    const b = numericTransformer.from('0.2');
    const sum = (a ?? 0) + (b ?? 0);
    expect(sum).toBeCloseTo(0.3, 10);
    expect(String(sum)).not.toBe('0.10.2');
  });

  it('C12 shakli: order_ids bigint[], draft_id uuid, market_id/user_id bigint', () => {
    const orderIds = column(AiUsageLog, 'order_ids');
    expect(orderIds.options.type).toBe('bigint');
    expect(orderIds.options.array).toBe(true);
    expect(column(AiUsageLog, 'draft_id').options.type).toBe('uuid');
    expect(column(AiUsageLog, 'market_id').options.type).toBe('bigint');
    expect(column(AiUsageLog, 'user_id').options.type).toBe('bigint');
    expect(column(AiUsageLog, 'input_sha256').options.length).toBe(64);
  });

  it('AiUsageLog BaseEntity`dan: is_deleted, createdAt, updatedAt', () => {
    expect(column(AiUsageLog, 'isDeleted').options.name).toBe('is_deleted');
    expect(columnsOf(AiUsageLog).map((c) => c.propertyName)).toEqual(
      expect.arrayContaining(['id', 'createdAt', 'updatedAt']),
    );
  });

  it('HD5zOyBp #17: jurnalda xom matn/rasm ustuni YO`Q — faqat uzunlik, xesh, rasm soni', () => {
    const names = columnsOf(AiUsageLog).map((c) => c.propertyName);
    expect(names).toEqual(
      expect.arrayContaining(['input_chars', 'input_sha256', 'image_count']),
    );
    const forbidden = names.filter((n) =>
      /text|prompt|content|message|image_data|base64|phone|address|customer/i.test(
        n,
      ),
    );
    expect(forbidden).toEqual([]);
  });

  it('AiSpendCounter: composite PK (scope, period_key), market/user ustuni YO`Q', () => {
    const primary = columnsOf(AiSpendCounter)
      .filter((c) => c.options.primary)
      .map((c) => c.propertyName)
      .sort();
    expect(primary).toEqual(['period_key', 'scope']);
    const names = columnsOf(AiSpendCounter).map((c) => c.propertyName);
    expect(names.filter((n) => /market|user/i.test(n))).toEqual([]);
  });

  it('ikkala entity ai_schema da', () => {
    const tables = getMetadataArgsStorage().tables.filter(
      (t) => t.target === AiUsageLog || t.target === AiSpendCounter,
    );
    expect(tables.map((t) => [t.name, t.schema]).sort()).toEqual([
      ['ai_spend_counter', 'ai_schema'],
      ['ai_usage_log', 'ai_schema'],
    ]);
  });
});
