import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// js-yaml — @nestjs/swagger orqali o'rnatilgan (package-lock: node_modules/js-yaml).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load: (text: string) => unknown };
import {
  RECEIVE_BY_SCAN_OUTCOMES,
  receiveByScanTotal,
  recordReceiveByScanOutcome,
  registerMetrics,
} from './metrics';

/**
 * n9o0KYd5 — MONITORING TESTI: received=0 bo'lgan receive-by-scan javobi
 * alert qo'zg'atadi.
 *
 *   1. Qoida fayli (alerts/receive-by-scan.rules.yml) haqiqiy metrika nomi va
 *      `received=0` javobi beradigan `outcome` qiymatiga quriladi;
 *   2. /metrics: seriya 0 bilan oldindan bor, bitta received=0 javob uni 1 ga
 *      oshiradi — ya'ni `increase(...[15m]) > 0` sharti bajariladi (birinchi
 *      hodisa ham ko'rinadi);
 *   3. promtool bo'lsa (`PROMTOOL_BIN` yoki PATH) — `check rules` va
 *      `test rules` (alert_rule_test: qo'zg'aladi / o'chadi) haqiqiy dvigatelda.
 *
 * ⚠️ Repoda Prometheus/Alertmanager yo'q — qoida infra'ga ulanishi kerak
 * (fayl boshidagi izoh).
 */
const ALERTS_DIR = join(__dirname, 'alerts');
const RULES_FILE = join(ALERTS_DIR, 'receive-by-scan.rules.yml');
const RULES_TEST_FILE = join(ALERTS_DIR, 'receive-by-scan.rules.test.yml');

type Rule = {
  alert: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
};

const loadRules = (): Rule[] => {
  const doc = yaml.load(readFileSync(RULES_FILE, 'utf8')) as {
    groups: Array<{ name: string; rules: Rule[] }>;
  };
  return doc.groups.flatMap((group) => group.rules);
};

/** Fake Nest ilovasi — `registerMetrics` ning /metrics marshruti. */
function scrapeable() {
  const routes: Record<string, (req: unknown, res: unknown) => void> = {};
  const app = {
    getHttpAdapter: () => ({
      get: (path: string, handler: (req: unknown, res: unknown) => void) => {
        routes[path] = handler;
      },
    }),
    use: jest.fn(),
  };
  registerMetrics(app as never, 'api-gateway');
  return () =>
    new Promise<string>((resolve) => {
      routes['/metrics']({}, { setHeader: jest.fn(), end: resolve });
    });
}

const sampleOf = (body: string, outcome: string): number | null => {
  const match = new RegExp(
    `^receive_by_scan_total\\{outcome="${outcome}",service="api-gateway"\\} (\\d+(?:\\.\\d+)?)$`,
    'm',
  ).exec(body);
  return match ? Number(match[1]) : null;
};

const resolvePromtool = (): string | null => {
  const candidates = [process.env.PROMTOOL_BIN, 'promtool'].filter(
    (value): value is string => Boolean(value),
  );
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch {
      // keyingisi
    }
  }
  return null;
};

describe('n9o0KYd5 — receive-by-scan received=0 alert qoidasi', () => {
  it('⭐ qoida haqiqiy metrika va received=0 natijasiga quriladi (warning + critical)', () => {
    const rules = loadRules();
    const byName = new Map(rules.map((rule) => [rule.alert, rule]));
    // received=0 javobi (ok:false) qaysi outcome'ga tushadi — kodning o'zidan.
    const noneOutcome = recordReceiveByScanOutcome({
      ok: false,
      partial: false,
    });
    expect(noneOutcome).toBe('none');
    const metricName = (receiveByScanTotal as unknown as { name: string }).name;
    expect(metricName).toBe('receive_by_scan_total');

    const warning = byName.get('ReceiveByScanNothingReceived');
    expect(warning).toBeDefined();
    expect(warning?.expr.replace(/\s+/g, ' ').trim()).toBe(
      `sum by (service) (increase(${metricName}{outcome="${noneOutcome}"}[15m])) > 0`,
    );
    expect(warning?.labels).toMatchObject({
      severity: 'warning',
      card: 'n9o0KYd5',
    });
    expect(warning?.annotations?.summary).toContain('received=0');

    const critical = byName.get('ReceiveByScanMostlyFailing');
    expect(critical?.expr).toContain(
      `increase(${metricName}{outcome="${noneOutcome}"}[15m])`,
    );
    expect(critical?.expr).toContain(`increase(${metricName}[15m])`);
    expect(critical?.for).toBe('5m');
    expect(critical?.labels).toMatchObject({ severity: 'critical' });

    // Qoidalarda faqat mavjud label qiymatlari ishlatiladi.
    for (const rule of rules) {
      for (const [, value] of rule.expr.matchAll(/outcome="([^"]+)"/g)) {
        expect(RECEIVE_BY_SCAN_OUTCOMES).toContain(value);
      }
    }
  });

  it('⭐ /metrics: seriya 0 bilan oldindan bor; bitta received=0 javob uni oshiradi → alert sharti (increase > 0) bajariladi', async () => {
    const scrape = scrapeable();
    const before = await scrape();
    for (const outcome of RECEIVE_BY_SCAN_OUTCOMES) {
      // Hech bo'lmasa 0 — `increase()` birinchi hodisani ham ko'radi.
      expect(sampleOf(before, outcome)).not.toBeNull();
    }
    const noneBefore = sampleOf(before, 'none') ?? 0;

    // Gateway receive-by-scan javobi: received=0 → ok:false.
    recordReceiveByScanOutcome({ ok: false, partial: false });
    const after = await scrape();
    const delta = (sampleOf(after, 'none') ?? 0) - noneBefore;

    const threshold = Number(
      /> (\d+(?:\.\d+)?)\s*$/.exec(
        loadRules()
          .find((rule) => rule.alert === 'ReceiveByScanNothingReceived')!
          .expr.trim(),
      )?.[1],
    );
    expect(threshold).toBe(0);
    expect(delta).toBe(1);
    expect(delta > threshold).toBe(true);

    // Muvaffaqiyatli skan 'none' ni oshirmaydi (yolg'on alert yo'q).
    recordReceiveByScanOutcome({ ok: true, partial: false });
    const okOnly = await scrape();
    expect(sampleOf(okOnly, 'none')).toBe(sampleOf(after, 'none'));
  });

  const promtool = resolvePromtool();
  (promtool ? it : it.skip)(
    'promtool: check rules + test rules (alert qo`zg`aladi va o`chadi)',
    () => {
      const run = (args: string[]) =>
        execFileSync(promtool!, args, { cwd: ALERTS_DIR, encoding: 'utf8' });
      expect(run(['check', 'rules', RULES_FILE])).toContain('SUCCESS');
      expect(run(['test', 'rules', RULES_TEST_FILE])).toContain('SUCCESS');
    },
  );
});
