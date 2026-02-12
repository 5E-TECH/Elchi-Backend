import { Test, TestingModule } from '@nestjs/testing';
import { UserServiceController } from './user-service.controller';
import { UserServiceService } from './user-service.service';
import { RmqService } from '@app/common';

describe('UserServiceController', () => {
  let userServiceController: UserServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [UserServiceController],
      providers: [
        {
          provide: UserServiceService,
          useValue: {
            createUser: jest.fn(),
            updateUser: jest.fn(),
            deleteUser: jest.fn(),
            findById: jest.fn(),
            findByUsername: jest.fn(),
            findAll: jest.fn(),
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

    userServiceController = app.get<UserServiceController>(UserServiceController);
  });

  it('should define controller', () => {
    expect(userServiceController).toBeDefined();
  });
});
