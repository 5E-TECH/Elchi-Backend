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
 *     qayta yasaydi), `CARRIER_API.md`, `CARRIER_API_QUICKSTART.md` va h.k.
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

/**
 * Keyingi bosqichda yangilanadigan ommaviy fayllar (HTML qo'llanma va undan
 * chiqarilgan PDF). Ro'yxat VAQTINCHALIK: fayl tozalangach shu yerdan olib
 * tashlang — shunda u ham to'liq tekshiruvga tushadi (pastdagi test eskirgan
 * yozuvni o'zi aytadi).
 */
const PENDING_REGENERATION: Readonly<Record<string, string>> = {
  'docs/public/carrier-guide.html':
    'HTML qo‘llanma alohida bosqichda qayta yoziladi',
  'docs/public/Carrier-API-qollanma.pdf':
    'PDF carrier-guide.html dan qayta chiqariladi',
};

/** `docs/public/` dagi barcha fayllar (ichki papkalar ham), repo-nisbiy yo'l. */
function publicFiles(dir = PUBLIC_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? publicFiles(full)
      : [relative(REPO_ROOT, full).split('\\').join('/')];
  });
}

/** Matnli fayl — utf8; ikkilik (PDF) — latin1 (xom baytlardagi ochiq matn). */
const readPublic = (file: string): string =>
  readFileSync(
    join(REPO_ROOT, file),
    /\.(pdf|png|jpe?g|webp|gif)$/i.test(file) ? 'latin1' : 'utf8',
  );

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

    it('papka topildi; asosiy carrier fayllari tekshiruvda', () => {
      for (const file of [
        'docs/public/CARRIER_API.md',
        'docs/public/CARRIER_API_QUICKSTART.md',
        'docs/public/carrier-openapi.json',
      ]) {
        expect(files).toContain(file);
        expect(Object.keys(PENDING_REGENERATION)).not.toContain(file);
      }
    });

    it('⭐ har bir ommaviy faylda "rollback" yo‘q (kutilayotganlardan tashqari)', () => {
      const leaks = Object.fromEntries(
        files
          .filter((file) => !(file in PENDING_REGENERATION))
          .map((file) => [file, hits(readPublic(file))] as const)
          .filter(([, found]) => found.length > 0),
      );
      expect(leaks).toEqual({});
    });

    it('kutilayotgan (keyingi bosqich) ro‘yxati eskirmagan — tozalangan fayl ro‘yxatdan olib tashlansin', () => {
      const stale = Object.keys(PENDING_REGENERATION).filter(
        (file) =>
          !existsSync(join(REPO_ROOT, file)) ||
          !FORBIDDEN.test(readPublic(file)),
      );
      expect(stale).toEqual([]);
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
