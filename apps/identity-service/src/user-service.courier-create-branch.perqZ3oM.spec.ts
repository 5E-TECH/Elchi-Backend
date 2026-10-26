import { of } from 'rxjs';
import { Cashbox_type } from '@app/common';
import { RequesterContext } from './contracts/user.payloads';
import { UserServiceService } from './user-service.service';

/**
 * perqZ3oM — SA/admin `POST /couriers` HQ bo'lmagan filialga (ega qarori).
 * Filial gateway'da tanlanadi va tekshiriladi; identity saga'si
 * (`identity.courier.create` → `branch.user.assign` → kuryer kassasi)
 * so'rovchidan qat'i nazar BIR XIL — kuryer o'sha filialning COURIER qatori
 * bo'ladi, viloyati filialdan, kassasi kuryerniki (menejer yaratgan kuryer
 * bilan aynan bir xil zanjir: kuryer → filial → HQ).
 */
type Row = Record<string, unknown>;

function makeService() {
  const saves: Row[] = [];
  const repo = {
    findOne: jest.fn(() => Promise.resolve(null)),
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((value: Row) => {
      saves.push({ ...value });
      return Promise.resolve({ ...value, id: '700' });
    }),
  };
  const branchClient = {
    send: jest.fn(() => of({ statusCode: 201, data: {} })),
    emit: jest.fn(),
  };
  const financeClient = {
    send: jest.fn(() => of({ statusCode: 201, data: { id: 'cb-1' } })),
    emit: jest.fn(),
  };
  const logisticsClient = {
    send: jest.fn(() => of({ data: { id: '3', name: 'Andijon' } })),
    emit: jest.fn(),
  };
  const ok = { send: jest.fn(() => of({ statusCode: 201 })), emit: jest.fn() };
  const service = new UserServiceService(
    repo as never,
    ok as never, // search
    ok as never, // catalog
    ok as never, // order
    logisticsClient as never, // logistics
    financeClient as never, // finance
    branchClient as never, // branch
    {
      encrypt: jest.fn().mockResolvedValue('hashed'),
      compare: jest.fn(),
    } as never,
    { get: jest.fn() } as never,
    {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    } as never,
  );
  return { service, saves, branchClient, financeClient };
}

const courierDto = (over: Row = {}) =>
  ({
    name: 'TEST Kuryer',
    phone_number: '+998903001288',
    password: 'Test-Parol-2026',
    tariff_home: 15000,
    tariff_center: 10000,
    region_id: '3',
    branch_id: '15',
    ...over,
  }) as never;

describe('perqZ3oM — SA/admin kuryeri HQ bo`lmagan filialda (identity saga)', () => {
  it.each([
    ['superadmin', { id: '1', roles: ['superadmin'] }],
    ['admin', { id: '2', roles: ['admin'] }],
  ])(
    '⭐ %s → kuryer filial 15 ga biriktiriladi (so`rovchi uzatiladi), viloyat filialdan, kassa yaratiladi',
    async (_label, requester: RequesterContext) => {
      const { service, saves, branchClient, financeClient } = makeService();

      const res = (await service.createCourier(courierDto(), requester)) as {
        statusCode: number;
      };

      expect(res.statusCode).toBe(201);
      expect(saves[0]).toMatchObject({
        role: 'courier',
        region_id: '3',
        created_by: requester.id,
      });
      expect(branchClient.send).toHaveBeenCalledWith(
        { cmd: 'branch.user.assign' },
        {
          requester,
          dto: { branch_id: '15', user_id: '700', role: 'COURIER' },
        },
      );
      const cashboxCalls = (
        financeClient.send.mock.calls as unknown as Array<
          [{ cmd: string }, Record<string, unknown>]
        >
      ).filter(([pattern]) => pattern.cmd === 'finance.cashbox.create');
      expect(cashboxCalls).toHaveLength(1);
      expect(cashboxCalls[0][1]).toMatchObject({
        user_id: '700',
        cashbox_type: Cashbox_type.FOR_COURIER,
      });
    },
  );
});
