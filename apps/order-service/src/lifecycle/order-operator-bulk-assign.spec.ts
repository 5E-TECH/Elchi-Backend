import { RpcException } from '@nestjs/microservices';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * 2026-11-20 — `order.operator.assign_bulk`: har buyurtma ALOHIDA
 * `assignOperator` bilan (o'sha qulf va tekshiruvlar), bittasi yiqilsa
 * qolganlari davom etadi, natija har id uchun. Id'lar tozalanadi (takror,
 * yaroqsiz), chegaradan oshsa — 400.
 */
describe('OrderLifecycleService.assignOperatorBulk', () => {
  const makeService = () => {
    const service = Object.create(
      OrderLifecycleService.prototype,
    ) as OrderLifecycleService;
    const assign = jest
      .spyOn(service, 'assignOperator')
      .mockImplementation((id: string) => {
        if (id === '2') {
          return Promise.reject(
            new RpcException({
              statusCode: 409,
              code: 'ORDER_OPERATOR_ALREADY_ASSIGNED',
              message: 'Bu buyurtmaga operator allaqachon biriktirilgan',
            }),
          );
        }
        if (id === '3') {
          return Promise.reject(new Error('db down'));
        }
        return Promise.resolve({
          statusCode: 200,
          message: 'success',
          data: {
            id,
            operator_id: '41',
            operator: 'Sevinch',
            earning_recorded: id === '1',
          },
        } as never);
      });
    return { service, assign };
  };
  const INPUT = {
    operator_id: '41',
    operator_name: 'Sevinch',
    market_id: '12',
  };
  const REQUESTER = { id: '12', roles: ['market'], market_id: '12' };

  it('har id alohida; yiqilgani natijada kodi bilan, qolganlari davom etadi', async () => {
    const { service, assign } = makeService();

    const res = (await service.assignOperatorBulk(
      ['1', '2', '3', '4', '1', 'abc', 5],
      INPUT,
      REQUESTER,
    )) as { data: Record<string, unknown> };

    // Takror va yaroqsiz id tushib qoladi; har biri o'sha kirish va so'rovchi bilan.
    expect(assign.mock.calls.map(([id]) => id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    expect(assign).toHaveBeenCalledWith('1', INPUT, REQUESTER);
    expect(res.data).toEqual({
      assigned: 3,
      failed: 2,
      earnings_recorded: 1,
      results: [
        { id: '1', ok: true, earning_recorded: true },
        {
          id: '2',
          ok: false,
          status_code: 409,
          code: 'ORDER_OPERATOR_ALREADY_ASSIGNED',
          message: 'Bu buyurtmaga operator allaqachon biriktirilgan',
        },
        // Kutilmagan xato — ichki matn chiqmaydi.
        {
          id: '3',
          ok: false,
          status_code: 500,
          message: 'Biriktirib bo`lmadi',
        },
        { id: '4', ok: true, earning_recorded: false },
        { id: '5', ok: true, earning_recorded: false },
      ],
    });
  });

  it('bo`sh yoki 500 dan ko`p — 400, hech biri biriktirilmaydi', async () => {
    const { service, assign } = makeService();
    const statusOf = (promise: Promise<unknown>) =>
      promise.then(
        () => 200,
        (error: RpcException) =>
          (error.getError() as { statusCode?: number }).statusCode,
      );

    expect(
      await statusOf(service.assignOperatorBulk([], INPUT, REQUESTER)),
    ).toBe(400);
    expect(
      await statusOf(service.assignOperatorBulk(['abc'], INPUT, REQUESTER)),
    ).toBe(400);
    expect(
      await statusOf(
        service.assignOperatorBulk(
          Array.from({ length: 501 }, (_, i) => String(i + 1)),
          INPUT,
          REQUESTER,
        ),
      ),
    ).toBe(400);
    expect(assign).not.toHaveBeenCalled();
  });
});
