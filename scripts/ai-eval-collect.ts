/**
 * J3hEDtFN #1 — prod xatolari va operator tuzatishlaridan eval fixture
 * NOMZODLARINI yig'ish (FAQAT O'QISH, PII maskalangan).
 *
 * Manbalar (oxirgi N kun, sukut 30 — draft matni 30 kundan keyin
 * tozalanadi, `AI_DRAFT_TEXT_RETENTION_DAYS`):
 *  - `ai_schema.ai_order_draft` — outcome != 'ok' (ai_error, truncated,
 *    refused, invalid_json, network, cap_exceeded) VA operator tuzatgan
 *    draftlar (`ai_order_draft_item.edited_fields` bo'sh emas);
 *  - `ai_order_draft_item.field_corrections` — AI taklifi vs operator
 *    tasdiqlagan qiymat (kutilgan natijaning manbai). ⚠️ 30 kundan keyin
 *    `source_text` va tuzatishlardagi PII yo'q — matn↔kutilgan natija
 *    juftlari (golden set) faqat 30 kun ichida yig'iladi; 30–365 kun
 *    oralig'idagi tuzatishlar faqat agregat statistika uchun
 *    (`scripts/ai/eval-aggregates.sql`, #641 bilan keladi);
 *  - `ai_schema.ai_usage_log` — draft bo'yicha chaqiruvlar/outcome/stop_reason.
 * Gateway darajasidagi xatolar (timeout, no_market, disabled) ai_usage_log /
 * draft'ga tushmaydi — ular uchun gateway logi kerak (bu skript qamramaydi).
 *
 * ⚠️ MAXFIYLIK: `source_text` da telefonlar allaqachon `[TEL_n]`; skript
 * qo'shimcha ravishda email, ijtimoiy tarmoq / xarita / WhatsApp havolasi,
 * @foydalanuvchi, ism (AI/operator customer_name va operator qiymatlari,
 * qo'shimchalari va murojaatsiz o'zagi bilan), pasport seriyasi, 9+
 * raqamli ketma-ketliklar (100 mln dan katta narx ham!), kalit so'z
 * yonidagi uy/xonadon raqamlarini maskalaydi. QOLADIGAN PII (odam
 * ko'radi; to'liq ro'yxat — docs/ai/PROD_EVAL_EXPORT.md §2): ro'yxatda
 * yo'q ism, @ siz foydalanuvchi nomi, boshqa domen havolasi, to'liq
 * kenglikdagi raqamlar, 7 raqamli shahar telefoni, vergul bilan
 * ajratilgan raqamlar, havoladan tashqari koordinata, tug'ilgan sana,
 * manzil (ko'cha/mahalla), kalit so'zsiz uy raqami. Natija
 * FAQAT repo'dan TASHQARIDAGI katalogga (`--out`) yoziladi — odam
 * ko'rib chiqib, sintetik ko'rinishga keltirib, keyin
 * `apps/ai-service/test/fixtures/order-extract/` ga qo'shadi (source:
 * 'prod-masked'). Repo ichiga yozish RAD etiladi.
 *
 * Ishga tushirish (SERVERDA, faqat o'qish):
 *   POSTGRES_URI=... npx ts-node -r tsconfig-paths/register \
 *     scripts/ai-eval-collect.ts --out=/root/ai-eval-candidates [--days=30] [--limit=200]
 *   Tahrirlanmagan tasdiqlardan 5% namuna (alohida katalogga; seed majburiy —
 *   bir xil seed bir xil to'plam beradi):
 *     ... scripts/ai-eval-collect.ts --out=/root/ai-eval-unedited --sample-unedited=0.05 --seed=2026-11
 */
import 'reflect-metadata';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';

const REPO_ROOT = resolve(__dirname, '..');

export const COLLECT_SQL = `
  SELECT d.id::text AS draft_id,
         d.created_at,
         d.source_kind,
         d.source_text,
         d.image_count,
         d.model,
         d.prompt_version,
         d.outcome,
         d.raw_extraction,
         d.resolved_preview,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'item_index', i.item_index,
                    'edited_fields', i.edited_fields,
                    'field_corrections', i.field_corrections))
           FROM ai_schema.ai_order_draft_item i
           WHERE i.draft_id = d.id
         ), '[]'::json) AS items,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'feature', u.feature, 'outcome', u.outcome,
                    'stop_reason', u.stop_reason, 'steps', u.steps,
                    'latency_ms', u.latency_ms))
           FROM ai_schema.ai_usage_log u
           WHERE u.draft_id = d.id AND u.is_deleted = false
         ), '[]'::json) AS calls
  FROM ai_schema.ai_order_draft d
  WHERE d.created_at >= now() - ($1::int * interval '1 day')
    AND d.source_text IS NOT NULL
    AND (
      d.outcome <> 'ok'
      OR EXISTS (
        SELECT 1 FROM ai_schema.ai_order_draft_item i
        WHERE i.draft_id = d.id
          -- JSON 'null' / skalyar: jsonb_array_length xato bermasin
          -- (CASE — AND tartibi Postgres'da kafolatlanmagan).
          AND CASE WHEN jsonb_typeof(i.edited_fields) = 'array'
                   THEN jsonb_array_length(i.edited_fields) > 0
                   ELSE false END
      )
    )
  ORDER BY d.created_at DESC
  LIMIT $2::int
`;

/**
 * `--sample-unedited=0.05`: operator HECH NARSA o'zgartirmay tasdiqlagan
 * draftlardan tasodifiy ulush ($3) — "jim xato" (AI xato, operator ko'rmadi)
 * ulushini qo'lda baholash uchun. Kutilgan natija = AI taklifi (tasdiqlangan),
 * belgilovchi uni matn bilan solishtiradi.
 */
export const UNEDITED_SAMPLE_SQL = `
  SELECT d.id::text AS draft_id,
         d.created_at,
         d.source_kind,
         d.source_text,
         d.image_count,
         d.model,
         d.prompt_version,
         d.outcome,
         d.raw_extraction,
         d.resolved_preview,
         (
           SELECT json_agg(json_build_object(
                    'item_index', i.item_index,
                    'edited_fields', i.edited_fields,
                    'field_corrections', i.field_corrections))
           FROM ai_schema.ai_order_draft_item i
           WHERE i.draft_id = d.id
         ) AS items,
         '[]'::json AS calls
  FROM ai_schema.ai_order_draft d
  WHERE d.created_at >= now() - ($1::int * interval '1 day')
    AND d.source_text IS NOT NULL
    AND d.outcome = 'ok'
    AND EXISTS (
      SELECT 1 FROM ai_schema.ai_order_draft_item i WHERE i.draft_id = d.id
    )
    -- "Tahrirlanmagan" = HAR bog'langan buyurtma preview bilan solishtirilgan
    -- (edited_fields NULL emas, item_index bor) va bo'sh. NULL —
    -- "solishtirib bo'lmadi", tahrirlanmagan EMAS.
    AND NOT EXISTS (
      SELECT 1 FROM ai_schema.ai_order_draft_item i
      WHERE i.draft_id = d.id
        AND (i.edited_fields IS NULL
             OR i.item_index IS NULL
             -- JSON 'null' / skalyar — "solishtirib bo'lmadi" (NULL kabi);
             -- jsonb_array_length faqat massivda chaqiriladi.
             OR CASE WHEN jsonb_typeof(i.edited_fields) = 'array'
                     THEN jsonb_array_length(i.edited_fields) > 0
                     ELSE true END)
    )
    -- Deterministik namuna ($4 = seed): bir xil seed — bir xil to'plam.
    AND ('x' || substr(md5($4::text || d.id::text), 1, 8))::bit(32)::bigint
        < floor($3::float8 * 4294967296)
  ORDER BY md5($4::text || d.id::text)
  LIMIT $2::int
`;

/** Apostrof variantlari (ism ichida va matnda). */
const APOS_CLASS = "['ʻʼ‘’`´]";
const APOS_RE = /['ʻʼ‘’`´]/g;

/**
 * Ismga qo'shiladigan BITTA qo'shimcha; ketma-ket 3 tagacha
 * ("Dilnoza|xon|ga", "Dilnoza|jon|ning", "Dilnoza|opa|ga", "Dilnoza|cha|ga").
 * Lotin o'zbek, kirill o'zbek va rus kelishik qo'shimchalari.
 */
const NAME_SUFFIX_ONE = [
  // lotin o'zbek
  'gacha',
  'larning',
  'larga',
  'lardan',
  'lar',
  'ning',
  'niki',
  'dagi',
  'dan',
  'dek',
  'day',
  'ga',
  'ka',
  'qa',
  'ni',
  'da',
  'ta',
  'ning',
  'imiz',
  'ingiz',
  'im',
  'ing',
  'm',
  'si',
  'opa',
  'aka',
  'xon',
  'hon',
  'jon',
  'oy',
  'bek',
  'cha',
  // kirill o'zbek
  'гача',
  'ларнинг',
  'ларга',
  'лардан',
  'лар',
  'нинг',
  'ники',
  'даги',
  'дан',
  'дек',
  'дай',
  'га',
  'ка',
  'қа',
  'ни',
  'да',
  'та',
  'имиз',
  'ингиз',
  'им',
  'инг',
  'м',
  'си',
  'опа',
  'ака',
  'хон',
  'жон',
  'ой',
  'бек',
  'ча',
  // rus
  'ою',
  'ом',
  'ем',
  'ей',
  'ым',
  'а',
  'я',
  'у',
  'ю',
  'е',
  'ы',
  'и',
]
  .filter((x, i, arr) => arr.indexOf(x) === i)
  .sort((x, y) => y.length - x.length)
  .join('|');
/** Rus kelishik oxiri — kirill ismning oxirgi harfi tushganda (Малик|е). */
const RU_CASE_ENDING = 'ой|ою|ом|ем|ей|ий|ию|ия|ье|ья|ью|ем|а|я|у|ю|е|ы|и';
const NAME_SUFFIX = `(?:${NAME_SUFFIX_ONE}){0,3}`;

/**
 * Ko'p so'zli ismdan alohida maskalanmaydigan so'zlar (murojaat, umumiy so'z).
 */
const NAME_PART_STOP = new Set([
  'opa',
  'aka',
  'xon',
  'hon',
  'xonim',
  'honim',
  'jon',
  'mijoz',
  'uka',
  'ota',
  'ona',
  'опа',
  'ака',
  'хон',
  'хоним',
  'жон',
  'мижоз',
  'клиент',
]);

/**
 * Ismga yopishgan murojaat ("Dilnozaxon", "Dilnozahon", "Dilnoza-xon",
 * "Ферузажон") — tire bilan birga olib tashlanadi,
 * qolgan o'zak (3+ harf) alohida variant: matnda "Dilnoza" ham maskalanadi.
 */
const GLUED_HONORIFIC_RE =
  /[-‐–]?(?:xonim|honim|xon|hon|jon|opa|aka|хоним|хон|жон|опа|ака)$/iu;

/** Regex maxsus belgilarini qochiradi. */
function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ism skeleti (apostrofsiz) → regex: harflar orasida apostrof ixtiyoriy
 * ("Gulomjon" "G'ulomjon"ni ham, "O'g'iloy" "Ogiloy"ni ham topadi),
 * bo'sh joy — har qanday bo'shliq.
 */
function skeletonRe(skeleton: string): string {
  const chars = [...skeleton.replace(/\s+/g, ' ')];
  return chars
    .map((ch, i) => {
      if (ch === ' ') return '\\s+';
      const prev = chars[i - 1];
      const apos = prev && /\p{L}/u.test(prev) && /\p{L}/u.test(ch);
      return (apos ? `${APOS_CLASS}?` : '') + escapeRe(ch);
    })
    .join('');
}

/**
 * Ism ro'yxatidan maskalanadigan shakllar: to'liq ism, (ko'p so'zli
 * bo'lsa) har 3+ harfli so'z alohida ("Abdullayev Jasur" → "Jasur" ham)
 * va har so'zning yopishgan murojaatsiz o'zagi, o'zak 3+ harf bo'lsa
 * ("Dilnozaxon" → "Dilnoza", "Ферузажон" → "Феруза").
 * Boshidagi #/@ olib tashlanadi ("#sevinch" → "#[ISM]").
 */
export function nameVariants(names: readonly string[]): string[] {
  const out = new Set<string>();
  const letterCount = (w: string): number => w.replace(/[^\p{L}]/gu, '').length;
  for (const raw of names) {
    const n = raw
      .trim()
      .replace(/^[#@]+/, '')
      .replace(APOS_RE, '');
    if (n.length < 2) continue;
    out.add(n);
    const words = n.split(/[\s,;()]+/).filter(Boolean);
    for (const w of words) {
      if (
        words.length >= 2 &&
        letterCount(w) >= 3 &&
        !NAME_PART_STOP.has(w.toLowerCase())
      ) {
        out.add(w);
      }
      const stem = w.replace(GLUED_HONORIFIC_RE, '');
      if (
        stem !== w &&
        letterCount(stem) >= 3 &&
        !NAME_PART_STOP.has(stem.toLowerCase())
      ) {
        out.add(stem);
      }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Bitta ism uchun regex alternativlari. Har birida AYNAN bitta guruh —
 * saqlanadigan qo'shimcha ("[ISM]ga").
 *  - to'liq ism + 0..3 qo'shimcha;
 *  - kirill ism -а/-я/-й/-ь bilan tugasa (4+ harf): oxirgi harfsiz o'zak +
 *    rus kelishik oxiri MAJBURIY ("Малика" → "Малике", "Маликой";
 *    "Дмитрий" → "Дмитрию"). Faqat o'zak ("Малик") maskalanMAYDI.
 */
function nameAlternatives(skeleton: string): string[] {
  const alts = [`${skeletonRe(skeleton)}(${NAME_SUFFIX})`];
  if (
    /^[\p{Script=Cyrillic}\s-]+$/u.test(skeleton) &&
    /[аяйь]$/iu.test(skeleton)
  ) {
    const stem = skeleton.slice(0, -1);
    if ([...stem.replace(/\s/g, '')].length >= 3) {
      alts.push(
        `${skeletonRe(stem)}((?:${RU_CASE_ENDING})${NAME_SUFFIX.replace('{0,3}', '{0,2}')})`,
      );
    }
  }
  return alts;
}

/**
 * Ijtimoiy tarmoq / messenjer (profil = shaxs) va xarita havolalari
 * (joylashuv = uy manzili): Google Maps (maps.app.goo.gl, goo.gl,
 * google.<tld>/maps, maps.google.<tld>), Yandex Maps, 2GIS, WhatsApp (wa.me).
 * Yo'lda vergul faqat koordinata/zoom oldidan ("?q=41.31,69.24",
 * "@41.31,69.23,17z/"), shunda "[LINK], [LINK]" dagi tinish belgisi
 * saqlanadi va "…/shop,90-742 90 47" dagi telefon havolaga yutilmaydi.
 * Yo'l "[" da to'xtaydi ("wa.me/[TEL_1]" → "[LINK][TEL_1]").
 */
const LINK_RE =
  /(?<![\p{L}\p{N}_.-])(?:https?:\/\/)?(?:[\w-]+\.)*(?:t\.me|telegram\.me|instagram\.com|instagr\.am|facebook\.com|fb\.com|vk\.com|tiktok\.com|wa\.me|whatsapp\.com|goo\.gl|maps\.google\.[a-z]{2,3}(?:\.[a-z]{2})?|google\.[a-z]{2,3}(?:\.[a-z]{2})?\/maps|yandex\.[a-z]{2,3}\/maps|2gis\.[a-z]{2,3})(?![\p{L}\p{N}_-])(?:[/?#](?:[^\s,;)[\]]|,(?=-?\d{1,3}\.\d|\d{1,2}z))*)?/giu;
const EMAIL_RE =
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
/** Telegram/Instagram foydalanuvchi nomi (email maskalangandan keyin). */
const USER_HANDLE_RE = /(?<![\p{L}\p{N}_.@])@[A-Za-z0-9_.]{3,32}/gu;

/**
 * Uy/xonadon kalit so'zlari (uzunidan boshlab; "kv-ra" — "kv" dan oldin).
 * Rus kelishiklari: "в доме 5", "квартире 7", "в квартиру 9".
 * "д."/"d." — faqat nuqta bilan.
 */
const HOUSE_KW =
  'xonadon|kvartira|хонадон|квартир[аеуы]|kv-ra|кв-ра|dom|uy|kv|дом[еау]?|уй|кв';
/**
 * Kalit so'zdan keyin: egalik ("12-uyi", "5-xonadoni", "kvartirasi 7",
 * "12-уйи") va kelishik ("12-uyda", "kvartiraga 5", "12-uyida",
 * "kvartirasiga 5") qo'shimchasi — ikkalasi ham ixtiyoriy.
 */
const HOUSE_KW_SUFFIX =
  '(?:i|si|и|си)?(?:gacha|dagi|ning|dan|ga|da|ni|гача|даги|нинг|дан|га|да|ни)?';
/**
 * "uyga 2 ta", "kvartiraga 3 dona" — miqdor/narx, uy raqami EMAS.
 * "uyiga 25 000", "uyigacha 20 000 so'm" — narxning birinchi guruhi
 * (keyin bo'shliq/nuqta + "000"), uy raqami EMAS. Faqat "000": "kv 45
 * 250 000", "uy 12\n250 000" dagi uy/xonadon raqami yopiq qoladi.
 */
const NOT_QTY =
  "(?!\\s*(?:ta|dona|shtuk|шт|та|дона|ming|минг|тыс|mln|млн|so'm|сум|x)(?![\\p{L}])|[\\s.]000(?!\\d))";
/**
 * "Narxi 1 586 000 uyiga" — narxning oxirgi "000" guruhi, uy raqami EMAS.
 */
const NOT_PRICE_TAIL = '(?!(?<=\\d[\\s.])000(?!\\d))';
/** Uy raqami: 12, 12a, 12/3. */
const HOUSE_NUM = '\\d{1,4}(?:\\/\\d{1,4}|\\p{L}(?![\\p{L}\\p{N}]))?';
/**
 * Kalit so'zdan OLDINGI uy raqami: yana "12-a uy" (tire + harf) va
 * "12 A uy" (bo'shliq + FAQAT lotin harfi, x dan tashqari) — "дом 12 и кв 5"
 * dagi "и" va "1 x uy" dagi "x" yutilmasin.
 */
const HOUSE_NUM_BEFORE_KW =
  '\\d{1,4}(?:\\/\\d{1,4}|-?\\p{L}(?![\\p{L}\\p{N}])|\\s[a-wyz](?![\\p{L}\\p{N}]))?';

/**
 * Telefon tokenlaridan tashqari PII: email, ijtimoiy tarmoq havolasi,
 * @foydalanuvchi, ismlar, pasport, 9+ raqam, uy/xonadon raqamlari.
 */
export function maskCandidateText(
  text: string,
  names: readonly string[] = [],
): string {
  let out = text
    .replace(EMAIL_RE, '[EMAIL]')
    .replace(LINK_RE, (m0: string, offset: number, whole: string) => {
      // Havola boshidagi faqat raqamli "label" ("…45 85.maps.app.goo.gl") —
      // oldingi telefonning oxirgi guruhi: matnga qaytariladi.
      let lead = /^(?:\d[\d-]*\.)+/.exec(m0)?.[0] ?? '';
      if (lead) {
        const run =
          /\d[\d\s\-\u2010-\u2015\u2212()./_]{7,}\d$/.exec(
            whole.slice(0, offset) + lead.slice(0, -1),
          )?.[0] ?? '';
        if (!(
          run.length >= lead.length && run.replace(/\D/g, '').length >= 9
        )) {
          lead = '';
        }
      }
      const m = m0.slice(lead.length);
      const dots = /\.+$/.exec(m)?.[0] ?? '';
      const core = m.slice(0, m.length - dots.length);
      const rest = whole.slice(offset + m0.length).replace(LINK_RE, '[LINK]');
      // Havola dumidagi raqam guruhlari ("…/AbC1-90-742", "…?phone=90",
      // "wa.me/90", "…,90.742") keyingi matn bilan 9+ raqamli ketma-ketlik
      // bo'lsa — matnga qaytariladi, 9+ raqam qoidasi telefonni
      // butunligicha ko'radi.
      const t = dots ? null : /(?:[^\p{L}\p{N}\s]\(?\d+\)?)+$/u.exec(core);
      if (t) {
        for (let i = 0; i < t[0].length; i++) {
          if (!/[^\p{L}\p{N}(]/u.test(t[0][i])) continue;
          const back = t[0].slice(i + 1);
          const run =
            /^\(?\d[\d\s\-\u2010-\u2015\u2212()./_]{7,}\d/.exec(
              back + rest,
            )?.[0] ?? '';
          if (run.length > back.length && run.replace(/\D/g, '').length >= 9) {
            return lead + '[LINK]' + t[0].slice(i);
          }
        }
      }
      // Ajratgichsiz yopishgan raqamlar ("…/AbC12390 742 90 47"): dumdagi
      // raqamlar keyingi matn bilan 9+ raqam bo'lsa — ular ham qaytariladi.
      const glued = dots ? '' : (/\d+$/.exec(core)?.[0] ?? '');
      if (glued && glued.length < core.length) {
        const run = /^\d[\d\s\-‐-―−()./_]{7,}\d/.exec(glued + rest)?.[0] ?? '';
        if (run.length > glued.length && run.replace(/\D/g, '').length >= 9) {
          return lead + '[LINK]' + glued;
        }
      }
      // Gap oxiridagi nuqta havolaga kirmaydi.
      return lead + '[LINK]' + dots;
    })
    .replace(USER_HANDLE_RE, (m) => {
      // Gap oxiridagi nuqta handle'ga kirmaydi.
      const dots = /\.+$/.exec(m)?.[0] ?? '';
      return '@[USER]' + dots;
    });
  // Ismlar: BITTA o'tishda (eng uzuni birinchi) — "[ISM]" qayta tegilmaydi.
  // Butun so'z, katta-kichik harfsiz, qo'shimchalar saqlanadi
  // ("Alisherga" → "[ISM]ga"). "Ali" → "Alisher" ichida TEGILMAYDI.
  const alts = nameVariants(names).flatMap(nameAlternatives);
  if (alts.length > 0) {
    out = out.replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`,
        'giu',
      ),
      (...args: unknown[]) => {
        const groups = args.slice(1, 1 + alts.length);
        const suffix = groups.find((g) => typeof g === 'string');
        return `[ISM]${suffix ?? ''}`;
      },
    );
  }
  return (
    out
      // Pasport/ID: 2 harf + 7 raqam ("AA 1234567", "AA-1234567",
      // "AA №1234567", "AA № 1234567").
      // Oldida umumiy 2 harfli so'z yoki uy kalit so'zi ("1 ta - 1500000",
      // "uy-1234567", "151-уй - 6356734") — seriya EMAS (raqami pastda,
      // uy qoidalaridan keyin, [RAQAM] bo'ladi; kalit so'z uy qoidasiga
      // qoladi).
      .replace(
        /(?<![\p{L}\p{N}])(?!(?:ta|va|uy|kv|da|ga|ni|bu|to|та|ва|уй|кв)(?![\p{L}]))\p{L}{2}\s?(?:[-–№]\s?)?\d{7}(?!\d)/gu,
        '[HUJJAT]',
      )
      // 9+ raqamli ketma-ketlik (maskalanmagan telefon/karta; nuqta, slash,
      // pastki chiziq, har xil tire ajratgichlar ham). ⚠️ 100 mln dan katta
      // narx ("150 000 000") ham [RAQAM] bo'ladi; narxlar odatda 7–8 raqam
      // ("1 500 000") — SAQLANADI.
      .replace(/(?<!\[TEL_)\d[\d\s\-‐-―−()./_]{7,}\d/g, (m) =>
        m.replace(/\D/g, '').length >= 9 ? '[RAQAM]' : m,
      )
      // "12-uy", "12a-uy", "12-a uy", "12/3-uyda", "5-xonadonga", "12-uyi",
      // "45-xonadonida", "12-уйда", "5-хонадони".
      .replace(
        new RegExp(
          `(?<![\\p{L}\\p{N}])([№#]?)${NOT_PRICE_TAIL}${HOUSE_NUM_BEFORE_KW}(\\s*-?\\s*)((?:${HOUSE_KW})${HOUSE_KW_SUFFIX})(?![\\p{L}\\p{N}])`,
          'giu',
        ),
        '$1[N]$2$3',
      )
      // "uy 12/3", "uyi 12", "kvartiraga 5", "kvartirasi 7", "kv-ra 5",
      // "kv №5", "дом №12", "д. 15", "d.15".
      .replace(
        new RegExp(
          `(?<![\\p{L}\\p{N}])((?:(?:${HOUSE_KW})${HOUSE_KW_SUFFIX}\\.?|[дd]\\.)\\s*[-:]?\\s*(?:[№#]|N(?=\\s*\\d))?\\s*)${HOUSE_NUM}(?!\\d)${NOT_QTY}`,
          'giu',
        ),
        '$1[N]',
      )
      // Umumiy 2 harfli so'z / uy kalit so'zi + 7 raqam ("va 2345678",
      // "uy 2345678", "uy2345678"): so'z qoladi, raqam yopiladi (dev bu
      // shaklni [HUJJAT] qilardi). "1 ta - 1500000", "uy-1234567" — dev'dagidek
      // ochiq.
      .replace(
        /(?<![\p{L}\p{N}])((?:ta|va|uy|kv|da|ga|ni|bu|to|та|ва|уй|кв)\s?)\d{7}(?!\d)/gu,
        '$1[RAQAM]',
      )
  );
}

/**
 * Ismlar: `customer_name` satr bo'lsa ham, tuzatishdagi `{ai, final}`
 * obyekti bo'lsa ham (operator yozgan `final` ism ham) yig'iladi.
 */
export function namesOf(value: unknown): string[] {
  const out: string[] = [];
  const take = (x: unknown): void => {
    if (typeof x === 'string') out.push(x);
    else if (x && typeof x === 'object' && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      take(o.ai);
      take(o.final);
    }
  };
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'customer_name' || k === 'operator') take(x);
        else visit(x);
      }
    }
  };
  visit(value);
  return [...new Set(out)];
}

/**
 * Tuzatishlardan erkin matnli PII maydonlarini tashlaydi (izoh, operator,
 * telefon maskasi) — eval uchun keraksiz.
 */
const DROP_CORRECTION_KEYS = new Set([
  'comment',
  'operator',
  'phone_number',
  'extra_number',
]);
export function scrubCorrections(items: unknown): unknown {
  if (!Array.isArray(items)) return [];
  return (items as unknown[]).map((it: unknown): unknown => {
    if (!it || typeof it !== 'object') return it;
    const row = { ...(it as Record<string, unknown>) };
    const fc = row.field_corrections;
    if (fc && typeof fc === 'object' && !Array.isArray(fc)) {
      row.field_corrections = Object.fromEntries(
        Object.entries(fc as Record<string, unknown>).filter(
          ([k]) => !DROP_CORRECTION_KEYS.has(k),
        ),
      );
    }
    return row;
  });
}

/** Tasdiqlangan preview'dan faqat ruxsat etilgan kalitlar (hash/telefon/izoh yo'q). */
const PREVIEW_KEYS = [
  'index',
  'customer_name',
  'region_id',
  'district_id',
  'address',
  'total_price',
  'where_deliver',
  'is_replacement',
  'items',
] as const;
export function confirmedPreview(
  resolvedPreview: unknown,
  items: unknown,
): unknown[] {
  if (!Array.isArray(resolvedPreview)) return [];
  const indexes = new Set(
    (Array.isArray(items) ? items : [])
      .map((i) => (i as { item_index?: unknown })?.item_index)
      .filter((x): x is number => typeof x === 'number'),
  );
  return resolvedPreview
    .filter(
      (p) =>
        !!p &&
        typeof p === 'object' &&
        indexes.has((p as { index?: unknown }).index as number),
    )
    .map((p) =>
      Object.fromEntries(
        PREVIEW_KEYS.filter((k) => k in (p as object)).map((k) => [
          k,
          (p as Record<string, unknown>)[k],
        ]),
      ),
    );
}

/** Har satr qiymatini maskalaydi (JSON tuzilmasi buzilmaydi). */
export function maskDeep(value: unknown, names: readonly string[]): unknown {
  if (typeof value === 'string') return maskCandidateText(value, names);
  // Raqam ko'rinishidagi telefon (998901234567 / 901234567) — narx emas.
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    /^(?:998)?(?:20|33|5[05]|6[1-9]|7\d|88|9[013-57-9])\d{7}$/.test(
      String(value),
    ) &&
    !/000$/.test(String(value))
  ) {
    return '[RAQAM]';
  }
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, names));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        maskDeep(v, names),
      ]),
    );
  }
  return value;
}

/** Qiymatsiz bayroqlar. */
const BOOLEAN_FLAGS = new Set(['include-unmasked-names']);

const KNOWN_FLAGS = new Set([
  'out',
  'days',
  'limit',
  'sample-unedited',
  'seed',
  'env',
]);

/**
 * `raw_extraction.orders` da ismsiz (customer_name bo'sh) buyurtma bormi —
 * bo'lsa, o'sha mijozning matndagi ismi ro'yxatda yo'q va maskalanmay
 * qolishi mumkin (`names_masked: 'partial'`).
 */
export function hasUnnamedOrder(rawExtraction: unknown): boolean {
  const orders = (rawExtraction as { orders?: unknown } | null)?.orders;
  if (!Array.isArray(orders)) return false;
  return orders.some((o) => {
    const name = (o as { customer_name?: unknown } | null)?.customer_name;
    return typeof name !== 'string' || name.trim() === '';
  });
}

/**
 * Butun son bayroq: yo'q → sukut; raqam emas yoki oraliqdan tashqari →
 * null (skript 2-kod bilan to'xtaydi, jim sukut YO'Q).
 */
export function parseIntFlag(
  raw: string | null,
  def: number,
  min: number,
  max: number,
): number | null {
  if (raw === null) return def;
  if (!/^\d+$/.test(raw)) return null;
  const v = Number(raw);
  return v >= min && v <= max ? v : null;
}

function arg(name: string): string | null {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

async function main(): Promise<number> {
  for (const a of process.argv.slice(2)) {
    const m = /^--([a-z-]+)(=|$)/.exec(a);
    const isSwitch = m && BOOLEAN_FLAGS.has(m[1]) && m[2] === '';
    if (!m || (!isSwitch && (!KNOWN_FLAGS.has(m[1]) || m[2] !== '='))) {
      console.error(`Noma'lum yoki noto'g'ri bayroq: ${a}`);
      return 2;
    }
  }
  // .env faqat main ichida (import qilinganda — testlarda — o'qilmaydi).
  dotenv.config({ quiet: true });
  const envFlag = arg('env');
  if (envFlag) dotenv.config({ path: envFlag, override: true, quiet: true });
  const includeUnmasked = process.argv.includes('--include-unmasked-names');
  const out = arg('out');
  if (!out) {
    console.error('--out=<katalog> majburiy (repo TASHQARISIDA).');
    return 2;
  }
  const outDir = resolve(out);
  const repoReal = realpathSync(REPO_ROOT);
  const outParent = (() => {
    let d = outDir;
    while (!existsSync(d)) d = dirname(d);
    return realpathSync(d);
  })();
  if (
    outDir === REPO_ROOT ||
    outDir.startsWith(REPO_ROOT + '/') ||
    outParent === repoReal ||
    outParent.startsWith(repoReal + '/')
  ) {
    console.error(
      'Repo ichiga yozish taqiqlangan (PII xavfi). Boshqa katalog bering.',
    );
    return 2;
  }
  // Eski natija ustiga yozilmaydi / aralashmaydi: katalog bo'sh bo'lsin.
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    console.error(
      `--out katalogi bo'sh emas: ${outDir}. Yangi katalog bering yoki tozalang.`,
    );
    return 2;
  }
  const days = parseIntFlag(arg('days'), 30, 1, 90);
  const limit = parseIntFlag(arg('limit'), 200, 1, 2000);
  if (days === null || limit === null) {
    console.error(
      "--days 1..90 va --limit 1..2000 oralig'idagi butun son bo'lishi kerak.",
    );
    return 2;
  }
  const sampleArg = arg('sample-unedited');
  const sample = sampleArg === null ? null : Number(sampleArg);
  if (sample !== null && !(sample > 0 && sample <= 1)) {
    console.error(
      "--sample-unedited 0 < x <= 1 bo'lishi kerak (masalan 0.05).",
    );
    return 2;
  }
  const seed = arg('seed');
  if (sample !== null && !(seed && /^[A-Za-z0-9_-]{1,64}$/.test(seed))) {
    console.error(
      '--sample-unedited bilan --seed=<matn> majburiy (namuna takrorlansin).',
    );
    return 2;
  }
  const uri = process.env.POSTGRES_URI;
  if (!uri) {
    console.error('POSTGRES_URI is required.');
    return 2;
  }
  const ds = new DataSource({
    type: 'postgres',
    url: uri,
    synchronize: false,
    logging: false,
  });
  await ds.initialize();
  try {
    // Faqat o'qish: tranzaksiya READ ONLY.
    const rows: Record<string, unknown>[] = await ds.transaction(async (m) => {
      await m.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      // Prod: uzoq so'rov yoki qulf kutish servisni sekinlashtirmasin.
      await m.query("SET LOCAL statement_timeout = '120s'");
      await m.query("SET LOCAL lock_timeout = '2s'");
      await m.query("SET LOCAL application_name = 'ai-eval-collect'");
      return sample === null
        ? m.query<Record<string, unknown>[]>(COLLECT_SQL, [days, limit])
        : m.query<Record<string, unknown>[]>(UNEDITED_SAMPLE_SQL, [
            days,
            limit,
            sample,
            seed,
          ]);
    });
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    chmodSync(outDir, 0o700);
    if (sample !== null) {
      console.log(`namuna: ulush=${sample} seed=${seed}`);
    }
    let n = 0;
    let unmaskedCount = 0;
    let partialCount = 0;
    for (const r of rows) {
      const names = namesOf([r.raw_extraction, r.resolved_preview, r.items]);
      const sourceText = typeof r.source_text === 'string' ? r.source_text : '';
      // B2: ism ro'yxati bo'sh (outcome≠ok — raw_extraction yo'q) — matndagi
      // ism va operator MASKALANMAYDI. Sukut: matn chiqarilmaydi (null).
      const namesKnown = names.length > 0 || sourceText.trim() === '';
      if (!namesKnown) unmaskedCount += 1;
      // Ismsiz buyurtma bor — boshqa ismlar maskalangan, uniki yo'q.
      const partial = namesKnown && hasUnnamedOrder(r.raw_extraction);
      if (partial) partialCount += 1;
      const candidate = {
        id: `prod-${String(r.draft_id)}`,
        category: [sample === null ? 'prod_candidate' : 'prod_unedited_sample'],
        source: 'prod-masked',
        note:
          `outcome=${String(r.outcome)} prompt=${String(r.prompt_version)} ` +
          `kind=${String(r.source_kind)} images=${String(r.image_count)}`,
        input: {
          text:
            namesKnown || includeUnmasked
              ? maskCandidateText(sourceText, names)
              : null,
          names_masked: partial ? 'partial' : namesKnown,
        },
        // Kutilgan natija ODAM tomonidan to'ldiriladi: AI taklifi +
        // operator tuzatishlari (field_corrections.final) asosida.
        expected: { orders: [] },
        evidence: {
          outcome: r.outcome,
          calls: r.calls,
          corrections: maskDeep(scrubCorrections(r.items), names),
          // Tahrirlanmagan namunada: operator o'zgartirmay tasdiqlagan AI
          // taklifi — FAQAT tasdiqlangan index'lar, ruxsat etilgan kalitlar.
          ...(sample === null
            ? {}
            : {
                confirmed_preview: maskDeep(
                  confirmedPreview(r.resolved_preview, r.items),
                  names,
                ),
                sample: { fraction: sample, seed },
              }),
        },
      };
      writeFileSync(
        join(outDir, `${candidate.id}.json`),
        JSON.stringify(candidate, null, 2) + '\n',
        // 'wx': mavjud faylni hech qachon qayta yozmaydi.
        { mode: 0o600, flag: 'wx' },
      );
      n += 1;
    }
    console.log(`${n} ta nomzod yozildi: ${outDir} (oxirgi ${days} kun).`);
    if (unmaskedCount > 0) {
      console.log(
        `${unmaskedCount} ta faylda ism ro'yxati yo'q: ` +
          (includeUnmasked
            ? "matn ISMLARI OCHIQ — qo'lda maskalang."
            : 'matn chiqarilmadi (input.text = null; --include-unmasked-names bilan ochiq holda).'),
      );
    }
    if (partialCount > 0) {
      console.log(
        `${partialCount} ta faylda ismsiz buyurtma bor (names_masked: 'partial'): ` +
          "o'sha mijoz ismi matnda ochiq qolishi mumkin — qo'lda tekshiring.",
      );
    }
    return 0;
  } finally {
    await ds.destroy();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(
        `collect xatosi: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(2);
    },
  );
}
