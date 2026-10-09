import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { NotificationServiceController } from './notification-service.controller';

/**
 * uFmUS86e TC11 — mavjud 7 ta inbox RMQ patterni (dispatch, inbox.list,
 * find_one, unread_count, mark_read, mark_all_read, delete) regressiyasiz;
 * Eh8y21Ha — yangi `notification.types.list` patterni qo'shilgan.
 */
describe('NotificationServiceController — RMQ patternlari', () => {
  const patternsOf = () => {
    const proto = NotificationServiceController.prototype as unknown as Record<
      string,
      unknown
    >;
    const map = new Map<string, string>();
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const meta = Reflect.getMetadata(PATTERN_METADATA, handler) as
        | Array<{ cmd?: string }>
        | undefined;
      for (const pattern of meta ?? []) {
        if (pattern?.cmd) map.set(pattern.cmd, name);
      }
    }
    return map;
  };

  it('7 ta inbox patterni + types.list ro‘yxatda', () => {
    const patterns = patternsOf();
    for (const cmd of [
      'notification.dispatch',
      'notification.inbox.list',
      'notification.inbox.find_one',
      'notification.inbox.unread_count',
      'notification.inbox.mark_read',
      'notification.inbox.mark_all_read',
      'notification.inbox.delete',
      'notification.types.list',
    ]) {
      expect(patterns.has(cmd)).toBe(true);
    }
  });

  it('har inbox handler servisga aynan delegatsiya qiladi va ack qiladi', async () => {
    const inbox: Record<string, jest.Mock> = {
      dispatch: jest.fn().mockResolvedValue('dispatch'),
      list: jest.fn().mockResolvedValue('list'),
      findOne: jest.fn().mockResolvedValue('findOne'),
      unreadCount: jest.fn().mockResolvedValue('unread'),
      markRead: jest.fn().mockResolvedValue('read'),
      markAllRead: jest.fn().mockResolvedValue('all'),
      remove: jest.fn().mockResolvedValue('removed'),
      listTypes: jest.fn().mockReturnValue('types'),
    };
    const rmq = { ack: jest.fn(), nackForError: jest.fn() };
    const controller = new NotificationServiceController(
      rmq as never,
      {} as never,
      inbox as never,
      {} as never,
      {} as never,
    );
    const ctx = { getPattern: () => 'x' } as never;

    await expect(
      controller.dispatch({ type: 'order.sold' } as never, ctx),
    ).resolves.toBe('dispatch');
    await expect(
      controller.listInbox({ recipient_id: '1' } as never, ctx),
    ).resolves.toBe('list');
    await expect(
      controller.findOneInbox({ recipient_id: '1', id: '2' }, ctx),
    ).resolves.toBe('findOne');
    await expect(
      controller.unreadCount({ recipient_id: '1' }, ctx),
    ).resolves.toBe('unread');
    await expect(
      controller.markRead({ recipient_id: '1', id: '2' }, ctx),
    ).resolves.toBe('read');
    await expect(
      controller.markAllRead({ recipient_id: '1' }, ctx),
    ).resolves.toBe('all');
    await expect(
      controller.deleteInbox({ recipient_id: '1', id: '2' }, ctx),
    ).resolves.toBe('removed');
    await expect(controller.listTypes(ctx)).resolves.toBe('types');

    expect(inbox.findOne).toHaveBeenCalledWith('1', '2');
    expect(inbox.markRead).toHaveBeenCalledWith('1', '2', true);
    expect(inbox.remove).toHaveBeenCalledWith('1', '2');
    expect(rmq.ack).toHaveBeenCalledTimes(8);
  });
});
