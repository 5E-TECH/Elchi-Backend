import { createHash } from 'crypto';
import {
  AI_AUDITED_FIELDS,
  maskPhoneForLog,
  normalizeUzPhone,
  type AiAuditedField,
  type AiDraftPreviewSnapshot,
} from '@app/common';

/**
 * vncdmXOy #2 — AI TAKLIFI (preview snapshot) va operator TASDIQLAGAN
 * buyurtmani SERVER tomonda solishtirish. `edited_fields` mijozdan HECH
 * QACHON olinmaydi (DTO'da bunday maydon yo'q — forbidNonWhitelisted 400).
 *
 * Snapshot'ni faqat shu modul quradi (ai-parse oxirida) va faqat shu modul
 * solishtiradi — algoritm bitta joyda. ai-service snapshot'ni o'zgartirmay
 * saqlaydi.
 *
 * ⚠️ MAXFIYLIK (HD5zOyBp): snapshot'da to'liq telefon YO'Q — maskalangan
 * ko'rinish va normallashgan raqamning sha256'i.
 */

type Row = Record<string, unknown>;

const text = (value: unknown): string =>
  typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : '';

const textOrNull = (value: unknown): string | null => text(value) || null;

const idOrNull = (value: unknown): string | null => {
  const s = text(value);
  return /^\d{1,19}$/.test(s) ? s : null;
};

const priceOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Telefon xeshi: UZ raqami normallashsa `+998…`, aks holda faqat raqamlar. */
export function aiPhoneDigest(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const normalized = normalizeUzPhone(raw) ?? raw.replace(/\D/g, '');
  if (!normalized) return null;
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function maskedPhone(value: unknown): string | null {
  const raw = text(value);
  return raw ? maskPhoneForLog(raw) : null;
}

/** Mahsulotlar ro'yxatining tartibsiz kanonik ko'rinishi. */
function itemsKey(
  items: ReadonlyArray<{
    product_id?: unknown;
    name?: unknown;
    product_name?: unknown;
    quantity?: unknown;
  } | null>,
): string {
  return items
    .map((it) => {
      const qty = Math.round(Number(it?.quantity) || 0);
      const productId = idOrNull(it?.product_id);
      return productId
        ? `p${productId}x${qty}`
        : `n${text(it?.name ?? it?.product_name).toLowerCase()}x${qty}`;
    })
    .sort()
    .join('|');
}

/**
 * order-service preview'idan (`AiOrderPreview`) kompakt snapshot. Kalitlar
 * RO'YXAT bo'yicha — xom obyekt yoyilmaydi.
 */
export function buildPreviewSnapshots(
  previews: unknown[],
): AiDraftPreviewSnapshot[] {
  return previews
    .filter((p): p is Row => !!p && typeof p === 'object' && !Array.isArray(p))
    .map((p, position) => {
      const index = Number(p.index);
      const items = Array.isArray(p.items) ? (p.items as Row[]) : [];
      return {
        index: Number.isInteger(index) && index >= 0 ? index : position,
        customer_name: textOrNull(p.customer_name),
        phone_masked: maskedPhone(p.phone_number),
        phone_sha256: aiPhoneDigest(p.phone_number),
        extra_masked: maskedPhone(p.extra_number),
        extra_sha256: aiPhoneDigest(p.extra_number),
        region_id: idOrNull(p.region_id),
        district_id: idOrNull(p.district_id),
        address: textOrNull(p.address),
        total_price: priceOrNull(p.total_price),
        where_deliver: textOrNull(p.where_deliver)?.toLowerCase() ?? null,
        comment: textOrNull(p.comment),
        operator: textOrNull(p.operator),
        is_replacement: p.is_replacement === true,
        items: items
          .filter((it) => !!it && typeof it === 'object')
          .map((it) => ({
            name: text(it.name),
            product_id: idOrNull(it.product_id),
            quantity: Math.round(Number(it.quantity) || 0),
          })),
      };
    });
}

/** Tasdiqlangan buyurtmaning solishtiriladigan qismi (DB'dan olingan ID'lar bilan). */
export interface AiConfirmedForAudit {
  customer: {
    name?: unknown;
    phone_number?: unknown;
    extra_number?: unknown;
    address?: unknown;
  };
  /** Serverda tekshirilgan (DB) tuman/viloyat — mijoz yuborgani emas. */
  district_id: string;
  region_id: string;
  address?: unknown;
  total_price?: unknown;
  where_deliver?: unknown;
  comment?: unknown;
  operator?: unknown;
  items: ReadonlyArray<{
    product_id?: unknown;
    product_name?: unknown;
    quantity?: unknown;
  } | null>;
}

/**
 * O'zgargan maydonlar — `AI_AUDITED_FIELDS` tartibida. Hech narsa
 * o'zgarmasa bo'sh massiv (TC5).
 */
export function computeEditedFields(
  preview: AiDraftPreviewSnapshot,
  confirmed: AiConfirmedForAudit,
): AiAuditedField[] {
  const changed = new Set<AiAuditedField>();
  const differs = (a: unknown, b: unknown) => text(a) !== text(b);

  if (differs(preview.customer_name, confirmed.customer?.name)) {
    changed.add('customer_name');
  }
  if (
    preview.phone_sha256 !== aiPhoneDigest(confirmed.customer?.phone_number)
  ) {
    changed.add('phone_number');
  }
  if (
    preview.extra_sha256 !== aiPhoneDigest(confirmed.customer?.extra_number)
  ) {
    changed.add('extra_number');
  }
  if ((preview.region_id ?? '') !== (confirmed.region_id ?? '')) {
    changed.add('region_id');
  }
  if ((preview.district_id ?? '') !== (confirmed.district_id ?? '')) {
    changed.add('district_id');
  }
  if (
    differs(
      preview.address,
      confirmed.address ?? confirmed.customer?.address ?? null,
    )
  ) {
    changed.add('address');
  }
  if (preview.total_price !== priceOrNull(confirmed.total_price)) {
    changed.add('total_price');
  }
  if (
    text(preview.where_deliver).toLowerCase() !==
    text(confirmed.where_deliver).toLowerCase()
  ) {
    changed.add('where_deliver');
  }
  if (differs(preview.comment, confirmed.comment)) changed.add('comment');
  if (differs(preview.operator, confirmed.operator)) changed.add('operator');
  if (itemsKey(preview.items) !== itemsKey(confirmed.items)) {
    changed.add('items');
  }
  return AI_AUDITED_FIELDS.filter((f) => changed.has(f));
}

/**
 * Barqaror ai-confirm kaliti (Cp2v3ZJ7 #1): `ai:<market>:<draft>:<idx>`.
 * draft_id yoki ai_item_index bo'lmasa null — eski `ai-dedupe:<imzo>` yo'li.
 */
export function aiStableRequestId(
  marketId: string,
  draftId: unknown,
  itemIndex: unknown,
): string | null {
  const draft = text(draftId).toLowerCase();
  const idx = Number(itemIndex);
  if (
    !/^\d{1,19}$/.test(marketId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      draft,
    ) ||
    itemIndex === null ||
    itemIndex === undefined ||
    !Number.isInteger(idx) ||
    idx < 0 ||
    idx > 999
  ) {
    return null;
  }
  return `ai:${marketId}:${draft}:${idx}`;
}
