import { EntityManager, In, Raw, type FindOperator } from 'typeorm';
import { CashboxHistory } from '../entities/cashbox-history.entity';

/**
 * (2026-11-26, ega) O'TKAZMA IZI — pul kassaga KIRMAGAN, lekin kassa tarixida
 * bir to'lov ichida ikki qator bo'lib turadi: «Kirim +X» va «Chiqim −X»
 * (sof 0). Masalan «Marketga o'tkazma»: kuryer pulni to'g'ridan-to'g'ri
 * marketga o'tkazadi, asosiy (HQ yozgan) yoki filial (menejer yozgan) kassasida
 * iz qoladi; «Filialdan marketga o'tkazma» — asosiy kassada. Shunday juftning
 * teskari yozuvlari (T6) ham xuddi shu shaklda.
 *
 * Qoida (umumiy, to'lov turidan qat'i nazar): BITTA `transfer_id` ichida AYNI
 * kassada teskari amalli, TENG summali boshqa (o'chirilmagan) oyoq bor.
 * Bunday qator «Kirim» / «Chiqim» jamilariga kirmaydi — qoldiq o'zgarmaydi,
 * «Davr boshida + kirim − chiqim = davr oxirida» saqlanadi (juft bir lahzada
 * yoziladi, har doim bitta kunda). Ro'yxatda u bitta kulrang qator (frontend).
 */

/**
 * SQL predikati: `alias` qatori o'tkazma izi. `historyTable` — to'liq nom
 * (sxema bilan, tirnoqlangan).
 */
export const passThroughSql = (alias: string, historyTable: string) =>
  `(${alias}."transfer_id" IS NOT NULL AND EXISTS (
     SELECT 1 FROM ${historyTable} pt
      WHERE pt."transfer_id" = ${alias}."transfer_id"
        AND pt."cashbox_id" = ${alias}."cashbox_id"
        AND pt."operation_type" <> ${alias}."operation_type"
        AND pt."amount" = ${alias}."amount"
        AND pt."is_deleted" = false
        AND pt."id" <> ${alias}."id"))`;

/**
 * TypeORM `find` uchun: `transfer_id` ustuniga qo'yiladi — iz qatorlari
 * CHIQARILADI (`exclude`) yoki FAQAT ular qoladi (`only`). Asosiy jadval
 * taxallusi Raw bergan ustun ifodasidan olinadi.
 */
export const passThroughFilter = (
  historyTable: string,
  mode: 'exclude' | 'only',
): FindOperator<string> =>
  Raw((column) => {
    const dot = column.lastIndexOf('.');
    const raw = dot > 0 ? column.slice(0, dot) : column;
    // TypeORM taxallusni tirnoqsiz berishi mumkin — Postgres uni kichik
    // harfga o'girardi («missing FROM-clause entry»).
    const alias = raw.startsWith('"') ? raw : `"${raw}"`;
    const predicate = passThroughSql(alias, historyTable);
    return mode === 'exclude' ? `NOT ${predicate}` : predicate;
  });

type LegLike = {
  id: string | number;
  transfer_id?: string | null;
  cashbox_id?: string | number | null;
  operation_type?: unknown;
  amount?: unknown;
};

const tiyin = (value: unknown) => Math.round(Number(value) * 100);

/**
 * Qatorlar ichidagi iz qatorlari → juftining id si (`qator id → juft id`).
 * BITTA so'rov (`transfer_id IN (...)`, 1000 talab), N+1 yo'q. Juft qator
 * sahifada bo'lmasa ham topiladi.
 */
export async function passThroughPartners(
  manager: EntityManager,
  rows: readonly LegLike[],
): Promise<Map<string, string>> {
  const partners = new Map<string, string>();
  const transferIds = [
    ...new Set(
      rows
        .map((row) => (row?.transfer_id ? String(row.transfer_id) : ''))
        .filter(Boolean),
    ),
  ];
  if (!transferIds.length) return partners;
  const legs: CashboxHistory[] = [];
  for (let i = 0; i < transferIds.length; i += 1000) {
    legs.push(
      ...(await manager.find(CashboxHistory, {
        where: {
          transfer_id: In(transferIds.slice(i, i + 1000)),
          isDeleted: false,
        },
        select: ['id', 'transfer_id', 'cashbox_id', 'operation_type', 'amount'],
      })),
    );
  }
  const byGroup = new Map<string, CashboxHistory[]>();
  for (const leg of legs) {
    const key = `${String(leg.transfer_id)}:${String(leg.cashbox_id)}`;
    const group = byGroup.get(key) ?? [];
    group.push(leg);
    byGroup.set(key, group);
  }
  for (const row of rows) {
    if (!row?.transfer_id) continue;
    const group =
      byGroup.get(`${String(row.transfer_id)}:${String(row.cashbox_id)}`) ?? [];
    const partner = group.find(
      (leg) =>
        String(leg.id) !== String(row.id) &&
        String(leg.operation_type) !== String(row.operation_type) &&
        tiyin(leg.amount) === tiyin(row.amount),
    );
    if (partner) partners.set(String(row.id), String(partner.id));
  }
  return partners;
}

/**
 * Qatorlarga belgi: iz qatori — `pass_through: true` va `pass_through_pair_id`
 * (o'sha kassadagi juft qator). Boshqa qatorlar o'zgarmaydi (kalit yo'q).
 */
export function markPassThrough<T extends { id: string | number }>(
  rows: T[],
  partners: ReadonlyMap<string, string>,
): Array<T & { pass_through?: true; pass_through_pair_id?: string }> {
  if (!partners.size) return rows;
  return rows.map((row) => {
    const pair = row ? partners.get(String(row.id)) : undefined;
    return pair
      ? { ...row, pass_through: true as const, pass_through_pair_id: pair }
      : row;
  });
}
