/**
 * Yuklangan faylning HAQIQIY turini birinchi baytlari bo'yicha tekshirish
 * (audit S8).
 *
 * ⚠️ MUAMMO. `file.mimetype` — multer uni multipart qismining
 * `Content-Type` sarlavhasidan oladi, ya'ni uni MIJOZ YOZADI. Ruxsat etilgan
 * turlar ro'yxati faqat shu so'zga tayanardi: `.exe`, `.html` yoki skript
 * faylni `image/jpeg` deb e'lon qilib yuklash mumkin edi. Fayl keyin
 * MinIO'dan o'sha e'lon qilingan tur bilan qaytariladi — ya'ni saqlangan
 * HTML brauzerda ochilsa XSS, boshqa hollarda esa zararli faylni tarqatish
 * yo'li bo'lardi.
 *
 * Bu yerda tashqi kutubxona ISHLATILMAYDI: qo'llab-quvvatlanadigan turlar
 * ro'yxati qisqa va ularning imzosi (magic bytes) barqaror. Kutubxona
 * qo'shish yangi bog'liqlik va yangi zaiflik yuzasi demakdir.
 */

interface Signature {
  /** Boshlanishidagi baytlar. `null` — istalgan bayt (joker). */
  bytes: Array<number | null>;
  /** Qaysi ofsetdan boshlab tekshiriladi. */
  offset?: number;
}

const SIGNATURES: Record<string, Signature[]> = {
  'image/png': [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  'image/jpeg': [{ bytes: [0xff, 0xd8, 0xff] }],
  'image/jpg': [{ bytes: [0xff, 0xd8, 0xff] }],
  'image/webp': [
    { bytes: [0x52, 0x49, 0x46, 0x46] },
    { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  ],
  'application/pdf': [{ bytes: [0x25, 0x50, 0x44, 0x46] }],
  // XLSX — ZIP konteyner (PK\x03\x04).
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
    { bytes: [0x50, 0x4b, 0x03, 0x04] },
  ],
  // MP4/MOV — ISO BMFF: 4 bayt uzunlik, so'ng 'ftyp'.
  'video/mp4': [{ bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }],
  'video/quicktime': [{ bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }],
  // WebM/Matroska — EBML sarlavhasi.
  'video/webm': [{ bytes: [0x1a, 0x45, 0xdf, 0xa3] }],
};

function matches(buffer: Buffer, signature: Signature): boolean {
  const offset = signature.offset ?? 0;
  if (buffer.length < offset + signature.bytes.length) {
    return false;
  }
  return signature.bytes.every(
    (byte, index) => byte === null || buffer[offset + index] === byte,
  );
}

/**
 * E'lon qilingan MIME turi faylning haqiqiy imzosiga mos keladimi.
 *
 * Imzosi ma'lum bo'lmagan tur uchun `true` qaytaradi — bu funksiya MIME
 * ro'yxatini ALMASHTIRMAYDI, uni kuchaytiradi: avval ro'yxat tekshiriladi,
 * so'ng imzo.
 */
export function matchesDeclaredType(
  buffer: Buffer,
  declaredMime: string,
): boolean {
  const expected = SIGNATURES[String(declaredMime ?? '').toLowerCase()];
  if (!expected || !expected.length) {
    return true;
  }
  return expected.every((signature) => matches(buffer, signature));
}
