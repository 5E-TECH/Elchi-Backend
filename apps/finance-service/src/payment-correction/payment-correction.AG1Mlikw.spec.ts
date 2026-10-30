import { RpcException } from '@nestjs/microservices';
import { Source_type } from '@app/common';
import { FinanceServiceService } from '../finance-service.service';

/**
 * AG1Mlikw — `payment_reversal` faqat ichki tur (teskari qatorni FAQAT
 * `PaymentCorrectionService` yozadi). `finance.cashbox.update_balance` RMQ
 * yo'li (gateway DTO'sidan tashqari ham) uni 400 bilan rad etadi — pul va
 * tranzaksiyaga tegmasdan.
 */
describe('AG1Mlikw — updateBalance `payment_reversal` ni rad etadi', () => {
  const createQueryRunner = jest.fn();
  const service = Object.create(
    FinanceServiceService.prototype,
  ) as FinanceServiceService;
  Object.assign(service, { dataSource: { createQueryRunner } });

  beforeEach(() => createQueryRunner.mockReset());

  it('⭐ 400, kassa qulflanmaydi', async () => {
    const error = await service
      .updateBalance({
        cashbox_id: '1',
        amount: 1000,
        operation_type: 'income',
        source_type: Source_type.PAYMENT_REVERSAL,
      } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 400,
    });
    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it('boshqa tur tranzaksiyaga o`tadi', async () => {
    createQueryRunner.mockImplementation(() => {
      throw new Error('tranzaksiyaga yetdi');
    });
    await service
      .updateBalance({
        cashbox_id: '1',
        amount: 1000,
        operation_type: 'income',
        source_type: Source_type.CORRECTION,
      } as never)
      .catch(() => undefined);
    expect(createQueryRunner).toHaveBeenCalledTimes(1);
  });
});
