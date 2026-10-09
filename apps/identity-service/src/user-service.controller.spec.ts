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
   * (GvL6ZFAd) identity.user.find_by_id market_tg_token'ni HECH QACHON
   * so'ramaydi: avvalgi `include_tg_token` istisnosi bekor qilindi — flag
   * kelsa ham servisga faqat id uzatiladi.
   */
  describe('identity.user.find_by_id — include_tg_token e’tiborsiz (GvL6ZFAd)', () => {
    const ctx = {} as RmqContext;

    it.each([[true], ['true'], [1], [undefined]])(
      'include_tg_token %p → findUserById faqat id bilan (token opsiyasi YO`Q)',
      async (flag) => {
        await identityController.getAdminById(
          { id: '3', include_tg_token: flag } as never,
          ctx,
        );

        expect(userService.findUserById).toHaveBeenCalledTimes(1);
        // (i76gGjyq) yagona opsiya — includeDeleted (sukut false).
        expect(userService.findUserById.mock.calls[0]).toEqual([
          '3',
          { includeDeleted: false },
        ]);
      },
    );

    it.each([
      [true, true],
      ['true', false],
      [1, false],
    ])(
      '(i76gGjyq) include_deleted %p → includeDeleted %p (faqat qat`iy true)',
      async (flag, expected) => {
        await identityController.getAdminById(
          { id: '3', include_deleted: flag } as never,
          ctx,
        );
        expect(userService.findUserById.mock.calls[0]).toEqual([
          '3',
          { includeDeleted: expected },
        ]);
      },
    );

    it('identity.user.profile flagni e’tiborsiz qoldiradi (findOwnProfile faqat id bilan)', async () => {
      await identityController.getMyProfile(
        { id: '3', include_tg_token: true } as never,
        ctx,
      );

      expect(userService.findOwnProfile).toHaveBeenCalledWith('3');
      expect(userService.findUserById).not.toHaveBeenCalled();
    });
  });

  /**
   * (GvL6ZFAd) Token RPC'lari requester'ni servisga uzatadi — SUPERADMIN
   * tekshiruvi servisda (ikkinchi qatlam).
   */
  describe('market_tg_token RPC handlerlari requester bilan (GvL6ZFAd)', () => {
    const ctx = {} as RmqContext;
    const requester = { id: '1', roles: ['superadmin'] };

    it('identity.market.get_tg_token → getMarketTelegramToken(id, requester)', async () => {
      userService.getMarketTelegramToken = jest.fn().mockResolvedValue({});

      await identityController.getMarketTgToken({ id: '3', requester }, ctx);

      expect(userService.getMarketTelegramToken).toHaveBeenCalledWith(
        '3',
        requester,
      );
    });

    it('identity.market.rotate_tg_token → rotateMarketTelegramToken(id, requester)', async () => {
      userService.rotateMarketTelegramToken = jest.fn().mockResolvedValue({});

      await identityController.rotateMarketTgToken({ id: '3', requester }, ctx);

      expect(userService.rotateMarketTelegramToken).toHaveBeenCalledWith(
        '3',
        requester,
      );
    });

    it('identity.market.rotate_all_tg_tokens → rotateAllMarketTelegramTokens(confirm, requester)', async () => {
      userService.rotateAllMarketTelegramTokens = jest
        .fn()
        .mockResolvedValue({});

      await identityController.rotateAllMarketTgTokens(
        { confirm: 'ROTATE_ALL', requester },
        ctx,
      );

      expect(userService.rotateAllMarketTelegramTokens).toHaveBeenCalledWith(
        'ROTATE_ALL',
        requester,
      );
    });
  });
});
