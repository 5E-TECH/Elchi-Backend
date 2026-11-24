import { Logger } from '@nestjs/common';
import {
  GROUP_LINK_HINT_DELAY_MS,
  GROUP_NOT_LINKED_TEXT,
  GroupLinkHintService,
} from './group-link-hint.service';
import { MembershipHandler } from './handlers/membership.handler';
import type { TelegramChatMemberUpdated } from './telegram.types';

/**
 * (prod 2026-11-25) Bot guruhga oddiy yo'l bilan qo'shilib, ulanmay qolsa —
 * guruhga ulash yo'li yoziladi (ilgari bot jim edi).
 */
const CHAT = -1001234567;

const member = (
  previous: string,
  next: string,
  type = 'supergroup',
): TelegramChatMemberUpdated => ({
  chat: { id: CHAT, type },
  old_chat_member: { status: previous },
  new_chat_member: { status: next },
});

const setup = (linked: { id: string } | null = null) => {
  const chats = { findOne: jest.fn().mockResolvedValue(linked) };
  const outbox = { send: jest.fn().mockResolvedValue({ status: 'sent' }) };
  const service = new GroupLinkHintService(chats as never, outbox as never);
  return { service, chats, outbox };
};

const elapse = () => jest.advanceTimersByTimeAsync(GROUP_LINK_HINT_DELAY_MS);

describe('GroupLinkHintService — ulanmagan guruh', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    ['left', 'member'],
    ['kicked', 'member'],
    ['left', 'administrator'],
  ])("%s → %s: ulanmasa — ulash yo'li bir marta", async (previous, next) => {
    const fx = setup();
    fx.service.onMembership(member(previous, next));
    await jest.advanceTimersByTimeAsync(GROUP_LINK_HINT_DELAY_MS - 1);
    expect(fx.outbox.send).not.toHaveBeenCalled();
    await elapse();
    expect(fx.chats.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chat_id: String(CHAT), is_active: true },
      }),
    );
    expect(fx.outbox.send).toHaveBeenCalledTimes(1);
    expect(fx.outbox.send).toHaveBeenCalledWith({
      chatId: String(CHAT),
      text: GROUP_NOT_LINKED_TEXT,
      source: 'bot.group_not_linked',
    });
  });

  it('havola bilan qo‘shildi (shu orada ulandi) — hech narsa yozilmaydi', async () => {
    const fx = setup({ id: '5' });
    fx.service.onMembership(member('left', 'member'));
    await elapse();
    expect(fx.chats.findOne).toHaveBeenCalledTimes(1);
    expect(fx.outbox.send).not.toHaveBeenCalled();
  });

  it.each([
    ['admin huquqi berildi', member('member', 'administrator')],
    ['huquq olindi', member('administrator', 'member')],
    ['kanal', member('left', 'administrator', 'channel')],
    ['shaxsiy chat', member('kicked', 'member', 'private')],
  ])('%s — qo‘shilish emas', async (_label, update) => {
    const fx = setup();
    fx.service.onMembership(update);
    await elapse();
    expect(fx.chats.findOne).not.toHaveBeenCalled();
    expect(fx.outbox.send).not.toHaveBeenCalled();
  });

  it('kutish ichida chiqarildi — bekor; qayta qo‘shilsa — bitta xabar', async () => {
    const fx = setup();
    fx.service.onMembership(member('left', 'member'));
    fx.service.onMembership(member('member', 'kicked'));
    await elapse();
    expect(fx.outbox.send).not.toHaveBeenCalled();
    fx.service.onMembership(member('kicked', 'member'));
    fx.service.onMembership(member('left', 'member'));
    await elapse();
    expect(fx.outbox.send).toHaveBeenCalledTimes(1);
  });

  it('baza xatosi yutiladi (log), servis to‘xtasa — rejalangan eslatma bekor', async () => {
    const fx = setup();
    fx.chats.findOne.mockRejectedValueOnce(new Error('db down'));
    fx.service.onMembership(member('left', 'member'));
    await elapse();
    expect(fx.outbox.send).not.toHaveBeenCalled();
    fx.service.onMembership(member('left', 'member'));
    fx.service.onModuleDestroy();
    await elapse();
    expect(fx.outbox.send).not.toHaveBeenCalled();
  });

  it('MembershipHandler: holat qayta ishlanadi va eslatmaga uzatiladi', async () => {
    const channels = { markActive: jest.fn(), markInactive: jest.fn() };
    const hint = { onMembership: jest.fn() };
    const handler = new MembershipHandler(channels as never, hint as never);
    const update = member('left', 'member');
    await handler.handle('elchi', update);
    expect(channels.markActive).toHaveBeenCalledWith(String(CHAT), 'elchi');
    expect(hint.onMembership).toHaveBeenCalledWith(update);
  });
});
