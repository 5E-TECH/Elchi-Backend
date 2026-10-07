import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import { Observable, defer, of, throwError } from 'rxjs';
import { Cashbox_type, RmqService } from '@app/common';
import { IdentityController } from './identity.controller';
import { UserServiceService } from './user-service.service';
import type { RequesterContext } from './contracts/user.payloads';

/**
 * Item 9 — PICKUP filiali menejeri POST /couriers qilganda HTTP 500 edi.
 *
 * branch-service to'g'ri RpcException 403 otadi, lekin RabbitMQ orqali u
 * identity'ga ODDIY obyekt ({statusCode, message, data}) bo'lib keladi. Saga
 * (assignUserToBranchOrCompensate) uni xom holda qayta otardi: executeAndAck
 * xabarni "vaqtinchalik" deb navbatga qaytarar (createCourier ikkinchi marta
 * ishlab, ikkinchi user yaratib o'chirardi), Nest esa xatoni
 * 'Internal server error' ga almashtirardi. Endi 4xx → RpcException.
 */
const PICKUP_MESSAGE =
  'Courier faqat HQ, REGIONAL yoki HYBRID branchga biriktirilishi mumkin';

type Row = Record<string, unknown> & { id: string };

function makeService(assignReply: () => Observable<unknown>) {
  let assignAttempts = 0;
  let nextId = 700;
  const rows = new Map<string, Row>();
  // save() chaqiruvi paytidagi holat nusxalari (keyingi o'zgarishlar ta'sir
  // qilmaydi).
  const saves: Record<string, unknown>[] = [];

  const repo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      if (typeof where.id === 'string') {
        const row = rows.get(where.id);
        return Promise.resolve(row && row.isDeleted === false ? row : null);
      }
      // ensurePhoneUnique — telefon bo'sh.
      return Promise.resolve(null);
    }),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn((value: Record<string, unknown>) => {
      saves.push({ ...value });
      const id = typeof value.id === 'string' ? value.id : String(nextId++);
      const row: Row = { ...value, id };
      rows.set(id, row);
      return Promise.resolve(row);
    }),
  };

  const branchClient = {
    send: jest.fn(({ cmd }: { cmd: string }) => {
      if (cmd === 'branch.find_hq') {
        return of({ statusCode: 200, data: { id: '1', type: 'HQ' } });
      }
      if (cmd === 'branch.user.assign') {
        // defer — rmqSend qayta obuna bo'lganda (retry) urinish sanaladi;
        // branchClient.send esa bir marta chaqiriladi.
        return defer(() => {
          assignAttempts += 1;
          return assignReply();
        });
      }
      return of({ data: null });
    }),
    emit: jest.fn(),
  };
  const logisticsClient = {
    send: jest.fn(() => of({ data: { id: '13' } })),
    emit: jest.fn(),
  };
  const financeClient = {
    send: jest.fn(() => of({ statusCode: 201 })),
    emit: jest.fn(),
  };
  const searchClient = {
    send: jest.fn(() => of({ ok: true })),
    emit: jest.fn(),
  };
  const noopClient = { send: jest.fn(), emit: jest.fn() };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  const service = new UserServiceService(
    repo as never,
    searchClient as never, // search
    noopClient as never, // catalog
    noopClient as never, // order
    logisticsClient as never, // logistics
    financeClient as never, // finance
    branchClient as never, // branch
    {
      encrypt: jest.fn().mockResolvedValue('hashed'),
      compare: jest.fn(),
    } as never,
    { get: jest.fn() } as never,
    activityLog as never,
  );

  return {
    service,
    repo,
    saves,
    branchClient,
    financeClient,
    searchClient,
    activityLog,
    assignAttempts: () => assignAttempts,
  };
}

const pickupManager: RequesterContext = { id: '50', roles: ['manager'] };
const superadmin: RequesterContext = { id: '1', roles: ['superadmin'] };

const courierDto = () =>
  ({
    name: 'E2E PICKUP kuryer',
    phone_number: '+998903001234',
    password: '0990',
    tariff_home: 15000,
    tariff_center: 10000,
    region_id: '13',
    branch_id: '18',
  }) as never;

const staffDto = () =>
  ({
    name: 'Yangi xodim',
    phone_number: '+998903001235',
    password: '0990',
    branch_id: '15',
  }) as never;

const sentCmds = (client: { send: jest.Mock }) =>
  client.send.mock.calls.map(([pattern]) => (pattern as { cmd: string }).cmd);

/** Promise rad etilishi SHART; rad etilgan qiymat qaytariladi. */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('rad etilishi kutilgandi');
    },
    (error: unknown) => error,
  );
}

async function rpcErrorOf(
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; message?: string }> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
}

describe('UserServiceService saga — branch.user.assign 4xx rad javobi', () => {
  it('PICKUP menejeri: 403 aniq matn bilan RpcException; bitta soft-delete; kassa, log, search yo‘q', async () => {
    const h = makeService(() =>
      throwError(() => ({
        statusCode: 403,
        message: PICKUP_MESSAGE,
        data: null,
      })),
    );

    const err = await rpcErrorOf(
      h.service.createCourier(courierDto(), pickupManager),
    );

    expect(err).toEqual(
      expect.objectContaining({ statusCode: 403, message: PICKUP_MESSAGE }),
    );
    // rmqSend kutubxonadagi qayta urinish (retries: 1) o'zgarmagan.
    expect(h.assignAttempts()).toBe(2);
    expect(h.branchClient.send).toHaveBeenCalledTimes(1);
    // 1-save: yangi kuryer; 2-save: kompensatsiya (soft-delete).
    expect(h.saves).toHaveLength(2);
    expect(h.saves[1]).toEqual(
      expect.objectContaining({
        isDeleted: true,
        status: 'inactive',
        phone_number: expect.stringMatching(/^\+998903001234-d\d+$/),
      }),
    );
    expect(sentCmds(h.financeClient)).not.toContain('finance.cashbox.create');
    expect(h.activityLog.log).not.toHaveBeenCalled();
    expect(h.searchClient.send).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'Berilgan role user roli bilan mos emas. User roli: COURIER'],
    [403, 'Bu filialga yozish/o‘zgartirish ruxsati yo‘q'],
    [403, 'Courier biriktirish uchun ushbu branchda MANAGER bo‘lish kerak'],
    [404, 'Branch not found'],
    [409, 'User already assigned to another branch'],
  ])(
    '%p %p — createCourier, createRegistrator va createManager aynan shu status va matnni qaytaradi',
    async (statusCode, message) => {
      const reject = () =>
        throwError(() => ({ statusCode, message, data: null }));

      const courier = makeService(reject);
      const registrator = makeService(reject);
      const manager = makeService(reject);

      const courierErr = await rpcErrorOf(
        courier.service.createCourier(courierDto(), superadmin),
      );
      const registratorErr = await rpcErrorOf(
        registrator.service.createRegistrator(staffDto(), superadmin),
      );
      const managerErr = await rpcErrorOf(
        manager.service.createManager(staffDto(), superadmin),
      );

      for (const err of [courierErr, registratorErr, managerErr]) {
        expect(err).toEqual(expect.objectContaining({ statusCode, message }));
      }
      // Menejer uchun filial kassasi (BRANCH) saga'dan keyin — yaratilmaydi.
      expect(sentCmds(manager.financeClient)).not.toContain(
        'finance.cashbox.create',
      );
      // Uchala oqimda ham user soft-delete qilingan.
      for (const h of [courier, registrator, manager]) {
        expect(h.saves[h.saves.length - 1]).toEqual(
          expect.objectContaining({ isDeleted: true }),
        );
      }
    },
  );

  it.each([
    [
      '5xx',
      { statusCode: 502, message: 'Identity service unavailable', data: null },
    ],
    [
      "Nest 'Internal server error'",
      { status: 'error', message: 'Internal server error' },
    ],
    [
      'TimeoutError',
      Object.assign(new Error('Timeout has occurred'), {
        name: 'TimeoutError',
      }),
    ],
  ])(
    '%s — o‘zgarishsiz qayta otiladi (RpcException emas), user baribir soft-delete',
    async (_label, failure) => {
      const h = makeService(() => throwError(() => failure));

      const error = await rejectionOf(
        h.service.createCourier(courierDto(), superadmin),
      );

      expect(error).toBe(failure);
      expect(error).not.toBeInstanceOf(RpcException);
      expect(h.saves[1]).toEqual(expect.objectContaining({ isDeleted: true }));
    },
  );

  it('allaqachon RpcException: rmqSend qayta urinmaydi, aynan o‘sha nusxa qayta otiladi', async () => {
    const rpcError = new RpcException({
      statusCode: 403,
      message: PICKUP_MESSAGE,
    });
    const h = makeService(() => throwError(() => rpcError));

    const error = await rejectionOf(
      h.service.createCourier(courierDto(), superadmin),
    );

    expect(error).toBe(rpcError);
    expect(h.assignAttempts()).toBe(1);
  });

  it("muvaffaqiyat (nazorat): 201 'Courier yaratildi', bitta save, couriers kassasi yaratiladi", async () => {
    const h = makeService(() => of({ statusCode: 201, data: { id: 'bu-1' } }));

    const res = await h.service.createCourier(courierDto(), pickupManager);

    expect(res).toEqual(
      expect.objectContaining({
        statusCode: 201,
        message: 'Courier yaratildi',
      }),
    );
    expect(h.repo.save).toHaveBeenCalledTimes(1);
    expect(h.assignAttempts()).toBe(1);
    expect(h.financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.create' },
      expect.objectContaining({ cashbox_type: Cashbox_type.FOR_COURIER }),
    );
  });
});

/**
 * Kontroller darajasi, HAQIQIY RmqService + executeAndAck bilan (kutubxona
 * faqat o'qiladi). Muhimi — nack'ning `requeue` argumenti: false → DLQ
 * (handler bir marta ishlaydi), true → qayta navbat (handler ikkinchi marta).
 */
describe('identity.courier.create — executeAndAck nack xulqi', () => {
  const makeContext = () => {
    const msg = { fields: { redelivered: false } };
    const channel = { ack: jest.fn(), nack: jest.fn() };
    const ctx = {
      getChannelRef: () => channel,
      getMessage: () => msg,
      getPattern: () => 'identity.courier.create',
    } as unknown as RmqContext;
    return { msg, channel, ctx };
  };

  const realRmqService = () => new RmqService({ get: jest.fn() } as never);

  it("403 rad javobi → nack(msg, false, false): DLQ, qayta navbatga qo'yilmaydi", async () => {
    const h = makeService(() =>
      throwError(() => ({
        statusCode: 403,
        message: PICKUP_MESSAGE,
        data: null,
      })),
    );
    const controller = new IdentityController(
      realRmqService(),
      h.service,
      {} as never,
      {} as never,
    );
    const { msg, channel, ctx } = makeContext();

    const error = await rejectionOf(
      controller.createCourier(
        { dto: courierDto(), requester: pickupManager },
        ctx,
      ),
    );

    expect(error).toBeInstanceOf(RpcException);
    expect(channel.nack).toHaveBeenCalledTimes(1);
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.nack).not.toHaveBeenCalledWith(msg, false, true);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('taqqoslash: xom obyekt qayta otilsa → nack(msg, false, true) — shuning uchun handler ikki marta ishlardi', async () => {
    const plain = { statusCode: 403, message: PICKUP_MESSAGE, data: null };
    const userService = { createCourier: jest.fn().mockRejectedValue(plain) };
    const controller = new IdentityController(
      realRmqService(),
      userService as never,
      {} as never,
      {} as never,
    );
    const { msg, channel, ctx } = makeContext();

    const error = await rejectionOf(
      controller.createCourier(
        { dto: courierDto(), requester: pickupManager },
        ctx,
      ),
    );

    expect(error).toBe(plain);
    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
  });
});
