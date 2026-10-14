import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationPriority } from '@app/common';
import { SmsBlockedError } from '../sms/sms-gate.service';
import {
  ESCALATE_OUTBOX_TARGET,
  ESCALATE_PATTERN,
  NotificationEscalationService,
} from './notification-escalation.service';

/**
 * (7Ec56EIw TC9–TC12, Jht84wGp TC8/TC9) CRITICAL → N daqiqadan keyin SMS,
 * ATIGI BIR MARTA.
 */
const row = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    recipient_id: `9${id}`,
    priority: NotificationPriority.CRITICAL,
    is_read: false,
    isDeleted: false,
    delivery: { in_app: 'sent', escalation: 'scheduled' },
    ...extra,
  }) as any;

describe('NotificationEscalationService', () => {
  let config: any;
  let outbox: any;
  let notifications: any;
  let smsDispatch: any;
  let smsConfig: any;
  let store: Map<string, any>;
  let patches: Array<{ ids: string[]; patch: any }>;
  let service: NotificationEscalationService;

  beforeEach(() => {
    store = new Map();
    patches = [];
    config = { get: jest.fn(() => undefined) };
    outbox = { enqueue: jest.fn().mockResolvedValue({}) };
    const qb = () => {
      const state: any = { ids: [], patch: undefined };
      const builder: any = {
        update: jest.fn(() => builder),
        set: jest.fn(() => builder),
        setParameter: jest.fn((_: string, value: string) => {
          state.patch = JSON.parse(value);
          return builder;
        }),
        whereInIds: jest.fn((ids: string[]) => {
          state.ids = ids;
          return builder;
        }),
        andWhere: jest.fn(() => builder),
        execute: jest.fn(() => {
          patches.push(state);
          return Promise.resolve({ affected: state.ids.length });
        }),
      };
      return builder;
    };
    notifications = {
      find: jest.fn(({ where }: any) =>
        Promise.resolve(
          (where.id.value as string[])
            .map((id) => store.get(id))
            .filter(Boolean),
        ),
      ),
      createQueryBuilder: jest.fn(qb),
    };
    // Haqiqiy SmsDispatchService.escalate kabi: `escalated_at` ni ATOMIK
    // qo'yadi (bo'sh bo'lganlarga) va shular soniga SMS.
    smsDispatch = {
      escalate: jest.fn((ids: string[]) => {
        let claimed = 0;
        for (const id of ids) {
          const current = store.get(id);
          if (current && !current.delivery?.escalated_at) {
            current.delivery = {
              ...current.delivery,
              escalated_at: new Date().toISOString(),
              sms: 'queued',
              escalation: 'sms',
            };
            claimed += 1;
          }
        }
        return Promise.resolve(claimed);
      }),
    };
    smsConfig = { enabled: true };
    service = new NotificationEscalationService(
      config,
      outbox,
      notifications,
      smsDispatch,
      smsConfig,
    );
  });

  describe('dueAt / schedule — dispatch tomoni', () => {
    it('TC12: kechikish outbox scheduledAt orqali (N daqiqa, sukut 10), dispatch tranzaksiyasida', async () => {
      const now = new Date('2026-10-14T10:00:00.000Z');
      const due = service.dueAt('critical', ['in_app', 'realtime'], now);
      expect(due?.toISOString()).toBe('2026-10-14T10:10:00.000Z');

      const manager = { tx: true } as any;
      const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
      await service.schedule(manager, ids, due!);
      expect(outbox.enqueue).toHaveBeenCalledTimes(2);
      expect(outbox.enqueue).toHaveBeenNthCalledWith(
        1,
        ESCALATE_OUTBOX_TARGET,
        ESCALATE_PATTERN,
        { notification_ids: ids.slice(0, 100) },
        { manager, scheduledAt: due },
      );
    });

    it('critical emas / SMS allaqachon so‘ralgan / N=0 — eskalatsiya rejalashtirilmaydi', () => {
      expect(service.dueAt('high', ['in_app'])).toBeNull();
      expect(service.dueAt('critical', ['in_app', 'sms'])).toBeNull();
      config.get.mockReturnValue(0);
      expect(service.dueAt('critical', ['in_app'])).toBeNull();
      config.get.mockReturnValue('3');
      const now = new Date('2026-10-14T10:00:00.000Z');
      expect(service.dueAt('critical', ['in_app'], now)?.toISOString()).toBe(
        '2026-10-14T10:03:00.000Z',
      );
    });

    it('TC12: RMQ navbat argumentlari / TTL bu yerda ishlatilmaydi', () => {
      const src = readFileSync(
        join(__dirname, 'notification-escalation.service.ts'),
        'utf8',
      ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(src).not.toMatch(
        /RMQ_RPC_TTL_MS|x-message-ttl|messageTtl|expiration/,
      );
    });
  });

  describe('handle — N daqiqadan keyin', () => {
    it('TC9: o‘qilmagan critical, push yetmagan → SMS shoxiga o‘tadi', async () => {
      store.set('1', row('1', { delivery: { push: 'no_subscription' } }));
      store.set('2', row('2')); // push so'ralmagan

      const res = await service.handle({ notification_ids: ['1', '2'] });

      expect(smsDispatch.escalate).toHaveBeenCalledWith(['1', '2']);
      expect(res).toEqual({ checked: 2, escalated: 2 });
    });

    it('TC10: xabar o‘qilgan bo‘lsa eskalatsiya ishlamaydi; push `sent` bo‘lsa ham', async () => {
      store.set('1', row('1', { is_read: true }));
      store.set('2', row('2', { delivery: { push: 'sent' } }));
      store.set('3', row('3', { isDeleted: true }));
      store.set('4', row('4', { priority: NotificationPriority.HIGH }));

      const res = await service.handle({
        notification_ids: ['1', '2', '3', '4'],
      });

      expect(smsDispatch.escalate).not.toHaveBeenCalled();
      expect(res).toEqual({ checked: 4, escalated: 0 });
    });

    it('TC11 / Jht84wGp TC8-9: ikki marta chaqirilsa ikkinchisi `escalated_at` tufayli hech narsa qilmaydi — SMS ATIGI 1 marta', async () => {
      store.set('1', row('1', { delivery: { push: 'failed' } }));

      const first = await service.handle({ notification_ids: ['1'] });
      const second = await service.handle({ notification_ids: ['1'] });

      expect(first.escalated).toBe(1);
      expect(second).toEqual({ checked: 1, escalated: 0 });
      expect(smsDispatch.escalate).toHaveBeenCalledTimes(1);
    });

    it('ikki nusxa bir vaqtda (filtrdan ikkalasi o‘tdi) — atomik claim baribir 1 ta SMS', async () => {
      store.set('1', row('1'));
      const [a, b] = await Promise.all([
        service.handle({ notification_ids: ['1'] }),
        service.handle({ notification_ids: ['1'] }),
      ]);
      expect(a.escalated + b.escalated).toBe(1);
    });

    it('SMS o‘chiq — SMS yo‘q, holat DB ga yoziladi (logga emas)', async () => {
      smsConfig.enabled = false;
      store.set('1', row('1'));
      const res = await service.handle({ notification_ids: ['1'] });
      expect(smsDispatch.escalate).not.toHaveBeenCalled();
      expect(res).toEqual({ checked: 1, escalated: 0, skipped: 1 });
      expect(patches[0]).toEqual({
        ids: ['1'],
        patch: { escalation: 'skipped', escalation_reason: 'sms_disabled' },
      });
    });

    it('kvota / kill-switch — xato yutilmaydi, `blocked` yoziladi, qayta urinish yo‘q', async () => {
      store.set('1', row('1'));
      smsDispatch.escalate.mockRejectedValue(
        new SmsBlockedError('daily_cap', 'Kunlik limit'),
      );
      const res = await service.handle({ notification_ids: ['1'] });
      expect(res).toEqual({ checked: 1, escalated: 0, blocked: 1 });
      expect(patches[0].patch).toEqual({
        escalation: 'blocked',
        escalation_reason: 'daily_cap',
      });
    });

    it('bo‘sh / noto‘g‘ri payload — DB so‘rovi yo‘q', async () => {
      expect(await service.handle({})).toEqual({ checked: 0, escalated: 0 });
      expect(await service.handle({ notification_ids: ['abc', null] })).toEqual(
        { checked: 0, escalated: 0 },
      );
      expect(notifications.find).not.toHaveBeenCalled();
    });
  });
});
