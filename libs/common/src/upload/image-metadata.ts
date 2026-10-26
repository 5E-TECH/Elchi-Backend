/**
 * kiZgTybn — rasm METAMA'LUMOTINI tozalash (EXIF / XMP / IPTC / matn
 * bloklari): GPS koordinatalari, qurilma seriyasi, sana va h.k. saqlanmasin.
 *
 * Tashqi kutubxona ISHLATILMAYDI (`file-signature.ts` bilan bir xil sabab):
 * faqat konteyner bloklari olib tashlanadi, piksel ma'lumoti O'ZGARMAYDI
 * (qayta kodlash yo'q — sifat va AI o'qishi buzilmaydi).
 *
 *   • JPEG — APP1 (EXIF/XMP), APP13 (IPTC/Photoshop), COM segmentlari;
 *   • PNG  — eXIf, tEXt, zTXt, iTXt, tIME chunk'lari;
 *   • WebP — EXIF va "XMP " chunk'lari (VP8X bayroqlari ham tozalanadi).
 *
 * Tuzilma buzilgan bo'lsa `null` — chaqiruvchi faylni RAD etadi (400).
 */

export type StrippableImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

const JPEG_DROP_MARKERS = new Set([0xe1, 0xed, 0xfe]);
const PNG_DROP_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
const WEBP_DROP_CHUNKS = new Set(['EXIF', 'XMP ']);

function stripJpeg(buffer: Buffer): Buffer | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  const parts: Buffer[] = [buffer.subarray(0, 2)];
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    // To'ldiruvchi 0xFF baytlar.
    let markerOffset = offset;
    while (markerOffset < buffer.length && buffer[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    if (markerOffset >= buffer.length) return null;
    const marker = buffer[markerOffset];
    const segmentStart = markerOffset - 1;
    // SOS — undan keyin entropiya bilan kodlangan ma'lumot: qolgani as-is.
    if (marker === 0xda) {
      parts.push(buffer.subarray(segmentStart));
      return Buffer.concat(parts);
    }
    if (marker === 0xd9) {
      parts.push(buffer.subarray(segmentStart, markerOffset + 1));
      return Buffer.concat(parts);
    }
    // Uzunliksiz markerlar (RSTn, TEM).
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(buffer.subarray(segmentStart, markerOffset + 1));
      offset = markerOffset + 1;
      continue;
    }
    if (markerOffset + 2 >= buffer.length) return null;
    const length = buffer.readUInt16BE(markerOffset + 1);
    if (length < 2) return null;
    const end = markerOffset + 1 + length;
    if (end > buffer.length) return null;
    if (!JPEG_DROP_MARKERS.has(marker)) {
      parts.push(buffer.subarray(segmentStart, end));
    }
    offset = end;
  }
  return null;
}

function stripPng(buffer: Buffer): Buffer | null {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) {
    return null;
  }
  const parts: Buffer[] = [buffer.subarray(0, 8)];
  let offset = 8;
  let sawEnd = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) return null;
    if (!PNG_DROP_CHUNKS.has(type)) {
      parts.push(buffer.subarray(offset, end));
    }
    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  return sawEnd ? Buffer.concat(parts) : null;
}

function stripWebp(buffer: Buffer): Buffer | null {
  if (
    buffer.length < 12 ||
    buffer.toString('latin1', 0, 4) !== 'RIFF' ||
    buffer.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  const chunks: Buffer[] = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const fourcc = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const padded = size + (size % 2);
    const end = offset + 8 + padded;
    if (offset + 8 + size > buffer.length) return null;
    const chunk = Buffer.from(
      buffer.subarray(offset, Math.min(end, buffer.length)),
    );
    if (fourcc === 'VP8X' && size >= 1) {
      // Bayroqlar: 0x08 — EXIF, 0x04 — XMP.
      chunk[8] = chunk[8] & ~0x0c;
    }
    if (!WEBP_DROP_CHUNKS.has(fourcc)) chunks.push(chunk);
    offset = end;
  }
  if (!chunks.length) return null;
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

/** Metama'lumotsiz nusxa yoki `null` (tuzilma buzilgan / tur qo'llanmaydi). */
export function stripImageMetadata(
  buffer: Buffer,
  mime: string,
): Buffer | null {
  try {
    switch (String(mime ?? '').toLowerCase()) {
      case 'image/jpeg':
      case 'image/jpg':
        return stripJpeg(buffer);
      case 'image/png':
        return stripPng(buffer);
      case 'image/webp':
        return stripWebp(buffer);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
