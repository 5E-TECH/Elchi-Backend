import { Test, TestingModule } from '@nestjs/testing';
import { IdentityController } from './identity.controller';
import { UserServiceService } from './user-service.service';
import { RmqService } from '@app/common';
import { AuthService } from './auth/auth.service';

describe('IdentityController', () => {
  let identityController: IdentityController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [IdentityController],
      providers: [
        {
          provide: UserServiceService,
          useValue: {
            createAdmin: jest.fn(),
            updateAdmin: jest.fn(),
            deleteAdmin: jest.fn(),
            findAdminById: jest.fn(),
            findAllAdmins: jest.fn(),
            createUserForAuth: jest.fn(),
            findByPhoneForAuth: jest.fn(),
            findByUsernameForAuth: jest.fn(),
            findByIdForAuth: jest.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            login: jest.fn(),
            refresh: jest.fn(),
            validateUser: jest.fn(),
          },
        },
        {
          provide: RmqService,
          useValue: {
            ack: jest.fn(),
          },
        },
      ],
    }).compile();

    identityController = app.get<IdentityController>(IdentityController);
  });

  it('should define controller', () => {
    expect(identityController).toBeDefined();
  });
});
