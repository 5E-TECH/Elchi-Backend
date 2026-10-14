import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { RpcException } from '@nestjs/microservices';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import { IdentityController } from './identity.controller';

/**
 * rCFZAmOz — shaxsiy Telegram: `users.telegram_id` endi to'ldiriladi (bot
 * `/start <token>` → `identity.user.telegram_bind`) va notification-service
 * `contacts_by_ids` orqali o'qiydi.
 */
describe('identity — Telegram ulash (rCFZAmOz)', () => {
  function make(affected = 1, rows: Record<string, unknown>[] = []) {
    const svc = Object.create(UserServiceService.prototype) as {
      users: { update: jest.Mock; find: jest.Mock };
    } & UserServiceService;
    svc.users = {
      update: jest.fn().mockResolvedValue({ affected }),
      find: jest.fn().mockResolvedValue(rows),
    };
    return svc;
  }

  it('TC1: telegramBind — faqat faol, o‘chirilmagan foydalanuvchiga telegram_id yoziladi', async () => {
    const svc = make();
    const res = await svc.telegramBind({ user_id: '7', telegram_id: 5550007 });
    expect(svc.users.update).toHaveBeenCalledWith(
      { id: '7', isDeleted: false, status: Status.ACTIVE },
      { telegram_id: '5550007' },
    );
    expect(res).toMatchObject({ data: { bound: true } });
  });

  it('telegramBind — topilmasa 404, noto‘g‘ri id 400 (UPDATE yo‘q)', async () => {
    await expect(
      make(0).telegramBind({ user_id: '7', telegram_id: '5550007' }),
    ).rejects.toMatchObject({ error: { statusCode: 404 } });
    const svc = make();
    for (const payload of [
      { user_id: 'abc', telegram_id: '1' },
      { user_id: '7', telegram_id: 'x; DROP' },
      { user_id: '7' },
    ]) {
      await expect(svc.telegramBind(payload)).rejects.toBeInstanceOf(
        RpcException,
      );
    }
    expect(svc.users.update).not.toHaveBeenCalled();
  });

  it('telegramUnbind — shu chat ulangan akkauntlardan uziladi', async () => {
    const svc = make(2);
    const res = await svc.telegramUnbind({ telegram_id: '5550007' });
    expect(svc.users.update).toHaveBeenCalledWith(
      { telegram_id: '5550007' },
      { telegram_id: null },
    );
    expect(res).toMatchObject({ data: { unbound: 2 } });
  });

  it('contactsByIds — telegram_id qaytadi (DM uchun), null ham', async () => {
    const svc = make(1, [
      {
        id: '7',
        phone_number: '+998901112233',
        role: Roles.COURIER,
        language: 'uz',
        settings: null,
        telegram_id: '5550007',
      },
      {
        id: '8',
        phone_number: null,
        role: Roles.MARKET,
        language: 'ru',
        settings: null,
        telegram_id: null,
      },
    ]);
    const res = (await svc.contactsByIds(['7', '8'])) as {
      data: Array<Record<string, unknown>>;
    };
    expect(svc.users.find.mock.calls[0][0].select).toContain('telegram_id');
    expect(res.data.map((row) => row.telegram_id)).toEqual(['5550007', null]);
  });

  it('RMQ patternlari: identity.user.telegram_bind / telegram_unbind', () => {
    const proto = IdentityController.prototype as unknown as Record<
      string,
      object
    >;
    const cmds = Object.getOwnPropertyNames(proto).flatMap((name) => {
      const meta = Reflect.getMetadata(PATTERN_METADATA, proto[name]) as
        | Array<{ cmd?: string }>
        | undefined;
      return (meta ?? []).map((pattern) => pattern.cmd);
    });
    expect(cmds).toEqual(
      expect.arrayContaining([
        'identity.user.telegram_bind',
        'identity.user.telegram_unbind',
      ]),
    );
  });
});
