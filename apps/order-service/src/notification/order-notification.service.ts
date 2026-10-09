import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  CancelReason,
  Group_type,
  NotificationChannel,
  Order_status,
  OutboxService,
  escapeTelegramHtml,
  findNotificationType,
  renderNotificationGroupKey,
  rmqSend,
} from '@app/common';
import { Order } from '../entities/order.entity';

/**
 * HODISA → BILDIRISHNOMA (OA16fdSq / ePpLHPX2) — order-service pilot.
 *
 * QAYERDAN CHAQIRILADI. Buyurtma holatining HAR bir o'zgarishi
 * `OrderCustodyService.createTrackingEvent` orqali kuzatuv qatorini yozadi
 * (lifecycle, transfer-batch, `updateFull` — hammasi). Bildirishnoma ham
 * aynan shu yagona nuqtadan, kuzatuv qatori bilan BITTA tranzaksiyada
 * (`repository.manager`) outbox'ga yoziladi. Kuryerga biriktirish
 * (`order.assigned_to_courier`) — `OrderLifecycleService.updateFull` /
 * `create` dan, `courier_id` o'zgargan tranzaksiyaning o'zida.
 *
 * ⚠️ FAQAT OUTBOX. To'g'ridan-to'g'ri `rmqSend('notification.dispatch')`
 * TAQIQ: biznes tranzaksiyasi rollback bo'lsa ham xabar ketib qolardi
 * ("buyurtmangiz sotildi" — aslida sotilmagan), sinxron chaqiruv esa
 * "Sotildi" tugmasini bildirishnomani kutishga majburlardi.
 *
 * ⚠️ FAIL-OPEN. notification-service ishlamasa buyurtma holati baribir
 * o'zgaradi: tranzaksiyada faqat `outbox_events` ga INSERT, yetkazishni
 * OutboxPublisher keyin (qayta urinish bilan) qiladi. Payload qurishdagi
 * kutilmagan xato ham biznes amalini yiqitmaydi (faqat WARN).
 *
 * ⚠️ TRANZAKSIYA ICHIDAGI RPC (TC11). Nishon (viloyat logisti) va Telegram
 * matni (mijoz, kuryer, mahsulot nomlari) boshqa servislardan olinadi —
 * bu chaqiruvlar DB tranzaksiyasi OCHIQ turganda bajariladi, shuning uchun:
 *   • region → logist xaritasi KESHDA (TTL 5 daq, eskirgani darhol
 *     qaytariladi, yangilash fonda — "Sotildi" uni kutmaydi);
 *   • har RPC — qisqa timeout (`NOTIFY_LOOKUP_TIMEOUT_MS`), qayta urinishsiz;
 *   • xato/timeout → o'sha servis `NOTIFY_LOOKUP_BACKOFF_MS` davomida
 *     so'ralmaydi (har hodisa timeout kutib turmasin) va bildirishnoma
 *     logistsiz / to'liq bo'lmagan matn bilan ketadi (fail-open);
 *   • mijoz/kuryer/mahsulot faqat Telegram kanali bo'lgan turlar uchun
 *     so'raladi (hozir `order.cancelled`) — sotuvda umuman so'ralmaydi.
 *
 * PII: in_app `body` — faqat buyurtma raqami + holat (telefon/manzil YO'Q).
 * Mijoz ismi/telefoni, manzil va izoh faqat market Telegram guruhiga
 * ketadigan `telegram.text` da va HTML-escape qilingan (Elchi
 * `parse_mode: HTML`, BeePost Markdown edi).
 */

export const NOTIFICATION_OUTBOX_TARGET = 'NOTIFICATION';
export const NOTIFICATION_DISPATCH_PATTERN = 'notification.dispatch';

/** (TC11) Boyitish RPC'si (logist, mijoz, kuryer, mahsulot) uchun muddat. */
export const NOTIFY_LOOKUP_TIMEOUT_MS = 800;
/** (TC11) Xato/timeout'dan keyin o'sha servis shuncha vaqt so'ralmaydi. */
export const NOTIFY_LOOKUP_BACKOFF_MS = 30_000;
/** (TC11) `regions.logist_id` xaritasi keshining yashash muddati. */
export const REGION_DIRECTORY_TTL_MS = 5 * 60_000;

/** Telegram xabari chegarasi (API 4096; DTO ham 4096). */
const TELEGRAM_TEXT_LIMIT = 4000;
const TELEGRAM_MAX_ITEMS = 20;

/** Pilot hodisalar — kalitlar `NOTIFICATION_TYPES` katalogida. */
export const ORDER_PILOT_NOTIFICATION_TYPES = [
  'order.created',
  'order.accepted',
  'order.on_way',
  'order.sold',
  'order.cancelled',
  'order.returned',
  'order.not_accepted',
] as const;

export type OrderNotificationType =
  (typeof ORDER_PILOT_NOTIFICATION_TYPES)[number];

/** (ePpLHPX2) Kuryerga biriktirish — katalogdagi kalit aynan shu. */
export const ORDER_COURIER_ASSIGNED_TYPE = 'order.assigned_to_courier';

const SOLD_STATES: readonly Order_status[] = [
  Order_status.SOLD,
  Order_status.PAID,
  Order_status.PARTLY_PAID,
];

/**
 * Kuzatuv o'tishi → bildirishnoma turi. `null` — bildirishnoma yo'q (izoh,
 * rollback, ichki holatlar: WAITING, CANCELLED_SENT, CLOSED, …).
 */
export function resolveOrderNotificationType(
  from: Order_status | null | undefined,
  to: Order_status,
): OrderNotificationType | null {
  if (from === to) return null;
  if (!from) {
    return to === Order_status.CREATED || to === Order_status.NEW
      ? 'order.created'
      : null;
  }
  switch (to) {
    case Order_status.RECEIVED:
      return 'order.accepted';
    case Order_status.ON_THE_ROAD:
      return 'order.on_way';
    case Order_status.WAITING_CUSTOMER:
      // Kuryer yetkaza olmadi / mijoz qabul qilmadi (couldNotDeliverOrder).
      return from === Order_status.ON_THE_ROAD ? 'order.not_accepted' : null;
    case Order_status.SOLD:
    case Order_status.PAID:
    case Order_status.PARTLY_PAID:
      // SOLD → PAID (marketga to'lov) — sotuv EMAS, moliya hodisasi.
      return SOLD_STATES.includes(from) ? null : 'order.sold';
    case Order_status.CANCELLED:
      // CANCELLED_SENT → CANCELLED — qaytgan pochta qabul qilindi, yangi
      // bekor qilish emas.
      return from === Order_status.CANCELLED_SENT ? null : 'order.cancelled';
    case Order_status.RETURNED_TO_MARKET:
      return 'order.returned';
    default:
      return null;
  }
}

/** Mijozga ko'rinadigan raqam: "EL-" + (id + 100000) (formatOrderNumber bilan bir xil). */
export function orderNumberOf(id: string | number | null | undefined) {
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) && numeric > 0
    ? `EL-${numeric + 100000}`
    : '';
}

const TEXT: Record<OrderNotificationType, { title: string; status: string }> = {
  'order.created': { title: 'Yangi buyurtma', status: 'yaratildi' },
  'order.accepted': {
    title: 'Buyurtma qabul qilindi',
    status: 'omborga qabul qilindi',
  },
  'order.on_way': { title: "Buyurtma yo'lda", status: "yo'lga chiqdi" },
  'order.sold': { title: 'Buyurtma sotildi', status: 'sotildi' },
  'order.cancelled': {
    title: 'Buyurtma bekor qilindi',
    status: 'bekor qilindi',
  },
  'order.returned': {
    title: 'Buyurtma qaytarildi',
    status: 'marketga qaytarildi',
  },
  'order.not_accepted': {
    title: 'Buyurtma yetkazilmadi',
    status: "mijozga yetkazib bo'lmadi",
  },
};

/** BeePost sarlavhasidagi belgi (`*❌ Buyurtma bekor qilindi!*`) — HTML'da ham shu. */
const ICON: Record<OrderNotificationType, string> = {
  'order.created': '🆕',
  'order.accepted': '📥',
  'order.on_way': '🚚',
  'order.sold': '✅',
  'order.cancelled': '❌',
  'order.returned': '↩️',
  'order.not_accepted': '⚠️',
};

/** `return_reason` (CancelReason) — o'zbekcha; noma'lum qiymat o'zicha (escape bilan). */
const CANCEL_REASON_UZ: Record<string, string> = {
  [CancelReason.CUSTOMER_NO_ANSWER]: 'Mijoz javob bermadi',
  [CancelReason.CUSTOMER_REFUSED]: 'Mijoz rad etdi',
  [CancelReason.WRONG_ADDRESS]: "Manzil noto'g'ri",
  [CancelReason.DEFECTIVE_PRODUCT]: 'Mahsulot nuqsonli',
  [CancelReason.PRICE_DISPUTE]: "Narx bo'yicha kelishmovchilik",
  [CancelReason.OTHER]: 'Boshqa',
};

const formatMoney = (value: unknown) => {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount)
    ? `${Math.round(amount)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm`
    : '';
};

/** Toshkent vaqti (UTC+5, yozgi vaqt yo'q): `09.10.2026 14:05`. ICU'ga bog'liq emas. */
export function formatTashkentDateTime(value: unknown): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() + 5 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(local.getUTCDate())}.${pad(local.getUTCMonth() + 1)}.` +
    `${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  );
}

/**
 * Xom qiymatni ESCAPE'DAN OLDIN qisqartiradi — escape'dan keyin kesilsa
 * `&amp;` yarmida uzilib Telegram "can't parse entities" bilan rad etardi.
 */
const clip = (value: unknown, max: number): string => {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** HTML-escape qilingan qiymat yoki `-` (BeePost: `${... || '-'}`). */
const field = (value: unknown, max = 200) => {
  const text = clip(value, max);
  return text ? escapeTelegramHtml(text) : '-';
};

/** Telegram matni uchun boyitilgan ma'lumot (boshqa servislardan, fail-open). */
export interface OrderTelegramDetails {
  customer?: { name?: string | null; phone_number?: string | null } | null;
  courier?: { name?: string | null; phone_number?: string | null } | null;
  region_name?: string | null;
  district_name?: string | null;
  items?: Array<{ name: string; quantity: number }>;
}

type TelegramOrder = Pick<
  Order,
  'id' | 'total_price' | 'address' | 'comment' | 'return_reason'
> &
  Partial<Pick<Order, 'operator' | 'createdAt'>>;

/**
 * Market Telegram guruhi uchun HTML matn — BeePost bekor qilish xabari
 * mazmuni (order.service.ts: mijoz ismi, telefoni, manzili, mahsulotlar,
 * narx, yaratilgan vaqt, kuryer, operator, izoh). BeePost `*qalin*`
 * (Markdown) → `<b>qalin</b>` (HTML). HAR foydalanuvchi qiymati
 * `escapeTelegramHtml` dan o'tadi; satrlar butunligicha qo'shiladi (teg yoki
 * entity yarmida kesilmaydi).
 */
export function buildOrderTelegramText(
  type: OrderNotificationType,
  order: TelegramOrder,
  details: OrderTelegramDetails = {},
): string {
  const lines: string[] = [
    `${ICON[type]} <b>${escapeTelegramHtml(TEXT[type].title)}</b>`,
    `Buyurtma: <b>#${escapeTelegramHtml(orderNumberOf(order.id))}</b>`,
    '',
    `👤 <b>Mijoz:</b> ${field(details.customer?.name, 120)}`,
    `📞 <b>Telefon:</b> ${field(details.customer?.phone_number, 40)}`,
  ];
  const place = [details.region_name, details.district_name, order.address]
    .map((part) => clip(part, 300))
    .filter(Boolean)
    .join(', ');
  lines.push(`📍 <b>Manzil:</b> ${field(place, 400)}`);

  const items = (details.items ?? []).filter(
    (item) => clip(item?.name, 120) && Number(item?.quantity) > 0,
  );
  if (items.length) {
    lines.push('', '📦 <b>Mahsulotlar:</b>');
    items.slice(0, TELEGRAM_MAX_ITEMS).forEach((item, index) => {
      lines.push(
        `   ${index + 1}. ${field(item.name, 120)} — ${Math.trunc(Number(item.quantity))} dona`,
      );
    });
    if (items.length > TELEGRAM_MAX_ITEMS) {
      lines.push(`   … yana ${items.length - TELEGRAM_MAX_ITEMS} ta`);
    }
  }

  lines.push('');
  const money = formatMoney(order.total_price);
  lines.push(`💰 <b>Narxi:</b> ${field(money, 40)}`);
  const createdAt = formatTashkentDateTime(order.createdAt);
  if (createdAt) {
    lines.push(`🕒 <b>Yaratilgan vaqti:</b> ${escapeTelegramHtml(createdAt)}`);
  }

  lines.push(
    '',
    `🚚 <b>Kuryer:</b> ${field(details.courier?.name, 120)}`,
    `📞 <b>Kuryer bilan aloqa:</b> ${field(details.courier?.phone_number, 40)}`,
    `👨‍💼 <b>Operator:</b> ${field(order.operator, 120)}`,
    '',
  );
  if (order.return_reason) {
    const reason =
      CANCEL_REASON_UZ[String(order.return_reason)] ?? order.return_reason;
    lines.push(`↩️ <b>Sabab:</b> ${field(reason, 200)}`);
  }
  lines.push(`📝 <b>Izoh:</b> ${field(order.comment, 800)}`);

  // Chegaradan oshsa — butun satrlar bo'yicha kesiladi (teg/entity buzilmaydi).
  let text = '';
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > TELEGRAM_TEXT_LIMIT - 2) {
      text = `${text}\n…`;
      break;
    }
    text = next;
  }
  return text;
}

export interface OrderNotificationPayload {
  type: OrderNotificationType | typeof ORDER_COURIER_ASSIGNED_TYPE;
  category: string;
  priority: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  link: string;
  recipient_ids: string[];
  group_key?: string;
  channels: string[];
  telegram?: { market_id: string; group_type: Group_type; text: string };
}

/** Holat bildirishnomasi uchun tashqi kontekst (hammasi ixtiyoriy, fail-open). */
export interface OrderNotificationContext {
  /** Buyurtma viloyatining logisti (`regions.logist_id`). */
  logist_id?: string | null;
  /** Telegram matni uchun boyitish (faqat Telegram kanali bo'lgan turlarda). */
  telegram?: OrderTelegramDetails;
}

const isId = (value: unknown): value is string | number =>
  (typeof value === 'string' || typeof value === 'number') &&
  /^\d+$/.test(String(value)) &&
  String(value) !== '0';

const idOrNull = (value: unknown): string | null =>
  isId(value) ? String(value) : null;

/** Tur katalogda Telegram kanali bilan VA marketi bor — market guruhiga ketadi. */
export function orderTypeWantsTelegram(
  type: string,
  order: Pick<Order, 'market_id'>,
): boolean {
  const entry = findNotificationType(type);
  return Boolean(
    entry?.default_channels.includes(NotificationChannel.TELEGRAM) &&
    isId(order.market_id),
  );
}

/**
 * `notification.dispatch` payload'i. Nishon: buyurtma marketining useri
 * (`market_id`) + buyurtmani yaratgan operator (`operator_id`, bo'lsa) +
 * buyurtma viloyatining logisti (`context.logist_id`, bo'lsa) — butun
 * rollarga EMAS (har buyurtma hamma operator/logistga ketmasin).
 */
export function buildOrderNotificationPayload(
  type: OrderNotificationType,
  order: Pick<
    Order,
    | 'id'
    | 'market_id'
    | 'operator_id'
    | 'status'
    | 'total_price'
    | 'address'
    | 'comment'
    | 'return_reason'
  > &
    Partial<Pick<Order, 'operator' | 'createdAt'>>,
  fromStatus: Order_status | null | undefined,
  context: OrderNotificationContext = {},
): OrderNotificationPayload | null {
  const entry = findNotificationType(type);
  const recipients = [order.market_id, order.operator_id, context.logist_id]
    .filter(isId)
    .map(String);
  const recipientIds = [...new Set(recipients)];
  if (!entry || !recipientIds.length) return null;

  const orderId = String(order.id);
  const orderNumber = orderNumberOf(order.id);
  const data: Record<string, unknown> = {
    order_id: orderId,
    order_number: orderNumber,
    status: order.status,
    from_status: fromStatus ?? null,
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);
  const channels = [...entry.default_channels];
  const wantsTelegram = orderTypeWantsTelegram(type, order);

  return {
    type,
    category: entry.category,
    priority: entry.priority,
    title: TEXT[type].title,
    // in_app: faqat raqam + holat — telefon/manzil YO'Q (PII).
    body: `Buyurtma #${orderNumber || orderId} ${TEXT[type].status}.`,
    data,
    link: `/orders/${orderId}`,
    recipient_ids: recipientIds,
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: wantsTelegram
      ? channels
      : channels.filter((channel) => channel !== NotificationChannel.TELEGRAM),
    ...(wantsTelegram
      ? {
          telegram: {
            market_id: String(order.market_id),
            // Bekor qilinganlar — marketning "cancel" guruhiga (BeePost
            // sendMessageToGroup(cancel) bilan bir xil).
            group_type:
              type === 'order.cancelled'
                ? Group_type.CANCEL
                : Group_type.CREATE,
            text: buildOrderTelegramText(type, order, context.telegram),
          },
        }
      : {}),
  };
}

/**
 * (ePpLHPX2) `order.assigned_to_courier` payload'i. Nishon: yangi kuryer +
 * buyurtma marketi. `null` — kuryer yo'q / `'0'` (biriktirilmagan pochta) /
 * o'zgarmagan (qayta saqlash bildirishnoma bermaydi).
 */
export function buildCourierAssignedPayload(
  order: Pick<Order, 'id' | 'market_id' | 'courier_id' | 'status'>,
  previousCourierId?: string | null,
): OrderNotificationPayload | null {
  const entry = findNotificationType(ORDER_COURIER_ASSIGNED_TYPE);
  const courierId = idOrNull(order.courier_id);
  if (!entry || !courierId || courierId === idOrNull(previousCourierId)) {
    return null;
  }
  const orderId = String(order.id);
  const orderNumber = orderNumberOf(order.id);
  const data: Record<string, unknown> = {
    order_id: orderId,
    order_number: orderNumber,
    courier_id: courierId,
    previous_courier_id: idOrNull(previousCourierId),
    status: order.status,
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);
  return {
    type: ORDER_COURIER_ASSIGNED_TYPE,
    category: entry.category,
    priority: entry.priority,
    title: entry.label_uz,
    // PII yo'q: faqat buyurtma raqami.
    body: `Buyurtma #${orderNumber || orderId} kuryerga biriktirildi.`,
    data,
    link: `/orders/${orderId}`,
    recipient_ids: [
      ...new Set([courierId, order.market_id].filter(isId).map(String)),
    ],
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: entry.default_channels.filter(
      (channel) => channel !== NotificationChannel.TELEGRAM,
    ),
  };
}

/** `logistics.region.find_all` dan qurilgan xarita (keshlanadi). */
export interface RegionDirectory {
  logistByRegion: Map<string, string>;
  regionByDistrict: Map<string, string>;
  regionName: Map<string, string>;
  districtName: Map<string, string>;
}

type RegionRow = {
  id?: unknown;
  name?: unknown;
  logist_id?: unknown;
  districts?: Array<{ id?: unknown; name?: unknown }> | null;
};

/** `successRes(rows)` yoki xom massiv → xarita; tanilmagan javob → `null`. */
export function buildRegionDirectory(
  response: unknown,
): RegionDirectory | null {
  const rows: unknown =
    response && typeof response === 'object' && 'data' in response
      ? (response as { data?: unknown }).data
      : response;
  if (!Array.isArray(rows)) return null;
  const directory: RegionDirectory = {
    logistByRegion: new Map(),
    regionByDistrict: new Map(),
    regionName: new Map(),
    districtName: new Map(),
  };
  for (const region of rows as RegionRow[]) {
    const regionId = idOrNull(region?.id);
    if (!regionId) continue;
    const name = clip(region.name, 120);
    if (name) directory.regionName.set(regionId, name);
    const logistId = idOrNull(region.logist_id);
    if (logistId) directory.logistByRegion.set(regionId, logistId);
    for (const district of Array.isArray(region.districts)
      ? region.districts
      : []) {
      const districtId = idOrNull(district?.id);
      if (!districtId) continue;
      directory.regionByDistrict.set(districtId, regionId);
      const districtName = clip(district.name, 120);
      if (districtName) directory.districtName.set(districtId, districtName);
    }
  }
  return directory;
}

/** Buyurtma viloyati: `region_id`, bo'lmasa tumanning viloyati. */
function regionOf(
  order: Pick<Order, 'region_id' | 'district_id'>,
  directory: RegionDirectory,
): string | null {
  return (
    idOrNull(order.region_id) ??
    (idOrNull(order.district_id)
      ? (directory.regionByDistrict.get(String(order.district_id)) ?? null)
      : null)
  );
}

export interface TrackingTransition {
  order_id: string;
  from_status: Order_status | null;
  to_status: Order_status;
}

type LookupTarget = 'logistics' | 'identity' | 'catalog';

type NamedUser = { id?: unknown; name?: string; phone_number?: string };

const firstOf = (response: unknown): NamedUser | null => {
  const rows = (response as { data?: unknown } | null)?.data;
  return Array.isArray(rows) && rows.length ? (rows[0] as NamedUser) : null;
};

@Injectable()
export class OrderNotificationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrderNotificationService.name);
  private regionDirectory: {
    value: RegionDirectory;
    expiresAt: number;
  } | null = null;
  private regionDirectoryLoad: Promise<RegionDirectory | null> | null = null;
  private readonly lookupDownUntil = new Map<LookupTarget, number>();

  constructor(
    private readonly outbox: OutboxService,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    // (OA16fdSq) Faqat O'QISH RPC'lari (logist xaritasi, Telegram matni).
    // Ixtiyoriy: ulanmagan bo'lsa bildirishnoma logistsiz/qisqa matn bilan.
    @Optional()
    @Inject('LOGISTICS')
    private readonly logisticsClient?: ClientProxy,
    @Optional()
    @Inject('IDENTITY')
    private readonly identityClient?: ClientProxy,
    @Optional()
    @Inject('CATALOG')
    private readonly catalogClient?: ClientProxy,
  ) {}

  /** Keshni oldindan isitish — birinchi "Sotildi" ham xaritani kutmasin. */
  onApplicationBootstrap(): void {
    void this.getRegionDirectory();
  }

  /**
   * Kuzatuv qatori yozilgandan keyin chaqiriladi. `manager` — kuzatuv
   * yozilgan tranzaksiya (bo'lsa): outbox qatori ham AYNAN shunda, ya'ni
   * rollback bo'lsa bildirishnoma ham yo'q.
   */
  async onStatusChange(
    transition: TrackingTransition,
    manager?: EntityManager,
  ): Promise<void> {
    const type = resolveOrderNotificationType(
      transition.from_status,
      transition.to_status,
    );
    if (!type) return;

    const inTransaction = Boolean(manager?.queryRunner?.isTransactionActive);
    try {
      const repo = manager ? manager.getRepository(Order) : this.orderRepo;
      // Telegram matni mahsulotlarni ham ko'rsatadi — faqat o'sha turlarda
      // `items` bilan (bitta JOIN), sotuvda oddiy o'qish.
      const order = await repo.findOne(
        this.typeMayUseTelegram(type)
          ? {
              where: { id: String(transition.order_id) },
              relations: ['items'],
            }
          : { where: { id: String(transition.order_id) } },
      );
      if (!order) return;

      let payload: OrderNotificationPayload | null = null;
      try {
        const context = await this.collectContext(type, order);
        payload = buildOrderNotificationPayload(
          type,
          order,
          transition.from_status,
          context,
        );
      } catch (err) {
        this.logger.warn(
          `order notification payload (${type}, order=${transition.order_id}) qurilmadi: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        );
      }
      if (!payload) return;

      await this.outbox.enqueue(
        NOTIFICATION_OUTBOX_TARGET,
        NOTIFICATION_DISPATCH_PATTERN,
        payload,
        manager ? { manager } : {},
      );
    } catch (err) {
      // Tranzaksiya ichida DB xatosi — Postgres tranzaksiyasi baribir
      // buzilgan, chaqiruvchi rollback qilsin. Tranzaksiyasiz yo'lda esa
      // bildirishnoma biznes amalini yiqitmaydi (fail-open).
      if (inTransaction) throw err;
      this.logger.warn(
        `order notification (${type}, order=${transition.order_id}) outbox'ga yozilmadi: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }

  /**
   * (ePpLHPX2) Buyurtma kuryerga biriktirildi — `courier_id` yozilgan
   * tranzaksiyaning o'zida (`manager`) outbox'ga. Kuryer o'zgarmagan yoki
   * olib tashlangan bo'lsa hech narsa yozilmaydi. RPC yo'q (buyurtma
   * xotirada) — biriktirish tugmasini sekinlashtirmaydi.
   */
  async onCourierAssigned(
    input: {
      order: Pick<Order, 'id' | 'market_id' | 'courier_id' | 'status'>;
      previous_courier_id?: string | null;
    },
    manager?: EntityManager,
  ): Promise<void> {
    let payload: OrderNotificationPayload | null = null;
    try {
      payload = buildCourierAssignedPayload(
        input.order,
        input.previous_courier_id,
      );
    } catch (err) {
      this.logger.warn(
        `courier notification payload (order=${String(input?.order?.id)}) qurilmadi: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
    if (!payload) return;

    const inTransaction = Boolean(manager?.queryRunner?.isTransactionActive);
    try {
      await this.outbox.enqueue(
        NOTIFICATION_OUTBOX_TARGET,
        NOTIFICATION_DISPATCH_PATTERN,
        payload,
        manager ? { manager } : {},
      );
    } catch (err) {
      if (inTransaction) throw err;
      this.logger.warn(
        `courier notification (order=${String(input.order.id)}) outbox'ga yozilmadi: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }

  /**
   * `regions.logist_id` xaritasi (dzyVftBx). Yangi kesh — darhol; eskirgan —
   * darhol qaytariladi, yangilash fonda (stale-while-revalidate); kesh
   * umuman yo'q bo'lsagina `NOTIFY_LOOKUP_TIMEOUT_MS` gacha kutiladi.
   * Xato — `null` (logistsiz davom etiladi).
   */
  async getRegionDirectory(): Promise<RegionDirectory | null> {
    const cached = this.regionDirectory;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const load = this.loadRegionDirectory();
    return cached ? cached.value : load;
  }

  /** Bir vaqtda faqat BITTA so'rov (single-flight). Hech qachon reject qilmaydi. */
  private loadRegionDirectory(): Promise<RegionDirectory | null> {
    if (!this.regionDirectoryLoad) {
      this.regionDirectoryLoad = this.lookup<unknown>(
        'logistics',
        this.logisticsClient,
        'logistics.region.find_all',
        {},
      )
        .then((response) => {
          const directory = response ? buildRegionDirectory(response) : null;
          if (directory) {
            this.regionDirectory = {
              value: directory,
              expiresAt: Date.now() + REGION_DIRECTORY_TTL_MS,
            };
          }
          return directory ?? this.regionDirectory?.value ?? null;
        })
        .catch(() => this.regionDirectory?.value ?? null)
        .finally(() => {
          this.regionDirectoryLoad = null;
        });
    }
    return this.regionDirectoryLoad;
  }

  private typeMayUseTelegram(type: OrderNotificationType): boolean {
    return Boolean(
      findNotificationType(type)?.default_channels.includes(
        NotificationChannel.TELEGRAM,
      ),
    );
  }

  /**
   * Nishon (logist) va Telegram matni uchun kontekst. Barcha RPC'lar
   * PARALLEL, har biri qisqa timeout bilan; birortasi yiqilsa o'sha qism
   * bo'sh qoladi. Mijoz/kuryer/mahsulot — faqat Telegram ketadigan turda.
   */
  private async collectContext(
    type: OrderNotificationType,
    order: Order,
  ): Promise<OrderNotificationContext> {
    const wantsTelegram = orderTypeWantsTelegram(type, order);
    const customerId = idOrNull(order.customer_id);
    const courierId =
      idOrNull(order.courier_id) ?? idOrNull(order.holder_courier_id);
    const items = Array.isArray(order.items) ? order.items : [];
    const missingProductIds = [
      ...new Set(
        items
          .filter((item) => !clip(item?.product_name, 120))
          .map((item) => idOrNull(item?.product_id))
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const [directory, customerRes, courierRes, productsRes] = await Promise.all(
      [
        this.getRegionDirectory(),
        wantsTelegram && customerId
          ? this.lookup<unknown>(
              'identity',
              this.identityClient,
              'identity.customer.find_by_ids',
              { ids: [customerId] },
            )
          : null,
        wantsTelegram && courierId
          ? this.lookup<unknown>(
              'identity',
              this.identityClient,
              'identity.courier.find_by_ids',
              { ids: [courierId] },
            )
          : null,
        wantsTelegram && missingProductIds.length
          ? this.lookup<unknown>(
              'catalog',
              this.catalogClient,
              'catalog.product.find_by_ids',
              { ids: missingProductIds },
            )
          : null,
      ],
    );

    const regionId = directory ? regionOf(order, directory) : null;
    const logistId = regionId
      ? (directory?.logistByRegion.get(regionId) ?? null)
      : null;
    if (!wantsTelegram) return { logist_id: logistId };

    const productRows = (productsRes as { data?: unknown } | null)?.data;
    const productNames = new Map<string, string>(
      (Array.isArray(productRows) ? productRows : [])
        .map((row: { id?: unknown; name?: unknown }) => [
          idOrNull(row?.id),
          clip(row?.name, 120),
        ])
        .filter((pair): pair is [string, string] =>
          Boolean(pair[0] && pair[1]),
        ),
    );
    const customer = firstOf(customerRes);
    const courier = firstOf(courierRes);
    const districtId = idOrNull(order.district_id);
    return {
      logist_id: logistId,
      telegram: {
        customer: customer
          ? { name: customer.name, phone_number: customer.phone_number }
          : null,
        courier: courier
          ? { name: courier.name, phone_number: courier.phone_number }
          : null,
        region_name: regionId
          ? (directory?.regionName.get(regionId) ?? null)
          : null,
        district_name: districtId
          ? (directory?.districtName.get(districtId) ?? null)
          : null,
        items: items.map((item) => {
          const productId = idOrNull(item?.product_id);
          return {
            name:
              clip(item?.product_name, 120) ||
              (productId ? productNames.get(productId) : undefined) ||
              (productId ? `Mahsulot #${productId}` : 'Mahsulot'),
            quantity: Number(item?.quantity ?? 1),
          };
        }),
      },
    };
  }

  /**
   * Qisqa timeout'li, qayta urinishsiz o'qish RPC'si. Xato/timeout → `null`
   * va o'sha servis `NOTIFY_LOOKUP_BACKOFF_MS` davomida so'ralmaydi (har
   * hodisa tranzaksiyani timeout bilan ushlab turmasin).
   */
  private async lookup<T>(
    target: LookupTarget,
    client: ClientProxy | undefined,
    cmd: string,
    data: unknown,
  ): Promise<T | null> {
    if (!client) return null;
    if ((this.lookupDownUntil.get(target) ?? 0) > Date.now()) return null;
    try {
      return await rmqSend<T>(client, { cmd }, data, {
        timeoutMs: NOTIFY_LOOKUP_TIMEOUT_MS,
        retries: 0,
        attachRequestId: false,
      });
    } catch (err) {
      this.lookupDownUntil.set(target, Date.now() + NOTIFY_LOOKUP_BACKOFF_MS);
      this.logger.warn(
        `${cmd} (bildirishnoma uchun) javob bermadi — ${target} ${
          NOTIFY_LOOKUP_BACKOFF_MS / 1000
        } s so'ralmaydi: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      return null;
    }
  }
}
