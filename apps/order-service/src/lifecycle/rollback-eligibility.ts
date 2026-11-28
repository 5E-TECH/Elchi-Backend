import {
  ORDER_ROLLBACK_ERROR_CODES as RB,
  ORDER_ROLLBACK_MESSAGES,
  Order_status,
  Roles,
  SettlementStatus,
  type OrderRollbackErrorCode,
} from '@app/common';

/**
 * Buyurtma rollback ruxsati — BITTA MANBA (ega qarorlari D1–D4, 2026-11-19).
 *
 * `POST /orders/rollback/:id` ham, buyurtma ro'yxati / tafsilotidagi
 * `rollback: { allowed, code, message }` maydoni ham shu sof funksiyadan
 * foydalanadi: kontekst (`RollbackEligibilityContext`) bir marta, partiya
 * bilan yig'iladi (`OrderLifecycleService.loadRollbackContexts`), qaror esa
 * shu yerda — I/O yo'q.
 *
 *  • SUPERADMIN (D2) — SOLD / CANCELLED / CLOSED / PAID / PARTLY_PAID, har
 *    hisob-kitob bosqichida (kuryerda, filialda, HQ'da, market to'langan,
 *    filial marketga to'lagan). Daftar avtomatik teskari yozib bo'lmaydigan
 *    holat (M6 sabablari) — `CORRECTION_REQUIRED`. HQ sotuvi (Toshkent
 *    kuryeri yoki HQ menejeri; qatorda `branch_id` NULL — filial bo'g'ini
 *    yo'q) ham (2026-11-27, `hqCourierCreditBlocker`).
 *  • Kuryer / menejer rad xabarlari market to'lovini oshkor qilmaydi (ega,
 *    2026-11-27): HQ ↔ market hisob-kitobi ularning ishi emas.
 *  • MENEJER — faqat o'z filiali, `can_sell_cancel` (D3, aks holda 403):
 *      – pul kuryerda (PENDING) — ruxsat;
 *      – kuryer filialga topshirgan (COURIER_SETTLED, D1) — ruxsat (M6 kredit
 *        yo'li); M6 sabablari — `SUPERADMIN_ONLY`;
 *      – HQ'ga o'tgan / market to'langan / filial marketga to'lagan —
 *        `SUPERADMIN_ONLY`;
 *      – bekor buyurtma faqat posilka o'z filialida yoki o'z filiali
 *        kuryerida (D4), jo'natilgan — `PARCEL_NOT_IN_BRANCH`.
 *  • KURYER — avvalgi qoidalar (faqat o'ziga biriktirilgan; topshirilgan pul
 *    — `COURIER_REMITTED`); bekor posilka faqat o'z qo'lida (D4).
 */
export interface RollbackActor {
  id: string;
  roles: string[];
  branch_id: string | null;
  /** Menejerning `can_sell_cancel` huquqi (boshqa rollarda e'tiborsiz). */
  can_sell_cancel: boolean | null;
}

export interface RollbackOrderView {
  status: string;
  sold_at?: Date | string | null;
  holder_type?: string | null;
  holder_branch_id?: string | null;
  holder_courier_id?: string | null;
  branch_id?: string | null;
  courier_id?: string | null;
  /** Bekorlar pochtasi (solingan / jo'natilgan) — S11. */
  canceled_post_id?: string | null;
  /** Qo'shimcha xarajat snapshoti (A-F6: kuryersiz bekor — pul oyog'i bormi). */
  extra_cost?: number | string | null;
}

export interface RollbackSaleView {
  status: string;
  courier_id?: string | null;
  branch_id?: string | null;
  courier_amount?: number | string | null;
  market_paid_by_branch_at?: Date | string | null;
  market_paid_by_branch_amount?: number | string | null;
}

export interface RollbackEligibilityContext {
  actor: RollbackActor;
  order: RollbackOrderView;
  /** Buyurtma pochtasining kuryeri (`post_id` bo'lmasa — null). */
  postCourierId: string | null;
  /** `kind = 'sale'` hisob-kitob qatori (yo'q — null). */
  sale: RollbackSaleView | null;
  /** Posilka egasi kuryer bo'lsa — uning hozirgi filiali (D4). */
  holderCourierBranchId: string | null;
  /** Sotuv qatori kuryerining hozirgi filiali (M6: kredit shu filialda). */
  saleCourierBranchId: string | null;
  /** HQ filiali id si (M6: HQ qatoriga kredit yozilmaydi). */
  hqBranchId: string | null;
  /** `order_settlement_carry` jadvali bormi. */
  carryTablePresent: boolean;
  /**
   * Daftar ↔ kassa moslik xatosi (M6 snapshot, kechiktirilgan E rejasi) —
   * yuklovchi hisoblaydi; `null` — mos.
   */
  ledgerMismatch: string | null;
  /**
   * `false` — hisob-kitob hali o'qilmagan (yuklovchining 1-bosqichi): 5-qadam
   * (hisob-kitob bosqichi) baholanmaydi, faqat oldingi qadamlar rad etadi.
   */
  settlementLoaded?: boolean;
  /**
   * B-3 — migratsiya 246 konvertatsiya izida shu sotuv qatori bor: filial
   * marketga to'lagan qism ustunlardan o'chirilgan (konvertatsiya qilingan),
   * qator esa oddiy COURIER_SETTLED ko'rinadi. Avtomatik qaytarish yo'q.
   */
  conversionTraced?: boolean;
  /**
   * A-F8 — kuryerning `courier_to_branch` qoldig'i boshqa filialga bog'langan
   * (musbat) — kreditni qo'shib bo'lmaydi (`creditRemittedCourierCarry` sharti).
   */
  saleCourierCarryBranchId?: string | null;
  saleCourierCarryAmount?: number | null;
}

export interface RollbackEligibility {
  allowed: boolean;
  code: OrderRollbackErrorCode | null;
  message: string | null;
  /** Rad etilganda HTTP holati (403 — huquq, aks holda 400). */
  httpStatus: 400 | 403 | null;
  /**
   * Ruxsat berilganda daftar qaysi yo'l bilan teskari yoziladi:
   *  • `plain` — pul kuryerda (yoki sotuv qatori yo'q);
   *  • `courier_remitted` — M6 / D1 (kuryer qoldig'iga kredit);
   *  • `settled` — D2, superadmin: HQ'ga o'tgan / market to'langan / filial
   *    marketga to'lagan qator (kuryer + filial kredit, market debet).
   */
  path: 'plain' | 'courier_remitted' | 'settled' | null;
}

const toTiyin = (value: unknown): number =>
  Math.round((Number(value ?? 0) || 0) * 100);

const norm = (value: unknown): string => {
  const raw =
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
      ? String(value).trim()
      : '';
  return /^\d+$/.test(raw) ? String(BigInt(raw)) : raw;
};

const hasRole = (actor: Pick<RollbackActor, 'roles'>, role: string): boolean =>
  (actor.roles ?? []).some(
    (item) => String(item).toLowerCase() === String(role).toLowerCase(),
  );

/**
 * A-F9 — rol ustuvorligi (bir nechta rolli JWT): superadmin > kuryer >
 * menejer. Endpoint ham, eligibility ham AYNAN shu tanlov bilan ishlaydi.
 */
export function effectiveRollbackRole(
  actor: Pick<RollbackActor, 'roles'>,
): 'superadmin' | 'courier' | 'manager' | null {
  if (hasRole(actor, Roles.SUPERADMIN)) return 'superadmin';
  if (hasRole(actor, Roles.COURIER)) return 'courier';
  if (hasRole(actor, Roles.MANAGER)) return 'manager';
  return null;
}

function deny(
  code: OrderRollbackErrorCode,
  message?: string | null,
): RollbackEligibility {
  return {
    allowed: false,
    code,
    message: message ?? ORDER_ROLLBACK_MESSAGES[code],
    httpStatus:
      code === RB.NO_PERMISSION || code === RB.NOT_ALLOWED_ROLE ? 403 : 400,
    path: null,
  };
}

function allow(path: RollbackEligibility['path']): RollbackEligibility {
  return { allowed: true, code: null, message: null, httpStatus: null, path };
}

/** Filial o'z kassasidan market ulushini (qisman ham) to'laganmi (PR-C). */
export function isBranchPaidMarketSale(
  sale: RollbackSaleView | null | undefined,
): boolean {
  return (
    Boolean(sale?.market_paid_by_branch_at) ||
    toTiyin(sale?.market_paid_by_branch_amount) !== 0
  );
}

/** Kuryer pulni filialga topshirganmi (audit M6 — `isCourierRemittedSettlement`). */
export function isRemittedSale(
  sale: RollbackSaleView | null | undefined,
): boolean {
  if (!sale || sale.status !== SettlementStatus.COURIER_SETTLED) return false;
  return Boolean(norm(sale.courier_id)) && toTiyin(sale.courier_amount) !== 0;
}

/**
 * S6 — kuryer qo'shimcha xarajat krediti (manfiy qator) bilan bekor qilgan
 * va uni topshiriqda ishlatgan buyurtma: avtomatik qaytarish kuryer
 * qoldig'ini manfiy qilardi. Xabar foydalanuvchiga YO'L ko'rsatadi (T6 —
 * to'lovni qaytarish / tahrirlash, keyin qator yana ochiq bo'ladi).
 */
export const REMITTED_CREDIT_ROW_MESSAGE =
  "Bu buyurtmada qo'shimcha xarajat krediti (manfiy (kredit) summa) bor va kuryer pulni filialga " +
  "topshirib bo'lgan — avtomatik qaytarib bo'lmaydi. Superadmin: Moliya → kuryer to'lovlari " +
  "tarixida shu topshiriqni qaytaring yoki tahrirlang (T6); shundan keyin buyurtmani qaytarish mumkin bo'ladi";

/**
 * M6 — kuryer topshirgan summani uning qoldig'iga kredit qilish xavfsizmi.
 * `null` — xavfsiz; aks holda aniq sabab. `prepareRemittedCourierCredit`
 * bilan AYNAN bir xil shartlar.
 */
export function remittedCreditBlocker(
  ctx: Pick<
    RollbackEligibilityContext,
    | 'sale'
    | 'saleCourierBranchId'
    | 'hqBranchId'
    | 'carryTablePresent'
    | 'saleCourierCarryBranchId'
    | 'saleCourierCarryAmount'
  >,
): string | null {
  const sale = ctx.sale;
  if (!sale || !norm(sale.courier_id)) {
    return 'Kuryer hisob-kitob qatori topilmadi — rollback bajarilmadi';
  }
  if (toTiyin(sale.courier_amount) <= 0) {
    return REMITTED_CREDIT_ROW_MESSAGE;
  }
  const branchId = norm(sale.branch_id);
  if (!branchId) {
    return "Kuryer to'lovi filialsiz qatorda — rollback mumkin emas (naqd HQ'da)";
  }
  if (ctx.hqBranchId && branchId === norm(ctx.hqBranchId)) {
    return (
      "Bu qator HQ filialiga yozilgan — kuryer kreditini avtomatik yozib bo'lmaydi, " +
      'rollback bajarilmadi'
    );
  }
  if (!ctx.carryTablePresent) {
    return (
      "Hisob-kitob qoldig'i jadvali topilmadi — kuryer kreditini yozib bo'lmaydi, " +
      'rollback bajarilmadi'
    );
  }
  if (norm(ctx.saleCourierBranchId) !== branchId) {
    return (
      'Kuryer endi boshqa filialda (yoki filialga biriktirilmagan) — topshirilgan ' +
      "summani uning hisobiga o'tkazib bo'lmaydi, rollback bajarilmadi"
    );
  }
  // A-F8 — `creditRemittedCourierCarry` bilan AYNI shart: boshqa filialga
  // yozilgan noldan farqli qoldiq (musbat yoki manfiy — kuryer qarzi).
  if (
    toTiyin(ctx.saleCourierCarryAmount ?? 0) !== 0 &&
    norm(ctx.saleCourierCarryBranchId) !== branchId
  ) {
    return 'Kuryerda boshqa filialga tegishli qoldiq bor — rollback bajarilmadi';
  }
  return null;
}

/**
 * 2026-11-27 — HQ sotuvi qatori (`branch_id` NULL: `resolveSettlementBranchId`
 * HQ uchun null yozadi) superadmin tomonidan qaytarilganda kuryer kreditining
 * sharti. Filial bo'g'ini yo'q: HQ kuryeri naqdni to'g'ridan-to'g'ri HQ'ga
 * topshiradi (qator darhol BRANCH_SETTLED), shuning uchun kredit kuryerning
 * HQ qoldig'iga (`courier_to_branch`, `branch_id` NULL — FIFO HQ kuryeri
 * uchun aynan shunday saqlaydi) yoziladi. `null` — xavfsiz; aks holda sabab.
 * `prepareRemittedCourierCredit({ allowHq: true })` bilan AYNI shartlar.
 */
export function hqCourierCreditBlocker(
  ctx: Pick<
    RollbackEligibilityContext,
    | 'sale'
    | 'saleCourierBranchId'
    | 'hqBranchId'
    | 'carryTablePresent'
    | 'saleCourierCarryBranchId'
    | 'saleCourierCarryAmount'
  >,
): string | null {
  const sale = ctx.sale;
  if (!sale || !norm(sale.courier_id)) {
    return 'Kuryer hisob-kitob qatori topilmadi — rollback bajarilmadi';
  }
  if (toTiyin(sale.courier_amount) <= 0) {
    return REMITTED_CREDIT_ROW_MESSAGE;
  }
  if (!ctx.carryTablePresent) {
    return (
      "Hisob-kitob qoldig'i jadvali topilmadi — kuryer kreditini yozib bo'lmaydi, " +
      'rollback bajarilmadi'
    );
  }
  // Kredit HQ'da sarflanishi kerak: kuryer keyingi pulni yana HQ'ga
  // topshirishi shart (boshqa filialga o'tgan bo'lsa — u yerda ishlatilmaydi).
  if (
    !norm(ctx.hqBranchId) ||
    norm(ctx.saleCourierBranchId) !== norm(ctx.hqBranchId)
  ) {
    return (
      "Kuryer endi bosh ofis (HQ) kuryeri emas — HQ'ga topshirilgan summani " +
      "uning hisobiga o'tkazib bo'lmaydi, rollback bajarilmadi"
    );
  }
  // A-F8 bilan AYNI: filialga bog'langan noldan farqli qoldiq aralashmaydi.
  if (
    toTiyin(ctx.saleCourierCarryAmount ?? 0) !== 0 &&
    norm(ctx.saleCourierCarryBranchId) !== ''
  ) {
    return 'Kuryerda boshqa filialga tegishli qoldiq bor — rollback bajarilmadi';
  }
  return null;
}

/** Kuryer va menejerga: market to'lovi tilga olinmaydi (ega, 2026-11-27). */
const SUPERADMIN_ONLY_NEUTRAL_MESSAGE =
  'Bu buyurtmani faqat superadmin qaytara oladi — superadminga murojaat qiling';

/**
 * D4 — bekor posilka hali o'z filialida yoki o'z filiali kuryerida turibdimi.
 * Jo'natilgan (`cancelled_sent` — bekorlar paketi / pochta) bu yerga
 * yetmaydi (status bosqichida rad etiladi).
 */
function parcelInBranch(
  ctx: RollbackEligibilityContext,
  branchId: string,
): boolean {
  const holderType = String(ctx.order.holder_type ?? '').toUpperCase();
  const holderCourier = norm(ctx.order.holder_courier_id);
  if (holderType === 'COURIER' || (!holderType && holderCourier)) {
    return (
      Boolean(holderCourier) && norm(ctx.holderCourierBranchId) === branchId
    );
  }
  if (holderType === 'BRANCH' || !holderType) {
    return norm(ctx.order.holder_branch_id) === branchId;
  }
  return false;
}

export function evaluateRollbackEligibility(
  ctx: RollbackEligibilityContext,
): RollbackEligibility {
  const { actor, order, sale } = ctx;
  const role = effectiveRollbackRole(actor);
  const isSuperAdmin = role === 'superadmin';
  const isCourier = role === 'courier';
  const isManager = role === 'manager';
  if (!role) {
    return deny(RB.NOT_ALLOWED_ROLE);
  }

  const status = String(order.status ?? '');
  const saleStatuses: string[] = [
    Order_status.SOLD,
    Order_status.PAID,
    Order_status.PARTLY_PAID,
  ];

  // 1) Holat.
  if (isSuperAdmin) {
    if (
      ![
        Order_status.SOLD,
        Order_status.CANCELLED,
        Order_status.CLOSED,
        Order_status.PAID,
        Order_status.PARTLY_PAID,
      ].includes(status as Order_status)
    ) {
      return deny(
        RB.STATUS_NOT_ROLLBACKABLE,
        `Rollback mumkin emas (status: ${status})`,
      );
    }
  } else {
    if (
      status === Order_status.CANCELLED_SENT ||
      status === Order_status.CLOSED ||
      status === Order_status.RETURNED_TO_MARKET
    ) {
      return deny(RB.PARCEL_NOT_IN_BRANCH);
    }
    if (status === Order_status.PAID || status === Order_status.PARTLY_PAID) {
      // Ega (2026-11-27): HQ marketga to'laganmi-yo'qmi — kuryer/menejerga
      // ko'rinmaydi, xabar ham uni aytmaydi (to'liq / qisman farqi ham).
      return deny(RB.SUPERADMIN_ONLY, SUPERADMIN_ONLY_NEUTRAL_MESSAGE);
    }
    if (status !== Order_status.SOLD && status !== Order_status.CANCELLED) {
      return deny(
        RB.STATUS_NOT_ROLLBACKABLE,
        `Rollback mumkin emas (status: ${status})`,
      );
    }
  }

  // 2) Sotuv qaydi (RBAC-05).
  if (saleStatuses.includes(status) && !String(order.sold_at ?? '').trim()) {
    return deny(RB.NO_SALE_RECORD);
  }

  // 3) Aktor ↔ buyurtma.
  const actorId = norm(actor.id);
  const actorBranch = norm(actor.branch_id);
  if (isManager) {
    if (actor.can_sell_cancel !== true) {
      return deny(RB.NO_PERMISSION);
    }
    if (
      !actorBranch ||
      (actorBranch !== norm(order.holder_branch_id) &&
        actorBranch !== norm(order.branch_id))
    ) {
      return deny(RB.NOT_OWN_BRANCH);
    }
  }
  if (isCourier) {
    const assigned =
      Boolean(actorId) &&
      [ctx.postCourierId, order.holder_courier_id, order.courier_id]
        .map(norm)
        .includes(actorId);
    if (!assigned) {
      return deny(RB.NOT_OWN_ORDER);
    }
  }

  // 4) D4 — bekor posilka joyi (menejer: o'z filiali yoki filial kuryeri;
  //    kuryer: faqat o'z qo'lida — LC-05).
  if (status === Order_status.CANCELLED) {
    // S11 — bekorlar pochtasiga solingan posilka (DB holati hali `cancelled`
    // bo'lsa ham) — holder'dan qat'i nazar.
    if (!isSuperAdmin && String(order.canceled_post_id ?? '').trim()) {
      return deny(RB.PARCEL_NOT_IN_BRANCH);
    }
    if (isManager && !parcelInBranch(ctx, actorBranch)) {
      return deny(RB.PARCEL_NOT_IN_BRANCH);
    }
    if (isCourier) {
      const holderType = String(order.holder_type ?? '').toUpperCase();
      const heldByMe =
        (!holderType || holderType === 'COURIER') &&
        norm(order.holder_courier_id) === actorId;
      if (!heldByMe) {
        return deny(
          RB.PARCEL_NOT_IN_BRANCH,
          "Topshirilgan bekor buyurtmani qaytarib bo'lmaydi — posilka endi filial yoki HQ qo'lida",
        );
      }
    }
  }

  // 5) Hisob-kitob bosqichi (faqat sotuv qatori).
  if (ctx.settlementLoaded === false) {
    return allow('plain');
  }
  if (
    !sale &&
    isSuperAdmin &&
    ![ctx.postCourierId, order.holder_courier_id, order.courier_id]
      .map(norm)
      .some(Boolean) &&
    // A-F6 — pul oyog'i yo'q (sotuv emas va qo'shimcha xarajat yo'q) bekor
    // buyurtma — kuryer kerak emas, superadmin ham qaytaradi.
    (saleStatuses.includes(status) || toTiyin(order.extra_cost) > 0)
  ) {
    // Sotuv qatori yo'q (eski buyurtma) — teskari oyoqlar kuryerdan olinadi
    // (`resolveActorCourierId`, avvalgidek): kuryer majburiy.
    return deny(RB.CORRECTION_REQUIRED, 'Buyurtmaga kuryer biriktirilmagan');
  }
  // B-3 — konvertatsiya qilingan qator: filial to'lagan qism daftarda yo'q.
  if (ctx.conversionTraced && sale) {
    return deny(
      isSuperAdmin ? RB.CORRECTION_REQUIRED : RB.SUPERADMIN_ONLY,
      isCourier
        ? SUPERADMIN_ONLY_NEUTRAL_MESSAGE
        : "Bu buyurtmaning filial → market to'lovi migratsiya 246 orqaga qaytarilganda " +
            "konvertatsiya qilingan — avtomatik qaytarib bo'lmaydi, buxgalteriya tuzatishi kerak",
    );
  }
  if (!sale || sale.status === SettlementStatus.PENDING) {
    if (ctx.ledgerMismatch) {
      return deny(
        isSuperAdmin ? RB.CORRECTION_REQUIRED : RB.SUPERADMIN_ONLY,
        ctx.ledgerMismatch,
      );
    }
    return allow('plain');
  }
  const settledToHq =
    sale.status === SettlementStatus.BRANCH_SETTLED ||
    sale.status === SettlementStatus.MARKET_SETTLED;
  const branchPaidMarket = isBranchPaidMarketSale(sale);
  const remitted = isRemittedSale(sale);

  if (!isSuperAdmin && (settledToHq || branchPaidMarket)) {
    return deny(
      RB.SUPERADMIN_ONLY,
      settledToHq
        ? "Buyurtma puli bosh ofisga o'tgan — faqat superadmin qaytara oladi"
        : // PR-C — filial marketga o'zi to'lagan: menejer buni biladi (o'z
          // amali); kuryerga market to'lovi aytilmaydi (ega, 2026-11-27).
          isManager
          ? "Buyurtmaning market ulushi filial kassasidan to'langan — faqat superadmin qaytara oladi"
          : SUPERADMIN_ONLY_NEUTRAL_MESSAGE,
    );
  }
  if (isCourier && remitted) {
    return deny(RB.COURIER_REMITTED);
  }

  if (settledToHq || branchPaidMarket) {
    if (!norm(sale.branch_id)) {
      // 2026-11-27 — HQ sotuvi (Toshkent kuryeri yoki HQ menejeri): filial
      // bo'g'ini yo'q, naqd to'g'ridan-to'g'ri HQ'da. Kuryer bo'lsa — kredit
      // uning HQ qoldig'iga; filialga kredit yo'q; market to'langan bo'lsa —
      // market debeti (`planSettledRollbackLedger`).
      if (branchPaidMarket) {
        // HQ qatorida filial to'lovi bo'lishi mumkin emas — buzilgan qator.
        return deny(
          RB.CORRECTION_REQUIRED,
          "HQ sotuvi qatorida filial to'lovi yozilgan — daftarni avtomatik teskari yozib bo'lmaydi",
        );
      }
      if (norm(sale.courier_id)) {
        const blocker = hqCourierCreditBlocker(ctx);
        if (blocker) return deny(RB.CORRECTION_REQUIRED, blocker);
      }
      if (ctx.ledgerMismatch) {
        return deny(RB.CORRECTION_REQUIRED, ctx.ledgerMismatch);
      }
      return allow('settled');
    }
    // Superadmin, D2: kuryer qismi bo'lsa — M6 shartlari (kredit shu filialda).
    // Kuryersiz qator (menejer / filial sotgan) — kuryerga kredit yo'q.
    if (norm(sale.courier_id)) {
      const blocker = remittedCreditBlocker(ctx);
      if (blocker) return deny(RB.CORRECTION_REQUIRED, blocker);
    }
    if (ctx.ledgerMismatch) {
      return deny(RB.CORRECTION_REQUIRED, ctx.ledgerMismatch);
    }
    return allow('settled');
  }

  if (remitted) {
    const blocker = remittedCreditBlocker(ctx) ?? ctx.ledgerMismatch;
    if (blocker) {
      return deny(
        isSuperAdmin ? RB.CORRECTION_REQUIRED : RB.SUPERADMIN_ONLY,
        blocker,
      );
    }
    return allow('courier_remitted');
  }

  if (ctx.ledgerMismatch) {
    return deny(
      isSuperAdmin ? RB.CORRECTION_REQUIRED : RB.SUPERADMIN_ONLY,
      ctx.ledgerMismatch,
    );
  }
  return allow('plain');
}
