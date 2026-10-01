import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { OrderLookupService } from './order-lookup.service';

/**
 * CODE-05 — HAMKOR (PARTNER) filial ulushi hech qachon yozilmasdi:
 * `resolveBranchShare` `branch.find_by_id` ni requester'siz yuborardi,
 * branch-service 403 'Requester aniqlanmadi' qaytarar, `.catch` esa uni 0 ga
 * aylantirardi. Endi tizim requester'i uzatiladi; xato esa (fix3b) jimgina
 * emas — `logger.error` bilan — 0 bo'ladi (hozir PARTNER filial yo'q).
 */
describe('CODE-05 — OrderLookupService.resolveBranchShare', () => {
  function makeLookup(send: jest.Mock) {
    const branchClient = { send };
    return new OrderLookupService(
      {} as never, // identity
      {} as never, // logistics
      {} as never, // finance
      {} as never, // integration
      branchClient as never,
    );
  }

  const branchReply = (data: Record<string, unknown> | undefined) =>
    jest.fn(() => of({ statusCode: 200, data }));

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('⭐ tizim requester`i (superadmin) bilan so`raydi, request_id qo`shilmaydi', async () => {
    const send = branchReply({ ownership: 'partner', per_order_share: 7000 });
    const lookup = makeLookup(send);

    const share = await lookup.resolveBranchShare('15');

    expect(share).toBe(7000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      { cmd: 'branch.find_by_id' },
      { id: '15', requester: { id: 'system', roles: ['superadmin'] } },
    );
  });

  it.each([
    [{ ownership: 'partner', per_order_share: '7000.50' }, 7000.5],
    [{ ownership: 'owned', per_order_share: 7000 }, 0],
    [{ ownership: 'partner', per_order_share: 0 }, 0],
    [{ ownership: 'partner', per_order_share: -100 }, 0],
    [{ ownership: 'partner', per_order_share: 'abc' }, 0],
    [{ per_order_share: 7000 }, 0],
    [undefined, 0],
  ])('filial %j → ulush %p', async (branch, expected) => {
    const lookup = makeLookup(branchReply(branch));

    await expect(lookup.resolveBranchShare('15')).resolves.toBe(expected);
  });

  it('branchId yo`q (HQ / noma`lum) — 0, so`rov yuborilmaydi', async () => {
    const send = jest.fn();
    const lookup = makeLookup(send);

    await expect(lookup.resolveBranchShare(null)).resolves.toBe(0);
    await expect(lookup.resolveBranchShare('')).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('404 (filial topilmadi / o`chirilgan) — 0, avvalgidek', async () => {
    const send = jest.fn(() =>
      throwError(() => ({ statusCode: 404, message: 'Branch not found' })),
    );
    const lookup = makeLookup(send);

    await expect(lookup.resolveBranchShare('15')).resolves.toBe(0);
  });

  /**
   * fix3b (CODE-05, ishga tushirish xavfsizligi): 404 dan boshqa xato endi
   * 503 EMAS — baland ovozda `logger.error` va 0. Hozir HAMKOR filial yo'q
   * va ownership/per_order_share ni o'rnatib bo'lmaydi, ya'ni har bir filial
   * uchun to'g'ri ulush baribir 0; 503 esa har bir filial sotuvini
   * branch-service'ga bog'lab qo'yardi.
   */
  it('⭐ transport xatosi — 503 EMAS: logger.error (filial + xato bilan) va 0', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const lookup = makeLookup(
      jest.fn(() => throwError(() => new Error('Connection closed'))),
    );

    await expect(lookup.resolveBranchShare('15')).resolves.toBe(0);

    expect(error).toHaveBeenCalledTimes(1);
    const [message] = error.mock.calls[0] as [string];
    expect(message).toContain('branch=15');
    expect(message).toContain('Connection closed');
  });

  it('branch-service 500 qaytarsa ham — logger.error va 0 (RpcException otilmaydi)', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const lookup = makeLookup(
      jest.fn(() =>
        throwError(() => ({ statusCode: 500, message: 'Internal error' })),
      ),
    );

    await expect(lookup.resolveBranchShare('15')).resolves.toBe(0);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('status=500');
  });

  it('404 da logger.error YOZILMAYDI (oddiy "noma`lum filial")', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const lookup = makeLookup(
      jest.fn(() =>
        throwError(() => ({ statusCode: 404, message: 'Branch not found' })),
      ),
    );

    await expect(lookup.resolveBranchShare('15')).resolves.toBe(0);
    expect(error).not.toHaveBeenCalled();
  });
});
