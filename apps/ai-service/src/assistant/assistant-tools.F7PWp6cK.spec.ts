import { of, throwError } from 'rxjs';
import {
  AI_ASSISTANT_READ_PATTERNS,
  AI_ASSISTANT_TOOL_NAMES,
  type AiAssistantRequester,
} from '@app/common';
import {
  AssistantReader,
  AssistantReadForbiddenError,
} from './assistant-reader';
import {
  assistantToolDefinitions,
  assistantToolSpecNames,
  executeAssistantTool,
  type AssistantToolContext,
} from './assistant-tools';
import { sanitizeForModel } from './assistant-sanitize';

/**
 * F7PWp6cK — yordamchi tool'lari: OQ RO'YXAT (faqat o'qish), rol filtri,
 * kirish validatsiyasi, PII (telefon) modelga ketmasligi, top-N.
 */

const SA: AiAssistantRequester = { id: '1', roles: ['superadmin'] };
const ADMIN: AiAssistantRequester = { id: '25', roles: ['admin'] };

type Sent = { client: string; cmd: string; payload: any };

function fakeClients(responses: Record<string, unknown>) {
  const sent: Sent[] = [];
  const mk = (client: string) => ({
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      sent.push({ client, cmd: pattern.cmd, payload });
      const r = responses[pattern.cmd];
      return r instanceof Error ? throwError(() => r) : of(r ?? { data: {} });
    }),
  });
  const finance = mk('FINANCE');
  const analytics = mk('ANALYTICS');
  const branch = mk('BRANCH');
  const reader = new AssistantReader(
    finance as any,
    analytics as any,
    branch as any,
  );
  return { reader, sent };
}

function ctx(
  reader: AssistantReader,
  requester: AiAssistantRequester = SA,
): AssistantToolContext {
  return { reader, requester, today: '2026-10-26' };
}

/** Yozuvchi amallarni bildiruvchi so'zlar — oq ro'yxatda bo'lmasligi SHART. */
const WRITE_VERB_RE =
  /\.(create|update|delete|remove|spend|fill|payment|pay|transfer|convert|open|close|record|raise|link|attach|ack|make_default|set_|rename|cancel|sell|approve|reject|assign|import|upsert|save|restore|revoke|send)/i;

describe('AI yordamchi tool oq ro‘yxati (F7PWp6cK)', () => {
  it('kartadagi 9 tool + T3-4 get_receipt_checks (OXIRIDA), registry bilan bir xil tartibda', () => {
    expect(AI_ASSISTANT_TOOL_NAMES).toEqual([
      'get_cash_position',
      'get_cashbox_history',
      'get_courier_debts',
      'get_market_payables',
      'get_branch_settlements',
      'get_shift_summaries',
      'get_expenses_by_category',
      'get_revenue_profit',
      'get_order_flow',
      'get_receipt_checks',
    ]);
    expect(assistantToolSpecNames()).toEqual([...AI_ASSISTANT_TOOL_NAMES]);
  });

  it('RMQ oq ro‘yxatida yozuvchi pattern YO‘Q', () => {
    for (const p of AI_ASSISTANT_READ_PATTERNS) {
      expect(p.cmd).not.toMatch(WRITE_VERB_RE);
      expect(['FINANCE', 'ANALYTICS', 'BRANCH']).toContain(p.client);
    }
  });

  it('oq ro‘yxatda yo‘q buyruq mijozga YETIB BORMAYDI', async () => {
    const { reader, sent } = fakeClients({});
    for (const cmd of [
      'finance.cashbox.spend',
      'finance.cashbox.payment_market',
      'finance.shift.close',
      'finance.cashbox.cards.transfer',
      'order.create',
    ]) {
      await expect(reader.read('FINANCE', cmd, {})).rejects.toBeInstanceOf(
        AssistantReadForbiddenError,
      );
    }
    // To'g'ri buyruq, lekin boshqa mijoz nomi bilan ham rad etiladi.
    await expect(
      reader.read('BRANCH', 'finance.history.find_all', {}),
    ).rejects.toBeInstanceOf(AssistantReadForbiddenError);
    expect(sent).toHaveLength(0);
  });

  it('har tool bajarilganda faqat oq ro‘yxatdagi buyruqlar yuboriladi', async () => {
    const { reader, sent } = fakeClients({});
    for (const name of AI_ASSISTANT_TOOL_NAMES) {
      const exec = await executeAssistantTool(name, {}, ctx(reader));
      expect(exec.result.isError).toBe(false);
    }
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(AssistantReader.isAllowed(s.client as any, s.cmd)).toBe(true);
    }
  });

  it('modelga faqat rolga ruxsat etilgan tool‘lar e’lon qilinadi', () => {
    expect(assistantToolDefinitions(['superadmin']).map((t) => t.name)).toEqual(
      [...AI_ASSISTANT_TOOL_NAMES],
    );
    expect(assistantToolDefinitions(['admin'])).toHaveLength(10);
    for (const role of [
      'market',
      'courier',
      'logist',
      'manager',
      'registrator',
    ]) {
      expect(assistantToolDefinitions([role])).toEqual([]);
    }
  });

  it('noma’lum tool / ruxsatsiz rol — is_error, o‘qish YO‘Q', async () => {
    const { reader, sent } = fakeClients({});
    const unknown = await executeAssistantTool(
      'finance_spend_money',
      {},
      ctx(reader),
    );
    expect(unknown.result.isError).toBe(true);
    const market = await executeAssistantTool(
      'get_cash_position',
      {},
      {
        ...ctx(reader),
        requester: { id: '37', roles: ['market'] },
      },
    );
    expect(market.result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('noto‘g‘ri kirish — INVALID_JSON / invalid_input, o‘qish YO‘Q', async () => {
    const { reader, sent } = fakeClients({});
    const extra = await executeAssistantTool(
      'get_cashbox_history',
      { from: '2026-10-01', cmd: 'finance.cashbox.spend' },
      ctx(reader),
    );
    expect(extra.result.isError).toBe(true);
    expect(JSON.parse(extra.result.content)).toHaveProperty('INVALID_JSON');
    const badDate = await executeAssistantTool(
      'get_cashbox_history',
      { from: '01.10.2026' },
      ctx(reader),
    );
    expect(JSON.parse(badDate.result.content)).toMatchObject({
      error: 'invalid_input',
    });
    const reversed = await executeAssistantTool(
      'get_order_flow',
      { from: '2026-10-20', to: '2026-10-01' },
      ctx(reader),
    );
    expect(reversed.result.isError).toBe(true);
    const tooLong = await executeAssistantTool(
      'get_revenue_profit',
      { from: '2024-01-01', to: '2026-10-26' },
      ctx(reader),
    );
    expect(tooLong.result.isError).toBe(true);
    const badEnum = await executeAssistantTool(
      'get_cashbox_history',
      { operation_type: 'transfer' },
      ctx(reader),
    );
    expect(badEnum.result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('payload API SUPERADMIN yo‘li bilan bir xil: tarix sukut MAIN, sukut davr — joriy oy', async () => {
    const { reader, sent } = fakeClients({});
    await executeAssistantTool('get_cashbox_history', {}, ctx(reader));
    expect(sent[0]).toMatchObject({
      client: 'FINANCE',
      cmd: 'finance.history.find_all',
      payload: {
        cashbox_type: 'main',
        from_date: '2026-10-01',
        to_date: '2026-10-26',
        page: 1,
      },
    });
  });

  it('analytics tool‘lari haqiqiy requester bilan (servis rol bo‘yicha kesadi)', async () => {
    const { reader, sent } = fakeClients({});
    await executeAssistantTool(
      'get_order_flow',
      { from: '2026-10-01', to: '2026-10-07' },
      ctx(reader, ADMIN),
    );
    expect(sent[0]).toMatchObject({
      cmd: 'analytics.dashboard',
      payload: {
        requester: { id: '25', roles: ['admin'] },
        filter: { startDate: '2026-10-01', endDate: '2026-10-07' },
      },
    });
  });

  it('PII: kuryer telefoni modelga ketmaydi, top-15 + jami + manba', async () => {
    const couriers = Array.from({ length: 20 }, (_, i) => ({
      id: String(i + 1),
      user_id: String(100 + i),
      balance: (i + 1) * 1000,
      balance_cash: (i + 1) * 1000,
      balance_card: 0,
      user: {
        id: String(100 + i),
        name: `Kuryer ${i + 1}`,
        phone_number: '+998901234567',
        region_id: '3',
      },
    }));
    const { reader } = fakeClients({
      'finance.cashbox.financial_balance': {
        statusCode: 200,
        data: {
          couriers: {
            allCourierCashboxes: couriers,
            couriersTotalBalanse: 210000,
            nonZeroCount: 20,
            truncated: false,
          },
        },
      },
    });
    const exec = await executeAssistantTool(
      'get_courier_debts',
      {},
      ctx(reader),
    );
    expect(exec.result.content).not.toContain('901234567');
    expect(exec.result.content).not.toContain('phone');
    const body = JSON.parse(exec.result.content);
    expect(body.data.top).toHaveLength(15);
    expect(body.data.top[0]).toMatchObject({
      name: 'Kuryer 20',
      balance: 20000,
    });
    expect(body.data.couriers_total_balance).toBe(210000);
    expect(exec.source).toEqual({
      tool: 'get_courier_debts',
      period: null,
      records: 20,
      truncated: true,
      ok: true,
    });
  });

  it('xarajat kategoriyalari bo‘yicha agregat (nomi, ulush %), izohlar modelga ketmaydi', async () => {
    const { reader, sent } = fakeClients({
      'finance.history.find_all': {
        data: {
          items: [
            {
              amount: 300,
              expense_category_id: '1',
              source_type: 'manual_expense',
              comment: 'Ali +998901112233',
            },
            {
              amount: 100,
              expense_category_id: '2',
              source_type: 'manual_expense',
            },
            { amount: 100, expense_category_id: null, source_type: 'salary' },
          ],
          pagination: { total: 3 },
        },
      },
      'finance.cashbox.expense_categories.list': {
        data: {
          items: [
            { id: '1', name: 'Yoqilg‘i' },
            { id: '2', name: 'Ijara' },
          ],
        },
      },
    });
    const exec = await executeAssistantTool(
      'get_expenses_by_category',
      { from: '2026-10-01', to: '2026-10-26' },
      ctx(reader),
    );
    expect(sent[0].payload).toMatchObject({
      cashbox_type: 'main',
      operation_type: 'expense',
    });
    const body = JSON.parse(exec.result.content);
    expect(body.data.total_expense).toBe(500);
    expect(body.data.by_category[0]).toMatchObject({
      name: 'Yoqilg‘i',
      amount: 300,
      share_percent: 60,
    });
    expect(exec.result.content).not.toContain('1112233');
    expect(body.period).toEqual({ from: '2026-10-01', to: '2026-10-26' });
    expect(body.records).toBe(3);
  });

  it('⭐ get_receipt_checks (T3-4): payload API bilan bir xil (rollar bilan), natija top-15 bilan cheklangan', async () => {
    const counts = {
      match: 3,
      mismatch: 2,
      unreadable: 0,
      pending: 0,
      error: 0,
      disabled: 0,
      none: 1,
    };
    const { reader, sent } = fakeClients({
      'finance.receipt_checks.summary': {
        statusCode: 200,
        data: {
          period: { from: '2026-10-01', to: '2026-10-26' },
          counts,
          total: 6,
          mismatch_total: 7000,
          by_branch: Array.from({ length: 20 }, (_, i) => ({
            branch_id: String(i + 1),
            counts,
          })),
          by_category: [{ expense_category_id: '4', name: 'Ijara', counts }],
          top: [
            {
              receipt_id: '41',
              history_id: '501',
              kind: 'manual_expense',
              entered_amount: 145000,
              difference: 5000,
              date: '2026-10-20T07:00:00.000Z',
              file_key: 'cashbox-receipt-1-x.jpg',
              uploaded_by: { id: '7', name: 'Ali' },
            },
          ],
        },
      },
    });
    const exec = await executeAssistantTool(
      'get_receipt_checks',
      { from: '2026-10-01', ai_status: 'mismatch' },
      ctx(reader, ADMIN),
    );
    expect(sent).toEqual([
      {
        client: 'FINANCE',
        cmd: 'finance.receipt_checks.summary',
        payload: {
          from: '2026-10-01',
          to: '2026-10-26',
          ai_status: 'mismatch',
          requester_roles: ['admin'],
        },
      },
    ]);
    expect(exec.result.isError).toBe(false);
    const body = JSON.parse(exec.result.content);
    expect(body).toMatchObject({
      tool: 'get_receipt_checks',
      records: 6,
      truncated: true,
      data: { counts, total: 6, mismatch_total: 7000 },
    });
    expect(body.data.by_branch).toHaveLength(15);
    expect(body.data.largest_differences).toEqual([
      {
        receipt_id: '41',
        history_id: '501',
        kind: 'manual_expense',
        entered_amount: 145000,
        difference: 5000,
        date: '2026-10-20T07:00:00.000Z',
      },
    ]);
    expect(exec.result.content).not.toMatch(/file_key|cashbox-receipt-|Ali/);
  });

  it('get_receipt_checks: noto`g`ri kind / ai_status / davr — invalid_input, o`qish YO`Q', async () => {
    const { reader, sent } = fakeClients({});
    for (const input of [
      { kind: 'salary' },
      { ai_status: 'linked' },
      { from: '2024-01-01', to: '2026-10-26' },
    ]) {
      const exec = await executeAssistantTool(
        'get_receipt_checks',
        input,
        ctx(reader),
      );
      expect(exec.result.isError).toBe(true);
    }
    expect(sent).toHaveLength(0);
  });

  it('RMQ xatosi — is_error, xato matni modelga ketmaydi', async () => {
    const { reader } = fakeClients({
      'finance.shift.find_all': new Error('connection refused 10.0.0.5'),
    });
    const exec = await executeAssistantTool(
      'get_shift_summaries',
      {},
      ctx(reader),
    );
    expect(exec.result.isError).toBe(true);
    expect(exec.result.content).not.toContain('10.0.0.5');
    expect(exec.failure).toContain('connection refused');
  });

  it('sanitizeForModel: PII kalitlari tashlanadi, matndagi telefon maskalanadi', () => {
    const out = sanitizeForModel({
      name: 'Market A',
      phone_number: '+998901234567',
      comment: 'x',
      nested: { holder_name: 'Ali', note: 'tel 90 123 45 67', amount: 5 },
      text: 'Qo‘ng‘iroq: +998 90 123 45 67',
    }) as any;
    expect(out).not.toHaveProperty('phone_number');
    expect(out).not.toHaveProperty('comment');
    expect(out.nested).toEqual({ amount: 5 });
    expect(out.text).not.toContain('123 45 67');
  });
});
