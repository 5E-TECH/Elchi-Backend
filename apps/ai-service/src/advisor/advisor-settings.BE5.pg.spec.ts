import { RpcException } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { aiAdvisorDefaultRules, type ActivityLogService } from '@app/common';
import { AiAdvisorAlerts1716000000224 } from '../../../../migrations/1716000000224-AiAdvisorAlerts';
import { AdvisorSettingsService } from './advisor-settings.service';

/**
 * BE-5 — sozlamalar haqiqiy Postgres'da: migratsiya (idempotent, down),
 * version (optimistik qulf), parallel PATCH → bittasi 409, o'zgarishsiz
 * PATCH versiyani oshirmaydi, audit, ogohlantirishlar jadvalining ochiq
 * qator UNIQUE indeksi va takrorlar UNIQUE (dedup_key, fact_key).
 */
const ADMIN_URI = process.env.AI_ADVISOR_PG_TEST_URI;
const describePg = ADMIN_URI ? describe : describe.skip;

/**
 * Qo'riq: spec O'Z vaqtinchalik bazasini yaratadi va oxirida o'chiradi —
 * `AI_ADVISOR_PG_TEST_URI` faqat ulanish uchun (lokal host bo'lishi shart),
 * mavjud bazadagi jadval/qatorlarga tegilmaydi.
 */
function tempDbUri(admin: string, name: string): string {
  const url = new URL(admin);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error(
      'AI_ADVISOR_PG_TEST_URI faqat lokal Postgres bo‘lishi kerak',
    );
  }
  url.pathname = `/${name}`;
  return url.toString();
}

const SA = { id: '1', roles: ['superadmin'], name: 'Test Superadmin' };

function codeOf(err: unknown): Record<string, unknown> {
  expect(err).toBeInstanceOf(RpcException);
  return (err as RpcException).getError() as Record<string, unknown>;
}

describePg('AdvisorSettingsService — real Postgres (BE-5)', () => {
  let ds: DataSource;
  let service: AdvisorSettingsService;
  const log = jest.fn<Promise<void>, [Record<string, unknown>]>();

  const dbName = `elchi_ai_advisor_${process.pid}_${Date.now()}`;
  let admin: DataSource;

  beforeAll(async () => {
    const uri = tempDbUri(ADMIN_URI as string, dbName);
    admin = new DataSource({ type: 'postgres', url: ADMIN_URI });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    ds = new DataSource({ type: 'postgres', url: uri, synchronize: false });
    await ds.initialize();
    const qr = ds.createQueryRunner();
    try {
      await qr.query('CREATE SCHEMA IF NOT EXISTS ai_schema');
      await new AiAdvisorAlerts1716000000224().up(qr);
      await new AiAdvisorAlerts1716000000224().up(qr); // idempotent
      await new AiAdvisorAlerts1716000000224().down(qr);
      await new AiAdvisorAlerts1716000000224().up(qr);
    } finally {
      await qr.release();
    }
    service = new AdvisorSettingsService(ds, {
      log,
    } as unknown as ActivityLogService);
  });

  beforeEach(async () => {
    log.mockReset();
    await ds.query('DELETE FROM ai_schema.ai_advisor_settings');
  });

  afterAll(async () => {
    await ds?.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.destroy();
    }
  });

  it('qator yo‘q: version 1, sukutlar, updated_by null', async () => {
    const view = await service.get();
    expect(view.version).toBe(1);
    expect(view.rules).toEqual(aiAdvisorDefaultRules());
    expect(view.updated_at).toBeNull();
    expect(view.updated_by).toBeNull();
    expect(view.telegram).toBeNull();
    expect(view.limits.rules.R1.shortage_uzs.default).toBe(50000);
  });

  it('PATCH: version+1, saqlanadi, audit eski → yangi; keyingi GET shuni beradi', async () => {
    const out = await service.update(SA, {
      version: 1,
      rules: { R1: { shortage_uzs: 200000 }, R8: { enabled: false } },
    });
    expect(out.version).toBe(2);
    expect(out.rules.R1.shortage_uzs).toBe(200000);
    expect(out.rules.R8.enabled).toBe(false);
    expect(out.updated_by).toEqual({ id: '1', name: 'Test Superadmin' });
    expect(out.updated_at).toEqual(expect.any(String));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      action: 'ai.advisor.settings.update',
      entity_type: 'ai_advisor_settings',
      entity_id: 'rules',
      old_value: { R1: { shortage_uzs: 50000 }, R8: { enabled: true } },
      new_value: { R1: { shortage_uzs: 200000 }, R8: { enabled: false } },
      user_id: '1',
      metadata: { version: 2, changes: 2 },
    });
    expect(await service.get()).toEqual(out);
    expect((await service.getRules()).R1.shortage_uzs).toBe(200000);
    // severity saqlanmaydi — doim kodda.
    const [row] = await ds.query<
      Array<{ value: Record<string, Record<string, unknown>> }>
    >(`SELECT value FROM ai_schema.ai_advisor_settings WHERE key = 'rules'`);
    expect(row.value.R1.severity).toBeUndefined();
  });

  it('eskirgan version → 409 AI_ADVISOR_SETTINGS_CONFLICT {version}', async () => {
    await service.update(SA, {
      version: 1,
      rules: { R1: { shortage_uzs: 1000 } },
    });
    const err = await service
      .update(SA, { version: 1, rules: { R1: { shortage_uzs: 2000 } } })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toMatchObject({
      statusCode: 409,
      code: 'AI_ADVISOR_SETTINGS_CONFLICT',
      version: 2,
    });
    expect((await service.getRules()).R1.shortage_uzs).toBe(1000);
  });

  it('parallel ikki PATCH (ayni version): aynan bittasi o‘tadi, ikkinchisi 409', async () => {
    const results = await Promise.allSettled([
      service.update(SA, { version: 1, rules: { R1: { shortage_uzs: 111 } } }),
      service.update(SA, { version: 1, rules: { R1: { shortage_uzs: 222 } } }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(codeOf(failed[0].reason).code).toBe('AI_ADVISOR_SETTINGS_CONFLICT');
    expect((await service.get()).version).toBe(2);
  });

  it('o‘zgarishsiz PATCH: version oshmaydi, audit yo‘q', async () => {
    const out = await service.update(SA, {
      version: 1,
      rules: { R1: { shortage_uzs: 50000 } },
    });
    expect(out.version).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('noto‘g‘ri tana: hech narsa yozilmaydi (hammasi yoki hech narsa)', async () => {
    const err = await service
      .update(SA, {
        version: 1,
        rules: { R1: { shortage_uzs: 1000 }, R2: { growth_days: 0 } },
      })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toMatchObject({
      code: 'AI_ADVISOR_INVALID_RULE',
      field: 'rules.R2.growth_days',
    });
    expect((await service.getRules()).R1.shortage_uzs).toBe(50000);
  });

  describe('ai_advisor_alerts indekslari', () => {
    beforeEach(async () => {
      await ds.query('DELETE FROM ai_schema.ai_advisor_alerts');
    });

    const insertAlert = (status: string) =>
      ds.query<Array<{ id: string }>>(
        `INSERT INTO ai_schema.ai_advisor_alerts (rule_key, severity, status, dedup_key)
         VALUES ('R1', 'warning', $1, 'R1:cashbox:7') RETURNING id`,
        [status],
      );

    it('bitta dedup_key uchun faqat bitta ochiq (new/seen); yopilganlar cheklanmaydi', async () => {
      await insertAlert('resolved');
      await insertAlert('dismissed');
      await insertAlert('new');
      await expect(insertAlert('seen')).rejects.toThrow(
        /UQ_AI_ADVISOR_ALERT_OPEN_DEDUP/,
      );
    });

    it('takror: (dedup_key, fact_key) yagona; CHECK cheklovlari', async () => {
      const [{ id }] = await insertAlert('new');
      const occ = () =>
        ds.query(
          `INSERT INTO ai_schema.ai_advisor_alert_occurrences (alert_id, dedup_key, fact_key)
           VALUES ($1, 'R1:cashbox:7', '806')`,
          [id],
        );
      await occ();
      await expect(occ()).rejects.toThrow(/UQ_AI_ADVISOR_OCC_DEDUP_FACT/);
      await expect(
        ds.query(
          `INSERT INTO ai_schema.ai_advisor_alerts (rule_key, severity, status, dedup_key)
           VALUES ('R9', 'warning', 'new', 'x')`,
        ),
      ).rejects.toThrow(/CHK_AI_ADVISOR_ALERT_RULE/);
    });
  });
});
