import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import { IdentityController } from './identity.controller';
import type { RequesterContext } from './contracts/user.payloads';

/**
 * vpKijXce (b) — INVESTOR LOGINI (`identity.investor_user.create`,
 * gateway `POST /investor-users`).
 *
 * Elchida investor roli va `/investors/me` bor edi, lekin investor rolli
 * foydalanuvchini yaratishning hech qanday yo'li yo'q edi — `/investors/me`
 * ni hech kim ishlata olmasdi. BeePost `POST /users/investor` naqshi: faqat
 * kirish (ism, telefon, parol), maosh/kassa yo'q; faqat SUPERADMIN/ADMIN.
 */
function makeService(opts: { phoneTaken?: boolean } = {}) {
  const repo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        'phone_number' in where && opts.phoneTaken
          ? { id: '7', phone_number: where.phone_number, isDeleted: false }
          : null,
      ),
    ),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn((value: Record<string, unknown>) =>
      Promise.resolve({ id: '31', ...value }),
    ),
  };
  const makeClient = (reply: unknown) => ({
    send: jest.fn(() => of(reply)),
    emit: jest.fn(),
  });
  const financeClient = makeClient({ data: null });
  const branchClient = makeClient({ data: null });
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const service = new UserServiceService(
    repo as never,
    makeClient({ ok: true }) as never, // search
    makeClient({ statusCode: 200 }) as never, // catalog
    makeClient({ data: null }) as never, // order
    makeClient({ data: null }) as never, // logistics
    financeClient as never, // finance
    branchClient as never, // branch
    {
      encrypt: jest.fn().mockResolvedValue('hashed-pw'),
      compare: jest.fn(),
    } as never,
    { get: jest.fn() } as never,
    activityLog as never,
  );
  return { service, repo, financeClient, branchClient, activityLog };
}

const statusOf = (error: unknown): number | undefined =>
  error instanceof RpcException
    ? (error.getError() as { statusCode?: number }).statusCode
    : undefined;

const dto = {
  name: 'Ali Investor',
  phone_number: '+998901234567',
  password: 'secret12',
};
const superadmin: RequesterContext = { id: '1', roles: ['superadmin'] };
const admin: RequesterContext = { id: '2', roles: ['admin'] };

describe('vpKijXce — identity.investor_user.create (investor logini)', () => {
  it.each([
    ['superadmin', superadmin],
    ['admin', admin],
  ])(
    '⭐ %s — rol INVESTOR, faol, parol xeshlangan, maosh 0, kassa/filial yo‘q',
    async (_label, requester) => {
      const ctx = makeService();

      const res: any = await ctx.service.createInvestorUser(
        { ...dto },
        requester,
      );

      expect(res.statusCode).toBe(201);
      expect(ctx.repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Ali Investor',
          phone_number: '+998901234567',
          password: 'hashed-pw',
          salary: 0,
          role: Roles.INVESTOR,
          status: Status.ACTIVE,
          created_by: requester.id,
          isDeleted: false,
        }),
      );
      // Javobda parol/refresh token yo'q.
      expect(res.data.password).toBeUndefined();
      expect(res.data.role).toBe(Roles.INVESTOR);
      // Investor logini — kassa ham, filial biriktiruvi ham ochilmaydi.
      expect(ctx.financeClient.send).not.toHaveBeenCalled();
      expect(ctx.branchClient.send).not.toHaveBeenCalled();
      expect(ctx.activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'User',
          new_value: expect.objectContaining({ role: Roles.INVESTOR }),
        }),
      );
    },
  );

  it.each([
    ['manager'],
    ['market'],
    ['investor'],
    ['registrator'],
    ['courier'],
  ])('%s — 403, foydalanuvchi yaratilmaydi', async (role) => {
    const ctx = makeService();

    const err = await ctx.service
      .createInvestorUser({ ...dto }, { id: '9', roles: [role] })
      .catch((e: unknown) => e);

    expect(statusOf(err)).toBe(403);
    expect(ctx.repo.save).not.toHaveBeenCalled();
  });

  it('band telefon — 409, yaratilmaydi', async () => {
    const ctx = makeService({ phoneTaken: true });

    const err = await ctx.service
      .createInvestorUser({ ...dto }, superadmin)
      .catch((e: unknown) => e);

    expect(statusOf(err)).toBe(409);
    expect(ctx.repo.save).not.toHaveBeenCalled();
  });

  it('bo‘sh maydon — 400', async () => {
    const ctx = makeService();

    const err = await ctx.service
      .createInvestorUser({ ...dto, password: '' }, superadmin)
      .catch((e: unknown) => e);

    expect(statusOf(err)).toBe(400);
    expect(ctx.repo.save).not.toHaveBeenCalled();
  });

  it('RMQ: identity.investor_user.create → servis dto + requester bilan', async () => {
    const userService = {
      createInvestorUser: jest.fn().mockResolvedValue({ statusCode: 201 }),
    };
    const controller = new IdentityController(
      { ack: jest.fn(), nackForError: jest.fn() } as any,
      userService as any,
      {} as any,
      {} as any,
    );

    await controller.createInvestorUser({ dto: { ...dto }, requester: admin }, {
      getPattern: () => 'x',
    } as any);

    expect(userService.createInvestorUser).toHaveBeenCalledWith(dto, admin);
  });
});
