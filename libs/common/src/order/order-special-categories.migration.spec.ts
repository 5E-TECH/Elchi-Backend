import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORDER_SPECIAL_CATEGORIES } from '@app/common';

/**
 * T8 — migratsiya 187 dagi CHECK ro'yxati `ORDER_SPECIAL_CATEGORIES` bilan
 * AYNAN bir xil (tartibi ham). Kod qo'shilsa-yu CHECK yangilanmasa, DB yangi
 * kodni rad etardi (500) — bu spec shu ajralishni ushlaydi.
 */
describe('1716000000187 CHECK ↔ ORDER_SPECIAL_CATEGORIES', () => {
  const source = readFileSync(
    join(
      __dirname,
      '../../../../migrations/1716000000187-OrderSpecialCategories.ts',
    ),
    'utf8',
  );

  it('ARRAY[...] ro`yxati enum bilan bir xil', () => {
    const match = /CHECK \("special_categories" <@ ARRAY\[([^\]]*)\]/.exec(
      source,
    );
    expect(match).not.toBeNull();
    const codes = (match?.[1] ?? '')
      .split(',')
      .map((part) => part.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(codes).toEqual([...ORDER_SPECIAL_CATEGORIES]);
  });

  it('CHECK `NOT VALID` va lock_timeout bilan (jadval skanerlanmaydi, cheksiz kutmaydi)', () => {
    expect(source).toMatch(/\]::varchar\[\]\) NOT VALID;/);
    expect(source).toMatch(/set_config\('lock_timeout', '5s', true\)/);
    expect(source).toMatch(
      /set_config\('lock_timeout', previous_lock_timeout, true\)/,
    );
  });
});
