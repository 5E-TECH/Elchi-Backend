import { Workbook } from 'exceljs';
import {
  WAREHOUSE_ALERT_ROWS,
  WAREHOUSE_STOCK_COLUMNS,
  buildWarehouseStockXlsx,
  toWarehouseStockRows,
  type WarehouseStockSource,
} from './warehouse-stock-xlsx';

/** `GET /warehouses/:id/export` — «Xulosa» + «Qoldiq» varaqlari. */

const item = (
  name: string,
  on_hand: number,
  reserved: number,
  threshold: number,
  extra: Partial<WarehouseStockSource> = {},
): WarehouseStockSource => {
  const available = on_hand - reserved;
  return {
    product: {
      name,
      code: { value: 'ELC-P-000118', kind: 'sku' },
      chargeable_weight_kg: 1.35,
      chargeable_basis: 'volumetric',
    },
    market: { id: '1', name: 'Baraka Shop' },
    on_hand,
    reserved,
    available,
    threshold,
    level: available <= 0 ? 'out' : available <= threshold ? 'low' : 'ok',
    last_movement_at: '2026-11-24T13:05:00.000Z',
    ...extra,
  };
};

const SOURCE: WarehouseStockSource[] = [
  item('Sumka', 50, 5, 10),
  item('Blender', 4, 2, 5, {
    product: {
      name: 'Blender',
      code: { value: '4780000000081', kind: 'barcode', format: 'EAN-13' },
      chargeable_weight_kg: null,
      chargeable_basis: 'actual',
    },
    market: { id: '2', name: 'Zamin Market' },
    last_movement_at: null,
  }),
  item('Palto', 2, 2, 5),
  item('Dazmol', 3, 2, 5),
  item('Choynak', 6, 0, 6),
];

const plain = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const cell = value as {
      formula?: string;
      result?: unknown;
      richText?: Array<{ text: string }>;
    };
    if (cell.richText) return cell.richText.map((part) => part.text).join('');
    if (cell.formula) return cell.result ?? 0;
  }
  return value;
};

const load = async (buffer: Buffer) => {
  const wb = new Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
};

const sheetRows = (wb: Workbook, name: string): unknown[][] => {
  const rows: unknown[][] = [];
  wb.getWorksheet(name)!.eachRow({ includeEmpty: false }, (row) => {
    rows.push((row.values as unknown[]).slice(2).map(plain));
  });
  return rows;
};

const build = (
  extra: Partial<Parameters<typeof buildWarehouseStockXlsx>[0]> = {},
) =>
  buildWarehouseStockXlsx({
    rows: SOURCE,
    warehouseName: 'Andijon',
    total: SOURCE.length,
    now: new Date('2026-11-24T23:41:00.000Z'),
    ...extra,
  });

describe('ombor qoldig‘i eksporti', () => {
  it('saralash: Tugagan → Kam qoldi → Yetarli, ichida mavjud soni o‘sishi', () => {
    expect(
      toWarehouseStockRows(SOURCE).map((row) => [
        row.n,
        row.product,
        row.level_label,
        row.available,
      ]),
    ).toEqual([
      [1, 'Palto', 'Tugagan', 0],
      [2, 'Dazmol', 'Kam qoldi', 1],
      [3, 'Blender', 'Kam qoldi', 2],
      [4, 'Choynak', 'Kam qoldi', 6],
      [5, 'Sumka', 'Yetarli', 45],
    ]);
  });

  it('«Xulosa» birinchi varaq: ombor nomi, kartalar, tugagan / kam qolganlar, marketlar', async () => {
    const wb = await load(await build());
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(['Xulosa', 'Qoldiq']);
    const ws = wb.getWorksheet('Xulosa')!;
    expect(ws.getImages()).toHaveLength(1);
    const rows = sheetRows(wb, 'Xulosa');
    expect(rows[0]).toContain('25.11.2026');
    expect(rows[1]).toContain('Andijon ombori · barcha market · barcha holat');
    expect(rows).toContainEqual(expect.arrayContaining([1, 3, 1]));
    expect(rows).toContainEqual(expect.arrayContaining([65, 11, 54]));
    const alert = rows.filter(
      (row) => row.includes('Tugagan') || row.includes('Kam qoldi'),
    );
    const palto = alert.find((row) => row.includes('Palto'))!;
    expect(palto).toEqual(
      expect.arrayContaining(['Palto', 'Baraka Shop', 0, 5, -5, 'Tugagan']),
    );
    expect(rows.some((row) => row.includes('Sumka'))).toBe(false);
    expect(rows.find((row) => row[0] === 'Baraka Shop')).toEqual(
      expect.arrayContaining([4, 61, 9, 52, 1, 2]),
    );
    // JAMI — formula.
    let total: string | undefined;
    ws.eachRow((row) => {
      if (row.getCell(2).value === 'JAMI') total = row.getCell(4).formula;
    });
    expect(total).toMatch(/^SUM\(D\d+:D\d+\)$/);
  });

  it('«Qoldiq»: ustunlar, kod turi, sana, vazn, SUBTOTAL; rang holatga qarab', async () => {
    const ws = (await load(await build())).getWorksheet('Qoldiq')!;
    expect((ws.getRow(9).values as unknown[]).slice(2)).toEqual(
      WAREHOUSE_STOCK_COLUMNS.map((column) => column.header),
    );
    expect((ws.getRow(10).values as unknown[]).slice(2)).toEqual([
      1,
      'Palto',
      'ELC-P-000118',
      'Elchi QR kodi',
      'Baraka Shop',
      2,
      2,
      0,
      5,
      'Tugagan',
      1.35,
      "hajm bo'yicha",
      new Date('2026-11-24T18:05:00.000Z'),
    ]);
    const blender = (ws.getRow(12).values as unknown[]).slice(2);
    // EAN — matn (E+12 bo'lib qolmasin); vazn / sana yo'q — «—».
    expect(blender[2]).toBe('4780000000081');
    expect(blender[3]).toBe('Zavod shtrix kodi (EAN-13)');
    expect(blender.slice(-3)).toEqual(['—', '—', '—']);
    expect(ws.getCell('I10').font.color?.argb).toBe('FFBE2A3B');
    expect(ws.getCell('I14').font.color?.argb).toBe('FF101733');
    expect(ws.getCell('B15').value).toBe('JAMI');
    expect(ws.getCell('C15').value).toMatchObject({
      formula: 'SUBTOTAL(2,B10:B14)',
      result: 5,
    });
    expect(ws.getCell('I15').value).toMatchObject({
      formula: 'SUBTOTAL(9,I10:I14)',
      result: 54,
    });
    expect(ws.autoFilter).toBe('B9:N14');
  });

  it('filtr matni: market nomi qatordan, holat o‘zbekcha, qidiruv', async () => {
    const rows = sheetRows(
      await load(
        await build({
          filters: { marketId: '2', level: 'low,out', search: 'Blen' },
        }),
      ),
      'Qoldiq',
    );
    expect(rows[1]).toContain(
      'Andijon ombori · Zamin Market · Kam qoldi, Tugagan · Qidiruv: Blen',
    );
  });

  it('nomida «ombor» bo‘lsa takrorlanmaydi; nom yo‘q — tushib qoladi', async () => {
    const subtitle = async (warehouseName: string | null) =>
      sheetRows(await load(await build({ warehouseName })), 'Xulosa')[1];
    expect(await subtitle('Markaziy ombor')).toContain(
      'Markaziy ombor · barcha market · barcha holat',
    );
    expect(await subtitle(null)).toContain('barcha market · barcha holat');
  });

  it('fayl chegarasidan oshgan (10 000) — DIQQAT ikkala varaqda', async () => {
    const wb = await load(await build({ total: 12_345 }));
    for (const name of ['Xulosa', 'Qoldiq']) {
      const warning = sheetRows(wb, name).find((row) =>
        /^DIQQAT/.test(String(row[0])),
      );
      expect(String(warning?.[0])).toContain('12 345');
    }
  });

  it('juda ko‘p tugagan — «Xulosa» da birinchilari, qolgani «Qoldiq» da', async () => {
    const rows = Array.from({ length: WAREHOUSE_ALERT_ROWS + 20 }, (_, i) =>
      item(`Mahsulot ${i}`, 0, 0, 5),
    );
    const wb = await load(await build({ rows, total: rows.length }));
    const alerts = sheetRows(wb, 'Xulosa').filter((row) =>
      String(row[1]).startsWith('Mahsulot '),
    );
    expect(alerts).toHaveLength(WAREHOUSE_ALERT_ROWS);
    const all = sheetRows(wb, 'Qoldiq').filter((row) =>
      String(row[1]).startsWith('Mahsulot '),
    );
    expect(all).toHaveLength(rows.length);
  });

  it('bo‘sh ombor — fayl ochiladi', async () => {
    const wb = await load(await build({ rows: [], total: 0 }));
    expect(
      sheetRows(wb, 'Xulosa').some((row) => row.includes('Hammasi yetarli')),
    ).toBe(true);
    expect(
      sheetRows(wb, 'Qoldiq').some((row) => row[0] === "Qoldiq yo'q"),
    ).toBe(true);
  });
});
