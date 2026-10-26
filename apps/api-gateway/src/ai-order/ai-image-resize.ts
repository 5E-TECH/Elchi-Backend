import { Logger } from '@nestjs/common';
import {
  AI_IMAGE_MAX_EDGE_PX,
  AI_IMAGE_REENCODE_QUALITY,
  type AiImageMediaType,
} from '@app/common';

/**
 * WHMAIqyo #2 — ai-parse rasmlarini SERVERDA kichraytirish (frontend
 * kichraytirmasa ham token kam bo'lsin):
 *  - EXIF yo'nalishi qo'llanadi (`rotate()`), so'ng BARCHA metadata (EXIF,
 *    GPS, ICC) olib tashlanadi — sharp sukut bo'yicha metadata yozmaydi;
 *  - eng uzun tomon `AI_IMAGE_MAX_EDGE_PX` (1568) dan oshmaydi, kichik rasm
 *    kattalashtirilmaydi;
 *  - WebP → WebP q80, JPEG/PNG → JPEG q80 (PNG shaffofligi oq fonga).
 * Sonnet 5 rasmni 2576 px gacha o'zi kichraytiradi (~4784 vizual token);
 * 1568 px ≈ 2 barobar kam vizual token.
 *
 * ⚠️ `sharp` (native modul) DANGASA yuklanadi: u yuklanmasa (masalan Alpine
 * imijida binar mos kelmasa) gateway baribir ko'tariladi va rasm asl holida
 * (allaqachon validatsiyadan o'tgan) yuboriladi — bitta WARN bilan. Rasm
 * faqat RAM'da: diskka/MinIO'ga YOZILMAYDI.
 */

export interface AiPreparedImage {
  media_type: AiImageMediaType;
  data_base64: string;
}

/** sharp'ning bizga kerak qismi (tiplar ixtiyoriy native modulga bog'lanmasin). */
interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(o: {
    width: number;
    height: number;
    fit: 'inside';
    withoutEnlargement: boolean;
  }): SharpPipeline;
  flatten(o: { background: string }): SharpPipeline;
  jpeg(o: { quality: number; mozjpeg?: boolean }): SharpPipeline;
  webp(o: { quality: number }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
}
export type SharpFactory = (
  input: Buffer,
  options?: {
    failOn?: 'none' | 'truncated' | 'error';
    limitInputPixels?: number;
  },
) => SharpPipeline;

/** Dekompressiya bombasidan himoya: 40 MP dan katta rasm o'qilmaydi. */
const MAX_INPUT_PIXELS = 40_000_000;

const logger = new Logger('AiImageResize');
let cachedSharp: SharpFactory | null | undefined;

/** `sharp` ni bir marta yuklaydi; yuklanmasa — null (WARN bir marta). */
export function loadSharp(): SharpFactory | null {
  if (cachedSharp !== undefined) return cachedSharp;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedSharp = require('sharp') as SharpFactory;
  } catch (err) {
    cachedSharp = null;
    logger.warn(
      `sharp yuklanmadi — ai-parse rasmlari kichraytirilmaydi: ${
        err instanceof Error ? err.message.slice(0, 200) : 'unknown'
      }`,
    );
  }
  return cachedSharp;
}

/** Testlar uchun: sharp fabrikasini almashtirish (null — "yuklanmadi"). */
export function setSharpForTesting(factory: SharpFactory | null | undefined) {
  cachedSharp = factory;
}

/** Rasm dekodlanmadi (buzilgan fayl) — gateway 400 qaytaradi. */
export class AiImageDecodeError extends Error {
  constructor() {
    super('ai_image_decode_failed');
    this.name = 'AiImageDecodeError';
  }
}

/**
 * Bitta rasmni kichraytiradi. sharp yo'q bo'lsa — asl bayt va tur.
 * @throws AiImageDecodeError — sharp rasmni o'qiy olmasa
 */
export async function downscaleAiImage(
  buffer: Buffer,
  mediaType: AiImageMediaType,
): Promise<{ buffer: Buffer; mediaType: AiImageMediaType }> {
  const sharp = loadSharp();
  if (!sharp) return { buffer, mediaType };
  try {
    let pipeline = sharp(buffer, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({
        width: AI_IMAGE_MAX_EDGE_PX,
        height: AI_IMAGE_MAX_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      });
    if (mediaType === 'image/webp') {
      pipeline = pipeline.webp({ quality: AI_IMAGE_REENCODE_QUALITY });
      return { buffer: await pipeline.toBuffer(), mediaType: 'image/webp' };
    }
    pipeline = pipeline
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: AI_IMAGE_REENCODE_QUALITY, mozjpeg: true });
    return { buffer: await pipeline.toBuffer(), mediaType: 'image/jpeg' };
  } catch {
    throw new AiImageDecodeError();
  }
}

/** Barcha rasmlarni parallel kichraytiradi (tartib saqlanadi). */
export function downscaleAiImages(
  images: ReadonlyArray<{ buffer: Buffer; mediaType: AiImageMediaType }>,
): Promise<{ buffer: Buffer; mediaType: AiImageMediaType }[]> {
  return Promise.all(
    images.map((img) => downscaleAiImage(img.buffer, img.mediaType)),
  );
}

/** Barcha rasmlarni parallel tayyorlaydi — base64 (tartib saqlanadi). */
export async function prepareAiImages(
  images: ReadonlyArray<{ buffer: Buffer; mediaType: AiImageMediaType }>,
): Promise<AiPreparedImage[]> {
  return toBase64Images(await downscaleAiImages(images));
}

export function toBase64Images(
  images: ReadonlyArray<{ buffer: Buffer; mediaType: AiImageMediaType }>,
): AiPreparedImage[] {
  return images.map((img) => ({
    media_type: img.mediaType,
    data_base64: img.buffer.toString('base64'),
  }));
}
