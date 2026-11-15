import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  AI_CONFIG_ERROR_CODES as C,
  ActivityLogService,
  aiProviderKeyAad,
  checkAiFreeText,
  checkAiKeyFormat,
  fingerprintOf,
  formatAiKeyHint,
  keyTailOf,
  looksLikeAiKey,
  type AiConfigErrorCode,
  type AiConfigRequester,
  type AiConfigRpcError,
  type AiKeyRef,
  type AiKeyVerifyState,
} from '@app/common';
import { AiConfigEnv } from './ai-config-env';
import { AiConfigAbort, aiConfigError } from './ai-config-errors';
import type { AiConfigDeadline } from './ai-config-deadline';
import { consumeAiAttempt } from './ai-attempt-limiter';
import { AiKeyEnvelopeService } from './ai-key-envelope.service';
import { readAnthropicKey } from './ai-key-reader';
import {
  AiKeyVerifierService,
  type AiCatalogModelRaw,
  type AiKeyVerifyResult,
} from './ai-key-verifier.service';

/**
 * Kalit saqlash (be-brief §6.2, D5–D7, D15). Har o'zgarish BITTA
 * tranzaksiya: `keys` sozlama qatori `FOR UPDATE` → o'zgarish → audit
 * (`logWithin`, xato → rollback) → deadline tekshiruvi → COMMIT. Tekshiruv
 * (bepul `models.list`) tranzaksiyadan TASHQARIDA, undan oldin.
 *
 * ⚠️ MAXFIYLIK: kalit faqat lokal o'zgaruvchida; audit/natija/xato — faqat
 * `hint`, `fingerprint`, `label`.
 */
const KEYS = 'ai_schema.ai_provider_keys';
const SETTINGS = 'ai_schema.ai_runtime_settings';

export const AI_SETTING_KEYS = 'keys';
export const AI_SETTING_CATALOG = 'model_catalog';
export const AI_SETTING_ENV_CHECK = 'env_key_check';

export type AiKeyOpResult =
  { ok: true } | { ok: false; error: AiConfigRpcError };

export interface AiKeyChangeListener {
  (event: { action: string }): void;
}

interface KeyRowLite {
  id: string;
  status: 'active' | 'previous';
  label: string | null;
  key_hint: string;
  fingerprint: string;
  has_secret: boolean;
}

function refOf(r: {
  key_hint: string;
  fingerprint: string;
  label: string | null;
}): AiKeyRef {
  return {
    hint: formatAiKeyHint(r.key_hint),
    fingerprint: r.fingerprint,
    label: r.label,
    source: 'ui',
  };
}

const VERIFY_FAIL_STATES: Partial<Record<AiConfigErrorCode, AiKeyVerifyState>> =
  {
    AI_KEY_REJECTED: 'rejected',
    AI_KEY_FORBIDDEN: 'forbidden',
    AI_KEY_BAD_REQUEST: 'bad_request',
    AI_KEY_BILLING: 'billing',
  };

@Injectable()
export class AiKeyStoreService {
  private readonly logger = new Logger(AiKeyStoreService.name);
  private readonly listeners = new Set<AiKeyChangeListener>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly activityLog: ActivityLogService,
    private readonly env: AiConfigEnv,
    private readonly envelope: AiKeyEnvelopeService,
    private readonly verifier: AiKeyVerifierService,
  ) {}

  /** Runtime provayderi (BE-1c) shu orqali darhol qayta yuklaydi. */
  onChange(listener: AiKeyChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(action: string): void {
    for (const l of this.listeners) {
      try {
        l({ action });
      } catch {
        /* tinglovchi xatosi yozuvga ta'sir qilmaydi */
      }
    }
  }

  // ---------------------------------------------------------------- set

  async set(
    requester: AiConfigRequester,
    payload: Record<string, unknown>,
    deadline: AiConfigDeadline,
  ): Promise<AiKeyOpResult> {
    if (!this.env.cipher.configured)
      return aiConfigError(C.KEY_STORAGE_UNAVAILABLE);
    const version = this.versionOf(payload);
    if (version === null) return aiConfigError(C.INVALID, { field: 'version' });
    const label = checkAiFreeText('label', payload.label);
    if (!label.ok) return aiConfigError(C.INVALID, { field: 'label' });

    const opened = this.envelope.open(payload.key_envelope, requester.id);
    if (!opened.ok) return aiConfigError(opened.code);
    const format = checkAiKeyFormat(opened.apiKey);
    if (!format.ok) return aiConfigError(format.code);
    const key = format.key;
    const fingerprint = fingerprintOf(key);

    const limit = await consumeAiAttempt(this.ds, requester.id, 'key');
    if (!limit.ok)
      return aiConfigError(C.KEY_ATTEMPTS_EXCEEDED, {
        retry_after_seconds: limit.retry_after_seconds,
      });

    // Arzon oldindan tekshiruv (tarmoqdan oldin); qat'iysi — qulf ostida.
    const pre = await this.precheck(this.ds.manager, version);
    if (pre) return pre;
    const active = await this.rowByStatus(this.ds.manager, 'active');
    if (active?.fingerprint === fingerprint) return aiConfigError(C.KEY_SAME);

    const verified = await this.verifier.verify(
      key,
      deadline.verifyTimeoutMs(),
    );
    if (!verified.ok) {
      await this.attemptRejected(requester, fingerprint, verified.code);
      return aiConfigError(verified.code, {
        retry_after_seconds: verified.retry_after_seconds,
      });
    }

    const id = randomUUID();
    const secretEnc = this.env.cipher.encrypt(
      key,
      aiProviderKeyAad(this.env.appEnv, id),
    );
    const result = await this.mutate(
      deadline,
      version,
      async (m, newVersion) => {
        const current = await this.rowByStatus(m, 'active');
        const previous = await this.rowByStatus(m, 'previous');
        if (current?.fingerprint === fingerprint)
          throw new AiConfigAbort(C.KEY_SAME);
        if (previous) await this.retire(m, previous.id, requester.id);
        if (current)
          await m.query(
            `UPDATE ${KEYS} SET "status" = 'previous', "updatedAt" = now() WHERE "id" = $1`,
            [current.id],
          );
        await m.query(
          `INSERT INTO ${KEYS} ("id", "status", "label", "secret_enc", "key_hint", "fingerprint",
            "verify_state", "verify_origin", "verified_at", "created_by", "created_by_name")
         VALUES ($1, 'active', $2, $3, $4, $5, 'ok', 'verify', now(), $6, $7)`,
          [
            id,
            label.value,
            secretEnc,
            keyTailOf(key),
            fingerprint,
            requester.id,
            requester.name ?? null,
          ],
        );
        await this.saveCatalog(m, verified.models, null);
        const toRef: AiKeyRef = {
          hint: formatAiKeyHint(keyTailOf(key)),
          fingerprint,
          label: label.value,
          source: 'ui',
        };
        const action = current ? 'ai.key.replace' : 'ai.key.add';
        await this.audit(m, requester, action, id, {
          old_value: current ? { key: refOf(current) } : null,
          new_value: { key: toRef },
          metadata: {
            version: newVersion,
            key_from: current ? refOf(current) : null,
            key_to: toRef,
            retired: previous ? refOf(previous) : null,
          },
          description: current
            ? `AI kaliti almashtirildi (${toRef.hint})`
            : `AI kaliti qo'shildi (${toRef.hint})`,
        });
        return action;
      },
    );
    return result;
  }

  // ---------------------------------------------------------------- verify

  async verifyInUse(
    requester: AiConfigRequester,
    deadline: AiConfigDeadline,
  ): Promise<AiKeyOpResult> {
    const limit = await consumeAiAttempt(this.ds, requester.id, 'key');
    if (!limit.ok)
      return aiConfigError(C.KEY_ATTEMPTS_EXCEEDED, {
        retry_after_seconds: limit.retry_after_seconds,
      });

    // UI kaliti (flag yoqiq va faol qator bor) — aks holda env kaliti.
    const activeRow = this.env.uiEnabled
      ? await this.rowByStatus(this.ds.manager, 'active')
      : null;
    let key: string | null = null;
    let target: { kind: 'ui'; row: KeyRowLite } | { kind: 'env' };
    if (activeRow) {
      if (!this.env.cipher.configured && !this.env.cipher.rotating)
        return aiConfigError(C.KEY_STORAGE_UNAVAILABLE);
      const read = await readAnthropicKey(
        this.ds.manager,
        this.env.cipher,
        this.env.appEnv,
      );
      if (!read || read.unreadable)
        return aiConfigError(C.KEY_STORAGE_UNAVAILABLE);
      key = read.key;
      target = { kind: 'ui', row: activeRow };
    } else {
      key = this.env.envKey;
      if (!key) return aiConfigError(C.KEY_NONE);
      target = { kind: 'env' };
    }

    const verified: AiKeyVerifyResult = await this.verifier.verify(
      key,
      deadline.verifyTimeoutMs(),
    );
    const state: AiKeyVerifyState = verified.ok
      ? 'ok'
      : (VERIFY_FAIL_STATES[verified.code] ?? 'unavailable');
    const errorCode = verified.ok ? null : verified.code;
    const fingerprint = fingerprintOf(key);
    key = null;

    return this.mutate(
      deadline,
      null,
      async (m) => {
        if (target.kind === 'ui') {
          await m.query(
            `UPDATE ${KEYS}
              SET "verify_state" = $2::varchar, "verify_origin" = 'verify',
                  "verify_error_code" = $3::varchar, "verified_at" = now(),
                  "rejected_at" = CASE WHEN $2::varchar = 'rejected' THEN now() ELSE "rejected_at" END,
                  "updatedAt" = now()
            WHERE "id" = $1 AND "status" = 'active'`,
            [target.row.id, state, errorCode],
          );
        } else {
          await this.upsertSetting(m, AI_SETTING_ENV_CHECK, {
            fingerprint,
            state,
            origin: 'verify',
            checked_at: new Date().toISOString(),
            error_code: errorCode,
          });
        }
        if (verified.ok) await this.saveCatalog(m, verified.models, null);
        const ref: AiKeyRef =
          target.kind === 'ui'
            ? refOf(target.row)
            : {
                hint: formatAiKeyHint(keyTailOf(this.env.envKey ?? '')),
                fingerprint,
                label: null,
                source: 'env',
              };
        await this.audit(
          m,
          requester,
          'ai.key.verify',
          target.kind === 'ui' ? target.row.id : `env:${fingerprint}`,
          {
            new_value: { key: ref, verify_state: state },
            metadata: {
              key_to: ref,
              verify_state: state,
              error_code: errorCode,
            },
            description: `AI kaliti tekshirildi (${ref.hint}): ${state}`,
          },
        );
        return 'ai.key.verify';
      },
      { bumpVersion: false },
    );
  }

  // ---------------------------------------------------------------- restore

  async restore(
    requester: AiConfigRequester,
    payload: Record<string, unknown>,
    deadline: AiConfigDeadline,
  ): Promise<AiKeyOpResult> {
    const version = this.versionOf(payload);
    if (version === null) return aiConfigError(C.INVALID, { field: 'version' });
    if (!this.env.cipher.configured)
      return aiConfigError(C.KEY_STORAGE_UNAVAILABLE);
    const previous = await this.rowByStatus(this.ds.manager, 'previous');
    if (!previous) return aiConfigError(C.KEY_NO_PREVIOUS);

    const limit = await consumeAiAttempt(this.ds, requester.id, 'key');
    if (!limit.ok)
      return aiConfigError(C.KEY_ATTEMPTS_EXCEEDED, {
        retry_after_seconds: limit.retry_after_seconds,
      });
    const pre = await this.precheck(this.ds.manager, version);
    if (pre) return pre;

    const read = await readAnthropicKey(
      this.ds.manager,
      this.env.cipher,
      this.env.appEnv,
      { id: previous.id },
    );
    if (!read || read.unreadable)
      return aiConfigError(C.KEY_STORAGE_UNAVAILABLE);
    const verified = await this.verifier.verify(
      read.key,
      deadline.verifyTimeoutMs(),
    );
    if (!verified.ok) {
      await this.attemptRejected(
        requester,
        previous.fingerprint,
        verified.code,
      );
      return aiConfigError(verified.code, {
        retry_after_seconds: verified.retry_after_seconds,
      });
    }

    return this.mutate(deadline, version, async (m, newVersion) => {
      const prev = await this.rowByStatus(m, 'previous');
      if (!prev || prev.id !== previous.id)
        throw new AiConfigAbort(C.KEY_NO_PREVIOUS);
      const current = await this.rowByStatus(m, 'active');
      // Qisman UNIQUE indekslar bir qatorli almashtirishni rad etadi —
      // vaqtinchalik `swap` holati (faqat shu tranzaksiya ichida ko'rinadi).
      if (current)
        await m.query(
          `UPDATE ${KEYS} SET "status" = 'swap', "updatedAt" = now() WHERE "id" = $1`,
          [current.id],
        );
      await m.query(
        `UPDATE ${KEYS}
            SET "status" = 'active', "verify_state" = 'ok', "verify_origin" = 'verify',
                "verify_error_code" = NULL, "verified_at" = now(), "updatedAt" = now()
          WHERE "id" = $1`,
        [prev.id],
      );
      if (current)
        await m.query(
          `UPDATE ${KEYS} SET "status" = 'previous', "updatedAt" = now() WHERE "id" = $1`,
          [current.id],
        );
      await this.saveCatalog(m, verified.models, null);
      await this.audit(m, requester, 'ai.key.restore', prev.id, {
        old_value: current ? { key: refOf(current) } : null,
        new_value: { key: refOf(prev) },
        metadata: {
          version: newVersion,
          key_from: current ? refOf(current) : null,
          key_to: refOf(prev),
        },
        description: `Oldingi AI kalitiga qaytarildi (${refOf(prev).hint})`,
      });
      return 'ai.key.restore';
    });
  }

  // ---------------------------------------------------------------- deactivate

  async deactivate(
    requester: AiConfigRequester,
    payload: Record<string, unknown>,
    deadline: AiConfigDeadline,
  ): Promise<AiKeyOpResult> {
    const version = this.versionOf(payload);
    if (version === null) return aiConfigError(C.INVALID, { field: 'version' });
    let reason: string | null = null;
    if (payload.reason !== undefined && payload.reason !== null) {
      if (
        typeof payload.reason !== 'string' ||
        payload.reason.length > 200 ||
        looksLikeAiKey(payload.reason)
      )
        return aiConfigError(C.INVALID, { field: 'reason' });
      reason = payload.reason.trim() || null;
    }
    // Master sirsiz ham ishlaydi (faqat metadata) — bir bosishda tiklash.
    return this.mutate(deadline, version, async (m, newVersion) => {
      const current = await this.rowByStatus(m, 'active');
      if (!current) throw new AiConfigAbort(C.KEY_NONE);
      const previous = await this.rowByStatus(m, 'previous');
      if (previous) await this.retire(m, previous.id, requester.id);
      await m.query(
        `UPDATE ${KEYS} SET "status" = 'previous', "updatedAt" = now() WHERE "id" = $1`,
        [current.id],
      );
      await this.audit(m, requester, 'ai.key.deactivate', current.id, {
        old_value: { key: refOf(current) },
        new_value: null,
        metadata: {
          version: newVersion,
          key_from: refOf(current),
          retired: previous ? refOf(previous) : null,
          reason,
        },
        description: `AI kaliti o'chirildi (${refOf(current).hint})`,
      });
      return 'ai.key.deactivate';
    });
  }

  // ---------------------------------------------------------------- forget

  async forgetPrevious(
    requester: AiConfigRequester,
    payload: Record<string, unknown>,
    deadline: AiConfigDeadline,
  ): Promise<AiKeyOpResult> {
    const version = this.versionOf(payload);
    if (version === null) return aiConfigError(C.INVALID, { field: 'version' });
    return this.mutate(deadline, version, async (m, newVersion) => {
      const previous = await this.rowByStatus(m, 'previous');
      if (!previous) throw new AiConfigAbort(C.KEY_NO_PREVIOUS);
      await this.retire(m, previous.id, requester.id);
      await this.audit(m, requester, 'ai.key.forget', previous.id, {
        old_value: { key: refOf(previous) },
        new_value: null,
        metadata: { version: newVersion, key_from: refOf(previous) },
        description: `Oldingi AI kaliti o'chirib tashlandi (${refOf(previous).hint})`,
      });
      return 'ai.key.forget';
    });
  }

  // ---------------------------------------------------------------- helpers

  /** `keys` sozlama qatorining versiyasi (qator yo'q — 1). */
  async keysVersion(m: EntityManager = this.ds.manager): Promise<number> {
    const rows = await m.query<{ version: number }[]>(
      `SELECT "version" FROM ${SETTINGS} WHERE "key" = $1`,
      [AI_SETTING_KEYS],
    );
    return rows[0]?.version ?? 1;
  }

  private versionOf(payload: Record<string, unknown>): number | null {
    const v = payload?.version;
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
  }

  private async precheck(
    m: EntityManager,
    version: number,
  ): Promise<{ ok: false; error: AiConfigRpcError } | null> {
    const current = await this.keysVersion(m);
    return current === version
      ? null
      : aiConfigError(C.CONFLICT, { version: current });
  }

  private async rowByStatus(
    m: EntityManager,
    status: 'active' | 'previous',
  ): Promise<KeyRowLite | null> {
    const rows = await m.query<KeyRowLite[]>(
      `SELECT "id", "status", "label", "key_hint", "fingerprint",
              ("secret_enc" IS NOT NULL) AS "has_secret"
         FROM ${KEYS} WHERE "provider" = 'anthropic' AND "status" = $1 LIMIT 1`,
      [status],
    );
    return rows[0] ?? null;
  }

  private async retire(
    m: EntityManager,
    id: string,
    by: string,
  ): Promise<void> {
    await m.query(
      `UPDATE ${KEYS}
          SET "status" = 'retired', "secret_enc" = NULL, "retired_at" = now(),
              "retired_by" = $2, "updatedAt" = now()
        WHERE "id" = $1`,
      [id, by],
    );
  }

  private async upsertSetting(
    m: EntityManager,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    await m.query(
      `INSERT INTO ${SETTINGS} ("key", "value", "version") VALUES ($1, $2::jsonb, 1)
       ON CONFLICT ("key") DO UPDATE
         SET "value" = EXCLUDED."value", "version" = ${SETTINGS}."version" + 1,
             "updatedAt" = now()`,
      [key, JSON.stringify(value)],
    );
  }

  private async saveCatalog(
    m: EntityManager,
    models: AiCatalogModelRaw[],
    errorCode: string | null,
  ): Promise<void> {
    await this.upsertSetting(m, AI_SETTING_CATALOG, {
      fetched_at: new Date().toISOString(),
      error_code: errorCode,
      models,
    });
  }

  private async audit(
    m: EntityManager,
    requester: AiConfigRequester,
    action: string,
    entityId: string,
    input: {
      old_value?: Record<string, unknown> | null;
      new_value?: Record<string, unknown> | null;
      metadata: Record<string, unknown>;
      description: string;
    },
  ): Promise<void> {
    await this.activityLog.logWithin(m, {
      entity_type: 'AiProviderKey',
      entity_id: entityId,
      action,
      old_value: input.old_value ?? null,
      new_value: input.new_value ?? null,
      user_id: requester.id,
      user_name: requester.name ?? null,
      user_role: 'superadmin',
      metadata: input.metadata,
      description: input.description,
    });
  }

  /** Rad etilgan urinish — faqat iz va kod (o'zgarishdan tashqarida, best effort). */
  private async attemptRejected(
    requester: AiConfigRequester,
    fingerprint: string,
    code: AiConfigErrorCode,
  ): Promise<void> {
    await this.activityLog.log({
      entity_type: 'AiProviderKey',
      entity_id: `attempt:${fingerprint}`,
      action: 'ai.key.attempt_rejected',
      user_id: requester.id,
      user_name: requester.name ?? null,
      user_role: 'superadmin',
      new_value: { fingerprint, error_code: code },
      metadata: { fingerprint, error_code: code },
      description: `AI kaliti rad etildi (${code})`,
    });
  }

  /**
   * Umumiy tranzaksiya: `keys` qatori FOR UPDATE → versiya → `fn` → versiya
   * oshishi → deadline (COMMIT oldidan) → COMMIT → tinglovchilar.
   */
  private async mutate(
    deadline: AiConfigDeadline,
    expectedVersion: number | null,
    fn: (m: EntityManager, newVersion: number) => Promise<string>,
    opts: { bumpVersion?: boolean } = {},
  ): Promise<AiKeyOpResult> {
    const bump = opts.bumpVersion !== false;
    let action: string;
    try {
      action = await this.ds.transaction(async (m) => {
        await m.query(
          `INSERT INTO ${SETTINGS} ("key", "value", "version") VALUES ($1, '{}'::jsonb, 1)
           ON CONFLICT ("key") DO NOTHING`,
          [AI_SETTING_KEYS],
        );
        const rows = await m.query<{ version: number }[]>(
          `SELECT "version" FROM ${SETTINGS} WHERE "key" = $1 FOR UPDATE`,
          [AI_SETTING_KEYS],
        );
        const current = rows[0]?.version ?? 1;
        if (expectedVersion !== null && expectedVersion !== current)
          throw new AiConfigAbort(C.CONFLICT, { version: current });
        const next = bump ? current + 1 : current;
        const act = await fn(m, next);
        if (bump)
          await m.query(
            `UPDATE ${SETTINGS} SET "version" = $2, "updatedAt" = now() WHERE "key" = $1`,
            [AI_SETTING_KEYS, next],
          );
        // ⚠️ Gateway 504 = hech narsa o'zgarmagan (AC5).
        if (!deadline.canCommit()) throw new AiConfigAbort(C.EXPIRED);
        return act;
      });
    } catch (err) {
      if (err instanceof AiConfigAbort)
        return aiConfigError(err.code, err.extra);
      this.logger.error(
        `ai-config yozuvi yiqildi: ${(err as Error)?.name ?? 'Error'}`,
      );
      throw err;
    }
    this.emit(action);
    return { ok: true };
  }
}
