import { Test, TestingModule } from '@nestjs/testing';
import { of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';

describe('ApiGatewayController', () => {
  let apiGatewayController: ApiGatewayController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        {
          provide: 'USER',
          useValue: {
            send: jest.fn().mockReturnValue(of({ ok: true })),
          },
        },
      ],
    }).compile();

    apiGatewayController = app.get<ApiGatewayController>(ApiGatewayController);
  });

  it('should define controller', () => {
    expect(apiGatewayController).toBeDefined();
  });
});
