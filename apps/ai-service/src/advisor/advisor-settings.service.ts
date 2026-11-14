import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AI_ADVISOR_ERROR_CODES,
  AI_ADVISOR_RULE_LIMITS,
  ActivityLogService,
  type AiAdvisorRequester,
  type AiAdvisorRulesSettings,
  type AiAdvisorSettingsView,
} from '@app/common';
import { advisorError } from './advisor-errors';
import {
  changesToAudit,
  effectiveRules,
  parseSettingsPatch,
} from './advisor-settings.rules';

const TABLE = 'ai_schema.ai_advisor_settings';
export const ADVISOR_RULES_KEY = 'rules';

interface SettingRow {
  key: string;
  value: unknown;
  version: number;
  updated_by: string | null;
  updated_by_name: string | null;
  updatedAt: Date;
}

/**
 * BE-5 — `GET/PATCH /ai/advisor/settings` (§7.6–7.7).
 *
 * Saqlash: `ai_advisor_settings` — har kalit alohida qator (`rules`; BE-1
 * keyin `telegram`/`budget`/`schedule`). API `version` = barcha qatorlar
 * ichida MAX(version) (qator yo'q — 1). PATCH bitta tranzaksiyada barcha
 * qatorlarni `FOR UPDATE` bilan qulflaydi → ikki superadmin bir vaqtda
 * saqlasa, ikkinchisi 409 `AI_ADVISOR_SETTINGS_CONFLICT`.
 *
 * O'zgarishsiz PATCH (bo'sh yoki ayni qiymatlar) — version oshmaydi, audit
 * yozilmaydi, 200 joriy sozlamalar bilan.
 */
@Injectable()
export class AdvisorSettingsService {
  private readonly logger = new Logger(AdvisorSettingsService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly activityLog: ActivityLogService,
  ) {}

  /** Qoidalar dvigateli uchun: joriy (sukut bilan to'ldirilgan) qoidalar. */
  async getRules(): Promise<AiAdvisorRulesSettings> {
    const rows = await this.readRows();
    return effectiveRules(rows.find((r) => r.key === ADVISOR_RULES_KEY)?.value);
  }

  async get(): Promise<AiAdvisorSettingsView> {
    return this.toView(await this.readRows());
  }

  async update(
    requester: AiAdvisorRequester,
    patch: unknown,
  ): Promise<AiAdvisorSettingsView> {
    const outcome = await this.ds.transaction(async (m) => {
      await m.query(
        `INSERT INTO ${TABLE} ("key", "value", "version") VALUES ($1, '{}'::jsonb, 1)
         ON CONFLICT ("key") DO NOTHING`,
        [ADVISOR_RULES_KEY],
      );
      const rows = await m.query<SettingRow[]>(
        `SELECT "key", "value", "version", "updated_by", "updated_by_name", "updatedAt"
           FROM ${TABLE} WHERE "is_deleted" = false ORDER BY "key" FOR UPDATE`,
      );
      const current = effectiveRules(
        rows.find((r) => r.key === ADVISOR_RULES_KEY)?.value,
      );
      // Tana avval tekshiriladi (400), keyin versiya (409) — FE xato
      // maydonni ko'rsatadi, eskirgan versiyada qayta o'qiydi.
      const parsed = parseSettingsPatch(patch, current);
      const currentVersion = maxVersion(rows);
      if (parsed.version !== currentVersion) {
        throw advisorError(
          409,
          AI_ADVISOR_ERROR_CODES.SETTINGS_CONFLICT,
          "Sozlamalar boshqa oynada o'zgargan",
          { version: currentVersion },
        );
      }
      if (parsed.changes.length === 0) {
        return { rows, parsed, version: currentVersion };
      }
      const version = currentVersion + 1;
      await m.query(
        `UPDATE ${TABLE}
            SET "value" = $2::jsonb, "version" = $3, "updated_by" = $4,
                "updated_by_name" = $5, "updatedAt" = now()
          WHERE "key" = $1`,
        [
          ADVISOR_RULES_KEY,
          JSON.stringify(storedRules(parsed.rules)),
          version,
          requester.id,
          requester.name ? String(requester.name).slice(0, 200) : null,
        ],
      );
      const fresh = await m.query<SettingRow[]>(
        `SELECT "key", "value", "version", "updated_by", "updated_by_name", "updatedAt"
           FROM ${TABLE} WHERE "is_deleted" = false ORDER BY "key"`,
      );
      return { rows: fresh, parsed, version };
    });

    if (outcome.parsed.changes.length > 0) {
      await this.audit(requester, outcome.parsed.changes, outcome.version);
    }
    return this.toView(outcome.rows);
  }

  private async audit(
    requester: AiAdvisorRequester,
    changes: ReturnType<typeof parseSettingsPatch>['changes'],
    version: number,
  ): Promise<void> {
    try {
      const { old_value, new_value } = changesToAudit(changes);
      await this.activityLog.log({
        entity_type: 'ai_advisor_settings',
        entity_id: ADVISOR_RULES_KEY,
        action: 'ai.advisor.settings.update',
        old_value,
        new_value,
        user_id: requester.id,
        user_name: requester.name ?? null,
        user_role: requester.roles.join(',').slice(0, 32) || null,
        metadata: { version, changes: changes.length },
        description: `AI maslahatchi sozlamalari o'zgartirildi (${changes.length} ta)`,
      });
    } catch (err) {
      // Audit best-effort (§11): haqiqat manbai — sozlama qatori.
      this.logger.warn(
        `ai_advisor_settings_audit_failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  private async readRows(): Promise<SettingRow[]> {
    return await this.ds.query<SettingRow[]>(
      `SELECT "key", "value", "version", "updated_by", "updated_by_name", "updatedAt"
         FROM ${TABLE} WHERE "is_deleted" = false ORDER BY "key"`,
    );
  }

  private toView(rows: SettingRow[]): AiAdvisorSettingsView {
    const rulesRow = rows.find((r) => r.key === ADVISOR_RULES_KEY);
    const latest = rows
      .filter((r) => r.updated_by !== null || r.version > 1)
      .sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt))[0];
    return {
      version: maxVersion(rows),
      rules: effectiveRules(rulesRow?.value),
      limits: {
        rules: structuredClone(AI_ADVISOR_RULE_LIMITS),
      },
      telegram: null,
      budget: null,
      schedule: null,
      updated_at: latest ? new Date(latest.updatedAt).toISOString() : null,
      updated_by:
        latest && latest.updated_by
          ? {
              id: String(latest.updated_by),
              name: latest.updated_by_name ?? null,
            }
          : null,
    };
  }
}

function maxVersion(rows: SettingRow[]): number {
  return rows.reduce((max, r) => Math.max(max, Number(r.version) || 1), 1);
}

function toTime(v: Date | string): number {
  return new Date(v).getTime();
}

/** Saqlanadigan shakl: `severity` yo'q (Q1 — doim kodda qotirilgan). */
function storedRules(rules: AiAdvisorRulesSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    const { severity: _severity, ...rest } = rule;
    void _severity;
    out[key] = rest;
  }
  return out;
}
