import { SITE_IMPORT_2026_11_24 } from './site-import-2026-11-24';
import {
  mergeSiteImportRows,
  parseSiteImportRepairArgs,
} from './site-import-repair';

describe('sayt importini tiklash — sof qism', () => {
  it("ro'yxat: 58 ta noyob buyurtma, 7 raqamli kod", () => {
    expect(SITE_IMPORT_2026_11_24).toHaveLength(58);
    expect(new Set(SITE_IMPORT_2026_11_24.map((r) => r.order_id)).size).toBe(
      58,
    );
    for (const row of SITE_IMPORT_2026_11_24) {
      expect(row.sato).toMatch(/^17\d{5}$/);
    }
  });

  it('sukut — DRY-RUN; --dry-run --apply dan ustun', () => {
    expect(parseSiteImportRepairArgs([]).apply).toBe(false);
    expect(parseSiteImportRepairArgs(['--apply']).apply).toBe(true);
    expect(parseSiteImportRepairArgs(['--apply', '--dry-run']).apply).toBe(
      false,
    );
  });

  it('--extra qatorlari; noto`g`ri shakl — xato', () => {
    expect(
      parseSiteImportRepairArgs(['--extra=4100:lidershop:56800:1703211']).extra,
    ).toEqual([
      {
        order_id: '4100',
        site: 'lidershop',
        external_id: '56800',
        sato: '1703211',
      },
    ]);
    expect(() =>
      parseSiteImportRepairArgs(["--extra=4100:x:1:1703211'; DROP"]),
    ).toThrow("noto'g'ri");
    expect(() => parseSiteImportRepairArgs(['--foo'])).toThrow("noma'lum");
  });

  it('bir buyurtma ikki marta — xato', () => {
    expect(() =>
      mergeSiteImportRows(SITE_IMPORT_2026_11_24, [SITE_IMPORT_2026_11_24[0]]),
    ).toThrow('ikki marta');
  });
});
