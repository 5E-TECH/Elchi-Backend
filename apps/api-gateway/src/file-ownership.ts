/**
 * (dgvwZasd B) Shaxsiy fayl egaligi reestri — gateway tomoni.
 *
 * Kim yuklagani `file_schema.file_objects` da (file-service, `file.find_owner`)
 * turadi; o'qish qoidasi `FileGatewayController.assertCanAccessPrivateKey` da.
 *
 * `FILE_OWNERSHIP_ENFORCE=on` bo'lmaguncha reestr FAQAT YOZILADI — o'qish
 * eski qoida bilan (sukut `off`, prod'da egasi qo'lda yoqadi).
 */

export const fileOwnershipEnforced = (): boolean =>
  String(process.env.FILE_OWNERSHIP_ENFORCE ?? '')
    .trim()
    .toLowerCase() === 'on';

/** `file.upload` to'lovidagi `owner`. */
export interface FileOwnerPayload {
  id: string;
  role: string | null;
  branch_id: string | null;
}

/** So'rovchi (JWT) → yuklovchi; `sub` yo'q — reestrga yozilmaydi. */
export function fileOwnerOf(
  user:
    | {
        sub?: string | number;
        roles?: string[];
        branch_id?: string | number | null;
      }
    | undefined,
): FileOwnerPayload | undefined {
  const id = String(user?.sub ?? '').trim();
  if (!id) return undefined;
  const role = String(user?.roles?.[0] ?? '').trim();
  const branchId = String(user?.branch_id ?? '').trim();
  return { id, role: role || null, branch_id: branchId || null };
}

/** `file.find_owner` javobidagi qator. */
export interface FileOwnerRecord {
  key: string;
  owner_id: string | null;
  owner_role: string | null;
  owner_branch_id: string | null;
}

/** `order.find_owner_by_proof_file` javobi — dalil biriktirilgan buyurtma. */
export interface ProofOrderOwner {
  market_id?: string | null;
  courier_id?: string | null;
  holder_courier_id?: string | null;
  branch_id?: string | null;
  holder_branch_id?: string | null;
  home_branch_id?: string | null;
}

/** So'rovchi buyurtmaning marketi yoki kuryeri (`sub` bilan). */
export function isOrderParticipant(
  order: ProofOrderOwner | null,
  sub: string,
): boolean {
  if (!order || !sub) return false;
  return (
    String(order.market_id ?? '') === sub ||
    String(order.courier_id ?? '') === sub ||
    String(order.holder_courier_id ?? '') === sub
  );
}

/** Filial doirasi — `GET /orders/:id` qoidasi bilan AYNI uch ustun. */
export function isOrderInBranch(
  order: ProofOrderOwner | null,
  branchId: string,
): boolean {
  if (!order || !branchId) return false;
  return [order.branch_id, order.holder_branch_id, order.home_branch_id].some(
    (id) => String(id ?? '') === branchId,
  );
}
