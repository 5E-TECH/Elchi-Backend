import { Logger } from '@nestjs/common';
import type { RmqContext } from '@nestjs/microservices';
import {
  AI_CONFIG_PATTERNS as P,
  RMQ_REQUESTER_SIG_HEADER,
  signRmqRequester,
  type RmqService,
} from '@app/common';
import { AiConfigController } from './ai-config.controller';
import type { AiConfigEnv } from './ai-config-env';
import type { AiConfigAccessSettings } from './ai-config-requester';

/**
 * be-brief §12 ai-config.controller.spec — handler HECH QACHON throw
 * qilmaydi va DOIM ack qiladi; har xato yo'li `{ok:false}`.
 */
const SECRET = 'q'.repeat(40);
const SA = { id: '7', roles: ['superadmin'], name: 'Ega' };

function make(over: Partial<AiConfigAccessSettings> = {}) {
  const access: AiConfigAccessSettings = {
    appEnv: 'staging',
    uiEnabled: true,
    sigSecret: SECRET,
    configQueue: 'ai_config_queue',
    writerIds: ['7'],
    stepUpRequired: false,
    masterKeyConfigured: true,
    ...over,
  };
  const rmq = { ack: jest.fn() };
  const store = {
    set: jest.fn().mockResolvedValue({ ok: true }),
    verifyInUse: jest.fn().mockResolvedValue({ ok: true }),
    restore: jest.fn().mockResolvedValue({ ok: true }),
    deactivate: jest.fn().mockResolvedValue({ ok: true }),
    forgetPrevious: jest.fn().mockResolvedValue({ ok: true }),
  };
  const view = { build: jest.fn().mockResolvedValue({ view: true }) };
  const history = {
    page: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
  };
  const ctl = new AiConfigController(
    rmq as unknown as RmqService,
    { access: () => access } as unknown as AiConfigEnv,
    store as never,
    view as never,
    history as never,
  );
  return { ctl, rmq, store, view, history };
}

function ctx(
  cmd: string,
  data: unknown,
  o: { signed?: boolean; queue?: string } = {},
): RmqContext {
  const header =
    o.signed === false
      ? undefined
      : signRmqRequester({
          cmd,
          data: JSON.parse(JSON.stringify(data)),
          secret: SECRET,
          kind: 'gateway',
        });
  return {
    getPattern: () => JSON.stringify({ cmd }),
    getMessage: () => ({
      fields: { routingKey: o.queue ?? 'ai_config_queue' },
      properties: {
        headers: header ? { [RMQ_REQUESTER_SIG_HEADER]: header } : {},
      },
    }),
  } as unknown as RmqContext;
}

describe('AiConfigController', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterAll(() => jest.restoreAllMocks());

  const fresh = () => ({ requester: SA, sent_at: Date.now(), version: 1 });

  it('key.set: imzo + oyna → store.set → yangilangan view', async () => {
    const { ctl, rmq, store } = make();
    const data = fresh();
    await expect(ctl.keySet(data, ctx(P.KEY_SET, data))).resolves.toEqual({
      ok: true,
      data: { view: true },
    });
    expect(store.set).toHaveBeenCalled();
    expect(rmq.ack).toHaveBeenCalledTimes(1);
  });

  type Call = (
    c: AiConfigController,
    d: Record<string, unknown>,
    x: RmqContext,
  ) => Promise<{ ok: boolean; error?: { code?: string } }>;
  const writes: Array<[string, Call]> = [
    [P.KEY_SET, (c, d, x) => c.keySet(d, x)],
    [P.KEY_VERIFY, (c, d, x) => c.keyVerify(d, x)],
    [P.KEY_RESTORE, (c, d, x) => c.keyRestore(d, x)],
    [P.KEY_DEACTIVATE, (c, d, x) => c.keyDeactivate(d, x)],
    [P.KEY_FORGET_PREVIOUS, (c, d, x) => c.keyForget(d, x)],
  ];

  it.each(writes)(
    '%s: imzosiz / boshqa navbat / admin / flag / ro‘yxat → {ok:false}, ack',
    async (cmd, m) => {
      const cases: Array<
        [
          Partial<AiConfigAccessSettings>,
          Record<string, unknown>,
          { signed?: boolean; queue?: string },
          string,
        ]
      > = [
        [{}, fresh(), { signed: false }, 'AI_CONFIG_UNSIGNED'],
        [{ sigSecret: undefined }, fresh(), {}, 'AI_CONFIG_UNSIGNED'],
        [{}, fresh(), { queue: 'ai_queue' }, 'AI_CONFIG_UNSIGNED'],
        [
          {},
          { ...fresh(), requester: { id: '7', roles: ['admin'] } },
          {},
          'AI_CONFIG_NOT_ALLOWED',
        ],
        [{ uiEnabled: false }, fresh(), {}, 'AI_CONFIG_UI_DISABLED'],
        [{ writerIds: [] }, fresh(), {}, 'AI_CONFIG_NOT_ALLOWED'],
        [
          {},
          { ...fresh(), sent_at: Date.now() - 2500 },
          {},
          'AI_CONFIG_EXPIRED',
        ],
      ];
      for (const [over, data, o, code] of cases) {
        const { ctl, rmq, store } = make(over);
        const res = await m(ctl, data, ctx(cmd, data, o));
        expect(res).toMatchObject({ ok: false, error: { code } });
        expect(rmq.ack).toHaveBeenCalledTimes(1);
        for (const op of Object.values(store))
          expect(op).not.toHaveBeenCalled();
      }
    },
  );

  it('step-up talab qilinsa: set/restore/deactivate/forget rad, verify o‘tadi', async () => {
    for (const [cmd, m] of writes) {
      const { ctl } = make({ stepUpRequired: true });
      const data = fresh();
      const res = await m(ctl, data, ctx(cmd, data));
      if (cmd === P.KEY_VERIFY) expect(res.ok).toBe(true);
      else
        expect(res).toMatchObject({
          ok: false,
          error: { code: 'AI_STEP_UP_REQUIRED' },
        });
    }
  });

  it('kutilmagan xato: throw yo‘q, 500 kodsiz, matnda tafsilot yo‘q, ack', async () => {
    const { ctl, rmq, store } = make();
    store.set.mockRejectedValueOnce(
      new Error('pg: connection reset sk-ant-api03-secret'),
    );
    const data = fresh();
    const res = await ctl.keySet(data, ctx(P.KEY_SET, data));
    expect(res).toEqual({
      ok: false,
      error: { statusCode: 500, message: 'Ichki xato' },
    });
    expect(rmq.ack).toHaveBeenCalledTimes(1);
  });

  it('ack o‘zi throw qilsa ham handler throw qilmaydi', async () => {
    const { ctl, rmq } = make();
    rmq.ack.mockImplementation(() => {
      throw new Error('channel closed');
    });
    const data = fresh();
    await expect(ctl.keySet(data, ctx(P.KEY_SET, data))).resolves.toMatchObject(
      { ok: true },
    );
  });

  it('get/history: superadmin (imzo shart emas, flag o‘chiq ham); admin → NOT_ALLOWED', async () => {
    const { ctl, view, history } = make({
      uiEnabled: false,
      sigSecret: undefined,
    });
    await expect(
      ctl.get({ requester: SA }, ctx(P.GET, {}, { signed: false })),
    ).resolves.toEqual({
      ok: true,
      data: { view: true },
    });
    expect(view.build).toHaveBeenCalledWith('7');
    await expect(
      ctl.getHistory(
        { requester: SA, limit: 5 },
        ctx(P.HISTORY, {}, { signed: false }),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(history.page).toHaveBeenCalled();
    await expect(
      ctl.get(
        { requester: { id: '2', roles: ['admin'] } },
        ctx(P.GET, {}, { signed: false }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'AI_CONFIG_NOT_ALLOWED', statusCode: 403 },
    });
    await expect(
      ctl.get(undefined, ctx(P.GET, {}, { signed: false })),
    ).resolves.toMatchObject({ ok: false });
  });
});
