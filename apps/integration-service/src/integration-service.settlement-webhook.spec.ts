import { IntegrationServiceService } from './integration-service.service';

/**
 * `settlement.payment` — HQ marketga to'lov qilganda, agar market bir
 * HAMKORNIKI bo'lsa, hamkorga "to'ladim" webhooki outbox orqali yuboriladi.
 * Prototip orqali test (og'ir konstruktorsiz).
 */
function makeSvc(
  over: { marketRefFindOne?: jest.Mock; outboxSave?: jest.Mock } = {},
) {
  const svc: any = Object.create(IntegrationServiceService.prototype);
  svc.partnerMarketRefRepo = {
    findOne:
      over.marketRefFindOne ??
      jest.fn(() =>
        Promise.resolve({ partner_id: '7', elchi_market_id: '121' }),
      ),
  };
  svc.partnerWebhookOutboxRepo = {
    create: jest.fn((x: unknown) => x),
    save:
      over.outboxSave ??
      jest.fn((x: any) => Promise.resolve({ id: 'o1', ...x })),
  };
  svc.processPendingPartnerWebhooks = jest.fn(() => Promise.resolve());
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  return svc as IntegrationServiceService;
}

describe('IntegrationServiceService — enqueueSettlementPayment', () => {
  it('HAMKOR market -> outbox `settlement.payment` qatori yoziladi', async () => {
    const svc: any = makeSvc();
    await svc.enqueueSettlementPayment({
      market_id: '121',
      amount: 1100000,
      paid_at: 1750000000000,
      payment_key: '121:abc',
    });
    const row = svc.partnerWebhookOutboxRepo.save.mock.calls[0][0];
    expect(row.event_type).toBe('settlement.payment');
    expect(row.partner_id).toBe('7');
    expect(row.order_id).toBe('0'); // buyurtma yo'q — sentinel
    expect(row.new_status).toBe('121:abc'); // dedup kaliti
    expect(row.payload.event).toBe('settlement.payment');
    expect(row.payload.payment_id).toBe('121:abc');
    expect(row.payload.amount).toBe(1100000);
    expect(row.payload.paid_at).toBe(1750000000000);
    expect(svc.processPendingPartnerWebhooks).toHaveBeenCalled();
  });

  it('HAMKOR EMAS market -> skipped, outbox TEGILMAYDI (no-op, xato emas)', async () => {
    const svc: any = makeSvc({
      marketRefFindOne: jest.fn(() => Promise.resolve(null)),
    });
    await svc.enqueueSettlementPayment({
      market_id: '999',
      amount: 1000,
      payment_key: 'x',
    });
    expect(svc.partnerWebhookOutboxRepo.save).not.toHaveBeenCalled();
  });

  it('TAKROR (unique violation) -> dedup, YIQILMAYDI', async () => {
    const dupSave = jest.fn(() => {
      const e: any = new Error(
        'duplicate key value violates unique constraint',
      );
      e.code = '23505';
      throw e;
    });
    const svc: any = makeSvc({ outboxSave: dupSave });
    await expect(
      svc.enqueueSettlementPayment({
        market_id: '121',
        amount: 1000,
        payment_key: '121:abc',
      }),
    ).resolves.toBeDefined();
  });

  it('amount <= 0 yoki payment_key yo`q -> skipped (outbox tegilmaydi)', async () => {
    const svc: any = makeSvc();
    await svc.enqueueSettlementPayment({
      market_id: '121',
      amount: 0,
      payment_key: 'x',
    });
    await svc.enqueueSettlementPayment({
      market_id: '121',
      amount: 1000,
      payment_key: '',
    });
    expect(svc.partnerWebhookOutboxRepo.save).not.toHaveBeenCalled();
  });
});
