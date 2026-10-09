import { Cashbox_type, Order_status, PaymentMethod, Roles } from '../../enums';

/**
 * JURNAL UCHUN O'ZBEKCHA YORLIQLAR VA GAPLAR (2WRzdWpZ).
 *
 * YAGONA MANBA: status/rol/pul ko'rinishi va `activity_logs.description`
 * gaplari FAQAT shu yerda yoziladi — servislarda qayta yozilmaydi (aks holda
 * bir xil amal turli servisda turlicha ataladi va qidiruv "bekor" so'zini
 * topmay qoladi). Namuna: BeePost `server/src/common/utils/status-label.util.ts`
 * (`orderStatusUz`).
 *
 * ⚠️ PII QOIDASI. Gapga FAQAT obyekt raqami + amal + summa/status kiradi.
 * Mijoz ismi, telefoni, manzili, erkin izoh (comment/reason) HECH QACHON
 * qo'shilmaydi — aks holda jurnal PII omboriga aylanadi. Shu sabab quruvchilar
 * bunday maydonlarni PARAMETR sifatida qabul ham qilmaydi
 * (`describe-uz.spec.ts` qulflaydi). Xodim ismi faqat `login` gapida
 * (u baribir `user_name` ustunida turadi); mijoz kirganda ism o'rniga rol.
 *
 * ⚠️ GAP YOZILGANDA MUZLAYDI. Keyin matn o'zgartirilsa eski qatorlar eski
 * shaklda qoladi — shuning uchun qisqa va barqaror shakl. Noma'lum kod uchun
 * kodning o'zi qaytadi (hech qachon throw qilmaydi).
 */

const ORDER_STATUS_UZ: Readonly<Record<string, string>> = {
  [Order_status.CREATED]: 'Yaratildi',
  [Order_status.NEW]: 'Yangi',
  [Order_status.RECEIVED]: 'Qabul qilindi',
  [Order_status.ON_THE_ROAD]: "Yo'lda",
  [Order_status.WAITING]: 'Kutilmoqda',
  [Order_status.WAITING_CUSTOMER]: 'Mijoz kutilmoqda',
  [Order_status.SOLD]: 'Sotildi',
  [Order_status.CANCELLED]: 'Bekor qilindi',
  [Order_status.RETURNED_TO_MARKET]: 'Marketga qaytarildi',
  [Order_status.PAID]: "To'langan",
  [Order_status.PARTLY_PAID]: "Qisman to'langan",
  [Order_status.CANCELLED_SENT]: 'Bekor (yuborilgan)',
  [Order_status.CLOSED]: 'Yopilgan',
};

const ROLE_UZ: Readonly<Record<string, string>> = {
  [Roles.SUPERADMIN]: 'Super Admin',
  [Roles.ADMIN]: 'Admin',
  [Roles.COURIER]: 'Kuryer',
  [Roles.REGISTRATOR]: 'Registrator',
  [Roles.MARKET]: 'Market',
  [Roles.CUSTOMER]: 'Mijoz',
  [Roles.OPERATOR]: 'Operator',
  [Roles.MARKET_OPERATOR]: 'Market operatori',
  [Roles.MANAGER]: 'Menejer',
  [Roles.BRANCH]: 'Filial',
  [Roles.INVESTOR]: 'Investor',
  [Roles.LOGIST]: 'Logist',
};

const PAYMENT_METHOD_UZ: Readonly<Record<string, string>> = {
  [PaymentMethod.CASH]: 'naqd',
  [PaymentMethod.CLICK]: 'karta (Click)',
  [PaymentMethod.CLICK_TO_MARKET]: 'karta (marketga)',
};

const CASHBOX_TYPE_UZ: Readonly<Record<string, string>> = {
  [Cashbox_type.MAIN]: 'Asosiy kassa',
  [Cashbox_type.FOR_COURIER]: 'Kuryer kassasi',
  [Cashbox_type.FOR_MARKET]: 'Market kassasi',
  [Cashbox_type.BRANCH]: 'Filial kassasi',
};

const AUTH_FAILURE_REASON_UZ: Readonly<Record<string, string>> = {
  user_not_found: 'foydalanuvchi topilmadi',
  inactive: 'foydalanuvchi faol emas',
  bad_password: "noto'g'ri parol",
  refresh_token_superseded: 'eskirgan sessiya tokeni',
};

function label(
  map: Readonly<Record<string, string>>,
  code?: string | null,
): string {
  if (!code) return '-';
  return map[code] ?? code;
}

/** Buyurtma statusi kodini o'zbekcha yorliqqa aylantiradi. */
export function orderStatusUz(code?: string | null): string {
  return label(ORDER_STATUS_UZ, code);
}

/** Rol kodini o'zbekcha yorliqqa aylantiradi. */
export function roleUz(code?: string | null): string {
  return label(ROLE_UZ, code);
}

/** To'lov usuli kodini o'zbekcha yorliqqa aylantiradi (kichik harf — gap ichida). */
export function paymentMethodUz(code?: string | null): string {
  return label(PAYMENT_METHOD_UZ, code);
}

/** Kassa turini o'zbekcha yorliqqa aylantiradi. */
export function cashboxTypeUz(code?: string | null): string {
  return label(CASHBOX_TYPE_UZ, code);
}

/**
 * Summani o'zbekcha ko'rinishga keltiradi: `150000` → `"150 000 so'm"`.
 * Ming ajratgichi — bo'shliq; kasr qism (tiyin) bo'lsa vergul bilan 2 xonagacha
 * (`1500.5` → `"1 500,50 so'm"`). Raqam bo'lmagan qiymat — `"-"`.
 * Postgres `numeric` satr ko'rinishida kelsa ham (`"150000.00"`) ishlaydi.
 */
export function moneyUz(amount: unknown): string {
  const value =
    typeof amount === 'number'
      ? amount
      : typeof amount === 'string' && amount.trim() !== ''
        ? Number(amount)
        : Number.NaN;
  if (!Number.isFinite(value)) return '-';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const fixed = abs.toFixed(2);
  const [intPart, fracPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = fracPart === '00' ? '' : `,${fracPart}`;
  return `${sign}${grouped}${frac} so'm`;
}

type Id = string | number;

const hasAmount = (amount: unknown): boolean => {
  const n = Number(amount);
  return amount !== null && amount !== undefined && Number.isFinite(n);
};

const order = (id: Id) => `Buyurtma #${String(id)}`;

/** "(Asosiy kassa, naqd)" — faqat ma'lum qismlar. */
function cashboxSuffix(
  cashboxType?: string | null,
  method?: string | null,
): string {
  const parts = [
    cashboxType ? cashboxTypeUz(cashboxType) : null,
    method ? paymentMethodUz(method) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/**
 * `activity_logs.description` gaplari (2WRzdWpZ). Har bir quruvchi faqat
 * ID/summa/status oladi — PII maydonini uzatishning iloji yo'q.
 */
export const ActivityDescribeUz = {
  /** "Buyurtma #100439 yaratildi — 150 000 so'm" */
  orderCreated(id: Id, totalPrice?: unknown): string {
    return Number(totalPrice) > 0
      ? `${order(id)} yaratildi — ${moneyUz(totalPrice)}`
      : `${order(id)} yaratildi`;
  },

  /** "Buyurtma #100439 holati: Yangi → Qabul qilindi" */
  orderStatusChanged(
    id: Id,
    from: string | null | undefined,
    to: string | null | undefined,
  ): string {
    return from && from !== to
      ? `${order(id)} holati: ${orderStatusUz(from)} → ${orderStatusUz(to)}`
      : `${order(id)} holati: ${orderStatusUz(to)}`;
  },

  /** "Buyurtma #100439 bekor qilindi" */
  orderCancelled(id: Id): string {
    return `${order(id)} bekor qilindi`;
  },

  /** "Buyurtma #100439 sotildi — 150 000 so'm" */
  orderSold(id: Id, amount?: unknown): string {
    return hasAmount(amount)
      ? `${order(id)} sotildi — ${moneyUz(amount)}`
      : `${order(id)} sotildi`;
  },

  /** "Buyurtma #100439 qisman sotildi — 90 000 so'm" */
  orderPartlySold(id: Id, amount?: unknown): string {
    return hasAmount(amount)
      ? `${order(id)} qisman sotildi — ${moneyUz(amount)}`
      : `${order(id)} qisman sotildi`;
  },

  /** "Buyurtma #100439 tahrirlandi" (status o'zgarmagan tahrir). */
  orderUpdated(id: Id): string {
    return `${order(id)} tahrirlandi`;
  },

  /** "Kassaga kirim: 150 000 so'm (Asosiy kassa, naqd)" */
  cashboxIncome(
    amount: unknown,
    cashboxType?: string | null,
    method?: string | null,
  ): string {
    return `Kassaga kirim: ${moneyUz(amount)}${cashboxSuffix(cashboxType, method)}`;
  },

  /** "Kassadan chiqim: 50 000 so'm (Filial kassasi, naqd)" */
  cashboxExpense(
    amount: unknown,
    cashboxType?: string | null,
    method?: string | null,
  ): string {
    return `Kassadan chiqim: ${moneyUz(amount)}${cashboxSuffix(cashboxType, method)}`;
  },

  /** "Kuryer #301 dan to'lov qabul qilindi: 150 000 so'm (naqd)" */
  courierPayment(
    courierId: Id | null | undefined,
    amount: unknown,
    method?: string | null,
  ): string {
    const who = courierId ? `Kuryer #${String(courierId)} dan` : 'Kuryerdan';
    return `${who} to'lov qabul qilindi: ${moneyUz(amount)}${cashboxSuffix(null, method)}`;
  },

  /** "Filial #77 → asosiy kassa: 150 000 so'm (naqd)" */
  branchToMainPayment(
    branchId: Id | null | undefined,
    amount: unknown,
    method?: string | null,
  ): string {
    return `Filial #${String(branchId ?? '-')} → asosiy kassa: ${moneyUz(amount)}${cashboxSuffix(null, method)}`;
  },

  /** "Market #501 ga to'lov: 150 000 so'm (naqd)" */
  marketPayment(
    marketId: Id | null | undefined,
    amount: unknown,
    method?: string | null,
  ): string {
    return `Market #${String(marketId ?? '-')} ga to'lov: ${moneyUz(amount)}${cashboxSuffix(null, method)}`;
  },

  /** "Operator #42 ga komissiya to'lovi: 150 000 so'm" */
  operatorPayment(operatorId: Id | null | undefined, amount: unknown): string {
    return `Operator #${String(operatorId ?? '-')} ga komissiya to'lovi: ${moneyUz(amount)}`;
  },

  /** "Jo'natma #12 yaratildi: Filial #3 → Filial #5, 4 ta buyurtma" */
  branchTransferCreated(input: {
    batchId?: Id | null;
    fromBranchId?: Id | null;
    toBranchId?: Id | null;
    orderCount?: number | null;
  }): string {
    const batch = input.batchId ? ` #${String(input.batchId)}` : '';
    const route = `Filial #${String(input.fromBranchId ?? '-')} → Filial #${String(input.toBranchId ?? '-')}`;
    const count = Number.isFinite(Number(input.orderCount))
      ? `, ${Number(input.orderCount)} ta buyurtma`
      : '';
    return `Jo'natma${batch} yaratildi: ${route}${count}`;
  },

  /** "Qaytarish jo'natmasi #12 yaratildi: Filial #3, 4 ta buyurtma" */
  branchReturnCreated(input: {
    batchId?: Id | null;
    fromBranchId?: Id | null;
    orderCount?: number | null;
  }): string {
    const batch = input.batchId ? ` #${String(input.batchId)}` : '';
    const count = Number.isFinite(Number(input.orderCount))
      ? `, ${Number(input.orderCount)} ta buyurtma`
      : '';
    return `Qaytarish jo'natmasi${batch} yaratildi: Filial #${String(input.fromBranchId ?? '-')}${count}`;
  },

  /** "Kuryer #301 Filial #3 → Filial #5 ga o'tkazildi" */
  courierTransferred(
    userId: Id,
    fromBranchId: Id | null | undefined,
    toBranchId: Id | null | undefined,
  ): string {
    return `Kuryer #${String(userId)} Filial #${String(fromBranchId ?? '-')} → Filial #${String(toBranchId ?? '-')} ga o'tkazildi`;
  },

  /**
   * "Ali Valiyev tizimga kirdi" — xodim/market. Mijoz (customer) kirganda ism
   * YOZILMAYDI (PII): "Mijoz tizimga kirdi". `method: 'otp'` → "(SMS kod)".
   */
  login(input: {
    name?: string | null;
    role?: string | null;
    method?: 'password' | 'otp';
  }): string {
    const name = String(input.name ?? '').trim();
    const who =
      input.role === Roles.CUSTOMER || !name
        ? input.role
          ? roleUz(input.role)
          : 'Foydalanuvchi'
        : name;
    return `${who} tizimga kirdi${input.method === 'otp' ? ' (SMS kod)' : ''}`;
  },

  /** "Kirish urinishi muvaffaqiyatsiz: noto'g'ri parol" — telefon YO'Q. */
  authFailure(reason: string): string {
    return `Kirish urinishi muvaffaqiyatsiz: ${label(AUTH_FAILURE_REASON_UZ, reason)}`;
  },
} as const;
