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
 *    tasdiqlagan qiymat (kutilgan natijaning manbai);
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
 */
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

/** Telefon tokenlaridan tashqari 9+ raqam, uy/xonadon raqamlari, ismlar. */
export function maskCandidateText(
  text: string,
  names: readonly string[] = [],
): string {
  let out = text;
  for (const name of names) {
    const n = name.trim();
    if (n.length < 2) continue;
    out = out.split(n).join('[ISM]');
  }
  return (
    out
      // 9+ raqamli ketma-ketlik (maskalanmagan telefon/karta) — narxlar
      // ("1 500 000" = 7 raqam) SAQLANADI, ular eval uchun kerak.
      .replace(/(?<!\[TEL_)\d[\d\s\-()]{7,}\d/g, (m) =>
        m.replace(/\D/g, '').length >= 9 ? '[RAQAM]' : m,
      )
      .replace(
        /\b(\d{1,4})(\s*-?\s*)(uy|xonadon|kv|kvartira|дом|кв)\b/gi,
        '[N]$2$3',
      )
      .replace(/\b(uy|xonadon|kv|дом|кв)\.?\s*\d{1,4}\b/gi, '$1 [N]')
  );
}

function namesOf(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'customer_name' && typeof x === 'string') out.push(x);
        else visit(x);
      }
    }
  };
  visit(value);
  return [...new Set(out)];
}

function arg(name: string): string | null {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

async function main(): Promise<number> {
  const out = arg('out');
  if (!out) {
    console.error('--out=<katalog> majburiy (repo TASHQARISIDA).');
    return 2;
  }
  const outDir = resolve(out);
  if (outDir === REPO_ROOT || outDir.startsWith(REPO_ROOT + '/')) {
    console.error(
      'Repo ichiga yozish taqiqlangan (PII xavfi). Boshqa katalog bering.',
    );
    return 2;
  }
  const days = Math.max(1, Math.min(90, Number(arg('days') ?? 30) || 30));
  const limit = Math.max(1, Math.min(2000, Number(arg('limit') ?? 200) || 200));
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
      await m.query('SET TRANSACTION READ ONLY');
      return m.query<Record<string, unknown>[]>(COLLECT_SQL, [days, limit]);
    });
    mkdirSync(outDir, { recursive: true });
    let n = 0;
    for (const r of rows) {
      const names = namesOf([r.raw_extraction, r.resolved_preview, r.items]);
      const candidate = {
        id: `prod-${String(r.draft_id).slice(0, 8)}`,
        category: ['prod_candidate'],
        source: 'prod-masked',
        note:
          `outcome=${String(r.outcome)} prompt=${String(r.prompt_version)} ` +
          `kind=${String(r.source_kind)} images=${String(r.image_count)}`,
        input: {
          text: maskCandidateText(
            typeof r.source_text === 'string' ? r.source_text : '',
            names,
          ),
        },
        // Kutilgan natija ODAM tomonidan to'ldiriladi: AI taklifi +
        // operator tuzatishlari (field_corrections.final) asosida.
        expected: { orders: [] },
        evidence: {
          outcome: r.outcome,
          calls: r.calls,
          corrections: JSON.parse(
            maskCandidateText(JSON.stringify(r.items ?? []), names),
          ) as unknown,
        },
      };
      writeFileSync(
        join(outDir, `${candidate.id}.json`),
        JSON.stringify(candidate, null, 2) + '\n',
      );
      n += 1;
    }
    console.log(`${n} ta nomzod yozildi: ${outDir} (oxirgi ${days} kun).`);
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
