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

    service = new FileServiceService(config);
  });

  it('upload throws when file_name is missing', async () => {
    await expect(service.upload({ mime_type: 'image/png', file_base64: 'abcd' } as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('upload throws on unsupported mime', async () => {
    const b64 = Buffer.from('abc').toString('base64');
    await expect(
      service.upload({ file_name: 'a.txt', mime_type: 'text/plain', file_base64: b64 } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('upload returns 201 on success', async () => {
    const b64 = Buffer.from('abc').toString('base64');
    jest.spyOn(service as any, 'uploadBuffer').mockResolvedValue({ key: 'k1', bucket: 'b', file_name: 'a.png', mime_type: 'image/png', size: 3, url: 'u' });

    const res = await service.upload({ file_name: 'a.png', mime_type: 'image/png', file_base64: b64 } as any);

    expect(res.statusCode).toBe(201);
    expect(res.data.key).toBe('k1');
  });

  it('getUrl throws when key is missing', async () => {
    await expect(service.getUrl({ key: '' } as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('remove deletes object and returns 200', async () => {
    jest.spyOn(service as any, 'ensureObjectExists').mockResolvedValue(undefined);
    jest.spyOn((service as any).s3, 'send').mockResolvedValue({});

    const res = await service.remove({ key: 'uploads-a.png' } as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.key).toBe('uploads-a.png');
  });

  it('generateQr throws when text is empty', async () => {
    await expect(service.generateQr({ text: '   ' } as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('generatePdf throws when content is empty', async () => {
    await expect(service.generatePdf({ content: '  ' } as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('generatePdf returns 201 when upload succeeds', async () => {
    jest.spyOn(service as any, 'uploadBuffer').mockResolvedValue({ key: 'pdf-k', bucket: 'b', file_name: 'document.pdf', mime_type: 'application/pdf', size: 10, url: 'u' });

    const res = await service.generatePdf({ content: 'hello', title: 'T' } as any);

    expect(res.statusCode).toBe(201);
    expect(res.data.key).toBe('pdf-k');
  });
});
