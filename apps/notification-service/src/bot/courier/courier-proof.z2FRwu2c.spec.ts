import { Logger } from '@nestjs/common';
import { MEDIA_SEND_AS_PHOTO_TEXT } from '../bot-media';
import {
  callbackUpdate,
  courierActor,
  fakeOrdersGateway,
  gatewayOrder,
  lastButtons,
  makeRouter,
  openIshim,
  sentTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import {
  PROOF_FORMAT_TEXT,
  PROOF_PROMPT_TEXT,
  PROOF_TOO_LARGE_TEXT,
} from './courier.handler';

/**
 * z2FRwu2c — isbot (rasm/video) oqimi, Telegram 20MB chegarasi bilan.
 * Isbot fayli `POST /files/upload` (folder=proof, kuryer JWT) → kalit →
 * `proofFileKeys`; `proofFileKeysVerified` ni bot O'RNATMAYDI (soxta kalit
 * order-service'da rad — soxta gateway shuni taqlid qiladi).
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const proofOrder = () =>
  gatewayOrder('101', 'waiting', {
    market: { id: '3', expense_proof_conditions: ['cancel_any', 'sell_any'] },
  });

const setup = (orders = [proofOrder()]) => {
  const gateway = fakeOrdersGateway(orders);
  const ctx = makeRouter({ actor: courierActor(), gateway: gateway.request });
  return { ctx, gateway };
};

const press = (ctx: ReturnType<typeof makeRouter>, data: string) =>
  ctx.router.dispatch(
    'elchi',
    callbackUpdate(data, { chatId: 25, fromId: 25 }),
  );

let updateId = 1000;
const media = (
  ctx: ReturnType<typeof makeRouter>,
  message: Record<string, unknown>,
) =>
  ctx.router.dispatch('elchi', {
    update_id: (updateId += 1),
    message: {
      message_id: updateId,
      chat: { id: 25, type: 'private' },
      from: { id: 25 },
      ...message,
    },
  });

const startSell = async (ctx: ReturnType<typeof makeRouter>) => {
  await openIshim(ctx);
  await press(ctx, lastButtons(ctx)['✅ Sotildi']);
  await press(ctx, lastButtons(ctx)['✅ Ha']);
};

describe('z2FRwu2c — isbot oqimi', () => {
  it('⭐ sell_any market: ✅ Sotildi → avval isbot so‘raladi, isbotsiz sell CHAQIRILMAYDI', async () => {
    const { ctx, gateway } = setup();
    await startSell(ctx);
    expect(sentTexts(ctx).at(-1)).toBe(PROOF_PROMPT_TEXT);
    expect(gateway.calls.some((call) => call.path === '/orders/sell/101')).toBe(
      false,
    );
    expect(ctx.sessions.states.get('25')?.proof).toEqual(
      expect.objectContaining({ op: 'sell', order_id: '101', keys: [] }),
    );
  });

  it('⭐ rasm → file-service’ga yuklanadi, Tugatdim → proofFileKeys bilan sell o‘tadi', async () => {
    const { ctx, gateway } = setup();
    await startSell(ctx);
    const done = lastButtons(ctx)['✅ Tugatdim'];
    await media(ctx, {
      photo: [
        { file_id: 'small', file_size: 10_000 },
        { file_id: 'big', file_size: 900_000 },
      ],
    });
    expect(ctx.transport.downloadFile).toHaveBeenCalledWith('big');
    const upload = gateway.calls.find((call) => call.path === '/files/upload')!;
    expect(upload.body).toBeInstanceOf(FormData);
    expect((upload.body as FormData).get('folder')).toBe('proof');
    expect(sentTexts(ctx).at(-1)).toContain('Qabul qilindi (1/3)');
    await press(ctx, done);
    const sell = gateway.calls.find(
      (call) => call.path === '/orders/sell/101',
    )!;
    expect(sell.body).toEqual({ proofFileKeys: ['proof-1'] });
    // Bot "verified" bayrog'ini YUBORMAYDI — order-service tekshiradi.
    expect(sell.body).not.toHaveProperty('proofFileKeysVerified');
    expect(gateway.orders.get('101')!.status).toBe('sold');
    expect(ctx.sessions.states.get('25')?.proof).toBeUndefined();
  });

  it('⭐ isbot talab qilmaydigan market — isbot so‘ralmaydi', async () => {
    const { ctx, gateway } = setup([gatewayOrder('101', 'waiting')]);
    await startSell(ctx);
    expect(sentTexts(ctx)).not.toContain(PROOF_PROMPT_TEXT);
    expect(gateway.calls.some((call) => call.path === '/orders/sell/101')).toBe(
      true,
    );
  });

  it('⭐ 25MB video — aniq xato + kabinet havolasi, amal OCHIQ qoladi', async () => {
    const { ctx, gateway } = setup();
    await startSell(ctx);
    await media(ctx, {
      video: {
        file_id: 'v',
        file_size: 25 * 1024 * 1024,
        mime_type: 'video/mp4',
      },
    });
    expect(sentTexts(ctx).at(-1)).toBe(PROOF_TOO_LARGE_TEXT);
    expect(lastButtons(ctx)['🌐 Kabinetda ochish']).toContain('search=101');
    expect(ctx.transport.downloadFile).not.toHaveBeenCalled();
    expect(gateway.orders.get('101')!.status).toBe('waiting');
    expect(ctx.sessions.states.get('25')?.proof).toBeDefined();
  });

  it('⭐ HEIC hujjat — "surat sifatida yuboring"; noma’lum format — aniq javob', async () => {
    const { ctx } = setup();
    await startSell(ctx);
    await media(ctx, {
      document: { file_id: 'h', mime_type: 'image/heic', file_size: 2_000_000 },
    });
    expect(sentTexts(ctx).at(-1)).toBe(MEDIA_SEND_AS_PHOTO_TEXT);
    await media(ctx, {
      document: {
        file_id: 'p',
        mime_type: 'application/pdf',
        file_size: 2_000,
      },
    });
    expect(sentTexts(ctx).at(-1)).toBe(PROOF_FORMAT_TEXT);
  });

  it('⭐ soxta / mavjud bo‘lmagan kalit — order-service rad etadi, isbot qayta so‘raladi', async () => {
    const { ctx, gateway } = setup();
    const original = gateway.request.getMockImplementation()!;
    gateway.request.mockImplementation(
      (...args: Parameters<typeof original>) =>
        args[2] === '/files/upload'
          ? Promise.resolve({
              status: 201,
              body: { data: { key: 'fake-key' } },
            })
          : original(...args),
    );
    await startSell(ctx);
    const done = lastButtons(ctx)['✅ Tugatdim'];
    await media(ctx, { photo: [{ file_id: 'p', file_size: 1000 }] });
    await press(ctx, done);
    const sell = gateway.calls.find(
      (call) => call.path === '/orders/sell/101',
    )!;
    expect(sell.body).toEqual({ proofFileKeys: ['fake-key'] });
    expect(sentTexts(ctx).join('\n')).toContain('Isbot fayli tasdiqlanmadi');
    expect(sentTexts(ctx).at(-1)).toBe(PROOF_PROMPT_TEXT);
    expect(gateway.orders.get('101')!.status).toBe('waiting');
  });

  it('⭐ 3 ta fayl + Tugatdim — uchalasi bitta amalga; 4-chisi qabul qilinmaydi', async () => {
    const { ctx, gateway } = setup();
    await startSell(ctx);
    const done = lastButtons(ctx)['✅ Tugatdim'];
    await media(ctx, { photo: [{ file_id: 'a', file_size: 1000 }] });
    await media(ctx, {
      video: {
        file_id: 'b',
        file_size: 3_000_000,
        mime_type: 'video/quicktime',
      },
    });
    await media(ctx, {
      document: { file_id: 'c', file_size: 50_000, mime_type: 'image/png' },
    });
    await media(ctx, { photo: [{ file_id: 'd', file_size: 1000 }] });
    expect(sentTexts(ctx).at(-1)).toContain("Ko'pi bilan 3 ta");
    await press(ctx, done);
    const sell = gateway.calls.find(
      (call) => call.path === '/orders/sell/101',
    )!;
    expect(sell.body).toEqual({
      proofFileKeys: ['proof-1', 'proof-2', 'proof-3'],
    });
  });

  it('Tugatdim fayl yo‘q holda — qayta so‘raladi; ✖️ Bekor — amal bajarilmaydi', async () => {
    const { ctx, gateway } = setup();
    await startSell(ctx);
    await press(ctx, lastButtons(ctx)['✅ Tugatdim']);
    expect(sentTexts(ctx).at(-1)).toContain("Hech bo'lmasa bitta");
    await press(ctx, lastButtons(ctx)['✖️ Bekor']);
    expect(sentTexts(ctx).at(-1)).toContain('amal bajarilmadi');
    expect(gateway.calls.some((call) => call.path === '/orders/sell/101')).toBe(
      false,
    );
    expect(ctx.sessions.states.get('25')?.proof).toBeUndefined();
  });

  it('isbot rejimidan tashqari media — umumiy qoidalar (jim emas)', async () => {
    const { ctx } = setup();
    await media(ctx, { video: { file_id: 'v', file_size: 25 * 1024 * 1024 } });
    expect(sentTexts(ctx).at(-1)).toContain('20MB');
  });
});
