import { Test, TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';
import {
  CreateCourierRequestDto,
  UpdateAdminRequestDto,
} from './dto/identity.swagger.dto';

/**
 * DtKKY0V8 — kuryer `district_id`:
 *   - CreateCourierRequestDto (POST /couriers) — yangi: ilgari maydon yo'q edi,
 *     global ValidationPipe (whitelist + forbidNonWhitelisted) 400 berardi;
 *   - UpdateAdminRequestDto (PATCH /users/:id) — 2026-10-23 dan bor (YEThmZBn),
 *     shu yerda ham qayd etiladi;
 *   - gateway qiymatni `identity.courier.create` ga uzatadi (mavjudlik va
 *     viloyatga mosligini identity tekshiradi).
 */
const courierBody = (over: Record<string, unknown> = {}) => ({
  name: 'TEST-KURYER',
  phone_number: '+998901112233',
  password: 'secret123',
  tariff_home: 10000,
  tariff_center: 8000,
  ...over,
});

const errorsFor = async (
  cls: typeof CreateCourierRequestDto | typeof UpdateAdminRequestDto,
  body: Record<string, unknown>,
) =>
  (
    await validate(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

describe('DtKKY0V8 — DTO shakli', () => {
  it.each([['41'], [null], [undefined]])(
    '⭐ CreateCourierRequestDto district_id=%p — qabul qilinadi',
    async (district_id) => {
      expect(
        await errorsFor(CreateCourierRequestDto, courierBody({ district_id })),
      ).toEqual([]);
    },
  );

  it.each([['abc'], ['-1'], [''], [41]])(
    'CreateCourierRequestDto district_id=%p — 400',
    async (district_id) => {
      expect(
        await errorsFor(CreateCourierRequestDto, courierBody({ district_id })),
      ).toEqual(['district_id']);
    },
  );

  it('UpdateAdminRequestDto district_id (YEThmZBn) — qabul qilinadi', async () => {
    expect(
      await errorsFor(UpdateAdminRequestDto, { district_id: '41' }),
    ).toEqual([]);
  });
});

describe('DtKKY0V8 — POST /couriers district_id identity`ga uzatiladi', () => {
  let controller: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let branchClient: { send: jest.Mock };

  beforeEach(async () => {
    identityClient = { send: jest.fn(() => of({ statusCode: 201 })) };
    branchClient = {
      send: jest.fn((pattern: { cmd: string }) =>
        pattern.cmd === 'branch.find_by_id'
          ? of({ data: { id: '6', type: 'REGIONAL', region_id: '3' } })
          : of({
              data: { branch_id: '6', branch: { id: '6', type: 'REGIONAL' } },
            }),
      ),
    };
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: identityClient },
        { provide: 'FINANCE', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: branchClient },
      ],
    }).compile();
    controller = app.get(ApiGatewayController);
  });

  const MANAGER = { user: { sub: '19', username: 'm', roles: ['manager'] } };

  const sentDto = () =>
    (
      identityClient.send.mock.calls[0] as [
        { cmd: string },
        { dto: Record<string, unknown> },
      ]
    )[1].dto;

  it('⭐ menejer: district_id filial viloyati bilan birga uzatiladi', async () => {
    await controller.createCourier(
      courierBody({ district_id: '41' }) as never,
      MANAGER as never,
    );

    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.courier.create' },
      expect.anything(),
    );
    expect(sentDto()).toMatchObject({
      district_id: '41',
      region_id: '3',
      branch_id: '6',
    });
  });

  it.each([[undefined], [null]])(
    'district_id=%p — identity`ga undefined (tumansiz)',
    async (district_id) => {
      await controller.createCourier(
        courierBody({ district_id }) as never,
        MANAGER as never,
      );
      expect(sentDto().district_id).toBeUndefined();
    },
  );
});
