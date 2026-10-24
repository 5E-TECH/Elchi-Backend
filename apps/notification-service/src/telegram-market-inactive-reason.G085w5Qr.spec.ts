import { NotificationServiceService } from './notification-service.service';
import { BotChannelService } from './bot/bot-channel.service';

/**
 * (G085w5Qr) telegram_markets.inactive_reason + inactive_at: bot aniqlagan
 * sabab, admin qo'lda o'chirsa 'manual', faollashtirilsa NULL; GET
 * /notifications va /:id javobida qaytadi; activity log old/new da bor.
 */
describe('G085w5Qr — Telegram guruhi nofaol sababi', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: '10',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    market_id: '37',
    group_id: '-100555',
    group_type: 'create',
    bot_slug: null,
    is_active: true,
    inactive_reason: null,
    inactive_at: null,
    ...overrides,
  });

  let repo: Record<string, jest.Mock>;
  let activityLog: { log: jest.Mock; logChange: jest.Mock };
  let service: NotificationServiceService;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      save: jest.fn((v) => Promise.resolve(v)),
      create: jest.fn((v) => v),
    };
    activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    };
    service = new NotificationServiceService(
      repo as never,
      {} as never,
      activityLog as never,
      {} as never,
      {} as never,
    );
  });

  it("PATCH is_active=false → inactive_reason='manual', inactive_at hozir; audit'da sabab", async () => {
    repo.findOne.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    const res = await service.updateTelegramMarket({
      id: '10',
      is_active: false,
    } as never);
    const data = res?.data as Record<string, unknown>;
    expect(data.is_active).toBe(false);
    expect(data.inactive_reason).toBe('manual');
    expect(data.inactive_at).toBeInstanceOf(Date);
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: expect.objectContaining({ inactive_reason: null }),
        new_value: expect.objectContaining({
          is_active: false,
          inactive_reason: 'manual',
        }),
      }),
    );
  });

  it('PATCH is_active=true (faollashtirish) → sabab va vaqt NULL', async () => {
    repo.findOne
      .mockResolvedValueOnce(
        row({
          is_active: false,
          inactive_reason: 'kicked',
          inactive_at: new Date('2026-10-20T10:00:00Z'),
        }),
      )
      .mockResolvedValueOnce(null);
    const res = await service.updateTelegramMarket({
      id: '10',
      is_active: true,
    } as never);
    const data = res?.data as Record<string, unknown>;
    expect(data.is_active).toBe(true);
    expect(data.inactive_reason).toBeNull();
    expect(data.inactive_at).toBeNull();
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: expect.objectContaining({ inactive_reason: 'kicked' }),
        new_value: expect.objectContaining({ inactive_reason: null }),
      }),
    );
  });

  it("holat o'zgarmasa (nofaol → nofaol) bot sababi saqlanib qoladi", async () => {
    const at = new Date('2026-10-20T10:00:00Z');
    repo.findOne
      .mockResolvedValueOnce(
        row({ is_active: false, inactive_reason: 'left', inactive_at: at }),
      )
      .mockResolvedValueOnce(null);
    const res = await service.updateTelegramMarket({
      id: '10',
      is_active: false,
    } as never);
    const data = res?.data as Record<string, unknown>;
    expect(data.inactive_reason).toBe('left');
    expect(data.inactive_at).toBe(at);
  });

  it('GET /notifications va /:id — inactive_reason, inactive_at tanlanadi va qaytadi', async () => {
    const at = new Date('2026-10-21T08:00:00Z');
    repo.findAndCount.mockResolvedValue([
      [
        row({
          is_active: false,
          inactive_reason: 'chat_not_found',
          inactive_at: at,
        }),
      ],
      1,
    ]);
    const list = await service.findAllTelegramMarkets({});
    const select = repo.findAndCount.mock.calls[0][0].select;
    expect(select).toEqual(
      expect.objectContaining({ inactive_reason: true, inactive_at: true }),
    );
    const item = (list?.data as { items: Array<Record<string, unknown>> })
      .items[0];
    expect(item.inactive_reason).toBe('chat_not_found');
    expect(item.inactive_at).toBe(at);

    repo.findOne.mockResolvedValueOnce(row());
    const one = await service.findTelegramMarketById('10');
    expect(one?.data).toEqual(
      expect.objectContaining({ inactive_reason: null, inactive_at: null }),
    );
  });

  it.each(['kicked', 'left', 'blocked_on_send', 'chat_not_found'] as const)(
    'bot markInactive(%s) → UPDATE da inactive_reason=$2, inactive_at=now()',
    async (reason) => {
      const query = jest.fn().mockResolvedValue([]);
      const channels = new BotChannelService(
        { query } as never,
        {} as never,
        { log: jest.fn() } as never,
        { get: jest.fn() } as never,
      );
      await channels.markInactive('-100555', 'elchi', reason);
      expect(query.mock.calls[0][0]).toMatch(/"inactive_reason" = \$2/);
      expect(query.mock.calls[0][0]).toMatch(/"inactive_at" = now\(\)/);
      expect(query.mock.calls[0][1]).toEqual(['-100555', reason]);
    },
  );
});
