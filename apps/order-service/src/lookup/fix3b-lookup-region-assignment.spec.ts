/**
 * fix3b — OrderLookupService ning yangi o'qishlari.
 *
 *   • `resolveRegionIdForDistrict` (LC-13): tumandan viloyat — avval
 *     `assigned_region`, bo'lmasa tumanning o'z `region_id` si; faqat raqam;
 *     aniqlanmasa `null` (qaror chaqiruvchida).
 *   • `getBranchAssignmentByUserStrict`: `getBranchAssignmentByUser` bilan
 *     AYNI so'rov, lekin transport xatosi YUTILMAYDI ("biriktirilmagan" va
 *     "javob bermadi" ajraladi).
 */
import { of, throwError } from 'rxjs';
import { OrderLookupService } from './order-lookup.service';

function makeLookup(opts: { logistics?: jest.Mock; branch?: jest.Mock }) {
  return new OrderLookupService(
    {} as never, // identity
    { send: opts.logistics ?? jest.fn() } as never, // logistics
    {} as never, // finance
    {} as never, // integration
    { send: opts.branch ?? jest.fn() } as never, // branch
  );
}

describe('fix3b — resolveRegionIdForDistrict (LC-13)', () => {
  const districtReply = (data: Record<string, unknown> | null) =>
    jest.fn(() => of({ statusCode: 200, data }));

  it('⭐ assigned_region birinchi (HQ qabuli ham pochtani shu bo`yicha tanlaydi)', async () => {
    const send = districtReply({
      id: '12',
      assigned_region: '7',
      region_id: '5',
    });
    const lookup = makeLookup({ logistics: send });

    await expect(lookup.resolveRegionIdForDistrict('12')).resolves.toBe('7');
    expect(send).toHaveBeenCalledWith(
      { cmd: 'logistics.district.find_by_id' },
      expect.objectContaining({ id: '12' }),
    );
  });

  it.each([
    [{ assignedToRegion: { id: '8' }, region_id: '5' }, '8'],
    [{ assigned_region: null, region_id: '5' }, '5'],
    [{ region: { id: '6' } }, '6'],
    [{ assigned_region: 'Toshkent', region_id: '5' }, '5'],
    [{ assigned_region: 7, region_id: 5 }, '7'],
  ])('tuman %j → %p', async (district, expected) => {
    const lookup = makeLookup({ logistics: districtReply(district) });

    await expect(lookup.resolveRegionIdForDistrict('12')).resolves.toBe(
      expected,
    );
  });

  it('viloyatsiz tuman / bo`sh javob — null', async () => {
    await expect(
      makeLookup({
        logistics: districtReply({ id: '12' }),
      }).resolveRegionIdForDistrict('12'),
    ).resolves.toBeNull();
    await expect(
      makeLookup({ logistics: districtReply(null) }).resolveRegionIdForDistrict(
        '12',
      ),
    ).resolves.toBeNull();
  });

  it('logistika xatosi (404 / timeout) — null, xato otilmaydi', async () => {
    const lookup = makeLookup({
      logistics: jest.fn(() =>
        throwError(() => ({ statusCode: 404, message: 'District not found' })),
      ),
    });

    await expect(lookup.resolveRegionIdForDistrict('12')).resolves.toBeNull();
  });

  it('raqam bo`lmagan tuman id — RMQ so`ralmaydi, null', async () => {
    const send = jest.fn();
    const lookup = makeLookup({ logistics: send });

    await expect(lookup.resolveRegionIdForDistrict('abc')).resolves.toBeNull();
    await expect(lookup.resolveRegionIdForDistrict(null)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('fix3b — getBranchAssignmentByUserStrict', () => {
  it('biriktiruvni qaytaradi (tizim so`rovchisi bilan)', async () => {
    const send = jest.fn(() =>
      of({ data: { branch_id: '22', role: 'REGISTRATOR' } }),
    );
    const lookup = makeLookup({ branch: send });

    await expect(
      lookup.getBranchAssignmentByUserStrict('301'),
    ).resolves.toEqual({ branch_id: '22', role: 'REGISTRATOR' });
    expect(send).toHaveBeenCalledWith(
      { cmd: 'branch.user.find_by_user' },
      { user_id: '301', requester: { id: 'system', roles: ['superadmin'] } },
    );
  });

  it('biriktirilmagan — null', async () => {
    const lookup = makeLookup({ branch: jest.fn(() => of({ data: null })) });

    await expect(
      lookup.getBranchAssignmentByUserStrict('301'),
    ).resolves.toBeNull();
  });

  it('⭐ transport xatosi YUTILMAYDI (null EMAS)', async () => {
    const lookup = makeLookup({
      branch: jest.fn(() => throwError(() => new Error('Connection closed'))),
    });

    await expect(lookup.getBranchAssignmentByUserStrict('301')).rejects.toThrow(
      'Connection closed',
    );
  });
});
