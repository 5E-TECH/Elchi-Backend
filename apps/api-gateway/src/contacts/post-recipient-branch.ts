import {
  BranchContactLoader,
  branchContactScope,
  type BranchContact,
} from './branch-contact';

/**
 * sZxxo98G (Dilshod 2026-11-27: «Pochta cheklarida kimga joʻnatilgani nomi
 * bor lekin telefon nomeri yuq») — pochta chekidagi QABUL QILUVCHI FILIAL.
 *
 * Kuryer pochtasida chek «Kuryer: Ism · telefon» ni `data.post.courier` dan
 * oladi. Filial o'tkazmasi pochtasida (HQ → filial) kuryer yo'q
 * (`courier_id` '0' / bo'sh) va manzil filialning na nomi, na raqami javobda
 * bor edi — chekda qabul qiluvchi qatori chiqmasdi. Endi `GET
 * /post/orders/:id` va `GET /post/:id/receipt` dagi `data.post` ga
 * `recipient_branch: {id, name, phone_number, manager} | null` qo'shiladi.
 *
 *  - Filial o'tkazmasi = kuryersiz, holati `sent` yoki `received` pochta;
 *    uning `branch_id` — MANZIL filial (`dispatchPostToBranch` →
 *    `logistics.post.receive_orders` `assigned_branch`, `reassign` ham shu
 *    maydonni yangilaydi). `new` (yig'ilmoqda — qayerga ketishi hali
 *    noma'lum) va bekor pochtalar — `null`.
 *  - Kontakt — 0Rn5U6AD `branch.contact` (filial raqami + faol menejeri,
 *    kesh 60 s). Chekdagi raqam: `phone_number`, bo'lmasa menejerniki
 *    (`postRecipientBranchPhone`).
 *  - Kim ko'radi — 0Rn5U6AD bilan bir xil (`branchContactScope`):
 *    superadmin/admin/registrator — har filial; menejer/filial — faqat o'z
 *    filiali (JWT `branch_id`); kuryer, logist va boshqalar — `null`.
 *  - branch-service javob bermasa — `null`, pochta javobi buzilmaydi.
 */

export type PostRecipientBranch = BranchContact;

/** Javobdagi pochta holatlari: filial o'tkazmasi qabul qiluvchisi ma'lum. */
const RECIPIENT_BRANCH_POST_STATUSES: ReadonlySet<string> = new Set([
  'sent',
  'received',
]);

const ID_PATTERN = /^\d{1,19}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const idText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/**
 * Pochta filial o'tkazmasi bo'lsa — manzil filial id'si, aks holda `null`
 * (kuryer pochtasi, yig'ilayotgan yoki bekor pochta, filialsiz pochta).
 */
export function postRecipientBranchId(post: unknown): string | null {
  if (!isRecord(post)) {
    return null;
  }
  const courierId = idText(post.courier_id);
  if (courierId && courierId !== '0') {
    return null;
  }
  const status =
    typeof post.status === 'string' ? post.status.trim().toLowerCase() : '';
  if (!RECIPIENT_BRANCH_POST_STATUSES.has(status)) {
    return null;
  }
  const branchId = idText(post.branch_id);
  return ID_PATTERN.test(branchId) ? branchId : null;
}

/**
 * Chekdagi qabul qiluvchi filial raqami: filialning o'z raqami (filial
 * sozlamasidagi rasmiy raqam), bo'sh bo'lsa — faol menejeri raqami
 * (o'tkazma faqat faol menejeri bor filialga jo'natiladi — qopni u qabul
 * qiladi). Ikkalasi ham yo'q — `null`.
 */
export function postRecipientBranchPhone(
  recipient:
    | {
        phone_number?: string | null;
        manager?: { phone_number?: string | null } | null;
      }
    | null
    | undefined,
): string | null {
  const own =
    typeof recipient?.phone_number === 'string'
      ? recipient.phone_number.trim()
      : '';
  if (own) {
    return own;
  }
  const manager =
    typeof recipient?.manager?.phone_number === 'string'
      ? recipient.manager.phone_number.trim()
      : '';
  return manager || null;
}

/**
 * `{ data: { post } }` javobiga `post.recipient_branch` ni qo'shadi
 * (additive). Pochta meta'si yo'q yoki obyekt emas — javob o'zgarmaydi.
 */
export async function withPostRecipientBranch<T>(
  payload: T,
  user: { roles?: string[]; branch_id?: string | null } | undefined,
  loader: BranchContactLoader,
): Promise<T> {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return payload;
  }
  const post = payload.data.post;
  if (!isRecord(post)) {
    return payload;
  }
  const branchId = postRecipientBranchId(post);
  let recipient: PostRecipientBranch | null = null;
  if (branchId) {
    const scope = branchContactScope(user?.roles);
    const allowed =
      scope === 'any' ||
      (scope === 'own' && idText(user?.branch_id) === branchId);
    if (allowed) {
      recipient = await loader.find(branchId);
    }
  }
  return {
    ...payload,
    data: {
      ...payload.data,
      post: { ...post, recipient_branch: recipient },
    },
  };
}
