import { of } from 'rxjs';
import { DispatchHistoryService } from './dispatch-history.service';

/**
 * (NwlmrcMf) GET /notifications/sent — har qatorda `audience` (tafsilot
 * bilan bir xil shakl); bitta odam bo'lsa `audience.recipient: { id, name,
 * role }` — ismlar created_by bilan BITTA identity so'rovida.
 */
describe('NwlmrcMf — Yuborilganlar ro‘yxatida auditoriya', () => {
  const dispatchRow = (overrides: Record<string, unknown> = {}) => ({
    id: '1',
    dispatch_id: 'd-1',
    status: 'sent',
    type: 'system.manual',
    category: 'system',
    priority: 'normal',
    title: 'E’lon',
    body: 'Matn',
    link: null,
    channels: ['in_app'],
    audience: null,
    recipients: 1,
    dispatched: 1,
    skipped_by_preference: 0,
    by_channel: {},
    channel_status: null,
    no_provider: [],
    message: 'Notification dispatched',
    created_by: '25',
    created_by_role: 'admin',
    createdAt: new Date(0),
    finished_at: new Date(0),
    error: null,
    ...overrides,
  });

  let rows: Array<Record<string, unknown>>;
  let notificationsQuery: jest.Mock;
  let identitySend: jest.Mock;
  let service: DispatchHistoryService;

  beforeEach(() => {
    rows = [];
    const qb: Record<string, jest.Mock> = {};
    for (const key of [
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
    ])
      qb[key] = jest.fn(() => qb);
    qb.getManyAndCount = jest.fn(() => Promise.resolve([rows, rows.length]));
    notificationsQuery = jest.fn().mockResolvedValue([]);
    identitySend = jest.fn(() =>
      of({
        data: [
          { id: '25', name: 'Admin Test', role: 'admin' },
          { id: '37', name: 'TEST Market', role: 'market' },
          { id: '41', name: 'Aziz Karimov', role: 'courier' },
        ],
      }),
    );
    service = new DispatchHistoryService(
      {
        createQueryBuilder: () => qb,
        findOne: jest.fn(() => Promise.resolve(rows[0])),
      } as never,
      { query: notificationsQuery } as never,
      { send: identitySend } as never,
    );
  });

  const items = async () =>
    (
      (await service.list({})) as {
        data: { items: Array<Record<string, any>> };
      }
    ).data.items;

  it('rollar / broadcast / segment — audience o‘zi qaytadi, recipient yo‘q', async () => {
    rows = [
      dispatchRow({
        dispatch_id: 'd-roles',
        audience: { roles: ['courier', 'market'] },
        recipients: 12,
      }),
      dispatchRow({ dispatch_id: 'd-all', audience: { broadcast: true } }),
      dispatchRow({ dispatch_id: 'd-none', audience: null }),
    ];
    const [roles, all, none] = await items();
    expect(roles.audience).toEqual({ roles: ['courier', 'market'] });
    expect(roles.recipients).toBe(12);
    expect(all.audience).toEqual({ broadcast: true });
    expect(none.audience).toBeNull();
    expect(notificationsQuery).not.toHaveBeenCalled();
  });

  it('yangi yozuv: recipient_ids=1 + recipient_id → recipient { id, name, role }, ichki id chiqmaydi; identity so‘rovi BITTA', async () => {
    rows = [
      dispatchRow({
        dispatch_id: 'd-one',
        audience: { recipient_ids: 1, recipient_id: '41' },
      }),
    ];
    const [item] = await items();
    expect(item.audience).toEqual({
      recipient_ids: 1,
      recipient: { id: '41', name: 'Aziz Karimov', role: 'courier' },
    });
    expect(identitySend).toHaveBeenCalledTimes(1);
    expect(identitySend.mock.calls[0][1].ids.sort()).toEqual(['25', '41']);
    expect(notificationsQuery).not.toHaveBeenCalled();
  });

  it('eski yozuv (faqat recipient_ids=1) — id inbox qatoridan BITTA batch so‘rov bilan', async () => {
    rows = [
      dispatchRow({ dispatch_id: 'd-old', audience: { recipient_ids: 1 } }),
      dispatchRow({
        dispatch_id: 'd-many',
        audience: { recipient_ids: 3 },
        recipients: 3,
      }),
      // rol + bitta id — kim ekanini aniqlab bo'lmaydi → recipient yo'q.
      dispatchRow({
        dispatch_id: 'd-mixed',
        audience: { recipient_ids: 1, roles: ['courier'] },
      }),
    ];
    notificationsQuery.mockResolvedValue([
      { dispatch_id: 'd-old', recipient_id: '37', recipient_role: 'market' },
    ]);
    const [old, many, mixed] = await items();
    expect(notificationsQuery).toHaveBeenCalledTimes(1);
    expect(notificationsQuery.mock.calls[0][1]).toEqual([['d-old']]);
    expect(old.audience.recipient).toEqual({
      id: '37',
      name: 'TEST Market',
      role: 'market',
    });
    expect(many.audience).toEqual({ recipient_ids: 3 });
    expect(mixed.audience).toEqual({ recipient_ids: 1, roles: ['courier'] });
  });

  it('tafsilot ham ayni shakl (recipient bilan)', async () => {
    rows = [
      dispatchRow({
        dispatch_id: 'd-one',
        audience: { recipient_ids: 1, recipient_id: '41' },
      }),
    ];
    notificationsQuery.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('COUNT(*)') ? [{ n: 0 }] : []),
    );
    const res = (await service.detail('d-one')) as {
      data: Record<string, any>;
    };
    expect(res.data.audience).toEqual({
      recipient_ids: 1,
      recipient: { id: '41', name: 'Aziz Karimov', role: 'courier' },
    });
  });
});
