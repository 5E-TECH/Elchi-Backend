import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * Migration ordering guard (audit devops): TypeORM runs migrations in timestamp
 * order, so two migrations sharing a timestamp have an UNDEFINED relative order
 * — a latent bug the moment one depends on the other. This test scans the
 * migrations/ directory and fails if any NEW timestamp collision is introduced.
 *
 * The three pairs below are grandfathered: they already ran in production (so
 * they cannot be renumbered) and each pair touches unrelated tables, making
 * their order immaterial. Do NOT extend this allowlist to silence a new
 * collision — give the new migration a unique, later timestamp instead.
 */
const GRANDFATHERED_COLLISIONS = new Set([
  '1715000000000', // AddBranchCashboxAndHistorySourceType + CreateActivityLogsInIntegrationSchema
  '1716000000008', // CreateNotifications + MigrateManagerCashboxesToBranch
  '1716000000009', // ExtendActivityLogsCoverage + AddOrderBranchCashboxAmount
]);

describe('migration timestamps are collision-free', () => {
  const migrationsDir = join(__dirname, '..', '..', '..', 'migrations');

  it('finds the migrations directory', () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('has no NEW timestamp collisions (grandfathered pairs excepted)', () => {
    const byTimestamp = new Map<string, string[]>();
    for (const file of readdirSync(migrationsDir)) {
      const match = /^(\d+)-.+\.ts$/.exec(file);
      if (!match) continue;
      const ts = match[1];
      const list = byTimestamp.get(ts) ?? [];
      list.push(file);
      byTimestamp.set(ts, list);
    }

    const newCollisions = [...byTimestamp.entries()]
      .filter(
        ([ts, files]) => files.length > 1 && !GRANDFATHERED_COLLISIONS.has(ts),
      )
      .map(([ts, files]) => `${ts}: ${files.sort().join(', ')}`);

    expect(newCollisions).toEqual([]);
  });

  it('every grandfathered timestamp still actually collides (keep the list honest)', () => {
    const counts = new Map<string, number>();
    for (const file of readdirSync(migrationsDir)) {
      const match = /^(\d+)-.+\.ts$/.exec(file);
      if (!match) continue;
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
    const staleAllowlistEntries = [...GRANDFATHERED_COLLISIONS].filter(
      (ts) => (counts.get(ts) ?? 0) < 2,
    );
    expect(staleAllowlistEntries).toEqual([]);
  });

  /**
   * (be-brief §4) Parallel sessiyalar bir xil migratsiya raqami yoki klass
   * nomini olib qo'yishi mumkin: TypeORM ikki xil migratsiyani bir xil `name`
   * bilan BITTA deb hisoblaydi (ikkinchisi jimgina yurmaydi). Klass nomi va
   * `name` maydoni noyob bo'lishi va fayl timestamp'iga mos kelishi SHART.
   */
  it('migratsiya klass nomlari noyob va timestamp bilan tugaydi', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('fs') as typeof import('fs');
    const byClass = new Map<string, string[]>();
    const mismatched: string[] = [];
    for (const file of readdirSync(migrationsDir)) {
      const match = /^(\d+)-.+\.ts$/.exec(file);
      if (!match) continue;
      const src = readFileSync(join(migrationsDir, file), 'utf8');
      const cls = /export class (\w+)/.exec(src)?.[1];
      if (!cls) {
        mismatched.push(`${file}: klass yo'q`);
        continue;
      }
      byClass.set(cls, [...(byClass.get(cls) ?? []), file]);
      const name = /\bname\s*=\s*'([^']+)'/.exec(src)?.[1];
      if (name !== undefined && name !== cls) {
        mismatched.push(`${file}: name='${name}' ≠ ${cls}`);
      }
      if (!GRANDFATHERED_COLLISIONS.has(match[1]) && !cls.endsWith(match[1])) {
        mismatched.push(
          `${file}: klass ${cls} timestamp ${match[1]} bilan tugamaydi`,
        );
      }
    }
    const dupes = [...byClass.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([c, files]) => `${c}: ${files.join(', ')}`);
    expect(dupes).toEqual([]);
    expect(mismatched).toEqual([]);
  });
});
