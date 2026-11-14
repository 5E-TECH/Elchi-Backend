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
 * qo'shimcha ravishda ism (AI/operator customer_name qiymatlari), 9+
 * raqamli ketma-ketliklar, uy/xonadon raqamlarini maskalaydi. Natija
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
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';

dotenv.config();
const envFlag = process.argv.find((a) => a.startsWith('--env='));
if (envFlag) {
  dotenv.config({ path: envFlag.slice('--env='.length), override: true });
}

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
          AND jsonb_array_length(COALESCE(i.edited_fields, '[]'::jsonb)) > 0
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
             OR jsonb_array_length(i.edited_fields) > 0)
    )
    -- Deterministik namuna ($4 = seed): bir xil seed — bir xil to'plam.
    AND ('x' || substr(md5($4::text || d.id::text), 1, 8))::bit(32)::bigint
        < floor($3::float8 * 4294967296)
  ORDER BY md5($4::text || d.id::text)
  LIMIT $2::int
`;

/** Telefon tokenlaridan tashqari 9+ raqam, uy/xonadon raqamlari, ismlar. */
export function maskCandidateText(
  text: string,
  names: readonly string[] = [],
): string {
  let out = text;
  // Eng uzunidan boshlab, butun so'z (o'zbek/rus qo'shimchalari bilan:
  // "Alisherga", "Alisherning", "Малике"), katta-kichik harfsiz, apostrof
  // variantlari bir xil ("G'ulomjon" = "Gʻulomjon" = "G‘ulomjon"). "Ali"
  // → "Alisher" ichida TEGILMAYDI. Boshidagi #/@ olib tashlanadi
  // ("#sevinch" → "#[ISM]").
  const sorted = [...new Set(names.map((n) => n.trim().replace(/^[#@]+/, '')))]
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const n of sorted) {
    const escaped = n
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/['ʻʼ‘’`]/g, NAME_APOS);
    out = out.replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}])${escaped}(${NAME_SUFFIX})(?![\\p{L}\\p{N}])`,
        'giu',
      ),
      '[ISM]$1',
    );
  }
  return (
    out
      // 9+ raqamli ketma-ketlik (maskalanmagan telefon/karta; nuqta va '/'
      // ajratgichlar ham) — narxlar ("1 500 000" = 7 raqam) SAQLANADI.
      .replace(/(?<!\[TEL_)\d[\d\s\-()./]{7,}\d/g, (m) =>
        m.replace(/\D/g, '').length >= 9 ? '[RAQAM]' : m,
      )
      .replace(
        /(?<![\p{L}\p{N}])(\d{1,4})(\s*-?\s*)(uy|xonadon|kvartira|kv|dom|квартира|дом|кв)(?![\p{L}\p{N}])/giu,
        '[N]$2$3',
      )
      .replace(
        /(?<![\p{L}\p{N}])(uy|xonadon|kvartira|kv|dom|квартира|дом|кв)(\.?\s*-?\s*)\d{1,4}(?!\d)/giu,
        '$1$2[N]',
      )
  );
}

/** Apostrof variantlari (ism ichida). */
const NAME_APOS = "['ʻʼ‘’`]";
/** Ismga qo'shiladigan o'zbek/rus qo'shimchalari (ixtiyoriy). */
const NAME_SUFFIX =
  '(?:ga|ka|qa|ning|ni|niki|da|dan|ta|lar|larga|larning|opa|aka|xon|jon|а|у|е|ой|ом|ым|ы|и)?';

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
  const days = Math.max(1, Math.min(90, Number(arg('days') ?? 30) || 30));
  const limit = Math.max(1, Math.min(2000, Number(arg('limit') ?? 200) || 200));
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
    for (const r of rows) {
      const names = namesOf([r.raw_extraction, r.resolved_preview, r.items]);
      const sourceText = typeof r.source_text === 'string' ? r.source_text : '';
      // B2: ism ro'yxati bo'sh (outcome≠ok — raw_extraction yo'q) — matndagi
      // ism va operator MASKALANMAYDI. Sukut: matn chiqarilmaydi (null).
      const namesKnown = names.length > 0 || sourceText.trim() === '';
      if (!namesKnown) unmaskedCount += 1;
      const candidate = {
        id: `prod-${String(r.draft_id).slice(0, 8)}`,
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
          names_masked: namesKnown,
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
        { mode: 0o600 },
      );
      n += 1;
    }
    console.log(`${n} ta nomzod yozildi: ${outDir} (oxirgi ${days} kun).`);
    if (unmaskedCount > 0) {
      console.log(
        `${unmaskedCount} ta faylda ism ro'yxati yo'q (outcome≠ok): ` +
          (includeUnmasked
            ? "matn ISMLARI OCHIQ — qo'lda maskalang."
            : 'matn chiqarilmadi (input.text = null; --include-unmasked-names bilan ochiq holda).'),
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
