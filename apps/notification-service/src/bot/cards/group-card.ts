import { cabinetLinks, escapeTelegramHtml } from '@app/common';
import { STATUS_LABEL_UZ, formatSum } from '../courier/courier-cards';
import { STATUS_EMOJI } from '../handlers/market.handler';
import type { InlineKeyboardButton } from '../telegram.types';

/** order-service `order.telegram_card` javobi (OrderTelegramCard). */
export interface GroupCardData {
  id: string;
  order_number?: string | null;
  market_id?: string | null;
  status: string;
  total_price?: number | string | null;
  district_name?: string | null;
  operator?: string | null;
  show_customer_pii?: boolean;
  customer_name?: string | null;
  customer_phone?: string | null;
}

const clip = (value: unknown, max: number): string => {
  const text =
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};
const field = (value: unknown, max = 120) =>
  escapeTelegramHtml(clip(value, max) || '-');

/**
 * (ysBqD9Nx #3) Market guruhi kartasi: raqam, holat, TUMAN (to'liq manzil
 * emas), summa, operator; mijoz ismi/telefoni — market bayrog'iga qarab
 * (`tg_group_show_customer_pii`, EGA QARORI: sukut yoqiq; o'chiq — ism
 * yo'q, telefon niqoblangan — niqoblash order-service'da). ✅/❌ tasdiq
 * tugmalari YO'Q (Elchida bunday bosqich yo'q) — faqat "Kabinetda ochish".
 */
export function groupCardText(card: GroupCardData): string {
  const status = String(card.status ?? '');
  const number = clip(card.order_number, 20) || `#${clip(card.id, 20)}`;
  const lines = [
    `${STATUS_EMOJI[status] ?? '•'} <b>Buyurtma ${escapeTelegramHtml(number.startsWith('#') ? number : `#${number}`)}</b>`,
    `Holati: <b>${escapeTelegramHtml(STATUS_LABEL_UZ[status] ?? status)}</b>`,
    `📍 Tuman: ${field(card.district_name)}`,
    `💰 Summa: ${escapeTelegramHtml(formatSum(card.total_price ?? 0))}`,
    `👨‍💼 Operator: ${field(card.operator)}`,
  ];
  if (card.show_customer_pii !== false && clip(card.customer_name, 120)) {
    lines.push(`👤 Mijoz: ${field(card.customer_name)}`);
  }
  if (clip(card.customer_phone, 40)) {
    lines.push(`📞 Telefon: ${field(card.customer_phone, 40)}`);
  }
  return lines.join('\n').slice(0, 4000);
}

export function groupCardKeyboard(
  cabinetUrl: string,
  orderId: string,
): InlineKeyboardButton[][] {
  // (PIJN1lGp) guruh kartasi — buyurtma tafsiloti sahifasi.
  return [
    [
      {
        text: '🌐 Kabinetda ochish',
        url: cabinetLinks(cabinetUrl).orderDetail(orderId),
      },
    ],
  ];
}
