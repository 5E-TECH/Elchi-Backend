import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLog } from '@app/common';

/**
 * `GET /ai/config/history` — `activity_logs` (ai_schema) dagi `ai.key.*` va
 * `ai.models.*` qatorlari, eng yangisi tepada, kursor bilan.
 *
 * `details` faqat metadata'dagi xavfsiz maydonlardan quriladi (kalit
 * havolalari = hint/iz/nom). Kursor — `{ts,id}` ning base64url'i.
 */
export const AI_CONFIG_HISTORY_ACTIONS = [
  'ai.key.add',
  'ai.key.replace',
  'ai.key.restore',
  'ai.key.deactivate',
  'ai.key.forget',
  'ai.key.verify',
  'ai.key.runtime_failure',
  'ai.key.unreadable',
  'ai.key.attempt_rejected',
  'ai.key.reencrypt',
  'ai.models.update',
  'ai.models.auto_revert',
  'ai.models.unavailable',
] as const;

const DETAIL_KEYS = [
  'key_from',
  'key_to',
  'verify_state',
  'error_code',
  'slot',
  'attempts',
  'models',
  'reencrypted',
] as const;

interface Cursor {
  ts: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128)
    return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      ts?: unknown;
      id?: unknown;
    };
    if (
      typeof c.ts === 'string' &&
      !Number.isNaN(Date.parse(c.ts)) &&
      typeof c.id === 'string' &&
      /^\d{1,20}$/.test(c.id)
    )
      return { ts: c.ts, id: c.id };
  } catch {
    /* noto'g'ri kursor — birinchi sahifa */
  }
  return null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);

@Injectable()
export class AiConfigHistoryService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async page(query: { limit?: unknown; cursor?: unknown }): Promise<{
    items: Array<Record<string, unknown>>;
    next_cursor: string | null;
  }> {
    const n = Number(query?.limit ?? 10);
    const limit = Number.isInteger(n) ? Math.min(50, Math.max(1, n)) : 10;
    const cursor = decodeCursor(query?.cursor);
    const qb = this.ds
      .getRepository(ActivityLog)
      .createQueryBuilder('a')
      .where('a.action IN (:...actions)', {
        actions: [...AI_CONFIG_HISTORY_ACTIONS],
      })
      .orderBy('a.created_at', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .take(limit + 1);
    if (cursor) {
      qb.andWhere(
        '(a.created_at < :ts OR (a.created_at = :ts AND a.id < :id))',
        { ts: cursor.ts, id: cursor.id },
      );
    }
    const rows = await qb.getMany();
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.item(r)),
      next_cursor:
        more && last
          ? encodeCursor({
              ts: new Date(last.created_at).toISOString(),
              id: String(last.id),
            })
          : null,
    };
  }

  private item(r: ActivityLog): Record<string, unknown> {
    const meta: Record<string, unknown> = r.metadata ?? {};
    const details: Record<string, unknown> = {};
    for (const k of DETAIL_KEYS) {
      if (meta[k] !== undefined) details[k] = meta[k];
    }
    return {
      id: String(r.id),
      action: r.action,
      created_at: new Date(r.created_at).toISOString(),
      actor: r.user_id ? { id: r.user_id, name: r.user_name ?? null } : null,
      details,
      reason: str(meta.reason),
      context: { ip: str(meta.ip), device: str(meta.device_name) },
    };
  }
}
