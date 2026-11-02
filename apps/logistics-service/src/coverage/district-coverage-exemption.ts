import {
  Order_status,
  isHqBranch,
  isOrderServedByBranch,
  type CoverageBranch,
  type CoverageDistrict,
} from '@app/common';

/**
 * Tuman ko'chirilganda (boshqa viloyatga yoki boshqa xizmat filialiga) ESKI
 * filialda / uning kuryerida turgan ochiq buyurtmalar eski filialda tugaydi
 * (ega qarori, 2026-11-02) — imtiyoz (exemption) qoidasi.
 *
 * Ko'chish PAYTIDA eski filial (yoki uning kuryeri) qo'lidagi buyurtma uchun
 * `logistics_schema.district_coverage_exemptions` ga (buyurtma, filial)
 * qatori yoziladi: filial uni o'z kuryerlariga berishda davom etadi (kuryer
 * qaytarib bergandan keyin ham). Ko'chishdan KEYIN filialga kelgan buyurtma
 * — faqat yangi filialniki (imtiyoz yo'q).
 *
 * Mas'ul filial (`responsibleBranchId`): yo'ldagi (SENT) partiyada —
 * partiya BORAYOTGAN filial (`batch_destination_branch_id`; HQ → filial
 * FORWARD ham, filial → HQ RETURN ham); aks holda `holder_type`
 * BRANCH/COURIER va `holder_branch_id` bor — o'sha filial (HQ → filial
 * pochtasi: custody jo'natishda filialga o'tadi); aks holda `branch_id`.
 *
 * Imtiyoz (buyurtma o, filial b): b = mas'ul filial, HQ emas, ko'chishdan
 * OLDIN b xizmat qilardi va KEYIN xizmat qilmaydi (`isOrderServedByBranch`).
 * Faqat ochiq custody holatlari va MARKET qo'lida bo'lmagan buyurtmalar.
 * Imtiyozda ko'chishdan KEYINGI buyurtma tumani saqlanadi: qamrov to'sig'i
 * imtiyozni faqat buyurtma hozir o'sha tumanda bo'lsa hisobga oladi.
 * Tumanlar birlashtirilsa (A → B) ko'chgan buyurtmalarning A tumanli
 * qatorlari B ga o'tadi; birlashtirish bekor bo'lsa — u yozgan B tumanli
 * qatorlar o'chadi.
 *
 * Sof funksiyalar: DB/RMQ yo'q.
 */

/** `order.open_custody_by_district` qatori (order-service shartnomasi). */
export interface OpenCustodyRow {
  id: string;
  district_id: string | null;
  region_id: string | null;
  status: string;
  holder_type: string | null;
  holder_branch_id: string | null;
  holder_courier_id: string | null;
  branch_id: string | null;
  courier_id: string | null;
  current_batch_id: string | null;
  /**
   * Yo'ldagi (SENT) partiya borayotgan filial (har ikki yo'nalish); partiya
   * yo'q / hali jo'natilmagan (PENDING) — `null`. Eski order-service
   * qaytarmasa ham `null`.
   */
  batch_destination_branch_id: string | null;
}

/** `order.open_custody_by_district` javobi (`data`). */
export interface OpenCustodyPage {
  rows: OpenCustodyRow[];
  next_after_id: string | null;
}

/** Yoziladigan imtiyoz: (buyurtma, filial) + ko'chishdan keyingi tuman. */
export interface CoverageExemption {
  order_id: string;
  branch_id: string;
  district_id: string | null;
}

/**
 * Haqiqatan yozilgan imtiyoz qatori — `INSERT … RETURNING` (yangi yoki
 * boshqa tumanga qayta yo'naltirilgan / qayta tiklangan).
 */
export interface CreatedCoverageExemption {
  order_id: string;
  branch_id: string;
  district_id: string | null;
}

/** Javob / audit uchun qisqa natija. */
export interface CoverageExemptionSummary {
  created: number;
  by_branch: Array<{ branch_id: string; count: number }>;
}

/** Shartnoma: bitta so'rovdagi tumanlar soni 1..50, sahifa hajmi ≤ 1000. */
export const OPEN_CUSTODY_MAX_DISTRICT_IDS = 50;
export const OPEN_CUSTODY_PAGE_LIMIT = 1000;

/**
 * Imtiyoz jadvali. Migratsiya 1716000000203 — sxema qattiq yozilgan
 * (logistics-service `DB_SCHEMA = logistics_schema`).
 */
export const DISTRICT_COVERAGE_EXEMPTION_TABLE =
  '"logistics_schema"."district_coverage_exemptions"';

/**
 * Ochiq custody holatlari (shartnoma v2). `cancelled` va `sold` HAM: ularni
 * ushlab turgan filial menejeri / kuryer WAITING ga qaytara oladi
 * (`rollbackOrderToWaiting`) — imtiyozsiz buyurtma eski filialda qotib
 * qolardi. `cancelled (sent)` (marketga jo'natilgan) va paid, partly_paid,
 * closed (qaytarishni faqat superadmin qiladi; tarix snapshot'ni
 * shishirmasin), returned_to_market — kirmaydi.
 */
export const COVERAGE_EXEMPTION_OPEN_STATUSES: ReadonlySet<string> =
  new Set<string>([
    Order_status.NEW,
    Order_status.RECEIVED,
    Order_status.WAITING,
    Order_status.WAITING_CUSTOMER,
    Order_status.ON_THE_ROAD,
    Order_status.CANCELLED,
    Order_status.SOLD,
  ]);

const PG_BIGINT_MAX = BigInt('9223372036854775807');

/** Kanonik bigint id ('05' → '5'); yaroqsiz, 0 yoki bigint'dan katta — `null`. */
function canonicalId(value: unknown): string | null {
  let raw = '';
  if (typeof value === 'string') {
    raw = value.trim();
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    raw = String(value);
  }
  if (!/^\d{1,19}$/.test(raw)) {
    return null;
  }
  const parsed = BigInt(raw);
  if (parsed <= BigInt(0) || parsed > PG_BIGINT_MAX) {
    return null;
  }
  return parsed.toString();
}

const upperText = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';

/**
 * Buyurtma uchun mas'ul filial: yo'ldagi (SENT) partiya — u borayotgan
 * filial (buyurtma o'sha yerga ketyapti); aks holda BRANCH/COURIER qo'lida
 * va `holder_branch_id` bor — o'sha filial; aks holda `branch_id`; hech
 * biri — `null`. `batch_destination_branch_id` berilmasa — `null`.
 */
export function responsibleBranchId(
  row: Pick<OpenCustodyRow, 'holder_type' | 'holder_branch_id' | 'branch_id'> &
    Partial<Pick<OpenCustodyRow, 'batch_destination_branch_id'>>,
): string | null {
  const batchDestinationId = canonicalId(row.batch_destination_branch_id);
  if (batchDestinationId) {
    return batchDestinationId;
  }
  const holderType = upperText(row.holder_type);
  const holderBranchId = canonicalId(row.holder_branch_id);
  if ((holderType === 'BRANCH' || holderType === 'COURIER') && holderBranchId) {
    return holderBranchId;
  }
  return canonicalId(row.branch_id);
}

/**
 * Ochiq custody qatori: holat ochiq ro'yxatda va MARKET qo'lida emas.
 * Shartnoma buni order-service'da ham filtrlaydi — bu ikkinchi qatlam.
 */
export function isOpenCustodyRow(
  row: Pick<OpenCustodyRow, 'status' | 'holder_type'>,
): boolean {
  const status =
    typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
  return (
    COVERAGE_EXEMPTION_OPEN_STATUSES.has(status) &&
    upperText(row.holder_type) !== 'MARKET'
  );
}

/**
 * Imtiyoz shartlari (yuqoridagi qoida). `before` / `after` — buyurtma
 * tumanining ko'chishdan oldingi va keyingi qatori; `branch` — mas'ul
 * filial qatori (noma'lum — `null`, imtiyoz yo'q).
 */
export function isCoverageExemptionEligible(input: {
  row: OpenCustodyRow;
  before: CoverageDistrict | null;
  after: CoverageDistrict | null;
  branch: CoverageBranch | null | undefined;
}): boolean {
  const { row, before, after, branch } = input;
  if (!branch || isHqBranch(branch) || !isOpenCustodyRow(row)) {
    return false;
  }
  const branchId = canonicalId(branch.id);
  if (!branchId || branchId !== responsibleBranchId(row)) {
    return false;
  }
  return (
    isOrderServedByBranch(
      { district: before, orderRegionId: row.region_id },
      branch,
    ) &&
    !isOrderServedByBranch(
      { district: after, orderRegionId: row.region_id },
      branch,
    )
  );
}

/**
 * Bitta tuman ko'chishi uchun imtiyozlar: `rows` — o'sha tuman ochiq
 * buyurtmalari, `branchesById` — mas'ul filial qatorlari (kanonik id →
 * qator; yo'q / `null` — noma'lum filial). (buyurtma, filial) takrorlanmaydi.
 * `targetDistrictId` — ko'chishdan KEYINGI buyurtma tumani (birlashtirishda
 * B); berilmasa — qatorning tumani.
 */
export function computeCoverageExemptions(input: {
  rows: readonly OpenCustodyRow[];
  before: CoverageDistrict | null;
  after: CoverageDistrict | null;
  branchesById: ReadonlyMap<string, CoverageBranch | null>;
  targetDistrictId?: string | null;
}): CoverageExemption[] {
  const targetDistrictId =
    input.targetDistrictId === undefined
      ? undefined
      : canonicalId(input.targetDistrictId);
  const exemptions = new Map<string, CoverageExemption>();
  for (const row of input.rows) {
    const orderId = canonicalId(row.id);
    const branchId = responsibleBranchId(row);
    if (!orderId || !branchId) {
      continue;
    }
    const eligible = isCoverageExemptionEligible({
      row,
      before: input.before,
      after: input.after,
      branch: input.branchesById.get(branchId) ?? null,
    });
    const key = `${orderId}:${branchId}`;
    if (eligible && !exemptions.has(key)) {
      exemptions.set(key, {
        order_id: orderId,
        branch_id: branchId,
        district_id:
          targetDistrictId === undefined
            ? canonicalId(row.district_id)
            : targetDistrictId,
      });
    }
  }
  return Array.from(exemptions.values());
}

/** Filial qatori kerak bo'ladigan (ochiq qatorlardagi) mas'ul filiallar. */
export function coverageExemptionCandidateBranchIds(
  rows: readonly OpenCustodyRow[],
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const branchId = isOpenCustodyRow(row) ? responsibleBranchId(row) : null;
    if (branchId) {
      ids.add(branchId);
    }
  }
  return Array.from(ids);
}

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * `order.open_custody_by_district` javobini tekshirish (`successRes`
 * konverti). Noto'g'ri shakl — `null` (chaqiruvchi fail-closed): xato
 * statusi, `rows` massiv emas, id yaroqsiz, `next_after_id` yaroqsiz,
 * `batch_destination_branch_id` bor-u yaroqsiz (jim `null` bo'lsa buyurtma
 * manba filialniki bo'lib qolardi). Bu maydon yo'q (eski order-service) —
 * `null`.
 */
export function parseOpenCustodyPage(
  response: unknown,
): OpenCustodyPage | null {
  if (!response || typeof response !== 'object') {
    return null;
  }
  const envelope = response as { statusCode?: unknown; data?: unknown };
  if (
    envelope.statusCode !== undefined &&
    !(Number(envelope.statusCode) >= 200 && Number(envelope.statusCode) < 300)
  ) {
    return null;
  }
  const data = envelope.data as
    { rows?: unknown; next_after_id?: unknown } | null | undefined;
  if (!data || typeof data !== 'object' || !Array.isArray(data.rows)) {
    return null;
  }
  let nextAfterId: string | null = null;
  if (data.next_after_id !== null && data.next_after_id !== undefined) {
    nextAfterId = canonicalId(data.next_after_id);
    if (!nextAfterId) {
      return null;
    }
  }
  const rows: OpenCustodyRow[] = [];
  for (const raw of data.rows as unknown[]) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const row = raw as Record<keyof OpenCustodyRow, unknown>;
    const id = canonicalId(row.id);
    if (!id) {
      return null;
    }
    const rawDestination = row.batch_destination_branch_id;
    const batchDestinationId = canonicalId(rawDestination);
    if (
      rawDestination !== undefined &&
      rawDestination !== null &&
      !batchDestinationId
    ) {
      return null;
    }
    rows.push({
      id,
      district_id: canonicalId(row.district_id),
      region_id: canonicalId(row.region_id),
      status: textOrNull(row.status) ?? '',
      holder_type: textOrNull(row.holder_type),
      holder_branch_id: canonicalId(row.holder_branch_id),
      holder_courier_id: canonicalId(row.holder_courier_id),
      branch_id: canonicalId(row.branch_id),
      courier_id: canonicalId(row.courier_id),
      current_batch_id: canonicalId(row.current_batch_id),
      batch_destination_branch_id: batchDestinationId,
    });
  }
  return { rows, next_after_id: nextAfterId };
}

/**
 * Imtiyozlarni yozish so'rovi: bitta `INSERT … SELECT unnest(...)`.
 * (order_id, branch_id) allaqachon bor bo'lsa — `ON CONFLICT … DO UPDATE`:
 * tuman boshqacha yoki qator bekor qilingan bo'lsa `district_id` yangi
 * tumanga o'tadi va `revoked_at` NULL bo'ladi (oxirgi ko'chish shu filialga
 * shu buyurtmani yangi tumanda bergan; eski tuman imtiyozi baribir o'lik —
 * to'siq faqat buyurtmaning hozirgi tumanini qabul qiladi, demak ruxsat
 * kengaymaydi). Aynan bir xil qator tegilmaydi: qayta yurgizish xatosiz,
 * dublikatsiz va `RETURNING` faqat yangi / o'zgargan qatorlarni qaytaradi.
 * Bir so'rovda (buyurtma, filial) takrorlanmaydi (DO UPDATE bir qatorga
 * ikki marta tegsa PG xato beradi) — oxirgisi qoladi.
 */
export function coverageExemptionInsertQuery(
  exemptions: readonly CoverageExemption[],
  source: string,
): { sql: string; params: unknown[] } {
  const unique = Array.from(
    new Map(
      exemptions.map((exemption) => [
        `${exemption.order_id}:${exemption.branch_id}`,
        exemption,
      ]),
    ).values(),
  );
  return {
    sql: `
      INSERT INTO ${DISTRICT_COVERAGE_EXEMPTION_TABLE} AS e
        ("order_id", "branch_id", "district_id", "source")
      SELECT t."order_id", t."branch_id", t."district_id", $4
        FROM unnest($1::bigint[], $2::bigint[], $3::bigint[])
          AS t("order_id", "branch_id", "district_id")
      ON CONFLICT ("order_id", "branch_id") DO UPDATE
        SET "district_id" = EXCLUDED."district_id",
            "revoked_at" = NULL,
            "source" = EXCLUDED."source"
        WHERE e."district_id" IS DISTINCT FROM EXCLUDED."district_id"
           OR e."revoked_at" IS NOT NULL
      RETURNING e."order_id"::text AS "order_id",
                e."branch_id"::text AS "branch_id",
                e."district_id"::text AS "district_id"
    `,
    params: [
      unique.map((exemption) => exemption.order_id),
      unique.map((exemption) => exemption.branch_id),
      unique.map((exemption) => exemption.district_id),
      source,
    ],
  };
}

/**
 * Tumanlar birlashtirilgach (A → B): A dan B ga KO'CHGAN buyurtmalarning
 * oldingi ko'chishlardagi A tumanli imtiyozlari B ga qayta yo'naltiriladi —
 * buyurtma tumani tahrirlanmadi, tumanning o'zi birlashdi. Faqat `orderIds`
 * (ko'chganlar): birlashtirishdan oldin A → B tahrirlangan buyurtmaning A
 * tumanli qatori jonlanmaydi. `revoked_at` tegilmaydi.
 */
export function coverageExemptionRetargetQuery(
  fromDistrictId: string,
  toDistrictId: string,
  orderIds: readonly string[],
): { sql: string; params: unknown[] } {
  return {
    sql: `
      UPDATE ${DISTRICT_COVERAGE_EXEMPTION_TABLE}
         SET "district_id" = $2::bigint
       WHERE "district_id" = $1::bigint
         AND "order_id" = ANY($3::bigint[])
      RETURNING "order_id"::text AS "order_id"
    `,
    params: [fromDistrictId, toDistrictId, Array.from(new Set(orderIds))],
  };
}

/**
 * Bekor bo'lgan birlashtirish oldindan yozgan imtiyozlarni o'chirish: faqat
 * berilgan (buyurtma, filial) juftlari va faqat hali shu tuman (B) va shu
 * manbali qatorlar (oraliqda boshqa amal qayta yozgani tegilmaydi).
 */
export function coverageExemptionDeleteQuery(
  exemptions: ReadonlyArray<
    Pick<CreatedCoverageExemption, 'order_id' | 'branch_id'>
  >,
  districtId: string,
  source: string,
): { sql: string; params: unknown[] } {
  return {
    sql: `
      DELETE FROM ${DISTRICT_COVERAGE_EXEMPTION_TABLE} AS e
       USING unnest($1::bigint[], $2::bigint[]) AS t("order_id", "branch_id")
       WHERE e."order_id" = t."order_id"
         AND e."branch_id" = t."branch_id"
         AND e."district_id" = $3::bigint
         AND e."source" = $4
      RETURNING e."order_id"::text AS "order_id"
    `,
    params: [
      exemptions.map((exemption) => exemption.order_id),
      exemptions.map((exemption) => exemption.branch_id),
      districtId,
      source,
    ],
  };
}

/**
 * Yozilgan imtiyozlar xulosasi (`district_id` berilsa — faqat o'sha tuman):
 * jami va filial bo'yicha soni (filial id bo'yicha tartibda).
 */
export function summarizeCoverageExemptions(
  created: readonly CreatedCoverageExemption[],
  districtId?: string,
): CoverageExemptionSummary {
  const counts = new Map<string, number>();
  let total = 0;
  for (const row of created) {
    if (districtId !== undefined && row.district_id !== districtId) {
      continue;
    }
    total += 1;
    counts.set(row.branch_id, (counts.get(row.branch_id) ?? 0) + 1);
  }
  // Kanonik id'lar: avval uzunlik, keyin matn — son tartibi.
  const byBranch = Array.from(counts.entries())
    .map(([branchId, count]) => ({ branch_id: branchId, count }))
    .sort(
      (a, b) =>
        a.branch_id.length - b.branch_id.length ||
        a.branch_id.localeCompare(b.branch_id),
    );
  return { created: total, by_branch: byBranch };
}
