import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { AiImageMediaType } from './order-extract.contract';

/**
 * WHMAIqyo #3 — ai-parse rasmlari RabbitMQ'da base64 bo'lib yurmasin:
 * gateway rasmni (kichraytirilgan) file-service saqlovi — MinIO bucket'iga
 * (`MINIO_*`, file-service bilan BIR XIL) VAQTINCHALIK yozadi, `ai.order.extract`
 * payload'iga faqat KALIT (`image_refs`) tushadi; ai-service kalit bo'yicha
 * o'qib Claude'ga yuboradi va darhol o'chiradi.
 *
 * ⚠️ MAXFIYLIK (HD5zOyBp yangilandi, ega 2026-10-23 kartasi): rasm endi
 * diskka (MinIO) ko'pi bilan `AI_IMAGE_TMP_TTL_MS` (1 soat) yoziladi —
 * ekstraksiyadan keyin darhol o'chiriladi, o'chmay qolgani ai-service
 * tozalovchisi (`sweepExpired`, har 10 daqiqa) bilan 1 soatda o'chadi.
 * Kalit `ai-tmp/<draft_id>/<n>.<ext>` — ichida PII yo'q; bucket shaxsiy
 * (public URL berilmaydi). Kalitlar QAT'IY regex bilan tekshiriladi —
 * RMQ payload'i orqali bucket'dagi boshqa faylni o'qib bo'lmaydi.
 *
 * Bu modul `@app/common` barrel'iga EXPORT QILINMAYDI (S3 SDK hamma servisda
 * yuklanmasin) — `@app/common/ai/ai-image-store` dan import qilinadi.
 */

/** DI tokeni — qiymat `AiImageStore | null` (MINIO_* yo'q bo'lsa null). */
export const AI_IMAGE_STORE = Symbol('AI_IMAGE_STORE');

export const AI_IMAGE_TMP_PREFIX = 'ai-tmp/';
/** Vaqtinchalik rasmning maksimal umri — 1 soat (karta: TTL 1 soat). */
export const AI_IMAGE_TMP_TTL_MS = 60 * 60_000;
/** Tozalovchi davri (ai-service). */
export const AI_IMAGE_SWEEP_INTERVAL_MS = 10 * 60_000;
/** S3 so'rovlari uchun timeout — ai-parse byudjetini yeb qo'ymasin. */
const S3_TIMEOUT_MS = 8_000;

export interface AiImageRef {
  key: string;
  media_type: AiImageMediaType;
}

const EXT: Record<AiImageMediaType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_RE = new RegExp(`^ai-tmp/(${UUID})/(\\d{1,2})\\.(jpg|png|webp)$`);

/** Kalit faqat shu draft'ning vaqtinchalik rasmi bo'lsa true. */
export function isAiImageKeyFor(draftId: string, ref: unknown): boolean {
  if (!ref || typeof ref !== 'object') return false;
  const { key, media_type } = ref as Partial<AiImageRef>;
  if (typeof key !== 'string' || typeof media_type !== 'string') return false;
  const m = KEY_RE.exec(key);
  if (!m || m[1] !== draftId.toLowerCase()) return false;
  return (EXT as Record<string, string>)[media_type] === m[3];
}

/** S3Client'ning bizga kerak qismi (testda soxta). */
export interface S3Like {
  send(
    command: unknown,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

function describe(err: unknown): string {
  return err instanceof Error
    ? `${err.name}: ${err.message}`.slice(0, 200)
    : 'non-error';
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  const b = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
  } | null;
  if (b && typeof b.transformToByteArray === 'function') {
    return Buffer.from(await b.transformToByteArray());
  }
  throw new Error('S3 body o‘qilmadi');
}

export class AiImageStore {
  private readonly logger = new Logger(AiImageStore.name);

  constructor(
    private readonly s3: S3Like,
    private readonly bucket: string,
  ) {}

  /**
   * `MINIO_*` env'dan (file-service bilan bir xil); kalit/endpoint bo'lmasa
   * null — chaqiruvchi eski base64 yo'liga qaytadi.
   */
  static fromConfig(config: ConfigService): AiImageStore | null {
    const str = (k: string): string => {
      const v = config.get<unknown>(k);
      if (typeof v === 'string') return v.trim();
      return typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
    };
    const host = str('MINIO_ENDPOINT');
    const accessKeyId = str('MINIO_ACCESS_KEY');
    const secretAccessKey = str('MINIO_SECRET_KEY');
    if (!host || !accessKeyId || !secretAccessKey) return null;
    const port = Number(str('MINIO_PORT') || 9000);
    const ssl = str('MINIO_USE_SSL') === 'true';
    const s3 = new S3Client({
      region: 'us-east-1',
      endpoint: `${ssl ? 'https' : 'http'}://${host}:${port}`,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 1,
    });
    return new AiImageStore(
      s3 as unknown as S3Like,
      str('MINIO_BUCKET') || 'elchi-files',
    );
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(S3_TIMEOUT_MS);
  }

  /** Rasmlarni parallel yozadi; bittasi yiqilsa — yozilganlari o'chiriladi, throw. */
  async putAll(
    draftId: string,
    images: ReadonlyArray<{ mediaType: AiImageMediaType; buffer: Buffer }>,
  ): Promise<AiImageRef[]> {
    const refs: AiImageRef[] = images.map((img, i) => ({
      key: `${AI_IMAGE_TMP_PREFIX}${draftId.toLowerCase()}/${i}.${EXT[img.mediaType]}`,
      media_type: img.mediaType,
    }));
    const results = await Promise.allSettled(
      images.map((img, i) =>
        this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: refs[i].key,
            Body: img.buffer,
            ContentType: img.mediaType,
          }),
          { abortSignal: this.signal() },
        ),
      ),
    );
    const failed = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failed) {
      void this.deleteAll(refs);
      throw new Error(`ai_image_put_failed: ${describe(failed.reason)}`);
    }
    return refs;
  }

  /** Kalitlar bo'yicha parallel o'qiydi (base64). Kalit tekshiruvi chaqiruvchida. */
  async getAll(
    refs: ReadonlyArray<AiImageRef>,
  ): Promise<{ media_type: AiImageMediaType; data_base64: string }[]> {
    return Promise.all(
      refs.map(async (ref) => {
        const res = await this.s3.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: ref.key }),
          { abortSignal: this.signal() },
        );
        const buf = await bodyToBuffer((res as { Body?: unknown })?.Body);
        return {
          media_type: ref.media_type,
          data_base64: buf.toString('base64'),
        };
      }),
    );
  }

  /** O'chiradi — HECH QACHON throw qilmaydi (faqat WARN). */
  async deleteAll(refs: ReadonlyArray<AiImageRef>): Promise<void> {
    if (refs.length === 0) return;
    try {
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: refs.map((r) => ({ Key: r.key })), Quiet: true },
        }),
        { abortSignal: this.signal() },
      );
    } catch (err) {
      this.logger.warn(`ai_image_delete_failed: ${describe(err)}`);
    }
  }

  /**
   * TTL tozalovchisi: `ai-tmp/` ostidagi `AI_IMAGE_TMP_TTL_MS` dan eski
   * obyektlar o'chiriladi. Qaytaradi: o'chirilganlar soni. Throw yo'q.
   */
  async sweepExpired(now: number = Date.now()): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    try {
      do {
        const page = (await this.s3.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: AI_IMAGE_TMP_PREFIX,
            ContinuationToken: token,
            MaxKeys: 1000,
          }),
          { abortSignal: this.signal() },
        )) as {
          Contents?: { Key?: string; LastModified?: Date }[];
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        };
        const expired = (page.Contents ?? []).filter(
          (o) =>
            typeof o.Key === 'string' &&
            o.Key.startsWith(AI_IMAGE_TMP_PREFIX) &&
            o.LastModified instanceof Date &&
            now - o.LastModified.getTime() > AI_IMAGE_TMP_TTL_MS,
        );
        if (expired.length > 0) {
          await this.s3.send(
            new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: {
                Objects: expired.map((o) => ({ Key: o.Key as string })),
                Quiet: true,
              },
            }),
            { abortSignal: this.signal() },
          );
          deleted += expired.length;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    } catch (err) {
      this.logger.warn(`ai_image_sweep_failed: ${describe(err)}`);
    }
    return deleted;
  }
}
