import { Logger } from '@nestjs/common';
import {
  AiImageDecodeError,
  downscaleAiImage,
  loadSharp,
  prepareAiImages,
  setSharpForTesting,
} from './ai-image-resize';

/**
 * WHMAIqyo #2 — HAQIQIY sharp bilan: 1568 px, EXIF yo'nalishi qo'llanib
 * metadata olib tashlanadi, PNG → JPEG (oq fon), WebP → WebP, kichik rasm
 * kattalashtirilmaydi, buzilgan fayl → AiImageDecodeError.
 * sharp o'rnatilmagan muhitda (native binar yo'q) — o'tkazib yuboriladi;
 * CI'da `npm ci` uni o'rnatadi.
 */
interface SharpMeta {
  width?: number;
  height?: number;
  format?: string;
  exif?: Buffer;
  orientation?: number;
  hasAlpha?: boolean;
}
interface SharpPipelineLike {
  jpeg(o?: unknown): SharpPipelineLike;
  png(): SharpPipelineLike;
  webp(o?: unknown): SharpPipelineLike;
  withMetadata(o?: unknown): SharpPipelineLike;
  toBuffer(): Promise<Buffer>;
  metadata(): Promise<SharpMeta>;
}
/** sharp(buffer) yoki sharp({create}) — bitta argumentli shakllar. */
type SharpLike = (
  input:
    | Buffer
    | {
        create: {
          width: number;
          height: number;
          channels: 3 | 4;
          background: Record<string, number>;
        };
      },
) => SharpPipelineLike;

function realSharp(): SharpLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('sharp') as SharpLike;
  } catch {
    return null;
  }
}

const sharp = realSharp();
const describeSharp = sharp ? describe : describe.skip;

describeSharp('ai-image-resize (haqiqiy sharp)', () => {
  const s = sharp as SharpLike;

  beforeEach(() => setSharpForTesting(undefined));

  const solid = (w: number, h: number, channels: 3 | 4 = 3) =>
    s({
      create: {
        width: w,
        height: h,
        channels,
        background: { r: 200, g: 50, b: 50, alpha: 0.5 },
      },
    });

  it('3000×2000 JPEG, EXIF orientation=6 → 1045×1568, EXIF yo‘q', async () => {
    const input = await solid(3000, 2000)
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await s(input).metadata()).orientation).toBe(6);
    const out = await downscaleAiImage(input, 'image/jpeg');
    const meta = await s(out.buffer).metadata();
    expect(out.mediaType).toBe('image/jpeg');
    expect(meta.format).toBe('jpeg');
    // Yo'nalish qo'llangan (90° burilgan): balandlik endi uzun tomon.
    expect(meta.height).toBe(1568);
    expect(meta.width).toBe(1045);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('PNG (shaffof) → JPEG, oq fonga; kichik rasm kattalashtirilmaydi', async () => {
    const input = await solid(400, 300, 4).png().toBuffer();
    const out = await downscaleAiImage(input, 'image/png');
    const meta = await s(out.buffer).metadata();
    expect(out.mediaType).toBe('image/jpeg');
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([400, 300]);
    expect(meta.hasAlpha).toBe(false);
  });

  it('WebP → WebP, uzun tomon 1568', async () => {
    const input = await solid(2400, 1200).webp({ quality: 90 }).toBuffer();
    const out = await downscaleAiImage(input, 'image/webp');
    const meta = await s(out.buffer).metadata();
    expect(out.mediaType).toBe('image/webp');
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([1568, 784]);
  });

  it('buzilgan fayl (faqat imzo baytlari) → AiImageDecodeError', async () => {
    await expect(
      downscaleAiImage(
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
        'image/jpeg',
      ),
    ).rejects.toBeInstanceOf(AiImageDecodeError);
  });

  it('prepareAiImages: tartib saqlanadi, base64', async () => {
    const a = await solid(10, 10).jpeg().toBuffer();
    const b = await solid(20, 10).webp().toBuffer();
    const out = await prepareAiImages([
      { buffer: a, mediaType: 'image/jpeg' },
      { buffer: b, mediaType: 'image/webp' },
    ]);
    expect(out.map((x) => x.media_type)).toEqual(['image/jpeg', 'image/webp']);
    const second = await s(
      Buffer.from(out[1].data_base64, 'base64'),
    ).metadata();
    expect([second.width, second.height]).toEqual([20, 10]);
  });
});

describe('ai-image-resize — sharp yo‘q bo‘lsa (fallback)', () => {
  afterEach(() => setSharpForTesting(undefined));

  it('rasm o‘zgarishsiz qaytadi, gateway yiqilmaydi', async () => {
    setSharpForTesting(null);
    expect(loadSharp()).toBeNull();
    const buf = Buffer.from([1, 2, 3]);
    await expect(downscaleAiImage(buf, 'image/png')).resolves.toEqual({
      buffer: buf,
      mediaType: 'image/png',
    });
  });

  it('require xatosi bir marta WARN bilan null bo‘ladi', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    setSharpForTesting(undefined);
    const first = loadSharp();
    const second = loadSharp();
    expect(second).toBe(first);
    if (first === null) expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
