import { BadRequestException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  BRANCH_CHAT_SCOPE,
  BRANCH_GROUP_MARKET_CHAT_MESSAGE,
  BRANCH_GROUP_OTHER_BRANCH_MESSAGE,
  BRANCH_GROUP_PRIVATE_CHAT_MESSAGE,
  BranchTelegramService,
} from './branch-telegram.service';
import { NotificationInboxService } from '../notification-inbox.service';

/**
 * Filial kassasi Telegram guruhi — bir martalik kod bilan ulash, hisobot
 * qayerga (guruh / shaxsiy chat), uzish va bot hodisalari. SQL — mock
 * (haqiqiy Postgres sinovi yo'q: chaqiruv parametrlari tekshiriladi).
 */

const sqlOf = (mock: jest.Mock, needle: string) =>
  mock.mock.calls.find(([sql]) => String(sql).includes(needle));

const setup = (
  opts: {
    marketGroup?: boolean;
    otherBranch?: boolean;
    previous?: Record<string, unknown> | null;
    setting?: { report_target: 'group' | 'private' } | null;
    chatRow?: Record<string, unknown> | null;
    updateRows?: Array<Record<string, unknown>>;
    botToken?: string;
    botUsername?: string;
  } = {},
) => {
  const chats = {
    query: jest.fn((sql: string) => {
      if (sql.includes('SELECT "owner_id"')) {
        return Promise.resolve(opts.otherBranch ? [{ owner_id: '99' }] : []);
      }
      if (sql.trim().startsWith('UPDATE')) {
        return Promise.resolve([opts.updateRows ?? [], 0]);
      }
      return Promise.resolve([]);
    }),
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        where.scope === BRANCH_CHAT_SCOPE && 'owner_type' in where
          ? opts.chatRow !== undefined
            ? opts.chatRow
            : (opts.previous ?? null)
          : null,
      ),
    ),
    find: jest
      .fn()
      .mockResolvedValue(opts.chatRow ? [{ id: '1', ...opts.chatRow }] : []),
  };
  const settings = {
    findOne: jest.fn().mockResolvedValue(opts.setting ?? null),
    query: jest.fn().mockResolvedValue([]),
  };
  const markets = {
    findOne: jest.fn().mockResolvedValue(opts.marketGroup ? { id: '5' } : null),
  };
  const links = {
    issue: jest.fn().mockResolvedValue({
      token: 'T'.repeat(43),
      expires_at: new Date('2026-11-20T10:10:00Z'),
    }),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: jest.fn((key: string) =>
      key === 'TELEGRAM_BOT_TOKEN'
        ? (opts.botToken ?? '123:abc')
        : key === 'TELEGRAM_BOT_USERNAME'
          ? (opts.botUsername ?? '@elchi_bot')
          : undefined,
    ),
  };
  const inbox = { dispatch: jest.fn().mockResolvedValue({}) };
  const moduleRef = {
    get: jest.fn((token: unknown) =>
      token === NotificationInboxService ? inbox : undefined,
    ),
  };
  const service = new BranchTelegramService(
    chats as never,
    settings as never,
    markets as never,
    links as never,
    activityLog as never,
    config as never,
    moduleRef as never,
  );
  return { service, chats, settings, markets, links, activityLog, inbox };
};

const MANAGER = { id: '301', roles: ['manager'] };

describe('BranchTelegramService — ulash kodi', () => {
  it('`branch_group` kodi: owner — filial, nom guruhga aytiladi, havola `startgroup`', async () => {
    const fx = setup();
    const res = await fx.service.issueLinkCode({
      branch_id: '12',
      branch_name: '  Chilonzor  filiali ',
      requester: MANAGER,
      ip: '10.0.0.1',
    });
    expect(fx.links.issue).toHaveBeenCalledWith({
      purpose: 'branch_group',
      owner_type: 'branch',
      owner_id: '12',
      owner_label: 'Chilonzor filiali',
      created_by: '301',
      created_ip: '10.0.0.1',
    });
    expect(res.data).toMatchObject({
      purpose: 'branch_group',
      branch_id: '12',
      deep_link: `https://t.me/elchi_bot?startgroup=${'T'.repeat(43)}`,
      command: `/start ${'T'.repeat(43)}`,
    });
  });

  it('rol / filial / bot tekshiruvlari', async () => {
    const fx = setup();
    await expect(
      fx.service.issueLinkCode({
        branch_id: '12',
        requester: { id: '7', roles: ['courier'] },
      }),
    ).rejects.toBeInstanceOf(RpcException);
    await expect(
      fx.service.issueLinkCode({ branch_id: '0', requester: MANAGER }),
    ).rejects.toBeInstanceOf(RpcException);
    await expect(
      fx.service.issueLinkCode({
        branch_id: '12',
        requester: { roles: ['admin'] },
      }),
    ).rejects.toBeInstanceOf(RpcException);
    const noBot = setup({ botToken: '' });
    await expect(
      noBot.service.issueLinkCode({ branch_id: '12', requester: MANAGER }),
    ).rejects.toMatchObject({ error: { statusCode: 503 } });
    expect(fx.links.issue).not.toHaveBeenCalled();
  });
});

describe('BranchTelegramService.bindGroup', () => {
  const token = { owner_id: '12', owner_label: 'Chilonzor', created_by: '301' };

  it('guruh ulanadi: upsert (filialga bitta qator), javob guruhga — filial nomi bilan', async () => {
    const fx = setup();
    const res = await fx.service.bindGroup(token, '-1001', 'Kassa guruhi');
    const upsert = sqlOf(fx.chats.query, 'INSERT INTO');
    expect(upsert?.[0]).toContain(
      `ON CONFLICT ("owner_id", "scope") WHERE "owner_type" = 'branch'`,
    );
    expect(upsert?.[1]).toEqual([
      '-1001',
      '12',
      BRANCH_CHAT_SCOPE,
      '301',
      'Kassa guruhi',
    ]);
    expect(res.message).toContain('«Chilonzor» filiali kassasiga ulandi');
    expect(res.data).toEqual({
      branch_id: '12',
      chat_id: '-1001',
      replaced_chat_id: null,
    });
    expect(fx.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notification.tg_branch_group_linked',
      }),
    );
  });

  it('boshqa guruh ulangan bo‘lsa — almashtiriladi (eski chat activity-log’da)', async () => {
    const fx = setup({ previous: { chat_id: '-1000', is_active: true } });
    const res = await fx.service.bindGroup(token, '-1001');
    expect(res.data.replaced_chat_id).toBe('-1000');
  });

  it.each([
    ['shaxsiy chat', {}, '777', BRANCH_GROUP_PRIVATE_CHAT_MESSAGE],
    [
      'market guruhi',
      { marketGroup: true },
      '-1001',
      BRANCH_GROUP_MARKET_CHAT_MESSAGE,
    ],
    [
      'boshqa filial guruhi',
      { otherBranch: true },
      '-1001',
      BRANCH_GROUP_OTHER_BRANCH_MESSAGE,
    ],
  ])(
    '%s — rad (BadRequest, matn guruhga)',
    async (_name, opts, chatId, message) => {
      const fx = setup(opts);
      const error = await fx.service
        .bindGroup(token, chatId)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe(message);
      expect(sqlOf(fx.chats.query, 'INSERT INTO')).toBeUndefined();
    },
  );
});

describe('BranchTelegramService — panel', () => {
  it('holat: sozlama yo‘q → `group`; ulangan guruh ko‘rinadi', async () => {
    const linkedAt = new Date('2026-11-20T09:00:00Z');
    const fx = setup({
      chatRow: {
        chat_id: '-1001',
        chat_title: 'Kassa',
        is_active: false,
        inactive_reason: 'kicked',
        inactive_at: linkedAt,
        linked_at: linkedAt,
        linked_by: '301',
      },
    });
    const res = await fx.service.status({ branch_id: '12' });
    expect(res.data).toEqual({
      branch_id: '12',
      report_target: 'group',
      group: {
        chat_id: '-1001',
        title: 'Kassa',
        is_active: false,
        inactive_reason: 'kicked',
        inactive_at: linkedAt,
        linked_at: linkedAt,
        linked_by: '301',
      },
    });
  });

  it('panelda uzilgan guruh — «ulanmagan» (`group: null`)', async () => {
    const fx = setup({
      setting: { report_target: 'private' },
      chatRow: {
        chat_id: '-1001',
        is_active: false,
        inactive_reason: 'unlinked',
      },
    });
    const res = await fx.service.status({ branch_id: '12' });
    expect(res.data).toEqual({
      branch_id: '12',
      report_target: 'private',
      group: null,
    });
  });

  it('report_target: faqat group | private; o‘zgarsa activity-log', async () => {
    const fx = setup();
    await expect(
      fx.service.setReportTarget({
        branch_id: '12',
        report_target: 'dm',
        requester: MANAGER,
      }),
    ).rejects.toBeInstanceOf(RpcException);
    await fx.service.setReportTarget({
      branch_id: '12',
      report_target: 'private',
      requester: MANAGER,
    });
    expect(fx.settings.query.mock.calls[0][1]).toEqual([
      '12',
      'private',
      '301',
    ]);
    expect(fx.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notification.tg_branch_report_target',
        old_value: { report_target: 'group' },
        new_value: { report_target: 'private' },
      }),
    );
  });

  it('uzish: faqat faol qator `unlinked` bo‘ladi', async () => {
    const fx = setup({ updateRows: [{ id: '1', chat_id: '-1001' }] });
    const res = await fx.service.unlink({
      branch_id: '12',
      requester: MANAGER,
    });
    const update = sqlOf(fx.chats.query, "'unlinked'");
    expect(update?.[0]).toContain('"is_active" = true');
    expect(update?.[1]).toEqual(['12', BRANCH_CHAT_SCOPE]);
    expect(res.data.unlinked).toBe(true);
  });

  it('marshrut (finance): report_target + guruh faolligi', async () => {
    const fx = setup({
      setting: { report_target: 'group' },
      chatRow: { chat_id: '-1001', is_active: true, inactive_reason: null },
    });
    await expect(fx.service.route({ branch_id: '12' })).resolves.toMatchObject({
      data: {
        branch_id: '12',
        report_target: 'group',
        group: { active: true, inactive_reason: null },
      },
    });
    const none = setup();
    await expect(
      none.service.route({ branch_id: '12' }),
    ).resolves.toMatchObject({
      data: { report_target: 'group', group: null },
    });
  });
});

describe('BranchTelegramService — bot hodisalari', () => {
  it('bot chiqarildi: filial qatori nofaol + ulagan xodimga xabar', async () => {
    const fx = setup({
      updateRows: [
        { id: '1', owner_id: '12', linked_by: '301', chat_title: 'Kassa' },
      ],
    });
    await expect(fx.service.markInactive('-1001', 'kicked')).resolves.toBe(1);
    const update = sqlOf(fx.chats.query, '"inactive_reason" = $2');
    expect(update?.[0]).toContain(`"owner_type" = 'branch'`);
    expect(update?.[1]).toEqual(['-1001', 'kicked']);
    expect(fx.inbox.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'telegram.branch_channel_inactive',
        recipient_ids: ['301'],
      }),
    );
  });

  it('shaxsiy chat id — e’tiborsiz', async () => {
    const fx = setup();
    await expect(fx.service.markInactive('777', 'kicked')).resolves.toBe(0);
    await expect(fx.service.reactivate('777')).resolves.toBe(0);
    expect(fx.chats.query).not.toHaveBeenCalled();
  });

  it('supergroup: filial qatori yangi chat id’ga ko‘chadi', async () => {
    const fx = setup({ updateRows: [{ id: '1', owner_id: '12' }] });
    await expect(fx.service.migrate('-1001', '-1009')).resolves.toBe(1);
    expect(sqlOf(fx.chats.query, 'SET "chat_id" = $2')?.[1]).toEqual([
      '-1001',
      '-1009',
    ]);
  });

  it('yangi a’zo: guruhni ulagan xodim ogohlantiriladi, guruhga yozilmaydi', async () => {
    const fx = setup({ chatRow: { owner_id: '12', linked_by: '301' } });
    await expect(
      fx.service.warnNewMembers('-1001', 'Kassa', [
        { id: 5, first_name: 'Vali' },
      ]),
    ).resolves.toBe(1);
    expect(fx.inbox.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'telegram.branch_group_member_joined',
        recipient_ids: ['301'],
      }),
    );
  });
});
