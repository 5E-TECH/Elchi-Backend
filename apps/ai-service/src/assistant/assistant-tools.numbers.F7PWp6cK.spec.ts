import { of } from 'rxjs';
import type { AiAssistantRequester } from '@app/common';
import { AssistantReader } from './assistant-reader';
import {
  ASSISTANT_HISTORY_FETCH_LIMIT,
  assistantToolDefinitions,
  executeAssistantTool,
  type AssistantToolContext,
} from './assistant-tools';

/**
 * F7PWp6cK (BE-D) — 10 savollik TC: yordamchi raqamlari hisobotlar bilan
 * AYNAN bir xil chiqishi uchun tool nuqsonlari (D2–D7):
 *  - D2 get_order_flow: reyting qatorida nom/id, saralash qoidasi, oyna,
 *    previous sanalari Toshkent YYYY-MM-DD, «yo'ldagi» va'dasi yo'q;
 *  - D3 get_revenue_profit: series[].orders = `ordersCount`;
 *  - D4 get_expenses_by_category: kategoriya — faqat qo'lda xarajat, qolgan
 *    chiqimlar manba turi bo'yicha alohida, jami — BARCHA chiqim;
 *  - D5 jami summalar `finance.history.daily` (SQL SUM, 1000 chegarasiz);
 *  - D6 musbat/manfiy balanslar alohida ro'yxatlarda, market jami ikki xil;
 *  - D7 auto_closed = close_reason 'auto' (NULL — avto emas).
 */

const SA: AiAssistantRequester = { id: '1', roles: ['superadmin'] };

type Sent = { client: string; cmd: string; payload: any };
/** Javob yoki payload'dan javob quruvchi funksiya. */
type Reply = unknown;

function fakeClients(responses: Record<string, Reply>) {
  const sent: Sent[] = [];
  const mk = (client: string) => ({
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      sent.push({ client, cmd: pattern.cmd, payload });
      const r = responses[pattern.cmd];
      const v = typeof r === 'function' ? (r as any)(payload) : r;
      return of(v ?? { data: {} });
    }),
  });
  const reader = new AssistantReader(
    mk('FINANCE') as any,
    mk('ANALYTICS') as any,
    mk('BRANCH') as any,
  );
  return { reader, sent };
}

function ctx(
  reader: AssistantReader,
  today = '2026-10-26',
): AssistantToolContext {
  return { reader, requester: SA, today };
}

async function run(
  tool: string,
  input: Record<string, unknown>,
  responses: Record<string, Reply>,
  today?: string,
) {
  const { reader, sent } = fakeClients(responses);
  const exec = await executeAssistantTool(tool, input, ctx(reader, today));
  expect(exec.result.isError).toBe(false);
  return { exec, sent, body: JSON.parse(exec.result.content) };
}

const historyRow = (
  i: number,
  amount: number,
  extra: Record<string, unknown> = {},
) => ({
  id: String(i),
  createdAt: '2026-10-10T07:00:00.000Z',
  operation_type: 'expense',
  source_type: 'manual_expense',
  payment_method: 'cash',
  amount,
  balance_after: 0,
  ...extra,
});

describe('F7PWp6cK BE-D — yordamchi raqamlari hisobotlar bilan bir xil', () => {
  describe('D5 — davr: 366 kalendar kuni (history/daily bilan bir xil)', () => {
    it('366 kun (ikki chet kiradi) — ruxsat; 367 kun — invalid_input, o‘qish YO‘Q', async () => {
      const ok = fakeClients({});
      const exec366 = await executeAssistantTool(
        'get_cashbox_history',
        { from: '2025-10-26', to: '2026-10-26' },
        ctx(ok.reader),
      );
      expect(exec366.result.isError).toBe(false);

      const bad = fakeClients({});
      const exec367 = await executeAssistantTool(
        'get_cashbox_history',
        { from: '2025-10-25', to: '2026-10-26' },
        ctx(bad.reader),
      );
      expect(JSON.parse(exec367.result.content)).toMatchObject({
        error: 'invalid_input',
      });
      expect(bad.sent).toHaveLength(0);
    });
  });

  describe('D5 — get_cashbox_history: jami SQL agregatdan (1000 qator chegarasiz)', () => {
    it('2500 qatorli davr: totals = history/daily, kesimlar qisman (breakdown_complete=false)', async () => {
      const items = Array.from(
        { length: ASSISTANT_HISTORY_FETCH_LIMIT },
        (_, i) =>
          historyRow(i + 1, 1000, {
            operation_type: i % 2 ? 'income' : 'expense',
            source_type: i % 2 ? 'courier_payment' : 'market_payment',
          }),
      );
      const { body, sent } = await run(
        'get_cashbox_history',
        {
          from: '2026-10-01',
          to: '2026-10-25',
          source_type: 'courier_payment',
        },
        {
          'finance.history.daily': {
            statusCode: 200,
            data: {
              totals: {
                income: 7_250_000.5,
                expense: 1_200_000,
                net: 6_050_000.5,
                income_count: 2000,
                expense_count: 500,
              },
            },
          },
          'finance.history.find_all': {
            data: {
              items,
              counts: { all: 2500, income: 2000, expense: 500 },
              pagination: { total: 2500 },
            },
          },
        },
      );
      // Ikkala o'qish ham AYNI filtr bilan (API SUPERADMIN yo'li).
      const daily = sent.find((s) => s.cmd === 'finance.history.daily');
      const rows = sent.find((s) => s.cmd === 'finance.history.find_all');
      expect(daily).toEqual({
        client: 'FINANCE',
        cmd: 'finance.history.daily',
        payload: {
          cashbox_type: 'main',
          from_date: '2026-10-01',
          to_date: '2026-10-25',
          source_type: 'courier_payment',
        },
      });
      expect(rows?.payload).toEqual({
        ...daily!.payload,
        page: 1,
        limit: ASSISTANT_HISTORY_FETCH_LIMIT,
      });
      expect(body.data.totals).toEqual({
        income: 7_250_000.5,
        expense: 1_200_000,
        net: 6_050_000.5,
        income_count: 2000,
        expense_count: 500,
      });
      expect(body.data.totals_complete).toBe(true);
      expect(body.data.breakdown_complete).toBe(false);
      expect(body.data.breakdown_rows).toBe(1000);
      // F4 — kesim qisman: aniq manba summasi uchun filtrli chaqiruv ko'rsatmasi.
      expect(body.data.breakdown_hint).toContain('eng yangi 1000 qator');
      expect(body.data.breakdown_hint).toContain('source_type filtri');
      // sanitizeForModel 160 belgidan uzun satrni kesadi — ko'rsatma butun.
      expect(body.data.breakdown_hint).toMatch(/totals aniq$/);
      expect(body.records).toBe(2500);
      expect(body.truncated).toBe(true);
    });

    it('F4: kesim to‘liq bo‘lsa breakdown_hint null; tavsif aniq manba summasi uchun source_type filtrini aytadi', async () => {
      const { body } = await run(
        'get_cashbox_history',
        {},
        {
          'finance.history.daily': {
            data: { totals: { income: 1000, income_count: 1 } },
          },
          'finance.history.find_all': {
            data: {
              items: [historyRow(1, 1000, { operation_type: 'income' })],
              pagination: { total: 1 },
            },
          },
        },
      );
      expect(body.data.breakdown_complete).toBe(true);
      expect(body.data.breakdown_hint).toBeNull();
      const tool = assistantToolDefinitions(['superadmin']).find(
        (t) => t.name === 'get_cashbox_history',
      )!;
      expect(tool.description).toMatch(
        /ANIQ summasi\/soni kerak bo'lsa .*source_type .*filtri bilan chaqiring/,
      );
    });

    it('cashbox_type=courier → couriers; operation_type ikkala o‘qishga ham boradi', async () => {
      const { sent } = await run(
        'get_cashbox_history',
        { cashbox_type: 'courier', operation_type: 'income' },
        {},
      );
      for (const cmd of ['finance.history.daily', 'finance.history.find_all']) {
        expect(sent.find((s) => s.cmd === cmd)?.payload).toMatchObject({
          cashbox_type: 'couriers',
          operation_type: 'income',
          from_date: '2026-10-01',
          to_date: '2026-10-26',
        });
      }
    });
  });

  describe('D4 + D5 — get_expenses_by_category', () => {
    const categories = {
      data: {
        items: [
          { id: '1', name: 'Yoqilg‘i' },
          { id: '2', name: 'Ijara' },
        ],
      },
    };
    const manualRows = [
      historyRow(1, 300_000, { expense_category_id: '1' }),
      historyRow(2, 100_000, { expense_category_id: '2' }),
      historyRow(3, 50_000, { expense_category_id: '2' }),
      // O'chirilgan kategoriya (joriy ro'yxatda yo'q).
      historyRow(4, 70_000, { expense_category_id: '9' }),
      // Kategoriyasiz qo'lda xarajat.
      historyRow(5, 20_000, { expense_category_id: null }),
    ];
    const otherRows = [
      historyRow(6, 5_000_000, {
        source_type: 'market_payment',
        expense_category_id: null,
      }),
      historyRow(7, 1_000_000, {
        source_type: 'salary',
        expense_category_id: null,
      }),
      historyRow(8, 400_000, {
        source_type: 'market_payment',
        expense_category_id: null,
      }),
    ];
    const daily = (payload: any) =>
      payload.source_type === 'manual_expense'
        ? { data: { totals: { expense: 540_000, expense_count: 5 } } }
        : { data: { totals: { expense: 6_940_000, expense_count: 8 } } };
    const findAll = (payload: any) =>
      payload.source_type === 'manual_expense'
        ? { data: { items: manualRows, pagination: { total: 5 } } }
        : { data: { items: otherRows, pagination: { total: 3 } } };

    it('kategoriya — FAQAT qo‘lda xarajat; market to‘lovi/ish haqi «Kategoriyasiz» ga tushmaydi', async () => {
      const { body, sent } = await run(
        'get_expenses_by_category',
        { from: '2026-10-01', to: '2026-10-25' },
        {
          'finance.history.daily': daily,
          'finance.history.find_all': findAll,
          'finance.cashbox.expense_categories.list': categories,
        },
      );
      const base = {
        cashbox_type: 'main',
        operation_type: 'expense',
        from_date: '2026-10-01',
        to_date: '2026-10-25',
      };
      const payloads = (cmd: string) =>
        sent.filter((s) => s.cmd === cmd).map((s) => s.payload);
      expect(payloads('finance.history.daily')).toEqual(
        expect.arrayContaining([
          base,
          { ...base, source_type: 'manual_expense' },
        ]),
      );
      const rowReads = payloads('finance.history.find_all');
      expect(rowReads).toHaveLength(2);
      expect(rowReads).toContainEqual({
        ...base,
        source_type: 'manual_expense',
        page: 1,
        limit: ASSISTANT_HISTORY_FETCH_LIMIT,
      });
      const other = rowReads.find((p) => p.source_types);
      expect(other.source_types.split(',')).not.toContain('manual_expense');
      expect(other.source_types.split(',')).toEqual(
        expect.arrayContaining([
          'market_payment',
          'salary',
          'payment_reversal',
        ]),
      );

      expect(body.data).toMatchObject({
        total_expense: 6_940_000,
        expense_count: 8,
        totals_complete: true,
        manual_expense_total: 540_000,
        manual_expense_count: 5,
        non_manual_expense_total: 6_400_000,
        non_manual_expense_count: 3,
        by_category_complete: true,
        non_manual_by_source_complete: true,
        manual_uncategorised: {
          count: 1,
          amount: 20_000,
          share_of_manual_percent: 3.7,
        },
      });
      expect(body.data.total_expense_scope).toContain('BARCHA');
      expect(body.data.by_category).toEqual([
        {
          category_id: '1',
          name: 'Yoqilg‘i',
          count: 1,
          amount: 300_000,
          share_of_manual_percent: 55.56,
        },
        {
          category_id: '2',
          name: 'Ijara',
          count: 2,
          amount: 150_000,
          share_of_manual_percent: 27.78,
        },
        {
          category_id: '9',
          name: '#9',
          deleted_category: true,
          count: 1,
          amount: 70_000,
          share_of_manual_percent: 12.96,
        },
      ]);
      // Kategoriyasiz qo'lda xarajat kategoriya ro'yxatida EMAS.
      expect(
        body.data.by_category.some((c: any) => c.category_id === null),
      ).toBe(false);
      expect(body.data.non_manual_by_source_type).toEqual([
        {
          source_type: 'market_payment',
          count: 2,
          amount: 5_400_000,
          share_of_non_manual_percent: 84.38,
        },
        {
          source_type: 'salary',
          count: 1,
          amount: 1_000_000,
          share_of_non_manual_percent: 15.63,
        },
      ]);
      expect(body.records).toBe(8);
      expect(body.truncated).toBe(false);
    });

    it('1000 dan ko‘p qo‘lda xarajat: jami aniq (SQL), kategoriya kesimi qisman (by_category_complete=false)', async () => {
      const many = Array.from(
        { length: ASSISTANT_HISTORY_FETCH_LIMIT },
        (_, i) => historyRow(i + 1, 1000, { expense_category_id: '1' }),
      );
      const { body } = await run(
        'get_expenses_by_category',
        {},
        {
          'finance.history.daily': (p: any) =>
            p.source_type === 'manual_expense'
              ? {
                  data: { totals: { expense: 1_500_000, expense_count: 1500 } },
                }
              : {
                  data: { totals: { expense: 1_500_000, expense_count: 1500 } },
                },
          'finance.history.find_all': (p: any) =>
            p.source_type === 'manual_expense'
              ? { data: { items: many, pagination: { total: 1500 } } }
              : { data: { items: [], pagination: { total: 0 } } },
          'finance.cashbox.expense_categories.list': categories,
        },
      );
      expect(body.data).toMatchObject({
        total_expense: 1_500_000,
        manual_expense_total: 1_500_000,
        manual_expense_count: 1500,
        totals_complete: true,
        by_category_complete: false,
        non_manual_by_source_complete: true,
      });
      expect(body.truncated).toBe(true);
    });

    it('F16: qo‘lda bo‘lmagan chiqimlar o‘qilganidan ko‘p — non_manual_by_source_complete=false', async () => {
      const other = Array.from(
        { length: ASSISTANT_HISTORY_FETCH_LIMIT },
        (_, i) => historyRow(i + 1, 1000, { source_type: 'market_payment' }),
      );
      const { body } = await run(
        'get_expenses_by_category',
        {},
        {
          'finance.history.daily': (p: any) =>
            p.source_type === 'manual_expense'
              ? { data: { totals: { expense: 0, expense_count: 0 } } }
              : {
                  data: { totals: { expense: 1_500_000, expense_count: 1500 } },
                },
          'finance.history.find_all': (p: any) =>
            p.source_type === 'manual_expense'
              ? { data: { items: [], pagination: { total: 0 } } }
              : { data: { items: other, pagination: { total: 1500 } } },
          'finance.cashbox.expense_categories.list': { data: { items: [] } },
        },
      );
      expect(body.data).toMatchObject({
        total_expense: 1_500_000,
        non_manual_expense_total: 1_500_000,
        non_manual_expense_count: 1500,
        by_category_complete: true,
        non_manual_by_source_complete: false,
      });
      expect(body.truncated).toBe(true);
    });

    it('F3/F7: tavsif va total_expense_scope — total_expense qo‘lda xarajatni HAM o‘z ichiga oladi (qayta qo‘shilmaydi)', async () => {
      const tool = assistantToolDefinitions(['superadmin']).find(
        (t) => t.name === 'get_expenses_by_category',
      )!;
      // «qo'lda xarajat EMAS» — total_expense dan qo'lda xarajat chiqarilgan
      // deb o'qilardi (model qo'lda xarajatni ikki marta qo'shardi).
      expect(tool.description).not.toMatch(/qo'lda xarajat EMAS/);
      expect(tool.description).toMatch(/qo'lda xarajatlar HAM/);
      expect(tool.description).toContain(
        'total_expense = manual_expense_total + non_manual_expense_total',
      );
      const { body } = await run(
        'get_expenses_by_category',
        {},
        {
          'finance.cashbox.expense_categories.list': { data: { items: [] } },
        },
      );
      expect(body.data.total_expense_scope).toContain('BARCHA');
      // Butun yetib boradi (sanitizeForModel 160 belgidan keyin kesadi).
      expect(body.data.total_expense_scope).toMatch(
        /\(= manual_expense_total \+ non_manual_expense_total\)$/,
      );
    });
  });

  describe('D6 — musbat va manfiy balanslar alohida ro‘yxatlarda', () => {
    const cashbox = (userId: number, balance: number, name: string) => ({
      id: String(userId),
      user_id: String(userId),
      balance,
      balance_cash: balance,
      balance_card: 0,
      user: {
        id: String(userId),
        name,
        phone_number: '+998901234567',
        region_id: '3',
      },
    });

    it('kuryerlar: 20 ta katta manfiy eng katta musbatlarni siqib chiqarmaydi', async () => {
      // finance tartibi: |balans| bo'yicha kamayish.
      const negatives = Array.from({ length: 20 }, (_, i) =>
        cashbox(200 + i, -1_000_000 - i * 1000, `Manfiy ${i + 1}`),
      ).reverse();
      const positives = [
        cashbox(101, 30_000, 'Ali'),
        cashbox(102, 90_000, 'Vali'),
        cashbox(103, 60_000, 'Soli'),
      ];
      const list = [...negatives, ...positives];
      const net = list.reduce((s, r) => s + r.balance, 0);
      const { body, exec } = await run(
        'get_courier_debts',
        {},
        {
          'finance.cashbox.financial_balance': {
            data: {
              couriers: {
                allCourierCashboxes: list,
                couriersTotalBalanse: net,
                nonZeroCount: 23,
                truncated: false,
              },
            },
          },
        },
      );
      expect(exec.result.content).not.toContain('901234567');
      expect(body.data).toMatchObject({
        couriers_total_balance: net,
        non_zero_count: 23,
        positive_count: 3,
        positive_total: 180_000,
        negative_count: 20,
        lists_complete: true,
      });
      expect(body.data.negative_total).toBe(net - 180_000);
      expect(body.data.top_positive.map((r: any) => r.name)).toEqual([
        'Vali',
        'Soli',
        'Ali',
      ]);
      expect(body.data.top_positive[0]).toEqual({
        courier_id: '102',
        name: 'Vali',
        region_id: '3',
        balance: 90_000,
        balance_cash: 90_000,
        balance_card: 0,
      });
      expect(body.data.top_negative).toHaveLength(15);
      // Eng manfiysi birinchi (o'sish tartibi).
      expect(body.data.top_negative[0].balance).toBe(-1_019_000);
      expect(body.data.top_negative[14].balance).toBe(-1_005_000);
      expect(body.data).not.toHaveProperty('top');
      expect(body.truncated).toBe(true);
    });

    it('marketlar: sof (imzoli) va faqat musbat jami alohida, nomlari bilan', async () => {
      const list = [
        cashbox(301, -500_000, 'Qarzdor market'),
        cashbox(302, 1_000_000, 'Katta market'),
        cashbox(303, 200_000, 'Kichik market'),
      ];
      const { body } = await run(
        'get_market_payables',
        {},
        {
          'finance.cashbox.financial_balance': {
            data: {
              markets: {
                marketPayable: 700_000,
                allMarketCashboxes: list,
                nonZeroCount: 3,
                truncated: false,
              },
            },
          },
        },
      );
      expect(body.data).toMatchObject({
        market_payable_net: 700_000,
        market_payable_positive_only: 1_200_000,
        markets_owe_us_total: 500_000,
        non_zero_count: 3,
        positive_count: 2,
        negative_count: 1,
        lists_complete: true,
        top_positive: [
          { market_id: '302', name: 'Katta market', balance: 1_000_000 },
          { market_id: '303', name: 'Kichik market', balance: 200_000 },
        ],
        top_negative: [
          { market_id: '301', name: 'Qarzdor market', balance: -500_000 },
        ],
      });
      expect(body.data).not.toHaveProperty('market_payable_total');
      expect(body.truncated).toBe(false);
    });

    it('marketlar: finance ro‘yxati kesilgan (truncated) — faqat musbat jami null, sof jami aniq', async () => {
      const { body } = await run(
        'get_market_payables',
        {},
        {
          'finance.cashbox.financial_balance': {
            data: {
              markets: {
                marketPayable: 700_000,
                allMarketCashboxes: [cashbox(302, 1_000_000, 'Katta market')],
                nonZeroCount: 900,
                truncated: true,
              },
            },
          },
        },
      );
      expect(body.data).toMatchObject({
        market_payable_net: 700_000,
        market_payable_positive_only: null,
        markets_owe_us_total: null,
        positive_count: null,
        negative_count: null,
        lists_complete: false,
      });
      expect(body.truncated).toBe(true);
    });

    // F2/F15 — finance ro'yxat so'rovi yiqilsa `{items: [], nonZeroCount: 0,
    // truncated: false}` qaytaradi, jami esa alohida SUM'dan keladi: bo'sh
    // ro'yxat aniq nol deb ko'rsatilmasin.
    it('F2/F15 marketlar: ro‘yxat yiqilgan (bo‘sh, sof jami ≠ 0) — musbat/manfiy null, lists_complete=false', async () => {
      const { body } = await run(
        'get_market_payables',
        {},
        {
          'finance.cashbox.financial_balance': {
            data: {
              markets: {
                marketPayable: 5_000_000,
                allMarketCashboxes: [],
                nonZeroCount: 0,
                truncated: false,
              },
            },
          },
        },
      );
      expect(body.data).toMatchObject({
        market_payable_net: 5_000_000,
        market_payable_positive_only: null,
        markets_owe_us_total: null,
        non_zero_count: null,
        positive_count: null,
        negative_count: null,
        lists_complete: false,
        top_positive: [],
        top_negative: [],
      });
      expect(body.truncated).toBe(true);
    });

    it('F2/F15 kuryerlar: ro‘yxat yiqilgan (bo‘sh, sof jami ≠ 0) — positive_total/negative_total null', async () => {
      const { body } = await run(
        'get_courier_debts',
        {},
        {
          'finance.cashbox.financial_balance': {
            data: {
              couriers: {
                couriersTotalBalanse: 700_000,
                allCourierCashboxes: [],
                nonZeroCount: 0,
                truncated: false,
              },
            },
          },
        },
      );
      expect(body.data).toMatchObject({
        couriers_total_balance: 700_000,
        non_zero_count: null,
        positive_count: null,
        positive_total: null,
        negative_count: null,
        negative_total: null,
        lists_complete: false,
      });
      expect(body.truncated).toBe(true);
      expect(body.records).toBe(0);
    });

    it('F15: bo‘sh ro‘yxat va sof jami 0 — haqiqatan qoldiq yo‘q, nollar aniq (lists_complete=true)', async () => {
      const markets = await run(
        'get_market_payables',
        {},
        {
          'finance.cashbox.financial_balance': {
            data: {
              markets: {
                marketPayable: 0,
                allMarketCashboxes: [],
                nonZeroCount: 0,
                truncated: false,
              },
            },
          },
        },
      );
      expect(markets.body.data).toMatchObject({
        market_payable_net: 0,
        market_payable_positive_only: 0,
        markets_owe_us_total: 0,
        non_zero_count: 0,
        lists_complete: true,
      });
      expect(markets.body.truncated).toBe(false);
      const couriers = await run(
        'get_courier_debts',
        {},
        {
          'finance.cashbox.financial_balance': {
            data: {
              couriers: {
                couriersTotalBalanse: 0,
                allCourierCashboxes: [],
                nonZeroCount: 0,
                truncated: false,
              },
            },
          },
        },
      );
      expect(couriers.body.data).toMatchObject({
        couriers_total_balance: 0,
        non_zero_count: 0,
        positive_total: 0,
        negative_total: 0,
        lists_complete: true,
      });
    });

    it('F16 kuryerlar: finance ro‘yxati kesilgan — musbat/manfiy soni va jami null, lists_complete=false', async () => {
      const { body } = await run(
        'get_courier_debts',
        {},
        {
          'finance.cashbox.financial_balance': {
            data: {
              couriers: {
                allCourierCashboxes: [
                  cashbox(1, 50_000, 'A'),
                  cashbox(2, -20_000, 'B'),
                ],
                couriersTotalBalanse: 999_000,
                nonZeroCount: 600,
                truncated: true,
              },
            },
          },
        },
      );
      expect(body.data).toMatchObject({
        couriers_total_balance: 999_000,
        non_zero_count: 600,
        positive_count: null,
        positive_total: null,
        negative_count: null,
        negative_total: null,
        lists_complete: false,
      });
      expect(body.truncated).toBe(true);
    });

    it('F16 kuryerlar: truncated=false, lekin ro‘yxat nonZeroCount dan qisqa — lists_complete=false', async () => {
      const { body } = await run(
        'get_courier_debts',
        {},
        {
          'finance.cashbox.financial_balance': {
            data: {
              couriers: {
                allCourierCashboxes: [cashbox(1, 50_000, 'A')],
                couriersTotalBalanse: 30_000,
                nonZeroCount: 2,
                truncated: false,
              },
            },
          },
        },
      );
      expect(body.data).toMatchObject({
        non_zero_count: 2,
        positive_total: null,
        lists_complete: false,
      });
      expect(body.truncated).toBe(true);
    });

    it("filiallar: HQ'ga qarzdor (musbat) va HQ qarzdor (manfiy) alohida, olinishi_kerak — faqat > 0", async () => {
      const { body } = await run(
        'get_branch_settlements',
        {},
        {
          'finance.cashbox.financial_balance': {
            data: {
              branches: {
                branchReceivable: 150_000,
                branchCashboxTotal: 90_000,
                items: [
                  { branch_id: '11', amount: -900_000 },
                  { branch_id: '12', amount: 50_000 },
                  { branch_id: '13', amount: 1_000_000 },
                ],
                cashExceedingPayable: [],
              },
            },
          },
          'branch.find_all': {
            data: {
              items: [
                {
                  id: '11',
                  name: 'Urgut',
                  type: 'REGIONAL',
                  olinishi_kerak: 0,
                },
                {
                  id: '12',
                  name: 'Samarqand',
                  type: 'REGIONAL',
                  olinishi_kerak: 50_000,
                },
                {
                  id: '13',
                  name: 'Buxoro',
                  type: 'REGIONAL',
                  olinishi_kerak: 1_000_000,
                },
              ],
            },
          },
        },
      );
      expect(body.data).toMatchObject({
        branch_receivable_total: 150_000,
        receivable_positive_count: 2,
        receivable_positive_total: 1_050_000,
        receivable_negative_count: 1,
        receivable_negative_total: -900_000,
        receivable_positive: [
          { branch_id: '13', name: 'Buxoro', amount: 1_000_000 },
          { branch_id: '12', name: 'Samarqand', amount: 50_000 },
        ],
        receivable_negative: [
          { branch_id: '11', name: 'Urgut', amount: -900_000 },
        ],
        olinishi_kerak_count: 2,
      });
      expect(
        body.data.olinishi_kerak_by_branch.map((b: any) => b.branch_id),
      ).toEqual(['13', '12']);
      expect(body.data).not.toHaveProperty('receivable_by_branch');
    });
  });

  describe('D7 — get_shift_summaries: auto_closed = close_reason «auto»', () => {
    it('NULL close_reason — eski smena, avto EMAS; ochiq smena sanalmaydi', async () => {
      const { body } = await run(
        'get_shift_summaries',
        { from: '2026-10-20', to: '2026-10-26' },
        {
          'finance.shift.find_all': {
            data: {
              items: [
                { id: '1', status: 'closed', close_reason: 'auto' },
                { id: '2', status: 'closed', close_reason: 'auto' },
                { id: '3', status: 'closed', close_reason: 'manual' },
                { id: '4', status: 'closed', close_reason: null },
                { id: '5', status: 'open', close_reason: null },
              ],
              pagination: { total: 5 },
            },
          },
        },
      );
      expect(body.data.shifts).toEqual({ total: 5, open: 1, closed: 4 });
      expect(body.data.auto_closed).toBe(2);
      expect(body.data.closed_without_reason).toBe(1);
    });

    it('qatorlarda close_reason kaliti umuman bo‘lmasa ham — 0 (null emas)', async () => {
      const { body } = await run(
        'get_shift_summaries',
        {},
        {
          'finance.shift.find_all': {
            data: {
              items: [{ id: '1', status: 'closed' }],
              pagination: { total: 1 },
            },
          },
        },
      );
      expect(body.data.auto_closed).toBe(0);
      expect(body.data.closed_without_reason).toBe(1);
    });
  });

  describe('D3 — get_revenue_profit: series[].orders = ordersCount', () => {
    it('bandlardagi ordersCount modelga orders sifatida boradi', async () => {
      const { body } = await run(
        'get_revenue_profit',
        { from: '2026-09-01', to: '2026-10-25', granularity: 'monthly' },
        {
          'analytics.revenue': {
            data: {
              summary: { totalRevenue: 3_000_000, totalOrders: 30 },
              data: [
                {
                  period: 'M:2026-09',
                  label: '09.2026',
                  ordersCount: 12,
                  revenue: 1_000_000,
                  profit: 100_000,
                },
                {
                  period: 'M:2026-10',
                  label: '10.2026',
                  ordersCount: 18,
                  revenue: 2_000_000,
                  profit: 200_000,
                },
              ],
            },
          },
        },
      );
      expect(body.data.series).toEqual([
        { period: '09.2026', revenue: 1_000_000, profit: 100_000, orders: 12 },
        { period: '10.2026', revenue: 2_000_000, profit: 200_000, orders: 18 },
      ]);
    });
  });

  describe('D2 — get_order_flow', () => {
    const dashboard = {
      statusCode: 200,
      data: {
        orders: {
          acceptedCount: 120,
          total: 120,
          soldAndPaid: 80,
          cancelled: 9,
          totalRevenue: 9_000_000,
          profit: 900_000,
          // order-service: epoch ms (Toshkent kuni chegaralari).
          from: Date.parse('2026-11-01T19:00:00.000Z'),
          to: Date.parse('2026-11-08T18:59:59.999Z'),
          applied_range: {
            requested_from: '2026-11-01T19:00:00.000Z',
            requested_to: '2026-11-08T18:59:59.999Z',
            applied_from: '2026-11-01T19:00:00.000Z',
            applied_to: '2026-11-08T18:59:59.999Z',
            clamped: false,
            max_span_days: 366,
          },
        },
        previous: {
          from: '2026-10-25T19:00:00.000Z',
          to: '2026-11-01T18:59:59.999Z',
          acceptedCount: 100,
          soldAndPaid: 70,
          cancelled: 12,
        },
        topMarkets: [
          {
            market_id: '501',
            market_name: 'Gulnora Shop',
            total_orders: 40,
            successful_orders: 39,
            success_rate: 97.5,
          },
          {
            market_id: '502',
            market_name: 'Mega Savdo',
            total_orders: 300,
            successful_orders: 270,
            success_rate: 90,
          },
        ],
        topMarketsMeta: {
          min_orders: 1,
          filtered_out: 0,
          from: '2026-11-01T19:00:00.000Z',
          to: '2026-11-08T18:59:59.999Z',
          period_rule: 'selected_range',
          period_days: null,
        },
        topBranches: [
          {
            branch_id: '13',
            branch_name: 'Urgut (URG)',
            total_orders: 50,
            successful_orders: 45,
            success_rate: 90,
          },
        ],
        topBranchesMeta: null,
      },
    };

    it('reyting qatorida market/filial NOMI va id bor; saralash qoidasi va oyna aytiladi', async () => {
      const { body } = await run(
        'get_order_flow',
        { from: '2026-11-02', to: '2026-11-08' },
        { 'analytics.dashboard': dashboard },
        '2026-11-11',
      );
      expect(body.data.top_markets).toEqual([
        {
          market_id: '501',
          name: 'Gulnora Shop',
          total_orders: 40,
          successful_orders: 39,
          success_rate: 97.5,
        },
        {
          market_id: '502',
          name: 'Mega Savdo',
          total_orders: 300,
          successful_orders: 270,
          success_rate: 90,
        },
      ]);
      expect(body.data.top_branches).toEqual([
        {
          branch_id: '13',
          name: 'Urgut (URG)',
          total_orders: 50,
          successful_orders: 45,
          success_rate: 90,
        },
      ]);
      expect(body.data.ranking).toMatchObject({
        window_rule: 'selected_range',
        window_from: '2026-11-02',
        window_to: '2026-11-08',
      });
      expect(body.data.ranking.sorted_by).toContain('success_rate');
    });

    it('previous va orders sanalari — Toshkent YYYY-MM-DD (UTC ISO / epoch emas)', async () => {
      const { body } = await run(
        'get_order_flow',
        { from: '2026-11-02', to: '2026-11-08' },
        { 'analytics.dashboard': dashboard },
        '2026-11-11',
      );
      expect(body.data.previous).toEqual({
        from: '2026-10-26',
        to: '2026-11-01',
        acceptedCount: 100,
        soldAndPaid: 70,
        cancelled: 12,
      });
      expect(body.data.orders).toMatchObject({
        acceptedCount: 120,
        soldAndPaid: 80,
        cancelled: 9,
        from: '2026-11-02',
        to: '2026-11-08',
        applied_range: {
          requested_from: '2026-11-02',
          requested_to: '2026-11-08',
          applied_from: '2026-11-02',
          applied_to: '2026-11-08',
          clamped: false,
        },
      });
    });

    it('bitta kun so‘ralsa reyting oynasi (oxirgi 30 kun) modelga ko‘rinadi', async () => {
      const { body } = await run(
        'get_order_flow',
        { from: '2026-10-26', to: '2026-10-26' },
        {
          'analytics.dashboard': {
            data: {
              ...dashboard.data,
              topMarketsMeta: {
                ...dashboard.data.topMarketsMeta,
                from: '2026-09-26T19:00:00.000Z',
                to: '2026-10-26T18:59:59.999Z',
                period_rule: 'last_30_days',
                period_days: 30,
              },
            },
          },
        },
      );
      expect(body.data.ranking).toMatchObject({
        window_rule: 'last_30_days',
        window_from: '2026-09-27',
        window_to: '2026-10-26',
      });
    });

    it('tavsif «yo‘ldagi buyurtmalar» ni va‘da qilmaydi — ma’lumot YO‘Qligini aytadi', () => {
      const tool = assistantToolDefinitions(['superadmin']).find(
        (t) => t.name === 'get_order_flow',
      )!;
      expect(tool.description).not.toMatch(
        /qilingan, yo'ldagi buyurtmalar|yo'ldagi buyurtmalar, daromad/,
      );
      expect(tool.description).toMatch(
        /yo'ldagi buyurtmalar soni bu tool'da YO'Q/,
      );
      expect(tool.description).toMatch(/success_rate/);
    });
  });
});
