import { Workbook } from 'exceljs';
import {
  REPORT_FMT,
  addBanner,
  addDataBars,
  addKpis,
  addMeta,
  addNote,
  addReportSheet,
  addSection,
  addSignatures,
  addTable,
  columnLetter,
  createReport,
  reportToBuffer,
  toExcelDate,
} from './xlsx';

const ROWS = [
  { name: 'Ali', method: 'naqd', at: '2026-11-24T13:05:00Z', sum: 10_000_000 },
  { name: 'Vali', method: 'karta', at: '2026-11-24T14:05:00Z', sum: 4_334_000 },
];

const build = (rows = ROWS) => {
  const workbook = createReport('Namuna');
  const ws = addReportSheet(workbook, 'Namuna', [6, 24, 16, 18, 18], {
    footer: 'A & B',
  });
  let r = addBanner(ws, {
    title: 'Namuna hisobot',
    subtitle: 'Andijon filiali',
    right: '#16',
    rightSub: 'Yopilgan',
  });
  r = addMeta(ws, r, [
    {
      label: 'Ochilgan',
      value: toExcelDate('2026-11-24T12:53:00Z'),
      fmt: REPORT_FMT.dateTime,
    },
    { label: 'Holat', value: 'Yopilgan', tone: 'success' },
  ]);
  r = addKpis(ws, r, [
    { label: "Jami, so'm", value: 14_334_000, tone: 'success', sub: '2 ta' },
    { label: 'Farq', value: -250_000, tone: 'danger' },
  ]);
  r = addSection(ws, r, "To'lovlar", '2 ta');
  const table = addTable(ws, r, {
    columns: [
      { header: '№', value: (row) => rows.indexOf(row) + 1, align: 'center' },
      { header: 'Kim', value: (row) => row.name },
      {
        header: 'Usul',
        value: (row) => row.method,
        badge: true,
        tone: (row) => (row.method === 'naqd' ? 'success' : 'info'),
      },
      {
        header: 'Vaqt',
        value: (row) => toExcelDate(row.at),
        fmt: REPORT_FMT.dateTime,
      },
      {
        header: "Summa, so'm",
        value: (row) => row.sum,
        fmt: REPORT_FMT.som,
        sum: true,
      },
    ],
    rows,
    total: true,
    filter: true,
  });
  addDataBars(ws, `F${table.first}:F${table.last}`);
  r = addNote(ws, table.next, 'Mos keldi', 'success');
  addSignatures(ws, r, ['Topshirdi', 'Qabul qildi']);
  return { workbook, table };
};

const reread = async (workbook: Workbook) => {
  const copy = new Workbook();
  await copy.xlsx.load((await reportToBuffer(workbook)) as never);
  return copy;
};

describe('report-kit xlsx', () => {
  it('⭐ summa — son, sana — Excel sanasi (Toshkent), jami — formula natijasi bilan', async () => {
    const { workbook, table } = build();
    const ws = (await reread(workbook)).getWorksheet('Namuna')!;
    expect(ws.getCell(table.first, 6).value).toBe(10_000_000);
    expect(ws.getCell(table.first, 6).numFmt).toBe(REPORT_FMT.som);
    expect(ws.getCell(table.first, 5).value).toEqual(
      new Date('2026-11-24T18:05:00Z'),
    );
    expect(ws.getCell(table.totalRow!, 6).value).toEqual(
      expect.objectContaining({
        formula: `SUM(F${table.first}:F${table.last})`,
        result: 14_334_000,
      }),
    );
    expect(ws.getCell(table.totalRow!, 2).value).toBe('JAMI');
  });

  it('lenta: nom, o‘ng raqam, logotip va uning matn zaxirasi', async () => {
    const ws = (await reread(build().workbook)).getWorksheet('Namuna')!;
    expect(ws.getCell('B2').value).toBe('ELCHI POCHTA');
    expect(ws.getImages()).toHaveLength(1);
    const texts: unknown[] = [];
    ws.getRow(2).eachCell((cell) => texts.push(cell.value));
    expect(texts).toEqual(expect.arrayContaining(['Namuna hisobot', '#16']));
  });

  it('A4, bitta bet kengligi, kolontitulda `&` xavfsiz, filtr', async () => {
    const { workbook, table } = build();
    const ws = (await reread(workbook)).getWorksheet('Namuna')!;
    expect(ws.pageSetup).toMatchObject({
      paperSize: 9,
      fitToWidth: 1,
      fitToHeight: 0,
    });
    expect(ws.headerFooter.oddFooter).toContain('A && B');
    expect(ws.autoFilter).toBe(`B${table.header}:F${table.last}`);
  });

  it('bo‘sh jadval — izoh, JAMI va filtr yo‘q', async () => {
    const { workbook, table } = build([]);
    const ws = (await reread(workbook)).getWorksheet('Namuna')!;
    expect(ws.getCell(table.first, 2).value).toBe("Ma'lumot yo'q");
    expect(table.totalRow).toBeNull();
    expect(ws.autoFilter ?? null).toBeNull();
  });

  it('`=` bilan boshlangan matn formula bo‘lmaydi', async () => {
    const { workbook, table } = build([
      { ...ROWS[0], name: '=HYPERLINK("http://x")' },
    ]);
    const ws = (await reread(workbook)).getWorksheet('Namuna')!;
    expect(ws.getCell(table.first, 3).value).toBe('=HYPERLINK("http://x")');
  });

  it('bitta katakni o‘zgartirish qo‘shni qatorlarga o‘tmaydi', () => {
    const { workbook, table } = build();
    const ws = workbook.getWorksheet('Namuna')!;
    ws.getCell(table.first, 6).font = { bold: true, size: 20 };
    expect(ws.getCell(table.last, 6).font?.size).toBe(10);
  });

  it('toExcelDate: yaroqsiz — null; columnLetter', () => {
    expect(toExcelDate('')).toBeNull();
    expect(toExcelDate('xato')).toBeNull();
    expect(toExcelDate({})).toBeNull();
    expect([1, 26, 27, 52, 53].map(columnLetter)).toEqual([
      'A',
      'Z',
      'AA',
      'AZ',
      'BA',
    ]);
  });
});
