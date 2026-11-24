/**
 * Sayt importi hodisasini tiklash (2026-11-24) — DB qismi (bir martalik ops
 * skripti, `scripts/repair-site-import.ts`).
 *
 * Nima qiladi: noto'g'ri tumanga tushgan sayt buyurtmasiga haqiqiy tuman va
 * viloyatni yozadi va uni o'sha viloyatning YANGI pochtasiga ko'chiradi
 * (pochta bo'lmasa ochiladi). Mijoz kartasidagi xato tuman ham to'g'rilanadi.
 *
 * Xavfsizlik — buyurtmaga faqat HAMMASI to'g'ri kelsa tegiladi:
 *  - `external`, `operator = external_<sayt>`, `external_id` ro'yxatdagidek;
 *  - hali `received`, HQ'da, kuryersiz, paketsiz, o'chirilmagan;
 *  - `region_id` Elchi viloyati EMAS (hodisa belgisi) va tuman kodi aynan shu
 *    qiymat bilan boshlanadi (ro'yxat adashib boshqa buyurtmaga tushmasin);
 *  - pochtasi hali YANGI (yoki o'chirilgan / yo'q). Jo'natilgan pochtaga
 *    TEGILMAYDI — sababi hisobotda.
 * Pul, narx, holat, egalik (custody) o'zgarmaydi. Hammasi bitta tranzaksiyada,
 * buyurtmalar FOR UPDATE; qayta yurgizish xavfsiz (tuzatilgani endi belgiga
 * to'g'ri kelmaydi). DRY-RUN ham shu tranzaksiyada hisoblanib, ROLLBACK
 * qilinadi — hisobot yozishdagi bilan bir xil yo'ldan chiqadi.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';
import type {
  SiteImportRepairPlanRow,
  SiteImportRepairReport,
  SiteImportRepairRow,
} from './site-import-repair';

export interface SiteImportRepairSchemas {
  order: string;
  logistics: string;
  identity: string;
}

export const DEFAULT_SITE_IMPORT_REPAIR_SCHEMAS: SiteImportRepairSchemas = {
  order: 'order_schema',
  logistics: 'logistics_schema',
  identity: 'identity_schema',
};

type Queryable = Pick<
  QueryRunner,
  'query' | 'startTransaction' | 'commitTransaction' | 'rollbackTransaction'
>;

interface OrderRow {
  id: string;
  is_deleted: boolean;
  source: string;
  operator: string | null;
  external_id: string | null;
  status: string;
  holder_type: string | null;
  courier_id: string | null;
  current_batch_id: string | null;
  customer_id: string;
  district_id: string | null;
  region_id: string | null;
  post_id: string | null;
  region_known: boolean;
}

interface DistrictRow {
  id: string;
  name: string;
  sato_code: string;
  region_id: string | null;
  region: string | null;
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`noto'g'ri sxema nomi: ${name}`);
  }
  return `"${name}"`;
}

/** Tegib bo'lmaydigan buyurtma sababi; `null` — tuzatsa bo'ladi. */
export function siteImportSkipReason(
  row: SiteImportRepairRow,
  order: OrderRow | undefined,
  postStatus: string | null,
): string | null {
  if (!order) return 'buyurtma topilmadi';
  if (order.is_deleted) return "o'chirilgan";
  if (order.region_known) return "viloyati to'g'ri — allaqachon tuzatilgan";
  if (
    order.source !== 'external' ||
    order.operator !== `external_${row.site}` ||
    order.external_id !== row.external_id
  ) {
    return "ro'yxatdagi sayt / saytdagi id mos emas";
  }
  if (!row.sato.startsWith(String(order.region_id))) {
    return `tuman kodi ${row.sato} buyurtma viloyati ${order.region_id} ga mos emas`;
  }
  if (order.status !== 'received') return `holati '${order.status}'`;
  if (order.holder_type !== 'HQ') return `HQ'da emas (${order.holder_type})`;
  if (order.courier_id) return 'kuryerda';
  if (order.current_batch_id) return 'filial paketida';
  if (postStatus && postStatus !== 'new') {
    return `pochta #${order.post_id} jo'natilgan ('${postStatus}')`;
  }
  return null;
}

export async function runSiteImportRepair(
  q: Queryable,
  rows: readonly SiteImportRepairRow[],
  options: { apply: boolean },
  schemas: SiteImportRepairSchemas = DEFAULT_SITE_IMPORT_REPAIR_SCHEMAS,
): Promise<SiteImportRepairReport> {
  const orders = `${ident(schemas.order)}."orders"`;
  const logs = `${ident(schemas.order)}."activity_logs"`;
  const posts = `${ident(schemas.logistics)}."posts"`;
  const districts = `${ident(schemas.logistics)}."districts"`;
  const regions = `${ident(schemas.logistics)}."regions"`;
  const users = `${ident(schemas.identity)}."admins"`;
  const runId = randomUUID();
  const report: SiteImportRepairReport = {
    apply: options.apply,
    run_id: runId,
    planned: [],
    skipped: [],
    unlisted: [],
    customers: 0,
  };

  await q.startTransaction();
  try {
    // Jonli ishni kutib qolmaslik: qulf 5 s da olinmasa hammasi qaytariladi.
    await q.query(`SET LOCAL lock_timeout = '5s'`);

    const ids = rows.map((row) => row.order_id);
    const found = (await q.query(
      `SELECT o.id::text AS id, o.is_deleted, o.source::text AS source,
              o.operator, o.external_id, o.status::text AS status,
              o.holder_type::text AS holder_type,
              o.courier_id::text AS courier_id,
              o.current_batch_id::text AS current_batch_id,
              o.customer_id::text AS customer_id,
              o.district_id::text AS district_id,
              o.region_id::text AS region_id, o.post_id::text AS post_id,
              EXISTS (SELECT 1 FROM ${regions} r WHERE r.id = o.region_id) AS region_known
         FROM ${orders} o
        WHERE o.id = ANY($1::bigint[])
        ORDER BY o.id
          FOR UPDATE OF o`,
      [ids],
    )) as OrderRow[];
    const orderById = new Map(found.map((order) => [order.id, order]));

    const postIds = [
      ...new Set(
        found.map((o) => o.post_id).filter((id): id is string => !!id),
      ),
    ];
    const postRows = (await q.query(
      `SELECT id::text AS id, status::text AS status FROM ${posts}
        WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [postIds],
    )) as Array<{ id: string; status: string }>;
    const postStatus = new Map(postRows.map((post) => [post.id, post.status]));

    const districtRows = (await q.query(
      `SELECT d.id::text AS id, d.name, d.sato_code,
              r.id::text AS region_id, r.name AS region
         FROM ${districts} d
         LEFT JOIN ${regions} r ON r.id = COALESCE(d.assigned_region, d.region_id)
        WHERE d.sato_code = ANY($1::varchar[]) AND d.is_deleted = false`,
      [[...new Set(rows.map((row) => row.sato))]],
    )) as DistrictRow[];
    const districtBySato = new Map(districtRows.map((d) => [d.sato_code, d]));

    const targetPostByRegion = new Map<string, string>();
    const touchedPosts = new Set<string>();

    for (const row of rows) {
      const order = orderById.get(row.order_id);
      const reason = siteImportSkipReason(
        row,
        order,
        order?.post_id ? (postStatus.get(order.post_id) ?? null) : null,
      );
      if (reason || !order) {
        report.skipped.push({
          order_id: row.order_id,
          reason: reason ?? 'buyurtma topilmadi',
        });
        continue;
      }
      const district = districtBySato.get(row.sato);
      if (!district?.region_id) {
        report.skipped.push({
          order_id: row.order_id,
          reason: `tuman ${row.sato} topilmadi yoki viloyatsiz`,
        });
        continue;
      }

      const regionId = district.region_id;
      let targetPostId = targetPostByRegion.get(regionId);
      if (!targetPostId) {
        targetPostId = await findOrCreateNewPost(q, posts, regionId);
        targetPostByRegion.set(regionId, targetPostId);
        touchedPosts.add(targetPostId);
      }
      if (order.post_id) touchedPosts.add(order.post_id);

      await q.query(
        `UPDATE ${orders}
            SET district_id = $2, region_id = $3, post_id = $4, "updatedAt" = now()
          WHERE id = $1`,
        [order.id, district.id, regionId, targetPostId],
      );
      // Import kartaga ham xato tumanni yozgan; o'zgargan bo'lsa — tegilmaydi.
      const customer = (await q.query(
        `WITH fixed AS (
           UPDATE ${users} SET district_id = $2, "updatedAt" = now()
            WHERE id = $1 AND role::text = 'customer' AND district_id = $3
            RETURNING id)
         SELECT count(*)::int AS n FROM fixed`,
        [order.customer_id, district.id, order.district_id],
      )) as Array<{ n: number }>;
      report.customers += Number(customer[0]?.n ?? 0);

      await q.query(
        `INSERT INTO ${logs}
           (entity_type, entity_id, action, old_value, new_value, user_id,
            user_name, user_role, service, metadata, description)
         VALUES ('Order', $1, 'updated', $2::jsonb, $3::jsonb, NULL,
                 'ops: repair-site-import', 'system', 'order-service',
                 $4::jsonb, $5)`,
        [
          order.id,
          JSON.stringify({
            district_id: order.district_id,
            region_id: order.region_id,
            post_id: order.post_id,
          }),
          JSON.stringify({
            district_id: district.id,
            region_id: regionId,
            post_id: targetPostId,
          }),
          JSON.stringify({
            reason: 'site_import_district_repair',
            source: 'ops-script',
            run_id: runId,
            sato: row.sato,
          }),
          `Buyurtma #${order.id}: saytdagi haqiqiy tuman (${district.name}, ${district.region ?? '-'}) va viloyat pochtasi #${targetPostId} yozildi`,
        ],
      );
      const planRow: SiteImportRepairPlanRow = {
        order_id: order.id,
        site: row.site,
        old_post_id: order.post_id,
        new_post_id: targetPostId,
        district_id: district.id,
        district: district.name,
        region_id: regionId,
        region: district.region ?? '-',
      };
      report.planned.push(planRow);
    }

    // Pochta hisoblagichlari buyurtmalardan qayta sanaladi (logistics
    // `recountRehomedNewPost` / `collapseDuplicateNewPosts` bilan bir xil).
    if (touchedPosts.size) {
      await q.query(
        `UPDATE ${posts} p
            SET order_quantity = s.n, post_total_price = s.total, "updatedAt" = now()
           FROM (SELECT ids.id,
                        count(o.id)::int AS n,
                        COALESCE(sum(o.total_price), 0) AS total
                   FROM unnest($1::bigint[]) AS ids(id)
                   LEFT JOIN ${orders} o
                     ON o.post_id = ids.id AND o.is_deleted = false
                  GROUP BY ids.id) s
          WHERE p.id = s.id`,
        [[...touchedPosts]],
      );
    }

    report.unlisted = (await q.query(
      `SELECT o.id::text AS order_id, o.operator AS site, o.status::text AS status
         FROM ${orders} o
        WHERE o.source::text = 'external' AND o.operator LIKE 'external\\_%'
          AND o.is_deleted = false AND o.region_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${regions} r WHERE r.id = o.region_id)
          AND NOT (o.id = ANY($1::bigint[]))
        ORDER BY o.id`,
      [ids],
    )) as SiteImportRepairReport['unlisted'];

    if (options.apply) await q.commitTransaction();
    else await q.rollbackTransaction();
    return report;
  } catch (error) {
    await q.rollbackTransaction();
    throw error;
  }
}

/**
 * Viloyatning eng eski YANGI pochtasi (logistics `collapseDuplicateNewPosts`
 * ham aynan shuni asosiy deb qoldiradi), bo'lmasa — yangi. Qulf kaliti
 * `receiveOrdersIntoPosts` niki bilan bir xil: parallel qabul ikkinchi
 * pochta ochmaydi.
 */
async function findOrCreateNewPost(
  q: Queryable,
  posts: string,
  regionId: string,
): Promise<string> {
  await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `post_receive_orders:new:${regionId}:`,
  ]);
  const [existing] = (await q.query(
    `SELECT id::text AS id FROM ${posts}
      WHERE region_id = $1 AND status::text = 'new' AND is_deleted = false
      ORDER BY "createdAt", id LIMIT 1 FOR UPDATE`,
    [regionId],
  )) as Array<{ id: string }>;
  if (existing) return existing.id;
  const [created] = (await q.query(
    `INSERT INTO ${posts}
       (courier_id, qr_code_token, region_id, branch_id, status,
        post_total_price, order_quantity)
     VALUES (0, $2, $1, NULL, 'new', 0, 0)
     RETURNING id::text AS id`,
    [
      regionId,
      `POST-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    ],
  )) as Array<{ id: string }>;
  return created.id;
}
