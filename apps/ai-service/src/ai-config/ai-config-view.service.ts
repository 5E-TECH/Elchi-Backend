import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AI_KEY_DEFAULT_LABEL,
  AI_SLOTS,
  aiProviderKeyAad,
  fingerprintOf,
  formatAiKeyHint,
  hintOf,
  type AiDisabledReason,
  type AiKeyCheckView,
  type AiKeySource,
  type AiKeyVerifyState,
  type AiKeyWarning,
  type AiStoredKeyView,
  type AiConfigErrorCode,
} from '@app/common';
import { AiConfigEnv } from './ai-config-env';
import { configPermissions } from './ai-config-requester';
import { AiKeyEnvelopeService } from './ai-key-envelope.service';
import {
  AI_SETTING_CATALOG,
  AI_SETTING_ENV_CHECK,
  AI_SETTING_KEYS,
} from './ai-key-store.service';
import {
  AI_PRICE_UNCONFIRMED,
  AI_SLOT_DEFS,
  slotPrice,
  slotVerdict,
} from './ai-model-slots';
import { normalizeModelId } from '../usage/ai-pricing';

/**
 * `GET /ai/config` ko'rinishi (openapi-fragment v0.2 `AiConfigView`).
 * Har chaqiruvda DB o'qiladi (kesh yo'q). Kalit qiymati yoki shifrmatni
 * HECH QACHON qaytmaydi — shifrmatn faqat `readable` ni aniqlash uchun
 * xotirada ochiladi va darhol tashlanadi.
 *
 * BE-1: `runtime` va `effective_source` saqlangan holatdan hisoblanadi;
 * BE-1c da runtime provayderi (xotiradagi haqiqiy holat) bilan
 * almashtiriladi. Modellar bloki — faqat o'qish (env/sukut); UI tanlovi,
 * katalog muvofiqligi va salomatlik — BE-2/BE-4.
 */
const KEYS = 'ai_schema.ai_provider_keys';
const SETTINGS = 'ai_schema.ai_runtime_settings';
const CATALOG_STALE_MS = 24 * 3600_000;
const CATALOG_USABLE_MS = 7 * 24 * 3600_000;
const BAD_STATES: Record<string, AiKeyWarning> = {
  rejected: 'ui_key_rejected',
  billing: 'ui_key_billing',
  forbidden: 'ui_key_forbidden',
};

interface KeyRow {
  id: string;
  status: 'active' | 'previous';
  label: string | null;
  secret_enc: string | null;
  key_hint: string;
  fingerprint: string;
  verify_state: AiKeyVerifyState;
  verify_origin: 'verify' | 'runtime';
  verify_error_code: string | null;
  verified_at: Date | null;
  last_used_at: Date | null;
  created_by: string;
  created_by_name: string | null;
  createdAt: Date;
}

interface SettingRow {
  key: string;
  value: Record<string, unknown>;
  version: number;
}

const iso = (d: Date | string | null | undefined) =>
  d ? new Date(d).toISOString() : null;

@Injectable()
export class AiConfigViewService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly env: AiConfigEnv,
    private readonly envelope: AiKeyEnvelopeService,
  ) {}

  async build(requesterId: string | null): Promise<Record<string, unknown>> {
    const keyRows = await this.ds.query<KeyRow[]>(
      `SELECT "id", "status", "label", "secret_enc", "key_hint", "fingerprint",
              "verify_state", "verify_origin", "verify_error_code", "verified_at",
              "last_used_at", "created_by", "created_by_name", "createdAt"
         FROM ${KEYS}
        WHERE "provider" = 'anthropic' AND "status" IN ('active','previous')`,
    );
    const settings = await this.ds.query<SettingRow[]>(
      `SELECT "key", "value", "version" FROM ${SETTINGS} WHERE "key" = ANY($1)`,
      [[AI_SETTING_KEYS, 'models', AI_SETTING_CATALOG, AI_SETTING_ENV_CHECK]],
    );
    const setting = (k: string) => settings.find((s) => s.key === k);

    const cipher = this.env.cipher;
    let rotationPending = 0;
    const toView = (r: KeyRow | undefined): AiStoredKeyView | null => {
      if (!r) return null;
      let readable = false;
      if (r.secret_enc) {
        const aad = aiProviderKeyAad(this.env.appEnv, r.id);
        try {
          cipher.decrypt(r.secret_enc, aad);
          readable = true;
          if (cipher.needsReencrypt(r.secret_enc, aad)) rotationPending++;
        } catch {
          readable = false;
        }
      }
      return {
        id: r.id,
        label: r.label ?? AI_KEY_DEFAULT_LABEL,
        hint: formatAiKeyHint(r.key_hint),
        fingerprint: r.fingerprint,
        created_at: iso(r.createdAt)!,
        created_by: { id: r.created_by, name: r.created_by_name },
        verify: {
          state: r.verify_state,
          origin: r.verify_origin,
          checked_at: iso(r.verified_at),
          error_code: (r.verify_error_code as AiConfigErrorCode) ?? null,
        },
        last_used_at: iso(r.last_used_at),
        readable,
      };
    };
    const activeRow = keyRows.find((r) => r.status === 'active');
    const active = toView(activeRow);
    const previous = toView(keyRows.find((r) => r.status === 'previous'));

    // Env kaliti — faqat ko'rinish va iz.
    const envKey = this.env.envKey;
    const envFp = envKey ? fingerprintOf(envKey) : null;
    const envCheckRaw = setting(AI_SETTING_ENV_CHECK)?.value ?? {};
    const envVerify: AiKeyCheckView | null = envKey
      ? envCheckRaw.fingerprint === envFp
        ? {
            state: (envCheckRaw.state as AiKeyVerifyState) ?? 'unverified',
            origin: (envCheckRaw.origin as 'verify' | 'runtime') ?? 'verify',
            checked_at: (envCheckRaw.checked_at as string) ?? null,
            error_code: (envCheckRaw.error_code as AiConfigErrorCode) ?? null,
          }
        : {
            state: 'unverified',
            origin: 'verify',
            checked_at: null,
            error_code: null,
          }
      : null;

    // Manba va ogohlantirishlar (D5: UI kaliti muammoli → env'ga O'TMAYDI).
    const warnings: AiKeyWarning[] = [];
    let source: AiKeySource;
    let keyProblem: AiDisabledReason | null = null;
    if (!this.env.uiEnabled) {
      source = envKey ? 'env' : 'none';
      if (active) warnings.push('ui_key_ignored_feature_off');
    } else if (active) {
      if (!active.readable) {
        warnings.push('ui_key_unreadable');
        keyProblem = 'key_unreadable';
      } else if (BAD_STATES[active.verify.state]) {
        warnings.push(BAD_STATES[active.verify.state]);
        keyProblem =
          active.verify.state === 'rejected'
            ? 'key_rejected'
            : active.verify.state === 'billing'
              ? 'key_billing'
              : 'key_forbidden';
      }
      source = keyProblem ? 'none' : 'ui';
    } else {
      source = envKey ? 'env' : 'none';
    }
    if (active && envFp && active.fingerprint === envFp)
      warnings.push('same_as_env');

    const disabledReason: AiDisabledReason | null = this.env.stagingAiDisabled
      ? 'staging_disabled'
      : (keyProblem ?? (source === 'none' ? 'no_key' : null));

    const perms = configPermissions(this.env.access(), requesterId, false);

    const catalogRaw = setting(AI_SETTING_CATALOG)?.value ?? {};
    const fetchedAt =
      typeof catalogRaw.fetched_at === 'string' ? catalogRaw.fetched_at : null;
    const age = fetchedAt ? Date.now() - Date.parse(fetchedAt) : Infinity;

    return {
      environment: ['production', 'staging', 'development'].includes(
        this.env.appEnv,
      )
        ? this.env.appEnv
        : 'production',
      version: {
        key: setting(AI_SETTING_KEYS)?.version ?? 1,
        models: setting('models')?.version ?? 1,
      },
      permissions: {
        key: perms.key,
        models: false, // BE-2: modellar PATCH
        step_up_required: perms.step_up_required,
      },
      key_locked_reason: perms.key_locked_reason,
      models_locked_reason: perms.models_locked_reason ?? 'feature_off',
      master_key: {
        configured: cipher.configured,
        rotation_pending: rotationPending,
      },
      policy_strict: this.env.policyStrict,
      runtime: {
        staging_ai_disabled: this.env.stagingAiDisabled,
        config_stale: false,
        config_loaded_at: null,
        disabled_reason: disabledReason,
      },
      limits: {
        daily_cap_usd:
          this.env.appEnv === 'staging'
            ? this.env.num('STAGING_AI_DAILY_USD_CAP', 2)
            : this.env.num('AI_DAILY_USD_CAP', 50),
        warn_ratio: this.env.num('AI_CAP_WARN_RATIO', 0.8),
        max_output_price_usd: this.env.num('AI_UI_MAX_OUTPUT_PRICE_USD', 25),
        assistant_daily_cap_usd: this.env.num('AI_ASSISTANT_DAILY_USD_CAP', 5),
        assistant_max_usd_per_message: this.env.num(
          'AI_ASSISTANT_MAX_USD_PER_MESSAGE',
          0.5,
        ),
      },
      key_wrap: perms.key ? this.envelope.view() : null,
      key: {
        effective_source: source,
        active,
        previous,
        env: {
          present: !!envKey,
          hint: envKey ? hintOf(envKey) : null,
          fingerprint: envFp,
          verify: envVerify,
        },
        warnings,
      },
      models: { slots: this.slots() },
      catalog: {
        fetched_at: fetchedAt,
        stale: age > CATALOG_STALE_MS,
        usable: age <= CATALOG_USABLE_MS,
        error_code:
          typeof catalogRaw.error_code === 'string'
            ? catalogRaw.error_code
            : null,
      },
    };
  }

  /** BE-1: faqat o'qish — env/sukut (UI tanlovi BE-2). */
  private slots(): Array<Record<string, unknown>> {
    return AI_SLOT_DEFS.filter((d) => AI_SLOTS.includes(d.slot)).map((d) => {
      const envModel = this.env.str(d.env);
      const model = envModel ?? d.defaultModel;
      const warnings: string[] = [];
      if (AI_PRICE_UNCONFIRMED.has(normalizeModelId(model)))
        warnings.push('price_unconfirmed');
      const verdict = slotVerdict(d, model);
      if (verdict === 'weak') warnings.push('weak_for_extraction');
      return {
        slot: d.slot,
        features: d.features,
        env_name: d.env,
        model,
        source: envModel ? 'env' : 'default',
        default_model: d.defaultModel,
        env_model: envModel,
        ui_model: null,
        recommended_model: d.defaultModel,
        verdict,
        price: slotPrice(model),
        warnings,
        changed_at: null,
        changed_by: null,
        effort:
          d.slot === 'assistant' ? this.env.str('AI_ASSISTANT_EFFORT') : null,
        previous_ui_model: null,
        override_invalid: false,
        verified_for_slot: true,
        unavailable: false,
        health: {
          window_minutes: 60,
          ok: 0,
          truncated: 0,
          refused: 0,
          rate_limited: 0,
          error: 0,
          last_error_code: null,
          last_error_at: null,
          guard_until: null,
          auto_reverted_at: null,
        },
      };
    });
  }
}
