import { Roles } from '@app/common';

/**
 * K3scaE0W — ROL KATALOGI (yagona manba).
 *
 * Ilgari rollar uch joyda qo'lda takrorlangan edi (backend enum — 11+,
 * yaratish ekrani — 5, foydalanuvchi filtri — 8; filtrda branch / investor /
 * market_operator yo'q edi). Endi `GET /roles` shu katalogni qaytaradi:
 * frontend RoleSelector va UserFilters shundan quriladi.
 *
 *   - `creatable` / `create_endpoint` — rolni yaratadigan gateway marshruti
 *     (yo'q bo'lsa null: superadmin seed qilinadi, operator/branch uchun
 *     yaratish yo'li yo'q);
 *   - `changeable` — PATCH /users/:id/role da MANBA ham, NISHON ham bo'la
 *     oladi. Faqat pul/hisob bog'lanmagan xodim rollari: admin, ro'yxatchi,
 *     menejer, logist. Kuryer (kassa, buyurtmalar, filial), market (kassa,
 *     mahsulotlar), market operatori, mijoz, investor, operator (komissiya
 *     daftari), branch (eski) va superadmin — almashtirilmaydi: ular uchun
 *     rol almashtirish pul yoki boshqa yozuvlarni jimgina yetim qoldiradi;
 *   - `filterable` — GET /users?role=... da tanlash mumkin (hammasi).
 *
 * Katalog Roles enum'ini TO'LIQ qamraydi — spec buni tekshiradi (yangi rol
 * qo'shilsa katalogsiz qolmaydi).
 */
export interface RoleCatalogEntry {
  role: Roles;
  label: string;
  description: string;
  /** Xodim (true) yoki tashqi hisob (market, mijoz, investor ...). */
  staff: boolean;
  creatable: boolean;
  create_endpoint: string | null;
  changeable: boolean;
  filterable: boolean;
}

const entry = (
  role: Roles,
  label: string,
  description: string,
  options: {
    staff: boolean;
    create_endpoint: string | null;
    changeable?: boolean;
  },
): RoleCatalogEntry =>
  Object.freeze({
    role,
    label,
    description,
    staff: options.staff,
    creatable: options.create_endpoint !== null,
    create_endpoint: options.create_endpoint,
    changeable: options.changeable ?? false,
    filterable: true,
  });

export const ROLE_CATALOG: ReadonlyArray<RoleCatalogEntry> = Object.freeze([
  entry(
    Roles.SUPERADMIN,
    'Superadmin',
    "Tizimning to'liq boshqaruvi; rollarni faqat u o'zgartiradi",
    { staff: true, create_endpoint: null },
  ),
  entry(
    Roles.ADMIN,
    'Admin',
    "Kompaniya bo'yicha boshqaruv (superadmin va boshqa adminlardan tashqari)",
    { staff: true, create_endpoint: 'POST /admins', changeable: true },
  ),
  entry(
    Roles.MANAGER,
    'Menejer',
    "Filial menejeri: o'z filiali pochtasi, kuryerlari va kassasi",
    { staff: true, create_endpoint: 'POST /managers', changeable: true },
  ),
  entry(
    Roles.REGISTRATOR,
    "Ro'yxatchi",
    "Buyurtmalarni qabul qilish va ro'yxatga olish",
    { staff: true, create_endpoint: 'POST /registrators', changeable: true },
  ),
  entry(
    Roles.LOGIST,
    'Logist',
    'Biriktirilgan viloyatlar statistikasi va nazorati',
    { staff: true, create_endpoint: 'POST /logists', changeable: true },
  ),
  entry(
    Roles.COURIER,
    'Kuryer',
    'Buyurtmalarni yetkazish; kassasi va filialga biriktiruvi bor',
    { staff: true, create_endpoint: 'POST /couriers' },
  ),
  entry(
    Roles.OPERATOR,
    'Operator',
    "Buyurtma kiritadi; komissiya sozlamasi bo'lishi mumkin",
    { staff: true, create_endpoint: null },
  ),
  entry(
    Roles.BRANCH,
    'Filial (eski rol)',
    'Eski filial hisobi; yangi foydalanuvchilar uchun ishlatilmaydi',
    { staff: true, create_endpoint: null },
  ),
  entry(
    Roles.MARKET,
    'Market',
    "Do'kon (yuboruvchi): buyurtmalari, mahsulotlari va kassasi bor",
    { staff: false, create_endpoint: 'POST /markets' },
  ),
  entry(
    Roles.MARKET_OPERATOR,
    'Market operatori',
    'Market nomidan buyurtma kirituvchi xodim',
    { staff: false, create_endpoint: 'POST /market-operators' },
  ),
  entry(Roles.CUSTOMER, 'Mijoz', 'Buyurtma qabul qiluvchi', {
    staff: false,
    create_endpoint: 'POST /customers',
  }),
  entry(Roles.INVESTOR, 'Investor', 'Investor kabineti (faqat kirish)', {
    staff: false,
    create_endpoint: 'POST /investor-users',
  }),
]);

const BY_ROLE = new Map<string, RoleCatalogEntry>(
  ROLE_CATALOG.map((item) => [item.role, item]),
);

export function roleCatalogEntry(role: unknown): RoleCatalogEntry | null {
  return (
    BY_ROLE.get((typeof role === 'string' ? role : '').trim().toLowerCase()) ??
    null
  );
}

/** PATCH /users/:id/role da manba va nishon bo'la oladigan rollar. */
export const CHANGEABLE_ROLES: ReadonlyArray<Roles> = Object.freeze(
  ROLE_CATALOG.filter((item) => item.changeable).map((item) => item.role),
);
