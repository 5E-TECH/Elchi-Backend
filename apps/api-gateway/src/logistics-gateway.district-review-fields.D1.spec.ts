import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { projectDistrictReviewFields } from './auth/district-review-projection';
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * D1 (round 3, S7): tumanlardagi `assignment_*` maydonlari (ichki admin id
 * `assignment_confirmed_by` ham) faqat SUPERADMIN/ADMIN ga. GET /district,
 * /district/:id, /district/sato/:code, /region, /region/:id — MARKET,
 * COURIER, MARKET_OPERATOR, filial xodimlariga kesiladi. Sintetik ma'lumot.
 */
const fakeJwtGuard = {
  canActivate: (ctx: ExecutionContext) => {
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const role = req.headers['x-test-role'];
    if (!role) return false;
    req.user = { sub: '1', username: 'u', roles: [role] };
    return true;
  },
};

const REVIEW = {
  assignment_review_required: true,
  assignment_review_reason: 'auto_assigned_D1',
  assignment_flagged_at: '2026-11-14T10:00:00.000Z',
  assignment_confirmed_by: '42',
  assignment_confirmed_at: null,
};
const district = (id: string) => ({
  id,
  name: `Tuman ${id}`,
  region_id: '1',
  assigned_region: '1',
  region: { id: '1', name: 'Viloyat' },
  ...REVIEW,
});
const region = {
  id: '1',
  name: 'Viloyat',
  districts: [district('5')],
  assignedDistricts: [district('5'), district('6')],
};
const REPLIES: Record<string, unknown> = {
  'logistics.district.find_all': { statusCode: 200, data: [district('5')] },
  'logistics.district.find_by_id': { statusCode: 200, data: district('5') },
  'logistics.district.find_by_sato': { statusCode: 200, data: district('5') },
  'logistics.region.find_all': { statusCode: 200, data: [region] },
  'logistics.region.find_by_id': { statusCode: 200, data: region },
};
const ROUTES = [
  '/district',
  '/district/5',
  '/district/sato/1730401',
  '/region',
  '/region/1',
];

const hasReviewKey = (value: unknown): boolean =>
  JSON.stringify(value).includes('"assignment_');

describe('D1 S7: assignment_* faqat admin', () => {
  let app: INestApplication;
  const logisticsSend = jest.fn((pattern: { cmd: string }) =>
    of(REPLIES[pattern.cmd]),
  );
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LogisticsGatewayController],
      providers: [
        { provide: 'LOGISTICS', useValue: { send: logisticsSend } },
        { provide: 'IDENTITY', useValue: { send: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(fakeJwtGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it.each(['market', 'courier', 'manager'])(
    '%s — barcha marshrutlarda assignment_* yo‘q, qolgan maydonlar joyida',
    async (role) => {
      for (const route of ROUTES) {
        const res = await request(http())
          .get(route)
          .set('x-test-role', role)
          .expect(200);
        expect(hasReviewKey(res.body)).toBe(false);
        expect(JSON.stringify(res.body)).toContain('"Tuman 5"');
      }
    },
  );

  it('market_operator — GET /district, /district/:id, /region, /region/:id', async () => {
    for (const route of ['/district', '/district/5', '/region', '/region/1']) {
      const res = await request(http())
        .get(route)
        .set('x-test-role', 'market_operator')
        .expect(200);
      expect(hasReviewKey(res.body)).toBe(false);
    }
  });

  it.each(['superadmin', 'admin'])(
    '%s — maydonlar to‘liq qaytadi',
    async (role) => {
      for (const route of ROUTES) {
        const res = await request(http())
          .get(route)
          .set('x-test-role', role)
          .expect(200);
        expect(JSON.stringify(res.body)).toContain(
          '"assignment_confirmed_by":"42"',
        );
      }
    },
  );

  it('asl javob o‘zgartirilmaydi (nusxa)', () => {
    const original = { statusCode: 200, data: [district('5')] };
    const projected = projectDistrictReviewFields(original, ['courier']);
    expect(hasReviewKey(projected)).toBe(false);
    expect(original.data[0].assignment_confirmed_by).toBe('42');
  });
});
