import { Order_status } from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * T6 — `order.payment_reversal.apply`: to'langan qismni kamaytiradi, holat
 * faqat to'lov qaytarilishi qirralari bilan, hamkorga holat sinxroni
 * YUBORILMAYDI (`suppressExternalSync`). CLOSED — tegilmaydi.
 */
describe('T6 applyPaymentReversal', () => {
  const make = (status: Order_status) => {
    const service = Object.create(
      OrderLifecycleService.prototype,
    ) as OrderLifecycleService;
    const updateFull = jest.fn().mockResolvedValue({});
    Object.assign(service, {
      findById: jest.fn().mockResolvedValue({ id: '5', status }),
      updateFull,
    });
    return { service, updateFull };
  };

  it('⭐ PAID → PARTLY_PAID: updateFull paymentReversal + suppressExternalSync', async () => {
    const { service, updateFull } = make(Order_status.PAID);
    const res = await service.applyPaymentReversal({
      order_id: '5',
      paid_amount: 150_000,
      status: Order_status.PARTLY_PAID,
    });
    expect(updateFull).toHaveBeenCalledWith(
      '5',
      { paid_amount: 150_000, status: Order_status.PARTLY_PAID },
      undefined,
      undefined,
      { paymentReversal: true, suppressExternalSync: true },
    );
    expect(res).toMatchObject({ data: { skipped: false } });
  });

  it('CLOSED — o`zgartirilmaydi; noto`g`ri holat → 400', async () => {
    const { service, updateFull } = make(Order_status.CLOSED);
    const res = await service.applyPaymentReversal({
      order_id: '5',
      paid_amount: 0,
      status: Order_status.SOLD,
    });
    expect(updateFull).not.toHaveBeenCalled();
    expect(res).toMatchObject({ data: { skipped: true } });
    await expect(
      service.applyPaymentReversal({
        order_id: '5',
        paid_amount: 0,
        status: Order_status.PAID,
      }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
  });
});
