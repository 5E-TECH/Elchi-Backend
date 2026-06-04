import {
  Controller,
  GatewayTimeoutException,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';

/**
 * Inbound provider webhooks (cargo / post / marketplace callbacks).
 *
 * Deliberately UNAUTHENTICATED at the JWT layer — providers can't carry our
 * tokens. Authenticity is established downstream by HMAC signature in
 * integration-service, using the per-provider secret. The gateway is a thin
 * pass-through: it captures the exact raw bytes (for signature verification)
 * and forwards them with the request headers to integration-service.
 *
 * Secrets never reach the gateway; verification happens where the secret
 * lives. A forged request is logged and rejected by integration-service.
 */
interface WebhookReceiveResult {
  ok?: boolean;
  code?: number;
  reason?: string | null;
}

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookGatewayController {
  constructor(
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
  ) {}

  @Post(':slug')
  @ApiOperation({
    summary: 'Inbound provider webhook (HMAC-verified downstream, no JWT)',
  })
  @ApiParam({ name: 'slug', description: 'Provider integration slug' })
  async receive(
    @Param('slug') slug: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
  ): Promise<void> {
    // Prefer the exact bytes captured by rawBody; fall back to re-serialising
    // the parsed body if rawBody is unavailable (signature may then fail,
    // which is the correct, safe outcome).
    const raw =
      req.rawBody && Buffer.isBuffer(req.rawBody)
        ? req.rawBody
        : Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }

    const traceId =
      (typeof req.headers['x-request-id'] === 'string'
        ? req.headers['x-request-id']
        : undefined) ?? null;

    try {
      const result = await firstValueFrom(
        this.integrationClient
          .send<WebhookReceiveResult>(
            { cmd: 'integration.webhook.receive' },
            {
              slug,
              raw_body_base64: raw.toString('base64'),
              headers,
              trace_id: traceId,
            },
          )
          .pipe(timeout(10_000)),
      );

      const code = typeof result?.code === 'number' ? result.code : 200;
      res.status(code).json({
        ok: result?.ok ?? false,
        reason: result?.reason ?? null,
      });
    } catch (error) {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Integration service timeout');
      }
      throw error;
    }
  }
}
