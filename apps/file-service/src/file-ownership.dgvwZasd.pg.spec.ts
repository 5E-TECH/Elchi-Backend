import { DataSource } from 'typeorm';
import { FileOwnershipRegistry1716000000191 } from '../../../migrations/1716000000191-FileOwnershipRegistry';
import { FileObject } from './entities/file-object.entity';
import { FileOwnershipService } from './file-ownership.service';

/**
 * HAQIQIY POSTGRES testi — FAQAT `FILE_PG_TEST_URI` berilganda ishlaydi
 * (CI va oddiy `jest` da o'tkazib yuboriladi):
 *
 *   FILE_PG_TEST_URI=postgres://user:pass@localhost:5432/db \
 *     npx jest apps/file-service/src/file-ownership.dgvwZasd.pg.spec.ts --runInBand
 *
 * Migratsiya 191 va `FileObject` entity bir-biriga mosligi (mock ko'rsatmaydi):
 * `up()` → yozish/o'qish/o'chirish → `down()`. ⚠️ `file_schema.file_objects`
 * jadvalini `down()` o'chiradi — faqat bo'sh sinov bazasida ishlating.
 */
const PG_URI = process.env.FILE_PG_TEST_URI;
const describePg = PG_URI ? describe : describe.skip;

describePg('file_objects — real Postgres (dgvwZasd B)', () => {
  let ds: DataSource;
  let service: FileOwnershipService;
  const migration = new FileOwnershipRegistry1716000000191();

  beforeAll(async () => {
    ds = await new DataSource({
      type: 'postgres',
      url: PG_URI,
      schema: 'file_schema',
      entities: [FileObject],
      synchronize: false,
    }).initialize();
    const runner = ds.createQueryRunner();
    await migration.up(runner);
    await migration.up(runner); // IF NOT EXISTS — qayta yurgizish xatosiz.
    await runner.release();
    service = new FileOwnershipService(ds.getRepository(FileObject));
  });

  afterAll(async () => {
    const runner = ds.createQueryRunner();
    await migration.down(runner);
    const exists = await runner.query(
      `SELECT to_regclass('file_schema.file_objects') AS t`,
    );
    await runner.release();
    await ds.destroy();
    expect(exists[0].t).toBeNull();
  });

  const base = {
    folder: 'proof',
    mimeType: 'image/png',
    size: 123,
  };

  it('yozish → o‘qish: entity ustunlari migratsiyaga mos, created_at to‘ladi', async () => {
    const key = `proof-${Date.now()}-a.png`;
    await service.record({
      ...base,
      key,
      owner: { id: 26, role: 'courier', branch_id: 5 },
    });

    expect(await service.find(key)).toMatchObject({
      key,
      folder: 'proof',
      owner_id: '26',
      owner_role: 'courier',
      owner_branch_id: '5',
      mime_type: 'image/png',
      size_bytes: 123,
      created_at: expect.any(Date),
    });
  });

  it('tizim egasi (`system`) va filialsiz yozuv — bigint xatosi yo‘q', async () => {
    const key = `shift-report-${Date.now()}-r.pdf`;
    await service.record({
      ...base,
      folder: 'shift-report',
      key,
      owner: { id: 'system', role: 'system', branch_id: null },
    });
    expect(await service.find(key)).toMatchObject({
      owner_id: 'system',
      owner_branch_id: null,
    });
  });

  it('yo‘q kalit — null; forget qatorni oladi; takror forget xatosiz', async () => {
    const key = `proof-${Date.now()}-b.png`;
    expect(await service.find(key)).toBeNull();
    await service.record({ ...base, key, owner: { id: '1' } });
    await service.forget(key);
    await service.forget(key);
    expect(await service.find(key)).toBeNull();
  });

  it('bir xil kalit ikkinchi marta — xato yutiladi, birinchi egasi qoladi', async () => {
    const key = `proof-${Date.now()}-c.png`;
    await service.record({ ...base, key, owner: { id: '1' } });
    await service.record({ ...base, key, owner: { id: '2' } });
    expect((await service.find(key))?.owner_id).toBe('1');
  });
});
