import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { SmsOutboxService } from './sms-outbox.service';
import { SmsProviderRegistry } from './sms-provider.registry';
import { asText } from './sms-phone.util';

export interface SmsDlrInput {
  provider?: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

/**
 * Yetkazilganlik hisoboti (8auPBa1O #3-#4). Webhook @Public — shuning uchun
 * har xabarga alohida HMAC token (callback_url ichida) tekshiriladi; sir faqat
 * shu servisda. Noto'g'ri token → 401, HECH QANDAY qator o'zgarmaydi.
 */
@Injectable()
export class SmsDlrService {
  private readonly logger = new Logger(SmsDlrService.name);

  constructor(
    private readonly registry: SmsProviderRegistry,
    private readonly outbox: SmsOutboxService,
  ) {}

  async handle(input: SmsDlrInput) {
    const provider = String(input?.provider ?? '').toLowerCase();
    const query = input?.query ?? {};
    const cmid = asText(query.cmid);
    if (!cmid || !this.registry.verifyDlrToken(cmid, query.token)) {
      this.logger.warn(
        `SMS DLR rad etildi: imzo noto'g'ri (provider=${provider})`,
      );
      throw new RpcException({
        statusCode: 401,
        message: 'Invalid DLR signature',
      });
    }
    const parser = this.registry.parserFor(provider);
    const report =
      parser?.parseDeliveryReport({ query, body: input?.body ?? {} }) ?? null;
    if (!report || report.clientMessageId !== cmid) {
      return { ok: true, applied: false, reason: 'unrecognized_payload' };
    }
    const applied = await this.outbox.applyDeliveryReport(report);
    return { ok: true, applied, status: report.status };
  }
}
