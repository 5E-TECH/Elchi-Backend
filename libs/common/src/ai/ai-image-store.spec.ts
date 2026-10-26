import { Logger } from '@nestjs/common';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  AI_IMAGE_TMP_TTL_MS,
  AiImageStore,
  isAiImageKeyFor,
  type S3Like,
} from './ai-image-store';

/** WHMAIqyo #3 — ai-parse rasmlari vaqtinchalik saqlovi (S3 soxta, tarmoq yo'q). */
const DRAFT = '0b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4';

function fakeS3(handler: (cmd: unknown) => unknown = () => ({})) {
  const sent: unknown[] = [];
  const s3: S3Like = {
    send: jest.fn((cmd: unknown) => {
      sent.push(cmd);
      try {
        return Promise.resolve(handler(cmd));
      } catch (err) {
        return Promise.reject(err as Error);
      }
    }),
  };
  return { s3, sent };
}

describe('AiImageStore', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('putAll: ai-tmp/<draft>/<n>.<ext> kalitlari, ContentType, tartib saqlanadi', async () => {
    const { s3, sent } = fakeS3();
    const store = new AiImageStore(s3, 'elchi-files');
    const refs = await store.putAll(DRAFT, [
      { mediaType: 'image/jpeg', buffer: Buffer.from('a') },
      { mediaType: 'image/webp', buffer: Buffer.from('b') },
    ]);
    expect(refs).toEqual([
      { key: `ai-tmp/${DRAFT}/0.jpg`, media_type: 'image/jpeg' },
      { key: `ai-tmp/${DRAFT}/1.webp`, media_type: 'image/webp' },
    ]);
    expect(sent.every((c) => c instanceof PutObjectCommand)).toBe(true);
    expect((sent[1] as PutObjectCommand).input).toMatchObject({
      Bucket: 'elchi-files',
      Key: `ai-tmp/${DRAFT}/1.webp`,
      ContentType: 'image/webp',
    });
  });

  it('putAll: bittasi yiqilsa — yozilganlar o‘chiriladi va throw', async () => {
    let n = 0;
    const { s3, sent } = fakeS3((cmd) => {
      if (cmd instanceof PutObjectCommand && n++ === 1) {
        throw new Error('minio down');
      }
      return {};
    });
    const store = new AiImageStore(s3, 'b');
    await expect(
      store.putAll(DRAFT, [
        { mediaType: 'image/jpeg', buffer: Buffer.from('a') },
        { mediaType: 'image/jpeg', buffer: Buffer.from('b') },
      ]),
    ).rejects.toThrow('ai_image_put_failed');
    await new Promise((r) => setImmediate(r));
    expect(sent.some((c) => c instanceof DeleteObjectsCommand)).toBe(true);
  });

  it('getAll: base64 qaytaradi; deleteAll xatoda throw qilmaydi', async () => {
    const { s3 } = fakeS3((cmd) => {
      if (cmd instanceof GetObjectCommand) {
        return {
          Body: {
            transformToByteArray: () =>
              Promise.resolve(new Uint8Array(Buffer.from('IMG'))),
          },
        };
      }
      throw new Error('delete failed');
    });
    const store = new AiImageStore(s3, 'b');
    const ref = {
      key: `ai-tmp/${DRAFT}/0.jpg`,
      media_type: 'image/jpeg' as const,
    };
    await expect(store.getAll([ref])).resolves.toEqual([
      {
        media_type: 'image/jpeg',
        data_base64: Buffer.from('IMG').toString('base64'),
      },
    ]);
    await expect(store.deleteAll([ref])).resolves.toBeUndefined();
  });

  it('sweepExpired: faqat ai-tmp/ ostidagi 1 soatdan eski obyektlar, sahifalab', async () => {
    const now = Date.parse('2026-10-26T12:00:00Z');
    const old = new Date(now - AI_IMAGE_TMP_TTL_MS - 1);
    const fresh = new Date(now - 60_000);
    const pages = [
      {
        Contents: [
          { Key: `ai-tmp/${DRAFT}/0.jpg`, LastModified: old },
          { Key: `ai-tmp/${DRAFT}/1.jpg`, LastModified: fresh },
        ],
        IsTruncated: true,
        NextContinuationToken: 't2',
      },
      {
        Contents: [{ Key: 'ai-tmp/x/2.png', LastModified: old }],
        IsTruncated: false,
      },
    ];
    let page = 0;
    const { s3, sent } = fakeS3((cmd) =>
      cmd instanceof ListObjectsV2Command ? pages[page++] : {},
    );
    const store = new AiImageStore(s3, 'b');
    await expect(store.sweepExpired(now)).resolves.toBe(2);
    const lists = sent.filter(
      (c): c is ListObjectsV2Command => c instanceof ListObjectsV2Command,
    );
    expect(lists.map((c) => c.input.Prefix)).toEqual(['ai-tmp/', 'ai-tmp/']);
    expect(lists[1].input.ContinuationToken).toBe('t2');
    const deletes = sent.filter(
      (c): c is DeleteObjectsCommand => c instanceof DeleteObjectsCommand,
    );
    expect(deletes.flatMap((d) => d.input.Delete?.Objects ?? [])).toEqual([
      { Key: `ai-tmp/${DRAFT}/0.jpg` },
      { Key: 'ai-tmp/x/2.png' },
    ]);
  });

  it('sweepExpired: S3 xatosi throw qilmaydi (0)', async () => {
    const { s3 } = fakeS3(() => {
      throw new Error('down');
    });
    await expect(new AiImageStore(s3, 'b').sweepExpired()).resolves.toBe(0);
  });

  it('fromConfig: MINIO_* bo‘lmasa null', () => {
    const config = { get: () => undefined };
    expect(AiImageStore.fromConfig(config as never)).toBeNull();
    const full = {
      get: (k: string) =>
        ({
          MINIO_ENDPOINT: 'minio',
          MINIO_ACCESS_KEY: 'a',
          MINIO_SECRET_KEY: 'b'.repeat(20),
        })[k],
    };
    expect(AiImageStore.fromConfig(full as never)).toBeInstanceOf(AiImageStore);
  });
});

describe('isAiImageKeyFor — RMQ payload orqali begona obyektni o‘qib bo‘lmaydi', () => {
  const ok = { key: `ai-tmp/${DRAFT}/3.png`, media_type: 'image/png' };
  it('faqat shu draft, ai-tmp/, raqamli nom va mos kengaytma', () => {
    expect(isAiImageKeyFor(DRAFT, ok)).toBe(true);
    for (const bad of [
      { ...ok, key: `ai-tmp/${DRAFT.replace('0b9f', '1b9f')}/3.png` },
      { ...ok, key: `products/${DRAFT}/3.png` },
      { ...ok, key: `ai-tmp/${DRAFT}/../secret.png` },
      { ...ok, key: `ai-tmp/${DRAFT}/3.jpg` },
      { ...ok, media_type: 'image/gif' },
      null,
      'ai-tmp/x',
    ]) {
      expect(isAiImageKeyFor(DRAFT, bad)).toBe(false);
    }
  });
});
