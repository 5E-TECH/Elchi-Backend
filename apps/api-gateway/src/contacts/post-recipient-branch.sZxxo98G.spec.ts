import 'reflect-metadata';
import { of, throwError } from 'rxjs';
import { LogisticsGatewayController } from '../logistics-gateway.controller';
import { renderPostReceiptHtml } from '../printer/printer.util';
import { BranchContactLoader } from './branch-contact';
import {
  postRecipientBranchId,
  postRecipientBranchPhone,
  withPostRecipientBranch,
} from './post-recipient-branch';

/**
 * sZxxo98G (Dilshod 2026-11-27): «Pochta cheklarida kimga joʻnatilgani nomi
 * bor lekin telefon nomeri yuq». Kuryer pochtasi chekida «Kuryer: Ism ·
 * telefon» bor edi; filial o'tkazmasida (kuryersiz, sent/received) qabul
 * qiluvchi filial na nomi, na raqami bilan chiqmasdi. Endi `data.post`
 * `recipient_branch` (0Rn5U6AD `branch.contact`, doira bir xil).
 */

const transferPost = (overrides: Record<string, unknown> = {}) => ({
  id: '74',
  status: 'sent',
  courier_id: '0',
  courier: null,
  qr_code_token: 'POST-tr74',
  order_quantity: 2,
  branch_id: '12',
  branch: { id: '1', name: 'HQ Toshkent' },
  region_id: '13',
  region: { id: '13', name: 'Xorazm' },
  createdAt: '2026-10-30T12:52:00.000Z',
  ...overrides,
});

const courierPost = {
  id: '108',
  status: 'sent',
  courier_id: '26',
  courier: { id: '26', name: 'Fatxulla', phone_number: '+998900000077' },
  qr_code_token: 'POST-c108',
  order_quantity: 1,
  branch_id: null,
  region: { id: '1', name: 'Toshkent shahri' },
  createdAt: '2026-11-05T09:46:00.000Z',
};

const contactData = (overrides: Record<string, unknown> = {}) => ({
  id: '12',
  name: 'Shahriyor Xorazm',
  phone_number: '+998912222222',
  manager: { id: '522', name: 'Menejer Ali', phone_number: '+998935550101' },
  ...overrides,
});

const branchClient = (data: unknown = contactData()) => ({
  send: jest.fn(() => of({ statusCode: 200, data })),
});

const orderRow = {
  id: '418',
  market_id: '2',
  customer_id: '3',
  status: 'on the road',
  total_price: 150000,
  where_deliver: 'address',
  post_id: '74',
  items: [],
};

const ordersResponse = (post: unknown) => ({
  statusCode: 200,
  data: {
    allOrdersByPostId: [orderRow],
    homeOrders: { homeOrders: 1, homeOrdersTotalPrice: 150000 },
    centerOrders: { centerOrders: 0, centerOrdersTotalPrice: 0 },
    post,
  },
});

const build = (
  post: unknown,
  branch: { send: jest.Mock } | null = branchClient(),
) => {
  const logistics = {
    send: jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'logistics.post.orders_by_post'
        ? of(ordersResponse(post))
        : of({ statusCode: 200, data: null }),
    ),
  };
  const identity = { send: jest.fn(() => of({ data: null })) };
  const controller = new LogisticsGatewayController(
    logistics as never,
    identity as never,
    undefined,
    undefined,
    undefined,
    (branch ?? undefined) as never,
  );
  return { controller, logistics, branch };
};

const req = (roles: string[], branchId: string | null = null) => ({
  user: { sub: '20', roles, branch_id: branchId },
});

type PostOrdersBody = {
  data: { post: Record<string, unknown> & { recipient_branch?: unknown } };
};

const fakeHtmlResponse = () => {
  const res = { set: jest.fn(), end: jest.fn() };
  return {
    res,
    html: (): string => {
      const body = (res.end.mock.calls as unknown[][])[0]?.[0];
      return typeof body === 'string' ? body : '';
    },
  };
};

describe('sZxxo98G — postRecipientBranchId (filial o‘tkazmasi)', () => {
  it.each([
    ['sent, courier 0', transferPost(), '12'],
    ['received, courier 0', transferPost({ status: 'received' }), '12'],
    ['courier null', transferPost({ courier_id: null }), '12'],
    ['courier bo‘sh', transferPost({ courier_id: '' }), '12'],
    ['raqamli branch_id', transferPost({ branch_id: 12 }), '12'],
    ['katta harf holat', transferPost({ status: 'SENT' }), '12'],
  ])('%s → manzil filial', (_name, post, expected) => {
    expect(postRecipientBranchId(post)).toBe(expected);
  });

  it.each([
    ['kuryer pochtasi', courierPost],
    ['yig‘ilmoqda (new)', transferPost({ status: 'new' })],
    ['bekor (canceled)', transferPost({ status: 'canceled' })],
    ['canceled_received', transferPost({ status: 'canceled_received' })],
    ['filialsiz', transferPost({ branch_id: null })],
    ['buzuq branch_id', transferPost({ branch_id: '12; drop' })],
    ['obyekt emas', null],
  ])('%s → null', (_name, post) => {
    expect(postRecipientBranchId(post)).toBeNull();
  });
});

describe('sZxxo98G — postRecipientBranchPhone', () => {
  it('filial raqami ustun', () => {
    expect(postRecipientBranchPhone(contactData())).toBe('+998912222222');
  });
  it('filial raqami bo‘sh — faol menejer raqami', () => {
    expect(postRecipientBranchPhone(contactData({ phone_number: null }))).toBe(
      '+998935550101',
    );
    expect(postRecipientBranchPhone(contactData({ phone_number: '  ' }))).toBe(
      '+998935550101',
    );
  });
  it('ikkalasi ham yo‘q — null', () => {
    expect(
      postRecipientBranchPhone(
        contactData({ phone_number: null, manager: null }),
      ),
    ).toBeNull();
    expect(postRecipientBranchPhone(null)).toBeNull();
  });
});

describe('sZxxo98G — withPostRecipientBranch (doira 0Rn5U6AD)', () => {
  const loaderFor = (client: { send: jest.Mock }) =>
    new BranchContactLoader(client as never);
  const payload = (post: unknown) => ({ statusCode: 200, data: { post } });

  it.each([['superadmin'], ['admin'], ['registrator']])(
    '%s — har filial kontakti',
    async (role) => {
      const client = branchClient();
      const out = await withPostRecipientBranch(
        payload(transferPost()),
        { roles: [role] },
        loaderFor(client),
      );
      expect(out.data.post).toMatchObject({
        id: '74',
        recipient_branch: contactData(),
      });
      expect(client.send).toHaveBeenCalledWith(
        { cmd: 'branch.contact' },
        { id: '12' },
      );
    },
  );

  it('menejer — o‘z filiali pochtasida bor', async () => {
    const out = await withPostRecipientBranch(
      payload(transferPost()),
      { roles: ['manager'], branch_id: '12' },
      loaderFor(branchClient()),
    );
    expect(out.data.post).toMatchObject({ recipient_branch: contactData() });
  });

  it.each([
    ['boshqa filial menejeri', ['manager'], '9'],
    ['filialsiz menejer', ['manager'], null],
    ['kuryer', ['courier'], '12'],
    ['logist', ['logist'], null],
    ['market', ['market'], null],
  ])('%s — null, RPC yo‘q', async (_name, roles, branchId) => {
    const client = branchClient();
    const out = await withPostRecipientBranch(
      payload(transferPost()),
      { roles, branch_id: branchId },
      loaderFor(client),
    );
    expect(out.data.post).toMatchObject({ id: '74', recipient_branch: null });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('kuryer pochtasi — null, kuryer o‘zgarmaydi, RPC yo‘q', async () => {
    const client = branchClient();
    const out = await withPostRecipientBranch(
      payload(courierPost),
      { roles: ['superadmin'] },
      loaderFor(client),
    );
    expect(out.data.post).toEqual({ ...courierPost, recipient_branch: null });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('branch-service yiqilsa — null, javob buzilmaydi', async () => {
    const client = {
      send: jest.fn(() => throwError(() => new Error('timeout'))),
    };
    const out = await withPostRecipientBranch(
      payload(transferPost()),
      { roles: ['admin'] },
      loaderFor(client),
    );
    expect(out.data.post).toMatchObject({ id: '74', recipient_branch: null });
  });

  it('pochta meta’si yo‘q — javob o‘sha-o‘sha', async () => {
    const client = branchClient();
    const raw = { statusCode: 200, data: { allOrdersByPostId: [] } };
    await expect(
      withPostRecipientBranch(raw, { roles: ['admin'] }, loaderFor(client)),
    ).resolves.toBe(raw);
  });
});

describe('sZxxo98G — GET /post/orders/:id', () => {
  it('filial o‘tkazmasi (SA): post.recipient_branch, boshqa maydonlar joyida', async () => {
    const { controller, branch } = build(transferPost());
    const body = (await controller.getOrdersByPost(
      '74',
      req(['superadmin']),
    )) as PostOrdersBody;
    expect(body.data.post).toEqual({
      ...transferPost(),
      recipient_branch: contactData(),
    });
    expect(branch!.send).toHaveBeenCalledTimes(1);
  });

  it('kuryer pochtasi: recipient_branch null, kuryer telefoni joyida', async () => {
    const { controller, branch } = build(courierPost);
    const body = (await controller.getOrdersByPost(
      '108',
      req(['admin']),
    )) as PostOrdersBody;
    expect(body.data.post.recipient_branch).toBeNull();
    expect(body.data.post.courier).toEqual(courierPost.courier);
    expect(branch!.send).not.toHaveBeenCalled();
  });

  it('menejer boshqa filial pochtasida — null', async () => {
    const { controller, branch } = build(transferPost());
    const body = (await controller.getOrdersByPost(
      '74',
      req(['manager'], '9'),
    )) as PostOrdersBody;
    expect(body.data.post.recipient_branch).toBeNull();
    expect(branch!.send).not.toHaveBeenCalled();
  });

  it('BRANCH klienti yo‘q (eski qurilish) — maydon qo‘shilmaydi', async () => {
    const { controller } = build(transferPost(), null);
    const body = (await controller.getOrdersByPost(
      '74',
      req(['superadmin']),
    )) as PostOrdersBody;
    expect(body.data.post).not.toHaveProperty('recipient_branch');
  });

  it('kontakt 60 s keshlanadi — ikkinchi so‘rovda RPC yo‘q', async () => {
    const { controller, branch } = build(transferPost());
    await controller.getOrdersByPost('74', req(['admin']));
    await controller.getOrdersByPost('74', req(['admin']));
    expect(branch!.send).toHaveBeenCalledTimes(1);
  });
});

describe('sZxxo98G — GET /post/:id/receipt (HTML chek)', () => {
  it('filial o‘tkazmasi: «Qabul qiluvchi: Filial · filial raqami»', async () => {
    const { controller } = build(transferPost());
    const { res, html } = fakeHtmlResponse();
    await controller.getPostReceipt('74', req(['admin']), res as never);
    const page = html();
    expect(page).toContain(
      '<td class="m-lbl">Qabul qiluvchi:</td><td class="m-val">Shahriyor Xorazm · +998 (91) 222-22-22</td>',
    );
    expect(page).toContain(
      '<td class="m-lbl">Kuryer:</td><td class="m-val">-</td>',
    );
  });

  it('filial raqami bo‘sh — menejer raqami', async () => {
    const { controller } = build(
      transferPost(),
      branchClient(contactData({ phone_number: null })),
    );
    const { res, html } = fakeHtmlResponse();
    await controller.getPostReceipt('74', req(['registrator']), res as never);
    expect(html()).toContain('Shahriyor Xorazm · +998 (93) 555-01-01');
  });

  it('kuryer pochtasi: «Qabul qiluvchi» qatori yo‘q, kuryer telefoni bor', async () => {
    const { controller } = build(courierPost);
    const { res, html } = fakeHtmlResponse();
    await controller.getPostReceipt('108', req(['admin']), res as never);
    const page = html();
    expect(page).not.toContain('Qabul qiluvchi:');
    expect(page).toContain('Fatxulla · +998 (90) 000-00-77');
  });

  it('raqamsiz filial — faqat nom; HTML escape qilinadi', async () => {
    const html = await renderPostReceiptHtml(
      {
        ...transferPost(),
        recipient_branch: {
          name: '<b>Filial</b>',
          phone_number: null,
          manager: null,
        },
      },
      [],
      '80mm',
    );
    expect(html).toContain(
      '<td class="m-lbl">Qabul qiluvchi:</td><td class="m-val">&lt;b&gt;Filial&lt;/b&gt;</td>',
    );
  });
});
