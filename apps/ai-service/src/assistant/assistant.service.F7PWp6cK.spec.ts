import { ConfigService } from '@nestjs/config';
import { lastValueFrom, toArray } from 'rxjs';
import type {
  AiAssistantEvent,
  AiAssistantMessageRequest,
  ClaudeToolLoopOptions,
  ClaudeToolLoopResult,
} from '@app/common';
import { AssistantService } from './assistant.service';
import { ASSISTANT_SYSTEM_PROMPT } from './assistant.prompt';

/**
 * F7PWp6cK — AssistantService: ruxsat (SA doim, ADMIN — access bilan,
 * boshqalar — rad), limitlar, oqim hodisalari, audit qatorlari. Claude va DB
 * soxta (haqiqiy API chaqiruvi YO'Q).
 */

function config(values: Record<string, unknown>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function makeStore(over: Record<string, jest.Mock> = {}) {
  return {
    getAccess: jest.fn(() => Promise.resolve(null)),
    countQuestionsToday: jest.fn(() => Promise.resolve(0)),
    assistantSpendTodayUsd: jest.fn(() => Promise.resolve(0)),
    reserveQuestion: jest.fn(() =>
      Promise.resolve({
        ok: true,
        conversation: { id: '7', turns: 1 },
        questionId: '70',
        nextSeq: 2,
        history: [],
        historyChars: 0,
        usedToday: 1,
      }),
    ),
    appendMessages: jest.fn<Promise<string>, unknown[]>(() =>
      Promise.resolve('72'),
    ),
    listAccess: jest.fn(() => Promise.resolve([])),
    upsertAccess: jest.fn(),
    listConversations: jest.fn(() => Promise.resolve([[], 0])),
    getConversation: jest.fn(() => Promise.resolve(null)),
    ...over,
  };
}

function okLoop(
  impl?: (o: ClaudeToolLoopOptions) => Promise<Partial<ClaudeToolLoopResult>>,
) {
  return jest.fn(async (o: ClaudeToolLoopOptions) => {
    const extra = impl ? await impl(o) : {};
    return {
      ok: true,
      stop: 'end_turn',
      text: 'Javob',
      newMessages: [],
      steps: 1,
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model: 'claude-sonnet-5',
      ...extra,
    } as ClaudeToolLoopResult;
  });
}

function makeService(
  opts: {
    enabled?: boolean;
    store?: ReturnType<typeof makeStore>;
    runToolLoop?: jest.Mock;
    aiEnabled?: boolean;
  } = {},
) {
  const store = opts.store ?? makeStore();
  const claude = {
    isEnabled: () => opts.aiEnabled ?? true,
    runToolLoop: opts.runToolLoop ?? okLoop(),
  };
  const reader = { read: jest.fn(() => Promise.resolve({ data: {} })) };
  const svc = new AssistantService(
    config({ AI_ASSISTANT_ENABLED: opts.enabled ?? true }),
    claude as any,
    store as any,
    reader as any,
  );
  return { svc, store, claude, reader };
}

const SA_REQ: AiAssistantMessageRequest = {
  requester: { id: '1', roles: ['superadmin'] },
  message: 'Kassada qancha pul bor?',
};
const ADMIN_REQ: AiAssistantMessageRequest = {
  requester: { id: '25', roles: ['admin'] },
  message: 'Bu oy foyda qancha?',
};

async function collect(svc: AssistantService, req: AiAssistantMessageRequest) {
  return lastValueFrom(svc.stream(req).pipe(toArray()));
}

describe('AssistantService (F7PWp6cK)', () => {
  describe('ruxsat', () => {
    it('SUPERADMIN — doim (access qatori shart emas), sukut limit 100', async () => {
      const { svc } = makeService();
      await expect(svc.accessState(SA_REQ.requester)).resolves.toMatchObject({
        allowed: true,
        reason: null,
        daily_limit: 100,
        remaining_today: 100,
      });
    });

    it('ADMIN — faqat ai_assistant_access.enabled bilan', async () => {
      const off = makeService();
      await expect(
        off.svc.accessState(ADMIN_REQ.requester),
      ).resolves.toMatchObject({ allowed: false, reason: 'access_disabled' });
      const disabledRow = makeService({
        store: makeStore({
          getAccess: jest.fn(() =>
            Promise.resolve({ enabled: false, daily_limit: null }),
          ),
        }),
      });
      await expect(
        disabledRow.svc.accessState(ADMIN_REQ.requester),
      ).resolves.toMatchObject({ allowed: false, reason: 'access_disabled' });
      const on = makeService({
        store: makeStore({
          getAccess: jest.fn(() =>
            Promise.resolve({ enabled: true, daily_limit: 5 }),
          ),
          countQuestionsToday: jest.fn(() => Promise.resolve(2)),
        }),
      });
      await expect(
        on.svc.accessState(ADMIN_REQ.requester),
      ).resolves.toMatchObject({
        allowed: true,
        daily_limit: 5,
        used_today: 2,
        remaining_today: 3,
      });
    });

    it.each([
      ['market'],
      ['courier'],
      ['logist'],
      ['manager'],
      ['registrator'],
      ['market_operator'],
    ])('%s — HECH QACHON (role_forbidden)', async (role) => {
      const { svc, store } = makeService({
        store: makeStore({
          getAccess: jest.fn(() =>
            Promise.resolve({ enabled: true, daily_limit: null }),
          ),
        }),
      });
      await expect(
        svc.accessState({ id: '37', roles: [role] }),
      ).resolves.toMatchObject({ allowed: false, reason: 'role_forbidden' });
      const events = await collect(svc, {
        requester: { id: '37', roles: [role] },
        message: 'salom',
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'error', code: 'role_forbidden' }),
      ]);
      expect(store.reserveQuestion).not.toHaveBeenCalled();
    });

    it('funksiya sukut bo‘yicha O‘CHIQ (AI_ASSISTANT_ENABLED yo‘q)', async () => {
      const store = makeStore();
      const svc = new AssistantService(
        config({}),
        { isEnabled: () => true, runToolLoop: jest.fn() } as any,
        store as any,
        {} as any,
      );
      expect(svc.enabled).toBe(false);
      const events = await collect(svc, SA_REQ);
      expect(events).toEqual([
        expect.objectContaining({ type: 'error', code: 'feature_disabled' }),
      ]);
    });

    it('karta sukutlari: model claude-sonnet-5, 6 qadam (6 dan oshmaydi)', () => {
      const svc = new AssistantService(
        config({ AI_ASSISTANT_MAX_STEPS: 50 }),
        {} as any,
        {} as any,
        {} as any,
      );
      expect(svc.model).toBe('claude-sonnet-5');
      expect(svc.maxSteps).toBe(6);
    });
  });

  describe('limitlar', () => {
    it('kunlik limit — reserveQuestion rad etsa Claude chaqirilmaydi', async () => {
      const { svc, claude } = makeService({
        store: makeStore({
          reserveQuestion: jest.fn(() =>
            Promise.resolve({
              ok: false,
              code: 'daily_limit',
              usedToday: 100,
            }),
          ),
        }),
      });
      const events = await collect(svc, SA_REQ);
      expect(events).toEqual([
        expect.objectContaining({ type: 'error', code: 'daily_limit' }),
      ]);
      expect(claude.runToolLoop).not.toHaveBeenCalled();
    });

    it('yordamchi kunlik USD shifti (feature=assistant) — rad', async () => {
      const { svc, claude, store } = makeService({
        store: makeStore({
          assistantSpendTodayUsd: jest.fn(() => Promise.resolve(5.01)),
        }),
      });
      const events = await collect(svc, SA_REQ);
      expect(events[0]).toMatchObject({
        type: 'error',
        code: 'assistant_usd_cap',
      });
      expect(store.reserveQuestion).not.toHaveBeenCalled();
      expect(claude.runToolLoop).not.toHaveBeenCalled();
    });

    it('bir foydalanuvchi — bir vaqtda bitta savol (busy)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { svc } = makeService({
        runToolLoop: okLoop(async () => {
          await gate;
          return {};
        }),
      });
      const first = collect(svc, SA_REQ);
      await new Promise((r) => setImmediate(r));
      const second = await collect(svc, SA_REQ);
      expect(second).toEqual([
        expect.objectContaining({ type: 'error', code: 'busy' }),
      ]);
      release();
      const firstEvents = await first;
      expect(firstEvents[firstEvents.length - 1]).toMatchObject({
        type: 'done',
      });
    });

    it('xabar shifti (beforeStep): token/USD oshsa — to‘xtaydi', async () => {
      let guard!: ClaudeToolLoopOptions['beforeStep'];
      const { svc } = makeService({
        runToolLoop: okLoop((o) => {
          guard = o.beforeStep;
          return Promise.resolve({});
        }),
      });
      await collect(svc, SA_REQ);
      const zero = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      expect(
        guard!({ step: 1, usage: zero, model: 'claude-sonnet-5' }),
      ).toEqual({
        ok: true,
      });
      expect(
        guard!({
          step: 3,
          usage: { ...zero, input_tokens: 150_000, output_tokens: 10_000 },
          model: 'claude-sonnet-5',
        }),
      ).toEqual({ ok: false, reason: 'message_usd_cap' });
      expect(
        guard!({
          step: 3,
          usage: { ...zero, cache_read_input_tokens: 250_000 },
          model: 'claude-sonnet-5',
        }),
      ).toEqual({ ok: false, reason: 'message_token_cap' });
    });

    it('noto‘g‘ri xabar / begona suhbat ID si', async () => {
      const { svc } = makeService();
      expect(await collect(svc, { ...SA_REQ, message: '   ' })).toEqual([
        expect.objectContaining({ code: 'invalid_message' }),
      ]);
      expect(
        await collect(svc, { ...SA_REQ, conversation_id: '1; DROP' }),
      ).toEqual([expect.objectContaining({ code: 'conversation_not_found' })]);
    });
  });

  describe('oqim va audit', () => {
    it('meta → step → tool_call → tool_result → delta → done (manba bilan); audit qatorlari yoziladi', async () => {
      const runToolLoop = okLoop(async (o) => {
        o.onEvent?.({ type: 'step_start', step: 1 });
        o.onEvent?.({
          type: 'tool_call',
          step: 1,
          id: 'tu1',
          name: 'get_cash_position',
          input: {},
        });
        const r = await o.executeTool(
          'get_cash_position',
          {},
          { step: 1, id: 'tu1' },
        );
        o.onEvent?.({
          type: 'tool_result',
          step: 1,
          id: 'tu1',
          name: 'get_cash_position',
          isError: r.isError,
        });
        o.onStep?.({
          step: 1,
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 500,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          stopReason: 'tool_use',
          toolCalls: 1,
        });
        o.onEvent?.({ type: 'step_start', step: 2 });
        o.onEvent?.({ type: 'text_delta', step: 2, text: 'Kassada ' });
        o.onStep?.({
          step: 2,
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 500,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          stopReason: 'end_turn',
          toolCalls: 0,
        });
        return {
          text: 'Kassada 100 so‘m. Manba: get_cash_position',
          steps: 2,
          newMessages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'tu1',
                  name: 'get_cash_position',
                  input: {},
                },
              ],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'tu1', content: '{}' },
              ],
            },
            {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'Kassada 100 so‘m. Manba: get_cash_position',
                },
              ],
            },
          ],
        };
      });
      const { svc, store } = makeService({ runToolLoop });
      const events = await collect(svc, SA_REQ);
      expect(events.map((e) => e.type)).toEqual([
        'meta',
        'step',
        'tool_call',
        'tool_result',
        'step',
        'delta',
        'done',
      ]);
      const done = events[events.length - 1] as Extract<
        AiAssistantEvent,
        { type: 'done' }
      >;
      expect(done).toMatchObject({
        conversation_id: '7',
        message_id: '72',
        answer: 'Kassada 100 so‘m. Manba: get_cash_position',
        stop: 'end_turn',
        limits: { daily_limit: 100, used_today: 1, remaining_today: 99 },
      });
      expect(done.sources).toEqual([
        expect.objectContaining({
          tool: 'get_cash_position',
          period: null,
          ok: true,
        }),
      ]);
      expect(done.usage.cost_usd).toBeGreaterThan(0);

      // Loop'ga berilgan sozlamalar: keshlanadigan o'zgarmas system, feature=assistant.
      const loopOpts = runToolLoop.mock.calls[0][0];
      expect(loopOpts.system).toBe(ASSISTANT_SYSTEM_PROMPT);
      expect(loopOpts.meta).toMatchObject({
        feature: 'assistant',
        requestArea: 'internal',
        userId: '1',
      });
      expect(loopOpts.maxSteps).toBe(6);
      expect(loopOpts.model).toBe('claude-sonnet-5');
      expect(loopOpts.tools).toHaveLength(10);
      const lastUser = loopOpts.messages[loopOpts.messages.length - 1] as any;
      expect(lastUser.content[0].text).toContain('<user_message>');
      expect(lastUser.content[0].text).toContain('Bugungi sana (Toshkent)');

      // Audit: assistant (qadam 1) + tool (tool_calls) + assistant (final, manba).
      const rows = store.appendMessages.mock.calls[0][3] as any[];
      expect(rows.map((r) => r.role)).toEqual([
        'assistant',
        'tool',
        'assistant',
      ]);
      expect(rows[0]).toMatchObject({
        step: 1,
        input_tokens: 500,
        stop_reason: 'tool_use',
      });
      expect(rows[1].tool_calls).toEqual([
        expect.objectContaining({
          tool: 'get_cash_position',
          ok: true,
          tool_use_id: 'tu1',
        }),
      ]);
      expect(rows[2]).toMatchObject({ is_final: true, step: 2 });
      expect(rows[2].sources).toHaveLength(1);
    });

    it('xato bilan tugasa — error hodisasi, yakuniy qator audit uchun baribir yoziladi', async () => {
      const { svc, store } = makeService({
        runToolLoop: okLoop(() =>
          Promise.resolve({ ok: false, stop: 'refused', text: '' }),
        ),
      });
      const events = await collect(svc, SA_REQ);
      expect(events.map((e) => e.type)).toEqual(['meta', 'error']);
      expect(events[1]).toMatchObject({
        code: 'refused',
        conversation_id: '7',
      });
      const rows = store.appendMessages.mock.calls[0][3] as any[];
      expect(rows).toEqual([
        expect.objectContaining({
          role: 'assistant',
          is_final: true,
          content: null,
          stop_reason: 'refused',
        }),
      ]);
    });

    it('kutilmagan xato — oqim baribir error bilan yopiladi (throw yo‘q)', async () => {
      const { svc } = makeService({
        store: makeStore({
          reserveQuestion: jest.fn(() => Promise.reject(new Error('db down'))),
        }),
      });
      const events = await collect(svc, SA_REQ);
      expect(events).toEqual([
        expect.objectContaining({ type: 'error', code: 'ai_error' }),
      ]);
    });
  });
});
