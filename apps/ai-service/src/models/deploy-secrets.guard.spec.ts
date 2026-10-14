import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * LP3RKvXY #5/#6 — AI kaliti repoga TUSHMAYDI (TC9, TC10, TC11).
 *
 * ⚠️ Kalit faqat serverdagi `.env.production` da (SSH orqali, deploy'dan
 * OLDIN). `docker-compose.prod.yml` `environment:` blokiga literal yozilsa
 * gitleaks CI'ni to'xtatadi, lekin lokal commit tarixida baribir qoladi —
 * bu test o'sha holatni commit'dan oldin ushlaydi.
 */
const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** Anthropic kalitining haqiqiy shakli (gitleaks default qoidasi bilan bir xil g'oya). */
const REAL_KEY_RE = /sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/;

describe('AI kaliti repoda yo‘q (LP3RKvXY)', () => {
  it('TC10: docker-compose.prod.yml da literal ANTHROPIC_API_KEY/sk-ant- yo‘q', () => {
    const compose = read('docker-compose.prod.yml');
    expect(compose).not.toMatch(/sk-ant-/);
    // Faqat izohda eslatilishi mumkin — `KEY: qiymat` / `KEY=qiymat` shaklida emas.
    expect(compose).not.toMatch(/^\s*-?\s*ANTHROPIC_API_KEY\s*[:=]/m);
  });

  it('TC10: hamma docker-compose fayllarida ham haqiqiy kalit shakli yo‘q', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.prod.yml']) {
      expect(read(file)).not.toMatch(REAL_KEY_RE);
    }
  });

  it("TC9: .env.example da ANTHROPIC_API_KEY qiymati bo'sh yoki __REPLACE_WITH…__ placeholder", () => {
    const lines = read('.env.example')
      .split('\n')
      .filter((l) => /^\s*#?\s*ANTHROPIC_API_KEY\s*=/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const value = line.split('=').slice(1).join('=').trim();
      const placeholder =
        value === '' || /__REPLACE_WITH[A-Za-z0-9_]*__/.test(value);
      expect(placeholder).toBe(true);
      expect(value).not.toMatch(REAL_KEY_RE);
    }
  });

  it('TC9: gitleaks allowlist .env.example va __REPLACE_WITH…__ ni qamraydi', () => {
    const toml = read('.gitleaks.toml');
    expect(toml).toContain('useDefault = true');
    expect(toml).toContain(String.raw`\.env\.example$`);
    expect(toml).toContain('__REPLACE_WITH[A-Za-z0-9_]*__');
  });

  it('TC11: README deploy bo‘limida AI tartibi yozilgan (avval .env, keyin push)', () => {
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('## Deployment'));
    expect(section).toContain('ANTHROPIC_API_KEY');
    const envStep = section.indexOf('.env.production');
    const pushStep = section.search(/push|merge/i);
    expect(envStep).toBeGreaterThan(-1);
    expect(pushStep).toBeGreaterThan(envStep);
  });
});
