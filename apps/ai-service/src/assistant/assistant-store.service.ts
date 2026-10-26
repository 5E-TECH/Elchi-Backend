import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, MoreThanOrEqual, Repository } from 'typeorm';
import {
  AiAssistantAccess,
  AiConversation,
  AiMessage,
} from '../entities/ai-assistant.entity';
import { AiUsageLog } from '../entities/ai-usage-log.entity';
import { tashkentDay, tashkentDayStartIso } from '../usage/tashkent-day';

/** API tarixidagi bitta xabar (Anthropic `MessageParam` shakli). */
export interface AssistantApiMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

export type ReserveResult =
  | {
      ok: true;
      conversation: AiConversation;
      questionId: string;
      nextSeq: number;
      history: AssistantApiMessage[];
      historyChars: number;
      usedToday: number;
    }
  | {
      ok: false;
      code: 'daily_limit' | 'conversation_not_found' | 'conversation_full';
      usedToday: number;
    };

export interface AppendRow {
  role: 'assistant' | 'tool';
  text?: string | null;
  content: unknown;
  tool_calls?: unknown;
  sources?: unknown;
  is_final?: boolean;
  model?: string | null;
  step?: number | null;
  stop_reason?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cost_usd?: number;
}

/**
 * F7PWp6cK — yordamchining DB qatlami (ai_schema). Kunlik limit QAT'IY:
 * hisoblash va savolni yozish BITTA tranzaksiyada, foydalanuvchi bo'yicha
 * advisory lock ostida (parallel so'rovlar limitdan oshirib yubora olmaydi).
 */
@Injectable()
export class AssistantStore {
  constructor(
    @InjectRepository(AiConversation)
    private readonly conversations: Repository<AiConversation>,
    @InjectRepository(AiMessage)
    private readonly messages: Repository<AiMessage>,
    @InjectRepository(AiAssistantAccess)
    private readonly access: Repository<AiAssistantAccess>,
    @InjectRepository(AiUsageLog)
    private readonly usageLog: Repository<AiUsageLog>,
  ) {}

  getAccess(userId: string): Promise<AiAssistantAccess | null> {
    return this.access.findOne({
      where: { user_id: userId, isDeleted: false },
    });
  }

  listAccess(): Promise<AiAssistantAccess[]> {
    return this.access.find({
      where: { isDeleted: false },
      order: { user_id: 'ASC' },
    });
  }

  async upsertAccess(
    userId: string,
    enabled: boolean,
    dailyLimit: number | null,
    updatedBy: string,
  ): Promise<AiAssistantAccess> {
    const existing = await this.access.findOne({ where: { user_id: userId } });
    const row = existing ?? this.access.create({ user_id: userId });
    row.enabled = enabled;
    row.daily_limit = dailyLimit;
    row.updated_by = updatedBy;
    row.isDeleted = false;
    return this.access.save(row);
  }

  /** Bugun (Toshkent) berilgan savollar soni. */
  countQuestionsToday(
    userId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const repo = manager ? manager.getRepository(AiMessage) : this.messages;
    return repo.count({
      where: {
        user_id: userId,
        role: 'user',
        isDeleted: false,
        createdAt: MoreThanOrEqual(
          new Date(tashkentDayStartIso(tashkentDay())),
        ),
      },
    });
  }

  /** Bugungi yordamchi xarajati (USD) — `ai_usage_log.feature = 'assistant'`. */
  async assistantSpendTodayUsd(): Promise<number> {
    const raw = await this.usageLog
      .createQueryBuilder('l')
      .select('COALESCE(SUM(l.cost_usd), 0)', 'usd')
      .where('l.feature = :feature', { feature: 'assistant' })
      .andWhere('l."createdAt" >= :from', {
        from: tashkentDayStartIso(tashkentDay()),
      })
      .getRawOne<{ usd: string | number | null }>();
    const usd = Number(raw?.usd ?? 0);
    return Number.isFinite(usd) ? usd : 0;
  }

  /**
   * Savolni QAT'IY limit bilan band qiladi: lock → bugungi son → (kerak bo'lsa)
   * suhbat yaratish → savol qatorini yozish. Tarix (oldingi API xabarlari)
   * ham shu yerda o'qiladi.
   */
  async reserveQuestion(args: {
    userId: string;
    conversationId: string | null;
    title: string;
    text: string;
    content: unknown;
    dailyLimit: number;
    maxTurns: number;
    /** Qayta yuboriladigan tarix hajmi chegarasi (belgi). */
    maxHistoryChars: number;
    traceId: string | null;
  }): Promise<ReserveResult> {
    return this.messages.manager.transaction(async (m) => {
      await m.query(
        `SELECT pg_advisory_xact_lock(hashtext('ai_assistant_user'), hashtext($1))`,
        [args.userId],
      );
      const used = await this.countQuestionsToday(args.userId, m);
      if (used >= args.dailyLimit) {
        return { ok: false, code: 'daily_limit', usedToday: used } as const;
      }

      const convRepo = m.getRepository(AiConversation);
      let conversation: AiConversation | null;
      if (args.conversationId) {
        conversation = await convRepo.findOne({
          where: {
            id: args.conversationId,
            user_id: args.userId,
            isDeleted: false,
          },
        });
        if (!conversation) {
          return {
            ok: false,
            code: 'conversation_not_found',
            usedToday: used,
          } as const;
        }
        if (conversation.turns >= args.maxTurns) {
          return {
            ok: false,
            code: 'conversation_full',
            usedToday: used,
          } as const;
        }
      } else {
        conversation = await convRepo.save(
          convRepo.create({
            user_id: args.userId,
            title: args.title.slice(0, 200),
            turns: 0,
            last_message_at: null,
          }),
        );
      }

      const msgRepo = m.getRepository(AiMessage);
      const rows = await msgRepo.find({
        where: { conversation_id: conversation.id, isDeleted: false },
        order: { seq: 'ASC' },
        select: ['id', 'seq', 'role', 'content'],
      });
      const history: AssistantApiMessage[] = rows
        .filter((r) => r.content !== null && r.content !== undefined)
        .map((r) => ({
          role: r.role === 'assistant' ? 'assistant' : 'user',
          content: r.content,
        }));
      const historyChars = history.reduce(
        (sum, h) => sum + JSON.stringify(h.content).length,
        0,
      );
      if (historyChars > args.maxHistoryChars) {
        // Savol YOZILMAYDI va limitdan yechilmaydi — yangi suhbat kerak.
        return {
          ok: false,
          code: 'conversation_full',
          usedToday: used,
        } as const;
      }
      const nextSeq = (rows.length ? rows[rows.length - 1].seq : 0) + 1;

      const question = await msgRepo.save(
        msgRepo.create({
          conversation_id: conversation.id,
          user_id: args.userId,
          seq: nextSeq,
          role: 'user',
          text: args.text,
          content: args.content,
          trace_id: args.traceId,
        }),
      );
      conversation.turns += 1;
      conversation.last_message_at = new Date();
      await convRepo.save(conversation);

      return {
        ok: true,
        conversation,
        questionId: question.id,
        nextSeq: nextSeq + 1,
        history,
        historyChars,
        usedToday: used + 1,
      } as const;
    });
  }

  /** Sikl natijasini (assistant qadamlari + tool natijalari) tartib bilan yozadi. */
  async appendMessages(
    conversation: AiConversation,
    userId: string,
    startSeq: number,
    rows: AppendRow[],
    traceId: string | null,
  ): Promise<string | null> {
    if (rows.length === 0) return null;
    return this.messages.manager.transaction(async (m) => {
      const msgRepo = m.getRepository(AiMessage);
      let finalId: string | null = null;
      let seq = startSeq;
      let inTok = 0;
      let outTok = 0;
      let cost = 0;
      for (const row of rows) {
        const saved = await msgRepo.save(
          msgRepo.create({
            conversation_id: conversation.id,
            user_id: userId,
            seq: seq++,
            role: row.role,
            text: row.text ?? null,
            content: row.content,
            tool_calls: row.tool_calls ?? null,
            sources: row.sources ?? null,
            is_final: row.is_final === true,
            model: row.model ?? null,
            step: row.step ?? null,
            stop_reason: row.stop_reason ?? null,
            input_tokens: row.input_tokens ?? 0,
            output_tokens: row.output_tokens ?? 0,
            cache_read_tokens: row.cache_read_tokens ?? 0,
            cache_creation_tokens: row.cache_creation_tokens ?? 0,
            cost_usd: row.cost_usd ?? 0,
            trace_id: traceId,
          }),
        );
        if (row.is_final) finalId = saved.id;
        inTok +=
          (row.input_tokens ?? 0) +
          (row.cache_read_tokens ?? 0) +
          (row.cache_creation_tokens ?? 0);
        outTok += row.output_tokens ?? 0;
        cost += row.cost_usd ?? 0;
      }
      await m
        .getRepository(AiConversation)
        .createQueryBuilder()
        .update()
        .set({
          input_tokens: () => `input_tokens + ${Math.round(inTok)}`,
          output_tokens: () => `output_tokens + ${Math.round(outTok)}`,
          cost_usd: () => `cost_usd + ${Number(cost.toFixed(6))}`,
          last_message_at: new Date(),
        })
        .where('id = :id', { id: conversation.id })
        .execute();
      return finalId;
    });
  }

  listConversations(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<[AiConversation[], number]> {
    return this.conversations.findAndCount({
      where: { user_id: userId, isDeleted: false },
      order: {
        last_message_at: { direction: 'DESC', nulls: 'LAST' },
        id: 'DESC',
      },
      take: limit,
      skip: offset,
    });
  }

  async getConversation(
    userId: string,
    id: string,
  ): Promise<{ conversation: AiConversation; messages: AiMessage[] } | null> {
    const conversation = await this.conversations.findOne({
      where: { id, user_id: userId, isDeleted: false },
    });
    if (!conversation) return null;
    const messages = await this.messages.find({
      where: { conversation_id: id, isDeleted: false },
      order: { seq: 'ASC' },
    });
    return { conversation, messages };
  }
}
