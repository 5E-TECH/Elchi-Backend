import { ServerRMQ, type RmqOptions } from '@nestjs/microservices';
import { AI_FAST_PATTERNS } from '@app/common';

/**
 * (AI ack B1) ai-service'ning TEZ navbati (`ai_fast_queue`) iste'molchisi.
 *
 * MUAMMO: ai-confirm FAIL-CLOSED — `ai.draft.confirm_context` (3 s timeout)
 * javob bermasa 503. Umumiy `ai_queue` da u `ai.order.extract` kabi Claude
 * chaqiruvlari bilan BITTA navbatda: prefetch 8 va ack handler tugagach,
 * ya'ni 8 ta ekstraksiya ochiq turganda confirm_context navbatda kutib
 * timeout bo'lardi (oddiy cho'qqida butun partiya 503).
 *
 * YECHIM: arzon DB amallari (`AI_FAST_PATTERNS`) alohida navbat va kanalda
 * (o'z prefetch'i, `AI_FAST_PREFETCH`, sukut 32). Bu server FAQAT shu
 * naqshlarni ro'yxatdan o'tkazadi — boshqa naqsh (masalan adashib yuborilgan
 * `ai.order.extract`) tez navbatda Claude'ni chaqirmaydi: Nest "handler
 * yo'q" javobini beradi va xabar nack (DLQ) bo'ladi.
 *
 * Orqaga moslik: xuddi shu handler'lar eski `ai_queue` da ham qoladi
 * (rolling deploy — eski gateway u yerga yuboradi).
 */
export class AiFastRmqServer extends ServerRMQ {
  private static readonly allowed: ReadonlySet<string> = new Set(
    AI_FAST_PATTERNS,
  );

  constructor(options: Required<RmqOptions>['options']) {
    super(options);
  }

  /** Naqsh `{ cmd }` — faqat `AI_FAST_PATTERNS` dagi `cmd` qabul qilinadi. */
  static accepts(pattern: unknown): boolean {
    const cmd =
      typeof pattern === 'object' && pattern !== null
        ? (pattern as { cmd?: unknown }).cmd
        : undefined;
    return typeof cmd === 'string' && AiFastRmqServer.allowed.has(cmd);
  }

  override addHandler(
    ...args: Parameters<ServerRMQ['addHandler']>
  ): ReturnType<ServerRMQ['addHandler']> {
    if (!AiFastRmqServer.accepts(args[0])) return;
    return super.addHandler(...args);
  }
}
