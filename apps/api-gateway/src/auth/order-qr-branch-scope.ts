import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BranchTransferBatchStatus, Roles as RoleEnum } from '@app/common';
import { isRpcNotFoundError } from '../order-qr-light-view';

/**
 * anKpzwxk (ega qarori 7, 2026-11-03) — BEGONA QR.
 *
 * Filial xodimi (MANAGER, REGISTRATOR, BRANCH akkaunti) yoki HQ bo'lmagan
 * filial kuryeri QR orqali (`GET /orders/qr-code/:token`, to'liq va
 * `?view=light`) O'Z filialida bo'lmagan buyurtmani ochsa — 403
 * «Bu buyurtma sizning filialingizda emas», `data.reason`
 * `order_not_in_your_branch`. Javobda buyurtma ma'lumoti (mijoz, manzil,
 * summa) YO'Q — faqat «sizniki emas».
 *
 * «Sizning filialingizda» — quyidagilardan biri:
 *  1. mas'ul filial (`holder_branch_id ?? branch_id`) so'rovchi filialiga
 *     teng. HQ->filial pochtasi jo'natilganda (branch-service
 *     dispatchPostToBranch) buyurtmaning `branch_id` va `holder_branch_id`
 *     manzil filialiga o'tadi, ya'ni filialga KELAYOTGAN pochta buyurtmasi
 *     shu bandning o'zi bilan ko'rinadi (pochta yozuvi so'ralmaydi);
 *  2. buyurtma filialdan-filialga JO'NATILGAN (SENT) paketda va paket
 *     manzili so'rovchi filiali. Jo'natishda `holder_branch_id` manba
 *     filialda qoladi (qabulda o'zgaradi), shuning uchun `current_batch_id`
 *     bo'yicha paket so'raladi — FAQAT 1-band o'tmaganda va paket bo'lsa;
 *  3. (kuryer) buyurtma shu kuryerda (`courier_id` yoki `holder_courier_id`).
 *
 * Cheklanmaydi: SUPERADMIN/ADMIN, HQ filiali xodimi va HQ kuryeri. MARKET
 * qoidasi (C11, `assertQrOrderVisible`) va LOGIST (QR rollarida yo'q)
 * o'zgarmagan.
 *
 * Filial — gateway'dagi AYNI manba (order-gateway `resolveBranchAssignment`:
 * xodimga JWT `branch_id`, kuryerga branch-service), HQ — `branch.find_hq`.
 * Manbalar `qrOrderBranchScopeRpcDeps` da — QR qidiruvining IKKALA yo'li
 * (`/orders/qr-code/:token` va `/scan/:token`) uchun bitta. Aniqlab
 * bo'lmasa (xizmat xatosi / timeout) — 503 (FAIL-CLOSED: doirasiz javob
 * hech qachon qaytmaydi). Filialga biriktirilmagan xodim/kuryer — 403
 * `branch_not_assigned` (qayta urinish foydasiz, administrator
 * biriktirishi kerak); kuryerga o'zidagi buyurtma baribir ko'rinadi.
 *
 * Eslatma: 1-band kuryerga ham qo'llanadi — HQ->filial pochtasi hali
 * qabul qilinmagan bo'lsa ham uning buyurtmalari kuryerga QR orqali
 * ko'rinadi (7-qaror matni «filialga kelayotgan» ni o'z ichiga oladi),
 * garchi 5-qaror pochtaning o'zini (ro'yxat, `GET /post/:id`) kuryerdan
 * yashirsa ham. Ega boshqacha hal qilsa — spec ataylab qulflangan.
 */
export const ORDER_NOT_IN_YOUR_BRANCH = 'order_not_in_your_branch';
export const ORDER_NOT_IN_YOUR_BRANCH_MESSAGE =
  'Bu buyurtma sizning filialingizda emas';
/** So'rovchi hech qaysi filialga biriktirilmagan — 403, administratorga. */
export const QR_REQUESTER_BRANCH_NOT_ASSIGNED = 'branch_not_assigned';
export const QR_REQUESTER_BRANCH_NOT_ASSIGNED_MESSAGE =
  'Siz hech qaysi filialga biriktirilmagansiz — administratorga murojaat qiling';
/** Filial/HQ/paketni aniqlab bo'lmadi — 503, qayta urinish. */
export const QR_BRANCH_SCOPE_UNAVAILABLE = 'branch_scope_unavailable';
export const QR_BRANCH_SCOPE_UNAVAILABLE_MESSAGE =
  "Filialingizni aniqlab bo'lmadi — birozdan so'ng qayta urinib ko'ring";

type Row = Record<string, unknown>;

export interface QrOrderBranchScopeDeps {
  /** So'rovchi filiali; biriktirilmagan — ''. Xizmat xatosi — tashlaydi. */
  resolveRequesterBranchId: () => Promise<string>;
  /** HQ filial id; HQ yo'q — ''. Xizmat xatosi — tashlaydi. */
  resolveHqBranchId: () => Promise<string>;
  /**
   * Filiallararo paket (`status`, `destination_branch_id`); topilmasa —
   * null. Xizmat xatosi — tashlaydi.
   */
  findTransferBatch: (batchId: string) => Promise<Row | null>;
}

export interface QrOrderBranchScope {
  /**
   * Buyurtmasiz: so'rovchi umuman cheklanmaganmi (rol bo'yicha yoki HQ).
   * Aniqlab bo'lmasa — false: chaqiruvchi sekinroq, lekin to'g'ri yo'lga
   * (`assertVisible`) o'tadi, u esa kerak bo'lsa 503 beradi.
   */
  isUnrestricted(): Promise<boolean>;
  /** Buyurtma so'rovchi filialida emas — 403; aniqlab bo'lmasa — 503. */
  assertVisible(order: unknown): Promise<void>;
}

const BRANCH_STAFF_ROLES: readonly string[] = [
  RoleEnum.BRANCH,
  RoleEnum.MANAGER,
  RoleEnum.REGISTRATOR,
];
/** O'z qoidasi bor rollar: SA/admin — cheklanmaydi, market — C11. */
const OWN_RULE_ROLES: readonly string[] = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.MARKET,
];

const normalizeRoles = (roles?: readonly unknown[] | null): string[] =>
  (roles ?? [])
    .map((role) => (typeof role === 'string' ? role.trim().toLowerCase() : ''))
    .filter(Boolean);

const str = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint'
    ? String(value).trim()
    : '';

/** snake_case maydon (order-service qatori), bo'lmasa camelCase nusxasi. */
const field = (row: Row, key: string): string =>
  str(row[key]) ||
  str(row[key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())]);

/** Mas'ul filial: `holder_branch_id ?? branch_id`. */
export function qrOrderResponsibleBranchId(order: Row): string {
  return field(order, 'holder_branch_id') || field(order, 'branch_id');
}

/** Buyurtma shu kuryerdami (`courier_id` yoki `holder_courier_id`). */
export function isQrOrderHeldByCourier(order: Row, courierId: string): boolean {
  const id = str(courierId);
  return (
    Boolean(id) &&
    (field(order, 'courier_id') === id ||
      field(order, 'holder_courier_id') === id)
  );
}

/** Rol bo'yicha begona QR doirasi qo'llanadimi (filial xodimi / kuryer). */
export function isQrBranchScopedRequester(
  roles?: readonly unknown[] | null,
): boolean {
  const normalized = normalizeRoles(roles);
  if (normalized.some((role) => OWN_RULE_ROLES.includes(role))) {
    return false;
  }
  return (
    normalized.includes(RoleEnum.COURIER) ||
    normalized.some((role) => BRANCH_STAFF_ROLES.includes(role))
  );
}

const notInYourBranch = (): ForbiddenException =>
  new ForbiddenException({
    statusCode: 403,
    message: ORDER_NOT_IN_YOUR_BRANCH_MESSAGE,
    data: { reason: ORDER_NOT_IN_YOUR_BRANCH },
  });

const branchNotAssigned = (): ForbiddenException =>
  new ForbiddenException({
    statusCode: 403,
    message: QR_REQUESTER_BRANCH_NOT_ASSIGNED_MESSAGE,
    data: { reason: QR_REQUESTER_BRANCH_NOT_ASSIGNED },
  });

const scopeUnavailable = (): ServiceUnavailableException =>
  new ServiceUnavailableException({
    statusCode: 503,
    message: QR_BRANCH_SCOPE_UNAVAILABLE_MESSAGE,
    data: { reason: QR_BRANCH_SCOPE_UNAVAILABLE },
  });

/** Xizmat xatosi (timeout ham) — 503; javob doirasiz chiqmaydi. */
const orUnavailable = <T>(promise: Promise<T>): Promise<T> =>
  promise.catch(() => {
    throw scopeUnavailable();
  });

/**
 * So'rov uchun doira. Filial va HQ so'rovi bir so'rov ichida bir marta
 * (light yo'lida `isUnrestricted` va `assertVisible` ikkalasi ishlaydi).
 */
export function createQrOrderBranchScope(
  user: { sub?: string; roles?: string[] } | undefined,
  deps: QrOrderBranchScopeDeps,
): QrOrderBranchScope {
  const roles = normalizeRoles(user?.roles);
  const applies = isQrBranchScopedRequester(roles);
  const courierId = roles.includes(RoleEnum.COURIER) ? str(user?.sub) : '';

  let branchPromise: Promise<string> | null = null;
  const requesterBranchId = (): Promise<string> => {
    if (!branchPromise) {
      branchPromise = deps.resolveRequesterBranchId().then(str);
    }
    return branchPromise;
  };
  let hqPromise: Promise<boolean> | null = null;
  const requesterIsHq = (): Promise<boolean> => {
    if (!hqPromise) {
      hqPromise = requesterBranchId().then(async (branchId) => {
        if (!branchId) {
          return false;
        }
        const hqBranchId = str(await deps.resolveHqBranchId());
        return Boolean(hqBranchId) && hqBranchId === branchId;
      });
    }
    return hqPromise;
  };

  /** 2-band: SENT paketda va paket manzili — so'rovchi filiali. */
  const isHeadingInSentBatch = async (
    order: Row,
    branchId: string,
  ): Promise<boolean> => {
    const batchId = field(order, 'current_batch_id');
    if (!batchId) {
      return false;
    }
    const batch = await deps.findTransferBatch(batchId);
    const sent: string = BranchTransferBatchStatus.SENT;
    return (
      Boolean(batch) &&
      str(batch?.status).toUpperCase() === sent &&
      field(batch ?? {}, 'destination_branch_id') === branchId
    );
  };

  return {
    async isUnrestricted(): Promise<boolean> {
      if (!applies) {
        return true;
      }
      try {
        return await requesterIsHq();
      } catch {
        return false;
      }
    },

    async assertVisible(order: unknown): Promise<void> {
      if (!applies || !order || typeof order !== 'object') {
        return;
      }
      const row = order as Row;
      // 3-band — RMQ'siz: kuryerning o'zidagi buyurtma.
      if (isQrOrderHeldByCourier(row, courierId)) {
        return;
      }
      const branchId = await orUnavailable(requesterBranchId());
      if (!branchId) {
        throw branchNotAssigned();
      }
      if (qrOrderResponsibleBranchId(row) === branchId) {
        return;
      }
      if (await orUnavailable(requesterIsHq())) {
        return;
      }
      if (await orUnavailable(isHeadingInSentBatch(row, branchId))) {
        return;
      }
      throw notInYourBranch();
    },
  };
}

type RpcSend = (
  pattern: { cmd: string },
  payload: Record<string, unknown>,
) => Promise<unknown>;

/** Chaqiruvchi controller'ning timeout'li RMQ yuboruvchilari. */
export interface QrOrderBranchScopeRpc {
  sendOrder: RpcSend;
  sendBranch: RpcSend;
}

const dataRow = (response: unknown): Row | null => {
  const data = (response as { data?: unknown } | null)?.data;
  return data && typeof data === 'object' ? (data as Row) : null;
};

/**
 * Doira manbalari RMQ orqali (QR qidiruvining ikkala yo'li uchun bitta):
 *  - filial — order-gateway `resolveBranchAssignment` bilan AYNI: filial
 *    xodimiga JWT `branch_id`, bo'lmasa (kuryer ham)
 *    `branch.user.find_by_user`; qator yo'q — '';
 *  - HQ — `branch.find_hq` (keshni chaqiruvchi o'zi almashtirishi mumkin);
 *  - paket — `order.transfer_batch.find_by_id`, 404 — null.
 * Xizmat xatosi (timeout ham) chaqiruvchiga uzatiladi -> 503.
 */
export function qrOrderBranchScopeRpcDeps(
  user:
    { sub?: string; roles?: string[]; branch_id?: string | null } | undefined,
  rpc: QrOrderBranchScopeRpc,
): QrOrderBranchScopeDeps {
  return {
    resolveRequesterBranchId: async () => {
      const roles = normalizeRoles(user?.roles);
      const jwtBranchId = str(user?.branch_id);
      if (
        jwtBranchId &&
        roles.some((role) => BRANCH_STAFF_ROLES.includes(role))
      ) {
        return jwtBranchId;
      }
      const userId = str(user?.sub);
      if (!userId) {
        return '';
      }
      const assignment = dataRow(
        await rpc.sendBranch(
          { cmd: 'branch.user.find_by_user' },
          {
            user_id: userId,
            requester: { id: userId, roles: user?.roles ?? [] },
          },
        ),
      );
      return assignment ? field(assignment, 'branch_id') : '';
    },
    resolveHqBranchId: async () =>
      str(dataRow(await rpc.sendBranch({ cmd: 'branch.find_hq' }, {}))?.id),
    findTransferBatch: async (batchId) => {
      try {
        return dataRow(
          await rpc.sendOrder(
            { cmd: 'order.transfer_batch.find_by_id' },
            { id: batchId },
          ),
        );
      } catch (error) {
        if (isRpcNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    },
  };
}
