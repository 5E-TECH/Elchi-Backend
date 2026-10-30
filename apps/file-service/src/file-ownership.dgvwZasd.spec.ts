import { RpcException } from '@nestjs/microservices';
import { FileOwnershipService } from './file-ownership.service';
import { FileServiceService } from './file-service.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed-url'),
}));

/**
 * (dgvwZasd B) Egalik reestri — file-service tomoni: yuklash qator yozadi,
 * reestr xatosi yuklashni to'xtatmaydi, o'chirish qatorni ham oladi.
 */
describe('Fayl egaligi reestri — file-service (dgvwZasd B)', () => {
  const PNG_B64 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]).toString('base64');

  const makeRepo = () => ({
    insert: jest.fn().mockResolvedValue(undefined),
    findOneBy: jest.fn().mockResolvedValue(null),
    delete: jest.fn().mockResolvedValue(undefined),
  });

  const makeService = (repo = makeRepo()) => {
    const config = {
      getOrThrow: jest.fn((k: string) =>
        k === 'MINIO_ENDPOINT' ? '127.0.0.1' : 'minio-test-secret',
      ),
      get: jest.fn(),
    } as any;
    const service = new FileServiceService(
      config,
      new FileOwnershipService(repo),
    );
    const s3Send = jest.fn().mockResolvedValue({});
    (service as any).s3 = { send: s3Send };
    return { service, repo, s3Send };
  };

  const upload = (service: FileServiceService, extra: object = {}) =>
    service.upload({
      file_name: 'proof photo.png',
      mime_type: 'image/png',
      file_base64: PNG_B64,
      folder: 'proof',
      ...extra,
    });

  it('⭐ yuklash qator yozadi: kalit, papka, yuklovchi, filial', async () => {
    const { service, repo } = makeService();
    const res: any = await upload(service, {
      owner: { id: '26', role: 'courier', branch_id: '5' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.data.key).toMatch(/^proof-/);
    expect(repo.insert).toHaveBeenCalledWith({
      key: res.data.key,
      folder: 'proof',
      owner_id: '26',
      owner_role: 'courier',
      owner_branch_id: '5',
      mime_type: 'image/png',
      size_bytes: 8,
    });
  });

  it('`owner` berilmasa (katalog rasmi) reestrga yozilmaydi', async () => {
    const { service, repo } = makeService();
    await upload(service, { folder: 'products' });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('owner bo‘sh id bilan — yozilmaydi', async () => {
    const { service, repo } = makeService();
    await upload(service, { owner: { id: '  ', role: 'courier' } });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('⭐ reestr yozuvi yiqilsa yuklash baribir 201 (kuryer sotuvi to‘xtamaydi)', async () => {
    const repo = makeRepo();
    repo.insert.mockRejectedValue(new Error('connection refused'));
    const { service } = makeService(repo);

    const res: any = await upload(service, { owner: { id: '26' } });

    expect(res.statusCode).toBe(201);
    expect(res.data.key).toMatch(/^proof-/);
  });

  it('S3 yiqilsa qator yozilmaydi', async () => {
    const { service, repo, s3Send } = makeService();
    s3Send.mockRejectedValue(new Error('minio down'));
    await expect(
      upload(service, { owner: { id: '26' } }),
    ).rejects.toBeInstanceOf(RpcException);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('findOwner: qator bor — egasi; yo‘q — data null', async () => {
    const repo = makeRepo();
    const created_at = new Date('2026-10-30T00:00:00Z');
    repo.findOneBy.mockResolvedValueOnce({
      key: 'proof-1',
      folder: 'proof',
      owner_id: '26',
      owner_role: 'courier',
      owner_branch_id: '5',
      mime_type: 'image/png',
      size_bytes: 8,
      created_at,
    });
    const { service } = makeService(repo);

    const found: any = await service.findOwner({ key: 'proof-1' });
    expect(found.data).toEqual({
      key: 'proof-1',
      folder: 'proof',
      owner_id: '26',
      owner_role: 'courier',
      owner_branch_id: '5',
      created_at,
    });
    expect(repo.findOneBy).toHaveBeenCalledWith({ key: 'proof-1' });

    const missing: any = await service.findOwner({ key: 'proof-2' });
    expect(missing.statusCode).toBe(200);
    expect(missing.data).toBeNull();
  });

  it('findOwner: DB xatosi "topilmadi" emas — RpcException', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockRejectedValue(new Error('db down'));
    const { service } = makeService(repo);
    await expect(service.findOwner({ key: 'proof-1' })).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('findOwner: kalitsiz — 400', async () => {
    const { service } = makeService();
    await expect(service.findOwner({})).rejects.toBeInstanceOf(RpcException);
  });

  it('o‘chirish reestr qatorini ham oladi; qator xatosi o‘chirishni buzmaydi', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    await service.remove({ key: 'proof-1' });
    expect(repo.delete).toHaveBeenCalledWith({ key: 'proof-1' });

    repo.delete.mockRejectedValue(new Error('db down'));
    await expect(service.remove({ key: 'proof-2' })).resolves.toMatchObject({
      statusCode: 200,
    });
  });
});
