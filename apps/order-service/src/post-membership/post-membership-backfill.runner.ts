import {
  BACKFILL_SOURCES,
  type BackfillArgs,
  type BackfillSource,
  type ExistingMembership,
  type JoinedAtFix,
  type MembershipKind,
  type PlannedStay,
  type PointerObservation,
  type PostBackfillReportRow,
  type BackfillReport,
  SEED_SOURCE,
  chunkStaysByKey,
  normalizeObservedPostId,
  planBackfill,
  usToIso,
} from './post-membership-backfill';

/**
 * Pochta ↔ buyurtma tarixi backfill'ining DB qismi (yupqa): manbalardan
 * kuzatuvlarni BITTA ulanishdagi vaqtinchalik jadvalga yig'adi, buyurtma id
 * paketlari bo'yicha sof `planBackfill` ni chaqiradi va (`--apply` bo'lsa)
 * natijani paket-paket tranzaksiyada yozadi. Butun mantiq
 * `post-membership-backfill.ts` da.
 *
 * Idempotent: faqat eng erta mavjud qatordan OLDINGI yopiq turishlar
 * qo'shiladi (+ INSERT ichida `NOT EXISTS` qo'riqchisi), seed `joined_at`
 * faqat kamayadi va faqat BIR marta (tegilmagan seed: `joined_at =
 * created_at`). Parallel ikki yurgizish — advisory lock bilan to'silgan.
 * Bitta (buyurtma, tur) turishlari doim BITTA INSERT'da (`chunkStaysByKey`)
 * — aks holda qo'riqchi oldingi bo'lak yozganini ko'rib qolganini tashlardi.
 */

/** typeorm `QueryRunner` ning kerakli qismi (BITTA ulanish — temp jadval). */
export interface BackfillSqlRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  startTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
}

const TABLE = '"order_schema"."post_order_memberships"';
const OBS = 'pg_temp."post_membership_backfill_obs"';
const LOCK_KEY = 'backfill-post-order-memberships';
const INSERT_CHUNK = 1000;
const REPORT_CHUNK = 5000;
const ID_RE = `'^[1-9][0-9]{0,17}$'`;
const EPOCH_US = (column: string) =>
  `(extract(epoch FROM ${column}) * 1000000)::bigint`;

/** Ko'rsatkich ustuni → tur (migratsiya 201 bilan ayni juftliklar). */
const KIND_VALUES = `(VALUES ('DELIVERY', 'post_id'), ('CANCELED', 'canceled_post_id')) AS k("kind", "col")`;

export const BACKFILL_SOURCE_SQL: Record<
  BackfillSource,
  { table: string; sql: string }
> = {
  outbox: {
    table: 'order_schema.outbox_events',
    sql: `
      INSERT INTO ${OBS} ("order_id", "kind", "post_raw", "ts_us", "seq", "source")
      SELECT (e."payload"->>'sourceId')::bigint, k."kind",
             e."payload"->'metadata'->>k."col",
             ${EPOCH_US('e."created_at"')}, e."id", 'outbox'
        FROM "order_schema"."outbox_events" e
       CROSS JOIN ${KIND_VALUES}
       WHERE e."pattern" = 'search.index.upsert'
         AND e."payload"->>'type' = 'order'
         AND (e."payload"->>'sourceId') ~ ${ID_RE}
         AND jsonb_typeof(e."payload"->'metadata') = 'object'
         AND (e."payload"->'metadata') ? k."col"
         AND e."created_at" < $1::timestamptz`,
  },
  order_activity: {
    table: 'order_schema.activity_logs',
    sql: `
      INSERT INTO ${OBS} ("order_id", "kind", "post_raw", "ts_us", "seq", "source")
      SELECT a."entity_id"::bigint, k."kind", a."new_value"->>k."col",
             ${EPOCH_US('a."created_at"')}, a."id", 'order_activity'
        FROM "order_schema"."activity_logs" a
       CROSS JOIN ${KIND_VALUES}
       WHERE a."entity_type" = 'Order'
         AND a."entity_id" ~ ${ID_RE}
         AND a."action" <> 'deleted'
         AND jsonb_typeof(a."new_value") = 'object'
         AND a."new_value" ? k."col"
         AND a."created_at" < $1::timestamptz
      UNION ALL
      SELECT a."entity_id"::bigint, k."kind", a."old_value"->>k."col",
             ${EPOCH_US('a."created_at"')}, a."id", 'order_activity'
        FROM "order_schema"."activity_logs" a
       CROSS JOIN ${KIND_VALUES}
       WHERE a."entity_type" = 'Order'
         AND a."entity_id" ~ ${ID_RE}
         AND a."action" = 'deleted'
         AND jsonb_typeof(a."old_value") = 'object'
         AND a."old_value" ? k."col"
         AND a."created_at" < $1::timestamptz`,
  },
  logistics_activity: {
    table: 'logistics_schema.activity_logs',
    sql: `
      INSERT INTO ${OBS} ("order_id", "kind", "post_raw", "ts_us", "seq", "source")
      SELECT a."entity_id"::bigint, 'DELIVERY', a."new_value"->>'post_id',
             ${EPOCH_US('a."created_at"')}, a."id", 'logistics_activity'
        FROM "logistics_schema"."activity_logs" a
       WHERE a."entity_type" = 'Order'
         AND a."entity_id" ~ ${ID_RE}
         AND jsonb_typeof(a."new_value") = 'object'
         AND a."new_value" ? 'post_id'
         AND a."created_at" < $1::timestamptz`,
  },
};

/**
 * Planlangan turishlar — `unnest` bilan; qo'riqchi: undan erta qator yo'q.
 * Statement o'zi yozgan qatorlarni ko'rmaydi — shuning uchun bir kalitning
 * barcha turishlari bitta statement'da yuboriladi (`chunkStaysByKey`).
 */
export const INSERT_STAYS_SQL = `
  INSERT INTO ${TABLE}
    ("order_id", "post_id", "kind", "joined_at", "left_at", "next_post_id", "source")
  SELECT v."order_id", v."post_id", v."kind", v."joined_at", v."left_at",
         v."next_post_id", v."source"
    FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::timestamptz[],
                $5::timestamptz[], $6::bigint[], $7::text[])
         AS v("order_id", "post_id", "kind", "joined_at", "left_at",
              "next_post_id", "source")
   WHERE EXISTS (
           SELECT 1 FROM "order_schema"."orders" o WHERE o."id" = v."order_id"
         )
     AND NOT EXISTS (
           SELECT 1 FROM ${TABLE} m
            WHERE m."order_id" = v."order_id" AND m."kind" = v."kind"
              AND m."joined_at" <= v."joined_at"
         )
  RETURNING 1`;

/**
 * Seed `joined_at` — faqat seed qatori, faqat ERTAROQ vaqtga va faqat bir
 * marta: seed `joined_at` va `created_at` ni ayni `now()` bilan yozadi —
 * surilgandan keyin ular farq qiladi va qator qayta tegilmaydi.
 */
export const FIX_JOINED_AT_SQL = `
  UPDATE ${TABLE} m
     SET "joined_at" = v."joined_at"
    FROM unnest($1::bigint[], $2::timestamptz[]) AS v("id", "joined_at")
   WHERE m."id" = v."id"
     AND m."source" = '${SEED_SOURCE}'
     AND m."joined_at" = m."created_at"
     AND m."joined_at" > v."joined_at"
  RETURNING 1`;

/** SELECT natijasi — chaqiruvchi bergan qator turi bilan. */
async function select<T>(
  runner: BackfillSqlRunner,
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await runner.query(sql, params);
  return Array.isArray(result) ? (result as T[]) : [];
}

/** typeorm: INSERT → qatorlar; UPDATE → `[qatorlar, soni]`. */
function affected(result: unknown): number {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[1];
  }
  return Array.isArray(result) ? result.length : 0;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function tableExists(
  runner: BackfillSqlRunner,
  name: string,
): Promise<boolean> {
  const rows = await select<{ ok: boolean }>(
    runner,
    `SELECT to_regclass($1) IS NOT NULL AS "ok"`,
    [name],
  );
  return rows[0]?.ok === true;
}

async function writePlan(
  runner: BackfillSqlRunner,
  stays: readonly PlannedStay[],
  fixes: readonly JoinedAtFix[],
  insertChunk: number,
): Promise<{ inserted: number; fixed: number }> {
  let inserted = 0;
  let fixed = 0;
  await runner.startTransaction();
  try {
    for (const part of chunkStaysByKey(stays, insertChunk)) {
      inserted += affected(
        await runner.query(INSERT_STAYS_SQL, [
          part.map((s) => s.order_id),
          part.map((s) => s.post_id),
          part.map((s) => s.kind),
          part.map((s) => usToIso(s.joined_at_us)),
          part.map((s) => usToIso(s.left_at_us)),
          part.map((s) => s.next_post_id),
          part.map((s) => s.source),
        ]),
      );
    }
    // Seed tuzatishi INSERT'dan KEYIN: qo'riqchi seed'ning eski (kech)
    // `joined_at` i bilan solishtiradi.
    for (const part of chunks(fixes, INSERT_CHUNK)) {
      fixed += affected(
        await runner.query(FIX_JOINED_AT_SQL, [
          part.map((f) => f.id),
          part.map((f) => usToIso(f.joined_at_us)),
        ]),
      );
    }
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  }
  return { inserted, fixed };
}

async function buildPostReport(
  runner: BackfillSqlRunner,
  newMembers: Map<string, number>,
  apply: boolean,
): Promise<PostBackfillReportRow[]> {
  const postIds = [...newMembers.keys()];
  const hasPosts = await tableExists(runner, 'logistics_schema.posts');
  const rows: PostBackfillReportRow[] = [];
  for (const part of chunks(postIds, REPORT_CHUNK)) {
    const posts = hasPosts
      ? await select<{
          id: string;
          status: string | null;
          order_quantity: number | null;
        }>(
          runner,
          `SELECT p."id"::text AS "id", p."status"::text AS "status",
                  p."order_quantity" AS "order_quantity"
             FROM "logistics_schema"."posts" p
            WHERE p."id" = ANY($1::bigint[])`,
          [part],
        )
      : [];
    const counts = await select<{ post_id: string; n: number }>(
      runner,
      `SELECT m."post_id"::text AS "post_id",
              count(DISTINCT m."order_id")::int AS "n"
         FROM ${TABLE} m
        WHERE m."post_id" = ANY($1::bigint[])
        GROUP BY m."post_id"`,
      [part],
    );
    const postById = new Map(posts.map((p) => [String(p.id), p]));
    const countById = new Map(counts.map((c) => [String(c.post_id), c.n]));
    for (const postId of part) {
      const post = postById.get(postId);
      const added = newMembers.get(postId) ?? 0;
      const now = Number(countById.get(postId) ?? 0);
      rows.push({
        post_id: postId,
        status: post ? post.status : null,
        order_quantity:
          post && post.order_quantity !== null
            ? Number(post.order_quantity)
            : null,
        // Dry-run'da yangi qatorlar hali yozilmagan — qo'shib ko'rsatiladi.
        members: apply ? now : now + added,
        new_members: added,
      });
    }
  }
  return rows;
}

export async function runPostMembershipBackfill(
  runner: BackfillSqlRunner,
  args: BackfillArgs,
  log: (line: string) => void = () => undefined,
): Promise<BackfillReport> {
  if (!(await tableExists(runner, 'order_schema.post_order_memberships'))) {
    throw new Error(
      "order_schema.post_order_memberships yo'q — avval migratsiya 1716000000201",
    );
  }
  // Uzoq skan — sessiya cheklovisiz; qulf kutishi esa qisqa.
  await runner.query(`SET statement_timeout = 0`);
  await runner.query(`SET lock_timeout = '10s'`);

  let locked = false;
  if (args.apply) {
    const rows = await select<{ ok: boolean }>(
      runner,
      `SELECT pg_try_advisory_lock(hashtext($1)) AS "ok"`,
      [LOCK_KEY],
    );
    if (rows[0]?.ok !== true) {
      throw new Error('Backfill allaqachon boshqa jarayonda ishlayapti');
    }
    locked = true;
  }

  try {
    const [cutoffRow] = await select<{ us: string }>(
      runner,
      `SELECT ${EPOCH_US(
        `COALESCE((SELECT min(m."created_at") FROM ${TABLE} m
                    WHERE m."source" = '${SEED_SOURCE}'), now())`,
      )}::text AS "us"`,
    );
    const cutoffUs = Number(cutoffRow.us);
    const cutoffIso = usToIso(cutoffUs);
    log(`[backfill] chegara (seed vaqti): ${cutoffIso}`);

    await runner.query(`DROP TABLE IF EXISTS ${OBS}`);
    await runner.query(`
      CREATE TEMP TABLE "post_membership_backfill_obs" (
        "order_id" bigint NOT NULL,
        "kind" varchar(16) NOT NULL,
        "post_raw" text NULL,
        "ts_us" bigint NOT NULL,
        "seq" bigint NOT NULL,
        "source" varchar(32) NOT NULL
      )
    `);
    for (const source of BACKFILL_SOURCES) {
      const { table, sql } = BACKFILL_SOURCE_SQL[source];
      if (!(await tableExists(runner, table))) {
        log(`[backfill] ${source}: ${table} yo'q — o'tkazildi`);
        continue;
      }
      await runner.query(sql, [cutoffIso]);
    }
    await runner.query(`CREATE INDEX ON ${OBS} ("order_id")`);
    await runner.query(`ANALYZE ${OBS}`);

    const observationCounts = Object.fromEntries(
      BACKFILL_SOURCES.map((s) => [s, 0]),
    ) as Record<BackfillSource, number>;
    const countRows = await select<{ source: BackfillSource; n: number }>(
      runner,
      `SELECT "source", count(*)::int AS "n" FROM ${OBS} GROUP BY "source"`,
    );
    for (const row of countRows) observationCounts[row.source] = row.n;
    log(
      `[backfill] kuzatuvlar: ${BACKFILL_SOURCES.map((s) => `${s}=${observationCounts[s]}`).join(', ')}`,
    );

    const report: BackfillReport = {
      apply: args.apply,
      cutoffIso,
      observations: observationCounts,
      ordersScanned: 0,
      staysPlanned: 0,
      staysInserted: 0,
      staysBySource: {},
      joinedAtFixesPlanned: 0,
      joinedAtFixesApplied: 0,
      posts: [],
    };
    const newMembers = new Map<string, number>();

    let lastOrderId = '0';
    for (;;) {
      const idRows = await select<{ order_id: string }>(
        runner,
        `SELECT d."order_id"::text AS "order_id"
           FROM (SELECT DISTINCT b."order_id" FROM ${OBS} b
                  WHERE b."order_id" > $1::bigint
                  ORDER BY b."order_id" LIMIT $2) d
          ORDER BY d."order_id"`,
        [lastOrderId, args.batchSize],
      );
      if (!idRows.length) break;
      const ids = idRows.map((row) => row.order_id);
      lastOrderId = ids[ids.length - 1];

      const obsRows = await select<{
        order_id: string;
        kind: MembershipKind;
        post_raw: string | null;
        ts_us: string;
        seq: string;
        source: BackfillSource;
      }>(
        runner,
        `SELECT b."order_id"::text AS "order_id", b."kind", b."post_raw",
                b."ts_us"::text AS "ts_us", b."seq"::text AS "seq", b."source"
           FROM ${OBS} b
          WHERE b."order_id" = ANY($1::bigint[])
            AND EXISTS (SELECT 1 FROM "order_schema"."orders" o
                         WHERE o."id" = b."order_id")`,
        [ids],
      );
      const observations: PointerObservation[] = [];
      for (const row of obsRows) {
        const postId = normalizeObservedPostId(row.post_raw);
        if (postId === undefined) continue;
        observations.push({
          order_id: row.order_id,
          kind: row.kind,
          post_id: postId,
          ts_us: Number(row.ts_us),
          seq: Number(row.seq),
          source: row.source,
        });
      }
      const existingRows = await select<{
        id: string;
        order_id: string;
        kind: MembershipKind;
        post_id: string;
        joined_at_us: string;
        created_at_us: string;
        source: string | null;
      }>(
        runner,
        `SELECT m."id"::text AS "id", m."order_id"::text AS "order_id",
                m."kind", m."post_id"::text AS "post_id",
                ${EPOCH_US('m."joined_at"')}::text AS "joined_at_us",
                ${EPOCH_US('m."created_at"')}::text AS "created_at_us",
                m."source"
           FROM ${TABLE} m
          WHERE m."order_id" = ANY($1::bigint[])`,
        [ids],
      );
      const existing: ExistingMembership[] = existingRows.map((row) => ({
        ...row,
        joined_at_us: Number(row.joined_at_us),
        created_at_us: Number(row.created_at_us),
      }));

      const plan = planBackfill({ observations, existing, cutoffUs });
      report.ordersScanned += new Set(observations.map((o) => o.order_id)).size;
      report.staysPlanned += plan.stays.length;
      report.joinedAtFixesPlanned += plan.joinedAtFixes.length;
      for (const stay of plan.stays) {
        report.staysBySource[stay.source] =
          (report.staysBySource[stay.source] ?? 0) + 1;
      }
      for (const [postId, n] of plan.newMembersByPost) {
        newMembers.set(postId, (newMembers.get(postId) ?? 0) + n);
      }
      if (
        args.apply &&
        (plan.stays.length > 0 || plan.joinedAtFixes.length > 0)
      ) {
        const written = await writePlan(
          runner,
          plan.stays,
          plan.joinedAtFixes,
          args.insertChunk ?? INSERT_CHUNK,
        );
        report.staysInserted += written.inserted;
        report.joinedAtFixesApplied += written.fixed;
        if (written.inserted < plan.stays.length) {
          // Rejadan keyin buyurtma o'chirilgan yoki qator paydo bo'lgan.
          log(
            `[backfill] ogohlantirish: paket ≤ #${lastOrderId}: rejada ${plan.stays.length}, yozildi ${written.inserted}`,
          );
        }
      }
      log(
        `[backfill] paket ≤ #${lastOrderId}: turish ${plan.stays.length}, seed tuzatish ${plan.joinedAtFixes.length}`,
      );
    }

    report.posts = await buildPostReport(runner, newMembers, args.apply);
    return report;
  } finally {
    await runner.query(`DROP TABLE IF EXISTS ${OBS}`).catch(() => undefined);
    if (locked) {
      await runner
        .query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK_KEY])
        .catch(() => undefined);
    }
  }
}
