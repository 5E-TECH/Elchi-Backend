import { Workbook, type Cell } from 'exceljs';
import { of } from 'rxjs';
import {
  buildBranchMessage,
  buildMarketMessage,
  buildSuperadminMessage,
  type ShiftReportSnapshot,
} from './shift-report.builders';
import { buildMarketXlsx } from './shift-report.file';
import { ShiftReportService } from './shift-report.service';
import { REPORT_DEFAULTS } from '../shift-auto-close/shift-schedule.rules';

/**
 * Smena hisoboti — XABAR + EXCEL: filial guruhi / menejerlari — to'liq
 * hisobot; market (egasi Telegram'ga ulangan) — FAQAT o'z to'lovlari;
 * ulanmagan market guruhiga — fayl yo'q.
 */

const snapshot: ShiftReportSnapshot = {
  shift_id: '77',
  round: 1,
  cashbox_type: 'branch',
  cashbox_user_id: '12',
  opened_at: new Date('2026-11-20T04:00:00Z'),
  closed_at: new Date('2026-11-20T18:00:00Z'),
  opened_by: '301',
  opened_by_name: 'Ali',
  closed_by: '301',
  closed_by_name: 'Ali',
  close_reason: 'manual',
  cash: {
    opening_balance: 0,
    total_income: 300_000,
    total_expense: 250_000,
    expected_balance: 50_000,
    closing_balance: 50_000,
    discrepancy: 0,
  },
  card: {
    opening_balance: 0,
    total_income: 0,
    total_expense: 0,
    expected_balance: 0,
    closing_balance: null,
    discrepancy: null,
  },
  accounts: [],
  couriers: [],
  markets: [
    {
      market_id: '601',
      name: 'Market A',
      total: 150_000,
      balance: 20_000,
      payments: [
        {
          history_id: '1',
          amount: 150_000,
          payment_method: 'cash',
          card_name: null,
          at: new Date('2026-11-20T10:00:00Z'),
        },
      ],
    },
    {
      market_id: '602',
      name: 'Market B',
      total: 100_000,
      balance: 0,
      payments: [
        {
          history_id: '2',
          amount: 100_000,
          payment_method: 'click',
          card_name: 'Asosiy',
          at: new Date('2026-11-20T11:00:00Z'),
        },
      ],
    },
  ],
};

/** Formula — natijasi bilan (`cell.value` 0 natijani tashlab yuboradi). */
const plain = (cell: Cell): unknown =>
  cell.formula ? cell.result : cell.value;

const load = async (buffer: Buffer) => {
  const workbook = new Workbook();
  await workbook.xlsx.load(buffer as never);
  return workbook;
};

/** Birinchi varaq qatorlari (birlashtirilgan kataklar bir marta, bo'shsiz). */
const rowsOf = async (buffer: Buffer) => {
  const rows: unknown[][] = [];
  (await load(buffer)).worksheets[0].eachRow((row) => {
    const values: unknown[] = [];
    row.eachCell((cell) => {
      if (cell.isMerged && cell.master !== cell) return;
      if (cell.value !== null && cell.value !== '') {
        values.push(plain(cell));
      }
    });
    if (values.length) rows.push(values);
  });
  return rows;
};

describe('buildMarketXlsx', () => {
  it('faqat o‘z to‘lovlari, jami va qoldiq', async () => {
    const rows = await rowsOf(
      await buildMarketXlsx(snapshot, snapshot.markets[0]),
    );
    const flat = JSON.stringify(rows);
    expect(flat).toContain('Market A');
    expect(flat).toContain('150000');
    expect(flat).not.toContain('Market B');
    expect(flat).not.toContain('100000');
    expect(rows).toContainEqual(["Jami to'langan", 150_000]);
    expect(rows).toContainEqual(['Hisobingizdagi qoldiq', 20_000]);
    expect(rows).toContainEqual([
      1,
      // 10:00 UTC → Toshkent 15:00 (Excel sanasi).
      new Date('2026-11-20T15:00:00Z'),
      150_000,
      'Naqd',
    ]);
  });

  it('⭐ fayl ichida (formula, kolontitul, nom) ham begona market / kassa yo‘q', async () => {
    const workbook = await load(
      await buildMarketXlsx(snapshot, snapshot.markets[1]),
    );
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "To'lovlar",
    ]);
    const all = JSON.stringify([
      workbook.title,
      workbook.worksheets.map((sheet) => [
        sheet.headerFooter,
        sheet.getSheetValues(),
      ]),
    ]);
    expect(all).toContain('Market B');
    expect(all).toContain('Asosiy');
    // Boshqa market va smena kassasi raqamlari.
    for (const foreign of [
      'Market A',
      '150000',
      '20000',
      '300000',
      '250000',
      '50000',
      'Ali',
    ]) {
      expect(all).not.toContain(foreign);
    }
  });

  it('qaytarilgan to‘lov: manfiy qator, sof jami (formula natijasi bilan)', async () => {
    const [paid] = snapshot.markets[0].payments;
    const rows = await rowsOf(
      await buildMarketXlsx(
        { ...snapshot, close_reason: 'auto' },
        {
          ...snapshot.markets[0],
          total: 100_000,
          payments: [
            paid,
            { ...paid, history_id: '8', amount: -50_000, reversed: true },
          ],
        },
      ),
    );
    expect(rows).toContainEqual(['Naqd', 150_000]);
    expect(rows).toContainEqual(['Qaytarilgan', -50_000]);
    expect(rows).toContainEqual(["Jami to'langan", 100_000]);
    expect(
      rows.some((row) => row.includes(-50_000) && row.includes('Qaytarildi')),
    ).toBe(true);
  });
});

describe('ShiftReportService — Excel ilovalari', () => {
  const setup = () => {
    const uploads: Array<Record<string, any>> = [];
    const file = {
      send: jest.fn((_pattern: unknown, payload: Record<string, any>) => {
        uploads.push(payload);
        return of({ data: { key: `key-${uploads.length}` } });
      }),
    };
    const service = new ShiftReportService(
      {} as never,
      { log: jest.fn() } as never,
      {} as never,
      {} as never,
      { send: jest.fn() } as never,
      file as never,
    );
    const attach = (
      recipients: Array<Record<string, any>>,
      linked: Map<string, boolean>,
      superKey: string | null = null,
      format: 'pdf' | 'xlsx' = 'pdf',
    ) =>
      (
        service as unknown as {
          attachExcel: (...args: unknown[]) => Promise<void>;
        }
      ).attachExcel(
        snapshot,
        { ...REPORT_DEFAULTS, format },
        recipients,
        linked,
        superKey,
      );
    return { uploads, attach };
  };
  const tg = { telegram: true, in_app: false };

  it('⭐ filial guruhi, menejer va ulangan market — Excel; ulanmagan market — yo‘q', async () => {
    const fx = setup();
    const branch = buildBranchMessage(snapshot, 'Chilonzor');
    const recipients = [
      {
        kind: 'branch',
        recipient_id: '12',
        message: branch,
        channels: tg,
        group: { active: true, inactive_reason: null },
      },
      {
        kind: 'branch_manager',
        recipient_id: '301',
        message: branch,
        channels: tg,
      },
      {
        kind: 'market',
        recipient_id: '601',
        message: buildMarketMessage(snapshot, snapshot.markets[0]),
        channels: tg,
      },
      {
        kind: 'market',
        recipient_id: '602',
        message: buildMarketMessage(snapshot, snapshot.markets[1]),
        channels: tg,
      },
    ];
    await fx.attach(
      recipients,
      new Map([
        ['601', true],
        ['602', false],
      ]),
    );
    // To'liq hisobot BIR marta saqlanadi (guruh + menejer), market A — o'zi.
    expect(fx.uploads.map((u) => u.file_name)).toEqual([
      'smena-77-hisobot.xlsx',
      'smena-77-market-601-tolovlar.xlsx',
    ]);
    expect(fx.uploads.every((u) => u.folder === 'shift-report')).toBe(true);
    expect(recipients[0].message.data).toMatchObject({
      telegram_media: ['key-1'],
      telegram_media_caption: "📎 To'liq hisobot (Excel)",
    });
    expect(recipients[1].message.data.telegram_media).toEqual(['key-1']);
    expect(recipients[2].message.data.telegram_media).toEqual(['key-2']);
    expect(recipients[3].message.data.telegram_media).toBeUndefined();
    // Asl (umumiy) xabar obyekti o'zgarmagan.
    expect(branch.data.telegram_media).toBeUndefined();
    // Market A fayli — faqat o'z to'lovlari.
    const marketRows = JSON.stringify(
      await rowsOf(Buffer.from(fx.uploads[1].file_base64, 'base64')),
    );
    expect(marketRows).toContain('Market A');
    expect(marketRows).not.toContain('Market B');
  });

  it('superadmin fayli XLSX bo‘lsa — o‘sha kalit qayta ishlatiladi; nofaol guruh — fayl yo‘q', async () => {
    const fx = setup();
    const branch = buildBranchMessage(snapshot, null);
    const recipients = [
      {
        kind: 'superadmin',
        recipient_id: '1',
        message: buildSuperadminMessage(snapshot, 'super-key'),
        channels: tg,
      },
      {
        kind: 'branch_manager',
        recipient_id: '301',
        message: branch,
        channels: tg,
      },
      {
        kind: 'branch',
        recipient_id: '12',
        message: branch,
        channels: tg,
        group: { active: false, inactive_reason: 'kicked' },
      },
    ];
    await fx.attach(recipients, new Map(), 'super-key', 'xlsx');
    expect(fx.uploads).toHaveLength(0);
    expect(recipients[1].message.data.telegram_media).toEqual(['super-key']);
    expect(recipients[2].message.data.telegram_media).toBeUndefined();
  });
});
