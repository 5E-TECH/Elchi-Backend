import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { ActivityAction } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * FIX3 LC-08 / RBAC-06 — tumanni boshqa hududga biriktirish (assigned_region)
 * HQ intake'dagi hudud pochtasini butun kompaniya bo'yicha o'zgartiradi.
 * Ilgari gateway COURIER va MARKET ga ham ruxsat berardi, logistics esa
 * so'rovchini umuman tekshirmas va kim o'zgartirganini yozmasdi.
 */
type DistrictResponse = {
  statusCode: number;
  data: Record<string, unknown>;
};

describe('FIX3 LC-08 — updateDistrict faqat admin/superadmin, actor log qilinadi', () => {
  function setup(
    overrides: {
      district?: Record<string, unknown>;
      region?: Record<string, unknown>;
    } = {},
  ) {
    const district = {
      id: '12',
      name: 'Chilonzor',
      region_id: '1',
      assigned_region: '1',
      serving_branch_id: null,
      ...overrides.district,
    };
    const districtRepo = {
      findOne: jest.fn().mockResolvedValue({ ...district }),
      save: jest.fn((entity: Record<string, unknown>) =>
        Promise.resolve({ ...entity }),
      ),
    };
    const regionRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue(overrides.region ?? { id: '7', name: 'Namangan' }),
    };
    const activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    };
    const service = new LogisticsServiceService(
      {} as any,
      regionRepo as any,
      districtRepo as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      activityLog as any,
    );
    return { service, districtRepo, activityLog };
  }

  async function expectForbidden(promise: Promise<unknown>) {
    try {
      await promise;
      throw new Error('Expected RpcException');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      expect(
        ((error as RpcException).getError() as { statusCode?: number })
          .statusCode,
      ).toBe(403);
    }
  }

  it.each([
    ['market', { id: '201', roles: ['market'] }],
    ['courier', { id: '179', roles: ['courier'] }],
    ['manager', { id: '198', roles: ['manager'] }],
    ['so‘rovchisiz (eski gateway)', undefined],
  ])('%s — 403, hech narsa saqlanmaydi', async (_label, requester) => {
    const ctx = setup();

    await expectForbidden(
      ctx.service.updateDistrict('12', { assigned_region: '7' }, requester),
    );

    expect(ctx.districtRepo.findOne).not.toHaveBeenCalled();
    expect(ctx.districtRepo.save).not.toHaveBeenCalled();
    expect(ctx.activityLog.logChange).not.toHaveBeenCalled();
  });

  it('superadmin — saqlanadi va logChange ga user_id/user_role yoziladi', async () => {
    const ctx = setup();

    const response = (await ctx.service.updateDistrict(
      '12',
      { assigned_region: '7' },
      { id: '1', roles: ['superadmin'] },
    )) as DistrictResponse;

    expect(response.statusCode).toBe(200);
    expect(ctx.districtRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '12', assigned_region: '7' }),
    );
    expect(response.data.serving_branch_cleared).toBe(false);
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith({
      entity_type: 'District',
      entity_id: '12',
      action: ActivityAction.UPDATED,
      old_value: { assigned_region: '1', serving_branch_id: null },
      new_value: {
        assigned_region: '7',
        serving_branch_id: null,
        serving_branch_cleared: false,
      },
      user_id: '1',
      user_role: 'superadmin',
    });
  });

  /**
   * Tuman ↔ filial qamrovi: xizmat viloyati o'zgarsa eski xizmat filiali
   * (eski viloyatniki) bo'shatiladi — javob va logda `serving_branch_cleared`.
   */
  it('xizmat viloyati o‘zgardi — serving_branch_id NULL, javob/logda serving_branch_cleared: true', async () => {
    const ctx = setup({ district: { serving_branch_id: '30' } });

    const response = (await ctx.service.updateDistrict(
      '12',
      { assigned_region: '7' },
      { id: '1', roles: ['superadmin'] },
    )) as DistrictResponse;

    expect(response.statusCode).toBe(200);
    expect(ctx.districtRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '12',
        assigned_region: '7',
        serving_branch_id: null,
      }),
    );
    expect(response.data).toMatchObject({
      id: '12',
      assigned_region: '7',
      serving_branch_id: null,
      serving_branch_cleared: true,
    });
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: { assigned_region: '1', serving_branch_id: '30' },
        new_value: {
          assigned_region: '7',
          serving_branch_id: null,
          serving_branch_cleared: true,
        },
      }),
    );
  });

  it('assigned_region o‘zgardi, lekin xizmat viloyati o‘sha (region_id) — filial saqlanadi', async () => {
    const ctx = setup({
      district: { assigned_region: null, serving_branch_id: '30' },
      region: { id: '1', name: 'Toshkent' },
    });

    const response = (await ctx.service.updateDistrict(
      '12',
      { assigned_region: '1' },
      { id: '1', roles: ['superadmin'] },
    )) as DistrictResponse;

    expect(ctx.districtRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        assigned_region: '1',
        serving_branch_id: '30',
      }),
    );
    expect(response.data.serving_branch_cleared).toBe(false);
  });
});
