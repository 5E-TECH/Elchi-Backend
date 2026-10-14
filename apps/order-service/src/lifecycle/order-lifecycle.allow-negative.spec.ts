import { Cashbox_type, Operation_type, Source_type } from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * i75GDixP — sotuv yo'lining kassa oyoqlari finance-service'ga ANIQ
 * `allow_negative: true` bayrog'i bilan boradi. Faqat shu yo'l bayroqni
 * yuboradi: gateway va qo'lda kirim/chiqim doimo `false` — shu bois filial
 * kassasi qo'lda chiqimda manfiyga tushmaydi, sotuv oyog'i esa poison-drop
 * bo'lmaydi.
 */
describe('i75GDixP — order-service outbox: finance.cashbox.update_balance', () => {
  function makeLifecycle() {
    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const lifecycle = Object.create(
      OrderLifecycleService.prototype,
    ) as OrderLifecycleService;
    Object.assign(lifecycle, { outbox });
    return { lifecycle, outbox };
  }

  it('sotuv oyog`i allow_negative:true va payment_method:cash bilan navbatga qo`yiladi', async () => {
    const { lifecycle, outbox } = makeLifecycle();
    const manager = {} as never;

    await (lifecycle as any).updateCashboxBalance(
      {
        user_id: '15',
        cashbox_type: Cashbox_type.BRANCH,
        amount: 300_000,
        operation_type: Operation_type.EXPENSE,
        source_type: Source_type.SELL,
        source_id: '777',
        dedup_epoch: 'ep-1',
      },
      manager,
    );

    expect(outbox.enqueue).toHaveBeenCalledWith(
      'FINANCE',
      'finance.cashbox.update_balance',
      expect.objectContaining({
        user_id: '15',
        cashbox_type: Cashbox_type.BRANCH,
        source_type: Source_type.SELL,
        payment_method: 'cash',
        allow_negative: true,
      }),
      { manager },
    );
  });

  it('0 summa — navbatga hech narsa qo`yilmaydi (avvalgidek)', async () => {
    const { lifecycle, outbox } = makeLifecycle();

    await (lifecycle as any).updateCashboxBalance({
      user_id: '15',
      cashbox_type: Cashbox_type.BRANCH,
      amount: 0,
      operation_type: Operation_type.EXPENSE,
      source_type: Source_type.SELL,
    });

    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
