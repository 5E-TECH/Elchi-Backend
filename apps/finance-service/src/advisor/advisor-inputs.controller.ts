import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
  RpcException,
} from '@nestjs/microservices';
import {
  AI_ADVISOR_FINANCE_RULE_INPUTS,
  RmqService,
  executeAndAck,
  type AiAdvisorRuleInputsRequest,
} from '@app/common';
import { AdvisorInputsService } from './advisor-inputs.service';

/**
 * BE-5 (LhTIno57) — `finance.advisor.rule_inputs` (FAQAT o'qish). Chaqiruvchi
 * — faqat ai-service (`AdvisorReader` oq ro'yxati); HTTP yo'li yo'q.
 * Kutilmagan xato → RpcException 500 (requeue yo'q, ichki matn chiqmaydi).
 */
@Controller()
export class AdvisorInputsController {
  private readonly logger = new Logger(AdvisorInputsController.name);

  constructor(
    private readonly rmqService: RmqService,
    private readonly inputs: AdvisorInputsService,
  ) {}

  @MessagePattern({ cmd: AI_ADVISOR_FINANCE_RULE_INPUTS })
  ruleInputs(
    @Payload() data: AiAdvisorRuleInputsRequest,
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, async () => {
      try {
        return await this.inputs.ruleInputs(data);
      } catch (error) {
        this.logger.error(
          `advisor.rule_inputs xato: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown'}`,
        );
        throw new RpcException({
          statusCode: 500,
          message: 'advisor.rule_inputs bajarilmadi',
        });
      }
    });
  }
}
