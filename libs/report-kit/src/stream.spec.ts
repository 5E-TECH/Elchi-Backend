import { Workbook } from 'exceljs';
import { sheetOrderProblems } from './testing/sheet-order';
import { PassThrough } from 'node:stream';
import { addReportSheet, createReport, reportToBuffer } from './xlsx';
import {
  ReportList,
  ReportTally,
  SUMMARY_WIDTHS,
  addAttention,
  addCards,
  addShareTable,
  addSlimKpis,
  addTextBanner,
  countFormat,
  createStreamReport,
  groupDigits,
  openReportBook,
  reportDateTime,
  splitColumns,
  wrappedLines,
  type ReportListColumn,
} from './stream';

const COLUMNS: readonly ReportListColumn[] = [
  { header: '№', key: 'n', width: 6, align: 'center', fmt: '#,##0' },
  { header: 'Nomi', key: 'name', width: 20, wrap: true },
  {
    header: 'Holati',
    key: 'status',
    width: 16,
    badge: true,
    tone: (row) => (row.status === 'Sotilgan' ? 'success' : undefined),
  },
  { header: "Summa, so'm", key: 'sum', width: 14, fmt: '#,##0', bold: true },
];

const load = async (buffer: Buffer) => {
  const wb = new Workbook();
  // Excel «Repaired» qilmasin (exceljs o'qiganda sezmaydi).
  expect(sheetOrderProblems(buffer)).toEqual([]);
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
};

const streamed = async (
  build: (wb: ReturnType<typeof createStreamReport>) => void,
) => {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((resolve) => out.on('end', resolve));
  const wb = createStreamReport(
    out,
    'Namuna',
    new Date('2026-11-24T23:41:00Z'),
  );
  build(wb);
  await wb.commit();
  await ended;
  return load(Buffer.concat(chunks));
};

describe('report-kit/stream — matn va son yordamchilari', () => {
  it('sana Toshkent vaqtida, son guruhlangan, birlik formatda xavfsiz', () => {
    expect(reportDateTime('2026-11-24T23:41:00Z')).toBe('25.11.2026 04:41');
    expect(reportDateTime('xato')).toBe('');
    expect(groupDigits(1234567)).toBe('1 234 567');
    expect(countFormat('ta buyurtma')).toBe('#,##0" ta buyurtma"');
    // Qo'shtirnoq formatni buzmasin.
    expect(countFormat('ta" ; [Red]\\')).toBe('#,##0" ta ; [Red]"');
  });

  it('wrappedLines: uzun matn bir nechta qator', () => {
    expect(wrappedLines('Kitob', 20)).toBe(1);
    expect(wrappedLines("Oshxona to'plami, 12 dona, sochiq (2 dona)", 20)).toBe(
      2,
    );
    expect(wrappedLines('a\nb', 20)).toBe(2);
  });
});

describe('report-kit/stream — oqimli varaq', () => {
  it('banner («ELCHI POCHTA», rasmsiz), ro‘yxat, SUBTOTAL, avtofiltr, chop sarlavhasi', async () => {
    const wb = await streamed((book) => {
      const ws = addReportSheet(
        book,
        'Royxat',
        COLUMNS.map((c) => c.width),
        { freeze: 6, freezeColumns: 2 },
      );
      let r = addTextBanner(ws, {
        title: 'Sarlavha',
        subtitle: 'Izoh',
        right: '2 ta',
        rightSub: 'hozir',
      });
      const list = new ReportList(ws, COLUMNS);
      list.header(r);
      ws.getRow(r).commit();
      r += 1;
      const first = r;
      [
        { n: 1, name: '=1+1', status: 'Sotilgan', sum: 1000 },
        { n: 2, name: '', status: 'Yangi', sum: 2500 },
      ].forEach((row, i) => {
        list.row(r, row, i, { dim: i === 1 });
        ws.getRow(r).commit();
        r += 1;
      });
      list.total(r, {
        name: { value: list.subtotal('n', first, r - 1, 2, 2), fmt: '#,##0' },
        sum: { value: list.subtotal('sum', first, r - 1, 3500) },
      });
      list.finish(6, first, r - 1);
      ws.commit();
    });
    const ws = wb.getWorksheet('Royxat')!;
    expect(wb.creator).toBe('Elchi Pochta');
    expect(ws.getImages()).toHaveLength(0);
    expect(ws.getCell('B1').value).toBe('ELCHI POCHTA');
    expect(ws.getCell('B2').value).toBe('Sarlavha');
    expect(ws.getCell('B3').value).toBe('Izoh');
    expect(ws.getCell('E2').value).toBe('2 ta');
    // Matn «=» bilan boshlansa ham matn; bo'sh — «—».
    expect(ws.getCell('C7').value).toBe('=1+1');
    expect(ws.getCell('C7').formula).toBeUndefined();
    expect(ws.getCell('C8').value).toBe('—');
    // Holat belgisi: yashil; tonsiz holat — rangsiz; xira qator.
    expect(ws.getCell('D7').font.color?.argb).toBe('FF12704F');
    expect(ws.getCell('D8').font.bold ?? false).toBe(false);
    expect(ws.getCell('E8').font.color?.argb).toBe('FF7C859F');
    expect(ws.getCell('C9').value).toMatchObject({
      formula: 'SUBTOTAL(2,B7:B8)',
      result: 2,
    });
    expect(ws.getCell('E9').value).toMatchObject({
      formula: 'SUBTOTAL(9,E7:E8)',
      result: 3500,
    });
    expect(ws.autoFilter).toBe('B6:E8');
    expect(ws.pageSetup.printTitlesRow).toBe('6:6');
    expect(ws.views[0]).toMatchObject({
      state: 'frozen',
      ySplit: 6,
      xSplit: 2,
    });
  });

  it('ulush jadvali: formula + natija, REPT chizig‘i, JAMI', async () => {
    const tally = new ReportTally();
    for (let i = 0; i < 4; i += 1) tally.add('Sotilgan', 100);
    tally.add('Yangi', 50);
    tally.add('', 10);
    const wb = await streamed((book) => {
      const ws = addReportSheet(book, 'Xulosa', SUMMARY_WIDTHS);
      addShareTable(ws, 1, {
        title: 'Holatlar',
        head: 'Holati',
        rows: tally.list({
          order: ['Yangi', 'Sotilgan'],
          tone: (name) => (name === 'Sotilgan' ? 'success' : undefined),
        }),
        badge: true,
      });
      ws.commit();
    });
    const ws = wb.getWorksheet('Xulosa')!;
    expect(['B3', 'B4', 'B5'].map((a) => ws.getCell(a).value)).toEqual([
      'Yangi',
      'Sotilgan',
      "Ko'rsatilmagan",
    ]);
    expect(ws.getCell('E4').value).toMatchObject({
      formula: 'IF(D$6=0,0,D4/D$6)',
      result: 4 / 6,
    });
    expect(ws.getCell('F4').value).toMatchObject({
      formula: 'REPT("█",ROUND(D4/MAX(D$3:D$5)*12,0))',
      result: '█'.repeat(12),
    });
    expect(ws.getCell('F3').result).toBe('█'.repeat(3));
    expect(ws.getCell('D6').value).toMatchObject({
      formula: 'SUM(D3:D5)',
      result: 6,
    });
    expect(ws.getCell('G6').value).toMatchObject({
      formula: 'SUM(G3:G5)',
      result: 460,
    });
    // Holat belgisi chapda (nom ustuni).
    expect(ws.getCell('B4').alignment).toMatchObject({
      horizontal: 'left',
      indent: 1,
    });
  });

  it('summasiz jadval (LOGIST): summa ustuni yo‘q', async () => {
    const tally = new ReportTally();
    tally.add('Asaka', 777_000);
    const wb = await streamed((book) => {
      const ws = addReportSheet(book, 'Xulosa', SUMMARY_WIDTHS);
      addShareTable(ws, 1, {
        title: 'Tumanlar',
        head: 'Tuman',
        rows: tally.list(),
        money: false,
        spans: [2, 1, 1, 2, 0],
      });
      ws.commit();
    });
    const values: unknown[] = [];
    wb.getWorksheet('Xulosa')!.eachRow((row) =>
      row.eachCell((cell) => values.push(cell.result ?? cell.value)),
    );
    expect(values).not.toContain(777_000);
    expect(values).not.toContain("Narxi, so'm");
  });
});

describe('report-kit/stream — guruhlar va kartalar', () => {
  it('ReportTally: soni bo‘yicha tartib, top + «Boshqalar (N ta)», total()', () => {
    const tally = new ReportTally('Yo‘q');
    ['a', 'b', 'b', 'c', 'c', 'c', ''].forEach((name) => tally.add(name, 10));
    expect(tally.list().map((g) => [g.name, g.count, g.sum])).toEqual([
      ['c', 3, 30],
      ['b', 2, 20],
      ['a', 1, 10],
      ['Yo‘q', 1, 10],
    ]);
    expect(tally.list({ top: 2 })[2]).toEqual({
      name: 'Boshqalar (2 ta)',
      count: 2,
      sum: 20,
    });
    expect(tally.total(['a', 'c', 'zzz'])).toEqual({ count: 4, sum: 40 });
    expect(tally.get('zzz')).toEqual({ name: 'zzz', count: 0, sum: 0 });
  });

  it('splitColumns: bo‘laklar ketma-ket va hammasini qoplaydi', () => {
    const ws = addReportSheet(
      createReport('x'),
      'x',
      [5, 10, 30, 8, 8, 20, 12],
    );
    for (const count of [1, 2, 3, 4]) {
      const parts = splitColumns(ws, count);
      expect(parts).toHaveLength(count);
      expect(parts[0][0]).toBe(2);
      expect(parts[count - 1][1]).toBe(8);
      parts.slice(1).forEach(([from], i) => {
        expect(from).toBe(parts[i][1] + 1);
      });
    }
  });

  it('kartalar, past ko‘rsatkichlar va DIQQAT lentasi', async () => {
    const workbook = createReport('x');
    const ws = addReportSheet(workbook, 'x', SUMMARY_WIDTHS);
    let r = addCards(ws, 1, [
      { label: 'Jami', value: 5, sub: 'izoh' },
      { label: 'Sotilgan', value: 3, tone: 'success' },
    ]);
    expect(r).toBe(5);
    r = addSlimKpis(ws, r, [{ label: 'Qoldi', value: 7, tone: 'warning' }]);
    expect(r).toBe(8);
    expect(addAttention(ws, r, 'DIQQAT: cheklangan', 28)).toBe(9);
    const sheet = (await load(await reportToBuffer(workbook))).getWorksheet(
      'x',
    )!;
    expect(sheet.getCell('B2').value).toBe(5);
    expect(sheet.getCell('B3').value).toBe('izoh');
    expect(sheet.getCell('B6').value).toBe(7);
    expect(sheet.getCell('B8').text).toBe('DIQQAT: cheklangan');
  });

  it('subtotal: bo‘sh ro‘yxatda formula emas, son', () => {
    const ws = addReportSheet(createReport('x'), 'x', [6, 20, 16, 14]);
    const list = new ReportList(ws, COLUMNS);
    expect(list.subtotal('sum', 7, 6, 0)).toBe(0);
    expect(list.letter('sum')).toBe('E');
  });
});

describe('report-kit/stream — openReportBook', () => {
  it.each([
    [false, 1],
    [true, 0],
  ])('streamed=%s — o‘qiladigan fayl, rasm soni %i', async (flag, images) => {
    const book = openReportBook('Namuna', { streamed: flag });
    const ws = addReportSheet(book.workbook, 'Royxat', [6, 20, 16, 14]);
    const r = book.banner(ws, { title: 'Sarlavha' });
    const list = new ReportList(ws, COLUMNS);
    list.header(r);
    book.commitRow(ws, r);
    list.row(r + 1, { n: 1, name: 'Kitob', status: 'Yangi', sum: 5 }, 0);
    book.commitRow(ws, r + 1);
    book.commitSheet(ws);
    const sheet = (await load(await book.finish())).getWorksheet('Royxat')!;
    expect(sheet.getImages()).toHaveLength(images);
    expect(sheet.getCell('C7').value).toBe('Kitob');
    expect(sheet.getCell('E7').value).toBe(5);
  });
});
