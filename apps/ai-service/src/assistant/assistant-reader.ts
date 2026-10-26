import { Inject, Injectable, Optional } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  AI_ASSISTANT_READ_PATTERNS,
  rmqSend,
  type AiAssistantReadClient,
} from '@app/common';

/** Bitta o'qish RPC'si uchun timeout (ms) — sekin hisobot butun siklni to'xtatmasin. */
export const ASSISTANT_READ_TIMEOUT_MS = 12_000;

/** Oq ro'yxatda yo'q buyruq — dasturchi xatosi (model hech qachon cmd tanlamaydi). */
export class AssistantReadForbiddenError extends Error {
  constructor(client: string, cmd: string) {
    super(`assistant_read_forbidden client=${client} cmd=${cmd}`);
    this.name = 'AssistantReadForbiddenError';
  }
}

const ALLOWED = new Set(
  AI_ASSISTANT_READ_PATTERNS.map((p) => `${p.client}:${p.cmd}`),
);

/**
 * F7PWp6cK — yordamchi tool'lari uchun YAGONA RMQ chiqish nuqtasi.
 *
 * ⚠️ Faqat `AI_ASSISTANT_READ_PATTERNS` (o'qish handler'lari) — boshqa har
 * qanday buyruq mijozga YETIB BORMAY rad etiladi. Tool'lar mijozlarni
 * to'g'ridan-to'g'ri olmaydi, faqat shu sinf orqali o'qiydi.
 *
 * Qayta urinish 1 marta (o'qish idempotent), timeout 12 s.
 */
@Injectable()
export class AssistantReader {
  constructor(
    @Optional() @Inject('FINANCE') private readonly finance?: ClientProxy,
    @Optional() @Inject('ANALYTICS') private readonly analytics?: ClientProxy,
    @Optional() @Inject('BRANCH') private readonly branch?: ClientProxy,
  ) {}

  static isAllowed(client: AiAssistantReadClient, cmd: string): boolean {
    return ALLOWED.has(`${client}:${cmd}`);
  }

  async read<T = unknown>(
    client: AiAssistantReadClient,
    cmd: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    if (!AssistantReader.isAllowed(client, cmd)) {
      throw new AssistantReadForbiddenError(client, cmd);
    }
    const proxy =
      client === 'FINANCE'
        ? this.finance
        : client === 'ANALYTICS'
          ? this.analytics
          : this.branch;
    if (!proxy) {
      throw new Error(`assistant_read_client_missing client=${client}`);
    }
    return rmqSend<T>(proxy, { cmd }, payload, {
      timeoutMs: ASSISTANT_READ_TIMEOUT_MS,
      retries: 1,
      attachRequestId: false,
    });
  }
}
