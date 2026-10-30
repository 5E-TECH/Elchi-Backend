import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { of } from 'rxjs';
import { FinanceGatewayController } from './finance-gateway.controller';
import {
  ReceiptProjectionInterceptor,
  projectReceiptsForViewer,
} from './finance-receipt-projection';

/**
 * T3-2 (QlLf33Ma) — gateway: chekni bog'lash va tarixda ko'rsatish.
 *  • spend / payment/courier (SA/admin) / branch-to-main → `receipt_policy`;
 *    menejerning kuryer qabuli + chek → 400 RECEIPT_NOT_APPLICABLE;
 *  • javobda `data.receipt = { id, ai_status }` (ichki `ai_request_id` yo'q);
 *  • tarix proyeksiyasi: kuryer/market/registrator — `receipt` yo'q;
 *    to'liq ko'rinish — `photo_url` (kalit yo'q), `can_reanalyze` faqat SA/admin,
 *    menejer — faqat o'z filiali;
 *  • GET /finance/receipts/:id — menejer boshqa filial → 403;
 *  • `receipt_status` filtri — kuryer → 403.
 */
const SECRET = 'T3-link-spec-access-token-key';
const req = {
  headers: { host: 'api.elchipochta.uz', 'x-forwarded-proto': 'https' },
  protocol: 'http',
};
const FULL = {
  id: '41',
  kind: 'manual_expense',
  branch_id: '13',
  file_key: 'cashbox-receipt-1-uuid-receipt.jpg',
  ai_status: 'mismatch',
  can_reanalyze: true,
  reanalyze_block: null,
};

describe('T3-2 — tarixdagi receipt proyeksiyasi', () => {
  const previous = process.env.ACCESS_TOKEN_KEY;
  beforeAll(() => {
    process.env.ACCESS_TOKEN_KEY = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.ACCESS_TOKEN_KEY;
    else process.env.ACCESS_TOKEN_KEY = previous;
  });

  const payload = () => ({
    statusCode: 200,
    data: {
      items: [
        { id: '1', receipt: { id: '41', ai_status: 'match' } },
        { id: '2', receipt: null },
      ],
      detail: { id: '3', receipt: { ...FULL } },
    },
  });

  it.each([[['courier']], [['market']], [['registrator']], [[]]])(
    '%j — receipt kaliti umuman yo`q',
    (roles) => {
      const out = projectReceiptsForViewer(payload(), {
        roles,
        branchId: '13',
        req,
      }) as any;
      expect(out.data.items[0]).not.toHaveProperty('receipt');
      expect(out.data.detail).not.toHaveProperty('receipt');
      expect(out.data.items[0].id).toBe('1');
    },
  );

  it('⭐ superadmin — to`liq ko`rinishda photo_url (kalit yo`q), can_reanalyze', () => {
    const out = projectReceiptsForViewer(payload(), {
      roles: ['superadmin'],
      branchId: null,
      req,
    }) as any;
    expect(out.data.items[0].receipt).toEqual({ id: '41', ai_status: 'match' });
    const full = out.data.detail.receipt;
    expect(full).not.toHaveProperty('file_key');
    expect(full).not.toHaveProperty('reanalyze_block');
    expect(String(full.photo_url)).toMatch(
      /^https:\/\/api\.elchipochta\.uz\/files\/signed\//,
    );
    expect(full.photo_url_expires_in).toBe(300);
    expect(full.can_reanalyze).toBe(true);
    expect(JSON.stringify(out)).not.toContain('cashbox-receipt-1');
  });

  it('⭐ menejer — o`z filiali: ko`radi, qayta tahlil yo`q; boshqa filial — null', () => {
    const own = projectReceiptsForViewer(payload(), {
      roles: ['manager'],
      branchId: '13',
      req,
    }) as any;
    expect(own.data.detail.receipt).toMatchObject({
      id: '41',
      can_reanalyze: false,
    });
    const other = projectReceiptsForViewer(payload(), {
      roles: ['manager'],
      branchId: '99',
      req,
    }) as any;
    expect(other.data.detail.receipt).toBeNull();
  });

  it('interceptor tarix va kassa handler`larida', () => {
    const proto = FinanceGatewayController.prototype as unknown as Record<
      string,
      object
    >;
    for (const name of [
      'findHistory',
      'findHistoryById',
      'getMainCashbox',
      'findCashboxByUser',
    ]) {
      const handler = Object.getOwnPropertyDescriptor(
        FinanceGatewayController.prototype,
        name,
      )?.value as object;
      expect(
        Reflect.getMetadata(INTERCEPTORS_METADATA, handler) ?? [],
      ).toContain(ReceiptProjectionInterceptor);
      expect(proto[name]).toBeDefined();
    }
  });
});

describe('T3-2 — gateway yo`llari', () => {
  const previous = process.env.ACCESS_TOKEN_KEY;
  beforeAll(() => {
    process.env.ACCESS_TOKEN_KEY = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.ACCESS_TOKEN_KEY;
    else process.env.ACCESS_TOKEN_KEY = previous;
  });

  const make = (financeReply: unknown = { statusCode: 200, data: {} }) => {
    const finance = { send: jest.fn(() => of(financeReply)) };
    const branch = {
      send: jest.fn(() => of({ statusCode: 200, data: { id: '13' } })),
    };
    const controller = new FinanceGatewayController(
      finance as never,
      { send: jest.fn(() => of({ data: {} })) } as never,
      branch as never,
      { send: jest.fn(() => of({})) } as never,
    );
    return { controller, finance };
  };
  const user = (roles: string[], extra: Record<string, unknown> = {}) =>
    ({ user: { sub: '9', roles, ...extra } }) as never as { user: never };
  const lastPayload = (finance: { send: jest.Mock }) =>
    (finance.send.mock.calls.at(-1) as unknown as [unknown, any])[1];

  it('⭐ spend: receipt_policy manual_expense + receipt_id; javobda ai_request_id yo`q', async () => {
    const { controller, finance } = make({
      statusCode: 200,
      data: {
        history: { id: '5' },
        receipt: {
          id: '41',
          kind: 'manual_expense',
          ai_status: 'pending',
          ai_request_id: 'uuid-1',
        },
      },
    });
    const res: any = await controller.spendMoney(
      user(['superadmin']),
      { amount: 1000, expense_category_id: '2', receipt_id: '41' },
      'idem-1',
    );
    expect(lastPayload(finance)).toMatchObject({
      receipt_policy: { kind: 'manual_expense' },
      receipt_id: '41',
      created_by: '9',
    });
    expect(res.data.receipt).toEqual({ id: '41', ai_status: 'pending' });
  });

  it('⭐ menejer kuryerdan qabul + receipt_id → 400 RECEIPT_NOT_APPLICABLE (finance`ga bormaydi)', async () => {
    const { controller, finance } = make();
    const error = await controller
      .paymentFromCourier(user(['manager'], { branch_id: '13' }), {
        courier_id: '301',
        amount: 1000,
        payment_method: 'click',
        receipt_id: '41',
      } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'RECEIPT_NOT_APPLICABLE',
    });
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('branch-to-main: receipt_policy branch_to_hq + receipt_id', async () => {
    const { controller, finance } = make();
    await controller.paymentBranchToMain(user(['admin']), {
      branch_id: '13',
      amount: 1000,
      payment_method: 'click',
      receipt_id: '41',
    } as never);
    expect(lastPayload(finance)).toMatchObject({
      receipt_policy: { kind: 'branch_to_hq' },
      receipt_id: '41',
    });
  });

  it('⭐ GET /finance/receipts/:id: menejer boshqa filial → 403; o`z filiali → photo_url', async () => {
    const { controller } = make({ statusCode: 200, data: { ...FULL } });
    await expect(
      controller.getReceipt('41', {
        ...user(['manager'], { branch_id: '99' }),
        ...req,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const own: any = await controller.getReceipt('41', {
      ...user(['manager'], { branch_id: '13' }),
      ...req,
    });
    expect(own.data).toMatchObject({ id: '41', can_reanalyze: false });
    expect(own.data).not.toHaveProperty('file_key');
    expect(String(own.data.photo_url)).toContain('/files/signed/');
  });

  it('receipt_status filtri: kuryer → 403', async () => {
    const { controller, finance } = make();
    await expect(
      controller.findHistory({ receipt_status: 'none' }, user(['courier'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(finance.send).not.toHaveBeenCalled();
  });
});
