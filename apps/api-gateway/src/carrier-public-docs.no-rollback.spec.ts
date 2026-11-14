import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { OpenAPIObject } from '@nestjs/swagger';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { CarrierApiKeyGuard } from './auth/carrier-api-key.guard';
import { CarrierThrottlerGuard } from './auth/carrier-throttler.guard';
import { CarrierGatewayController } from './carrier-gateway.controller';
import {
  CARRIER_API_SERVERS,
  CARRIER_SWAGGER_GUIDE,
  buildCarrierSwaggerDocument,
} from './carrier-swagger';

/**
 * QO'RIQ: kompaniyaga ko'rinadigan HECH QAYERDA "rollback" yo'q.
 *
 * Egasi (2026-11-14): Carrier API'dagi rollback (yuborilgan sold/cancelled
 * ni `waiting` ga qaytarish) akkaunt bo'yicha admin toggle'i bilan, sukut
 * bo'yicha O'CHIQ — va kompaniyaga hozircha AYTILMAYDI. Hujjatga tasodifan
 * qaytib kirmasligi uchun shu spec (registrga qaramay) quyidagilarni tekshiradi:
 *
 *  1. Swagger hujjati — `buildCarrierSwaggerDocument` (jonli `/carrier-docs`
 *     va statik spec generatori AYNI funksiya): enum, misollar, summary/tavsif,
 *     qo'llanma (`CARRIER_SWAGGER_GUIDE`), xato tavsiflari, sxema nomlari.
 *  2. `docs/public/` dagi HAR BIR fayl (yangi qo'shilgani ham avtomatik) —
 *     statik `carrier-openapi.json` (CI drift gate'i uni to'liq gateway'dan
 *     qayta yasaydi), `CARRIER_API.md`, `CARRIER_API_QUICKSTART.md`,
 *     `carrier-guide.html` va undan chiqarilgan `Carrier-API-qollanma.pdf`.
 *
 * Ichki fayllar (`INTERNAL_ONLY`) ATAYLAB tekshirilmaydi — u yerda toggle
 * hujjatlangan; ular `docs/public/` ga ko'chirilmasligi tekshiriladi.
 *
 * Rollback'ni kompaniyaga ochish kerak bo'lsa — `docs/ops/carrier-rollback.md`
 * «Ochish (un-hide)» ro'yxati: shu spec ham o'sha ro'yxatda.
 */

const REPO_ROOT = join(__dirname, '../../..');
const PUBLIC_DIR = join(REPO_ROOT, 'docs/public');
const FORBIDDEN = /rollback/i;

/**
 * Ichki (faqat jamoa uchun) — rollback toggle'i shu yerlarda hujjatlangan.
 * Bular tekshirilmaydi, lekin `docs/public/` ga tushmasligi shart.
 */
const INTERNAL_ONLY: readonly string[] = [
  'docs/ops/carrier-rollback.md',
  'docs/BACKEND_MAP.md',
  'docs/frontend/FRONTEND_CHANGELOG.md',
  // Ichki (frontend) Swagger: `/admin/carriers` dagi `rollback_enabled`.
  'docs/frontend/openapi.json',
];

/** Asosiy ommaviy carrier fayllari — mavjudligi va tekshiruvda ekani shart. */
const CARRIER_PUBLIC_FILES: readonly string[] = [
  'docs/public/CARRIER_API.md',
  'docs/public/CARRIER_API_QUICKSTART.md',
  'docs/public/carrier-openapi.json',
  'docs/public/carrier-guide.html',
  'docs/public/Carrier-API-qollanma.pdf',
];

/** `docs/public/` dagi barcha fayllar (ichki papkalar ham), repo-nisbiy yo'l. */
function publicFiles(dir = PUBLIC_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? publicFiles(full)
      : [relative(REPO_ROOT, full).split('\\').join('/')];
  });
}

/**
 * PDF'dagi UTF-16BE hex satrlar (`<FEFF…>`): Chromium ASCII bo'lmagan
 * outline sarlavhalarini (masalan `6.4 POST /carrier/…` — NBSP bilan) va
 * metadata'ni shunday yozadi; latin1 o'qishda ular ko'rinmaydi.
 */
const pdfHexStrings = (raw: string): string[] =>
  [...raw.matchAll(/<FEFF((?:[0-9A-Fa-f]{4})+)>/g)].map(([, hex]) =>
    Buffer.from(hex, 'hex').swap16().toString('utf16le'),
  );

/**
 * Matnli fayl — utf8; ikkilik — latin1 (xom baytlardagi ochiq matn). PDF'da
 * qo'shimcha UTF-16 satrlar ochiladi: outline (sarlavhalar) va metadata
 * to'liq tekshiriladi. Sahifa matni siqilgan va shrift kodlarida — uni bu
 * yerda o'qib bo'lmaydi; manbasi `carrier-guide.html` (u ham shu yerda
 * tekshiriladi), PDF chiqarilganda matn pypdf bilan alohida tekshiriladi.
 */
const readPublic = (file: string): string => {
  const binary = /\.(pdf|png|jpe?g|webp|gif)$/i.test(file);
  const text = readFileSync(join(REPO_ROOT, file), binary ? 'latin1' : 'utf8');
  return /\.pdf$/i.test(file)
    ? [text, ...pdfHexStrings(text)].join('\n')
    : text;
};

/** Topilgan joylar — xabarda qaysi fayl va qaysi qator ekani ko'rinsin. */
const hits = (text: string): string[] =>
  text
    .split('\n')
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => FORBIDDEN.test(line))
    .map(([n, line]) => `${n}: ${line.trim().slice(0, 160)}`);

describe('Carrier API ommaviy hujjatlari — "rollback" yo‘q (yashirin toggle)', () => {
  describe('Swagger (jonli /carrier-docs = statik spec generatori)', () => {
    let app: INestApplication;
    let docs: Array<[string, OpenAPIObject]>;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ThrottlerModule.forRoot({
            throttlers: [{ name: 'default', ttl: 60_000, limit: 1_000_000 }],
          }),
        ],
        controllers: [CarrierGatewayController],
        providers: [
          CarrierThrottlerGuard,
          { provide: 'ORDER', useValue: { send: jest.fn() } },
          { provide: 'LOGISTICS', useValue: { send: jest.fn() } },
          { provide: 'FINANCE', useValue: { send: jest.fn() } },
          { provide: 'INTEGRATION', useValue: { send: jest.fn() } },
        ],
      })
        .overrideGuard(CarrierApiKeyGuard)
        .useValue({ canActivate: () => true })
        .compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      docs = [
        ['jonli /carrier-docs', buildCarrierSwaggerDocument(app)],
        [
          'statik spec (servers bilan)',
          buildCarrierSwaggerDocument(app, { servers: CARRIER_API_SERVERS }),
        ],
      ];
    });

    afterAll(async () => {
      await app?.close();
    });

    it('⭐ hujjatning hech bir joyida (enum, misol, tavsif, sxema nomi) "rollback" yo‘q', () => {
      for (const [name, doc] of docs) {
        expect({ name, hits: hits(JSON.stringify(doc, null, 1)) }).toEqual({
          name,
          hits: [],
        });
      }
    });

    it('status enum’i va misollar — faqat sold / partly_sold / cancelled', () => {
      const [, doc] = docs[0];
      const schema = doc.components?.schemas?.CarrierOrderStatusRequestDto as {
        properties: { status: { enum: string[] } };
      };
      expect(schema.properties.status.enum).toEqual([
        'sold',
        'partly_sold',
        'cancelled',
      ]);
      const op = doc.paths['/carrier/orders/{id}/status'].post as unknown as {
        summary: string;
        requestBody: {
          content: Record<
            string,
            { examples?: Record<string, { value: { status: string } }> }
          >;
        };
      };
      expect(op.summary).toBe(
        'Buyurtma holatini yuborish: sotildi (sold), qisman (partly_sold), bekor (cancelled)',
      );
      const statuses = Object.values(
        op.requestBody.content['application/json'].examples ?? {},
      ).map((example) => example.value.status);
      expect(new Set(statuses)).toEqual(
        new Set(['sold', 'partly_sold', 'cancelled']),
      );
    });

    it('qo‘llanma (CARRIER_SWAGGER_GUIDE) — "rollback" yo‘q', () => {
      expect(hits(CARRIER_SWAGGER_GUIDE)).toEqual([]);
    });
  });

  describe('docs/public/* fayllari', () => {
    const files = publicFiles();

    it('papka topildi; asosiy carrier fayllari (HTML qo‘llanma va PDF ham) tekshiruvda', () => {
      for (const file of CARRIER_PUBLIC_FILES) {
        expect(files).toContain(file);
      }
    });

    it('⭐ har bir ommaviy faylda "rollback" yo‘q — istisnosiz', () => {
      const leaks = Object.fromEntries(
        files
          .map((file) => [file, hits(readPublic(file))] as const)
          .filter(([, found]) => found.length > 0),
      );
      expect(leaks).toEqual({});
    });

    it('PDF: outline sarlavhalari o‘qiladi (UTF-16 ham) — tekshiruv bo‘sh emas', () => {
      const pdf = readPublic('docs/public/Carrier-API-qollanma.pdf');
      // ASCII sarlavha — ochiq satr; NBSP li endpoint sarlavhasi — UTF-16 hex.
      expect(pdf).toContain('(7. Holatlar: sold, partly_sold, cancelled)');
      expect(pdf).toContain('6.4 POST\u00a0/carrier/orders/{id}/status');
    });

    it('ichki fayllar mavjud, docs/public/ da EMAS; toggle ichki qo‘llanmada hujjatlangan', () => {
      for (const file of INTERNAL_ONLY) {
        expect(existsSync(join(REPO_ROOT, file))).toBe(true);
        expect(file.startsWith('docs/public/')).toBe(false);
        expect(files).not.toContain(file);
      }
      const guide = readFileSync(
        join(REPO_ROOT, 'docs/ops/carrier-rollback.md'),
        'utf8',
      );
      expect(guide).toContain('rollback_enabled');
      // Ochish ro'yxati shu spec'ni ham eslatadi.
      expect(guide).toContain('carrier-public-docs.no-rollback.spec.ts');
    });
  });
});
