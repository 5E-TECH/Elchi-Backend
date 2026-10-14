import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { RpcException } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { IdentityController } from '../identity.controller';
import {
  ALL_CUSTOMERS_CONFIRM_HINT,
  AUDIENCE_RESOLVE_PATTERN,
  CUSTOMER_TARGETING_HINT,
  SEGMENT_WITHOUT_CUSTOMERS_HINT,
  normalizeAudienceInput,
  resolveAudience,
} from './audience-resolver';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  };
});

const errorOf = (
  fn: () => unknown,
): { statusCode?: number; message?: string } => {
  try {
    fn();
  } catch (error) {
    if (error instanceof RpcException) return error.getError() as never;
    throw error;
  }
  throw new Error('expected RpcException');
};

const asyncErrorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) return error.getError() as never;
    throw error;
  }
  throw new Error('expected RpcException');
};

/** Zanjirli QueryBuilder mock — SQL bo'laklarini yig'adi. */
function makeUsersRepo(rows: unknown[] = [], count = 0) {
  const sql: string[] = [];
  const params: Record<string, unknown> = {};
  const makeQb = (): any => {
    const qb: any = {};
    const record = (s: unknown, p?: Record<string, unknown>) => {
      if (typeof s === 'string') sql.push(s);
      else if (s && typeof s === 'object' && 'whereFactory' in s) {
        (s as any).whereFactory(qb);
      }
      Object.assign(params, p ?? {});
      return qb;
    };
    for (const m of ['where', 'andWhere', 'orWhere']) qb[m] = jest.fn(record);
    for (const m of [
      'select',
      'addSelect',
      'orderBy',
      'limit',
      'offset',
      'groupBy',
    ]) {
      qb[m] = jest.fn(() => qb);
    }
    qb.clone = jest.fn(() => qb);
    qb.getRawMany = jest.fn().mockResolvedValue(rows);
    qb.getCount = jest.fn().mockResolvedValue(count);
    return qb;
  };
  const qb = makeQb();
  return {
    repo: { createQueryBuilder: jest.fn(() => qb) } as never,
    qb,
    sql,
    params,
  };
}

describe('W8aerwL6 — identity.audience.resolve qoidalari', () => {
  beforeEach(() => rmqSendMock.mockReset());

  it('TC7: roles:[customer] bayroqsiz — 400 va nima qilish kerakligini aytadi', () => {
    const err = errorOf(() => normalizeAudienceInput({ roles: ['customer'] }));
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe(CUSTOMER_TARGETING_HINT);
    expect(err.message).toContain('include_customers: true');
    expect(err.message).toContain('segment');
  });

  it('TC6: segmentsiz include_customers:true tasdiqsiz — 400', () => {
    const err = errorOf(() =>
      normalizeAudienceInput({ include_customers: true }),
    );
    expect(err).toEqual(
      expect.objectContaining({
        statusCode: 400,
        message: ALL_CUSTOMERS_CONFIRM_HINT,
      }),
    );
    // bo'sh segment ham segment EMAS
    expect(
      errorOf(() =>
        normalizeAudienceInput({
          include_customers: true,
          segment: { region_id: '', market_id: null },
        }),
      ).message,
    ).toBe(ALL_CUSTOMERS_CONFIRM_HINT);
    // aniq tasdiq yoki segment bilan — o'tadi
    expect(
      normalizeAudienceInput({
        include_customers: true,
        confirm_all_customers: true,
      }).includeCustomers,
    ).toBe(true);
    expect(
      normalizeAudienceInput({
        include_customers: true,
        segment: { region_id: 7 },
      }).segment,
    ).toEqual({ region_id: '7' });
  });

  it('segment mijozsiz — 400; noma’lum segment kaliti / noto‘g‘ri id / sana — 400', () => {
    expect(
      errorOf(() =>
        normalizeAudienceInput({
          roles: ['courier'],
          segment: { region_id: '1' },
        }),
      ).message,
    ).toBe(SEGMENT_WITHOUT_CUSTOMERS_HINT);
    for (const segment of [
      { phones: ['+998901234567'] },
      { region_id: '1 OR 1=1' },
      { last_order_from: 'kecha' },
      { min_orders: 0 },
    ]) {
      expect(
        errorOf(() =>
          normalizeAudienceInput({ include_customers: true, segment }),
        ).statusCode,
      ).toBe(400);
    }
  });

  it('noma’lum rol — 400 (Postgres enum xatosi 500 emas); marketing → market', () => {
    expect(
      errorOf(() => normalizeAudienceInput({ roles: ['boss'] })).statusCode,
    ).toBe(400);
    expect(
      normalizeAudienceInput({ roles: ['Marketing', 'SUPERADMIN'] }).staffRoles,
    ).toEqual(['market', 'superadmin']);
  });

  it("bo'sh auditoriya — 400; limit 1000 bilan cheklanadi; after_id tekshiriladi", () => {
    expect(errorOf(() => normalizeAudienceInput({})).statusCode).toBe(400);
    expect(
      normalizeAudienceInput({ roles: ['admin'], limit: 99999 }).limit,
    ).toBe(1000);
    expect(
      errorOf(() =>
        normalizeAudienceInput({ roles: ['admin'], after_id: '1;drop' }),
      ).statusCode,
    ).toBe(400);
  });

  it('TC2: SQL da superadmin/customer CHIQARIB TASHLANMAYDI; roles bo‘yicha IN', async () => {
    const { repo, sql, params } = makeUsersRepo(
      [{ id: 1, role: 'superadmin', language: 'uz', name: 'B', phone: '+998' }],
      1,
    );
    const res = await resolveAudience(repo, {} as never, {
      roles: ['superadmin', 'admin'],
    });
    expect(res.data.items).toEqual([
      {
        id: '1',
        role: 'superadmin',
        language: 'uz',
        phone_valid: false,
        name: 'B',
        phone: '+998',
      },
    ]);
    expect(res.data.total).toBe(1);
    expect(sql.join(' ')).not.toMatch(/superadminRole|<> :superadmin/);
    expect(params.audienceStaffRoles).toEqual(['superadmin', 'admin']);
  });

  it('fields:minimal — ism/telefon javobga qo‘shilmaydi (PII minimal)', async () => {
    const { repo, qb } = makeUsersRepo([
      { id: 5, role: 'courier', language: 'ru', phone_valid: false },
    ]);
    const res = await resolveAudience(repo, {} as never, {
      roles: ['courier'],
      fields: 'minimal',
    });
    expect(res.data.items).toEqual([
      { id: '5', role: 'courier', language: 'ru', phone_valid: false },
    ]);
    const selected = qb.addSelect.mock.calls.map((c: any[]) => c[1]);
    expect(selected).not.toContain('phone');
    expect(selected).not.toContain('name');
  });

  it('segment truncated (>5000) — 400, jimgina kesilmaydi', async () => {
    rmqSendMock.mockResolvedValueOnce({
      data: { items: [{ customer_id: '1' }], truncated: true },
    });
    const { repo } = makeUsersRepo();
    const err = await asyncErrorOf(
      resolveAudience(repo, {} as never, {
        include_customers: true,
        segment: { market_id: '3' },
      }),
    );
    expect(err).toEqual(
      expect.objectContaining({
        statusCode: 400,
        message: expect.stringContaining('5000'),
      }),
    );
  });

  it('order-service ishlamasa — 502 (bo‘sh auditoriya deb jim davom etmaydi)', async () => {
    rmqSendMock.mockRejectedValueOnce(new Error('timeout'));
    const { repo } = makeUsersRepo();
    const err = await asyncErrorOf(
      resolveAudience(repo, {} as never, {
        include_customers: true,
        segment: { region_id: '3' },
      }),
    );
    expect(err.statusCode).toBe(502);
  });

  it('pattern IdentityController da ro‘yxatda va userService.resolveAudience ga delegatsiya qiladi', async () => {
    const handler = (IdentityController.prototype as any).resolveAudience;
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: AUDIENCE_RESOLVE_PATTERN },
    ]);
    expect(AUDIENCE_RESOLVE_PATTERN).toBe('identity.audience.resolve');
    const userService = {
      resolveAudience: jest.fn().mockResolvedValue('ok'),
    };
    const controller = new IdentityController(
      { ack: jest.fn(), nackForError: jest.fn() } as never,
      userService as never,
      {} as never,
      {} as never,
    );
    await expect(
      controller.resolveAudience({ roles: ['admin'] }, {
        getPattern: () => 'x',
      } as never),
    ).resolves.toBe('ok');
    expect(userService.resolveAudience).toHaveBeenCalledWith({
      roles: ['admin'],
    });
  });
});

describe('W8aerwL6 — statik kafolatlar', () => {
  const root = join(__dirname, '..', '..', '..', '..');

  it('TC1: findAllAdmins dagi superadmin/customer rol filtri O‘ZGARMAGAN', () => {
    const source = readFileSync(
      join(root, 'apps/identity-service/src/user-service.service.ts'),
      'utf8',
    );
    const start = source.indexOf('async findAllAdmins(');
    const body = source.slice(start, source.indexOf('async findAllCouriers('));
    expect(body).toContain(".andWhere('admin.role != :superadminRole', {");
    expect(body).toContain('superadminRole: Roles.SUPERADMIN,');
    expect(body).toContain(".andWhere('admin.role != :customerRole', {");
    expect(body).toContain('customerRole: Roles.CUSTOMER,');
  });

  it('TC3: identity.audience.resolve gateway’da HTTP orqali OCHILMAGAN', () => {
    const gatewayDir = join(root, 'apps/api-gateway/src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
          const text = readFileSync(path, 'utf8');
          if (/identity\.audience|audience\.resolve/.test(text)) {
            offenders.push(path);
          }
        }
      }
    };
    walk(gatewayDir);
    expect(offenders).toEqual([]);
  });
});
