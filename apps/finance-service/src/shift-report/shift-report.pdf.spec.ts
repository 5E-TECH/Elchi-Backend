import PDFDocument from 'pdfkit';
import type { ShiftReportSnapshot } from './shift-report.builders';
import { buildReportFile } from './shift-report.file';
import { buildPdf } from './shift-report.pdf';

/**
 * Smena hisoboti PDF'i (tasdiqlangan D1 — asosiy kassa, D2 — filial): matn
 * `doc.text` chaqiruvlaridan, sahifa / shrift — hujjat baytlaridan olinadi.
 */

const AT = (time: string) => new Date(`2026-11-24T${time}:00+05:00`);
let nextId = 1;
const pay = (
  amount: number,
  payment_method = 'cash',
  o: { card_name?: string; reversed?: boolean } = {},
) => ({
  history_id: String(nextId++),
  amount,
  payment_method,
  card_name: o.card_name ?? null,
  at: AT('12:30'),
  ...(o.reversed ? { reversed: true } : {}),
});

const MAIN: ShiftReportSnapshot = {
  shift_id: '16',
  round: 1,
  cashbox_type: 'main',
  cashbox_user_id: '0',
  opened_at: AT('08:57'),
  closed_at: AT('21:12'),
  opened_by: '9',
  opened_by_name: 'Dilnoza Karimova',
  closed_by: '9',
  closed_by_name: 'Dilnoza Karimova',
  close_reason: 'manual',
  cash: {
    opening_balance: 1_000_000,
    total_income: 8_000_000,
    total_expense: 3_000_000,
    expected_balance: 5_500_000,
    closing_balance: 5_500_000,
    discrepancy: 0,
  },
  card: {
    opening_balance: 2_000_000,
    total_income: 1_000_000,
    total_expense: 500_000,
    expected_balance: 3_000_000,
    closing_balance: 2_750_000,
    discrepancy: -250_000,
  },
  accounts: [
    {
      card_id: '51',
      name: 'Humo asosiy',
      last4: '0092',
      expected_balance: 3_000_000,
      entered_balance: 2_750_000,
      difference: -250_000,
      ai_status: 'mismatch',
    },
  ],
  couriers: [
    {
      courier_id: '41',
      name: 'Ali Valiyev',
      count: 3,
      received: 2_000_000,
      reversed: 400_000,
      total: 1_600_000,
      remaining_debt: 1_125_000,
    },
  ],
  markets: [
    {
      market_id: '71',
      name: 'Baraka Shop',
      payments: [
        pay(2_500_000),
        pay(300_000, 'click_to_market', { card_name: 'Uzcard •4417' }),
        pay(-300_000, 'click_to_market', { reversed: true }),
      ],
      total: 2_500_000,
      balance: 640_000,
    },
  ],
  branches: [
    {
      branch_id: '3',
      name: 'Andijon',
      payments: [
        pay(6_000_000),
        pay(1_000_000, 'click'),
        pay(-200_000, 'cash', { reversed: true }),
      ],
      total: 6_800_000,
      balance: 1_240_000,
    },
  ],
  between_shifts: {
    from: AT('01:00'),
    to: AT('08:57'),
    income: 1_500_000,
    expense: 300_000,
    count: 3,
  },
};

const NONE = {
  opening_balance: 0,
  total_income: 0,
  total_expense: 0,
  expected_balance: 0,
  closing_balance: 0,
  discrepancy: null,
};
const BRANCH: ShiftReportSnapshot = {
  ...MAIN,
  shift_id: '217',
  cashbox_type: 'branch',
  cashbox_user_id: '3',
  closed_at: AT('23:59'),
  closed_by: null,
  closed_by_name: null,
  close_reason: 'auto',
  cash: {
    opening_balance: 1_860_000,
    total_income: 2_240_000,
    total_expense: 6_400_000,
    expected_balance: -2_300_000,
    closing_balance: 0,
    discrepancy: null,
  },
  card: NONE,
  accounts: [],
  branches: undefined,
  between_shifts: null,
};

const pages = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;

async function draw(snapshot: ShiftReportSnapshot) {
  const spy = jest.spyOn(PDFDocument.prototype, 'text');
  try {
    const pdf = await buildPdf(snapshot, {
      createdAt: new Date('2026-11-24T16:13:00Z'),
      compress: false,
    });
    const texts = spy.mock.calls.map((call) =>
      String(call[0]).replace(/\u00a0/g, ' '),
    );
    /** Jadval qatori: yorliqdan keyingi `count` ta katak. */
    const after = (label: string, count = 1) =>
      texts.slice(texts.indexOf(label) + 1, texts.indexOf(label) + 1 + count);
    return { pdf, texts, after, all: texts.join('\n') };
  } finally {
    spy.mockRestore();
  }
}

describe('smena hisoboti PDF — asosiy kassa (D1)', () => {
  it('lenta, kassa hisobi, farq, manbalar va qaytarilganlar', async () => {
    const { pdf, texts, after, all } = await draw(MAIN);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const raw = pdf.toString('latin1');
    for (const font of ['Manrope-Medium', 'Manrope-SemiBold', 'Manrope-Bold']) {
      expect(raw).toContain(`+${font}`);
    }
    expect(raw).not.toContain('Helvetica');

    expect(texts).toContain('Asosiy kassa — smena hisoboti');
    expect(texts).toContain('24.11.2026 · 08:57–21:12');
    expect(texts).toContain("Qo'lda — Dilnoza Karimova");
    expect(texts).toContain('Yaratilgan: 24.11.2026 21:13');
    // KPI: jami sanalgan, farq; naqd + karta + jami ustunlari.
    expect(after("Sanalgan qoldiq, so'm")).toEqual(['8 250 000']);
    expect(after("Farq, so'm", 2)).toEqual([
      '−250 000',
      'Naqd 0 · karta −250 000',
    ]);
    expect(after("Ochilish qoldig'i", 3)).toEqual([
      '1 000 000',
      '2 000 000',
      '3 000 000',
    ]);
    // 1 000 000 + 8 000 000 − 3 000 000 − 500 000 = 5 500 000.
    expect(after('Konvertatsiya (±)', 3)).toEqual([
      '−500 000',
      '+500 000',
      '0',
    ]);
    expect(after('Farq', 8)).toEqual([
      'Holat',
      '0',
      'Mos',
      '−250 000',
      'Kamomad',
      '−250 000',
      'Kamomad',
      'Kirim manbalari',
    ]);
    expect(all).toContain(
      "Farq bor: karta −250 000 so'm (kamomad)\nHumo asosiy •0092: tizimda 3 000 000, kiritilgan 2 750 000 (AI: mos emas).",
    );
    expect(texts).toContain(
      'Smenalar orasida (smenasiz) harakat: 24.11.2026 01:00 → 24.11.2026 08:57',
    );
    // Manbalar: jami 9 000 000 va 3 500 000; qolgani — «Boshqa».
    expect(after('Filiallardan qabul', 2)).toEqual(['7 000 000', '77,8%']);
    expect(after('Kuryerlardan qabul', 2)).toEqual(['2 000 000', '22,2%']);
    expect(after('Marketdan qaytgan', 2)).toEqual(['300 000', '3,3%']);
    expect(after('Boshqa kirim')).toEqual(['−300 000']);
    expect(after("Marketlarga to'lov")).toEqual(['2 800 000']);
    expect(after('Filialga qaytarilgan')).toEqual(['200 000']);
    expect(after('Kuryerga qaytarilgan')).toEqual(['400 000']);
    expect(after('Boshqa chiqim')).toEqual(['100 000']);
    // Filial: soni, naqd, karta, qaytarilgan, sof, qoldiq.
    expect(after('Andijon', 6)).toEqual([
      '2',
      '6 000 000',
      '1 000 000',
      '200 000',
      '6 800 000',
      '1 240 000',
    ]);
    expect(after('Ali Valiyev', 5)).toEqual([
      '3',
      '2 000 000',
      '400 000',
      '1 600 000',
      '1 125 000',
    ]);
    expect(after('Baraka Shop', 3)).toEqual([
      "3 ta to'lov",
      '2 500 000',
      '640 000',
    ]);
    expect(after('Qaytarildi')).toEqual(['−300 000']);
    expect(texts).toContain("Kartaga o'tkazma");
    expect(texts).toContain('Mos emas');
    expect(texts).toContain('Topshirdi: Dilnoza Karimova');
    // Xom kodlar chiqmaydi.
    expect(all).not.toMatch(/click|mismatch|manual/);
  });

  it("«Tizim (avtomatik)» ochgan; avto-yopilgan — pul sanalmagan, imzo bo'sh", async () => {
    const block = { discrepancy: null, closing_balance: 0 };
    const { texts, after } = await draw({
      ...MAIN,
      opened_by_system: true,
      opened_by_name: null,
      close_reason: 'auto',
      closed_by: null,
      closed_by_name: 'Boshqa odam',
      cash: { ...MAIN.cash, ...block },
      card: { ...MAIN.card, ...block },
    });
    expect(texts).toContain('Tizim (avtomatik)');
    expect(texts).toContain('Avtomatik — 21:12, kassir yopmagan');
    expect(texts).toContain('Avtomatik yopildi — 21:12, kassir yopmagan');
    expect(after("Kutilgan qoldiq, so'm")).toEqual(['8 500 000']);
    expect(texts).toContain('Sanalmadi');
    expect(after('Sanalgan (topshirilgan)', 3)).toEqual([
      'sanalmadi',
      'sanalmadi',
      'sanalmadi',
    ]);
    expect(texts.some((text) => text.startsWith('Farq bor'))).toBe(false);
    expect(texts).toContain('Topshirdi:');
    expect(texts.join('\n')).not.toContain('Boshqa odam');
  });

  it("bo'sh smena — bitta sahifa, «yo'q» yozuvlari", async () => {
    const zero = { ...NONE, discrepancy: 0 };
    const { pdf, texts } = await draw({
      ...MAIN,
      opened_by: null,
      opened_by_name: null,
      cash: zero,
      card: zero,
      accounts: [],
      couriers: [],
      markets: [],
      branches: [],
      between_shifts: null,
    });
    expect(pages(pdf)).toBe(1);
    expect(texts).toContain("Bu smenada kuryerlardan qabul yo'q");
    expect(texts).toContain("Bu smenada marketlarga to'lov yo'q");
    expect(texts).not.toContain('Filiallar');
    expect(texts).not.toContain('Kartalar va hisoblar');
  });

  it("noma'lum qiymatlar (null, NaN) yiqitmaydi — «—»", async () => {
    const unknown = {
      opening_balance: null,
      total_income: null,
      total_expense: null,
      expected_balance: null,
      closing_balance: null,
      discrepancy: null,
    };
    const { texts, after } = await draw({
      ...MAIN,
      closed_at: null,
      cash: unknown,
      card: { ...unknown, total_income: Number.NaN },
      couriers: [{ ...MAIN.couriers[0], name: null, remaining_debt: null }],
    });
    expect(after("Ochilish qoldig'i", 3)).toEqual(['—', '—', '—']);
    expect(texts).not.toContain('Konvertatsiya (±)');
    expect(texts).toContain('#41');
    expect(texts.join('\n')).not.toMatch(/NaN|undefined|null/);
  });
});

describe('smena hisoboti PDF — filial kassasi (D2)', () => {
  it("bitta sahifa; filial nomi; bitta jami — karta / kartalar / filiallar bo'limi yo'q (63HO6cBU)", async () => {
    const { pdf, texts, after } = await draw({
      ...BRANCH,
      branch_name: 'Andijon',
      // Snapshot'da bo'lsa ham filial hisobotiga tushmaydi.
      card: { ...MAIN.card, total_income: 77_777_777 },
      accounts: MAIN.accounts,
      branches: MAIN.branches,
    });
    expect(pages(pdf)).toBe(1);
    expect(texts).toContain('Andijon filiali kassasi');
    expect(texts).toContain('Smena hisoboti · 24.11.2026 · 08:57–23:59');
    expect(after("Ochilish qoldig'i")).toEqual(['1 860 000']);
    expect(after('Holat', 2)).toEqual(['sanalmadi', 'Kassir sanamagan']);
    expect(after('Kirim − chiqim')).toEqual(['−4 160 000']);
    for (const text of [
      "Karta, so'm",
      'Kartalar va hisoblar',
      'Filiallar',
      'Humo asosiy •0092',
      'Filiallardan qabul',
    ]) {
      expect(texts).not.toContain(text);
    }
    expect(texts.join('\n')).not.toContain('77 777 777');
  });

  it("nom olinmagan — «Filial kassasi #id»; HQ summasi yo'q — «Boshqa» ichida", async () => {
    const { texts, after } = await draw(BRANCH);
    expect(texts).toContain('Filial kassasi #3');
    // 6 400 000 − 2 800 000 (market) − 400 000 (kuryerga qaytarilgan).
    expect(after("Boshqa (HQ'ga, xarajat)")).toEqual(['−3 200 000']);
    expect(texts.some((text) => text.startsWith("HQ'ga"))).toBe(false);
  });

  it("HQ'ga topshirilgan — alohida qator (yalpi), qaytgani — kirim; «Boshqa» shuni ayirib", async () => {
    const { after, texts } = await draw({
      ...BRANCH,
      branch_name: 'Chilonzor filiali',
      hq_transfers: { count: 2, total: 2_500_000, reversed: 200_000 },
    });
    expect(texts).toContain('Chilonzor filiali kassasi');
    expect(after("HQ'ga topshirilgan (2 ta)")).toEqual(['−2 700 000']);
    expect(after("HQ'dan qaytgan")).toEqual(['+200 000']);
    expect(after('Boshqa chiqim')).toEqual(['−500 000']);
    // 2 240 000 − 2 000 000 (kuryer) − 300 000 (marketdan) − 200 000 (HQ).
    expect(after('Boshqa kirim')).toEqual(['−260 000']);
  });

  it("qo'lda yopilgan, kamomad bilan", async () => {
    const { texts } = await draw({
      ...BRANCH,
      close_reason: 'manual',
      closed_by: '31',
      closed_by_name: null,
      cash: { ...BRANCH.cash, closing_balance: 900_000, discrepancy: -80_000 },
    });
    expect(texts).toContain("Qo'lda — #31");
    expect(texts).toContain("Kamomad: −80 000 so'm");
    expect(texts).toContain('Kamomad bor');
  });
});

describe('smena hisoboti PDF — chidamlilik', () => {
  it('30 filial, 40 kuryer, bitta marketga 63 to‘lov, kirill / emoji nomlar, milliardlar', async () => {
    const big: ShiftReportSnapshot = {
      ...MAIN,
      branches: Array.from({ length: 30 }, (_, i) => ({
        branch_id: String(i + 1),
        name: i === 0 ? 'Қўқон шаҳри ғарбий филиали' : i === 1 ? '🔥🔥' : null,
        payments: [pay(1_234_567_890), pay(9_876_543_210, 'click')],
        total: 11_111_111_100,
        balance: i % 2 ? null : 1_500_000_000,
      })),
      couriers: Array.from({ length: 40 }, (_, i) => ({
        courier_id: String(100 + i),
        name: i ? `😀 Ҳамидов Ғайрат ${i}` : 'x'.repeat(500),
        count: i,
        total: 1_000_000 * i,
        remaining_debt: null,
      })),
      accounts: Array.from({ length: 25 }, (_, i) => ({
        ...MAIN.accounts[0],
        card_id: String(i),
        name: `Juda uzun karta nomi ${i}`,
      })),
      markets: [
        {
          market_id: '1',
          name: '«Oʻzbegim Elektronika» MCHJ '.repeat(10),
          payments: Array.from({ length: 63 }, () => pay(1_000_000)),
          total: 63_000_000,
          balance: null,
        },
        {
          market_id: '2',
          name: null,
          payments: [pay(5, 'nomalum_usul')],
          total: 5,
          balance: 0,
        },
      ],
    };
    const { pdf, texts, all } = await draw(big);
    expect(pages(pdf)).toBeGreaterThanOrEqual(5);
    expect(pages(pdf)).toBeLessThanOrEqual(9);
    const raw = pdf.toString('latin1');
    expect(raw).toContain('+NotoSans-Bold');
    expect(texts).toContain("… yana 13 ta to'lov — Excel hisobotda");
    expect(texts).toContain('63 000 005');
    expect(texts).toContain('1 234 567 890');
    // Faqat emoji bo'lgan nom o'rniga — id.
    expect(texts).toContain('#2');
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(texts).toContain('Yana 17 ta karta — jadvalda.');
    // Har sahifada raqam.
    const total = pages(pdf);
    for (let i = 1; i <= total; i += 1) {
      expect(texts).toContain(
        `Elchi Pochta · Smena #16 · Sahifa ${i} / ${total}`,
      );
    }
  });

  it('`buildReportFile(pdf)` — o‘sha PDF (siqilgan)', async () => {
    const pdf = await buildReportFile(MAIN, 'pdf');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeLessThan(120_000);
  });
});
