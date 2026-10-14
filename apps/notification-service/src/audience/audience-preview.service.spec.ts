import { RpcException } from '@nestjs/microservices';
import { AudiencePreviewService } from './audience-preview.service';
import { CUSTOMER_TARGETING_HINT } from './audience-request';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  };
});

/**
 * (W8aerwL6 TC8) `notification.audience.preview` — aniq son, rollar kesimi
 * va kanal bo'yicha yaroqlilar; hech narsa yuborilmaydi, telefon qaytmaydi.
 */
describe('W8aerwL6 — AudiencePreviewService', () => {
  let service: AudiencePreviewService;
  let pushCounts: number[];
  let pushChunks: string[][];

  const item = (id: string, role: string, phone_valid = true) => ({
    id,
    role,
    language: 'uz',
    phone_valid,
  });

  const errorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof RpcException) return error.getError() as any;
      throw error;
    }
    throw new Error('expected RpcException');
  };

  beforeEach(() => {
    rmqSendMock.mockReset();
    pushCounts = [];
    pushChunks = [];
    const pushRepo = {
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          select: jest.fn(() => qb),
          where: jest.fn((where: any) => {
            pushChunks.push(where.user_id.value.map(String));
            return qb;
          }),
          getRawOne: jest.fn(() =>
            Promise.resolve({ count: String(pushCounts.shift() ?? 0) }),
          ),
        };
        return qb;
      }),
    };
    service = new AudiencePreviewService(
      { send: jest.fn() } as never,
      pushRepo as never,
      { get: jest.fn(() => undefined) } as never,
    );
  });

  it('TC8: aniq son, rollar kesimi va kanal bo‘yicha yaroqlilar (telefon/ism javobda yo‘q)', async () => {
    rmqSendMock.mockResolvedValueOnce({
      data: {
        items: [
          item('1', 'superadmin'),
          item('2', 'courier', false),
          item('3', 'customer'),
          item('4', 'customer'),
        ],
        total: 4,
        next_after_id: null,
        stats: {
          by_role: { superadmin: 1, courier: 1, customer: 2 },
          with_valid_phone: 3,
        },
      },
    });
    // aniq id'lar: 4 — allaqachon bor, 9 — yangi (kuryer), 77 — topilmadi
    rmqSendMock.mockResolvedValueOnce({
      data: { items: [item('9', 'courier')], total: null, next_after_id: null },
    });
    pushCounts = [2];

    const res: any = await service.preview({
      roles: ['superadmin', 'courier', 'customer'],
      include_customers: true,
      segment: { region_id: '5' },
      recipient_ids: ['4', '9', '77'],
    });

    expect(rmqSendMock.mock.calls[0][1]).toEqual({
      cmd: 'identity.audience.resolve',
    });
    expect(rmqSendMock.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        fields: 'minimal',
        with_stats: true,
        with_total: true,
        include_customers: true,
        segment: { region_id: '5' },
      }),
    );
    expect(rmqSendMock.mock.calls[1][2]).toEqual(
      expect.objectContaining({ user_ids: ['9', '77'], fields: 'minimal' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual(
      expect.objectContaining({
        exact: true,
        total: 6,
        by_role: { superadmin: 1, courier: 2, customer: 2, unknown: 1 },
        by_channel: {
          in_app: 6,
          realtime: 6,
          push: 2,
          sms: 4,
          email: 0,
          telegram: null,
        },
        not_found: 1,
        dispatch_allowed: true,
        campaign_allowed: true,
        limits: { dispatch_max: 5000, campaign_max: 20000 },
      }),
    );
    expect(res.data.warnings).toEqual(
      expect.arrayContaining(['includes_customers', 'recipients_not_found']),
    );
    expect(pushChunks).toEqual([['1', '2', '3', '4', '9']]);
    expect(JSON.stringify(res)).not.toMatch(/\+998|phone_number/);
  });

  it('5000 dan katta — dispatch_allowed=false, kampaniya tavsiya etiladi; barcha sahifalar yig‘iladi', async () => {
    const page = (from: number, n: number, next: string | null) => ({
      data: {
        items: Array.from({ length: n }, (_, i) =>
          item(String(from + i), 'customer'),
        ),
        total: from === 1 ? 6200 : null,
        next_after_id: next,
        ...(from === 1
          ? { stats: { by_role: { customer: 6200 }, with_valid_phone: 6200 } }
          : {}),
      },
    });
    for (let p = 0; p < 7; p += 1) {
      const from = 1 + p * 1000;
      const n = p < 6 ? 1000 : 200;
      rmqSendMock.mockResolvedValueOnce(
        page(from, n, p < 6 ? String(from + n - 1) : null),
      );
    }
    const res: any = await service.preview({
      include_customers: true,
      confirm_all_customers: true,
    });
    expect(rmqSendMock).toHaveBeenCalledTimes(7);
    expect(res.data.total).toBe(6200);
    expect(res.data.dispatch_allowed).toBe(false);
    expect(res.data.campaign_allowed).toBe(true);
    expect(res.data.warnings).toEqual(
      expect.arrayContaining([
        'all_customers',
        'over_dispatch_cap_use_campaign',
      ]),
    );
  });

  it('kampaniya chegarasidan katta — identity statistikasi bilan (hammasi yig‘ilmaydi)', async () => {
    rmqSendMock.mockResolvedValueOnce({
      data: {
        items: [item('1', 'customer')],
        total: 25_000,
        next_after_id: '1',
        stats: { by_role: { customer: 25_000 }, with_valid_phone: 24_000 },
      },
    });
    const res: any = await service.preview({
      include_customers: true,
      confirm_all_customers: true,
    });
    expect(rmqSendMock).toHaveBeenCalledTimes(1);
    expect(res.data).toEqual(
      expect.objectContaining({
        exact: false,
        total: 25_000,
        by_role: { customer: 25_000 },
        campaign_allowed: false,
      }),
    );
    expect(res.data.by_channel.push).toBeNull();
    expect(res.data.by_channel.sms).toBe(24_000);
  });

  it('mijoz qoidalari preview’da ham (TC7) va bo‘sh auditoriya — 400', async () => {
    expect(
      (await errorOf(service.preview({ roles: ['customer'] }))).message,
    ).toBe(CUSTOMER_TARGETING_HINT);
    expect((await errorOf(service.preview({}))).statusCode).toBe(400);
    expect(
      (await errorOf(service.preview({ recipient_ids: ['1', 'x'] })))
        .statusCode,
    ).toBe(400);
    expect(rmqSendMock).not.toHaveBeenCalled();
  });
});
