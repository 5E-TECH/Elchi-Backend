import { Test } from '@nestjs/testing';
import {
  Controller,
  Get,
  INestApplication,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import request from 'supertest';

// Proves the gateway's NON-BREAKING versioning config (main.ts): with
// defaultVersion [VERSION_NEUTRAL, '1'], every controller route is reachable at
// BOTH its current un-prefixed path (so the existing frontend keeps working)
// AND at /v1. Uses a throwaway module so it doesn't need the full gateway wiring.
@Controller('probe')
class ProbeController {
  @Get()
  get() {
    return { ok: true };
  }
}

describe('gateway URI versioning is non-breaking', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the route at the current un-prefixed path (frontend unaffected)', async () => {
    await request(app.getHttpServer()).get('/probe').expect(200, { ok: true });
  });

  it('serves the same route at /v1 (new versioned surface)', async () => {
    await request(app.getHttpServer())
      .get('/v1/probe')
      .expect(200, { ok: true });
  });
});
