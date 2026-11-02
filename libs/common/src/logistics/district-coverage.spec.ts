import {
  districtServingBranchId,
  effectiveDistrictRegionId,
  isHqBranch,
  isOrderServedByBranch,
} from './district-coverage';

describe('district-coverage — tuman ↔ filial qamrovi (yagona qoida)', () => {
  const branchX = { id: '10', type: 'REGIONAL', region_id: '5' };
  const branchY = { id: '11', type: 'REGIONAL', region_id: '5' };
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

  it('HQ — har doim xizmat qiladi', () => {
    expect(isHqBranch(hq)).toBe(true);
    expect(isOrderServedByBranch({ district: { region_id: '99' } }, hq)).toBe(
      true,
    );
    expect(isOrderServedByBranch({ district: null }, hq)).toBe(true);
  });

  it('serving_branch_id bo‘lsa — FAQAT o‘sha filial (bir viloyatdagi boshqasi emas)', () => {
    const d = { region_id: '5', serving_branch_id: '11' };
    expect(districtServingBranchId(d)).toBe('11');
    expect(isOrderServedByBranch({ district: d }, branchY)).toBe(true);
    expect(isOrderServedByBranch({ district: d }, branchX)).toBe(false);
  });

  it('serving_branch_id yo‘q — xizmat viloyati filial viloyatiga teng bo‘lsa', () => {
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
    // Lekin filial biriktirilgan tuman viloyatsiz filialda ham ishlaydi.
    expect(
      isOrderServedByBranch(
        { district: { region_id: '5', serving_branch_id: '12' } },
        noRegion,
      ),
    ).toBe(true);
  });
});
