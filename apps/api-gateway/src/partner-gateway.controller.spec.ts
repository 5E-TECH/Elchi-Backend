import { ExecutionContext, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { PartnerApiKeyGuard } from './auth/partner-api-key.guard';
import { PartnerThrottlerGuard } from './auth/partner-throttler.guard';
import {
  PartnerGatewayController,
  PARTNER_THROTTLE_LIMIT,
} from './partner-gateway.controller';

describe('PartnerGatewayController (HTTP) — auth + rate limit', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          // Baseline yuqori — /partner uchun controller @Throttle (PARTNER_THROTTLE_LIMIT) ustun bo‘ladi.
          throttlers: [{ name: 'default', ttl: 60_000, limit: 1_000_000 }],
        }),
      ],
      controllers: [PartnerGatewayController],
      providers: [
        PartnerThrottlerGuard,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    })
      // PartnerApiKeyGuard'ni stub bilan almashtiramiz: RMQ kalit tekshiruvini
      // chetlab, req.partner'ni to‘ldiradi — bu yerda controller + rate limit
      // sinaladi (guardning o‘zi alohida unit-testda).
      .overrideGuard(PartnerApiKeyGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context
            .switchToHttp()
            .getRequest<{ partner?: unknown }>();
          req.partner = { id: 'test-partner', name: 'Test' };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('TC1: yaroqli kalit -> 200 va hamkor ma‘lumoti qaytadi', async () => {
    const res = await request(app.getHttpServer()).get('/partner/ping');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      authenticated: true,
      partner: { id: 'test-partner', name: 'Test' },
    });
  });

  it('TC3: limitdan oshiq so‘rov -> 429', async () => {
    let sawTooMany = false;
    // limit + 1 so‘rov (per-hamkor tracker bo‘yicha) -> oxirgisi 429.
    for (let i = 0; i <= PARTNER_THROTTLE_LIMIT; i++) {
      const res = await request(app.getHttpServer()).get('/partner/ping');
      if (res.status === 429) sawTooMany = true;
    }
    expect(sawTooMany).toBe(true);
  }, 20_000);
});
