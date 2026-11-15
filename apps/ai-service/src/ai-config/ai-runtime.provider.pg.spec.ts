import { Logger } from '@nestjs/common';
import {
  APIError,
  AuthenticationError,
  PermissionDeniedError,
} from '@anthropic-ai/sdk';
import { DataSource } from 'typeorm';
import {
  ActivityLog,
  ActivityLogService,
  SecretCipher,
  fingerprintOf,
  type AnthropicClientLike,
} from '@app/common';
import { CreateAiSchema1716000000047 } from '../../../../migrations/1716000000047-CreateAiSchema';
import { AiProviderKeysAndRuntimeSettings1716000000228 } from '../../../../migrations/1716000000228-AiProviderKeysAndRuntimeSettings';
import type { AiConfigEnv } from './ai-config-env';
import type { AiConfigDeadline } from './ai-config-deadline';
import type { AiConfigNotifier } from './ai-config.notifier';
import { AiKeyEnvelopeService } from './ai-key-envelope.service';
import { AiKeyStoreService } from './ai-key-store.service';
import type {
  AiKeyVerifierService,
  AiKeyVerifyResult,
} from './ai-key-verifier.service';
import { AiRuntimeProvider } from './ai-runtime.provider';
import { FAKE_KEY, FAKE_KEY_2, sealForTest } from './ai-config-test-helpers';

/**
 * be-brief §12 ai-runtime.provider.spec + ai-call-failure.spec — haqiqiy
 * Postgres. Anthropic chaqirilmaydi (mijoz soxta, verifier soxta).
 */
const ADMIN_URI =
  process.env.AI_CONFIG_PG_TEST_URI ?? process.env.AI_ADVISOR_PG_TEST_URI;
const describePg = ADMIN_URI ? describe : describe.skip;
const MASTER = 'Q7v9zK2pL4mX8nB1cR6tY3wE5uI0oP-aSdFgHjKl';
const OTHER = 'P0o9I8u7Y6t5R4e3W2q1A-sDfGhJkLzXcVbNm12';
const ENV_KEY = 'sk-ant-api03-' + 'e'.repeat(40);
const SA = { id: '7', roles: ['superadmin'], name: 'Ega' };
const ok = (): AiConfigDeadline => ({
  sentAt: Date.now(),
  verifyTimeoutMs: () => 5000,
  canCommit: () => true,
});

const err = (status: number, type: string): APIError =>
  APIError.generate(
    status,
    { type: 'error', error: { type, message: 'm' } },
    'm',
    new Headers(),
  );

describePg('AiRuntimeProvider — real Postgres', () => {
  const dbName = `elchi_ai_runtime_${process.pid}_${Date.now()}`;
  let admin: DataSource;
  let ds: DataSource;
  let store: AiKeyStoreService;
  let envelope: AiKeyEnvelopeService;
  let activity: ActivityLogService;
  let verifyResult: AiKeyVerifyResult;
  const verify = jest.fn(() => Promise.resolve(verifyResult));
  const notify = jest.fn(() => Promise.resolve());
  const built: string[] = [];
  const factory = (o: { apiKey: string }) => {
    built.push(fingerprintOf(o.apiKey));
    return {
      messages: { create: jest.fn() },
    } as unknown as AnthropicClientLike;
  };
  const env = {
    cipher: new SecretCipher({ primary: MASTER }),
    appEnv: 'staging',
    uiEnabled: true,
    envKey: ENV_KEY as string | null,
    stagingAiDisabled: false,
    access: () => ({}),
  } as unknown as AiConfigEnv & {
    uiEnabled: boolean;
    envKey: string | null;
    cipher: SecretCipher;
  };

  const make = () =>
    new AiRuntimeProvider(
      ds,
      env,
      store,
      activity,
      { verify } as unknown as AiKeyVerifierService,
      { notify } as unknown as AiConfigNotifier,
      factory,
    );
  const setKey = async (key: string) =>
    store.set(
      SA,
      {
        key_envelope: await sealForTest(envelope.view(), {
          api_key: key,
          uid: '7',
        }),
        version: await store.keysVersion(),
      },
      ok(),
    );
  const actions = async () =>
    (
      await ds.query<{ action: string }[]>(
        'SELECT action FROM ai_schema.activity_logs ORDER BY id',
      )
    ).map((r) => r.action);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    admin = new DataSource({ type: 'postgres', url: ADMIN_URI });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(ADMIN_URI as string);
    url.pathname = `/${dbName}`;
    ds = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'ai_schema',
      entities: [ActivityLog],
    });
    await ds.initialize();
    const qr = ds.createQueryRunner();
    await new CreateAiSchema1716000000047().up(qr);
    await qr.query(
      `ALTER TABLE ai_schema.activity_logs ADD COLUMN IF NOT EXISTS "description" text`,
    );
    await new AiProviderKeysAndRuntimeSettings1716000000228().up(qr);
    await qr.release();
    envelope = new AiKeyEnvelopeService();
    activity = new ActivityLogService(
      ds.getRepository(ActivityLog),
      'ai-service',
    );
    store = new AiKeyStoreService(ds, activity, env, envelope, {
      verify,
    } as unknown as AiKeyVerifierService);
  });

  beforeEach(async () => {
    verifyResult = { ok: true, models: [] };
    verify.mockClear();
    notify.mockClear();
    built.length = 0;
    env.uiEnabled = true;
    env.envKey = ENV_KEY;
    (env as { cipher: SecretCipher }).cipher = new SecretCipher({
      primary: MASTER,
    });
    for (const t of [
      'ai_provider_keys',
      'ai_runtime_settings',
      'ai_config_attempts',
      'activity_logs',
    ])
      await ds.query(`DELETE FROM ai_schema.${t}`);
  });

  afterAll(async () => {
    await ds?.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.destroy();
    }
    jest.restoreAllMocks();
  });

  it('flag o‘chiq: faqat env, DB UMUMAN o‘qilmaydi (D12)', async () => {
    await setKey(FAKE_KEY);
    env.uiEnabled = false;
    const spy = jest.spyOn(ds, 'query');
    const p = make();
    await p.onModuleInit();
    const l = p.acquire();
    p.reportCallFailure(l!, 'order_extract_multi', err(402, 'billing_error'));
    await p.refresh();
    expect(l).toMatchObject({
      source: 'env',
      keyId: null,
      fingerprint: fingerprintOf(ENV_KEY),
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    p.onModuleDestroy();
  });

  it('ustuvorlik: UI > env; UI o‘chirilsa — env darhol (store.onChange)', async () => {
    const p = make();
    await p.onModuleInit();
    expect(p.acquire()?.source).toBe('env');
    await setKey(FAKE_KEY);
    await p.refresh();
    const l = p.acquire();
    expect(l).toMatchObject({
      source: 'ui',
      fingerprint: fingerprintOf(FAKE_KEY),
    });
    expect(l?.keyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.status()).toMatchObject({
      source: 'ui',
      disabledReason: null,
      configStale: false,
    });
    await store.deactivate(SA, { version: await store.keysVersion() }, ok());
    await p.refresh();
    expect(p.acquire()?.source).toBe('env');
    p.onModuleDestroy();
  });

  it('UI kaliti ochilmaydi → AI o‘chiq (env’ga O‘TMAYDI), audit bir marta', async () => {
    await setKey(FAKE_KEY);
    (env as { cipher: SecretCipher }).cipher = new SecretCipher({
      primary: OTHER,
    });
    const p = make();
    await p.onModuleInit();
    await p.refresh();
    await new Promise((r) => setTimeout(r, 50));
    expect(p.acquire()).toBeNull();
    expect(p.status()).toMatchObject({
      source: 'none',
      disabledReason: 'key_unreadable',
    });
    expect(
      (await actions()).filter((a) => a === 'ai.key.unreadable'),
    ).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai.key.unreadable' }),
    );
    p.onModuleDestroy();
  });

  it('DB xatosi: oxirgi ma’lum holat ishlaydi, config_stale; boot’da yo‘q → AI o‘chiq', async () => {
    await setKey(FAKE_KEY);
    const p = make();
    await p.onModuleInit();
    const spy = jest.spyOn(ds, 'query').mockRejectedValue(new Error('db down'));
    await setKey(FAKE_KEY_2).catch(() => undefined);
    // Imzo o'zgarishi uchun majburiy yangilash.
    await (p as unknown as { doRefresh(): Promise<void> }).doRefresh();
    expect(p.acquire()?.fingerprint).toBe(fingerprintOf(FAKE_KEY));
    expect(p.status().configStale).toBe(true);
    const fresh = make();
    await fresh.onModuleInit();
    expect(fresh.acquire()).toBeNull();
    expect(fresh.status()).toMatchObject({
      disabledReason: 'config_stale',
      configStale: true,
    });
    spy.mockRestore();
    p.onModuleDestroy();
    fresh.onModuleDestroy();
  });

  it('runtime 402 → billing, AI o‘chiq, bitta audit + inbox; takror — jim; verify ok tozalaydi', async () => {
    await setKey(FAKE_KEY);
    const p = make();
    await p.onModuleInit();
    const l = p.acquire()!;
    await p.markKey(l, 'billing', 'AI_KEY_BILLING');
    await p.markKey(l, 'billing', 'AI_KEY_BILLING');
    expect(p.acquire()).toBeNull();
    expect(p.status()).toMatchObject({
      disabledReason: 'key_billing',
      verifyState: 'billing',
    });
    expect(
      (await actions()).filter((a) => a === 'ai.key.runtime_failure'),
    ).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ai.key.runtime_failure',
        detail: 'AI_KEY_BILLING',
      }),
    );
    // «Qayta tekshirish» ok → tiklanadi.
    await store.verifyInUse(SA, ok());
    await p.refresh();
    expect(p.acquire()?.source).toBe('ui');
    p.onModuleDestroy();
  });

  it('401: bitta "blip" (tasdiq ok) — o‘zgarish yo‘q; tasdiqlangan 401 — rejected', async () => {
    await setKey(FAKE_KEY);
    const p = make();
    await p.onModuleInit();
    verify.mockClear(); // setKey'ning o'z tekshiruvi hisobga olinmaydi
    const l = p.acquire()!;
    const e401 = new AuthenticationError(
      401,
      { type: 'error' },
      'x',
      new Headers(),
    );
    p.reportCallFailure(l, 'order_extract_multi', e401);
    await new Promise((r) => setTimeout(r, 50));
    expect(verify).toHaveBeenCalledWith(FAKE_KEY, 5000);
    expect(p.acquire()?.source).toBe('ui');
    // 60 s ichida qayta tasdiq yo'q.
    p.reportCallFailure(l, 'order_extract_multi', e401);
    expect(verify).toHaveBeenCalledTimes(1);
    // Yangi provayder (vaqt oynasi yangi) — tasdiq 401.
    const p2 = make();
    await p2.onModuleInit();
    verifyResult = { ok: false, code: 'AI_KEY_REJECTED', state: 'rejected' };
    p2.reportCallFailure(p2.acquire()!, 'order_extract_multi', e401);
    await new Promise((r) => setTimeout(r, 100));
    expect(p2.acquire()).toBeNull();
    expect(p2.status().disabledReason).toBe('key_rejected');
    p.onModuleDestroy();
    p2.onModuleDestroy();
  });

  it('almashtirishdan keyin ESKI kalit lease’idagi 403 YANGI kalitga tegmaydi', async () => {
    await setKey(FAKE_KEY);
    const p = make();
    await p.onModuleInit();
    const oldLease = p.acquire()!;
    await setKey(FAKE_KEY_2);
    await p.refresh();
    p.reportCallFailure(
      oldLease,
      'order_extract_multi',
      new PermissionDeniedError(403, {}, 'x', new Headers()),
    );
    await new Promise((r) => setTimeout(r, 100));
    const rows = await ds.query<
      { fingerprint: string; status: string; verify_state: string }[]
    >(
      'SELECT fingerprint, status, verify_state FROM ai_schema.ai_provider_keys',
    );
    expect(
      rows.find((r) => r.fingerprint === fingerprintOf(FAKE_KEY)),
    ).toMatchObject({ status: 'previous', verify_state: 'forbidden' });
    expect(
      rows.find((r) => r.fingerprint === fingerprintOf(FAKE_KEY_2)),
    ).toMatchObject({ status: 'active', verify_state: 'ok' });
    expect(p.acquire()?.fingerprint).toBe(fingerprintOf(FAKE_KEY_2));
    p.onModuleDestroy();
  });

  it('env lease → env_key_check; 404 not_found → slot model_unavailable', async () => {
    const p = make();
    await p.onModuleInit();
    const l = p.acquire()!;
    expect(l.source).toBe('env');
    p.reportCallFailure(l, 'order_extract_multi', err(403, 'permission_error'));
    await new Promise((r) => setTimeout(r, 100));
    const s = await ds.query<{ value: Record<string, unknown> }[]>(
      `SELECT value FROM ai_schema.ai_runtime_settings WHERE key = 'env_key_check'`,
    );
    expect(s[0].value).toMatchObject({
      fingerprint: fingerprintOf(ENV_KEY),
      state: 'forbidden',
      origin: 'runtime',
    });
    expect(p.acquire()).toBeNull();
    expect(p.status().disabledReason).toBe('key_forbidden');

    const p2 = make();
    await ds.query('DELETE FROM ai_schema.ai_runtime_settings');
    await p2.onModuleInit();
    p2.reportCallFailure(
      p2.acquire()!,
      'order_extract_image',
      err(404, 'not_found_error'),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(p2.status().unavailableSlots).toEqual(['vision']);
    expect(await actions()).toContain('ai.models.unavailable');
    p.onModuleDestroy();
    p2.onModuleDestroy();
  });
});
