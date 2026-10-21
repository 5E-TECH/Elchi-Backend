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
  ActivityAction: {
    CREATED: 'created',
    UPDATED: 'updated',
    DELETED: 'deleted',
    STATUS_CHANGE: 'status_change',
    LOGIN: 'login',
    LOGOUT: 'logout',
    AUTH_FAILURE: 'auth_failure',
  },
  ActivityLogService: class ActivityLogService {},
  // 2WRzdWpZ / f2Ud5tju — sof funksiyalar, haqiqiylari ishlatiladi.
  ActivityDescribeUz: jest.requireActual(
    '../../../../libs/common/src/activity-log/describe-uz',
  ).ActivityDescribeUz,
  computeHmacSignature: jest.requireActual(
    '../../../../libs/common/src/webhook/hmac',
  ).computeHmacSignature,
  normalizeUzPhone: jest.requireActual(
    '../../../../libs/common/src/ai-text/phone',
  ).normalizeUzPhone,
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
  successRes: (data: any, statusCode: number, message: string) => ({
    data,
    statusCode,
    message,
  }),
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

/**
 * (Elchi Pochta #3) Sessiya do'koni stub'i: `sessionsByHash` dagi hash'lar
 * ochiq sessiya. Haqiqiy AuthSessionService bilan to'liq oqim —
 * `auth.sessions.spec.ts`.
 */
function buildSessions(sessionsByHash: Record<string, { id: string }> = {}) {
  return {
    findByHash: jest.fn((hash: string) =>
      Promise.resolve(
        sessionsByHash[hash]
          ? { ...sessionsByHash[hash], user_id: 'u1', revoked_at: null }
          : null,
      ),
    ),
    adoptLegacy: jest.fn((input: { refreshToken: string }) =>
      Promise.resolve({
        id: `legacy-${sha256(input.refreshToken).slice(0, 6)}`,
        user_id: 'u1',
        revoked_at: null,
      }),
    ),
    rejectReason: jest.fn().mockReturnValue(null),
    touch: jest.fn().mockResolvedValue(true),
    revokeOwn: jest.fn().mockResolvedValue(1),
    open: jest.fn().mockResolvedValue({ id: 'new-session' }),
  };
}

function buildService(user: MockUser | null, sessions = buildSessions()) {
  const usersRepo: any = {
    findOne: jest.fn().mockResolvedValue(user),
    save: jest.fn().mockImplementation((u: any) => Promise.resolve(u)),
    update: jest.fn().mockResolvedValue({}),
  };

  const jwtService: any = {
    verifyAsync: jest.fn().mockResolvedValue({
      sub: user?.id ?? 'unknown',
      username: user?.username ?? 'unknown',
    }),
    signAsync: jest.fn().mockResolvedValue('new-jwt'),
    decode: jest
      .fn()
      .mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  };

  const configService: any = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'REFRESH_TOKEN_KEY') return 'test-secret';
      if (key === 'REFRESH_TOKEN_TIME') return '1d';
      return undefined;
    }),
  };

  const bcryptEncryption: any = { compare: jest.fn(), encrypt: jest.fn() };
  const branchClient: any = { send: jest.fn() };
  const activityLog: any = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  const service = new AuthService(
    usersRepo,
    jwtService,
    configService,
    bcryptEncryption,
    branchClient,
    activityLog,
    sessions as never,
  );

  return {
    service,
    usersRepo,
    jwtService,
    configService,
    activityLog,
    sessions,
  };
}

describe('AuthService.refresh', () => {
  const VALID_TOKEN = 'plaintext-refresh-token-value';
  const VALID_HASH = sha256(VALID_TOKEN);

  it('renews only the access token (with the session id) and preserves refresh expiry on success', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: null,
      isDeleted: false,
    };
    const sessions = buildSessions({ [VALID_HASH]: { id: 'sess-1' } });
    const { service, usersRepo, jwtService } = buildService(user, sessions);

    jwtService.signAsync = jest.fn().mockResolvedValue('new-access-token');
    const refreshExpirySeconds = Math.floor(Date.now() / 1000) + 3600;
    jwtService.decode = jest.fn().mockImplementation((token: string) => ({
      exp:
        token === VALID_TOKEN
          ? refreshExpirySeconds
          : refreshExpirySeconds - 1800,
    }));

    const res = await service.refresh({ refreshToken: VALID_TOKEN } as any);

    expect(res.statusCode).toBe(200);
    expect(res.accessToken).toBe('new-access-token');
    expect(res).not.toHaveProperty('refreshToken');
    expect(res.refreshTokenExpiresAt).toBe(refreshExpirySeconds * 1000);
    expect(res.refreshTokenWarnAt).toBe(
      refreshExpirySeconds * 1000 - 15 * 60 * 1000,
    );
    expect(usersRepo.update).not.toHaveBeenCalled();
    expect(usersRepo.save).not.toHaveBeenCalled();
    expect(jwtService.signAsync).toHaveBeenCalledTimes(1);
    expect(jwtService.signAsync.mock.calls[0][0]).toEqual(
      expect.objectContaining({ sub: 'u1', sid: 'sess-1' }),
    );
    expect(sessions.findByHash).toHaveBeenCalledWith(VALID_HASH);
    expect(sessions.touch).toHaveBeenCalledWith('sess-1', expect.any(Date));
    expect(sessions.adoptLegacy).not.toHaveBeenCalled();
  });

  it('rejects when there is no session and no stored legacy hash (already logged out)', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: null,
      isDeleted: false,
    };
    const { service, sessions } = buildService(user);

    await expect(
      service.refresh({ refreshToken: VALID_TOKEN } as any),
    ).rejects.toBeInstanceOf(RpcException);
    expect(sessions.adoptLegacy).not.toHaveBeenCalled();
    expect(sessions.touch).not.toHaveBeenCalled();
  });

  it('unknown token: no session and the stored hash differs → 401, nothing is wiped', async () => {
    // A validly signed but unknown token (e.g. a login superseded BEFORE the
    // per-session deploy) — rejected, and no other session is touched.
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: sha256('different-token'),
      isDeleted: false,
    };
    const { service, usersRepo, activityLog, sessions } = buildService(user);

    const error = await service
      .refresh({ refreshToken: VALID_TOKEN } as any)
      .then(
        () => {
          throw new Error('expected a 401');
        },
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toEqual(
      expect.objectContaining({ statusCode: 401 }),
    );

    expect(usersRepo.save).not.toHaveBeenCalled();
    expect(usersRepo.update).not.toHaveBeenCalled();
    expect(sessions.revokeOwn).not.toHaveBeenCalled();
    expect(user.refresh_token).toBe(sha256('different-token'));
    // The security trail is kept.
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth_failure',
        metadata: { reason: 'refresh_session_not_found' },
      }),
    );
  });

  it('legacy (pre-deploy) token whose hash is the stored users.refresh_token → session adopted, 200', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: VALID_HASH,
      isDeleted: false,
    };
    const { service, sessions, usersRepo } = buildService(user);

    const res = await service.refresh({ refreshToken: VALID_TOKEN } as any);

    expect(res.statusCode).toBe(200);
    expect(sessions.adoptLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: VALID_TOKEN }),
    );
    expect(sessions.touch).toHaveBeenCalledTimes(1);
    expect(usersRepo.update).not.toHaveBeenCalled();
  });

  it('two devices: each refreshes with its own session (no more superseding)', async () => {
    const DEVICE_B_TOKEN = 'device-b-refresh-token';
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: sha256(DEVICE_B_TOKEN),
      isDeleted: false,
    };
    const sessions = buildSessions({
      [VALID_HASH]: { id: 'sess-a' },
      [sha256(DEVICE_B_TOKEN)]: { id: 'sess-b' },
    });
    const { service } = buildService(user, sessions);

    const a = await service.refresh({ refreshToken: VALID_TOKEN } as any);
    const b = await service.refresh({ refreshToken: DEVICE_B_TOKEN } as any);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });

  it('revoked / reset session → 401; a security reset is stamped on the row', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: null,
      isDeleted: false,
    };
    const sessions = buildSessions({ [VALID_HASH]: { id: 'sess-1' } });
    sessions.rejectReason.mockReturnValueOnce('reset');
    const { service } = buildService(user, sessions);

    await expect(
      service.refresh({ refreshToken: VALID_TOKEN } as any),
    ).rejects.toBeInstanceOf(RpcException);
    expect(sessions.revokeOwn).toHaveBeenCalledWith(
      'u1',
      { sessionId: 'sess-1' },
      'security_reset',
      expect.any(Date),
    );
    expect(sessions.touch).not.toHaveBeenCalled();
  });

  it('session revoked concurrently (touch matches no open row) → 401', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: null,
      isDeleted: false,
    };
    const sessions = buildSessions({ [VALID_HASH]: { id: 'sess-1' } });
    sessions.touch.mockResolvedValueOnce(false);
    const { service, jwtService } = buildService(user, sessions);

    await expect(
      service.refresh({ refreshToken: VALID_TOKEN } as any),
    ).rejects.toBeInstanceOf(RpcException);
    expect(jwtService.signAsync).not.toHaveBeenCalled();
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
    const { service, jwtService, sessions } = buildService(user);
    jwtService.verifyAsync = jest
      .fn()
      .mockRejectedValue(new Error('jwt malformed'));

    await expect(
      service.refresh({ refreshToken: VALID_TOKEN } as any),
    ).rejects.toBeInstanceOf(RpcException);
    expect(sessions.findByHash).not.toHaveBeenCalled();
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
  it('revokes only the current session (sid + cookie hash) and never saves the whole user row', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: sha256('some'),
      isDeleted: false,
    };
    const { service, usersRepo, sessions } = buildService(user);
    const sid = '3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d';

    await service.logout('u1', { sessionId: sid, refreshToken: 'some' });

    expect(sessions.revokeOwn).toHaveBeenCalledWith(
      'u1',
      { sessionId: sid, refreshTokenHash: sha256('some') },
      'logout',
    );
    expect(usersRepo.save).not.toHaveBeenCalled();
    // The legacy column held THIS session's hash → conditionally cleared.
    expect(usersRepo.update).toHaveBeenCalledWith(
      { id: 'u1', refresh_token: sha256('some') },
      { refresh_token: null },
    );
  });

  it('does not touch the legacy column when it belongs to another session', async () => {
    const user: MockUser = {
      id: 'u1',
      username: 'alice',
      status: 'active',
      refresh_token: sha256('newer-login'),
      isDeleted: false,
    };
    const { service, usersRepo } = buildService(user);

    await service.logout('u1', { refreshToken: 'older-login' });

    expect(usersRepo.update).not.toHaveBeenCalled();
  });
});
