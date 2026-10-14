import { RpcException } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of } from 'rxjs';
import { QueryFailedError } from 'typeorm';
import { DispatchNotificationDto } from './dto/dispatch-notification.dto';
import { NotificationInboxService } from './notification-inbox.service';

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]) => rmqSendMock(...args),
  };
});

/**
 * (BoMa1A1R) Dispatch atomikligi va xatoni mijozga ochmaslik.
 * Haqiqiy tranzaksiya rollback'i — notification-inbox.atomic.pg.spec.ts.
 */
describe('NotificationInboxService — BoMa1A1R', () => {
  let service: NotificationInboxService;
  let transaction: jest.Mock;
  let insert: jest.Mock;

  const rpcError = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as {
        statusCode: number;
        message: string;
      };
    }
    throw new Error('RpcException kutilgan edi');
  };

  beforeEach(() => {
    rmqSendMock.mockReset();
    insert = jest.fn();
    const txRepo = {
      create: jest.fn((v) => ({ ...v })),
      insert,
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    };
    transaction = jest.fn((work: (m: unknown) => Promise<unknown>) =>
      work({ getRepository: () => txRepo }),
    );
    service = new NotificationInboxService(
      {
        manager: { transaction },
        createQueryBuilder: jest.fn(),
      } as never,
      { send: jest.fn() } as never,
      { emit: jest.fn(() => of(null)) } as never,
      { sendNotification: jest.fn() } as never,
      { log: jest.fn() } as never,
      { enqueue: jest.fn() } as never,
      { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as never,
    );
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  it('TC1: recipient_ids ichida raqam bo‘lmagan element → 400, dispatch BOSHLANMAYDI', async () => {
    const error = await rpcError(
      service.dispatch({
        recipient_ids: ['1', 'abc'],
        type: 'x.audit.partial',
        title: 'Audit',
      } as DispatchNotificationDto),
    );
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('"abc"');
    expect(transaction).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(rmqSendMock).not.toHaveBeenCalled();
  });

  it('TC1: faqat ["abc"], bigint’dan katta va 0 ham 400 (xom PG xatosi emas)', async () => {
    for (const recipient_ids of [
      ['abc'],
      ['9223372036854775808'],
      ['0'],
      ['-5'],
    ]) {
      const error = await rpcError(
        service.dispatch({
          recipient_ids,
          type: 'x.audit.partial',
          title: 'Audit',
        } as DispatchNotificationDto),
      );
      expect(error.statusCode).toBe(400);
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it('TC1: DTO (gateway/class-validator) recipient_ids har elementini tekshiradi', async () => {
    const dto = plainToInstance(DispatchNotificationDto, {
      recipient_ids: ['1', 'abc'],
      type: 'x.audit.partial',
      title: 'Audit',
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('recipient_ids');
    const ok = plainToInstance(DispatchNotificationDto, {
      recipient_ids: ['1', '2'],
      type: 'x.audit.partial',
      title: 'Audit',
    });
    expect((await validate(ok)).map((e) => e.property)).not.toContain(
      'recipient_ids',
    );
  });

  it('TC3: DB xatosi 500 + umumiy matn — xom Postgres matni javobda YO‘Q', async () => {
    insert.mockRejectedValue(
      new QueryFailedError(
        'INSERT INTO notifications ...',
        [],
        new Error('invalid input syntax for type bigint: "abc"'),
      ),
    );
    const error = await rpcError(
      service.dispatch({
        recipient_ids: ['1', '2'],
        type: 'x.audit.partial',
        title: 'Audit',
      } as DispatchNotificationDto),
    );
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe('Internal server error');
    expect(JSON.stringify(error)).not.toMatch(/invalid input syntax|bigint/);
  });

  it('TC2: yozuvlar BITTA tranzaksiyada — xato bo‘lsa tranzaksiya yiqiladi (rollback)', async () => {
    insert.mockRejectedValue(new Error('boom'));
    await rpcError(
      service.dispatch({
        recipient_ids: ['1', '2'],
        type: 'x.audit.partial',
        title: 'Audit',
      } as DispatchNotificationDto),
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    // Ikkala qator BITTA bulk INSERT da (sikl ichida save yo'q).
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toHaveLength(2);
  });
});
