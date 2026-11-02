/**
 * Pochta ↔ buyurtma tarixini ESKI yozuvlardan tiklash — SOF funksiyalar
 * (DB'siz, unit testlanadi). DB qismi: `post-membership-backfill.runner.ts`,
 * kirish nuqtasi: `scripts/backfill-post-order-memberships.ts`.
 *
 * Model: har manba qatori — KUZATUV: "`ts_us` vaqtda buyurtmaning `kind`
 * ko'rsatkichi `post_id` edi" (`null` — pochtasiz). Bitta (buyurtma, tur)
 * uchun kuzatuvlar oqimi → ketma-ket takrorlar yig'iladi → "turishlar"
 * (joined_at, left_at, next_post_id).
 *
 * Manbalar USTUNLIK tartibida:
 *   1) `outbox`             — `order_schema.outbox_events`
 *      'search.index.upsert' (buyurtma tranzaksiyasi ICHIDA yoziladi, `id`
 *      bo'yicha tartib — eng ishonchli, har o'zgarishda to'liq surat);
 *   2) `order_activity`     — `order_schema.activity_logs` (Order): `new_value`
 *      dagi post_id / canceled_post_id, o'chirilganlarda `old_value.post_id`;
 *   3) `logistics_activity` — `logistics_schema.activity_logs` (Order):
 *      `scanAssignOrder` ning `{ courier_id, post_id }` qatorlari.
 * Outbox — yagona TO'LIQ manba (har o'zgarishda surat): u boshlangan joydan
 * keyin faqat u ishlatiladi. Jurnal manbalari (2, 3) siyrak va commit'dan
 * KEYIN yoziladi — ular faqat outbox'ning eng erta kuzatuvidan OLDINGI
 * davrni to'ldiradi (aralashtirilsa vaqt siljishi soxta "borib-qaytish"
 * yasardi); o'zaro esa vaqt bo'yicha birlashtiriladi (ayni vaqtda —
 * ustunlik tartibi).
 *
 * Chegara (`bound`): mavjud tarixning eng erta qatori (E) va seed vaqti
 * (`cutoffUs`, migratsiya 201) dan kichigi. Undan keyingi davrni trigger
 * aniq yozgan — backfill faqat undan OLDINGI yopiq turishlarni qo'shadi.
 * Chegara yugurishning MONOTONLANGAN boshlanishiga qo'llanadi (xom `ts_us`
 * ga emas) — qayta yurgizish birinchisi bilan ayni yugurishlarni ko'radi.
 * Oxirgi turish E bilan AYNI pochta bo'lsa — bu E ning o'zi: yangi qator
 * yozilmaydi, faqat seed qatorining `joined_at` i (migratsiya vaqti, haqiqiy
 * emas) tarixdagi kirgan vaqtga to'g'rilanadi — BIR marta: faqat hali
 * tegilmagan seed (`joined_at = created_at`).
 */

export type MembershipKind = 'DELIVERY' | 'CANCELED';

export const BACKFILL_SOURCES = [
  'outbox',
  'order_activity',
  'logistics_activity',
] as const;
export type BackfillSource = (typeof BACKFILL_SOURCES)[number];

/** Turish qatoridagi `source` (varchar(32)). */
export type BackfillRowSource = `backfill_${BackfillSource}`;

export const SEED_SOURCE = 'seed_current';

export interface PointerObservation {
  order_id: string;
  kind: MembershipKind;
  /** `null` — shu paytda ko'rsatkich bo'sh edi. */
  post_id: string | null;
  /** Epoch mikrosekund (Postgres `timestamptz` aniqligi). */
  ts_us: number;
  /** Manba qatori `id` si — manba ichidagi tartib. */
  seq: number;
  source: BackfillSource;
}

export interface ExistingMembership {
  id: string;
  order_id: string;
  kind: MembershipKind;
  post_id: string;
  joined_at_us: number;
  /** Qator yozilgan vaqt (`created_at`, epoch mikrosekund). */
  created_at_us: number;
  source: string | null;
}

export interface PointerRun {
  post_id: string | null;
  start_us: number;
  source: BackfillSource;
}

export interface PlannedStay {
  order_id: string;
  kind: MembershipKind;
  post_id: string;
  joined_at_us: number;
  left_at_us: number;
  next_post_id: string | null;
  source: BackfillRowSource;
}

/** Seed qatorining `joined_at` ini tarixdagi haqiqiy kirgan vaqtga surish. */
export interface JoinedAtFix {
  id: string;
  order_id: string;
  kind: MembershipKind;
  post_id: string;
  joined_at_us: number;
  previous_us: number;
}

export interface OrderKindPlan {
  stays: PlannedStay[];
  joinedAtFix: JoinedAtFix | null;
}

export interface BackfillPlan {
  stays: PlannedStay[];
  joinedAtFixes: JoinedAtFix[];
  /** Pochta → shu rejada YANGI paydo bo'ladigan buyurtmalar soni (hisobot). */
  newMembersByPost: Map<string, number>;
}

const POSITIVE_ID = /^[1-9]\d{0,17}$/;

/**
 * Manba qiymati → pochta id. `null` (JSON null) — ko'rsatkich bo'sh;
 * `undefined` — yaroqsiz (kuzatuv tashlanadi). Kalit umuman bo'lmagan qator
 * SQL'da tashlanadi (`?` operatori) — u "noma'lum", "bo'sh" emas.
 */
export function normalizeObservedPostId(
  raw: unknown,
): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const text = String(raw).trim();
  return POSITIVE_ID.test(text) ? text : undefined;
}

function priorityOf(source: BackfillSource): number {
  return BACKFILL_SOURCES.indexOf(source);
}

/**
 * Bitta (buyurtma, tur) kuzatuvlari → ustunlik bo'yicha tanlangan, xronologik
 * ketma-ketlik: [outbox'dan oldingi jurnal kuzatuvlari] + [outbox].
 *  • outbox ichida `seq` (qator id) tartibi — `created_at` tranzaksiya BOSHI
 *    vaqti, parallel tranzaksiyalarda id tartibidan farq qilishi mumkin; bir
 *    buyurtma uchun to'g'ri tartib — id (qator qulfi bo'yicha);
 *  • jurnallar (har yozuv alohida tranzaksiya) — vaqt, keyin ustunlik, keyin
 *    `seq` bo'yicha.
 */
export function selectByPriority(
  observations: readonly PointerObservation[],
): PointerObservation[] {
  const outbox = observations
    .filter((obs) => obs.source === 'outbox')
    .sort((a, b) => a.seq - b.seq);
  let outboxStart = Number.POSITIVE_INFINITY;
  for (const obs of outbox) outboxStart = Math.min(outboxStart, obs.ts_us);
  const journals = observations
    .filter((obs) => obs.source !== 'outbox' && obs.ts_us < outboxStart)
    .sort(
      (a, b) =>
        a.ts_us - b.ts_us ||
        priorityOf(a.source) - priorityOf(b.source) ||
        a.seq - b.seq,
    );
  return [...journals, ...outbox];
}

/**
 * Tartiblangan kuzatuvlar → "yugurishlar" (ayni ko'rsatkichli ketma-ket
 * davrlar):
 *  1) bir tranzaksiya (ayni manba, ayni `ts_us`) ichidagi oraliq suratlar
 *     tashlanadi — commit bo'lgan holat OXIRGISI;
 *  2) vaqt monoton qilinadi (oldingisidan kichik bo'lsa — oldingisi);
 *  3) ketma-ket ayni `post_id` lar bitta yugurishga yig'iladi.
 */
export function toRuns(ordered: readonly PointerObservation[]): PointerRun[] {
  const committed: PointerObservation[] = [];
  for (const obs of ordered) {
    const prev = committed[committed.length - 1];
    if (prev && prev.source === obs.source && prev.ts_us === obs.ts_us) {
      committed[committed.length - 1] = obs;
    } else {
      committed.push(obs);
    }
  }
  const runs: PointerRun[] = [];
  let lastTs = Number.NEGATIVE_INFINITY;
  for (const obs of committed) {
    const ts = Math.max(obs.ts_us, lastTs);
    lastTs = ts;
    const prev = runs[runs.length - 1];
    if (prev && prev.post_id === obs.post_id) continue;
    runs.push({ post_id: obs.post_id, start_us: ts, source: obs.source });
  }
  return runs;
}

function earliest(
  rows: readonly ExistingMembership[],
): ExistingMembership | null {
  let best: ExistingMembership | null = null;
  for (const row of rows) {
    if (
      !best ||
      row.joined_at_us < best.joined_at_us ||
      (row.joined_at_us === best.joined_at_us &&
        BigInt(row.id) < BigInt(best.id))
    ) {
      best = row;
    }
  }
  return best;
}

/**
 * Seed qatori va `joined_at` i hali migratsiya qo'ygan qiymatda: seed ikkala
 * ustunni ayni `now()` bilan yozadi. Backfill uni bir marta suradi — keyin
 * `joined_at` `created_at` dan farq qiladi va qayta surilmaydi.
 */
export function isPristineSeed(row: ExistingMembership): boolean {
  return row.source === SEED_SOURCE && row.joined_at_us === row.created_at_us;
}

/**
 * Bitta (buyurtma, tur) rejasi: `bound` dan OLDINGI yopiq turishlar va
 * (kerak bo'lsa) seed qatorining `joined_at` tuzatishi.
 */
export function planOrderKind(input: {
  observations: readonly PointerObservation[];
  existing: readonly ExistingMembership[];
  cutoffUs: number;
}): OrderKindPlan {
  const first = earliest(input.existing);
  const bound = first
    ? Math.min(first.joined_at_us, input.cutoffUs)
    : input.cutoffUs;
  // Yugurishlar BARCHA kuzatuvlardan (birinchi yurgizishdagi ayni tanlash va
  // monotonlash), chegara esa MONOTONLANGAN boshlanishga qo'llanadi. Xom
  // `ts_us` bo'yicha oldindan kesilsa: outbox `created_at` — tranzaksiya
  // BOSHI, id bo'yicha kechroq kuzatuvning xom vaqti chegaradan oldinga
  // tushadi va qayta yurgizish soxta orqaga turish qo'shardi yoki seed
  // `joined_at` ini yana surardi. `start_us` monoton — bu prefiks.
  const runs = toRuns(selectByPriority(input.observations)).filter(
    (run) => run.start_us < bound,
  );
  const stays: PlannedStay[] = [];
  let joinedAtFix: JoinedAtFix | null = null;
  // E chegarada turibdi — u oxirgi yugurishning davomi bo'lishi mumkin.
  const atBound = first && first.joined_at_us === bound ? first : null;

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (run.post_id === null) continue;
    const next = runs[index + 1];
    const base = {
      order_id: input.observations[0].order_id,
      kind: input.observations[0].kind,
      post_id: run.post_id,
      joined_at_us: run.start_us,
      source: `backfill_${run.source}` satisfies BackfillRowSource,
    };
    if (next) {
      stays.push({
        ...base,
        left_at_us: next.start_us,
        next_post_id: next.post_id,
      });
      continue;
    }
    if (atBound && atBound.post_id === run.post_id) {
      // Ayni turish — yangi qator emas. Seed `joined_at` i migratsiya vaqti:
      // tarixdagi haqiqiy kirgan vaqtga suriladi (faqat tegilmagan seed).
      if (isPristineSeed(atBound) && run.start_us < atBound.joined_at_us) {
        joinedAtFix = {
          id: atBound.id,
          order_id: atBound.order_id,
          kind: atBound.kind,
          post_id: atBound.post_id,
          joined_at_us: run.start_us,
          previous_us: atBound.joined_at_us,
        };
      }
      continue;
    }
    // Chiqish vaqti noma'lum — eng kech chegara (`bound`) olinadi.
    stays.push({
      ...base,
      left_at_us: bound,
      next_post_id: atBound ? atBound.post_id : null,
    });
  }
  return { stays, joinedAtFix };
}

function keyOf(orderId: string, kind: MembershipKind): string {
  return `${orderId}:${kind}`;
}

/**
 * Turishlar → INSERT bo'laklari (har biri ≈ `size`). Bitta (buyurtma, tur)
 * ning turishlari HECH QACHON ikki bo'lakka bo'linmaydi: INSERT qo'riqchisi
 * (`m.joined_at <= v.joined_at`) shu tranzaksiyadagi OLDINGI bo'lak yozgan
 * qatorlarni ko'radi va kalitning keyingi turishlarini tashlab yuborardi —
 * qayta yurgizish ham tiklamasdi (yozilgan turish yangi chegara bo'ladi).
 * Bitta statement esa o'zi yozgan qatorlarni ko'rmaydi. `size` dan katta
 * bitta kalit — o'zi alohida (kattaroq) bo'lak.
 */
export function chunkStaysByKey(
  stays: readonly PlannedStay[],
  size: number,
): PlannedStay[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`Noto'g'ri bo'lak o'lchami: ${size}`);
  }
  const groups = new Map<string, PlannedStay[]>();
  for (const stay of stays) {
    const key = keyOf(stay.order_id, stay.kind);
    const list = groups.get(key) ?? [];
    list.push(stay);
    groups.set(key, list);
  }
  const out: PlannedStay[][] = [];
  let current: PlannedStay[] = [];
  for (const group of groups.values()) {
    if (current.length > 0 && current.length + group.length > size) {
      out.push(current);
      current = [];
    }
    for (const stay of group) current.push(stay);
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Buyurtmalar to'plami (bitta paket) rejasi. `existing` — shu buyurtmalarning
 * BARCHA mavjud tarix qatorlari (har ikki tur).
 */
export function planBackfill(input: {
  observations: readonly PointerObservation[];
  existing: readonly ExistingMembership[];
  cutoffUs: number;
}): BackfillPlan {
  const obsByKey = new Map<string, PointerObservation[]>();
  for (const obs of input.observations) {
    const key = keyOf(obs.order_id, obs.kind);
    const list = obsByKey.get(key) ?? [];
    list.push(obs);
    obsByKey.set(key, list);
  }
  const existingByKey = new Map<string, ExistingMembership[]>();
  const existingPostsByOrder = new Map<string, Set<string>>();
  for (const row of input.existing) {
    const key = keyOf(row.order_id, row.kind);
    const list = existingByKey.get(key) ?? [];
    list.push(row);
    existingByKey.set(key, list);
    const posts = existingPostsByOrder.get(row.order_id) ?? new Set<string>();
    posts.add(row.post_id);
    existingPostsByOrder.set(row.order_id, posts);
  }

  const stays: PlannedStay[] = [];
  const joinedAtFixes: JoinedAtFix[] = [];
  const newPairs = new Set<string>();
  const newMembersByPost = new Map<string, number>();
  const keys = [...obsByKey.keys()].sort();
  for (const key of keys) {
    const plan = planOrderKind({
      observations: obsByKey.get(key) ?? [],
      existing: existingByKey.get(key) ?? [],
      cutoffUs: input.cutoffUs,
    });
    stays.push(...plan.stays);
    if (plan.joinedAtFix) joinedAtFixes.push(plan.joinedAtFix);
    for (const stay of plan.stays) {
      const pair = `${stay.order_id}:${stay.post_id}`;
      if (
        newPairs.has(pair) ||
        existingPostsByOrder.get(stay.order_id)?.has(stay.post_id)
      ) {
        continue;
      }
      newPairs.add(pair);
      newMembersByPost.set(
        stay.post_id,
        (newMembersByPost.get(stay.post_id) ?? 0) + 1,
      );
    }
  }
  return { stays, joinedAtFixes, newMembersByPost };
}

/** Mikrosekund → ISO (6 kasr xonasi, Postgres aniq o'qiydi). */
export function usToIso(us: number): string {
  if (!Number.isSafeInteger(us)) {
    throw new Error(`Noto'g'ri mikrosekund qiymati: ${us}`);
  }
  const ms = Math.floor(us / 1000);
  const micros = us - ms * 1000;
  return new Date(ms)
    .toISOString()
    .replace('Z', `${String(micros).padStart(3, '0')}Z`);
}

export interface BackfillArgs {
  apply: boolean;
  batchSize: number;
  reportLimit: number;
  /** INSERT bo'lagi (CLI'da yo'q; sukut 1000 — spec kichik qiymat beradi). */
  insertChunk?: number;
}

export const BACKFILL_DEFAULT_BATCH = 2000;
export const BACKFILL_DEFAULT_REPORT_LIMIT = 50;

/**
 * CLI argumentlari. Sukut — DRY-RUN (hech narsa yozilmaydi); yozish faqat
 * `--apply` bilan. `--dry-run` aniq berilsa `--apply` dan ustun (xavfsiz).
 */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const flag = (name: string) => argv.includes(`--${name}`);
  const num = (name: string, fallback: number, max: number): number => {
    const prefix = `--${name}=`;
    const raw = argv.find((arg) => arg.startsWith(prefix));
    if (raw === undefined) return fallback;
    const value = Number(raw.slice(prefix.length));
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(
        `--${name} 1..${max} oralig'idagi butun son bo'lishi kerak`,
      );
    }
    return value;
  };
  return {
    apply: flag('apply') && !flag('dry-run'),
    batchSize: num('batch', BACKFILL_DEFAULT_BATCH, 20_000),
    reportLimit: num('report-limit', BACKFILL_DEFAULT_REPORT_LIMIT, 100_000),
  };
}

export interface PostBackfillReportRow {
  post_id: string;
  /** `null` — pochta (qattiq) o'chirilgan. */
  status: string | null;
  /** `posts.order_quantity` — FAQAT ishora (bekor pochtalarda nolga tushgan). */
  order_quantity: number | null;
  /** Tarixdagi jami buyurtmalar (dry-run'da rejadagilar qo'shilgan). */
  members: number;
  /** Shu yurgizishda yangi paydo bo'lganlar. */
  new_members: number;
}

export interface BackfillReport {
  apply: boolean;
  cutoffIso: string;
  observations: Record<BackfillSource, number>;
  ordersScanned: number;
  staysPlanned: number;
  staysInserted: number;
  staysBySource: Partial<Record<BackfillRowSource, number>>;
  joinedAtFixesPlanned: number;
  joinedAtFixesApplied: number;
  posts: PostBackfillReportRow[];
}

/**
 * Hisobot matni. `order_quantity` — checksum EMAS: pochta sanog'i qisman
 * qaytarish/o'chirishda kamayadi, qabul qilingan bekor pochtalarda nolga
 * tushirilgan — farq xato degani emas.
 */
export function formatBackfillReport(
  report: BackfillReport,
  limit: number,
): string[] {
  const lines: string[] = [];
  lines.push(
    `[backfill] rejim: ${report.apply ? 'APPLY (yozildi)' : 'DRY-RUN (hech narsa yozilmadi)'}`,
  );
  lines.push(`[backfill] chegara (seed vaqti): ${report.cutoffIso}`);
  lines.push(
    `[backfill] kuzatuvlar: ${BACKFILL_SOURCES.map((s) => `${s}=${report.observations[s] ?? 0}`).join(', ')}`,
  );
  lines.push(`[backfill] buyurtmalar: ${report.ordersScanned}`);
  const bySource = Object.entries(report.staysBySource)
    .map(([source, n]) => `${source}=${n}`)
    .join(', ');
  lines.push(
    `[backfill] yopiq turishlar: rejada ${report.staysPlanned}` +
      (report.apply ? `, yozildi ${report.staysInserted}` : '') +
      (bySource ? ` (${bySource})` : ''),
  );
  lines.push(
    `[backfill] seed joined_at tuzatish: rejada ${report.joinedAtFixesPlanned}` +
      (report.apply ? `, yozildi ${report.joinedAtFixesApplied}` : ''),
  );
  const belowHint = report.posts.filter(
    (row) => row.order_quantity !== null && row.members < row.order_quantity,
  ).length;
  lines.push(
    `[backfill] pochtalar: ${report.posts.length} ta yangilandi; ` +
      `${belowHint} tasida topilgan < order_quantity (ishora, checksum emas)`,
  );
  const rows = [...report.posts]
    .sort((a, b) => (BigInt(b.post_id) > BigInt(a.post_id) ? 1 : -1))
    .slice(0, limit);
  if (rows.length) {
    lines.push('post_id\tstatus\torder_quantity(ishora)\ttopildi\tyangi');
    for (const row of rows) {
      lines.push(
        [
          row.post_id,
          row.status ?? "(o'chirilgan)",
          row.order_quantity ?? '-',
          row.members,
          row.new_members,
        ].join('\t'),
      );
    }
    if (report.posts.length > rows.length) {
      lines.push(
        `… yana ${report.posts.length - rows.length} ta pochta (--report-limit)`,
      );
    }
  }
  return lines;
}
