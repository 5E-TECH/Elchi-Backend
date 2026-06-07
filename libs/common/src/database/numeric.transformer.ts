import { ValueTransformer } from 'typeorm';

/**
 * TypeORM transformer for `numeric`/`decimal` columns.
 *
 * Postgres returns numeric/decimal as a string (to preserve exact precision).
 * This converts it back to a JS number on read so entity fields keep their
 * `number` type and existing arithmetic keeps working, while the column stores
 * exact fixed-point money/percentage values (no binary-float drift, exact SUM).
 *
 * Use `numeric(14,2)` for money and `numeric(5,2)` for percentages. null is
 * preserved for nullable columns; non-nullable defaulted columns never see null.
 */
export class ColumnNumericTransformer implements ValueTransformer {
  to(value: number | null | undefined): number | null | undefined {
    return value;
  }

  from(value: string | null | undefined): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
}

/** Shared singleton — reuse across entities. */
export const numericTransformer = new ColumnNumericTransformer();
