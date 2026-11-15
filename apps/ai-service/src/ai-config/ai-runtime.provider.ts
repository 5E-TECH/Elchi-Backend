import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { APIError } from '@anthropic-ai/sdk';
import { DataSource } from 'typeorm';
import {
  AI_CONFIG_ERROR_CODES as C,
  ActivityLogService,
  buildAnthropicClient,
  defaultAnthropicClientFactory,
  fingerprintOf,
  formatAiKeyHint,
  inspectAnthropicEnv,
  type AiDisabledReason,
  type AiKeySource,
  type AiKeyVerifyState,
  type AiSlot,
  type AnthropicClientFactory,
  type AnthropicClientLease,
  type AnthropicClientLike,
  type AnthropicClientProvider,
  type AnthropicKeyInspection,
} from '@app/common';
import { AiConfigEnv } from './ai-config-env';
import { AiConfigNotifier } from './ai-config.notifier';
import { readAnthropicKey } from './ai-key-reader';
import { AiKeyStoreService } from './ai-key-store.service';
import { AiKeyVerifierService } from './ai-key-verifier.service';
import { AI_SLOT_DEFS } from './ai-model-slots';

/**
 * «AI kalit va modellar» runtime provayderi (be-brief §6.2, D5, D12):
 *
 * - `AI_CONFIG_UI_ENABLED=false` — FAQAT env kaliti, DB UMUMAN o'qilmaydi
 *   (bugungi xulq, so'rov tanalari bayt-aniq bir xil — golden test).
 * - yoqiq — boot'da yuklanadi, har 15 s yangilanadi (o'zgarish bo'lsagina
 *   qayta quriladi), yozuvdan keyin darhol (`store.onChange`).
 *   Ustuvorlik: faol, ochiladigan, sog'lom UI kaliti > env kaliti > yo'q.
 *   UI kaliti rad etilgan / pul yo'q / ruxsat yo'q / ochilmadi — env'ga
 *   O'TMAYDI (ega qarori a): AI o'chiq, audit + ops xabari + inbox; ega
 *   «Kalitni o'chirish» bilan server kalitiga o'tkazadi.
 * - DB o'qilmasa — oxirgi ma'lum yaxshi holat (`config_stale`, bir marta
 *   ogohlantirish); boot'da umuman yo'q bo'lsa — AI o'chiq, 15 s da qayta.
 * - `acquire()` sinxron, faqat xotira. Kalit qiymati faqat xotirada (≤ 2 ta
 *   mijoz: UI + env); logga/natijaga hech qachon chiqmaydi.
 */
export const AI_RUNTIME_REFRESH_MS = 15_000;
export const AI_RUNTIME_CONFIRM_INTERVAL_MS = 60_000;
export const AI_RUNTIME_LAST_USED_MS = 10 * 60_000;
export const AI_RUNTIME_CLIENT_FACTORY = Symbol('AI_RUNTIME_CLIENT_FACTORY');

const BAD_STATES: ReadonlySet<string> = new Set([
  'rejected',
  'billing',
  'forbidden',
]);
const KEYS = 'ai_schema.ai_provider_keys';
const SETTINGS = 'ai_schema.ai_runtime_settings';

interface ActiveSnap {
  id: string;
  fingerprint: string;
  key_hint: string;
  label: string | null;
  verify_state: AiKeyVerifyState;
  updatedAt: string;
  unreadable: boolean;
  lease: AnthropicClientLease | null;
}

interface Snapshot {
  signature: string;
  configVersion: number;
  active: ActiveSnap | null;
  envCheck: { fingerprint: string; state: string } | null;
}

export interface AiRuntimeStatus {
  source: AiKeySource;
  verifyState: AiKeyVerifyState;
  /** Kalit sababli o'chiq (staging_disabled — ClaudeService/controller qo'shadi). */
  disabledReason: AiDisabledReason | null;
  configStale: boolean;
  loadedAt: string | null;
  unavailableSlots: AiSlot[];
}

function featureSlot(feature: string): AiSlot | null {
  return AI_SLOT_DEFS.find((d) => d.features.includes(feature))?.slot ?? null;
}

@Injectable()
export class AiRuntimeProvider
  implements AnthropicClientProvider, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AiRuntimeProvider.name);
  private readonly factory: AnthropicClientFactory;
  private envLeaseCache: {
    fp: string;
    lease: AnthropicClientLease | null;
  } | null = null;
  private snap: Snapshot | null = null;
  private stale = false;
  private staleAlerted = false;
  private loadedAt: Date | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly unreadableAudited = new Set<string>();
  private readonly confirmations = new Map<
    string,
    { at: number; p: Promise<void> }
  >();
  /** fingerprint → ochilgan kalit (faqat 401 tasdiqlash uchun; ≤ 2). */
  private readonly keys = new Map<string, string>();
  private readonly unavailable = new Set<AiSlot>();
  private lastTouch = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly env: AiConfigEnv,
    private readonly store: AiKeyStoreService,
    private readonly activity: ActivityLogService,
    private readonly verifier: AiKeyVerifierService,
    @Optional() private readonly notifier?: AiConfigNotifier,
    @Optional()
    @Inject(AI_RUNTIME_CLIENT_FACTORY)
    factory?: AnthropicClientFactory,
  ) {
    this.factory = factory ?? defaultAnthropicClientFactory;
  }

  async onModuleInit(): Promise<void> {
    this.unsubscribe = this.store.onChange((e) => {
      if (e.action === 'ai.key.verify') this.unavailable.clear();
      void this.refresh();
    });
    if (!this.env.uiEnabled) return; // D12: DB umuman o'qilmaydi.
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), AI_RUNTIME_REFRESH_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // ------------------------------------------------------------ provider

  acquire(): AnthropicClientLease | null {
    if (!this.env.uiEnabled) return this.envLease();
    const snap = this.snap;
    if (!snap) return null; // boot'da yuklanmadi — config_stale
    if (snap.active) {
      const a = snap.active;
      if (a.unreadable || BAD_STATES.has(a.verify_state) || !a.lease)
        return null;
      this.touch(a.id);
      return a.lease;
    }
    const env = this.envLease();
    if (
      env &&
      snap.envCheck &&
      snap.envCheck.fingerprint === env.fingerprint &&
      BAD_STATES.has(snap.envCheck.state)
    ) {
      return null;
    }
    return env;
  }

  keyState(): AnthropicKeyInspection {
    const scan = inspectAnthropicEnv(process.env);
    if (this.acquire() || this.env.envKey)
      return { state: 'ok', misnamedKeys: scan.misnamedKeys };
    return {
      state: scan.misnamedKeys.length > 0 ? 'misnamed' : 'missing',
      misnamedKeys: scan.misnamedKeys,
    };
  }

  reportCallOutcome(): void {
    // Slot salomatligi va avtomatik qaytarish — BE-4.
  }

  /**
   * Haqiqiy chaqiruv xatosi — FAQAT tur/status (matn o'qilmaydi). Holat
   * `lease.keyId` qatoriga (env lease — `env_key_check`) yoziladi: almashtirishdan
   * keyin eski kalit lease'idagi 401 YANGI kalitga tegmaydi. Throw yo'q.
   */
  reportCallFailure(
    lease: AnthropicClientLease,
    feature: string,
    err: unknown,
  ): void {
    if (!this.env.uiEnabled) return; // flag o'chiq — DB'ga hech narsa
    if (!(err instanceof APIError)) return;
    const status = err.status;
    if (status === 402 || err.type === 'billing_error') {
      void this.markKey(lease, 'billing', C.KEY_BILLING);
    } else if (status === 403) {
      void this.markKey(lease, 'forbidden', C.KEY_FORBIDDEN);
    } else if (status === 401) {
      void this.confirm401(lease);
    } else if (status === 404 && err.type === 'not_found_error') {
      void this.markSlotUnavailable(feature);
    }
  }

  // ------------------------------------------------------------ status

  status(): AiRuntimeStatus {
    const lease = this.acquire();
    const snap = this.snap;
    let source: AiKeySource = lease ? lease.source : 'none';
    let verifyState: AiKeyVerifyState = 'unverified';
    let reason: AiDisabledReason | null = null;
    if (!this.env.uiEnabled) {
      source = lease ? 'env' : 'none';
      reason = lease ? null : 'no_key';
    } else if (!snap) {
      reason = 'config_stale';
    } else if (snap.active) {
      verifyState = snap.active.verify_state;
      if (snap.active.unreadable) reason = 'key_unreadable';
      else if (snap.active.verify_state === 'rejected') reason = 'key_rejected';
      else if (snap.active.verify_state === 'billing') reason = 'key_billing';
      else if (snap.active.verify_state === 'forbidden')
        reason = 'key_forbidden';
      else if (!lease) reason = 'client_error';
    } else if (lease) {
      verifyState =
        snap.envCheck?.fingerprint === lease.fingerprint
          ? (snap.envCheck.state as AiKeyVerifyState)
          : 'unverified';
    } else if (this.env.envKey && snap.envCheck) {
      const s = snap.envCheck.state;
      verifyState = s as AiKeyVerifyState;
      reason =
        s === 'rejected'
          ? 'key_rejected'
          : s === 'billing'
            ? 'key_billing'
            : 'key_forbidden';
    } else {
      reason = 'no_key';
    }
    if (!lease) source = 'none';
    return {
      source,
      verifyState,
      disabledReason: reason,
      configStale: this.stale || (this.env.uiEnabled && !snap),
      loadedAt: this.loadedAt ? this.loadedAt.toISOString() : null,
      unavailableSlots: [...this.unavailable],
    };
  }

  // ------------------------------------------------------------ internals

  private envLease(): AnthropicClientLease | null {
    const key = this.env.envKey;
    if (!key) return null;
    const fp = fingerprintOf(key);
    if (this.envLeaseCache?.fp !== fp) {
      const client = buildAnthropicClient(this.factory, key, this.logger);
      this.envLeaseCache = {
        fp,
        lease: client
          ? {
              client,
              keyId: null,
              source: 'env',
              fingerprint: fp,
              configVersion: 0,
            }
          : null,
      };
      this.rememberKey(fp, key);
    }
    return this.envLeaseCache.lease;
  }

  private rememberKey(fp: string, key: string): void {
    this.keys.set(fp, key);
    // Faqat joriy UI va env kalitlari (≤ 2) qoladi.
    const keep = new Set<string>([
      this.envLeaseCache?.fp ?? '',
      this.snap?.active?.fingerprint ?? '',
      fp,
    ]);
    for (const k of this.keys.keys()) if (!keep.has(k)) this.keys.delete(k);
  }

  /** Yangilash — bir vaqtda bitta; xato → oxirgi ma'lum holat + config_stale. */
  refresh(): Promise<void> {
    if (!this.env.uiEnabled) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    try {
      const rows = await this.ds.query<
        Array<{
          id: string;
          fingerprint: string;
          key_hint: string;
          label: string | null;
          verify_state: AiKeyVerifyState;
          updatedAt: Date | string;
        }>
      >(
        `SELECT "id", "fingerprint", "key_hint", "label", "verify_state", "updatedAt"
           FROM ${KEYS} WHERE "provider" = 'anthropic' AND "status" = 'active' LIMIT 1`,
      );
      const settings = await this.ds.query<
        Array<{ key: string; version: number; value: Record<string, unknown> }>
      >(
        `SELECT "key", "version", "value" FROM ${SETTINGS} WHERE "key" IN ('keys','env_key_check')`,
      );
      const keysVersion = settings.find((s) => s.key === 'keys')?.version ?? 1;
      const envRow = settings.find((s) => s.key === 'env_key_check');
      const a = rows[0];
      const signature = [
        a?.id ?? '-',
        a ? new Date(a.updatedAt).toISOString() : '-',
        a?.verify_state ?? '-',
        keysVersion,
        envRow?.version ?? 0,
      ].join('|');
      const envCheck =
        envRow && typeof envRow.value?.fingerprint === 'string'
          ? {
              fingerprint: envRow.value.fingerprint,
              state:
                typeof envRow.value.state === 'string'
                  ? envRow.value.state
                  : 'unverified',
            }
          : null;

      if (this.snap?.signature !== signature) {
        let active: ActiveSnap | null = null;
        if (a) {
          const prev = this.snap?.active;
          let lease: AnthropicClientLease | null = null;
          let unreadable = false;
          if (prev && prev.id === a.id && prev.lease && !prev.unreadable) {
            lease = { ...prev.lease, configVersion: keysVersion };
          } else {
            const read = await readAnthropicKey(
              this.ds.manager,
              this.env.cipher,
              this.env.appEnv,
              { id: a.id },
            );
            if (!read || read.unreadable) {
              unreadable = true;
            } else {
              const client: AnthropicClientLike | null = buildAnthropicClient(
                this.factory,
                read.key,
                this.logger,
              );
              if (client) {
                lease = {
                  client,
                  keyId: a.id,
                  source: 'ui',
                  fingerprint: a.fingerprint,
                  configVersion: keysVersion,
                };
                this.rememberKey(a.fingerprint, read.key);
              }
            }
          }
          active = {
            id: a.id,
            fingerprint: a.fingerprint,
            key_hint: a.key_hint,
            label: a.label,
            verify_state: a.verify_state,
            updatedAt: new Date(a.updatedAt).toISOString(),
            unreadable,
            lease,
          };
          if (unreadable) void this.auditUnreadable(active);
        }
        this.snap = { signature, configVersion: keysVersion, active, envCheck };
      }
      this.loadedAt = new Date();
      if (this.stale)
        this.logger.log("AI sozlamasi qayta o'qildi (config_stale tugadi)");
      this.stale = false;
      this.staleAlerted = false;
    } catch (err) {
      this.stale = true;
      if (!this.staleAlerted) {
        this.staleAlerted = true;
        this.logger.warn(
          `AI sozlamasini o'qib bo'lmadi — ${this.snap ? "oxirgi ma'lum holat" : "AI o'chiq"}: ${(err as Error)?.name ?? 'Error'}`,
        );
        await this.activity
          .log({
            entity_type: 'AiRuntime',
            entity_id: 'config',
            action: 'ai.config.stale',
            user_name: 'Tizim',
            user_role: 'system',
            metadata: { has_last_known_good: !!this.snap },
            description: "AI sozlamasi o'qilmadi",
          })
          .catch(() => undefined);
      }
    }
  }

  private touch(id: string): void {
    const now = Date.now();
    if (now - (this.lastTouch.get(id) ?? 0) < AI_RUNTIME_LAST_USED_MS) return;
    this.lastTouch.set(id, now);
    this.ds
      .query(`UPDATE ${KEYS} SET "last_used_at" = now() WHERE "id" = $1`, [id])
      .catch(() => undefined);
  }

  private async auditUnreadable(a: ActiveSnap): Promise<void> {
    if (this.unreadableAudited.has(a.id)) return;
    this.unreadableAudited.add(a.id);
    const ref = {
      hint: formatAiKeyHint(a.key_hint),
      fingerprint: a.fingerprint,
      label: a.label,
      source: 'ui',
    };
    try {
      const row = await this.ds.transaction((m) =>
        this.activity.logWithin(m, {
          entity_type: 'AiProviderKey',
          entity_id: a.id,
          action: 'ai.key.unreadable',
          user_name: 'Tizim',
          user_role: 'system',
          metadata: { key_from: ref },
          description: `Saqlangan AI kalitini ochib bo'lmadi (${ref.hint}) — AI to'xtagan`,
        }),
      );
      void this.notifier?.notify({
        action: 'ai.key.unreadable',
        auditId: String(row.id),
        hint: ref.hint,
      });
    } catch {
      this.unreadableAudited.delete(a.id); // keyingi yangilanishda qayta urinish
    }
  }

  /** 401 — o'sha kalit bilan bepul `models.list` tasdig'i (kalitga 60 s da ≤ 1). */
  private confirm401(lease: AnthropicClientLease): Promise<void> {
    const now = Date.now();
    const prev = this.confirmations.get(lease.fingerprint);
    if (prev && now - prev.at < AI_RUNTIME_CONFIRM_INTERVAL_MS) return prev.p;
    const p = (async () => {
      const key = this.keys.get(lease.fingerprint);
      if (!key) return; // kalit xotirada yo'q — tasdiqlab bo'lmaydi (o'zgarish yo'q)
      const r = await this.verifier.verify(key, 5000);
      if (!r.ok && r.code === C.KEY_REJECTED) {
        await this.markKey(lease, 'rejected', C.KEY_REJECTED);
      }
    })().catch(() => undefined);
    this.confirmations.set(lease.fingerprint, { at: now, p });
    return p;
  }

  /** Holat + audit (bitta tranzaksiya) → inbox → yangilash. Takror holat — jim. */
  async markKey(
    lease: AnthropicClientLease,
    state: 'rejected' | 'billing' | 'forbidden',
    code: string,
  ): Promise<void> {
    try {
      const result = await this.ds.transaction(async (m) => {
        let ref: {
          hint: string;
          fingerprint: string;
          label: string | null;
          source: 'ui' | 'env';
        };
        let entityId: string;
        if (lease.keyId) {
          const rows = await m.query<
            Array<{
              key_hint: string;
              fingerprint: string;
              label: string | null;
            }>
          >(
            `UPDATE ${KEYS}
                SET "verify_state" = $2::varchar, "verify_origin" = 'runtime',
                    "verify_error_code" = $3::varchar, "verified_at" = now(),
                    "rejected_at" = CASE WHEN $2::varchar = 'rejected' THEN now() ELSE "rejected_at" END,
                    "updatedAt" = now()
              WHERE "id" = $1 AND "verify_state" <> $2::varchar AND "status" <> 'retired'
              RETURNING "key_hint", "fingerprint", "label"`,
            [lease.keyId, state, code],
          );
          // Postgres + RETURNING: TypeORM `[rows, count]` qaytaradi.
          const list = (Array.isArray(rows[0])
            ? rows[0]
            : rows) as unknown as Array<{
            key_hint: string;
            fingerprint: string;
            label: string | null;
          }>;
          const row = list[0];
          if (!row || typeof row.fingerprint !== 'string') return null;
          ref = {
            hint: formatAiKeyHint(row.key_hint),
            fingerprint: row.fingerprint,
            label: row.label,
            source: 'ui',
          };
          entityId = lease.keyId;
        } else {
          const cur = await m.query<Array<{ value: Record<string, unknown> }>>(
            `SELECT "value" FROM ${SETTINGS} WHERE "key" = 'env_key_check' FOR UPDATE`,
          );
          const v = cur[0]?.value ?? {};
          if (v.fingerprint === lease.fingerprint && v.state === state)
            return null;
          await m.query(
            `INSERT INTO ${SETTINGS} ("key", "value", "version") VALUES ('env_key_check', $1::jsonb, 1)
             ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value",
               "version" = ${SETTINGS}."version" + 1, "updatedAt" = now()`,
            [
              JSON.stringify({
                fingerprint: lease.fingerprint,
                state,
                origin: 'runtime',
                checked_at: new Date().toISOString(),
                error_code: code,
              }),
            ],
          );
          const envKey = this.env.envKey;
          ref = {
            hint: envKey ? formatAiKeyHint(envKey.slice(-4)) : 'sk-ant-…',
            fingerprint: lease.fingerprint,
            label: null,
            source: 'env',
          };
          entityId = `env:${lease.fingerprint}`;
        }
        const audit = await this.activity.logWithin(m, {
          entity_type: 'AiProviderKey',
          entity_id: entityId,
          action: 'ai.key.runtime_failure',
          user_name: 'Tizim',
          user_role: 'system',
          new_value: { verify_state: state },
          metadata: { key_from: ref, verify_state: state, error_code: code },
          description: `AI kaliti ishlamay qoldi (${ref.hint}): ${code}`,
        });
        return { auditId: String(audit.id), hint: ref.hint };
      });
      if (!result) return;
      this.logger.warn(
        `ai_key_runtime_failure state=${state} source=${lease.source}`,
      );
      void this.notifier?.notify({
        action: 'ai.key.runtime_failure',
        auditId: result.auditId,
        hint: result.hint,
        detail: code,
      });
      await this.refresh();
    } catch (err) {
      this.logger.warn(
        `AI kaliti holatini yozib bo'lmadi: ${(err as Error)?.name ?? 'Error'}`,
      );
    }
  }

  private async markSlotUnavailable(feature: string): Promise<void> {
    const slot = featureSlot(feature);
    if (!slot || this.unavailable.has(slot)) return;
    this.unavailable.add(slot);
    try {
      const row = await this.ds.transaction((m) =>
        this.activity.logWithin(m, {
          entity_type: 'AiModelSlot',
          entity_id: slot,
          action: 'ai.models.unavailable',
          user_name: 'Tizim',
          user_role: 'system',
          metadata: { slot, error_code: 'not_found' },
          description: `AI modeli mavjud emas (${slot})`,
        }),
      );
      void this.notifier?.notify({
        action: 'ai.models.unavailable',
        auditId: String(row.id),
        detail: `Vazifa: ${slot}`,
      });
    } catch {
      /* audit yiqilsa ham holat xotirada */
    }
  }
}
