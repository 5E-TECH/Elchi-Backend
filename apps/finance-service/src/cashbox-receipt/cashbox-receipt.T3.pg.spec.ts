import { randomUUID } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { DataSource } from 'typeorm';
import { ActivityLog, ActivityLogService } from '@app/common';
import { CashboxReceipts1716000000188 } from '../../../../migrations/1716000000188-CashboxReceipts';
import { CashboxReceipt } from '../entities/cashbox-receipt.entity';
import { FinanceSetting } from '../entities/finance-setting.entity';
import { CashboxReceiptService } from './cashbox-receipt.service';
import { CashboxReceiptCleanupScheduler } from './cashbox-receipt-cleanup.scheduler';

/**
 * T3-1 (QlLf33Ma) — kassa cheki, haqiqiy Postgres (FINANCE_T3_PG_TEST_URI
 * bo'lmasa skip). Migratsiya `finance_schema` ga yozadi — spec o'z
 * VAQTINCHALIK BAZASINI yaratadi va oxirida o'chiradi.
 *
 *  • 1716000000188 up ×2 / CHECK / down / qayta up;
 *  • sozlama: qator yo'q → hammasi true; rasm o'chsa AI o'chadi; AI+rasmsiz
 *    → 400; superadmin bo'lmagan → 403;
 *  • yuklash: rol × tur, rasm o'chiq → RECEIPT_DISABLED, qoralama;
 *  • tozalash: 25 soatlik `draft` o'chadi (fayl ham), 23 soatlik qoladi,
 *    eski `linked` chek HECH QACHON o'chmaydi; advisory lock.
 */
const pgUri = process.env.FINANCE_T3_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const SHA = 'a'.repeat(64);
const SA = ['superadmin'];

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as {
        statusCode?: number;
        code?: string;
        message?: string;
      };
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

describePg('T3-1 kassa cheki — haqiqiy Postgres', () => {
  const dbName = `spec_t3_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: CashboxReceiptService;
  const fileSend = jest.fn<unknown, [{ cmd: string }, { key: string }]>(() =>
    of({ statusCode: 200 }),
  );
  const migration = new CashboxReceipts1716000000188();

  const run = async (direction: 'up' | 'down') => {
    const runner = db.createQueryRunner();
    try {
      await migration[direction](runner);
    } finally {
      await runner.release();
    }
  };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri as string);
    url.pathname = `/${dbName}`;
    // finance_settings / activity_logs — entity'dan; cashbox_receipts —
    // MIGRATSIYADAN (entity ↔ migratsiya mosligi shu bilan tekshiriladi).
    const bootstrap = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities: [FinanceSetting, ActivityLog],
      synchronize: false,
    });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA finance_schema');
    await bootstrap.synchronize();
    await bootstrap.destroy();
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities: [FinanceSetting, ActivityLog, CashboxReceipt],
      synchronize: false,
    });
    await db.initialize();
    await run('up');
    service = new CashboxReceiptService(
      db,
      new ActivityLogService(db.getRepository(ActivityLog), 'finance-service'),
      { send: fileSend } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    fileSend.mockClear();
    fileSend.mockImplementation(() => of({ statusCode: 200 }));
    await db.query('DELETE FROM finance_schema.finance_settings');
    await db.query('DELETE FROM finance_schema.cashbox_receipts');
    await db.query('DELETE FROM finance_schema.activity_logs');
  });

  const draft = (over: Record<string, unknown> = {}) =>
    service.createDraft({
      kind: 'manual_expense',
      file_key: `cashbox-receipt-${randomUUID()}-receipt.jpg`,
      file_sha256: SHA,
      mime: 'image/jpeg',
      size_bytes: 1000,
      requester_id: '7',
      requester_roles: SA,
      ...over,
    }) as Promise<{ statusCode: number; data: { receipt_id: string } }>;

  // ───────────────────────── migratsiya ─────────────────────────

  it('migratsiya: up ikki marta xatosiz; CHECK noto`g`ri tur/holatni rad etadi; down → qayta up', async () => {
    await run('up');
    await expect(
      db.query(
        `INSERT INTO finance_schema.cashbox_receipts
           (kind, file_key, file_sha256, mime, size_bytes, uploaded_by)
         VALUES ('salary', 'k', $1, 'image/jpeg', 1, 1)`,
        [SHA],
      ),
    ).rejects.toThrow(/CHK_CASHBOX_RECEIPTS_KIND/);
    await expect(
      db.query(
        `INSERT INTO finance_schema.cashbox_receipts
           (kind, state, file_key, file_sha256, mime, size_bytes, uploaded_by)
         VALUES ('manual_expense', 'linked', 'k', $1, 'image/jpeg', 1, 1)`,
        [SHA],
      ),
    ).rejects.toThrow(/CHK_CASHBOX_RECEIPTS_LINKED/);
    await run('down');
    const gone = await db.query(
      `SELECT to_regclass('finance_schema.cashbox_receipts') AS t`,
    );
    expect(gone[0].t).toBeNull();
    await run('up');
  });

  it('UNIQUE history_id — bir operatsiyaga ikki chek bog`lanmaydi', async () => {
    const a = await draft();
    const b = await draft();
    await db.query(
      `UPDATE finance_schema.cashbox_receipts SET state = 'linked', history_id = 900 WHERE id = $1`,
      [a.data.receipt_id],
    );
    await expect(
      db.query(
        `UPDATE finance_schema.cashbox_receipts SET state = 'linked', history_id = 900 WHERE id = $1`,
        [b.data.receipt_id],
      ),
    ).rejects.toThrow(/UQ_CASHBOX_RECEIPTS_HISTORY/);
  });

  // ───────────────────────── sozlamalar ─────────────────────────

  it('⭐ qator yo`q → to`rttasi ham true', async () => {
    const res = (await service.getSettings()) as {
      data: Record<string, unknown>;
    };
    expect(res.data).toMatchObject({
      manual_expense: { photo_required: true, ai_enabled: true },
      hq_transfer: { photo_required: true, ai_enabled: true },
      updated_at: null,
      updated_by: null,
    });
  });

  it('⭐ {manual_expense:{photo_required:false}} → AI ham false; rasm qayta yoqilsa AI o`chiq qoladi; jurnal', async () => {
    const off = (await service.updateSettings({
      requester_id: '1',
      requester_roles: SA,
      manual_expense: { photo_required: false },
    })) as { data: Record<string, any> };
    expect(off.data.manual_expense).toEqual({
      photo_required: false,
      ai_enabled: false,
    });
    expect(off.data.hq_transfer).toEqual({
      photo_required: true,
      ai_enabled: true,
    });
    expect(off.data.updated_by).toBe('1');

    const on = (await service.updateSettings({
      requester_id: '1',
      requester_roles: SA,
      manual_expense: { photo_required: true },
    })) as { data: Record<string, any> };
    expect(on.data.manual_expense).toEqual({
      photo_required: true,
      ai_enabled: false,
    });

    const logs = await db.getRepository(ActivityLog).find({
      where: { action: 'finance.receipt_settings_updated' } as never,
    });
    expect(logs).toHaveLength(2);
    expect(logs[0].old_value).toMatchObject({
      manual_expense: { photo_required: true, ai_enabled: true },
    });
  });

  it('photo_required:false + ai_enabled:true → 400 RECEIPT_AI_REQUIRES_PHOTO, hech narsa yozilmaydi', async () => {
    await expect(
      rpcError(
        service.updateSettings({
          requester_id: '1',
          requester_roles: SA,
          manual_expense: { photo_required: false, ai_enabled: true },
        }),
      ),
    ).resolves.toMatchObject({
      statusCode: 400,
      code: 'RECEIPT_AI_REQUIRES_PHOTO',
    });
    expect(await db.getRepository(FinanceSetting).count()).toBe(0);
  });

  it.each([[['admin']], [['manager']], [[]]])(
    'superadmin bo`lmagan %j → 403',
    async (roles) => {
      await expect(
        rpcError(
          service.updateSettings({
            requester_id: '2',
            requester_roles: roles,
            hq_transfer: { ai_enabled: false },
          }),
        ),
      ).resolves.toMatchObject({ statusCode: 403 });
    },
  );

  // ───────────────────────── yuklash ─────────────────────────

  it.each([
    [['superadmin'], 'courier_to_hq', undefined, 200],
    [['admin'], 'branch_to_hq', undefined, 200],
    [['manager'], 'manual_expense', '15', 200],
    [['manager'], 'courier_to_hq', '15', 403],
    [['manager'], 'branch_to_hq', '15', 403],
    [['manager'], 'manual_expense', undefined, 403],
    [['courier'], 'manual_expense', undefined, 403],
    [['registrator'], 'manual_expense', undefined, 403],
  ])(
    'upload_check %j %s (filial %s) → %d',
    async (roles, kind, branch, status) => {
      const call = service.uploadCheck({
        kind,
        requester_roles: roles,
        branch_id: branch,
      });
      if (status === 200) {
        await expect(call).resolves.toMatchObject({ statusCode: 200 });
      } else {
        await expect(rpcError(call)).resolves.toMatchObject({
          statusCode: status,
        });
      }
    },
  );

  it('noto`g`ri kind → 400', async () => {
    await expect(
      rpcError(service.uploadCheck({ kind: 'salary', requester_roles: SA })),
    ).resolves.toMatchObject({ statusCode: 400 });
  });

  it('⭐ rasm o`chiq turga → 400 RECEIPT_DISABLED (boshqa tur ochiq)', async () => {
    await service.updateSettings({
      requester_id: '1',
      requester_roles: SA,
      hq_transfer: { photo_required: false },
    });
    await expect(
      rpcError(
        service.uploadCheck({ kind: 'courier_to_hq', requester_roles: SA }),
      ),
    ).resolves.toMatchObject({ statusCode: 400, code: 'RECEIPT_DISABLED' });
    await expect(
      rpcError(draft({ kind: 'branch_to_hq' })),
    ).resolves.toMatchObject({ code: 'RECEIPT_DISABLED' });
    await expect(
      service.uploadCheck({ kind: 'manual_expense', requester_roles: SA }),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it('⭐ qoralama: draft, menejer filiali, sozlama snapshot, jurnal (rasmsiz)', async () => {
    await service.updateSettings({
      requester_id: '1',
      requester_roles: SA,
      manual_expense: { ai_enabled: false },
    });
    const res = await draft({
      requester_id: '31',
      requester_roles: ['manager'],
      branch_id: '15',
    });
    expect(res).toMatchObject({
      statusCode: 201,
      data: { kind: 'manual_expense', state: 'draft' },
    });
    const row = await db
      .getRepository(CashboxReceipt)
      .findOneByOrFail({ id: res.data.receipt_id });
    expect(row).toMatchObject({
      state: 'draft',
      branch_id: '15',
      uploaded_by: '31',
      photo_required_snap: true,
      ai_enabled_snap: false,
      ai_status: 'disabled',
      history_id: null,
    });
    const logs = await db.getRepository(ActivityLog).find({
      where: { action: 'finance.receipt_uploaded' } as never,
    });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0])).not.toContain('cashbox-receipt-');
  });

  it.each([
    [{ file_key: 'shift-check-x' }],
    [{ file_sha256: 'xyz' }],
    [{ mime: 'image/gif' }],
    [{ size_bytes: 6 * 1024 * 1024 }],
    [{ requester_id: undefined }],
  ])('noto`g`ri qoralama %j → 400/403', async (over) => {
    const body = await rpcError(draft(over));
    expect([400, 403]).toContain(body.statusCode);
  });

  // ───────────────────────── tozalash ─────────────────────────

  const age = (id: string, hours: number) =>
    db.query(
      `UPDATE finance_schema.cashbox_receipts
          SET uploaded_at = now() - ($1 || ' hours')::interval WHERE id = $2`,
      [String(hours), id],
    );

  it('⭐ 25 soatlik qoralama o`chadi (fayl ham), 23 soatlik qoladi, eski BOG`LANGAN chek saqlanadi', async () => {
    const old = await draft();
    const fresh = await draft();
    const linked = await draft();
    await age(old.data.receipt_id, 25);
    await age(fresh.data.receipt_id, 23);
    await age(linked.data.receipt_id, 24 * 400);
    await db.query(
      `UPDATE finance_schema.cashbox_receipts SET state = 'linked', history_id = 777 WHERE id = $1`,
      [linked.data.receipt_id],
    );

    const scheduler = new CashboxReceiptCleanupScheduler(db, service);
    const result = await scheduler.tick();
    expect(result).toEqual({ locked: true, deleted: 1, failed: 0 });

    const rows = await db.getRepository(CashboxReceipt).find();
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    expect(byId.get(old.data.receipt_id)).toMatchObject({ isDeleted: true });
    expect(byId.get(old.data.receipt_id)?.deleted_at).toBeInstanceOf(Date);
    expect(byId.get(fresh.data.receipt_id)).toMatchObject({
      isDeleted: false,
    });
    expect(byId.get(linked.data.receipt_id)).toMatchObject({
      isDeleted: false,
      state: 'linked',
    });
    expect(fileSend).toHaveBeenCalledTimes(1);
    expect(fileSend.mock.calls[0][0]).toEqual({ cmd: 'file.delete' });
    expect(fileSend.mock.calls[0][1]).toMatchObject({
      key: byId.get(old.data.receipt_id)?.file_key,
    });

    // Ikkinchi yugurish — o'chiriladigan narsa qolmagan.
    expect(await scheduler.tick()).toEqual({
      locked: true,
      deleted: 0,
      failed: 0,
    });
  });

  it('file-service xato bersa qoralama qoladi (keyingi soatda); fayl allaqachon yo`q (404) — o`chadi', async () => {
    const a = await draft();
    await age(a.data.receipt_id, 30);
    fileSend.mockImplementation(() =>
      throwError(() => ({ statusCode: 500, message: 'down' })),
    );
    expect(await service.cleanupDrafts()).toEqual({ deleted: 0, failed: 1 });
    expect(
      (
        await db.getRepository(CashboxReceipt).findOneByOrFail({
          id: a.data.receipt_id,
        })
      ).isDeleted,
    ).toBe(false);

    fileSend.mockImplementation(() =>
      throwError(() => ({ statusCode: 404, message: 'not found' })),
    );
    expect(await service.cleanupDrafts()).toEqual({ deleted: 1, failed: 0 });
  });

  it('advisory lock band — tick hech narsa qilmaydi', async () => {
    const a = await draft();
    await age(a.data.receipt_id, 30);
    const holder = db.createQueryRunner();
    await holder.connect();
    await holder.query(
      'SELECT pg_advisory_lock($1::bigint)',
      [716_000_000_188],
    );
    try {
      const scheduler = new CashboxReceiptCleanupScheduler(db, service);
      expect(await scheduler.tick()).toEqual({
        locked: false,
        deleted: 0,
        failed: 0,
      });
    } finally {
      await holder.query(
        'SELECT pg_advisory_unlock($1::bigint)',
        [716_000_000_188],
      );
      await holder.release();
    }
  });
});
