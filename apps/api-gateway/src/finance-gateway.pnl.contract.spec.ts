import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { isObservable, of, throwError } from 'rxjs';
import { FinanceGatewayController } from './finance-gateway.controller';
import { collectRouteRoles } from './auth/route-roles';
import { FinancePnlQueryDto } from './dto/finance.swagger.dto';

/**
 * GET /finance/pnl — tizim bo'yicha oylik daromad / xarajat / sof foyda
 * (ega 2026-11-28). Gateway qoidani qayta yozmaydi: `finance.pnl.series`
 * ga uzatadi va faqat qatori yo'q oylarni 0 bilan to'ldiradi.
 */
type Client = { send: jest.Mock };

const client = (): Client => ({ send: jest.fn() });

const setup = (handler: (payload: any) => unknown) => {
  const finance = client();
  finance.send.mockImplementation((pattern: { cmd: string }, payload: any) => {
    if (pattern.cmd !== 'finance.pnl.series') {
      return throwError(() => new Error(`kutilmagan RPC: ${pattern.cmd}`));
    }
    const result = handler(payload);
    return isObservable(result) ? result : of(result);
  });
  const controller = new FinanceGatewayController(
    finance as never,
    client() as never,
    client() as never,
    client() as never,
  );
  return { controller, finance };
};

/** `finance.pnl.series` ga o'xshash javob: faqat qatori bor oylar. */
const rpcEcho = (items: unknown[]) => (payload: any) => ({
  statusCode: 200,
  message: 'P&L series',
  data: {
    from_day: payload.from_day,
    to_day: payload.to_day,
    granularity: payload.granularity,
    items,
    totals: { gross: 1, opex: 2, net: -1, other_income: 3 },
  },
});

const zero = (period: string) => ({
  period,
  gross: 0,
  opex: 0,
  net: 0,
  other_income: 0,
});

describe('GET /finance/pnl — tizim P&L grafigi', () => {
  afterEach(() => jest.useRealTimers());

  it('@Roles — faqat superadmin va admin', () => {
    const map = collectRouteRoles([FinanceGatewayController]);
    expect(map.get('FinanceGatewayController_pnlSeries')).toEqual([
      'superadmin',
      'admin',
    ]);
  });

  it('sukut: joriy oy bilan 12 oy, oylik', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    // 15:00 Toshkent.
    jest.setSystemTime(new Date('2026-11-28T10:00:00.000Z'));
    const { controller, finance } = setup(rpcEcho([]));

    const res: any = await controller.pnlSeries({});

    expect(finance.send).toHaveBeenCalledTimes(1);
    expect(finance.send.mock.calls[0][1]).toEqual({
      from_day: '2025-12-01',
      to_day: '2026-11-28',
      granularity: 'month',
    });
    expect(res.data.items.map((item: any) => item.period)).toEqual([
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(res.data.items.every((item: any) => item.net === 0)).toBe(true);
  });

  it('bo‘sh oy 0 bilan to‘ldiriladi; bor oy va totals o‘zgarishsiz', async () => {
    const sep = {
      period: '2026-09',
      gross: 41250000,
      opex: 18400000,
      net: 22850000,
      other_income: 5000000,
    };
    const nov = {
      period: '2026-11',
      gross: 38900000,
      opex: 41300000,
      net: -2400000,
      other_income: 0,
    };
    const { controller } = setup(rpcEcho([sep, nov]));

    const res: any = await controller.pnlSeries({
      from_day: '2026-08-15',
      to_day: '2026-12-31',
    });

    expect(res).toEqual({
      statusCode: 200,
      message: 'P&L series',
      data: {
        from_day: '2026-08-15',
        to_day: '2026-12-31',
        granularity: 'month',
        items: [zero('2026-08'), sep, zero('2026-10'), nov, zero('2026-12')],
        totals: { gross: 1, opex: 2, net: -1, other_income: 3 },
      },
    });
  });

  it('granularity=day — kunlik skelet; parametrlar o‘zgarishsiz uzatiladi', async () => {
    const { controller, finance } = setup(
      rpcEcho([{ ...zero('2026-11-02'), gross: 5, net: 5 }]),
    );

    const res: any = await controller.pnlSeries({
      from_day: '2026-11-01',
      to_day: '2026-11-03',
      granularity: 'day',
    });

    expect(finance.send.mock.calls[0][1]).toEqual({
      from_day: '2026-11-01',
      to_day: '2026-11-03',
      granularity: 'day',
    });
    expect(res.data.items.map((item: any) => [item.period, item.net])).toEqual([
      ['2026-11-01', 0],
      ['2026-11-02', 5],
      ['2026-11-03', 0],
    ]);
  });

  it('faqat to_day berilsa — o‘sha oy bilan 12 oy', async () => {
    const { controller, finance } = setup(rpcEcho([]));
    await controller.pnlSeries({ to_day: '2026-03-10' });
    expect(finance.send.mock.calls[0][1]).toMatchObject({
      from_day: '2025-04-01',
      to_day: '2026-03-10',
    });
  });

  it('moliya xatosi (400) gateway’dan o‘zgarishsiz o‘tadi', async () => {
    const { controller } = setup(() =>
      throwError(
        () =>
          new BadRequestException(
            "from_day to_day dan katta bo'lmasligi kerak",
          ),
      ),
    );
    await expect(
      controller.pnlSeries({ from_day: '2026-12-01', to_day: '2026-11-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('data’siz javob tegilmaydi', async () => {
    const { controller } = setup(() => ({ statusCode: 200, data: null }));
    await expect(controller.pnlSeries({})).resolves.toEqual({
      statusCode: 200,
      data: null,
    });
  });

  describe('FinancePnlQueryDto', () => {
    const errors = async (query: Record<string, unknown>) =>
      (
        await validate(plainToInstance(FinancePnlQueryDto, query), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((error) => error.property);

    it('to‘g‘ri so‘rov — xatosiz', async () => {
      expect(await errors({})).toEqual([]);
      expect(
        await errors({
          from_day: '2025-12-01',
          to_day: '2026-11-28',
          granularity: 'month',
        }),
      ).toEqual([]);
    });

    it.each([
      [{ from_day: '01.11.2026' }, 'from_day'],
      [{ to_day: '2026-11' }, 'to_day'],
      [{ granularity: 'year' }, 'granularity'],
      [{ from_date: '2026-11-01' }, 'from_date'],
    ])('%p → 400 (%s)', async (query, property) => {
      expect(await errors(query)).toEqual([property]);
    });
  });
});
