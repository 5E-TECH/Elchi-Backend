/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { of } from 'rxjs';
import { UserServiceService } from '../src/user-service.service';

/**
 * TEST UCHUN (K3scaE0W): HAQIQIY UserServiceService xotiradagi `admins`
 * jadvali ustida. Gateway spec'i ham shu orqali identity'ning haqiqiy
 * `changeUserRole` ini chaqiradi. Build'ga kirmaydi (`test` papkasi).
 */
type Row = Record<string, any>;

export function createRoleWorld(seed: Row[]) {
  const rows = seed.map((row) => ({
    isDeleted: false,
    status: 'active',
    can_sell_cancel: false,
    can_add_extra_cost: false,
    tariff_home: null,
    tariff_center: null,
    refresh_token: 'hash',
    ...row,
  }));
  const users = {
    rows,
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        (() => {
          const found = rows.find(
            (r) =>
              String(r.id) === String(where.id) &&
              Boolean(r.isDeleted) === Boolean(where.isDeleted),
          );
          return found ? { ...found } : null;
        })(),
      ),
    ),
    save: jest.fn((row: Row) => {
      const target = rows.find((r) => String(r.id) === String(row.id));
      if (target) Object.assign(target, row);
      return Promise.resolve({ ...row });
    }),
  };
  const branchAssignments = new Map<string, Row | null>();
  const branchSend = jest.fn((pattern: { cmd: string }, payload: any) => {
    if (pattern.cmd === 'branch.user.find_by_user') {
      return of({
        data: branchAssignments.get(String(payload.user_id)) ?? null,
      });
    }
    return of({ data: null });
  });
  const logisticsSend = jest.fn(() => of({ data: { released: 0 } }));
  const searchSend = jest.fn(() => of({}));
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const noop = { send: jest.fn(() => of({})), emit: jest.fn() };
  const service = new UserServiceService(
    users as never,
    { send: searchSend, emit: jest.fn() } as never, // search
    noop as never, // catalog
    noop as never, // order
    { send: logisticsSend } as never, // logistics
    noop as never, // finance
    { send: branchSend } as never, // branch
    { encrypt: jest.fn(), compare: jest.fn() } as never,
    { get: jest.fn() } as never,
    activityLog as never,
  );
  return {
    service,
    rows,
    users,
    branchAssignments,
    branchSend,
    logisticsSend,
    activityLog,
  };
}
