import { DataSource } from 'typeorm';
import {
  ActivityLog,
  ActivityLogService,
  SecretCipher,
  fingerprintOf,
} from '@app/common';
import { CreateAiSchema1716000000047 } from '../../../../migrations/1716000000047-CreateAiSchema';
import { AiProviderKeysAndRuntimeSettings1716000000228 } from '../../../../migrations/1716000000228-AiProviderKeysAndRuntimeSettings';
import type { AiConfigEnv } from './ai-config-env';
import type { AiConfigDeadline } from './ai-config-deadline';
import { AiConfigHistoryService } from './ai-config-history.service';
import { AiConfigViewService } from './ai-config-view.service';
import { AiKeyEnvelopeService } from './ai-key-envelope.service';
import { AiKeyStoreService } from './ai-key-store.service';
import type {
  AiKeyVerifierService,
  AiKeyVerifyResult,
} from './ai-key-verifier.service';
import { readAnthropicKey } from './ai-key-reader';
import { FAKE_KEY, FAKE_KEY_2, sealForTest } from './ai-config-test-helpers';

/**
 * be-brief §12 ai-key-store.pg.spec — haqiqiy Postgres (o'z vaqtinchalik
 * bazasi). `AI_CONFIG_PG_TEST_URI` (yoki `AI_ADVISOR_PG_TEST_URI`) faqat
 * lokal host. Hamma kalit soxta; Anthropic chaqirilmaydi (verifier soxta).
 */
const ADMIN_URI =
  process.env.AI_CONFIG_PG_TEST_URI ?? process.env.AI_ADVISOR_PG_TEST_URI;
const describePg = ADMIN_URI ? describe : describe.skip;

function tempDbUri(admin: string, name: string): string {
  const url = new URL(admin);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname))
    throw new Error(
      'AI_CONFIG_PG_TEST_URI faqat lokal Postgres bo‘lishi kerak',
    );
  url.pathname = `/${name}`;
  return url.toString();
}

const MASTER = 'Q7v9zK2pL4mX8nB1cR6tY3wE5uI0oP-aSdFgHjKl';
const OTHER_MASTER = 'P0o9I8u7Y6t5R4e3W2q1A-sDfGhJkLzXcVbNm12';
const FAKE_KEY_3 = 'sk-ant-api03-' + 'z'.repeat(40);
const SA = { id: '7', roles: ['superadmin'], name: 'Ega' };
const MODELS = [
  {
    id: 'claude-sonnet-5-5',
    display_name: 'S',
    created_at: null,
    max_input_tokens: null,
    max_tokens: null,
    capabilities: null,
  },
];

const okDeadline = (): AiConfigDeadline => ({
  sentAt: Date.now(),
  verifyTimeoutMs: () => 5000,
  canCommit: () => true,
});

describePg('AiKeyStoreService — real Postgres', () => {
  const dbName = `elchi_ai_config_${process.pid}_${Date.now()}`;
  let admin: DataSource;
  let ds: DataSource;
  let store: AiKeyStoreService;
  let view: AiConfigViewService;
  let history: AiConfigHistoryService;
  let envelope: AiKeyEnvelopeService;
  let activity: ActivityLogService;
  let verifyResult: AiKeyVerifyResult;
  const verify = jest.fn(() => Promise.resolve(verifyResult));
  const env = {
    cipher: new SecretCipher({ primary: MASTER }),
    appEnv: 'staging',
    uiEnabled: true,
    policyStrict: false,
    stagingAiDisabled: false,
    envKey: null as string | null,
    num: (_n: string, f: number) => f,
    str: () => null,
    access: () => ({
      appEnv: 'staging',
      uiEnabled: true,
      sigSecret: 's'.repeat(40),
      configQueue: 'ai_config_queue',
      writerIds: ['7'],
      stepUpRequired: false,
      masterKeyConfigured: true,
    }),
  } as unknown as AiConfigEnv & { envKey: string | null; cipher: SecretCipher };

  async function sealed(key: string) {
    return sealForTest(envelope.view(), { api_key: key, uid: '7' });
  }
  async function version() {
    return store.keysVersion();
  }
  async function setKey(key: string, extra: Record<string, unknown> = {}) {
    return store.set(
      SA,
      { key_envelope: await sealed(key), version: await version(), ...extra },
      okDeadline(),
    );
  }
  const keyRows = () =>
    ds.query<
      { status: string; fingerprint: string; secret_enc: string | null }[]
    >(
      `SELECT "status", "fingerprint", "secret_enc" FROM ai_schema.ai_provider_keys ORDER BY "createdAt"`,
    );
  const auditRows = () =>
    ds.query<
      {
        action: string;
        old_value: unknown;
        new_value: unknown;
        metadata: unknown;
        description: string;
      }[]
    >(
      `SELECT action, old_value, new_value, metadata, description FROM ai_schema.activity_logs ORDER BY id`,
    );

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: ADMIN_URI });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    ds = new DataSource({
      type: 'postgres',
      url: tempDbUri(ADMIN_URI as string, dbName),
      schema: 'ai_schema',
      entities: [ActivityLog],
      synchronize: false,
    });
    await ds.initialize();
    const qr = ds.createQueryRunner();
    try {
      await new CreateAiSchema1716000000047().up(qr);
      await qr.query(
        `ALTER TABLE ai_schema.activity_logs ADD COLUMN IF NOT EXISTS "description" text`,
      );
      const m = new AiProviderKeysAndRuntimeSettings1716000000228();
      await m.up(qr);
      await m.up(qr); // idempotent
      await m.down(qr);
      await m.up(qr);
    } finally {
      await qr.release();
    }
    envelope = new AiKeyEnvelopeService();
    activity = new ActivityLogService(
      ds.getRepository(ActivityLog),
      'ai-service',
    );
    store = new AiKeyStoreService(ds, activity, env, envelope, {
      verify,
    } as unknown as AiKeyVerifierService);
    view = new AiConfigViewService(ds, env, envelope);
    history = new AiConfigHistoryService(ds);
  });

  beforeEach(async () => {
    verifyResult = { ok: true, models: MODELS };
    verify.mockClear();
    env.envKey = null;
    await ds.query('DELETE FROM ai_schema.ai_provider_keys');
    await ds.query('DELETE FROM ai_schema.ai_runtime_settings');
    await ds.query('DELETE FROM ai_schema.ai_config_attempts');
    await ds.query('DELETE FROM ai_schema.activity_logs');
  });

  afterAll(async () => {
    await ds?.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.destroy();
    }
  });

  it('migratsiya: ai_usage_log ustunlari qo‘shilgan', async () => {
    const cols = await ds.query<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'ai_schema' AND table_name = 'ai_usage_log'
          AND column_name IN ('key_id','key_source','key_fingerprint','config_version')`,
    );
    expect(cols).toHaveLength(4);
  });

  it('add → replace → replace: active/previous/retired, versiya, audit, shifrmatn', async () => {
    expect(await setKey(FAKE_KEY, { label: 'Staging' })).toEqual({ ok: true });
    let rows = await keyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].secret_enc).toMatch(/^enc:gcm:v1:/);
    expect(rows[0].fingerprint).toBe(fingerprintOf(FAKE_KEY));
    expect(await version()).toBe(2);

    expect(await setKey(FAKE_KEY_2)).toEqual({ ok: true });
    expect(await setKey(FAKE_KEY_3)).toEqual({ ok: true });
    rows = await keyRows();
    expect(rows.map((r) => r.status)).toEqual([
      'retired',
      'previous',
      'active',
    ]);
    expect(rows[0].secret_enc).toBeNull();
    expect(await version()).toBe(4);
    expect((await auditRows()).map((a) => a.action)).toEqual([
      'ai.key.add',
      'ai.key.replace',
      'ai.key.replace',
    ]);

    // Pilot/runtime o'quvchisi: faol kalit ochiladi, previous id bo'yicha.
    const read = await readAnthropicKey(ds.manager, env.cipher, 'staging');
    expect(read?.key).toBe(FAKE_KEY_3);
    const v = (await view.build('7')) as any;
    expect(v.key.effective_source).toBe('ui');
    expect(v.key.active.readable).toBe(true);
    expect(v.key.active.verify.state).toBe('ok');
    expect(v.key.previous.hint).toBe('sk-ant-…yyyy');
    expect(v.version.key).toBe(4);
    expect(v.catalog.usable).toBe(true);
    expect(v.key_wrap.kid).toBe(envelope.kid);
  });

  it('bir xil kalit → AI_KEY_SAME; eski versiya → 409 {version}', async () => {
    await setKey(FAKE_KEY);
    const same = await setKey(FAKE_KEY);
    expect(same).toMatchObject({
      ok: false,
      error: { code: 'AI_KEY_SAME', statusCode: 409 },
    });
    const stale = await store.set(
      SA,
      { key_envelope: await sealed(FAKE_KEY_2), version: 1 },
      okDeadline(),
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'AI_CONFIG_CONFLICT', statusCode: 409, version: 2 },
    });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('Anthropic rad etdi → 422, hech narsa saqlanmaydi, urinish va attempt_rejected yoziladi', async () => {
    verifyResult = { ok: false, code: 'AI_KEY_REJECTED', state: 'rejected' };
    const r = await setKey(FAKE_KEY);
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'AI_KEY_REJECTED', statusCode: 422 },
    });
    expect(await keyRows()).toHaveLength(0);
    expect(await version()).toBe(1);
    const att = await ds.query(`SELECT * FROM ai_schema.ai_config_attempts`);
    expect(att).toHaveLength(1);
    const audit = await auditRows();
    expect(audit.map((a) => a.action)).toEqual(['ai.key.attempt_rejected']);
    expect(audit[0].metadata).toMatchObject({
      fingerprint: fingerprintOf(FAKE_KEY),
      error_code: 'AI_KEY_REJECTED',
    });
  });

  it('format / admin / oauth / label’da kalit — tarmoqsiz 400', async () => {
    for (const [key, code] of [
      ['sk-ant-admin01-' + 'x'.repeat(40), 'AI_KEY_ADMIN_KEY'],
      ['sk-ant-oat01-' + 'x'.repeat(40), 'AI_KEY_OAUTH_TOKEN'],
      ['sk-ant-' + 'ж'.repeat(40), 'AI_KEY_FORMAT'],
    ] as const) {
      expect(await setKey(key)).toMatchObject({ ok: false, error: { code } });
    }
    expect(await setKey(FAKE_KEY, { label: 'sk-ant-api03-xyz' })).toMatchObject(
      {
        ok: false,
        error: { code: 'AI_CONFIG_INVALID', field: 'label' },
      },
    );
    expect(verify).not.toHaveBeenCalled();
    expect(await keyRows()).toHaveLength(0);
  });

  it('audit INSERT xatosi → butun o‘zgarish orqaga qaytadi (D15)', async () => {
    const spy = jest
      .spyOn(activity, 'logWithin')
      .mockRejectedValueOnce(new Error('audit down'));
    await expect(setKey(FAKE_KEY)).rejects.toThrow('audit down');
    spy.mockRestore();
    expect(await keyRows()).toHaveLength(0);
    expect(await version()).toBe(1);
  });

  it('6.5 s dan keyin COMMIT → AI_CONFIG_EXPIRED, hech narsa saqlanmaydi', async () => {
    const r = await store.set(
      SA,
      { key_envelope: await sealed(FAKE_KEY), version: 1 },
      { ...okDeadline(), canCommit: () => false },
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'AI_CONFIG_EXPIRED', statusCode: 503 },
    });
    expect(await keyRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('restore: oldingisi qayta tekshirilib almashadi; deactivate; forget', async () => {
    await setKey(FAKE_KEY);
    await setKey(FAKE_KEY_2);
    expect(
      await store.restore(SA, { version: await version() }, okDeadline()),
    ).toEqual({ ok: true });
    let rows = await keyRows();
    const byFp = (k: string) =>
      rows.find((r) => r.fingerprint === fingerprintOf(k))!.status;
    expect(byFp(FAKE_KEY)).toBe('active');
    expect(byFp(FAKE_KEY_2)).toBe('previous');

    expect(
      await store.deactivate(
        SA,
        { version: await version(), reason: 'test' },
        okDeadline(),
      ),
    ).toEqual({ ok: true });
    rows = await keyRows();
    expect(byFp(FAKE_KEY)).toBe('previous');
    expect(byFp(FAKE_KEY_2)).toBe('retired');
    const v = (await view.build('7')) as any;
    expect(v.key.active).toBeNull();
    expect(v.key.effective_source).toBe('none');
    expect(v.runtime.disabled_reason).toBe('no_key');

    expect(
      await store.forgetPrevious(
        SA,
        { version: await version() },
        okDeadline(),
      ),
    ).toEqual({ ok: true });
    rows = await keyRows();
    expect(
      rows.every((r) => r.status === 'retired' && r.secret_enc === null),
    ).toBe(true);
    expect(
      await store.forgetPrevious(
        SA,
        { version: await version() },
        okDeadline(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'AI_KEY_NO_PREVIOUS', statusCode: 404 },
    });
    expect(
      await store.deactivate(SA, { version: await version() }, okDeadline()),
    ).toMatchObject({
      ok: false,
      error: { code: 'AI_KEY_NONE' },
    });
    expect((await auditRows()).map((a) => a.action)).toEqual([
      'ai.key.add',
      'ai.key.replace',
      'ai.key.restore',
      'ai.key.deactivate',
      'ai.key.forget',
    ]);
  });

  it('restore: oldingisi rad etilsa hech narsa o‘zgarmaydi', async () => {
    await setKey(FAKE_KEY);
    await setKey(FAKE_KEY_2);
    verifyResult = { ok: false, code: 'AI_KEY_BILLING', state: 'billing' };
    const before = await keyRows();
    expect(
      await store.restore(SA, { version: await version() }, okDeadline()),
    ).toMatchObject({
      ok: false,
      error: { code: 'AI_KEY_BILLING' },
    });
    expect(await keyRows()).toEqual(before);
  });

  it('verify: UI kaliti holati saqlanadi (200 data), versiya oshmaydi; env kaliti — env_key_check', async () => {
    await setKey(FAKE_KEY);
    const v0 = await version();
    verifyResult = { ok: false, code: 'AI_KEY_BILLING', state: 'billing' };
    expect(await store.verifyInUse(SA, okDeadline())).toEqual({ ok: true });
    expect(await version()).toBe(v0);
    let v = (await view.build('7')) as any;
    expect(v.key.active.verify).toMatchObject({
      state: 'billing',
      error_code: 'AI_KEY_BILLING',
    });
    expect(v.key.warnings).toContain('ui_key_billing');
    expect(v.key.effective_source).toBe('none');
    expect(v.runtime.disabled_reason).toBe('key_billing');

    // Env kaliti (UI kaliti yo'q).
    await store.deactivate(SA, { version: await version() }, okDeadline());
    env.envKey = FAKE_KEY_2;
    verifyResult = { ok: true, models: MODELS };
    expect(await store.verifyInUse(SA, okDeadline())).toEqual({ ok: true });
    v = (await view.build('7')) as any;
    expect(v.key.effective_source).toBe('env');
    expect(v.key.env).toMatchObject({
      present: true,
      hint: 'sk-ant-…yyyy',
      fingerprint: fingerprintOf(FAKE_KEY_2),
      verify: { state: 'ok', origin: 'verify' },
    });
    env.envKey = null;
    expect(await store.verifyInUse(SA, okDeadline())).toMatchObject({
      ok: false,
      error: { code: 'AI_KEY_NONE' },
    });
  });

  it('ochib bo‘lmaydigan kalit: readable=false, AI o‘chiq (env’ga O‘TMAYDI), deactivate master’siz ishlaydi', async () => {
    await setKey(FAKE_KEY);
    env.envKey = FAKE_KEY_2;
    const original = env.cipher;
    (env as any).cipher = new SecretCipher({ primary: OTHER_MASTER });
    try {
      const v = (await view.build('7')) as any;
      expect(v.key.active.readable).toBe(false);
      expect(v.key.warnings).toContain('ui_key_unreadable');
      expect(v.key.effective_source).toBe('none');
      expect(v.runtime.disabled_reason).toBe('key_unreadable');
      (env as any).cipher = new SecretCipher({ primary: null });
      expect(
        await store.deactivate(SA, { version: await version() }, okDeadline()),
      ).toEqual({ ok: true });
      const after = (await view.build('7')) as any;
      expect(after.key.effective_source).toBe('env');
    } finally {
      (env as any).cipher = original;
    }
  });

  it('rotatsiya: previous master bilan shifrlangan — rotation_pending', async () => {
    const original = env.cipher;
    (env as any).cipher = new SecretCipher({ primary: OTHER_MASTER });
    try {
      await setKey(FAKE_KEY);
    } finally {
      (env as any).cipher = new SecretCipher({
        primary: MASTER,
        previous: OTHER_MASTER,
      });
    }
    const v = (await view.build('7')) as any;
    expect(v.master_key).toEqual({ configured: true, rotation_pending: 1 });
    expect(v.key.active.readable).toBe(true);
    // Boot: qayta shifrlash → rotation_pending 0, audit ai.key.reencrypt.
    await store.onApplicationBootstrap();
    const after = (await view.build('7')) as any;
    expect(after.master_key.rotation_pending).toBe(0);
    expect((await auditRows()).map((a) => a.action)).toContain(
      'ai.key.reencrypt',
    );
    // Endi faqat yangi master bilan ham ochiladi.
    (env as any).cipher = new SecretCipher({ primary: MASTER });
    expect(
      (await readAnthropicKey(ds.manager, env.cipher, 'staging'))?.key,
    ).toBe(FAKE_KEY);
    (env as any).cipher = original;
  });

  it('cheklov: daqiqasiga 5 urinish, 6-chisi → 429 retry_after', async () => {
    verifyResult = { ok: false, code: 'AI_KEY_REJECTED', state: 'rejected' };
    for (let i = 0; i < 5; i++) await setKey(FAKE_KEY);
    const r = await setKey(FAKE_KEY);
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'AI_KEY_ATTEMPTS_EXCEEDED', statusCode: 429 },
    });
    expect((r as any).error.retry_after_seconds).toBeGreaterThan(0);
    expect(verify).toHaveBeenCalledTimes(5);
  });

  it('indekslar: ikkinchi active va secret’li retired rad etiladi', async () => {
    await setKey(FAKE_KEY);
    await expect(
      ds.query(
        `INSERT INTO ai_schema.ai_provider_keys ("id","status","secret_enc","key_hint","fingerprint","created_by")
         VALUES (gen_random_uuid(),'active','enc:gcm:v1:x','aaaa','f','7')`,
      ),
    ).rejects.toThrow(/UQ_AIKEY_ACTIVE/);
    await expect(
      ds.query(
        `INSERT INTO ai_schema.ai_provider_keys ("id","status","secret_enc","key_hint","fingerprint","created_by")
         VALUES (gen_random_uuid(),'retired','enc:gcm:v1:x','aaaa','f','7')`,
      ),
    ).rejects.toThrow(/CK_AIKEY_SECRET/);
  });

  it('tarix: eng yangisi tepada, kursor bilan', async () => {
    await setKey(FAKE_KEY);
    await setKey(FAKE_KEY_2);
    await store.deactivate(
      SA,
      { version: await version(), reason: 'sinov' },
      okDeadline(),
    );
    const p1 = await history.page({ limit: 2 });
    expect(p1.items.map((i) => i.action)).toEqual([
      'ai.key.deactivate',
      'ai.key.replace',
    ]);
    expect(p1.items[0]).toMatchObject({
      actor: { id: '7', name: 'Ega' },
      reason: 'sinov',
      details: { key_from: { hint: 'sk-ant-…yyyy' } },
    });
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await history.page({ limit: 2, cursor: p1.next_cursor });
    expect(p2.items.map((i) => i.action)).toEqual(['ai.key.add']);
    expect(p2.next_cursor).toBeNull();
  });

  it('SERIALIZATSIYA QO‘RIG‘I: javob, audit va tarixda kalit, shifrmatn va konvert yo‘q', async () => {
    const envs: unknown[] = [];
    for (const k of [FAKE_KEY, FAKE_KEY_2]) {
      const e = await sealed(k);
      envs.push(e);
      await store.set(
        SA,
        { key_envelope: e, version: await version() },
        okDeadline(),
      );
    }
    verifyResult = { ok: false, code: 'AI_KEY_REJECTED', state: 'rejected' };
    await setKey(FAKE_KEY_3);
    verifyResult = { ok: true, models: MODELS };
    await store.restore(SA, { version: await version() }, okDeadline());
    await store.verifyInUse(SA, okDeadline());
    const secrets = (
      await ds.query<{ secret_enc: string }[]>(
        `SELECT secret_enc FROM ai_schema.ai_provider_keys WHERE secret_enc IS NOT NULL`,
      )
    ).map((r) => r.secret_enc);
    const dump = JSON.stringify([
      await view.build('7'),
      await auditRows(),
      await history.page({ limit: 50 }),
    ]);
    for (const k of [FAKE_KEY, FAKE_KEY_2, FAKE_KEY_3]) {
      expect(dump).not.toContain(k);
      expect(dump).not.toContain(k.slice(13));
    }
    for (const s of secrets) expect(dump).not.toContain(s.split(':').pop()!);
    for (const e of envs) expect(dump).not.toContain((e as { ct: string }).ct);
    expect(dump).not.toContain('secret_enc');
    expect(dump).not.toContain('enc:gcm');
  });
});
