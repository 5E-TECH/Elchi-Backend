import { Logger } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { ExtraCostApprovalDecisionDto } from '../../../../api-gateway/src/dto/order.swagger.dto';
import { TelegramDmService } from '../../telegram/telegram-dm.service';
import {
  callbackUpdate,
  lastButtons,
  makeRouter,
  marketActor,
  sentTexts,
} from '../testing/bot-kit-spec';
import { EC_ALREADY_DONE_TEXT, EC_ONLY_OWNER_TEXT } from './extra-cost.actions';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: (...args: unknown[]) => rmqSendMock(...args) };
});

/**
 * DuST9k8j / 1tnpaIqd — market egasining DM'idagi qo'shimcha xarajat tugmalari:
 * qaror MAVJUD endpointga market JWT'si bilan; qarordan keyin tugmalar
 * olib tashlanadi; rad etish sababi yopiq ro'yxat; isbot — albom + alohida
 * tugmalar xabari.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  rmqSendMock.mockReset();
});
afterEach(() => jest.restoreAllMocks());

/** DM deliver yaratgan tugmalar taqlidi: market egasiga biriktirilgan amallar. */
async function setup(response: (path: string, body: unknown) => { status: number; body: unknown }) {
  const gateway = jest.fn((_tg: string, _m: string, path: string, body?: unknown) =>
    Promise.resolve(response(path, body)),
  );
  const ctx = makeRouter({ actor: marketActor('501'), gateway });
  const approve = await ctx.actions.create({
    chatId: '501',
    action: 'ec.ok',
    actorUserId: '501',
    orderId: '7001',
    payload: { approval_id: '7' },
    oneShot: false,
  });
  const reject = await ctx.actions.create({
    chatId: '501',
    action: 'ec.no',
    actorUserId: '501',
    orderId: '7001',
    payload: { approval_id: '7' },
    oneShot: false,
  });
  await ctx.actions.attachMessage([approve, reject], 555);
  return { ctx, gateway, approve, reject };
}
const press = (ctx: ReturnType<typeof makeRouter>, data: string, fromId = 501) =>
  ctx.router.dispatch('elchi', callbackUpdate(data, { chatId: 501, fromId }));

describe('DuST9k8j — ✅ Tasdiqlash / ❌ Rad etish', () => {
  it('⭐ ✅ → POST approve (market JWT), keyin asl xabar tugmalari bo‘shatiladi', async () => {
    const { ctx, gateway, approve } = await setup(() => ({ status: 200, body: { statusCode: 200 } }));
    await press(ctx, approve);
    expect(gateway).toHaveBeenCalledWith(
      '501',
      'POST',
      '/orders/extra-cost-approvals/7/approve',
      {},
      expect.any(Object),
    );
    expect(ctx.transport.editMessage).toHaveBeenCalledWith('501', '555', {
      reply_markup: { inline_keyboard: [] },
    });
    expect(sentTexts(ctx).at(-1)).toContain('tasdiqlandi');
  });

  it('⭐ yakunlangan so‘rovga qayta bosish — "allaqachon yakunlangan", tugmalar olinadi', async () => {
    const { ctx, approve } = await setup(() => ({
      status: 400,
      body: { message: "Bu so'rov allaqachon yakunlangan" },
    }));
    await press(ctx, approve);
    expect(sentTexts(ctx).at(-1)).toBe(EC_ALREADY_DONE_TEXT);
    expect(ctx.transport.editMessage).toHaveBeenCalledTimes(1);
  });

  it('⭐ market operatori bossa — "faqat market egasi" (chat emas, odam tekshiriladi)', async () => {
    const { ctx, gateway, approve } = await setup(() => ({ status: 200, body: {} }));
    ctx.actors.resolve.mockResolvedValue({ ...marketActor('37'), user_id: '40', role: 'market_operator' });
    await press(ctx, approve, 40);
    expect(ctx.transport.answerCallbackQuery).toHaveBeenLastCalledWith('cb1', EC_ONLY_OWNER_TEXT);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('server 403 — botda tushunarli xabar', async () => {
    const { ctx, approve } = await setup(() => ({ status: 403, body: { message: 'forbidden' } }));
    await press(ctx, approve);
    expect(sentTexts(ctx).at(-1)).toBe(EC_ONLY_OWNER_TEXT);
  });

  it('⭐ ❌ → YOPIQ sabablar ro‘yxati → sabab → POST reject { reason }, tugmalar bo‘shatiladi', async () => {
    const { ctx, gateway, reject } = await setup(() => ({ status: 200, body: {} }));
    await press(ctx, reject);
    expect(Object.keys(lastButtons(ctx))).toEqual([
      'Summa juda katta',
      'Xarajat kelishilmagan',
      'Isbot yetarli emas',
      "Takroriy so'rov",
      '⬅️ Orqaga',
    ]);
    await press(ctx, lastButtons(ctx)['Isbot yetarli emas']);
    expect(gateway).toHaveBeenCalledWith(
      '501',
      'POST',
      '/orders/extra-cost-approvals/7/reject',
      { reason: 'NO_PROOF' },
      expect.any(Object),
    );
    expect(ctx.transport.editMessage).toHaveBeenCalledWith('501', '555', {
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('⭐ gateway: yopiq ro‘yxatdan tashqari sabab → 400 (ValidationPipe)', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    await expect(
      pipe.transform({ reason: 'I_DONT_LIKE' }, { type: 'body', metatype: ExtraCostApprovalDecisionDto }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      pipe.transform({ reason: 'TOO_EXPENSIVE' }, { type: 'body', metatype: ExtraCostApprovalDecisionDto }),
    ).resolves.toEqual(expect.objectContaining({ reason: 'TOO_EXPENSIVE' }));
  });
});

describe('DuST9k8j — isbot fayllari DM’da', () => {
  const makeDm = (keys: string[]) => {
    const notifications = {
      query: jest.fn(),
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, jest.Mock> = {};
        for (const name of ['update', 'set', 'setParameter', 'whereInIds']) {
          qb[name] = jest.fn(() => qb);
        }
        qb.execute = jest.fn().mockResolvedValue({});
        return qb;
      }),
    };
    notifications.query.mockImplementation((sql: string) =>
      Promise.resolve(
        String(sql).includes('UPDATE')
          ? [
              {
                id: '1',
                recipient_id: '501',
                title: "Qo'shimcha xarajat",
                body: 'Summa',
                data: {
                  telegram_media: keys,
                  telegram_buttons: [[{ text: '✅ Tasdiqlash', action: 'ec.ok', payload: { approval_id: '7' } }]],
                },
              },
            ]
          : [],
      ),
    );
    const telegram = {
      sendDirectToGroup: jest.fn().mockResolvedValue({ result: { message_id: 900 } }),
    };
    const transport = { sendMedia: jest.fn().mockResolvedValue(keys.length === 1 ? 777 : null) };
    const actions = {
      create: jest.fn().mockResolvedValue('a:ec00000000000001'),
      attachMessage: jest.fn().mockResolvedValue(undefined),
    };
    rmqSendMock.mockResolvedValue({ data: { body_base64: Buffer.from('img').toString('base64'), mime_type: 'image/jpeg' } });
    const dm = new TelegramDmService(
      notifications as never,
      { enqueue: jest.fn() } as never,
      { contacts: jest.fn(() => new Map([['501', { telegram_id: '5550501' }]])) } as never,
      telegram as never,
      { get: (key: string) => ({ TELEGRAM_BOT_TOKEN: 'x:y' })[key] } as never,
      {} as never,
      {} as never,
      actions as never,
      transport as never,
      {} as never,
    );
    return { dm, telegram, transport, actions };
  };

  it('⭐ bitta fayl — rasm + izoh + tugmalar BITTA postda (alohida matn yo‘q)', async () => {
    const { dm, telegram, transport, actions } = makeDm(['proof-1']);
    await dm.deliver({ notification_ids: ['1'] });
    expect(transport.sendMedia).toHaveBeenCalledWith(
      '5550501',
      [expect.objectContaining({ mime: 'image/jpeg' })],
      expect.objectContaining({ caption: expect.stringContaining('xarajat'), reply_markup: expect.any(Object) }),
    );
    expect(telegram.sendDirectToGroup).not.toHaveBeenCalled();
    expect(actions.attachMessage).toHaveBeenCalledWith(['a:ec00000000000001'], 777);
  });

  it('⭐ bir nechta fayl — albom (tugmasiz) + ALOHIDA xabarda tugmalar', async () => {
    const { dm, telegram, transport, actions } = makeDm(['proof-1', 'proof-2', 'proof-3']);
    await dm.deliver({ notification_ids: ['1'] });
    const [, files, options] = transport.sendMedia.mock.calls[0] as [string, unknown[], Record<string, unknown>];
    expect(files).toHaveLength(3);
    expect(options).not.toHaveProperty('reply_markup');
    expect(telegram.sendDirectToGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Isbot fayllari yuqorida'),
        reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
      }),
    );
    expect(actions.attachMessage).toHaveBeenCalledWith(['a:ec00000000000001'], 900);
  });
});
