import { ConfigService } from '@nestjs/config';
import { BadRequestError } from '@anthropic-ai/sdk';
import { ClaudeService } from './claude.service';
import type {
  AnthropicClientFactory,
  ClaudeBudgetGuard,
  ClaudeToolLoopEvent,
  ClaudeToolLoopOptions,
  ClaudeUsageMeta,
  ClaudeUsageRecord,
} from './claude.types';

/**
 * F7PWp6cK — `ClaudeService.runToolLoop` (qo'lda tool-use sikli). Haqiqiy
 * Anthropic chaqirilmaydi: soxta mijoz `messages.stream()` ni taqlid qiladi.
 */

const META: ClaudeUsageMeta = {
  feature: 'assistant',
  requestArea: 'internal',
  marketId: null,
  userId: '1',
  traceId: 't-1',
  draftId: null,
};
const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 50,
};

type Resp = {
  stop_reason: string;
  content: Array<Record<string, unknown>>;
  stop_details?: { category: string } | null;
};

function toolUse(id: string, name: string, input: unknown = {}) {
  return { type: 'tool_use', id, name, input };
}
function text(t: string) {
  return { type: 'text', text: t };
}

function makeClient(responses: Array<Resp | Error>) {
  const bodies: any[] = [];
  const stream = jest.fn((body: any) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    const next = responses.shift();
    let onText: ((d: string) => void) | null = null;
    return {
      on: (event: string, cb: (d: string) => void) => {
        if (event === 'text') onText = cb;
        return undefined;
      },
      finalMessage: () => {
        if (!next) return Promise.reject(new Error('no more responses'));
        if (next instanceof Error) return Promise.reject(next);
        for (const b of next.content) {
          if (b.type === 'text' && onText) onText(String(b.text));
        }
        return Promise.resolve({ ...next, usage: USAGE });
      },
    };
  });
  const create = jest.fn();
  const factory: AnthropicClientFactory = () => ({
    messages: { create, stream },
  });
  return { factory, stream, create, bodies };
}

function makeService(
  factory: AnthropicClientFactory,
  budget?: ClaudeBudgetGuard,
  sink?: { record: jest.Mock },
) {
  const config = {
    get: (k: string) => (k === 'ANTHROPIC_API_KEY' ? 'sk-ant-test' : undefined),
  } as unknown as ConfigService;
  return new ClaudeService(config, factory, sink, budget);
}

function opts(
  over: Partial<ClaudeToolLoopOptions> = {},
): ClaudeToolLoopOptions {
  return {
    system: 'SYS',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'savol' }] }],
    tools: [
      {
        name: 'get_cash_position',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
      },
    ],
    executeTool: jest.fn(() =>
      Promise.resolve({
        content: JSON.stringify({ ok: 1 }),
        isError: false,
      }),
    ),
    meta: META,
    inputText: 'savol',
    model: 'claude-sonnet-5',
    maxSteps: 6,
    maxTokens: 8000,
    ...over,
  };
}

describe('ClaudeService.runToolLoop (F7PWp6cK)', () => {
  it('tool → yakuniy javob: 2 qadam, tarix append-only, tool_result BITTA user xabarida', async () => {
    const { factory, bodies } = makeClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig-1' },
          toolUse('t1', 'get_cash_position'),
          toolUse('t2', 'get_cash_position'),
        ],
      },
      { stop_reason: 'end_turn', content: [text('Kassada 100 so‘m.')] },
    ]);
    const svc = makeService(factory);
    const events: ClaudeToolLoopEvent[] = [];
    const o = opts({ onEvent: (e) => events.push(e) });
    const res = await svc.runToolLoop(o);

    expect(res).toMatchObject({ ok: true, stop: 'end_turn', steps: 2 });
    expect(res.text).toBe('Kassada 100 so‘m.');
    expect(o.executeTool).toHaveBeenCalledTimes(2);
    // assistant (thinking imzosi bilan o'zgarishsiz) + user(tool_result x2) + assistant
    expect(res.newMessages).toHaveLength(3);
    const [a1, u1] = res.newMessages as any[];
    expect(a1.content[0]).toEqual({
      type: 'thinking',
      thinking: '',
      signature: 'sig-1',
    });
    expect(u1.role).toBe('user');
    expect(u1.content.map((b: any) => b.tool_use_id)).toEqual(['t1', 't2']);
    // 2-qadam tanasida 1-qadam javobi va tool natijalari bor.
    expect(bodies[1].messages).toHaveLength(3);
    // Kirish xabarlari mutatsiya qilinmagan.
    expect(o.messages).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual([
      'step_start',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'step_start',
      'text_delta',
    ]);
    expect(res.usage.input_tokens).toBe(200);
  });

  it('so‘rov tanasi: system keshlanadi, top-level cache_control, tools eager_input_streaming, sampling/thinking/tool_choice YO‘Q', async () => {
    const { factory, bodies } = makeClient([
      { stop_reason: 'end_turn', content: [text('ok')] },
    ]);
    await makeService(factory).runToolLoop(opts({ effort: 'medium' }));
    const body = bodies[0];
    expect(body.system).toEqual([
      { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[0]).toMatchObject({
      name: 'get_cash_position',
      eager_input_streaming: true,
    });
    expect(body.output_config).toEqual({ effort: 'medium' });
    for (const k of [
      'temperature',
      'top_p',
      'top_k',
      'thinking',
      'tool_choice',
    ]) {
      expect(body).not.toHaveProperty(k);
    }
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.max_tokens).toBe(8000);
  });

  it('maxSteps (6): oxirgi qadamda ham tool so‘ralsa — ijro YO‘Q, is_error bilan tarix yopiladi, stop=max_steps', async () => {
    const responses: Resp[] = Array.from({ length: 6 }, (_, i) => ({
      stop_reason: 'tool_use',
      content: [toolUse(`t${i}`, 'get_cash_position')],
    }));
    const { factory, stream } = makeClient(responses);
    const o = opts();
    const res = await makeService(factory).runToolLoop(o);
    expect(stream).toHaveBeenCalledTimes(6);
    expect(res.stop).toBe('max_steps');
    expect(res.ok).toBe(false);
    expect(o.executeTool).toHaveBeenCalledTimes(5);
    const last = res.newMessages[res.newMessages.length - 1] as any;
    expect(last.role).toBe('user');
    expect(last.content[0]).toMatchObject({
      tool_use_id: 't5',
      is_error: true,
    });
  });

  it('refusal — tool ishga tushmaydi va qadam tarixga yozilmaydi', async () => {
    const { factory } = makeClient([
      {
        stop_reason: 'refusal',
        stop_details: { category: 'cyber' },
        content: [toolUse('t1', 'get_cash_position')],
      },
    ]);
    const o = opts();
    const res = await makeService(factory).runToolLoop(o);
    expect(res.stop).toBe('refused');
    expect(o.executeTool).not.toHaveBeenCalled();
    expect(res.newMessages).toHaveLength(0);
  });

  it('max_tokens + tool_use — kesilgan kirish bajarilmaydi', async () => {
    const { factory } = makeClient([
      {
        stop_reason: 'max_tokens',
        content: [toolUse('t1', 'get_cash_position', { from: '2026-1' })],
      },
    ]);
    const o = opts();
    const res = await makeService(factory).runToolLoop(o);
    expect(res.stop).toBe('truncated');
    expect(o.executeTool).not.toHaveBeenCalled();
    expect(res.newMessages).toHaveLength(0);
  });

  it('beforeStep (xabar shifti) — Anthropic chaqirilmaydi, stop=limit', async () => {
    const { factory, stream } = makeClient([
      {
        stop_reason: 'tool_use',
        content: [toolUse('t1', 'get_cash_position')],
      },
      { stop_reason: 'end_turn', content: [text('x')] },
    ]);
    const res = await makeService(factory).runToolLoop(
      opts({
        beforeStep: ({ step }) =>
          step >= 2 ? { ok: false, reason: 'message_usd_cap' } : { ok: true },
      }),
    );
    expect(stream).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({
      stop: 'limit',
      limitReason: 'message_usd_cap',
    });
  });

  it('global shift (budget guard) har qadamdan oldin — FAIL-CLOSED', async () => {
    const { factory, stream } = makeClient([
      { stop_reason: 'end_turn', content: [text('x')] },
    ]);
    const budget: ClaudeBudgetGuard = {
      check: jest.fn(() =>
        Promise.resolve({
          ok: false as const,
          reason: 'cap_exceeded' as const,
          scope: 'global' as const,
          reset_at: '2026-10-27T00:00:00+05:00',
        }),
      ),
      onSpend: jest.fn(),
    };
    const res = await makeService(factory, budget).runToolLoop(opts());
    expect(stream).not.toHaveBeenCalled();
    expect(res.stop).toBe('cap_exceeded');
    const broken: ClaudeBudgetGuard = {
      check: jest.fn(() => Promise.reject(new Error('db down'))),
      onSpend: jest.fn(),
    };
    const res2 = await makeService(factory, broken).runToolLoop(opts());
    expect(res2.stop).toBe('disabled');
  });

  it('har qadam xarajat jurnaliga feature=assistant bilan yoziladi', async () => {
    const { factory } = makeClient([
      {
        stop_reason: 'tool_use',
        content: [toolUse('t1', 'get_cash_position')],
      },
      { stop_reason: 'end_turn', content: [text('x')] },
    ]);
    const sink = { record: jest.fn() };
    await makeService(factory, undefined, sink).runToolLoop(opts());
    const records = sink.record.mock.calls.map(
      (c) => c[0] as ClaudeUsageRecord,
    );
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.steps)).toEqual([1, 2]);
    expect(records[0]).toMatchObject({
      feature: 'assistant',
      requestArea: 'internal',
      model: 'claude-sonnet-5',
      outcome: 'ok',
      inputChars: 5,
    });
  });

  it('API xatosi — throw yo‘q, sababli natija; JSON xatosi — qadam qayta yuboriladi', async () => {
    const apiErr = new BadRequestError(400, undefined, 'bad', new Headers());
    const { factory } = makeClient([apiErr]);
    const res = await makeService(factory).runToolLoop(opts());
    expect(res.stop).toBe('ai_error');

    const { factory: f2, stream: s2 } = makeClient([
      new SyntaxError('Unexpected token in JSON'),
      { stop_reason: 'end_turn', content: [text('ok')] },
    ]);
    const res2 = await makeService(f2).runToolLoop(opts());
    expect(s2).toHaveBeenCalledTimes(2);
    expect(res2).toMatchObject({ ok: true, text: 'ok' });
  });

  it('executeTool throw qilsa ham sikl davom etadi (is_error)', async () => {
    const { factory } = makeClient([
      {
        stop_reason: 'tool_use',
        content: [toolUse('t1', 'get_cash_position')],
      },
      { stop_reason: 'end_turn', content: [text('x')] },
    ]);
    const res = await makeService(factory).runToolLoop(
      opts({
        executeTool: jest.fn(() => Promise.reject(new Error('boom'))),
      }),
    );
    expect(res.ok).toBe(true);
    const toolMsg = res.newMessages[1] as any;
    expect(toolMsg.content[0]).toMatchObject({ is_error: true });
  });

  it('kalitsiz — disabled, chaqiruv yo‘q', async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const svc = new ClaudeService(config);
    const res = await svc.runToolLoop(opts());
    expect(res.stop).toBe('disabled');
  });
});
