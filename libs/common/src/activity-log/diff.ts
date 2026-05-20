const DEFAULT_IGNORED_FIELDS = new Set([
  'updatedAt',
  'updated_at',
  'createdAt',
  'created_at',
]);

export interface DiffResult {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * Compute a minimal diff between two records. Only fields that actually
 * changed appear in the output. Audit logs stay small, and downstream
 * consumers (UI, exports) don't have to filter out unchanged columns.
 *
 * Timestamps that always change on UPDATE (updatedAt) are skipped by default;
 * pass extra field names via `ignore` when a domain entity has more.
 */
export function computeDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  ignore: Iterable<string> = [],
): DiffResult {
  const ignored = new Set([...DEFAULT_IGNORED_FIELDS, ...ignore]);
  const beforeObj = before ?? {};
  const afterObj = after ?? {};
  const keys = new Set<string>([
    ...Object.keys(beforeObj),
    ...Object.keys(afterObj),
  ]);

  const diff: DiffResult = { before: {}, after: {} };
  for (const key of keys) {
    if (ignored.has(key)) continue;
    const a = beforeObj[key];
    const b = afterObj[key];
    if (!equal(a, b)) {
      diff.before[key] = a;
      diff.after[key] = b;
    }
  }
  return diff;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return a === b;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}
