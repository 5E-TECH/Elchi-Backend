import { DataSource } from 'typeorm';
import { CreateAiSchema1716000000047 } from '../../../../migrations/1716000000047-CreateAiSchema';
import { AiAssistant1716000000172 } from '../../../../migrations/1716000000172-AiAssistant';
import {
  AiAssistantAccess,
  AiConversation,
  AiMessage,
} from '../entities/ai-assistant.entity';
import { AiUsageLog } from '../entities/ai-usage-log.entity';
import { AssistantStore } from './assistant-store.service';

/**
 * F7PWp6cK — yordamchi DB qatlami haqiqiy Postgres'da: migratsiya
 * (idempotent), QAT'IY kunlik limit (parallel so'rovlar), suhbat egaligi,
 * tarix tartibi, yordamchi USD yig'indisi (faqat feature='assistant').
 */
const PG_URI = process.env.AI_PG_TEST_URI;
const describePg = PG_URI ? describe : describe.skip;

describePg('AssistantStore — real Postgres (F7PWp6cK)', () => {
  let ds: DataSource;
  let store: AssistantStore;
  const userA = '880001';
  const userB = '880002';

  const reserve = (
    userId: string,
    over: Partial<Parameters<AssistantStore['reserveQuestion']>[0]> = {},
  ) =>
    store.reserveQuestion({
      userId,
      conversationId: null,
      title: 'savol',
      text: 'savol',
      content: [{ type: 'text', text: 'savol' }],
      dailyLimit: 100,
      maxTurns: 20,
      maxHistoryChars: 400_000,
      traceId: null,
      ...over,
    });

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: PG_URI,
      entities: [AiConversation, AiMessage, AiAssistantAccess, AiUsageLog],
      synchronize: false,
    });
    await ds.initialize();
    const qr = ds.createQueryRunner();
    try {
      const probe = await ds.query<Array<{ t: string | null }>>(
        `SELECT to_regclass('ai_schema.ai_usage_log') AS t`,
      );
      if (!probe[0]?.t) await new CreateAiSchema1716000000047().up(qr);
      // up() ikki marta — IF NOT EXISTS (idempotent).
      await new AiAssistant1716000000172().up(qr);
      await new AiAssistant1716000000172().up(qr);
    } finally {
      await qr.release();
    }
    await ds.query(
      `DELETE FROM ai_schema.ai_conversations WHERE user_id IN ($1, $2)`,
      [userA, userB],
    );
    await ds.query(
      `DELETE FROM ai_schema.ai_assistant_access WHERE user_id IN ($1, $2)`,
      [userA, userB],
    );
    await ds.query(
      `DELETE FROM ai_schema.ai_usage_log WHERE user_id IN ($1, $2)`,
      [userA, userB],
    );
    store = new AssistantStore(
      ds.getRepository(AiConversation),
      ds.getRepository(AiMessage),
      ds.getRepository(AiAssistantAccess),
      ds.getRepository(AiUsageLog),
    );
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  it('kunlik limit QAT‘IY: 6 ta parallel so‘rov, limit 3 → aynan 3 tasi o‘tadi', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => reserve(userA, { dailyLimit: 3 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(
      results.filter((r) => !r.ok && r.code === 'daily_limit'),
    ).toHaveLength(3);
    await expect(store.countQuestionsToday(userA)).resolves.toBe(3);
  });

  it('suhbat davomi: tarix tartib bilan qaytadi, begona suhbat — not_found', async () => {
    const first = await reserve(userB);
    if (!first.ok) throw new Error('reserve failed');
    await store.appendMessages(
      first.conversation,
      userB,
      first.nextSeq,
      [
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
          input_tokens: 10,
          output_tokens: 5,
          cost_usd: 0.001,
        },
        {
          role: 'tool',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '{}' }],
          tool_calls: [{ tool: 'get_cash_position', ok: true }],
        },
        {
          role: 'assistant',
          text: 'Javob',
          content: [{ type: 'text', text: 'Javob' }],
          is_final: true,
          sources: [{ tool: 'get_cash_position' }],
          cost_usd: 0.002,
        },
      ],
      null,
    );
    const second = await reserve(userB, {
      conversationId: first.conversation.id,
    });
    if (!second.ok) throw new Error('reserve 2 failed');
    expect(second.history.map((h) => h.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect((second.history[2].content as any[])[0].type).toBe('tool_result');

    const foreign = await reserve(userA, {
      conversationId: first.conversation.id,
      dailyLimit: 100,
    });
    expect(foreign).toMatchObject({
      ok: false,
      code: 'conversation_not_found',
    });

    const detail = await store.getConversation(userB, first.conversation.id);
    expect(detail?.conversation.turns).toBe(2);
    expect(Number(detail?.conversation.cost_usd)).toBeCloseTo(0.003, 6);
    expect(
      await store.getConversation(userA, first.conversation.id),
    ).toBeNull();
  });

  it('suhbat to‘lsa (turns / tarix hajmi) — savol YOZILMAYDI', async () => {
    const first = await reserve(userB);
    if (!first.ok) throw new Error('reserve failed');
    const before = await store.countQuestionsToday(userB);
    const full = await reserve(userB, {
      conversationId: first.conversation.id,
      maxTurns: 1,
    });
    expect(full).toMatchObject({ ok: false, code: 'conversation_full' });
    const big = await reserve(userB, {
      conversationId: first.conversation.id,
      maxHistoryChars: 10,
    });
    expect(big).toMatchObject({ ok: false, code: 'conversation_full' });
    await expect(store.countQuestionsToday(userB)).resolves.toBe(before);
  });

  it('yordamchi USD yig‘indisi faqat feature=assistant', async () => {
    const before = await store.assistantSpendTodayUsd();
    await ds.query(
      `INSERT INTO ai_schema.ai_usage_log (feature, request_area, model, cost_usd, user_id)
       VALUES ('assistant','internal','claude-sonnet-5',0.25,$1),
              ('order_extract_multi','order','claude-sonnet-5',9,$1)`,
      [userA],
    );
    await expect(store.assistantSpendTodayUsd()).resolves.toBeCloseTo(
      before + 0.25,
      6,
    );
  });

  it('ruxsat upsert: bitta qator (UNIQUE user_id), qayta yozish yangilaydi', async () => {
    await store.upsertAccess(userA, true, 50, '1');
    const row = await store.upsertAccess(userA, false, null, '1');
    expect(row).toMatchObject({
      enabled: false,
      daily_limit: null,
      updated_by: '1',
    });
    const all = (await store.listAccess()).filter((r) => r.user_id === userA);
    expect(all).toHaveLength(1);
  });
});
