import { OrderLifecycleService } from './order-lifecycle.service';

describe('OrderLifecycleService holder recalc (4DeJh3FF)', () => {
  function makeService(order: Record<string, unknown>) {
    const service: any = Object.create(OrderLifecycleService.prototype);
    service.findById = jest.fn().mockResolvedValue(order);
    // resolveHolderFromState ga uzatilgan custody filialini ushlaymiz va
    // keyingi og'ir persist yo'lini ishga tushirmaslik uchun sentinel bilan
    // to'xtatamiz (recalc bloki tranzaksiyadan OLDIN turadi).
    service.resolveHolderFromState = jest
      .fn()
      .mockRejectedValue(new Error('__STOP__'));
    return service;
  }

  // truthy externalManager -> assertCommercial/DeliveryDetails tekshiruvlari
  // (if (!externalManager)) o'tkazib yuboriladi.
  const externalManager = {} as any;

  it("faqat courier_id o'zgarsa mavjud holder_branch_id saqlanadi (HQ ga qaytmaydi)", async () => {
    const order = {
      id: '1',
      branch_id: '1', // stale = HQ
      holder_type: 'BRANCH',
      holder_branch_id: '13',
      holder_courier_id: null,
      courier_id: null,
      status: 'RECEIVED',
    };
    const service = makeService(order);
    await expect(
      service.updateFull(
        '1',
        { courier_id: '174' },
        { id: '9', roles: ['BRANCH'] },
        externalManager,
      ),
    ).rejects.toThrow('__STOP__');
    // RED (patchsiz): ['1','174'] uzatiladi -> holder HQ ga tushadi.
    // GREEN (patch bilan): mavjud holder_branch_id='13' saqlanadi.
    expect(service.resolveHolderFromState).toHaveBeenCalledWith('13', '174');
  });

  it('branch_id aniq uzatilsa yangi filial ustun (dispatch/receivePost buzilmaydi)', async () => {
    const order = {
      id: '2',
      branch_id: '1',
      holder_type: 'HQ',
      holder_branch_id: null,
      holder_courier_id: null,
      courier_id: null,
      status: 'ON_THE_ROAD',
    };
    const service = makeService(order);
    await expect(
      service.updateFull(
        '2',
        { branch_id: '13' },
        { id: '9', roles: ['HQ'] },
        externalManager,
      ),
    ).rejects.toThrow('__STOP__');
    // Regressiya qorovuli: dto.branch_id berilganda merge qilingan '13' ustun.
    expect(service.resolveHolderFromState).toHaveBeenCalledWith('13', null);
  });
});
