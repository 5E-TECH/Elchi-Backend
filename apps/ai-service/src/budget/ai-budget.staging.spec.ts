import type { ConfigService } from '@nestjs/config';
import type { ActivityLogService } from '@app/common';
import type { AiSpendCounterService } from '../usage/ai-spend-counter.service';
import type { AiBudgetNotifier } from './ai-budget.notifier';
import { AiBudgetService } from './ai-budget.service';

/**
 * (staging-safe) APP_ENV=staging: global kunlik AI shifti
 * min(AI_DAILY_USD_CAP, STAGING_AI_DAILY_USD_CAP — sukut 2 USD).
 * production'da AI_DAILY_USD_CAP o'zgarishsiz.
 */
describe('AiBudgetService — staging qattiq shifti', () => {
  const OLD = { ...process.env };

  const build = (config: Record<string, unknown>) => {
    const counter = {
      read: jest.fn().mockResolvedValue({
        cost_usd: 3,
        override_usd: 0,
        exceeded_at: new Date(),
      }),
    } as unknown as AiSpendCounterService;
    return new AiBudgetService(
      counter,
      { notify: jest.fn() } as unknown as AiBudgetNotifier,
      { log: jest.fn() } as unknown as ActivityLogService,
      { get: (key: string) => config[key] } as unknown as ConfigService,
    );
  };

  afterEach(() => {
    process.env = { ...OLD };
  });

  it('production: AI_DAILY_USD_CAP=50 — 3 USD sarf bilan ochiq', async () => {
    delete process.env.APP_ENV;
    const budget = build({ AI_DAILY_USD_CAP: 50 });
    await expect(budget.check()).resolves.toEqual({ ok: true });
    expect((await budget.status()).cap_usd).toBe(50);
  });

  it('staging: sukut 2 USD shift — 3 USD sarf bilan YOPIQ', async () => {
    process.env.APP_ENV = 'staging';
    delete process.env.STAGING_AI_DAILY_USD_CAP;
    const budget = build({ AI_DAILY_USD_CAP: 50 });
    await expect(budget.check()).resolves.toMatchObject({
      ok: false,
      reason: 'cap_exceeded',
    });
    expect((await budget.status()).cap_usd).toBe(2);
  });

  it('staging: STAGING_AI_DAILY_USD_CAP env bilan, lekin AI_DAILY_USD_CAP dan oshmaydi', async () => {
    process.env.APP_ENV = 'staging';
    process.env.STAGING_AI_DAILY_USD_CAP = '5';
    expect((await build({ AI_DAILY_USD_CAP: 50 }).status()).cap_usd).toBe(5);
    expect((await build({ AI_DAILY_USD_CAP: 1 }).status()).cap_usd).toBe(1);
  });
});
