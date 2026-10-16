/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { throwError } from 'rxjs';
import { Roles } from '@app/common';
import { IdentityController } from './identity.controller';
import {
  CHANGEABLE_ROLES,
  ROLE_CATALOG,
  roleCatalogEntry,
} from './roles/role-catalog';
import { createRoleWorld } from '../test/identity-role-world';

/**
 * K3scaE0W — rolni o'zgartirish (PATCH /users/:id/role → identity
 * changeUserRole) va rol katalogi (GET /roles → getRoleCatalog).
 */
const SUPERADMIN = { id: '1', roles: ['superadmin'] };
const ADMIN = { id: '2', roles: ['admin'] };

const seed = () =>
  createRoleWorld([
    { id: '1', name: 'Super', role: Roles.SUPERADMIN },
    { id: '2', name: 'Admin', role: Roles.ADMIN },
    { id: '10', name: "Ro'yxatchi", role: Roles.REGISTRATOR },
    {
      id: '11',
      name: 'Menejer',
      role: Roles.MANAGER,
      can_sell_cancel: true,
      can_add_extra_cost: true,
      tariff_home: 20000,
      tariff_center: 15000,
    },
    { id: '12', name: 'Logist', role: Roles.LOGIST },
    { id: '13', name: 'Kuryer', role: Roles.COURIER },
    { id: '14', name: 'Market', role: Roles.MARKET },
    { id: '15', name: 'Investor', role: Roles.INVESTOR },
    { id: '16', name: 'Operator', role: Roles.OPERATOR },
    { id: '17', name: "O'chirilgan", role: Roles.ADMIN, isDeleted: true },
  ]);

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode?: number;
      message?: string;
    };
  }
  throw new Error('RpcException kutilgandi');
}

describe('K3scaE0W — changeUserRole', () => {
  it("⭐ superadmin: ro'yxatchi → menejer — 200, rol saqlanadi, sessiya yopiladi", async () => {
    const w = seed();

    const res: any = await w.service.changeUserRole(
      '10',
      'manager',
      SUPERADMIN,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({ id: '10', role: Roles.MANAGER });
    expect(res.data).not.toHaveProperty('password');
    expect(w.rows.find((r) => r.id === '10')).toMatchObject({
      role: Roles.MANAGER,
      refresh_token: null,
    });
  });

  it("⭐ activity_log: old_value.role va new_value.role yoziladi (kim o'zgartirgani bilan)", async () => {
    const w = seed();

    await w.service.changeUserRole('10', 'manager', SUPERADMIN);

    expect(w.activityLog.log).toHaveBeenCalledTimes(1);
    const entry = w.activityLog.log.mock.calls[0][0];
    expect(entry).toMatchObject({
      entity_type: 'User',
      entity_id: '10',
      action: 'updated',
      old_value: expect.objectContaining({ role: 'registrator' }),
      new_value: expect.objectContaining({ role: 'manager' }),
      metadata: expect.objectContaining({ change: 'role' }),
      user_id: '1',
    });
  });

  it("⭐ admin (va requester'siz chaqiruv) — 403, hech narsa yozilmaydi", async () => {
    for (const requester of [ADMIN, undefined]) {
      const w = seed();
      const err = await rpcError(
        w.service.changeUserRole('10', 'manager', requester as never),
      );
      expect(err.statusCode).toBe(403);
      expect(w.users.save).not.toHaveBeenCalled();
      expect(w.activityLog.log).not.toHaveBeenCalled();
    }
  });

  it('menejer → admin: faqat menejerga xos maydonlar tozalanadi (sell/cancel, xarajat, tarif)', async () => {
    const w = seed();

    await w.service.changeUserRole('11', 'admin', SUPERADMIN);

    expect(w.rows.find((r) => r.id === '11')).toMatchObject({
      role: Roles.ADMIN,
      can_sell_cancel: false,
      can_add_extra_cost: false,
      tariff_home: null,
      tariff_center: null,
    });
    const entry = w.activityLog.log.mock.calls[0][0];
    expect(entry.old_value).toMatchObject({
      role: 'manager',
      can_sell_cancel: true,
      tariff_home: 20000,
    });
  });

  it.each([
    ['kuryer (manba)', '13', 'admin'],
    ['market (manba)', '14', 'admin'],
    ['investor (manba)', '15', 'registrator'],
    ['operator (manba)', '16', 'admin'],
    ['superadmin (manba)', '1', 'admin'],
    ['nishon kuryer', '10', 'courier'],
    ['nishon superadmin', '10', 'superadmin'],
    ['nishon market', '10', 'market'],
    ["noma'lum rol", '10', 'boss'],
    ["o'sha rol", '10', 'registrator'],
  ])("%s — 400, yozuv yo'q", async (_label, id, role) => {
    const w = seed();
    const err = await rpcError(w.service.changeUserRole(id, role, SUPERADMIN));
    expect(err.statusCode).toBe(400);
    expect(w.users.save).not.toHaveBeenCalled();
  });

  it("o'chirilgan / yo'q foydalanuvchi — 404", async () => {
    const w = seed();
    for (const id of ['17', '999', 'abc']) {
      const err = await rpcError(
        w.service.changeUserRole(id, 'admin', SUPERADMIN),
      );
      expect(err.statusCode).toBe(404);
    }
  });

  it("⭐ filialga biriktirilgan — 409 (avval filialdan chiqarish), rol o'zgarmaydi", async () => {
    const w = seed();
    w.branchAssignments.set('10', {
      branch_id: '7',
      role: 'REGISTRATOR',
      branch: { name: 'Andijon' },
    });

    const err = await rpcError(
      w.service.changeUserRole('10', 'manager', SUPERADMIN),
    );

    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('Andijon');
    expect(err.message).toContain('/branches/7/users/10');
    expect(w.rows.find((r) => r.id === '10')?.role).toBe(Roles.REGISTRATOR);
  });

  it("filial biriktiruvini tekshirib bo'lmasa — 503 (fail-closed)", async () => {
    const w = seed();
    w.branchSend.mockImplementation(() =>
      throwError(() => new Error('branch down')),
    );

    const err = await rpcError(
      w.service.changeUserRole('10', 'manager', SUPERADMIN),
    );

    expect(err.statusCode).toBe(503);
    expect(w.users.save).not.toHaveBeenCalled();
  });

  it("logist → ro'yxatchi: viloyatlari bo'shatiladi; bo'shatib bo'lmasa 503 va rol o'zgarmaydi", async () => {
    const ok = seed();
    await ok.service.changeUserRole('12', 'registrator', SUPERADMIN);
    expect(ok.logisticsSend).toHaveBeenCalledWith(
      { cmd: 'logistics.region.clear_logist' },
      expect.objectContaining({ logist_id: '12' }),
    );
    expect(ok.rows.find((r) => r.id === '12')?.role).toBe(Roles.REGISTRATOR);

    const fail = seed();
    fail.logisticsSend.mockImplementation(() =>
      throwError(() => new Error('logistics down')),
    );
    const err = await rpcError(
      fail.service.changeUserRole('12', 'registrator', SUPERADMIN),
    );
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain("rol o'zgartirilmadi");
    expect(fail.rows.find((r) => r.id === '12')?.role).toBe(Roles.LOGIST);
  });

  it("o'z rolini o'zgartira olmaydi", async () => {
    const w = seed();
    w.rows.push({ id: '30', role: Roles.ADMIN, isDeleted: false });
    const err = await rpcError(
      w.service.changeUserRole('30', 'registrator', {
        id: '30',
        roles: ['superadmin'],
      }),
    );
    expect(err.statusCode).toBe(400);
  });
});

describe('K3scaE0W — rol katalogi (GET /roles)', () => {
  it("⭐ katalog Roles enum'ining HAR bir qiymatini qamraydi (branch, investor, market_operator ham)", () => {
    const catalogRoles = ROLE_CATALOG.map((item) => item.role).sort();
    expect(catalogRoles).toEqual(Object.values(Roles).sort());
    for (const role of [Roles.BRANCH, Roles.INVESTOR, Roles.MARKET_OPERATOR]) {
      expect(roleCatalogEntry(role)).toMatchObject({ filterable: true });
    }
  });

  it("almashtiriladigan rollar — faqat pul bog'lanmagan xodimlar", () => {
    expect([...CHANGEABLE_ROLES].sort()).toEqual(
      [Roles.ADMIN, Roles.LOGIST, Roles.MANAGER, Roles.REGISTRATOR].sort(),
    );
  });

  it('getRoleCatalog javobi: items (label, create_endpoint) + changeable_roles', () => {
    const w = seed();
    const res: any = w.service.getRoleCatalog();
    expect(res.statusCode).toBe(200);
    expect(res.data.items).toHaveLength(Object.values(Roles).length);
    expect(
      res.data.items.find((item: any) => item.role === 'registrator'),
    ).toMatchObject({
      label: "Ro'yxatchi",
      creatable: true,
      create_endpoint: 'POST /registrators',
      changeable: true,
    });
    expect(
      res.data.items.find((item: any) => item.role === 'superadmin'),
    ).toMatchObject({ creatable: false, changeable: false });
    expect(res.data.changeable_roles).toEqual([...CHANGEABLE_ROLES]);
  });
});

describe('identity controller naqshlari (K3scaE0W, o2j9uDtT)', () => {
  const handler = (name: string) =>
    Object.getOwnPropertyDescriptor(IdentityController.prototype, name)
      ?.value as (...args: unknown[]) => Promise<unknown>;
  const executeAndAck = jest.fn(
    (_ctx: RmqContext, fn: () => Promise<unknown>) => fn(),
  );

  it.each([
    ['changeUserRole', 'identity.user.change_role'],
    ['getRoleCatalog', 'identity.role.catalog'],
    ['getCourierRegionCounts', 'identity.courier.region_counts'],
  ])('%s → %s', (name, cmd) => {
    expect(Reflect.getMetadata(PATTERN_METADATA, handler(name))).toEqual([
      { cmd },
    ]);
  });

  it('change_role: (id, role, requester) servisga uzatiladi', async () => {
    const userService = { changeUserRole: jest.fn().mockResolvedValue('ok') };
    await handler('changeUserRole').call(
      { executeAndAck, userService },
      { id: '10', role: 'manager', requester: SUPERADMIN },
      {},
    );
    expect(userService.changeUserRole).toHaveBeenCalledWith(
      '10',
      'manager',
      SUPERADMIN,
    );
  });

  it('region_counts: region_ids servisga uzatiladi', async () => {
    const userService = {
      countCouriersByRegion: jest.fn().mockResolvedValue('ok'),
    };
    await handler('getCourierRegionCounts').call(
      { executeAndAck, userService },
      { region_ids: ['3', '6'] },
      {},
    );
    expect(userService.countCouriersByRegion).toHaveBeenCalledWith(['3', '6']);
  });
});
