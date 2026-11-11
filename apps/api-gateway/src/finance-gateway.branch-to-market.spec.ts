import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import { FinanceGatewayController } from './finance-gateway.controller';

/**
 * (2026-11-11, Dilshod) `POST finance/cashbox/payment/branch-to-main` —
 * «Marketga o'tkazma» (`payment_method: click_to_market` + `market_id`):
 * filial pulni HQ'ga bermay, to'g'ridan-to'g'ri marketga o'tkazgan.
 *  • market majburiy, chek (RECEIPT_NOT_APPLICABLE) va karta yo'q — 400,
 *    finance'ga bormaydi;
 *  • boshqa usulda `market_id` — 400;
 *  • faqat superadmin/admin (menejer — 403);
 *  • finance'ga `market_id` boradi, oddiy to'lovga — bormaydi.
 */
describe('branch-to-main — «Marketga o`tkazma» (gateway)', () => {
  const make = () => {
    const finance = {
      send: jest.fn(() => of({ statusCode: 200, data: { transfer_id: 't' } })),
    };
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
  const body = (extra: Record<string, unknown> = {}) =>
    ({
      branch_id: '13',
      amount: 250_000,
      payment_method: 'click_to_market',
      market_id: '201',
      ...extra,
    }) as never;

  it.each([['superadmin'], ['admin']])(
    '⭐ %s — finance`ga market_id bilan, chek siyosati bilan',
    async (role) => {
      const { controller, finance } = make();
      await controller.paymentBranchToMain(
        user([role]),
        body({ comment: 'Click' }),
        'idem-b2m-1',
      );
      expect(finance.send).toHaveBeenCalledTimes(1);
      expect(lastPayload(finance)).toMatchObject({
        branch_id: '13',
        amount: 250_000,
        payment_method: 'click_to_market',
        market_id: '201',
        dedup_epoch: 'idem-b2m-1',
        created_by: '9',
        receipt_policy: { kind: 'branch_to_hq' },
      });
      expect(lastPayload(finance)).not.toHaveProperty('card_id');
      expect(lastPayload(finance)).not.toHaveProperty('branch_card_id');
    },
  );

  it.each([
    ['market_id yo`q', { market_id: undefined }],
    ['market_id bo`sh', { market_id: '  ' }],
    ['karta (card_id)', { card_id: '3' }],
    ['filial kartasi (branch_card_id)', { branch_card_id: '7' }],
  ])('%s → 400, finance`ga bormaydi', async (_label, extra) => {
    const { controller, finance } = make();
    await expect(
      controller.paymentBranchToMain(user(['superadmin']), body(extra)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('⭐ chek → 400 RECEIPT_NOT_APPLICABLE, finance`ga bormaydi', async () => {
    const { controller, finance } = make();
    const error = await controller
      .paymentBranchToMain(user(['admin']), body({ receipt_id: '41' }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      code: 'RECEIPT_NOT_APPLICABLE',
    });
    expect(finance.send).not.toHaveBeenCalled();
  });

  it.each([['cash'], ['click']])(
    '%s + market_id → 400 (jimgina e`tiborsiz qolmaydi)',
    async (method) => {
      const { controller, finance } = make();
      await expect(
        controller.paymentBranchToMain(
          user(['superadmin']),
          body({ payment_method: method }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(finance.send).not.toHaveBeenCalled();
    },
  );

  it('oddiy naqd — market_id finance`ga ketmaydi (avvalgidek)', async () => {
    const { controller, finance } = make();
    await controller.paymentBranchToMain(
      user(['superadmin']),
      body({ payment_method: 'cash', market_id: undefined }),
    );
    expect(lastPayload(finance)).toMatchObject({ payment_method: 'cash' });
    expect(lastPayload(finance)).not.toHaveProperty('market_id');
  });

  it('menejer → 403 (filial pulini HQ`ga o`zi o`tkazmaydi, ega qarori #7)', async () => {
    const { controller, finance } = make();
    await expect(
      controller.paymentBranchToMain(
        user(['manager'], { branch_id: '13' }),
        body(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(finance.send).not.toHaveBeenCalled();
  });
});
