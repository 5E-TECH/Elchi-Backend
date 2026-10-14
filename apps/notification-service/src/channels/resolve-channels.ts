import {
  NotificationChannel,
  NotificationDeliveryStatus,
  allowedNotificationChannels,
  findNotificationType,
} from '@app/common';

/**
 * KANAL TANLASH QOIDASI (7Ec56EIw) — "kim, qaysi tur uchun, qaysi kanalni
 * oladi" BITTA joyda. SOF funksiya: I/O yo'q. Kanal imkoniyati (push obunasi,
 * telefon raqami) va foydalanuvchi sozlamasi chaqiruvchi tomonidan OLDINDAN,
 * butun qabul qiluvchilar ro'yxati uchun BULK so'rov bilan yig'iladi
 * (channel-planner.service.ts) — funksiya ichida per-recipient so'rov YO'Q,
 * aks holda 5000 qabul qiluvchida 5000 so'rov bo'lib QFoRULeu yutug'i yo'qoladi.
 *
 * Ustuvorlik:
 *   (a) katalogdagi `default_channels` (chaqiruvchi `channels` bermasa);
 *   (b) chaqiruvchi `channels` bersa — katalogdagi `allowed_channels` bilan
 *       KESISHMA (ortiqcha kanal qo'shilmaydi);
 *   (c) foydalanuvchi o'chirgan kanal chiqib ketadi (`skipped` + `muted`);
 *       `in_app` (yoki hammasi) o'chirilsa — qator umuman yaratilmaydi;
 *   (d) kanal imkoniyati: push — faol obuna, sms — telefon raqami. Imkoniyati
 *       yo'q kanal jimgina tashlanmaydi — `delivery[ch]` ga holati yoziladi.
 *
 * ⚠️ REALTIME va PUSH aralashtirilmaydi: REALTIME = socket.io (brauzer
 * OCHIQ), PUSH = brauzer yopiq bo'lsa ham yetadi. Onlayn foydalanuvchiga push
 * yubormaslik yetkazish paytida (`pushSuppressedByPresence`) hal qilinadi.
 *
 * ⚠️ DB migratsiya kerak emas: `channels` ustuni JSONB (1716000000008:45).
 */

/** Kanal imkoniyati yo'qligi sababi (`null`/yo'q — imkoniyat bor). */
export interface ChannelBlock {
  status:
    | NotificationDeliveryStatus.NOT_ELIGIBLE
    | NotificationDeliveryStatus.NO_PROVIDER
    | NotificationDeliveryStatus.NO_SUBSCRIPTION;
  reason?: string;
}

export interface ResolveChannelsRecipient {
  /** Foydalanuvchi o'chirgan kanallar; `'all'` — tur butunlay o'chirilgan. */
  muted?: ReadonlySet<string> | 'all' | null;
  /** Kanal imkoniyati — faqat YO'Q bo'lganlari (bulk yig'ilgan). */
  blocked?: Partial<Record<NotificationChannel, ChannelBlock | null>>;
}

export interface ResolvedChannels {
  /** (a)+(b) natijasi — `notifications.channels` ga yoziladi. */
  requested: NotificationChannel[];
  /** Haqiqatan yuboriladigan kanallar. */
  active: NotificationChannel[];
  /** Boshlang'ich `delivery` JSONB. */
  delivery: Record<string, string>;
  /** `in_app` o'chirilgan — qabul qiluvchi ro'yxatdan tushadi. */
  excluded: boolean;
}

const MUTED_REASON = 'muted';

const isChannel = (value: unknown): value is NotificationChannel =>
  (Object.values(NotificationChannel) as string[]).includes(String(value));

/**
 * (a)+(b): katalog sukuti yoki chaqiruvchi so'ragani ∩ ruxsat etilgan.
 * Tartib saqlanadi, takrorlar olib tashlanadi.
 */
export function requestedChannels(
  type: string,
  requested?: readonly string[] | null,
): NotificationChannel[] {
  const entry = findNotificationType(type);
  if (!requested?.length) {
    return [
      ...new Set(
        entry?.default_channels ?? [
          NotificationChannel.IN_APP,
          NotificationChannel.REALTIME,
        ],
      ),
    ];
  }
  const allowed = new Set<string>(allowedNotificationChannels(type));
  return [
    ...new Set(
      requested.filter(
        (channel): channel is NotificationChannel =>
          isChannel(channel) && allowed.has(channel),
      ),
    ),
  ];
}

/** Faol kanal uchun boshlang'ich holat (avvalgi `initialDelivery` bilan bir xil). */
export function initialChannelStatus(channel: NotificationChannel): string {
  if (channel === NotificationChannel.IN_APP) {
    return NotificationDeliveryStatus.SENT;
  }
  if (channel === NotificationChannel.PUSH) {
    // Push faqat navbatga qo'yiladi (outbox) — darhol "navbatda".
    return NotificationDeliveryStatus.QUEUED;
  }
  if (channel === NotificationChannel.EMAIL) {
    // Email provayderi ulanmagan — jim "skipped" emas, DB'da ko'rinadi.
    return NotificationDeliveryStatus.NO_PROVIDER;
  }
  return NotificationDeliveryStatus.PENDING;
}

/** (a)-(d) bitta qabul qiluvchi uchun. SOF — I/O yo'q. */
export function resolveChannels(
  type: string,
  requested: readonly string[] | null | undefined,
  recipient: ResolveChannelsRecipient = {},
): ResolvedChannels {
  const channels = requestedChannels(type, requested);
  const muted = recipient.muted ?? null;
  const isMuted = (channel: string) =>
    muted === 'all' || (muted !== null && muted.has(channel));

  if (isMuted(NotificationChannel.IN_APP)) {
    return { requested: channels, active: [], delivery: {}, excluded: true };
  }

  const active: NotificationChannel[] = [];
  const delivery: Record<string, string> = {
    [NotificationChannel.IN_APP]: NotificationDeliveryStatus.SENT,
  };
  for (const channel of channels) {
    if (channel === NotificationChannel.IN_APP) {
      active.push(channel);
      continue;
    }
    if (isMuted(channel)) {
      delivery[channel] = NotificationDeliveryStatus.SKIPPED;
      delivery[`${channel}_reason`] = MUTED_REASON;
      continue;
    }
    const block = recipient.blocked?.[channel];
    if (block) {
      delivery[channel] = block.status;
      if (block.reason) delivery[`${channel}_reason`] = block.reason;
      continue;
    }
    active.push(channel);
    delivery[channel] = initialChannelStatus(channel);
  }
  return { requested: channels, active, delivery, excluded: false };
}

/**
 * (7Ec56EIw #4) REALTIME ham so'ralgan va foydalanuvchi ONLAYN (socket
 * ulangan) bo'lsa push yuborilmaydi — xabar ochiq tabga realtime bilan
 * yetadi. Oflayn bo'lsa (yoki onlaynlik noma'lum) — push ketadi.
 */
export function pushSuppressedByPresence(
  channels: readonly string[] | null | undefined,
  online: boolean,
): boolean {
  return online && (channels ?? []).includes(NotificationChannel.REALTIME);
}
