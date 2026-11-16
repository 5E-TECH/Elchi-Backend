import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  AI_ADVISOR_FINANCE_RULE_INPUTS,
  rmqSend,
  type AiAdvisorRuleInputsRequest,
  type AiAdvisorRuleInputsResponse,
} from '@app/common';

/**
 * BE-5 (LhTIno57) — AI maslahatchining ALOHIDA o'qish mijozi (§4.4).
 * `AssistantReader` ga qo'shilmaydi: oq ro'yxat faqat shu buyruqlar.
 * Qoidalar SQL agregatlari og'ir bo'lishi mumkin — 30 s, bitta qayta urinish
 * (faqat o'qish, idempotent).
 */
export const AI_ADVISOR_READ_PATTERNS = [
  { client: 'FINANCE', cmd: AI_ADVISOR_FINANCE_RULE_INPUTS },
] as const;
export const ADVISOR_READ_TIMEOUT_MS = 30_000;

@Injectable()
export class AdvisorReader {
  constructor(@Inject('FINANCE') private readonly finance: ClientProxy) {}

  ruleInputs(
    request: AiAdvisorRuleInputsRequest,
  ): Promise<AiAdvisorRuleInputsResponse> {
    return rmqSend<AiAdvisorRuleInputsResponse>(
      this.finance,
      { cmd: AI_ADVISOR_FINANCE_RULE_INPUTS },
      request,
      { timeoutMs: ADVISOR_READ_TIMEOUT_MS, retries: 1 },
    );
  }
}
