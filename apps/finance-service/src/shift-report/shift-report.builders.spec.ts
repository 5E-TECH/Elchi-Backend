import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {
  betweenShiftsLine,
  buildBranchMessage,
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
    /** Sarlavha (`label`) katagi bor qator. */
    const find = (sheet: ExcelJS.Worksheet, label: string) => {
      let found: ExcelJS.Row | undefined;
      sheet.eachRow((row) => {
        const values = row.values as unknown[];
        if (!found && values.includes(label)) found = row;
      });
      return found!;
    };
    const columnOf = (row: ExcelJS.Row, label: string) =>
      (row.values as unknown[]).indexOf(label);
    const result = (cell: ExcelJS.Cell) =>
      cell.formula ? cell.result : cell.value;

    const couriers = workbook.getWorksheet('Kuryerlar')!;
    const header = find(couriers, "Topshirgan, so'm");
    const row = couriers.getRow(header.number + 1);
    const at = (label: string) => result(row.getCell(columnOf(header, label)));
    expect(at('Kuryer')).toBe('Ali');
    expect(at("Topshirgan, so'm")).toBe(700_000);
    expect(at("Qaytarilgan, so'm")).toBe(500_000);
    expect(at("Sof, so'm")).toBe(200_000);
    expect(at("Qolgan qarz, so'm")).toBe(500_000);

    const markets = workbook.getWorksheet('Marketlar')!;
    const list = find(markets, 'Market / vaqt');
    const izoh = columnOf(list, 'Izoh');
    const sum = columnOf(list, "Summa, so'm");
    expect(izoh).toBeGreaterThan(0);
    // Guruh qatori (market, sof jami), keyin uning to'lovlari.
    const line = (offset: number) => markets.getRow(list.number + offset);
    expect(line(1).getCell(columnOf(list, 'Market / vaqt')).value).toBe(
      'Market A',
    );
    expect(result(line(1).getCell(sum))).toBe(0);
    expect(line(2).getCell(sum).value).toBe(300_000);
    expect(line(2).getCell(izoh).value ?? '').toBe('');
    expect(line(3).getCell(sum).value).toBe(-300_000);
    expect(line(3).getCell(izoh).value).toBe('Qaytarildi');

    // PDF shriftli (glif kodlari) — matn `doc.text` chaqiruvlaridan olinadi.
    const spy = jest.spyOn(PDFDocument.prototype, 'text');
    const pdf = await buildPdf(reversedSnapshot);
    const texts = spy.mock.calls.map((call) =>
      String(call[0]).replace(/\u00a0/g, ' '),
    );
    spy.mockRestore();
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(texts).toContain("Qaytarilgan, so'm");
    // Kuryer: topshirgan 700 000, qaytarilgan 500 000, sof 200 000.
    const ali = texts.indexOf('Ali');
    expect(texts.slice(ali, ali + 5)).toEqual([
      'Ali',
      '1',
      '700 000',
      '500 000',
      '200 000',
    ]);
    const reversal = texts.indexOf('Qaytarildi');
    expect(texts[reversal + 1]).toBe('−300 000');
  });
});

describe('filial smenasi — HQ’ga topshirilgan pul', () => {
  const branch: ShiftReportSnapshot = {
    ...snapshot,
    cashbox_type: 'branch',
    cashbox_user_id: '16',
  };

  it('filial xabarida alohida qator (sof, soni; qaytarilgani bilan)', () => {
    expect(
      buildBranchMessage(
        {
          ...branch,
          hq_transfers: { count: 3, total: 21_834_000, reversed: 0 },
        },
        'Andijon',
      ).body.split('\n'),
    ).toContain("⬆️ HQ'ga topshirilgan: 21 834 000 so'm (3 ta)");
    const reversed = buildBranchMessage(
      {
        ...branch,
        hq_transfers: { count: 3, total: 21_834_000, reversed: 500_000 },
      },
      'Andijon',
    );
    expect(reversed.body.split('\n')).toContain(
      "⬆️ HQ'ga topshirilgan: 21 834 000 so'm (3 ta) · qaytarilgan 500 000 so'm",
    );
  });

  it('topshirilmagan / noma’lum / asosiy kassa — qator yo‘q', () => {
    for (const hq_transfers of [
      undefined,
      null,
      { count: 0, total: 0, reversed: 0 },
    ]) {
      expect(
        buildBranchMessage({ ...branch, hq_transfers }, 'Andijon').body,
      ).not.toContain("HQ'ga");
    }
    expect(
      buildBranchMessage(
        { ...snapshot, hq_transfers: { count: 1, total: 5, reversed: 0 } },
        'HQ',
      ).body,
    ).not.toContain("HQ'ga");
  });
});

describe('smenalar orasidagi (smenasiz) harakat', () => {
  it('superadmin va filial xabarida alohida qator; harakat yo‘q — qator yo‘q', () => {
    const gap = {
      from: new Date('2026-11-20T18:00:30Z'),
      to: new Date('2026-11-21T04:00:30Z'),
      income: 50_000,
      expense: 0,
      count: 1,
    };
    const line = betweenShiftsLine({ between_shifts: gap });
    expect(line).toBe(
      "⚠️ Smenalar orasida (smenasiz, 20.11.2026 23:00 → 21.11.2026 09:00): kirim 50 000 so'm, chiqim 0 so'm (1 ta) — ochilish qoldig'ida",
    );
    expect(betweenShiftsLine({ between_shifts: null })).toBeNull();
    const base = snapshot;
    expect(
      buildSuperadminMessage({ ...base, between_shifts: gap }, null).body,
    ).toContain(line!);
    expect(
      buildBranchMessage({ ...base, between_shifts: gap }, 'Chilonzor').body,
    ).toContain(line!);
    expect(buildBranchMessage(base, 'Chilonzor').body).not.toContain(
      'Smenalar orasida',
    );
  });
});
