import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import type { Repository } from 'typeorm';
import {
  ActivityLogService,
  ClaudeService,
  NotificationCategory,
  NotificationPriority,
  type AnthropicClientFactory,
  type ClaudeUsageMeta,
  type ClaudeUsageRecord,
  type ExtractJsonOptions,
} from '@app/common';
import { AiUsageLog } from '../entities/ai-usage-log.entity';
import type {
  AiSpendCounterRow,
  AiSpendCounterService,
  AiSpendTotals,
} from '../usage/ai-spend-counter.service';
import { AiUsageService } from '../usage/ai-usage.service';
import { tashkentDay } from '../usage/tashkent-day';
import { AiBudgetNotifier, type AiCapNotification } from './ai-budget.notifier';
import { AiBudgetService } from './ai-budget.service';

// ─── Soxta muhit ──────────────────────────────────────────────────────────

function makeConfig(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string): unknown => values[key],
  } as unknown as ConfigService;
}

/**
 * Xotiradagi `ai_spend_counter` — SQL semantikasi bilan bir xil:
 * add = atomik qo'shish, mark* = `IS NULL` g'olibi, addOverride = +=.
 */
function makeCounter() {
  const rows = new Map<string, AiSpendCounterRow>();
  const ensure = (periodKey: string): AiSpendCounterRow => {
    let row = rows.get(periodKey);
    if (!row) {
      row = {
        period_key: periodKey,
        cost_usd: 0,
        cost_uzs: 0,
        calls: 0,
        override_usd: 0,
        warned_at: null,
        exceeded_at: null,
      };
      rows.set(periodKey, row);
    }
    return row;
  };
  const totals = (row: AiSpendCounterRow): AiSpendTotals => ({
    cost_usd: row.cost_usd,
    override_usd: row.override_usd,
    warned_at: row.warned_at,
    exceeded_at: row.exceeded_at,
  });

  const read = jest.fn((periodKey: string) => {
    const row = rows.get(periodKey);
    return Promise.resolve(row ? { ...row } : null);
  });
  const add = jest.fn((periodKey: string, usd: number, uzs: number) => {
    const row = ensure(periodKey);
    row.cost_usd += usd;
    row.cost_uzs += uzs;
    row.calls += 1;
    return Promise.resolve(totals(row));
  });
  const markWarned = jest.fn((periodKey: string) => {
    const row = rows.get(periodKey);
    if (!row || row.warned_at) return Promise.resolve(false);
    row.warned_at = new Date();
    return Promise.resolve(true);
  });
  const markExceeded = jest.fn((periodKey: string) => {
    const row = rows.get(periodKey);
    if (!row || row.exceeded_at) return Promise.resolve(false);
    row.exceeded_at = new Date();
    return Promise.resolve(true);
  });
  const addOverride = jest.fn((periodKey: string, extraUsd: number) => {
    const row = ensure(periodKey);
    row.override_usd += extraUsd;
    return Promise.resolve(totals(row));
  });

  const counter = {
    read,
    add,
    markWarned,
    markExceeded,
    addOverride,
  } as unknown as AiSpendCounterService;
  return {
    counter,
    rows,
    ensure,
    read,
    add,
    markWarned,
    markExceeded,
    addOverride,
  };
}

function setup(config: Record<string, unknown> = {}) {
  const c = makeCounter();
  const notify = jest
    .fn<Promise<void>, [AiCapNotification]>()
    .mockResolvedValue(undefined);
  const notifier = { notify } as unknown as AiBudgetNotifier;
  const log = jest.fn().mockResolvedValue(undefined);
  const activityLog = { log } as unknown as ActivityLogService;
  const budget = new AiBudgetService(
    c.counter,
    notifier,
    activityLog,
    makeConfig({ AI_USD_UZS_RATE: 12800, ...config }),
  );
  return { ...c, notify, log, budget };
}

const META: ClaudeUsageMeta = {
  feature: 'order_extract_multi',
  requestArea: 'order',
  marketId: '12',
  userId: '34',
  traceId: 'trace-1',
  draftId: '5f2b8c1e-0000-4000-8000-000000000001',
};

function makeRecord(over: Partial<ClaudeUsageRecord> = {}): ClaudeUsageRecord {
  return {
    ...META,
    model: 'claude-sonnet-5',
    inputTokens: 1234,
    outputTokens: 567,
    cacheCreationTokens: 4072,
    cacheReadTokens: 89,
    steps: 1,
    stopReason: 'end_turn',
    outcome: 'ok',
    inputChars: 10,
    inputSha256: 'a'.repeat(64),
    imageCount: 0,
    ...over,
  };
}

function okResponse() {
  return {
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text: JSON.stringify({ orders: [] }) }],
    usage: {
      input_tokens: 1234,
      output_tokens: 567,
      cache_creation_input_tokens: 4072,
      cache_read_input_tokens: 89,
    },
  };
}

/**
 * HAQIQIY ClaudeService (@app/common) + soxta Anthropic fabrikasi +
 * HAQIQIY AiUsageService (sink, soxta repo) + shu AiBudgetService.
 */
function withClaude(config: Record<string, unknown> = {}) {
  const env = setup(config);
  const create = jest.fn().mockResolvedValue(okResponse());
  const factory: AnthropicClientFactory = () => ({ messages: { create } });
  const save = jest.fn().mockResolvedValue({});
  const repo = {
    create: (row: Partial<AiUsageLog>) => row,
    save,
    query: jest.fn(),
  } as unknown as Repository<AiUsageLog>;
  const usage = new AiUsageService(repo, makeConfig(config));
  const claude = new ClaudeService(
    makeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-key', ...config }),
    factory,
    usage,
    env.budget,
  );
  const opts: ExtractJsonOptions = {
    system: 'SYSTEM',
    userText: 'Ali, 2 ta atir',
    schema: { type: 'object' },
    meta: META,
  };
  return { ...env, claude, create, save, usage, opts };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Logger spy chaqiruvlarining birinchi argumenti (xabar matni). */
function messagesOf(spy: jest.SpyInstance): string[] {
  return (spy.mock.calls as unknown[][]).map((c) => String(c[0]));
}

describe('AiBudgetService — global kunlik avariya shifti (wFSMEIIy)', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let info: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    info = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    info.mockRestore();
  });

  describe('ClaudeService + AiBudgetService birgalikda', () => {
    it('#1/#2 (lYVuADRE #10): shift oshgach keyingi chaqiruv cap_exceeded — Anthropic 0 chaqiruv, ai_usage_log qatori YO`Q', async () => {
      const t = withClaude({ AI_DAILY_USD_CAP: 0.01 });

      const first = await t.claude.extractJson(t.opts);
      expect(first.ok).toBe(true);
      await flush();
      expect(t.create).toHaveBeenCalledTimes(1);
      expect(t.save).toHaveBeenCalledTimes(1);
      expect(t.add).toHaveBeenCalledTimes(1);

      const second = await t.claude.extractJson(t.opts);
      await flush();
      expect(second).toMatchObject({
        ok: false,
        reason: 'cap_exceeded',
        scope: 'global',
        attempts: 0,
      });
      // Anthropic'ga YANGI so'rov ketmadi va jurnalga yangi qator qo'shilmadi.
      expect(t.create).toHaveBeenCalledTimes(1);
      expect(t.save).toHaveBeenCalledTimes(1);
      expect(t.add).toHaveBeenCalledTimes(1);
    });

    it('#1: kun boshidanoq shift urilgan bo`lsa create 0 marta, record 0 marta', async () => {
      const t = withClaude({ AI_DAILY_USD_CAP: 5 });
      const today = tashkentDay(new Date());
      t.ensure(today).cost_usd = 5;

      const res = await t.claude.extractJson(t.opts);
      await flush();
      expect(res).toMatchObject({ ok: false, reason: 'cap_exceeded' });
      expect(t.create).not.toHaveBeenCalled();
      expect(t.save).not.toHaveBeenCalled();
      expect(t.add).not.toHaveBeenCalled();
    });

    it('#6 (lYVuADRE #11): hisoblagich o`qilmasa AI O`CHADI (fail-closed) — disabled, Anthropic 0 chaqiruv', async () => {
      const t = withClaude();
      t.read.mockRejectedValue(new Error('connection refused'));

      const res = await t.claude.extractJson(t.opts);
      expect(res).toEqual({ ok: false, reason: 'disabled', attempts: 0 });
      expect(t.create).not.toHaveBeenCalled();
      expect(t.save).not.toHaveBeenCalled();
      const errors = messagesOf(error);
      expect(errors.some((m) => m.includes('ai_cap_check_failed'))).toBe(true);
    });

    it('shift ichida: chaqiruv o`tadi, jurnal + hisoblagich bittadan oshadi', async () => {
      const t = withClaude();
      const res = await t.claude.extractJson(t.opts);
      await flush();
      expect(res.ok).toBe(true);
      expect(t.create).toHaveBeenCalledTimes(1);
      expect(t.save).toHaveBeenCalledTimes(1);
      expect(t.add).toHaveBeenCalledTimes(1);
      const [periodKey, usd] = t.add.mock.calls[0];
      expect(periodKey).toBe(tashkentDay(new Date()));
      expect(usd).toBeCloseTo(
        (1234 * 3 + 567 * 15 + 4072 * 3 * 1.25 + 89 * 3 * 0.1) / 1e6,
        6,
      );
      expect(t.notify).not.toHaveBeenCalled();
    });
  });

  describe('check()', () => {
    it('qator yo`q → spent 0 → ok (bitta PK o`qish, boshqa hisob yo`q)', async () => {
      const t = setup();
      await expect(t.budget.check()).resolves.toEqual({ ok: true });
      expect(t.read).toHaveBeenCalledTimes(1);
      expect(t.add).not.toHaveBeenCalled();
    });

    it('#12: reset_at — javobda KELAJAKDAGI Toshkent yarim tuni', async () => {
      const t = setup({ AI_DAILY_USD_CAP: 10 });
      const now = new Date('2026-09-27T10:00:00Z');
      t.ensure('2026-09-27').cost_usd = 10;
      const res = await t.budget.check(now);
      expect(res).toEqual({
        ok: false,
        reason: 'cap_exceeded',
        scope: 'global',
        reset_at: '2026-09-28T00:00:00+05:00',
      });
      if (!res.ok) {
        expect(new Date(res.reset_at).getTime()).toBeGreaterThan(now.getTime());
      }
    });

    it('#11: period_key Toshkent sanasi bo`yicha (UTC emas)', async () => {
      const t = setup();
      await t.budget.check(new Date('2026-09-26T19:30:00Z'));
      expect(t.read).toHaveBeenLastCalledWith('2026-09-27');
      await t.budget.check(new Date('2026-09-26T18:30:00Z'));
      expect(t.read).toHaveBeenLastCalledWith('2026-09-26');
    });

    it('#18: Toshkent yarim tunida hisoblagich nolga tushadi (yangi kun qatori)', async () => {
      const t = setup({ AI_DAILY_USD_CAP: 10 });
      t.ensure('2026-09-27').cost_usd = 25;
      // 23:59 Toshkent — bloklangan.
      const before = await t.budget.check(new Date('2026-09-27T18:59:00Z'));
      expect(before.ok).toBe(false);
      // 00:00 Toshkent — yangi kun, qator yo'q, ochiq.
      const after = await t.budget.check(new Date('2026-09-27T19:00:00Z'));
      expect(after).toEqual({ ok: true });
    });

    it('#17: shift urilgan, exceeded_at yo`q → bildirishnoma BIR marta (check orqali)', async () => {
      const t = setup({ AI_DAILY_USD_CAP: 10 });
      const now = new Date('2026-09-27T10:00:00Z');
      t.ensure('2026-09-27').cost_usd = 12;
      await t.budget.check(now);
      await t.budget.check(now);
      expect(t.markExceeded).toHaveBeenCalledTimes(1);
      expect(t.notify).toHaveBeenCalledTimes(1);
      expect(t.notify.mock.calls[0][0]).toMatchObject({
        type: 'ai.cap_exceeded',
        priority: NotificationPriority.CRITICAL,
        periodKey: '2026-09-27',
      });
    });

    it('#15: AI_DAILY_USD_CAP env orqali; berilmasa saxovatli sukut (50 USD)', async () => {
      const def = setup();
      await expect(def.budget.status()).resolves.toMatchObject({
        cap_usd: 50,
      });
      const tiny = setup({ AI_DAILY_USD_CAP: 0.01 });
      tiny.ensure(tashkentDay(new Date())).cost_usd = 0.02;
      await expect(tiny.budget.check()).resolves.toMatchObject({
        ok: false,
        reason: 'cap_exceeded',
      });
    });

    it('o`qish xatosi YUTILMAYDI (ClaudeService uni disabled qiladi)', async () => {
      const t = setup();
      t.read.mockRejectedValue(new Error('timeout'));
      await expect(t.budget.check()).rejects.toThrow('timeout');
    });
  });

  describe('onSpend()', () => {
    it('#7: 80% chegara — WARN log + cap_warning bildirishnomasi (high), oqim davom etadi', async () => {
      const t = setup({ AI_DAILY_USD_CAP: 0.03, AI_CAP_WARN_RATIO: 0.8 });
      // sonnet: bitta yozuv ≈ 0.0275 USD → 0.03 shiftning ~92% i.
      await t.budget.onSpend(makeRecord());
      expect(t.markWarned).toHaveBeenCalledTimes(1);
      expect(t.markExceeded).not.toHaveBeenCalled();
      expect(t.notify).toHaveBeenCalledTimes(1);
      expect(t.notify.mock.calls[0][0]).toMatchObject({
        type: 'ai.cap_warning',
        priority: NotificationPriority.HIGH,
      });
      const warns = messagesOf(warn);
      expect(warns.some((m) => m.startsWith('ai_cap_warning'))).toBe(true);
      // Oqim davom etadi — keyingi check ochiq.
      await expect(t.budget.check()).resolves.toEqual({ ok: true });
    });

    it('80% bildirishnomasi kuniga BIR marta (markWarned yutqazsa jim)', async () => {
      const t = setup({ AI_DAILY_USD_CAP: 0.05 });
      await t.budget.onSpend(makeRecord()); // ~55%
      expect(t.notify).not.toHaveBeenCalled();
      await t.budget.onSpend(makeRecord()); // ~110%
      await t.budget.onSpend(makeRecord()); // ~165%
      const types = t.notify.mock.calls.map((c) => c[0].type);
      expect(types).toEqual(['ai.cap_warning', 'ai.cap_exceeded']);
    });

    it('#17: 100% — cap_exceeded bildirishnomasi (critical)', async () => {
      const t = setup({ AI_DAILY_USD_CAP: 0.01 });
      await t.budget.onSpend(makeRecord());
      expect(t.markExceeded).toHaveBeenCalledTimes(1);
      const exceeded = t.notify.mock.calls
        .map((c) => c[0])
        .find((n) => n.type === 'ai.cap_exceeded');
      expect(exceeded).toMatchObject({
        priority: NotificationPriority.CRITICAL,
        capUsd: 0.01,
      });
    });

    it('#3: parallel 10 ta javob — hisoblagich aynan 10 marta oshadi', async () => {
      const t = setup();
      await Promise.all(
        Array.from({ length: 10 }, () => t.budget.onSpend(makeRecord())),
      );
      expect(t.add).toHaveBeenCalledTimes(10);
      const row = t.rows.get(tashkentDay(new Date()));
      expect(row?.calls).toBe(10);
    });

    it('token 0 → hisoblagichga tegilmaydi', async () => {
      const t = setup();
      await t.budget.onSpend(
        makeRecord({
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        }),
      );
      expect(t.add).not.toHaveBeenCalled();
    });

    it('cost_uzs = usd × AI_USD_UZS_RATE', async () => {
      const t = setup();
      await t.budget.onSpend(makeRecord());
      const [, usd, uzs] = t.add.mock.calls[0];
      expect(uzs).toBeCloseTo(usd * 12800, 2);
    });

    it('markWarned xatosi onSpend`ni yiqitmaydi (faqat WARN)', async () => {
      const t = setup({ AI_DAILY_USD_CAP: 0.03 });
      t.markWarned.mockRejectedValue(new Error('lock timeout'));
      await expect(t.budget.onSpend(makeRecord())).resolves.toBeUndefined();
      expect(t.notify).not.toHaveBeenCalled();
    });
  });

  describe('status()', () => {
    it('state ok / warn / exceeded', async () => {
      const t = setup({ AI_DAILY_USD_CAP: 10, AI_CAP_WARN_RATIO: 0.8 });
      const now = new Date('2026-09-27T10:00:00Z');
      await expect(t.budget.status(now)).resolves.toEqual({
        period_key: '2026-09-27',
        spent_usd: 0,
        cap_usd: 10,
        override_usd: 0,
        effective_cap_usd: 10,
        ratio: 0,
        state: 'ok',
        reset_at: '2026-09-28T00:00:00+05:00',
      });
      t.ensure('2026-09-27').cost_usd = 8.5;
      await expect(t.budget.status(now)).resolves.toMatchObject({
        state: 'warn',
        ratio: 0.85,
      });
      t.ensure('2026-09-27').cost_usd = 10;
      await expect(t.budget.status(now)).resolves.toMatchObject({
        state: 'exceeded',
      });
    });
  });

  describe('raise()', () => {
    const SUPER = { id: '7', roles: ['superadmin'] };

    it('#10: bir martalik ko`tarish — o`sha kun AI qayta ochiladi va audit yoziladi', async () => {
      const t = setup({ AI_DAILY_USD_CAP: 50 });
      const now = new Date('2026-09-27T10:00:00Z');
      t.ensure('2026-09-27').cost_usd = 60;
      expect((await t.budget.check(now)).ok).toBe(false);

      const res = await t.budget.raise(20, 'Aksiya kuni', SUPER, now);
      expect(res).toEqual({
        period_key: '2026-09-27',
        override_usd: 20,
        effective_cap_usd: 70,
      });
      expect(t.addOverride).toHaveBeenCalledWith('2026-09-27', 20);
      await expect(t.budget.check(now)).resolves.toEqual({ ok: true });

      expect(t.log).toHaveBeenCalledTimes(1);
      expect(t.log).toHaveBeenCalledWith({
        entity_type: 'ai_daily_cap',
        entity_id: '2026-09-27',
        action: 'ai.cap.raise',
        old_value: { override_usd: 0, effective_cap_usd: 50 },
        new_value: { override_usd: 20, effective_cap_usd: 70 },
        user_id: '7',
        user_role: 'superadmin',
        metadata: {
          reason: 'Aksiya kuni',
          extra_usd: 20,
          requested_usd: 20,
          spent_usd: 60,
        },
      });

      // Ertasi kun — override yo'q (bir kunlik).
      const tomorrow = new Date('2026-09-28T10:00:00Z');
      await expect(t.budget.status(tomorrow)).resolves.toMatchObject({
        override_usd: 0,
        effective_cap_usd: 50,
      });
    });

    it('AI_CAP_RAISE_MAX_USD dan oshmaydi', async () => {
      const t = setup({ AI_CAP_RAISE_MAX_USD: 30 });
      const res = await t.budget.raise(500, 'katta', SUPER);
      expect(t.addOverride).toHaveBeenCalledWith(tashkentDay(new Date()), 30);
      expect(res.override_usd).toBe(30);
    });

    it.each([
      ['0', 0],
      ['manfiy', -5],
      ['NaN', Number.NaN],
    ])(
      'yaroqsiz extra_usd (%s) → throw, hisoblagich va audit tegilmaydi',
      async (_l, extra) => {
        const t = setup();
        await expect(t.budget.raise(extra, 'x', SUPER)).rejects.toThrow();
        expect(t.addOverride).not.toHaveBeenCalled();
        expect(t.log).not.toHaveBeenCalled();
      },
    );

    it('bo`sh reason → throw', async () => {
      const t = setup();
      await expect(t.budget.raise(5, '   ', SUPER)).rejects.toThrow(/reason/);
      expect(t.addOverride).not.toHaveBeenCalled();
    });
  });
});

describe('AiBudgetNotifier (wFSMEIIy #17)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const NOTE: AiCapNotification = {
    type: 'ai.cap_exceeded',
    priority: NotificationPriority.CRITICAL,
    title: 'AI kunlik shifti urildi',
    body: 'matn',
    periodKey: '2026-09-27',
    spentUsd: 50.5,
    capUsd: 50,
  };

  it('notification.dispatch — superadmin+admin, category system, data, group_key', async () => {
    const send = jest.fn().mockReturnValue(of({ ok: true }));
    const notifier = new AiBudgetNotifier({ send } as unknown as ClientProxy);
    await notifier.notify(NOTE);
    expect(send).toHaveBeenCalledTimes(1);
    const [pattern, payload] = send.mock.calls[0] as [unknown, unknown];
    expect(pattern).toEqual({ cmd: 'notification.dispatch' });
    expect(payload).toMatchObject({
      roles: ['superadmin', 'admin'],
      type: 'ai.cap_exceeded',
      category: NotificationCategory.SYSTEM,
      priority: NotificationPriority.CRITICAL,
      title: 'AI kunlik shifti urildi',
      body: 'matn',
      data: { period_key: '2026-09-27', spent_usd: 50.5, cap_usd: 50 },
      group_key: 'ai.cap_exceeded:2026-09-27',
    });
  });

  it('xato YUTILADI (WARN), qayta yuborilmaydi (retries 0)', async () => {
    const send = jest
      .fn()
      .mockReturnValue(throwError(() => new Error('queue down')));
    const notifier = new AiBudgetNotifier({ send } as unknown as ClientProxy);
    await expect(notifier.notify(NOTE)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    const warns = messagesOf(warn);
    expect(warns.some((m) => m.startsWith('ai_cap_notify_failed'))).toBe(true);
  });
});
