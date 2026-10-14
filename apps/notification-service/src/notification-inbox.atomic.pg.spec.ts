import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { CreateNotifications1716000000008 } from '../../../migrations/1716000000008-CreateNotifications';
import { DispatchNotificationDto } from './dto/dispatch-notification.dto';
import { Notification } from './entities/notification.entity';
import { NotificationInboxService } from './notification-inbox.service';

/**
 * (BoMa1A1R TC2/TC3) HAQIQIY Postgres: ikkinchi qator yozilishida DB xatosi
 * bo'lsa birinchi qator ham QOLMAYDI (bitta tranzaksiya) va javobda xom
 * Postgres matni yo'q.
 *
 * Xato trigger bilan "o'rtada" chiqariladi: recipient_id = 777000000002
 * qatori `invalid input syntax for type bigint` matnli istisno tashlaydi.
 *
 *   NOTIFICATION_PG_TEST_URI=postgres://postgres@127.0.0.1:55443/elchi_c_test \
 *     npx jest apps/notification-service/src/notification-inbox.atomic.pg.spec.ts --runInBand
 */
const uri = process.env.NOTIFICATION_PG_TEST_URI;
const isLocal = (() => {
  if (!uri) return false;
  try {
    return ['127.0.0.1', 'localhost'].includes(new URL(uri).hostname);
  } catch {
    return false;
  }
})();

const GOOD = '777000000001';
const BAD = '777000000002';

(isLocal ? describe : describe.skip)(
  'dispatch atomikligi — haqiqiy PG (BoMa1A1R)',
  () => {
    let ds: DataSource;
    let service: NotificationInboxService;

    beforeAll(async () => {
      ds = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [Notification],
      });
      await ds.initialize();
      const runner = ds.createQueryRunner();
      try {
        await new CreateNotifications1716000000008().up(runner);
      } finally {
        await runner.release();
      }
      await ds.query(`
        CREATE OR REPLACE FUNCTION notification_schema.boma_fail_second()
        RETURNS trigger AS $$
        BEGIN
          IF NEW.recipient_id = ${BAD} THEN
            RAISE EXCEPTION 'invalid input syntax for type bigint: "abc"';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ds.query(
        'DROP TRIGGER IF EXISTS boma_fail_second ON notification_schema.notifications',
      );
      await ds.query(`
        CREATE TRIGGER boma_fail_second BEFORE INSERT
        ON notification_schema.notifications
        FOR EACH ROW EXECUTE FUNCTION notification_schema.boma_fail_second()`);

      service = new NotificationInboxService(
        ds.getRepository(Notification),
        { send: jest.fn() } as never,
        { emit: jest.fn(() => of(null)) } as never,
        { sendNotification: jest.fn() } as never,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
        { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
        { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as never,
      );
      jest
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => undefined);
    });

    afterAll(async () => {
      if (!ds?.isInitialized) return;
      await ds.query(
        'DROP TRIGGER IF EXISTS boma_fail_second ON notification_schema.notifications',
      );
      await ds.query(
        'DROP FUNCTION IF EXISTS notification_schema.boma_fail_second()',
      );
      await ds.query(
        `DELETE FROM notification_schema.notifications WHERE recipient_id IN (${GOOD}, ${BAD})`,
      );
      await ds.destroy();
    });

    const countFor = async (id: string) => {
      const [{ count }]: Array<{ count: string }> = await ds.query(
        'SELECT COUNT(*)::text AS count FROM notification_schema.notifications WHERE recipient_id = $1',
        [id],
      );
      return Number(count);
    };

    it('TC2: ikkinchi qatorda xato — birinchi qator ham DB da qolmaydi; TC3: 500 umumiy matn', async () => {
      let caught: unknown = null;
      try {
        await service.dispatch({
          recipient_ids: [GOOD, BAD],
          type: 'x.audit.partial',
          title: 'Audit',
        } as DispatchNotificationDto);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RpcException);
      const body = (caught as RpcException).getError() as {
        statusCode: number;
        message: string;
      };
      expect(body.statusCode).toBe(500);
      expect(body.message).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toContain('invalid input syntax');

      expect(await countFor(GOOD)).toBe(0);
      expect(await countFor(BAD)).toBe(0);
    });

    it('nazorat: xatosiz dispatch qatorni haqiqatan yozadi', async () => {
      await service.dispatch({
        recipient_ids: [GOOD],
        type: 'x.audit.partial',
        title: 'Audit',
      } as DispatchNotificationDto);
      expect(await countFor(GOOD)).toBe(1);
    });
  },
);
