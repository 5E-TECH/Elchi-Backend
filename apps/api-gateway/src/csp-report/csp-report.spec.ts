import {
  CSP_REPORT_MAX_PER_REQUEST,
  extractCspViolations,
  safeReportUrl,
} from './csp-report';

/**
 * KwodkKWY — CSP hisobotini tozalash (sof funksiyalar). Tana ishonchsiz:
 * logga faqat query'siz URL, direktiva nomi, qisqa namuna chiqadi.
 */
describe('KwodkKWY — CSP hisobotini tozalash', () => {
  describe('safeReportUrl', () => {
    it.each([
      [
        'https://elchipochta.uz/orders?phone=998901234567#x',
        'https://elchipochta.uz/orders',
      ],
      [
        'https://api.qrserver.com/v1/create-qr-code/?data=TOKEN123',
        'https://api.qrserver.com/v1/create-qr-code/',
      ],
      [
        'wss://api.elchipochta.uz/socket.io/',
        'wss://api.elchipochta.uz/socket.io/',
      ],
      // Token/UUID ko'rinishidagi bo'lak — `:id`; oddiy so'z va raqam qoladi.
      [
        'https://elchipochta.uz/s/9f8e7d6c5b4a39281706f5e4d3c2b1a0/view',
        'https://elchipochta.uz/s/:id/view',
      ],
      [
        'https://elchipochta.uz/financial-balance/12345',
        'https://elchipochta.uz/financial-balance/12345',
      ],
      ['inline', 'inline'],
      ['eval', 'eval'],
      ['data:image/png;base64,AAAA', 'data'],
      ['blob:https://elchipochta.uz/0b1c-uuid', 'blob'],
      ['chrome-extension://abcdefghijklmnop/content.js', 'chrome-extension'],
    ])('%s → %s', (input, expected) => {
      expect(safeReportUrl(input)).toBe(expected);
    });

    it.each([[''], ['   '], [42], [null], [{}], ['not a url with spaces']])(
      'yaroqsiz %p → null',
      (input) => {
        expect(safeReportUrl(input)).toBeNull();
      },
    );

    it('juda uzun yo‘l qisqartiriladi (≤256 + …)', () => {
      const out = safeReportUrl(`https://elchipochta.uz/${'a'.repeat(1000)}`);
      expect(out!.length).toBeLessThanOrEqual(257);
    });
  });

  describe('extractCspViolations', () => {
    it('⭐ report-uri (application/csp-report) — tozalangan maydonlar, original-policy yo‘q', () => {
      const out = extractCspViolations({
        'csp-report': {
          'document-uri': 'https://elchipochta.uz/orders?token=abc',
          referrer: 'https://elchipochta.uz/login?next=/orders',
          'violated-directive': "img-src 'self' data:",
          'effective-directive': 'img-src',
          'original-policy': "default-src 'self'; img-src 'self'",
          disposition: 'report',
          'blocked-uri':
            'https://api.qrserver.com/v1/create-qr-code/?data=7001',
          'status-code': 200,
          'source-file': 'https://elchipochta.uz/assets/index-abc.js?v=1',
          'line-number': 12,
          'column-number': '34',
          'script-sample': '',
        },
      });
      expect(out).toEqual({
        violations: [
          {
            format: 'report-uri',
            document_uri: 'https://elchipochta.uz/orders',
            referrer: 'https://elchipochta.uz/login',
            blocked_uri: 'https://api.qrserver.com/v1/create-qr-code/',
            effective_directive: 'img-src',
            violated_directive: 'img-src',
            disposition: 'report',
            source_file: 'https://elchipochta.uz/assets/index-abc.js',
            line_number: 12,
            column_number: 34,
            status_code: 200,
            sample: null,
            count: 1,
          },
        ],
        ignored: 0,
        dropped: 0,
      });
      expect(JSON.stringify(out)).not.toContain('original');
    });

    it('⭐ report-to (application/reports+json) — faqat csp-violation; takrorlar count bilan birlashadi', () => {
      const csp = {
        type: 'csp-violation',
        age: 10,
        url: 'https://elchipochta.uz/tg/scan?tgWebAppData=secret',
        user_agent: 'Mozilla/5.0',
        body: {
          blockedURL: 'inline',
          disposition: 'report',
          effectiveDirective: 'script-src-elem',
          lineNumber: 93,
          sample: 'console.log("hi")',
          statusCode: 200,
        },
      };
      const out = extractCspViolations([
        csp,
        csp,
        { type: 'deprecation', body: { id: 'x' } },
        'garbage',
      ]);
      expect(out.ignored).toBe(2);
      expect(out.dropped).toBe(0);
      expect(out.violations).toEqual([
        expect.objectContaining({
          format: 'report-to',
          document_uri: 'https://elchipochta.uz/tg/scan',
          blocked_uri: 'inline',
          effective_directive: 'script-src-elem',
          line_number: 93,
          sample: 'console.log("hi")',
          count: 2,
        }),
      ]);
    });

    it('namuna: boshqaruv belgilari olib tashlanadi, ≤80 belgi', () => {
      const out = extractCspViolations({
        'csp-report': {
          'effective-directive': 'script-src',
          'blocked-uri': 'inline',
          'script-sample': `<script>\u0000\nalert(1)</script>${'x'.repeat(200)}`,
        },
      });
      const sample = out.violations[0].sample!;
      expect(sample.startsWith('<script>')).toBe(true);
      expect(sample).not.toMatch(/\p{Cc}/u);
      expect(sample.length).toBeLessThanOrEqual(81);
    });

    it('direktiva ham, manba ham yo‘q / noto‘g‘ri shakl — e’tiborsiz', () => {
      expect(extractCspViolations({ 'csp-report': {} })).toEqual({
        violations: [],
        ignored: 1,
        dropped: 0,
      });
      expect(extractCspViolations({ foo: 1 }).ignored).toBe(1);
      expect(extractCspViolations(null).ignored).toBe(1);
      expect(
        extractCspViolations({
          'csp-report': { 'effective-directive': 'img_src;DROP TABLE' },
        }).violations,
      ).toEqual([]);
    });

    it(`bitta so‘rovdan ko‘pi bilan ${CSP_REPORT_MAX_PER_REQUEST} ta takrorlanmas buzilish, qolgani dropped`, () => {
      const items = Array.from(
        { length: CSP_REPORT_MAX_PER_REQUEST + 5 },
        (_, i) => ({
          type: 'csp-violation',
          body: {
            effectiveDirective: 'img-src',
            blockedURL: `https://cdn${i}.example.com/a.png`,
          },
        }),
      );
      const out = extractCspViolations(items);
      expect(out.violations).toHaveLength(CSP_REPORT_MAX_PER_REQUEST);
      expect(out.dropped).toBe(5);
    });
  });
});
