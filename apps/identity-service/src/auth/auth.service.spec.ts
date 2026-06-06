import { createHash } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';
import { AuthService } from './auth.service';

// BaseEntity is the TypeORM superclass for User; we don't exercise persistence
// in these unit tests, so an empty class stub is sufficient. Enum stubs match
// the values used in user.entity.ts decorators (Roles.ADMIN as default, etc.).
jest.mock('@app/common', () => ({
  Status: { ACTIVE: 'active', INACTIVE: 'inactive' },
  Roles: {
    SUPERADMIN: 'superadmin',
    ADMIN: 'admin',
    COURIER: 'courier',
    REGISTRATOR: 'registrator',
    MARKET: 'market',
    CUSTOMER: 'customer',
    OPERATOR: 'operator',
    MARKET_OPERATOR: 'market_operator',
    MANAGER: 'manager',
    BRANCH: 'branch',
    INVESTOR: 'investor',
  },
  Where_deliver: { CENTER: 'center', HOME: 'home' },
  CourierCompensationMode: {
    SALARY_ONLY: 'salary_only',
    PER_ORDER: 'per_order',
    SALARY_PLUS_PER_ORDER: 'salary_plus_per_order',
  },
  Commission_type: { PERCENT: 'percent', FIXED: 'fixed' },
  numericTransformer: { to: (v: unknown) => v, from: (v: unknown) => v },
  rmqSend: jest.fn(),
  BaseEntity: class BaseEntity {},
}));

jest.mock('../../../../libs/common/helpers/bcrypt', () => ({
  BcryptEncryption: class {
    encrypt = jest.fn();
    compare = jest.fn();
  },
}));

jest.mock('../../../../libs/common/helpers/response', () => ({
  errorRes: (message: string, statusCode: number) => ({ message, statusCode }),
  successRes: (data: any, statusCode: number, message: string) => ({ data, statusCode, message }),
}));

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface MockUser {
  id: string;
  username: string;
  status: string;
  refresh_token: string | null;
  isDeleted: boolean;
}

function buildService(user: MockUser | null) {
  const usersRepo: any = {
    findOne: jest.fn().mockResolvedValue(user),
    save: jest.fn().mockImplementation(async (u: any) => u),
    update: jest.fn().mockResolvedValue({}),
  };

  const jwtService: any = {
    verifyAsync: jest.fn().mockResolvedValue({ sub: user?.id ?? 'unknown', username: user?.username ?? 'unknown' }),
    signAsync: jest.fn().mockResolvedValue('new-jwt'),
    decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  };

  const configService: any = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'REFRESH_TOKEN_KEY') return 'test-secret';
      if (key === 'REFRESH_TOKEN_TIME') return '7d';
      return undefined;
    }),
  };

  const bcryptEncryption: any = { compare: jest.fn(), encrypt: jest.fn() };
  const branchClient: any = { send: jest.fn() };

  const service = new AuthService(
    usersRepo,
    jwtService,
    configService,
    bcryptEncryption,
    branchClient,
  );

  return { service, usersRepo, jwtService, configService };
}

describe('AuthService.refresh', () => {
  const VALID_TOKEN = 'plaintext-refresh-token-value';
  const VALID_HASH = sha256(VALID_TOKEN);

  it('rotates the token and stores SHA-256 hash (not plaintext) on success', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: VALID_HASH,
      isDeleted: false,
    };
    const { service, usersRepo, jwtService } = buildService(user);

    // The new refresh token issued by signAsync becomes the next stored hash.
    jwtService.signAsync = jest
      .fn()
      .mockResolvedValueOnce('new-access-token')
      .mockResolvedValueOnce('new-refresh-token');

    const res = await service.refresh({ refreshToken: VALID_TOKEN } as any);

    expect(res.statusCode).toBe(200);
    // saveRefreshToken stores the hash of the NEW token, never plaintext.
    expect(usersRepo.update).toHaveBeenCalledTimes(1);
    const updateCall = usersRepo.update.mock.calls[0];
    expect(updateCall[1].refresh_token).toBe(sha256('new-refresh-token'));
    expect(updateCall[1].refresh_token).not.toBe('new-refresh-token');
  });

  it('rejects when no refresh token is stored (already logged out)', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: null,
      isDeleted: false,
    };
    const { service } = buildService(user);

    await expect(
      service.refresh({ refreshToken: VALID_TOKEN } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('detects reuse: stored hash differs → invalidates session AND rejects', async () => {
    // Stolen token replay: legitimate user has already rotated to a new
    // hash, attacker presents the old plaintext.
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: sha256('different-token'), // a rotated newer one
      isDeleted: false,
    };
    const { service, usersRepo } = buildService(user);

    await expect(
      service.refresh({ refreshToken: VALID_TOKEN } as any),
    ).rejects.toBeInstanceOf(RpcException);

    // CRITICAL: session must be wiped (refresh_token = null) so the
    // attacker's previously-rotated token is also invalidated.
    expect(usersRepo.save).toHaveBeenCalledTimes(1);
    const savedUser = usersRepo.save.mock.calls[0][0];
    expect(savedUser.refresh_token).toBeNull();
  });

  it('rejects when user is inactive', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'inactive',
      refresh_token: VALID_HASH,
      isDeleted: false,
    };
    const { service } = buildService(user);

    await expect(
      service.refresh({ refreshToken: VALID_TOKEN } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('rejects when username in payload mismatches the user record', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: VALID_HASH,
      isDeleted: false,
    };
    const { service, jwtService } = buildService(user);
    jwtService.verifyAsync = jest
      .fn()
      .mockResolvedValue({ sub: 'u1', username: 'evil-different' });

    await expect(
      service.refresh({ refreshToken: VALID_TOKEN } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('rejects when the JWT signature is invalid', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: VALID_HASH,
      isDeleted: false,
    };
    const { service, jwtService } = buildService(user);
    jwtService.verifyAsync = jest.fn().mockRejectedValue(new Error('jwt malformed'));

    await expect(
      service.refresh({ refreshToken: VALID_TOKEN } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('rejects when user is soft-deleted', async () => {
    // findOne already filters isDeleted=false, so a deleted user returns null.
    const { service } = buildService(null);

    await expect(
      service.refresh({ refreshToken: VALID_TOKEN } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });
});

describe('AuthService.logout', () => {
  it('nulls the refresh_token in DB', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: sha256('some'),
      isDeleted: false,
    };
    const { service, usersRepo } = buildService(user);

    await service.logout('u1');

    expect(usersRepo.save).toHaveBeenCalledTimes(1);
    const saved = usersRepo.save.mock.calls[0][0];
    expect(saved.refresh_token).toBeNull();
  });
});
