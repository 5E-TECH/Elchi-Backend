import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import basicAuth from 'express-basic-auth';

/**
 * CARRIER API UCHUN ALOHIDA SWAGGER — tashqi yetkazuvchi dasturchilari
 * faqat `/carrier/*` endpointlarini ko'radi (`/carrier-docs`).
 *
 * NEGA ALOHIDA. Asosiy Swagger (`/api`) gateway'ning BARCHA ichki
 * marshrutlarini ko'rsatadi va production'da o'chiq (oFfOWGuo). Tashqi
 * kompaniyaga esa ichki API xaritasi kerak emas — faqat o'z kontrakti.
 *
 * Production'da (Docker image doim `NODE_ENV=production`, staging ham) FAQAT
 * aniq yoqilganda va parol berilganda ulanadi: `CARRIER_SWAGGER_ENABLED=true`
 * + `CARRIER_SWAGGER_PASSWORD`. Parolsiz yoqilsa ULANMAYDI (yopiq qoladi) —
 * ochiq hujjat API xaritasini begona skanerlarga ham ko'rsatardi.
 * Dev'da sukut bo'yicha ulanadi; parol bo'lsa Basic Auth.
 */

export const CARRIER_SWAGGER_PATH = 'carrier-docs';
export const CARRIER_API_KEY_SCHEME = 'carrier-api-key';

/** Hujjatga faqat shu prefiksli yo'llar kiradi. */
const CARRIER_PATH_PREFIX = '/carrier/';

/**
 * Qisqa qo'llanma — Swagger sahifasining tepasida ko'rinadi.
 *
 * ⚠️ `docs/public/CARRIER_API_QUICKSTART.md` bilan AYNAN bir xil bo'lishi
 * shart (`carrier-swagger.spec.ts` tekshiradi): fayl dasturchilarga alohida
 * yuboriladi, matn esa ikki joyda ajralib ketmasin. `docs/` Docker image'ga
 * kirmaydi, shu sababli matn kod ichida.
 */
export const CARRIER_SWAGGER_GUIDE = `Elchi Pochta posilkalarini yetkazadigan tashqi kompaniya uchun API. Elchi'da siz **bitta kurier akkaunti** sifatida ishlaysiz: Elchi xodimi buyurtmani sizga biriktiradi, siz posilka QR'ini skanerlaysiz va yetkazish natijasini yuborasiz. Pul sizning kurier kassangizga yoziladi.

## 1. Kirish

Har so'rovda \`X-Api-Key\` sarlavhasi (kalit \`elc_\` bilan boshlanadi, uni Elchi operatori beradi). Kalit faqat bir marta ko'rsatiladi — xavfsiz saqlang.

**Muhitlar.** Avval test muhitida sinang. Test va production — alohida tizimlar: kalit ham, buyurtmalar ham alohida (test kaliti production'da ishlamaydi va aksincha).

| Muhit | \`BASE_URL\` | Interaktiv hujjat (Swagger) |
|---|---|---|
| Test | \`https://test-api.elchipochta.uz\` | \`https://test-api.elchipochta.uz/carrier-docs\` |
| Production | \`https://api.elchipochta.uz\` | \`https://api.elchipochta.uz/carrier-docs\` |

Swagger sahifasining login va parolini Elchi beradi. U yerda **Authorize** tugmasiga kalitni kiritib, so'rovlarni ("Try it out") to'g'ridan-to'g'ri sinash mumkin — so'rov sahifa ochilgan muhitga yuboriladi. Quyidagi misollarda \`BASE_URL\` — tanlangan muhit manzili:

\`\`\`bash
BASE_URL=https://test-api.elchipochta.uz
curl "$BASE_URL/carrier/ping" -H "X-Api-Key: elc_..."
\`\`\`

## 2. Ish oqimi

**1) Skanerlash** — posilkani qo'lingizga olganda:

\`\`\`bash
curl -X POST "$BASE_URL/carrier/scan" \\
  -H "X-Api-Key: elc_..." -H "Content-Type: application/json" \\
  -d '{"qr_token":"a1b2c3d4e5"}'
\`\`\`

Javobda buyurtma (\`data.order\`): mijoz, manzil, tovarlar va **\`cod_amount\` — mijozdan olinadigan naqd**. Viloyat va tuman nomi emas, **SOATO kodi** bilan keladi: \`region.soato_code\` (4 xona), \`district.soato_code\` (7 xona; kod noma'lum bo'lsa \`null\`). Yo'ldagi (yoki mijozni kutishdagi) posilka shu skanda sizga qabul qilinadi (\`status: waiting\`). Sotish va bekor qilish faqat shundan keyin mumkin. \`replacement.old_item_required: true\` — almashtirish: eski mahsulotni oling va sotishda \`old_item_collected: true\` yuboring.

**2) Natijani yuborish** — \`data.order.id\` bilan. **\`Idempotency-Key\` majburiy** — har yangi urinish uchun yangi UUID:

\`\`\`bash
curl -X POST "$BASE_URL/carrier/orders/900/status" \\
  -H "X-Api-Key: elc_..." -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"sold"}'
\`\`\`

| status | Qachon | Qo'shimcha maydonlar |
|---|---|---|
| \`sold\` | To'liq sotildi | — |
| \`partly_sold\` | Qisman sotildi | \`total_price\` (mijoz olgan tovarlar qiymati, onlayn to'langan qism ham ichida), \`items: [{order_item_id, quantity}]\` — buyurtmaning har bir qatori |
| \`cancelled\` | Mijoz olmadi | \`reason\`: \`CUSTOMER_NO_ANSWER\`, \`CUSTOMER_REFUSED\`, \`WRONG_ADDRESS\`, \`DEFECTIVE_PRODUCT\`, \`PRICE_DISPUTE\`, \`OTHER\` (+ \`comment\`) |
| \`rollback\` | Xato yuborilgan sold/cancelled ni qaytarish | — (holat aynan sold yoki cancelled va hisob-kitob yopilmagan bo'lsa) |

**3) Bekor qilinganlarni qaytarish** — \`cancelled\` posilkalar (qisman sotuvning sotilmagan qismi ham) sizda qoladi: \`POST /carrier/returns\` \`{"order_ids":["901"]}\` → qaytarish pochtasi (\`post_id\`); posilkalarni Elchi filialiga topshirasiz. Qaytarilgan posilka \`/carrier/orders\` ro'yxatidan chiqadi.

**4) Solishtirish** — \`GET /carrier/orders\` (sizdagi buyurtmalar) va \`GET /carrier/cashbox\` (balans va oxirgi 30 kunlik harakatlar).

## 3. Muhim qoidalar

- Faqat **sizga biriktirilgan** buyurtmalar ko'rinadi; boshqasiga \`404\`.
- \`Idempotency-Key\`: har **yangi** urinish — yangi kalit; javob kelmasa — **ayni kalit** bilan qayta yuboring (amal ikki marta bajarilmaydi). Rollback'dan keyingi qayta sotuv — yangi kalit (eskisi bilan \`409 CARRIER_IDEMPOTENCY_KEY_STALE\`).
- Limit: akkaunt uchun daqiqada 120 so'rov, barcha endpoint birgalikda, va har endpoint uchun bitta IP'dan 120 (\`429\`). Ro'yxatni bittalab emas, sahifalab oling.
- Xato javobi: \`{ statusCode, message, code?, trace_id }\`. Qarorni matnga emas, \`statusCode\`/\`code\` ga qarab qiling. \`trace_id\` ni saqlang — muammo bo'lsa Elchi'ga yuboring.
- \`409\`, \`429\`, \`5xx\`, \`503\`, \`504\` — biroz kutib, **ayni** \`Idempotency-Key\` bilan qayta urining (\`CARRIER_IDEMPOTENCY_KEY_STALE\` — yangi kalit; 10 daqiqadan uzoq takrorlansa — Elchi'ga). Boshqa \`4xx\` — so'rovni tuzating.
- \`refreshed: false\` — holat qabul qilindi, buyurtmani keyinroq o'qing (qayta yubormang).

## 4. Pul

Sotuvda kassangizga **(mijozdan olingan naqd − yetkazish haqingiz)** yoziladi — bu Elchi'ga topshiriladigan summa. Naqdni topshirganingizda Elchi xodimi qabul qiladi va kassada chiqim paydo bo'ladi (eng eski sotuvlardan boshlab yopiladi). Bekor qilishda pul harakati yo'q. Kassa yozuvi holat yuborilgandan keyin **bir necha soniyada** paydo bo'ladi. Yo'nalish — \`type\` (income/expense), \`amount\` doim musbat.`;

export type CarrierSwaggerSetupResult =
  'mounted' | 'disabled' | 'disabled_no_password';

/** Hujjatdagi `$ref` larni yig'adi (ishlatilmagan sxemalarni olib tashlash uchun). */
function collectRefs(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string') {
      const name = child.split('/').pop();
      if (name) out.add(name);
    } else {
      collectRefs(child, out);
    }
  }
}

/**
 * To'liq gateway hujjatidan faqat `/carrier/*` yo'llarini va ular
 * ishlatadigan sxemalarni qoldiradi. Boshqa marshrutlar, teglar va
 * xavfsizlik sxemalari tashqariga chiqmaydi.
 */
export function filterCarrierDocument(full: OpenAPIObject): OpenAPIObject {
  const paths = Object.fromEntries(
    Object.entries(full.paths ?? {}).filter(([path]) =>
      path.startsWith(CARRIER_PATH_PREFIX),
    ),
  );

  const allSchemas = full.components?.schemas ?? {};
  const used = new Set<string>();
  collectRefs(paths, used);
  // Sxemalar bir-biriga ishora qiladi — yopilguncha kengaytiramiz.
  let size = -1;
  while (used.size !== size) {
    size = used.size;
    for (const name of [...used]) collectRefs(allSchemas[name], used);
  }
  const schemas = Object.fromEntries(
    Object.entries(allSchemas).filter(([name]) => used.has(name)),
  );

  const securitySchemes = Object.fromEntries(
    Object.entries(full.components?.securitySchemes ?? {}).filter(
      ([name]) => name === CARRIER_API_KEY_SCHEME,
    ),
  );

  return {
    ...full,
    paths,
    tags: (full.tags ?? []).filter((tag) => tag.name === 'Carrier'),
    components: { schemas, securitySchemes },
    security: [{ [CARRIER_API_KEY_SCHEME]: [] }],
  };
}

type MediaTypes = Record<string, { schema?: Record<string, unknown> }>;

/**
 * JSON va multipart so'rov tanasini AJRATADI. `@ApiBody` bitta sxema beradi:
 * `allOf: [DTO, { proof: binary }]` — u `application/json` ga ham tushib,
 * kod generatorlari JSON modelida `File` maydonini yasardi. Endi JSON —
 * faqat DTO, multipart — DTO + `proof`.
 */
export function splitMultipartProofBodies(doc: OpenAPIObject): OpenAPIObject {
  for (const pathItem of Object.values(doc.paths ?? {})) {
    for (const op of Object.values(pathItem ?? {})) {
      const content = (op as { requestBody?: { content?: MediaTypes } })
        ?.requestBody?.content;
      const json = content?.['application/json'];
      const allOf = json?.schema?.allOf as
        Array<Record<string, unknown>> | undefined;
      if (!content?.['multipart/form-data'] || !Array.isArray(allOf)) continue;
      const base = allOf.find((part) => typeof part.$ref === 'string');
      if (!base) continue;
      content['application/json'] = { ...json, schema: { ...base } };
    }
  }
  return doc;
}

export type CarrierApiServer = { url: string; description: string };

/**
 * Statik spec (`docs/public/carrier-openapi.json`) serverlari — qo'llanmadagi
 * «Muhitlar» jadvali bilan bir xil manzillar (`carrier-swagger.spec.ts`
 * tekshiradi). Postman / kod generatori server tanlovini shundan oladi.
 */
export const CARRIER_API_SERVERS: readonly CarrierApiServer[] = [
  { url: 'https://api.elchipochta.uz', description: 'Production' },
  {
    url: 'https://test-api.elchipochta.uz',
    description: 'Test muhiti — avval shu yerda sinang (alohida kalit)',
  },
];

/**
 * @param servers statik spec uchun (`scripts/generate-openapi.ts`:
 *   `CARRIER_API_SERVERS`). Jonli `/carrier-docs` da BERILMAYDI — "Try it
 *   out" sahifa ochilgan host'ga yuboradi (test'dan production'ga emas).
 */
export function buildCarrierSwaggerDocument(
  app: INestApplication,
  options: { servers?: readonly CarrierApiServer[] } = {},
): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('Elchi Pochta — Carrier API')
    .setDescription(CARRIER_SWAGGER_GUIDE)
    .setVersion('1.0.0')
    .addApiKey(
      { type: 'apiKey', name: 'X-Api-Key', in: 'header' },
      CARRIER_API_KEY_SCHEME,
    )
    .addTag('Carrier', 'Tashqi yetkazuvchi endpointlari');
  for (const server of options.servers ?? []) {
    builder.addServer(server.url, server.description);
  }
  return splitMultipartProofBodies(
    filterCarrierDocument(SwaggerModule.createDocument(app, builder.build())),
  );
}

/**
 * `CARRIER_SWAGGER_ENABLED` qiymati. Joi (`libs/common/src/config`) bilan bir
 * xil to'plam: true/1/yes — yoqiq, false/0/no — o'chiq, bo'sh — sukut.
 */
export function parseCarrierSwaggerFlag(
  value: unknown,
): 'on' | 'off' | 'default' {
  const flag = (typeof value === 'string' ? value : '').trim().toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return 'on';
  if (flag === 'false' || flag === '0' || flag === 'no') return 'off';
  return 'default';
}

export function setupCarrierSwagger(
  app: INestApplication,
  env: NodeJS.ProcessEnv = process.env,
): CarrierSwaggerSetupResult {
  const isProduction = env.NODE_ENV === 'production';
  const flag = parseCarrierSwaggerFlag(env.CARRIER_SWAGGER_ENABLED);
  const enabled = isProduction ? flag === 'on' : flag !== 'off';
  if (!enabled) return 'disabled';

  const user = String(env.CARRIER_SWAGGER_USER ?? '').trim() || 'carrier';
  const password = String(env.CARRIER_SWAGGER_PASSWORD ?? '');
  if (isProduction && !password) return 'disabled_no_password';

  const document = buildCarrierSwaggerDocument(app);

  if (password) {
    app.use(
      [`/${CARRIER_SWAGGER_PATH}`, `/${CARRIER_SWAGGER_PATH}-json`],
      basicAuth({
        users: { [user]: password },
        challenge: true,
        realm: 'Elchi Carrier API Docs',
      }),
    );
  }

  SwaggerModule.setup(CARRIER_SWAGGER_PATH, app, document, {
    /**
     * FAQAT JSON. Sukut `raw: true` `-yaml` ni ham beradi, Basic Auth esa
     * prefiks bo'yicha ishlaydi va `/carrier-docs-yaml` ni QOPLAMAYDI —
     * production'da parolsiz to'liq spec chiqardi (ultracode review).
     */
    raw: ['json'],
    customSiteTitle: 'Elchi Pochta — Carrier API',
    swaggerOptions: { persistAuthorization: true },
    customJs: [
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-bundle.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-standalone-preset.min.js',
    ],
    customCssUrl: [
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui.min.css',
    ],
  });
  return 'mounted';
}
