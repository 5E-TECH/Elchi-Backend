import { RpcException } from '@nestjs/microservices';
import { FileServiceService } from './file-service.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed-url'),
}));

jest.mock('qrcode', () => ({
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('qr-data')),
}));

describe('FileServiceService', () => {
  let service: FileServiceService;
  const qrCodeModule = jest.requireMock('qrcode');

  beforeEach(() => {
    const config = {
      getOrThrow: jest.fn((k: string) => {
        if (k === 'MINIO_ENDPOINT') return '127.0.0.1';
        if (k === 'MINIO_ACCESS_KEY') return 'minioadmin';
        if (k === 'MINIO_SECRET_KEY') return 'minioadmin';
        return '';
      }),
      get: jest.fn((k: string) => {
        const map: Record<string, string> = {
          MINIO_PORT: '9000',
          MINIO_USE_SSL: 'false',
          MINIO_BUCKET: 'elchi-files',
          FILE_MAX_SIZE_MB: '10',
          FILE_SIGNED_URL_EXPIRES: '3600',
        };
        return map[k];
      }),
    } as any;

    service = new FileServiceService(config, {
      record: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue(null),
      forget: jest.fn().mockResolvedValue(undefined),
    } as any);
  });

  it('upload throws when file_name is missing', async () => {
    await expect(
      service.upload({ mime_type: 'image/png', file_base64: 'abcd' } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('upload throws on unsupported mime', async () => {
    const b64 = Buffer.from('abc').toString('base64');
    await expect(
      service.upload({
        file_name: 'a.txt',
        mime_type: 'text/plain',
        file_base64: b64,
      } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('upload returns 201 on success', async () => {
    // Magic-bytes validatsiyasidan o'tishi uchun haqiqiy PNG sarlavhasi (8 bayt).
    const b64 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]).toString('base64');
    jest.spyOn(service as any, 'uploadBuffer').mockResolvedValue({
      key: 'k1',
      bucket: 'b',
      file_name: 'a.png',
      mime_type: 'image/png',
      size: 3,
      url: 'u',
    });

    const res = await service.upload({
      file_name: 'a.png',
      mime_type: 'image/png',
      file_base64: b64,
    });

    expect(res.statusCode).toBe(201);
    expect(res.data.key).toBe('k1');
  });

  // ugoDD9TT: mahsulot rasmlari uchun WebP (RIFF....WEBP imzosi bilan).
  describe('ugoDD9TT — WebP', () => {
    const WEBP = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WEBPVP8 '),
    ]);

    it('haqiqiy WebP → 201', async () => {
      jest.spyOn(service as any, 'uploadBuffer').mockResolvedValue({
        key: 'products-1-u-a.webp',
        bucket: 'b',
        file_name: 'a.webp',
        mime_type: 'image/webp',
        size: WEBP.length,
        url: 'u',
      });
      const res = await service.upload({
        file_name: 'a.webp',
        mime_type: 'image/webp',
        file_base64: WEBP.toString('base64'),
      });
      expect(res.statusCode).toBe(201);
    });

    it.each([
      ['PDF', Buffer.from('%PDF-1.4\n%xx')],
      [
        'RIFF/WAVE (WebP emas)',
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.from([0, 0, 0, 0]),
          Buffer.from('WAVEfmt '),
        ]),
      ],
    ])(
      'image/webp deb e`lon qilingan %s → rad etiladi',
      async (_label, buffer) => {
        const uploadBuffer = jest.spyOn(service as any, 'uploadBuffer');
        await expect(
          service.upload({
            file_name: 'a.webp',
            mime_type: 'image/webp',
            file_base64: buffer.toString('base64'),
          } as any),
        ).rejects.toBeInstanceOf(RpcException);
        expect(uploadBuffer).not.toHaveBeenCalled();
      },
    );

    it('WebP mazmuni image/png deb e`lon qilinsa → rad etiladi', async () => {
      await expect(
        service.upload({
          file_name: 'a.png',
          mime_type: 'image/png',
          file_base64: WEBP.toString('base64'),
        } as any),
      ).rejects.toBeInstanceOf(RpcException);
    });
  });

  it('getUrl throws when key is missing', async () => {
    await expect(service.getUrl({ key: '' } as any)).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('remove deletes object and returns 200', async () => {
    jest
      .spyOn(service as any, 'ensureObjectExists')
      .mockResolvedValue(undefined);
    jest.spyOn((service as any).s3, 'send').mockResolvedValue({});

    const res = await service.remove({ key: 'uploads-a.png' });

    expect(res.statusCode).toBe(200);
    expect(res.data.key).toBe('uploads-a.png');
  });

  it('generateQr throws when text is empty', async () => {
    await expect(
      service.generateQr({ text: '   ' } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('generateQr sends prefixed text to QR encoder', async () => {
    jest.spyOn(service as any, 'uploadBuffer').mockResolvedValue({
      key: 'qr-k',
      bucket: 'b',
      file_name: 'qr.png',
      mime_type: 'image/png',
      size: 7,
      url: 'u',
    });

    await service.generateQr({ text: '12345', prefix: 'BTB-' } as any);

    expect(qrCodeModule.toBuffer).toHaveBeenCalledWith(
      'BTB-12345',
      expect.objectContaining({ type: 'png' }),
    );
  });

  it('generatePdf throws when content is empty', async () => {
    await expect(
      service.generatePdf({ content: '  ' } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('generatePdf returns 201 when upload succeeds', async () => {
    jest.spyOn(service as any, 'uploadBuffer').mockResolvedValue({
      key: 'pdf-k',
      bucket: 'b',
      file_name: 'document.pdf',
      mime_type: 'application/pdf',
      size: 10,
      url: 'u',
    });

    const res = await service.generatePdf({
      content: 'hello',
      title: 'T',
    });

    expect(res.statusCode).toBe(201);
    expect(res.data.key).toBe('pdf-k');
  });
});
