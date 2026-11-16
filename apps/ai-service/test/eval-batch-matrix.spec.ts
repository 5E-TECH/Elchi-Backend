import {
  BATCH_DISCOUNT,
  captureBodies,
  matrix,
  paramsFor,
  plan,
} from '../../../scripts/ai/eval-batch-matrix';
import { loadFixtures } from './eval/order-extract-eval';

/** P2 batch matritsasi — tarmoqsiz (tana ushlash va reja). */
describe('eval-batch-matrix (P2)', () => {
  const fixtures = loadFixtures().slice(0, 3);

  it('haqiqiy servis tanasi ushlanadi: system kesh, sxema, maskalangan matn', async () => {
    const bodies = await captureBodies(fixtures);
    expect(bodies.size).toBe(3);
    const b = [...bodies.values()][0];
    expect(
      (b.system as { cache_control?: unknown }[])[0].cache_control,
    ).toEqual({
      type: 'ephemeral',
    });
    expect(JSON.stringify(b.messages)).not.toMatch(/\d{9}/);
    expect(b.output_config).toHaveProperty('format');
  });

  it('paramsFor: model va effort sozlamadan; effort qabul qilmaydigan modelda yo‘q', async () => {
    const [body] = [...(await captureBodies(fixtures)).values()];
    const p = paramsFor(body, {
      id: 'x',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      expectedOutputTokens: 1,
    });
    expect(p.model).toBe('claude-sonnet-5-5');
    expect((p.output_config as { effort?: string }).effort).toBe('high');
    const h = paramsFor(body, {
      id: 'y',
      model: 'claude-haiku-4-5',
      effort: 'low',
      expectedOutputTokens: 1,
    });
    expect(h.output_config).not.toHaveProperty('effort');
  });

  it('reja: 6 sozlama, batch chegirmasi, yuqori chegara ≥ kutilgan', async () => {
    const bodies = await captureBodies(fixtures);
    const rows = plan(bodies, matrix('claude-sonnet-5'), 2);
    expect(rows.map((r) => r.config)).toEqual([
      'baseline',
      'sonnet55-low',
      'sonnet55-medium',
      'sonnet55-high',
      'opus55-low',
      'haiku55-low',
    ]);
    expect(BATCH_DISCOUNT).toBe(0.5);
    for (const r of rows) {
      expect(r.requests).toBe(6);
      expect(r.upperUsd).toBeGreaterThanOrEqual(r.expectedUsd);
      expect(r.expectedUsd).toBeGreaterThan(0);
    }
  });
});
