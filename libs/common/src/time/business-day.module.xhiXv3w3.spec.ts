import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { of } from 'rxjs';
import type { DataSource } from 'typeorm';
import { getBusinessDaySchedule, setBusinessDaySchedule } from './business-day';
import {
  BusinessDayScheduleSync,
  intakeStateSchedule,
} from './business-day.module';

/**
 * xhiXv3w3 — servislar jadvalni ≤ 1 daqiqada oladi. RMQ manbasi (analytics,
 * gateway) `order.intake.state` javobini `successRes` konvertida oladi —
 * lokal UI e2e'da konvert ochilmagani uchun jadval yetib bormagan edi.
 */
const RULES = [{ from: '2026-11-27', time: '05:00' }];

const rmqSync = (response: unknown) => {
  const client = { send: jest.fn(() => of(response)) };
  const moduleRef = { get: jest.fn(() => client) } as unknown as ModuleRef;
  return {
    client,
    sync: new BusinessDayScheduleSync(moduleRef, {
      source: { rmqClient: 'ORDER' },
    }),
  };
};

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  setBusinessDaySchedule([]);
  jest.restoreAllMocks();
});

describe('xhiXv3w3 — BusinessDayScheduleSync', () => {
  it('intakeStateSchedule: successRes konverti, yalang`och holat, yo`q', () => {
    const envelope = {
      statusCode: 200,
      message: 'success',
      data: { day_change_schedule: RULES },
    };
    expect(intakeStateSchedule(envelope)).toEqual(RULES);
    expect(intakeStateSchedule({ day_change_schedule: RULES })).toEqual(RULES);
    expect(intakeStateSchedule({ data: { day_change_time: '05:00' } })).toBe(
      undefined,
    );
    expect(intakeStateSchedule(null)).toBe(undefined);
  });

  it('RMQ manbasi: `{ statusCode, data }` javobidan jadval oladi', async () => {
    const { sync, client } = rmqSync({
      statusCode: 200,
      message: 'success',
      data: { day_change_time: '05:00', day_change_schedule: RULES },
    });
    await sync.refresh();
    expect(client.send).toHaveBeenCalledWith(
      { cmd: 'order.intake.state' },
      expect.any(Object),
    );
    expect(getBusinessDaySchedule()).toEqual(RULES);
  });

  it('RMQ javobida jadval yo`q — oxirgisi qoladi, bir marta ogohlantiradi', async () => {
    setBusinessDaySchedule(RULES);
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const { sync } = rmqSync({ statusCode: 200, data: {} });
    await sync.refresh();
    await sync.refresh();
    expect(getBusinessDaySchedule()).toEqual(RULES);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('DB manbasi: `order_settings` qiymatidan jadval', async () => {
    const query = jest.fn(() =>
      Promise.resolve([{ value: { time: '05:00', schedule: RULES } }]),
    );
    const dataSource = { isInitialized: true, query } as unknown as DataSource;
    const sync = new BusinessDayScheduleSync(
      { get: jest.fn() } as unknown as ModuleRef,
      { source: 'db' },
      dataSource,
    );
    await sync.refresh();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"order_settings"'),
      ['intake.day_change_time'],
    );
    expect(getBusinessDaySchedule()).toEqual(RULES);
  });
});
