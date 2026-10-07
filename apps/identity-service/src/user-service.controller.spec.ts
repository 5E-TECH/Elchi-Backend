import { OtpService } from './otp/otp.service';
import { Test, TestingModule } from '@nestjs/testing';
import type { RmqContext } from '@nestjs/microservices';
import { IdentityController } from './identity.controller';
import { UserServiceService } from './user-service.service';
import { RmqService } from '@app/common';
import { AuthService } from './auth/auth.service';

describe('IdentityController', () => {
  let identityController: IdentityController;
  let userService: {
    findUserById: jest.Mock;
    findOwnProfile: jest.Mock;
  } & Record<string, jest.Mock>;

  beforeEach(async () => {
    userService = {
      createAdmin: jest.fn(),
      updateAdmin: jest.fn(),
      deleteAdmin: jest.fn(),
      findAdminById: jest.fn(),
      findAllAdmins: jest.fn(),
      createUserForAuth: jest.fn(),
      findByPhoneForAuth: jest.fn(),
      findByUsernameForAuth: jest.fn(),
      findByIdForAuth: jest.fn(),
      findUserById: jest.fn().mockResolvedValue({ statusCode: 200 }),
      findOwnProfile: jest.fn().mockResolvedValue({ statusCode: 200 }),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [IdentityController],
      providers: [
        {
          provide: UserServiceService,
          useValue: userService,
        },
        {
          provide: AuthService,
          useValue: {
            login: jest.fn(),
            refresh: jest.fn(),
            validateUser: jest.fn(),
          },
        },
        { provide: OtpService, useValue: {} },
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

  /**
   * Item 4 — market_tg_token faqat qat'iy `include_tg_token === true` bilan
   * so'raladi (gateway uni faqat SUPERADMIN/ADMIN GET /users/:id da yuboradi).
   * 'true' satri yoki 1 tokenni ochmaydi.
   */
  describe("identity.user.find_by_id — include_tg_token qat'iy boolean", () => {
    const ctx = {} as RmqContext;

    it('include_tg_token: true → findUserById(id, { includeTgToken: true })', async () => {
      await identityController.getAdminById(
        { id: '3', include_tg_token: true },
        ctx,
      );

      expect(userService.findUserById).toHaveBeenCalledWith('3', {
        includeTgToken: true,
      });
    });

    it("flag yo'q → { includeTgToken: false }", async () => {
      await identityController.getAdminById({ id: '3' }, ctx);

      expect(userService.findUserById).toHaveBeenCalledWith('3', {
        includeTgToken: false,
      });
    });

    it.each([['true'], [1], ['1'], [null]])(
      'include_tg_token %p (boolean true emas) → { includeTgToken: false }',
      async (flag) => {
        await identityController.getAdminById(
          { id: '3', include_tg_token: flag } as never,
          ctx,
        );

        expect(userService.findUserById).toHaveBeenCalledWith('3', {
          includeTgToken: false,
        });
      },
    );

    it('identity.user.profile flagni e’tiborsiz qoldiradi (findOwnProfile faqat id bilan)', async () => {
      await identityController.getMyProfile(
        { id: '3', include_tg_token: true },
        ctx,
      );

      expect(userService.findOwnProfile).toHaveBeenCalledWith('3');
      expect(userService.findUserById).not.toHaveBeenCalled();
    });
  });
});
