import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Optional,
  Res,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import type { AiHealthState } from '@app/common';
import { Public } from './auth/public.decorator';
import { AiStatusPoller } from './ai/ai-status.poller';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { firstValueFrom, timeout } from 'rxjs';

interface ServiceHealth {
  service: string;
  status: 'ok' | 'down' | 'unknown';
  latency_ms?: number;
  error?: string;
}

const SERVICE_HEALTH_PROBES: Array<{ token: string; cmd: string }> = [
  { token: 'IDENTITY', cmd: 'identity.health' },
  { token: 'ORDER', cmd: 'salom_ber_order' },
  { token: 'CATALOG', cmd: 'catalog.health' },
  { token: 'LOGISTICS', cmd: 'logistics.health' },
  { token: 'FINANCE', cmd: 'finance.health' },
  { token: 'NOTIFICATION', cmd: 'notification.health' },
  { token: 'INTEGRATION', cmd: 'integration.health' },
  { token: 'ANALYTICS', cmd: 'analytics.health' },
  { token: 'BRANCH', cmd: 'branch.health' },
  { token: 'INVESTOR', cmd: 'investor.health' },
  { token: 'FILE', cmd: 'file.health' },
  { token: 'C2C', cmd: 'c2c.health' },
  { token: 'SEARCH', cmd: 'search.health' },
  // AI buyurtma (ai-service, port 3024). ⚠️ Bu yerda FAQAT readiness — liveness
  // (`GET /health`) ai-service'ni kutmaydi, poller keshini o'qiydi.
  { token: 'AI', cmd: 'ai.health' },
];

const PROBE_TIMEOUT_MS = 1500;

@ApiTags('Health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  private readonly clients: Map<string, ClientProxy>;

  constructor(
    @Inject('IDENTITY') identityClient: ClientProxy,
    @Inject('ORDER') orderClient: ClientProxy,
    @Inject('CATALOG') catalogClient: ClientProxy,
    @Inject('LOGISTICS') logisticsClient: ClientProxy,
    @Inject('FINANCE') financeClient: ClientProxy,
    @Inject('NOTIFICATION') notificationClient: ClientProxy,
    @Inject('INTEGRATION') integrationClient: ClientProxy,
    @Inject('ANALYTICS') analyticsClient: ClientProxy,
    @Inject('BRANCH') branchClient: ClientProxy,
    @Inject('INVESTOR') investorClient: ClientProxy,
    @Inject('FILE') fileClient: ClientProxy,
    @Inject('C2C') c2cClient: ClientProxy,
    @Inject('SEARCH') searchClient: ClientProxy,
    // Ixtiyoriy (oxirida) — mavjud pozitsion konstruktor chaqiruvlari buzilmaydi.
    @Optional() @Inject('AI') aiClient?: ClientProxy,
    @Optional() private readonly aiStatus?: AiStatusPoller,
  ) {
    this.clients = new Map<string, ClientProxy>([
      ['IDENTITY', identityClient],
      ['ORDER', orderClient],
      ['CATALOG', catalogClient],
      ['LOGISTICS', logisticsClient],
      ['FINANCE', financeClient],
      ['NOTIFICATION', notificationClient],
      ['INTEGRATION', integrationClient],
      ['ANALYTICS', analyticsClient],
      ['BRANCH', branchClient],
      ['INVESTOR', investorClient],
      ['FILE', fileClient],
      ['C2C', c2cClient],
      ['SEARCH', searchClient],
    ]);
    if (aiClient) {
      this.clients.set('AI', aiClient);
    }
  }

  /**
   * Liveness — tez va faqat gateway'ning o'zi.
   *
   * ⚠️ `ai` maydoni (bVeyEuIR #2) AiStatusPoller KESHIDAN o'qiladi — bu
   * metod SINXRON va RMQ'ni HECH QACHON kutmaydi: ai-service sekinlashsa ham
   * gateway healthcheck'i yiqilmaydi. Qiymat: enabled | disabled |
   * cap_exceeded | unknown.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness check — fast, gateway-only' })
  check(): {
    status: string;
    timestamp: string;
    service: string;
    ai: AiHealthState;
  } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'api-gateway',
      ai: this.aiStatus?.getState() ?? 'unknown',
    };
  }

  /**
   * Readiness probe — pings every downstream service via RMQ in parallel.
   * Returns 200 only when all are reachable; 503 if any are down so that K8s
   * (or a load balancer) takes the gateway out of rotation.
   */
  @Public()
  @Get('readiness')
  @ApiOperation({ summary: 'Readiness check — pings every downstream service' })
  async readiness(@Res({ passthrough: true }) res: Response) {
    const probes = await Promise.all(
      SERVICE_HEALTH_PROBES.map((probe) =>
        this.probeOne(probe.token, probe.cmd),
      ),
    );

    const allOk = probes.every((p) => p.status === 'ok');
    res.status(allOk ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services: probes,
    };
  }

  private async probeOne(token: string, cmd: string): Promise<ServiceHealth> {
    const client = this.clients.get(token);
    if (!client) {
      return {
        service: token,
        status: 'unknown',
        error: 'client not registered',
      };
    }

    const startedAt = Date.now();
    try {
      await firstValueFrom(
        client.send({ cmd }, {}).pipe(timeout(PROBE_TIMEOUT_MS)),
      );
      return {
        service: token,
        status: 'ok',
        latency_ms: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        service: token,
        status: 'down',
        latency_ms: Date.now() - startedAt,
        error: (error as Error)?.message ?? 'unknown error',
      };
    }
  }
}
