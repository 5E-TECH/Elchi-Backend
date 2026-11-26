import PDFDocument from 'pdfkit';
import { buildDocumentPdf } from './document-pdf';

/** Umumiy hujjat blanki (tasdiqlangan D3). */
const pages = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;

async function draw(o: { title?: string; content: string }) {
  const spy = jest.spyOn(PDFDocument.prototype, 'text');
  try {
    const pdf = await buildDocumentPdf({
      ...o,
      createdAt: new Date('2026-11-24T20:20:00Z'),
      compress: false,
    });
    return { pdf, texts: spy.mock.calls.map((call) => String(call[0])) };
  } finally {
    spy.mockRestore();
  }
}

describe('umumiy hujjat PDF (D3)', () => {
  it("lenta sanasi (Toshkent), sarlavha, kichik sarlavha, ro'yxat, sahifa raqami", async () => {
    const { pdf, texts } = await draw({
      title: 'Smena tartibi',
      content:
        'Birinchi abzas oʻzbekcha.\n\nUMUMIY QOIDALAR\n\n1. Bitta smena.\n1.1) Ichki band\n- tire bandi\n• nuqta bandi\nOddiy qator',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(pdf)).toBe(1);
    expect(pdf.toString('latin1')).toContain('+Manrope-Medium');
    expect(pdf.toString('latin1')).not.toContain('Helvetica');
    expect(texts).toEqual([
      'Sana',
      '25.11.2026',
      'Smena tartibi',
      'Birinchi abzas o‘zbekcha.',
      'UMUMIY QOIDALAR',
      '1.',
      'Bitta smena.',
      '1.1)',
      'Ichki band',
      '•',
      'tire bandi',
      '•',
      'nuqta bandi',
      'Oddiy qator',
      'Elchi Pochta · Smena tartibi · Sahifa 1 / 1',
      'Yaratilgan: 25.11.2026 01:20',
    ]);
  });

  it("sarlavha bo'sh / faqat emoji — «Hujjat»", async () => {
    for (const title of [undefined, '', '   ', '🔥']) {
      const { texts } = await draw({ title, content: 'matn' });
      expect(texts[2]).toBe('Hujjat');
    }
  });

  it("uzun matn sahifalanadi, uzun so'z va sarlavha sig'diriladi, kirill zaxira shriftda", async () => {
    const { pdf, texts } = await draw({
      title: 'Жуда узун сарлавҳа Қўқон '.repeat(40),
      content: `${'Ғалаба қозонган ҳамкорлар 🎉 рўйхати. '.repeat(400)}\n${'y'.repeat(20_000)}\n🎉`,
    });
    const total = pages(pdf);
    expect(total).toBeGreaterThan(5);
    expect(pdf.toString('latin1')).toContain('+NotoSans-Medium');
    expect(texts.filter((text) => text.includes('Sahifa'))).toHaveLength(total);
    expect(texts.join('')).not.toMatch(/\p{Extended_Pictographic}/u);
    const letters = texts.filter((text) => /^y+$/.test(text)).join('');
    expect(letters).toHaveLength(20_000);
  });

  it("chizib bo'lmaydigan matn ham xato bermaydi", async () => {
    const { pdf } = await draw({ title: 'T', content: '漢字 🎉' });
    expect(pages(pdf)).toBe(1);
  });
});
