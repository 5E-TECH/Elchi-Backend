import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {
  buildCourierMessage,
  buildMarketMessage,
  buildSuperadminMessage,
  deliveryReasonText,
  type ShiftReportSnapshot,
} from './shift-report.builders';
import { deliveryStatusFrom } from './shift-report.service';
import { buildPdf, buildXlsx } from './shift-report.file';

/**
 * gWI4gYkw — hisobot xabarlari: kuryer/market FAQAT o'z bo'lagini ko'radi
 * (IDOR), superadmin — to'liq; yetkazish holati xaritasi; fayl quriladi.
 */
const snapshot: ShiftReportSnapshot = {
  shift_id: '77',
  round: 1,
  cashbox_type: 'main',
  cashbox_user_id: '0',
  opened_at: new Date('2026-10-26T04:00:00Z'),
  closed_at: new Date('2026-10-26T18:00:00Z'),
  opened_by: '25',
  opened_by_name: 'Kassir',
  closed_by: null,
  closed_by_name: null,
  close_reason: 'auto',
  cash: {
    opening_balance: 1000,
    total_income: 700_000,
    total_expense: 300_000,
    expected_balance: 401_000,
    closing_balance: 0,
    discrepancy: null,
  },
  card: {
    opening_balance: 0,
    total_income: 0,
    total_expense: 0,
    expected_balance: 0,
    closing_balance: 0,
    discrepancy: null,
  },
  accounts: [
    {
      card_id: '1',
      name: 'Asosiy',
      last4: null,
      expected_balance: 0,
      entered_balance: null,
      difference: null,
      ai_status: 'not_required',
    },
  ],
  couriers: [
    {
      courier_id: '501',
      name: 'Ali',
      count: 2,
      total: 400_000,
      remaining_debt: 50_000,
    },
    {
      courier_id: '502',
      name: 'Vali',
      count: 1,
      total: 300_000,
      remaining_debt: 0,
    },
  ],
  markets: [
    {
      market_id: '601',
      name: 'Market A',
      payments: [
        {
          history_id: '9',
          amount: 120_000,
          payment_method: 'cash',
          card_name: null,
          at: new Date('2026-10-26T10:00:00Z'),
        },
      ],
      total: 120_000,
      balance: 880_000,
    },
    {
      market_id: '602',
      name: 'Market B',
      payments: [
        {
          history_id: '10',
          amount: 180_000,
          payment_method: 'click',
          card_name: 'Humo •1234',
          at: new Date('2026-10-26T11:00:00Z'),
        },
      ],
      total: 180_000,
      balance: 20_000,
    },
  ],
};

describe('gWI4gYkw — smena hisoboti xabarlari', () => {
  it("kuryer xabari faqat o'z summasi / soni / qarzi (boshqa kuryer yo'q)", () => {
    const message = buildCourierMessage(snapshot, snapshot.couriers[0]);
    const text = JSON.stringify(message);
    expect(message.body).toContain("400 000 so'm (2 ta to'lov)");
    expect(message.body).toContain("Qolgan qarzingiz: 50 000 so'm");
    expect(text).not.toContain('300 000');
    expect(text).not.toContain('Vali');
    expect(text).not.toContain('502');
    expect(text).not.toContain('Market');
    expect(message.data).toMatchObject({ courier_id: '501', total: 400_000 });
  });

  it("market xabari faqat o'z to'lovlari (summa, usul, karta) va qoldiq", () => {
    const message = buildMarketMessage(snapshot, snapshot.markets[1]);
    const text = JSON.stringify(message);
    expect(message.body).toContain("180 000 so'm — karta (Humo •1234)");
    expect(message.body).toContain("Hisobingizdagi qoldiq: 20 000 so'm");
    expect(text).not.toContain('120 000');
    expect(text).not.toContain('Market A');
    expect(text).not.toContain('601');
    expect(text).not.toContain('Ali');
    expect(message.group_text).toContain('<b>');
    // Guruh xabari — bosh sahifa: guruhdagi operator /cash-box da 403 olardi.
    expect(message.group_text).toContain(
      '<a href="https://admin.elchipochta.uz/">Kabinetni ochish</a>',
    );
    expect(message.group_text).not.toContain('/cash-box');
    // Kassa havolasi — faqat egasining shaxsiy xabarida.
    expect(message.link).toBe('/cash-box');
    expect(message.group_text).not.toContain('120 000');
  });

  it("superadmin — to'liq xulosa, avtomatik yopilgan banner, ilova kaliti", () => {
    const message = buildSuperadminMessage(snapshot, 'shift-report-1.pdf');
    expect(message.title).toBe('⏰ Smena #77 avtomatik yopildi');
    expect(message.body).toContain(
      'Avtomatik yopildi — 23:00, kassir yopmagan',
    );
    expect(message.body).toContain('farq: sanalmadi');
    expect(message.body).toContain("Kuryerlar: 2 ta, 700 000 so'm");
    expect(message.body.length).toBeLessThanOrEqual(900);
    expect(message.data.telegram_media).toEqual(['shift-report-1.pdf']);
    expect(message.link).toBe('/payments/shifts/77');
  });

  it("yetkazish holati: Telegram ulanmagan / yuborildi / guruh yo'q", () => {
    expect(
      deliveryStatusFrom('telegram', {
        telegram: 'skipped',
        telegram_reason: 'no_telegram_id',
      }),
    ).toEqual({ status: 'failed', failed_reason: 'Telegram ulanmagan' });
    expect(deliveryStatusFrom('telegram', { telegram: 'sent' })).toEqual({
      status: 'sent',
      failed_reason: null,
    });
    expect(deliveryStatusFrom('telegram', { telegram: 'queued' })).toEqual({
      status: 'queued',
      failed_reason: null,
    });
    expect(
      deliveryStatusFrom('telegram_group', { telegram: 'not_eligible' }),
    ).toEqual({ status: 'failed', failed_reason: 'Telegram guruhi ulanmagan' });
    expect(deliveryStatusFrom('in_app', {})).toEqual({
      status: 'sent',
      failed_reason: null,
    });
    expect(deliveryReasonText('blocked_by_user: 403')).toBe('Botni bloklagan');
  });

  it('fayl: XLSX (zip) va PDF quriladi', async () => {
    const xlsx = await buildXlsx(snapshot);
    expect(xlsx.subarray(0, 2).toString()).toBe('PK');
    const pdf = await buildPdf(snapshot);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('T6 — qaytarilgan to`lovlar smena hisobotida', () => {
  const reversedSnapshot: ShiftReportSnapshot = {
    ...snapshot,
    couriers: [
      {
        courier_id: '501',
        name: 'Ali',
        count: 1,
        received: 700_000,
        reversed: 500_000,
        total: 200_000,
        remaining_debt: 500_000,
      },
    ],
    markets: [
      {
        market_id: '601',
        name: 'Market A',
        payments: [
          {
            history_id: '1',
            amount: 300_000,
            payment_method: 'cash',
            card_name: null,
            at: '2026-10-30T05:00:00.000Z',
          },
          {
            history_id: '2',
            amount: -300_000,
            payment_method: 'cash',
            card_name: null,
            at: '2026-10-30T06:00:00.000Z',
            reversed: true,
          },
        ],
        total: 0,
        balance: 700_000,
      },
    ],
  };

  it('kuryer: «Topshirgan · Qaytarilgan · Sof»; market: «qaytarildi» qatori va data.reversed', () => {
    const courier = buildCourierMessage(
      reversedSnapshot,
      reversedSnapshot.couriers[0],
    );
    expect(courier.body).toContain(
      "Topshirgan: 700 000 so'm (1 ta) · Qaytarilgan: 500 000 so'm · Sof: 200 000 so'm",
    );
    expect(courier.data).toMatchObject({
      reversed: 500_000,
      received: 700_000,
    });
    const market = buildMarketMessage(
      reversedSnapshot,
      reversedSnapshot.markets[0],
    );
    expect(market.body).toContain("−300 000 so'm — naqd — qaytarildi");
    expect((market.data.payments as unknown[])[1]).toMatchObject({
      amount: -300_000,
      reversed: true,
    });
  });

  it('XLSX: Kuryerlar — Qaytarilgan / Sof ustunlari va qiymatlari; Marketlar — Izoh «qaytarildi»; PDF matnida «qaytarilgan»', async () => {
    const xlsx = await buildXlsx(reversedSnapshot);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx as never);
    const couriers = workbook.getWorksheet('Kuryerlar');
    const header = (couriers?.getRow(1).values as unknown[]).filter(Boolean);
    expect(header).toEqual(
      expect.arrayContaining(['Topshirgan', 'Qaytarilgan', 'Sof']),
    );
    const col = (name: string) => header.indexOf(name) + 1;
    const row = couriers!.getRow(2);
    expect(row.getCell(col('Topshirgan')).value).toBe(700_000);
    expect(row.getCell(col('Qaytarilgan')).value).toBe(500_000);
    expect(row.getCell(col('Sof')).value).toBe(200_000);
    const markets = workbook.getWorksheet('Marketlar');
    const mHeader = (markets?.getRow(1).values as unknown[]).filter(Boolean);
    const izoh = mHeader.indexOf('Izoh') + 1;
    expect(izoh).toBeGreaterThan(0);
    expect(markets!.getRow(2).getCell(izoh).value ?? '').toBe('');
    expect(markets!.getRow(3).getCell(izoh).value).toBe('qaytarildi');

    // PDF shriftli (glif kodlari) — matn `doc.text` chaqiruvlaridan olinadi.
    const texts: string[] = [];
    const spy = jest
      .spyOn(PDFDocument.prototype, 'text')
      .mockImplementation(function (
        this: PDFKit.PDFDocument,
        ...args: unknown[]
      ) {
        if (typeof args[0] === 'string') texts.push(args[0]);
        return this;
      });
    const pdf = await buildPdf(reversedSnapshot);
    spy.mockRestore();
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const all = texts.join('\n');
    expect(all).toContain("qaytarilgan 500 000 so'm");
    expect(all).toContain('— qaytarildi');
  });
});
