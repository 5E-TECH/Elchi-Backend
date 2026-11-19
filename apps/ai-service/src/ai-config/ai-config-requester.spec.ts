import { RMQ_REQUESTER_SIG_HEADER, signRmqRequester } from '@app/common';
import {
  type AiConfigAccessSettings,
  checkConfigWrite,
  configPermissions,
  parseWriterIds,
} from './ai-config-requester';

/** be-brief D1 — yozuv tekshiruvi SOF va throw qilmaydi. */
const SECRET = 'z'.repeat(40);
const SA = { id: '7', roles: ['superadmin'], name: 'Ega' };
const CMD = 'ai.config.key.set';

function settings(
  over: Partial<AiConfigAccessSettings> = {},
): AiConfigAccessSettings {
  return {
    appEnv: 'staging',
    uiEnabled: true,
    sigSecret: SECRET,
    configQueue: 'ai_config_queue',
    writerIds: ['7'],
    stepUpRequired: false,
    masterKeyConfigured: true,
    ...over,
  };
}

function ctx(
  data: unknown,
  o: {
    kind?: 'gateway' | 'internal';
    queue?: string;
    header?: string | null;
  } = {},
) {
  const header =
    o.header === null
      ? undefined
      : (o.header ??
        signRmqRequester({
          cmd: CMD,
          data: JSON.parse(JSON.stringify(data)),
          secret: SECRET,
          kind: o.kind ?? 'gateway',
        }));
  return {
    getPattern: () => JSON.stringify({ cmd: CMD }),
    getMessage: () => ({
      fields: { routingKey: o.queue ?? 'ai_config_queue' },
      properties: {
        headers: header ? { [RMQ_REQUESTER_SIG_HEADER]: header } : {},
      },
    }),
  };
}

describe('checkConfigWrite', () => {
  const data = { requester: SA, sent_at: 1 };

  it('to‘g‘ri: gateway imzosi, navbat, superadmin, ro‘yxatda', () => {
    expect(
      checkConfigWrite(ctx(data), data, settings(), { stepUp: true }),
    ).toEqual({
      ok: true,
      requester: { id: '7', roles: ['superadmin'], name: 'Ega' },
    });
  });

  it.each([
    [
      'sir yo‘q',
      ctx(data),
      data,
      settings({ sigSecret: undefined }),
      'AI_CONFIG_UNSIGNED',
    ],
    [
      'imzosiz',
      ctx(data, { header: null }),
      data,
      settings(),
      'AI_CONFIG_UNSIGNED',
    ],
    [
      'internal kind',
      ctx(data, { kind: 'internal' }),
      data,
      settings(),
      'AI_CONFIG_UNSIGNED',
    ],
    [
      'buzilgan imzo',
      ctx(data, { header: 'v1.gateway.1.abcd' }),
      data,
      settings(),
      'AI_CONFIG_UNSIGNED',
    ],
    [
      'boshqa navbat (ai_queue)',
      ctx(data, { queue: 'ai_queue' }),
      data,
      settings(),
      'AI_CONFIG_UNSIGNED',
    ],
    [
      'payload almashtirilgan',
      ctx(data),
      { requester: { ...SA, id: '8' }, sent_at: 1 },
      settings(),
      'AI_CONFIG_UNSIGNED',
    ],
    [
      'admin',
      ctx({ requester: { id: '7', roles: ['admin'] } }),
      { requester: { id: '7', roles: ['admin'] } },
      settings(),
      'AI_CONFIG_NOT_ALLOWED',
    ],
    [
      'flag o‘chiq',
      ctx(data),
      data,
      settings({ uiEnabled: false }),
      'AI_CONFIG_UI_DISABLED',
    ],
    [
      'ro‘yxatda yo‘q',
      ctx(data),
      data,
      settings({ writerIds: ['9'] }),
      'AI_CONFIG_NOT_ALLOWED',
    ],
    [
      'staging bo‘sh ro‘yxat',
      ctx(data),
      data,
      settings({ writerIds: [] }),
      'AI_CONFIG_NOT_ALLOWED',
    ],
  ])('%s → %s', (_n, c, d, s, code) => {
    expect(checkConfigWrite(c, d, s, { stepUp: true })).toEqual({
      ok: false,
      code,
    });
  });

  it('mode off ham ahamiyatsiz: imzo baribir tekshiriladi', () => {
    process.env.RMQ_REQUESTER_SIG_MODE = 'off';
    try {
      expect(
        checkConfigWrite(ctx(data, { header: null }), data, settings(), {
          stepUp: false,
        }),
      ).toEqual({ ok: false, code: 'AI_CONFIG_UNSIGNED' });
    } finally {
      delete process.env.RMQ_REQUESTER_SIG_MODE;
    }
  });

  it('prod: bo‘sh ro‘yxat = har superadmin', () => {
    expect(
      checkConfigWrite(
        ctx(data),
        data,
        settings({ appEnv: 'production', writerIds: [] }),
        {
          stepUp: false,
        },
      ).ok,
    ).toBe(true);
  });

  it('step-up: talab qilinsa va step_up yo‘q → AI_STEP_UP_REQUIRED; verify uchun emas', () => {
    const s = settings({ stepUpRequired: true });
    expect(checkConfigWrite(ctx(data), data, s, { stepUp: true })).toEqual({
      ok: false,
      code: 'AI_STEP_UP_REQUIRED',
    });
    expect(checkConfigWrite(ctx(data), data, s, { stepUp: false }).ok).toBe(
      true,
    );
    const withStep = { ...data, step_up: true };
    expect(
      checkConfigWrite(ctx(withStep), withStep, s, { stepUp: true }).ok,
    ).toBe(true);
  });

  it('kontekst throw qilsa ham throw yo‘q', () => {
    const bad = {
      getPattern: () => {
        throw new Error('x');
      },
    };
    expect(checkConfigWrite(bad, data, settings(), { stepUp: false })).toEqual({
      ok: false,
      code: 'AI_CONFIG_UNSIGNED',
    });
  });
});

describe('configPermissions', () => {
  it.each([
    [settings({ uiEnabled: false }), '7', 'feature_off', 'feature_off'],
    [settings({ sigSecret: undefined }), '7', 'rmq_unsigned', 'rmq_unsigned'],
    [settings({ masterKeyConfigured: false }), '7', 'master_key_missing', null],
    [
      settings({ writerIds: [] }),
      '7',
      'writer_list_empty',
      'writer_list_empty',
    ],
    [settings(), '9', 'not_allowed_writer', 'not_allowed_writer'],
    [settings(), '7', null, null],
  ])('%#', (s, id, keyReason, modelsReason) => {
    const p = configPermissions(s, id, false);
    expect(p.key_locked_reason).toBe(keyReason);
    expect(p.models_locked_reason).toBe(modelsReason);
    expect(p.key).toBe(keyReason === null);
  });

  it('parseWriterIds', () => {
    expect(parseWriterIds(' 1, 2 ,,3')).toEqual(['1', '2', '3']);
    expect(parseWriterIds(undefined)).toEqual([]);
  });
});
