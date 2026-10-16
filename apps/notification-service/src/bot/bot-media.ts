import { TELEGRAM_LIMITS } from './bot-transport.service';
import type { TelegramMessage, TelegramPhotoSize } from './telegram.types';

/**
 * (GL2GgtEc #4) Media chegaralari — BeePostdan aynan:
 *  - rasm ≤ 5MB, faqat jpeg/png/gif/webp;
 *  - HEIC va katta fayl → "📷 SURAT sifatida yuboring" yo'naltiruvi;
 *  - rasm o'lchamlaridan limit ostidagi ENG KATTASI tanlanadi.
 * NOMUVOFIQLIK (TZ'da aniq): Telegram `getFile` ~20MB dan katta faylni
 * BERMAYDI, Elchi isbot yuklash limiti esa 50MB (`FileInterceptor('proof')`).
 * Bot yo'lida 20MB dan katta fayl (video/hujjat) aniq matn bilan rad
 * etiladi — jimgina yo'qolmaydi.
 */
export const BOT_MEDIA_LIMITS = {
  PHOTO_MAX_BYTES: 5 * 1024 * 1024,
  FILE_MAX_BYTES: TELEGRAM_LIMITS.GET_FILE_MAX_BYTES,
  ALLOWED_IMAGE_MIME: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
} as const;

export const MEDIA_SEND_AS_PHOTO_TEXT =
  '📷 Faylni SURAT sifatida yuboring (jpeg/png/gif/webp, 5MB gacha). HEIC va katta fayllar qabul qilinmaydi.';

export const MEDIA_TOO_LARGE_TEXT =
  '❌ Fayl 20MB dan katta — Telegram bot bunday faylni qabul qila olmaydi. Videoni qisqartiring yoki SURAT yuboring; katta isbotni Elchi ilovasi orqali yuklang (50MB gacha).';

export type MediaCheck =
  | {
      ok: true;
      kind: 'photo' | 'image' | 'video' | 'document';
      file_id: string;
      size: number | null;
    }
  | {
      ok: false;
      reply: string;
      reason: 'too_large' | 'unsupported' | 'no_media';
    };

/** Limit ostidagi eng katta rasm o'lchami (o'lchamsiz bo'lsa — oxirgisi). */
export function pickPhotoSize(
  sizes: TelegramPhotoSize[] | undefined,
  maxBytes: number = BOT_MEDIA_LIMITS.PHOTO_MAX_BYTES,
): TelegramPhotoSize | null {
  const list = (sizes ?? []).filter((size) => size?.file_id);
  if (!list.length) return null;
  const fitting = list.filter(
    (size) => size.file_size === undefined || size.file_size <= maxBytes,
  );
  if (!fitting.length) return null;
  return fitting.reduce((best, size) =>
    (size.file_size ?? (size.width ?? 0) * (size.height ?? 0)) >=
    (best.file_size ?? (best.width ?? 0) * (best.height ?? 0))
      ? size
      : best,
  );
}

/** Kiruvchi xabardagi media'ni tekshiradi; rad etilsa — foydalanuvchiga matn. */
export function checkIncomingMedia(
  message: TelegramMessage | undefined,
): MediaCheck {
  if (message?.photo?.length) {
    const size = pickPhotoSize(message.photo);
    if (!size) {
      return {
        ok: false,
        reply: MEDIA_SEND_AS_PHOTO_TEXT,
        reason: 'too_large',
      };
    }
    return {
      ok: true,
      kind: 'photo',
      file_id: size.file_id,
      size: size.file_size ?? null,
    };
  }
  const file = message?.video ?? message?.document;
  if (!file?.file_id) {
    return { ok: false, reply: '', reason: 'no_media' };
  }
  const size = file.file_size ?? null;
  if (size !== null && size > BOT_MEDIA_LIMITS.FILE_MAX_BYTES) {
    return { ok: false, reply: MEDIA_TOO_LARGE_TEXT, reason: 'too_large' };
  }
  if (message?.video) {
    return { ok: true, kind: 'video', file_id: file.file_id, size };
  }
  const mime = String(file.mime_type ?? '').toLowerCase();
  if (mime.startsWith('image/')) {
    const allowed = (
      BOT_MEDIA_LIMITS.ALLOWED_IMAGE_MIME as readonly string[]
    ).includes(mime);
    if (
      !allowed ||
      (size !== null && size > BOT_MEDIA_LIMITS.PHOTO_MAX_BYTES)
    ) {
      // HEIC / katta rasm hujjat sifatida — surat sifatida yuborishga yo'naltiriladi.
      return {
        ok: false,
        reply: MEDIA_SEND_AS_PHOTO_TEXT,
        reason: 'unsupported',
      };
    }
    return { ok: true, kind: 'image', file_id: file.file_id, size };
  }
  return { ok: true, kind: 'document', file_id: file.file_id, size };
}
