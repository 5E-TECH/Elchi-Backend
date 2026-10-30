import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { lastValueFrom, of, throwError } from 'rxjs';
import sharp from 'sharp';
import { setSharpForTesting } from './ai-order/ai-image-resize';
import {
  FinanceGatewayController,
  prepareReceiptAiImage,
} from './finance-gateway.controller';
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
      'myCashbox',
      'cashboxByUserId',
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
  const runInterceptor = async (
    user: Record<string, unknown>,
    branchClient?: { send: jest.Mock },
  ) => {
    const interceptor = new ReceiptProjectionInterceptor(branchClient as never);
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ ...req, user }) }),
    } as never;
    return (await lastValueFrom(
      interceptor.intercept(context, { handle: () => of(payload()) }),
    )) as any;
  };

  it('⭐ interceptor: JWT`da branch_id yo`q menejer — filial branch_users`dan (handler bilan bir xil)', async () => {
    const branch = {
      send: jest.fn(() => of({ data: { branch_id: '13', role: 'MANAGER' } })),
    };
    const out = await runInterceptor({ sub: '25', roles: ['manager'] }, branch);
    expect(branch.send).toHaveBeenCalledWith(
      { cmd: 'branch.user.find_by_user' },
      expect.objectContaining({ user_id: '25' }),
    );
    expect(out.data.detail.receipt).toMatchObject({ id: '41' });
  });

  it('interceptor: filial aniqlanmadi (xato) — chek null (fail closed); SA — so`rov yo`q', async () => {
    const failing = {
      send: jest.fn(() => throwError(() => new Error('down'))),
    };
    const out = await runInterceptor(
      { sub: '25', roles: ['manager'] },
      failing,
    );
    expect(out.data.detail.receipt).toBeNull();
    const branch = { send: jest.fn(() => of({ data: {} })) };
    const sa = await runInterceptor(
      { sub: '1', roles: ['superadmin'] },
      branch,
    );
    expect(branch.send).not.toHaveBeenCalled();
    expect(sa.data.detail.receipt).toMatchObject({ id: '41' });
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
  it.each([
    [['superadmin'], true],
    [['admin'], true],
    [['manager'], true],
    [['courier'], false],
    [['market'], false],
    [['registrator'], false],
  ])(
    '⭐ fail closed: tarix %j → include_receipts %s',
    async (roles, expected) => {
      const { controller, finance } = make({
        statusCode: 200,
        data: { items: [] },
      });
      await controller.findHistory({}, user(roles, { branch_id: '13' }));
      expect(lastPayload(finance).include_receipts).toBe(expected);
    },
  );

  it('⭐ my-cashbox (kuryer) — finance`dan chek SO`RALMAYDI; tafsilot — rolga qarab', async () => {
    const { controller, finance } = make({ statusCode: 200, data: {} });
    await controller.myCashbox(user(['courier']), {});
    expect(lastPayload(finance)).not.toHaveProperty('include_receipts');
    // Begona qator — 403, lekin finance so'rovida chek allaqachon so'ralmagan.
    await controller
      .findHistoryById('5', user(['courier']))
      .catch(() => undefined);
    expect(lastPayload(finance).include_receipts).toBe(false);
    await controller.findHistoryById('5', user(['admin']));
    expect(lastPayload(finance).include_receipts).toBe(true);
  });
});

describe('T3-3 — gateway: AI tahlili (fon) va qayta tahlil', () => {
  // Haqiqiy 3000×1500 JPEG — AI'ga 1568 px gacha kichraytirilib ketadi.
  let photoBase64 = '';
  beforeAll(async () => {
    photoBase64 = (
      await sharp({
        create: {
          width: 3000,
          height: 1500,
          channels: 3,
          background: { r: 240, g: 240, b: 240 },
        },
      })
        .jpeg({ quality: 95 })
        .toBuffer()
    ).toString('base64');
  });
  const cmdCalls = (mock: jest.Mock, name: string) =>
    (mock.mock.calls as unknown as Array<[{ cmd: string }, any]>).filter(
      ([pattern]) => pattern.cmd === name,
    );
  const make = (opts: {
    ai?: unknown;
    aiThrows?: boolean;
    finance?: unknown;
    body?: string;
  }) => {
    const finance = {
      send: jest.fn(() => of(opts.finance ?? { statusCode: 200, data: {} })),
    };
    const file = {
      send: jest.fn(() =>
        of({
          data: {
            body_base64: opts.body ?? photoBase64,
            mime_type: 'image/jpeg',
          },
        }),
      ),
    };
    const ai = {
      send: jest.fn(() =>
        opts.aiThrows ? throwError(() => new Error('down')) : of(opts.ai),
      ),
    };
    const controller = new FinanceGatewayController(
      finance as never,
      { send: jest.fn() } as never,
      { send: jest.fn() } as never,
      { send: jest.fn() } as never,
      file as never,
      ai as never,
    );
    return { controller, finance, file, ai };
  };
  const user = { sub: '9', roles: ['superadmin'] } as never;

  it('⭐ file.read → ai.finance.receipt_extract → finance.receipt.ai_result (o`sha ai_request_id)', async () => {
    const aiReply = { ok: true, amount: 150000, model: 'm' };
    const { controller, finance, file, ai } = make({ ai: aiReply });
    await controller.runReceiptAiCheck({
      receipt_id: '41',
      ai_request_id: 'req-1',
      file_key: 'cashbox-receipt-x.jpg',
      mime: 'image/jpeg',
      user,
    });
    expect(cmdCalls(file.send, 'file.read')[0][1]).toEqual({
      key: 'cashbox-receipt-x.jpg',
    });
    const sent = cmdCalls(ai.send, 'ai.finance.receipt_extract')[0][1];
    expect(sent).toMatchObject({ media_type: 'image/jpeg', receipt_id: '41' });
    // Kichraytirilgan: eng uzun tomon 1568 px, asl rasmdan kichik.
    const meta = await sharp(
      Buffer.from(sent.image_base64, 'base64'),
    ).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1568);
    expect(sent.image_base64.length).toBeLessThan(photoBase64.length);
    expect(cmdCalls(finance.send, 'finance.receipt.ai_result')[0][1]).toEqual({
      receipt_id: '41',
      ai_request_id: 'req-1',
      result: aiReply,
    });
  });

  it('AI xatosi / timeout — throw yo`q, natija network (finance error qiladi)', async () => {
    const { controller, finance } = make({ aiThrows: true });
    await expect(
      controller.runReceiptAiCheck({
        receipt_id: '41',
        ai_request_id: 'req-1',
        file_key: 'cashbox-receipt-x.jpg',
        mime: 'image/png',
        user,
      }),
    ).resolves.toBeUndefined();
    expect(
      cmdCalls(finance.send, 'finance.receipt.ai_result')[0][1].result,
    ).toEqual({ ok: false, reason: 'network' });
  });

  it('buzilgan fayl — AI chaqirilmaydi, image_decode_failed (finance: unreadable)', async () => {
    const { controller, finance, ai } = make({ ai: {}, body: 'aGVsbG8=' });
    await controller.runReceiptAiCheck({
      receipt_id: '41',
      ai_request_id: 'req-1',
      file_key: 'cashbox-receipt-x.jpg',
      mime: 'image/jpeg',
      user,
    });
    expect(cmdCalls(ai.send, 'ai.finance.receipt_extract')).toHaveLength(0);
    expect(
      cmdCalls(finance.send, 'finance.receipt.ai_result')[0][1].result,
    ).toEqual({ ok: false, reason: 'image_decode_failed' });
  });

  it('sharp yo`q va rasm katta — too_large, AI chaqirilmaydi', async () => {
    setSharpForTesting(null);
    try {
      const big = Buffer.alloc(5 * 1024 * 1024, 1).toString('base64');
      await expect(prepareReceiptAiImage(big, 'image/jpeg')).resolves.toEqual({
        reason: 'too_large',
      });
    } finally {
      setSharpForTesting(undefined);
    }
  });

  it('⭐ spend javobidagi pending chek → AI fonda boshlanadi; FE javobida file_key / ai_request_id yo`q', async () => {
    const { controller, file } = make({
      finance: {
        statusCode: 200,
        data: {
          receipt: {
            id: '41',
            ai_status: 'pending',
            ai_request_id: 'req-1',
            file_key: 'cashbox-receipt-x.jpg',
            mime: 'image/jpeg',
          },
        },
      },
      ai: { ok: false, reason: 'refused' },
    });
    const res: any = await controller.spendMoney(
      { user },
      { amount: 1000, expense_category_id: '2', receipt_id: '41' },
    );
    expect(res.data.receipt).toEqual({ id: '41', ai_status: 'pending' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(cmdCalls(file.send, 'file.read')).toHaveLength(1);
  });

  it('⭐ POST /finance/receipts/:id/reanalyze → 202 {receipt_id, ai_status:pending}, AI boshlanadi', async () => {
    const { controller, finance, file } = make({
      finance: {
        statusCode: 202,
        data: {
          receipt_id: '41',
          ai_status: 'pending',
          ai_request_id: 'req-2',
          file_key: 'cashbox-receipt-x.jpg',
          mime: 'image/jpeg',
        },
      },
      ai: { ok: false, reason: 'network' },
    });
    const res = await controller.reanalyzeReceipt('41', { user });
    expect(res).toEqual({
      statusCode: 202,
      message: 'Receipt reanalyze requested',
      data: { receipt_id: '41', ai_status: 'pending' },
    });
    expect(cmdCalls(finance.send, 'finance.receipt.reanalyze')[0][1]).toEqual({
      receipt_id: '41',
      requester_id: '9',
      requester_roles: ['superadmin'],
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(cmdCalls(file.send, 'file.read')).toHaveLength(1);
  });
});
