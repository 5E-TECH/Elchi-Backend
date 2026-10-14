/**
 * IgJ8bzxB — chek/yorliqda brend ELCHI (eski PCS brendi qolmagan).
 *
 * PDF yorliq HAQIQIY pdfkit bilan chiziladi; `text`/`path` chaqiruvlari
 * prototipdagi josus (spy) orqali yoziladi — PDF ichidagi matn shrift
 * glif-id'lari bilan kodlanadi, shuning uchun baytlardan qidirib bo'lmaydi.
 */
import PDFDocument from 'pdfkit';
import {
  BRAND_TEXT,
  renderReceiptHtml,
  renderThermalPdf,
  type PrintRow,
} from './printer.util';
import { ELCHI_LOGO_PATHS, ELCHI_LOGO_VIEWBOX } from './elchi-logo';

const OLD_BRAND = /bee\s*post/i;

const row = (over: Partial<PrintRow> = {}): PrintRow => ({
  id: '31',
  order_number: '1031',
  qr_code_token: 'ORD-31-TOKEN',
  created_at: Date.UTC(2026, 9, 14, 7, 0, 0),
  where_deliver: 'address',
  total_price: 150000,
  comment: 'Tez',
  address: 'Chilonzor 5-kv',
  customer_name: 'Ali Valiyev',
  customer_phone: '998901234567',
  extra_number: '',
  region_name: 'Toshkent',
  district_name: 'Chilonzor',
  market_name: 'Test market',
  market_phone: '998712345678',
  operator: 'Operator',
  products: [{ name: 'Kitob', quantity: 1 }],
  ...over,
});

describe('IgJ8bzxB — yorliq/chek brendi ELCHI', () => {
  it('brend matni — ELCHI', () => {
    expect(BRAND_TEXT).toBe('ELCHI');
  });

  it('logotip — Elchi pdflogo.svg yo`llari (bo`sh emas, faqat absolyut M/C/Z, qora)', () => {
    expect(ELCHI_LOGO_PATHS.length).toBe(7);
    for (const p of ELCHI_LOGO_PATHS) {
      expect(p.d).toMatch(/^M[\d.\- MCZ]+Z$/);
      expect(p.fill).toBe('#000');
    }
    expect(ELCHI_LOGO_VIEWBOX).toEqual({ width: 805.23, height: 730.44 });
  });

  describe('⭐ TC2: HTML chek', () => {
    it('brand-text ELCHI, logo — Elchi SVG, eski brend YO`Q (ekranda ham, sarlavhada ham)', async () => {
      const html = await renderReceiptHtml([row(), row({ id: '32' })]);

      expect(html).toContain('<span class="brand-text">ELCHI</span>');
      expect(html).toContain('<title>Elchi - Chek (2 ta)</title>');
      expect(html).toContain(
        `<svg class="logo-svg" viewBox="0 0 ${ELCHI_LOGO_VIEWBOX.width} ${ELCHI_LOGO_VIEWBOX.height}"`,
      );
      for (const p of ELCHI_LOGO_PATHS) {
        expect(html).toContain(`<path d="${p.d}" fill="#000"/>`);
      }
      expect(html).not.toMatch(OLD_BRAND);
      // Har chekda bittadan brend qatori.
      expect(html.match(/class="brand-text"/g)).toHaveLength(2);
    });
  });

  describe('⭐ TC1: PDF yorliq', () => {
    let textSpy: jest.SpyInstance;
    let pathSpy: jest.SpyInstance;

    beforeEach(() => {
      const proto = PDFDocument.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      textSpy = jest.spyOn(proto, 'text');
      pathSpy = jest.spyOn(proto, 'path');
    });
    afterEach(() => jest.restoreAllMocks());

    it('brandText ELCHI + Elchi logotipi chiziladi, eski brend matni yo`q', async () => {
      const pdf = await renderThermalPdf([row()]);

      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const texts = textSpy.mock.calls.map((call) => String(call[0]));
      expect(texts).toContain('ELCHI');
      expect(texts.filter((t) => OLD_BRAND.test(t))).toEqual([]);
      const drawn = pathSpy.mock.calls.map((call) => String(call[0]));
      expect(drawn).toEqual(ELCHI_LOGO_PATHS.map((p) => p.d));
    });

    it('har sahifada (buyurtmada) bittadan brend', async () => {
      await renderThermalPdf([row(), row({ id: '32' }), row({ id: '33' })]);

      const brandCalls = textSpy.mock.calls.filter(
        (call) => call[0] === 'ELCHI',
      );
      expect(brandCalls).toHaveLength(3);
      expect(pathSpy).toHaveBeenCalledTimes(3 * ELCHI_LOGO_PATHS.length);
    });
  });
});
