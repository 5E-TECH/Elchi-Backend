import {
  districtServingBranchId,
  effectiveDistrictRegionId,
  effectiveOrderRegionId,
  isHqBranch,
  isOrderServedByBranch,
} from './district-coverage';

describe('district-coverage — buyurtma ↔ filial qamrovi (viloyat qoidasi)', () => {
  // Viloyat 5 da ikki filial (masalan «Samarqand filiali» va «Urgut filiali»),
  // viloyat 6 da — bitta («Buxoro filiali»).
  const branchX = { id: '10', type: 'REGIONAL', region_id: '5' };
  const branchY = { id: '11', type: 'HYBRID', region_id: '5' };
  const branchZ = { id: '20', type: 'REGIONAL', region_id: '6' };
  const hq = { id: '1', type: 'HQ', region_id: null };

  it('xizmat viloyati: assigned_region → assignedToRegion → region_id → region', () => {
    expect(
      effectiveDistrictRegionId({ region_id: '3', assigned_region: '5' }),
    ).toBe('5');
    expect(
      effectiveDistrictRegionId({
        region_id: '3',
        assignedToRegion: { id: 7 },
      }),
    ).toBe('7');
    expect(
      effectiveDistrictRegionId({ region_id: '3', assigned_region: null }),
    ).toBe('3');
    expect(effectiveDistrictRegionId({ region: { id: '4' } })).toBe('4');
    expect(effectiveDistrictRegionId({ region_id: 'abc' })).toBeNull();
    expect(effectiveDistrictRegionId(null)).toBeNull();
  });

  it('buyurtma xizmat viloyati: tuman qatori bor — tumanniki, yo‘q — buyurtmaniki', () => {
    expect(
      effectiveOrderRegionId({
        district: { region_id: '3', assigned_region: '5' },
        orderRegionId: '3',
      }),
    ).toBe('5');
    expect(effectiveOrderRegionId({ district: null, orderRegionId: 6 })).toBe(
      '6',
    );
    expect(
      effectiveOrderRegionId({ district: null, orderRegionId: '006' }),
    ).toBe('6');
    // Tuman qatori bor-u viloyatsiz — buyurtma viloyatiga tushmaydi.
    expect(
      effectiveOrderRegionId({ district: { id: '1' }, orderRegionId: '5' }),
    ).toBeNull();
    expect(effectiveOrderRegionId({})).toBeNull();
  });

  it('HQ — har doim xizmat qiladi (viloyatsiz HQ ham)', () => {
    expect(isHqBranch(hq)).toBe(true);
    expect(isOrderServedByBranch({ district: { region_id: '99' } }, hq)).toBe(
      true,
    );
    expect(isOrderServedByBranch({ district: null }, hq)).toBe(true);
  });

  it('⭐ bir viloyatdagi HAR QANDAY filial xizmat qiladi; boshqa viloyat filiali — yo‘q', () => {
    // Urgut tumani (viloyat 5) buyurtmasi: X va Y (5) — ha, Z (6) — yo'q.
    const urgut = { id: '501', region_id: '5' };
    expect(isOrderServedByBranch({ district: urgut }, branchX)).toBe(true);
    expect(isOrderServedByBranch({ district: urgut }, branchY)).toBe(true);
    expect(isOrderServedByBranch({ district: urgut }, branchZ)).toBe(false);
  });

  it('⭐ serving_branch_id endi HISOBGA OLINMAYDI', () => {
    // Tuman Y ga biriktirilgan bo'lsa ham — viloyatdagi X ham xizmat qiladi.
    const d = { region_id: '5', serving_branch_id: '11' };
    expect(districtServingBranchId(d)).toBe('11');
    expect(isOrderServedByBranch({ district: d }, branchY)).toBe(true);
    expect(isOrderServedByBranch({ district: d }, branchX)).toBe(true);
    // Boshqa viloyat filialiga biriktirilgan bo'lsa ham — o'sha filial emas.
    expect(
      isOrderServedByBranch(
        { district: { region_id: '5', serving_branch_id: '20' } },
        branchZ,
      ),
    ).toBe(false);
  });

  it('tumanning xizmat viloyati (assigned_region) hal qiladi, geografik emas', () => {
    expect(
      isOrderServedByBranch({ district: { region_id: '5' } }, branchX),
    ).toBe(true);
    // Tuman boshqa viloyatga biriktirilgan: geografik 5, xizmat 6 → X (5) emas.
    expect(
      isOrderServedByBranch(
        { district: { region_id: '5', assigned_region: '6' } },
        branchX,
      ),
    ).toBe(false);
    expect(
      isOrderServedByBranch(
        { district: { region_id: '5', assigned_region: '6' } },
        branchZ,
      ),
    ).toBe(true);
    expect(
      isOrderServedByBranch(
        { district: { region_id: '6', assigned_region: '5' } },
        branchX,
      ),
    ).toBe(true);
  });

  it('tumansiz buyurtma — buyurtma viloyati bilan', () => {
    expect(
      isOrderServedByBranch({ district: null, orderRegionId: '5' }, branchX),
    ).toBe(true);
    expect(
      isOrderServedByBranch({ district: null, orderRegionId: 6 }, branchX),
    ).toBe(false);
  });

  it('fail-closed: filial viloyati yo‘q / hech narsa aniqlanmaydi / filial yo‘q', () => {
    const noRegion = { id: '12', type: 'REGIONAL', region_id: null };
    expect(
      isOrderServedByBranch({ district: { region_id: '5' } }, noRegion),
    ).toBe(false);
    expect(isOrderServedByBranch({ district: null }, branchX)).toBe(false);
    expect(isOrderServedByBranch({ district: { region_id: '5' } }, null)).toBe(
      false,
    );
    // ⭐ Viloyatsiz filial: tuman AYNAN unga biriktirilgan bo'lsa ham — yo'q
    // (avval serving_branch_id buni ochardi).
    expect(
      isOrderServedByBranch(
        { district: { region_id: '5', serving_branch_id: '12' } },
        noRegion,
      ),
    ).toBe(false);
    expect(
      isOrderServedByBranch(
        { district: null, orderRegionId: '5' },
        { id: '12', type: 'REGIONAL', region_id: '0' },
      ),
    ).toBe(false);
  });
});
