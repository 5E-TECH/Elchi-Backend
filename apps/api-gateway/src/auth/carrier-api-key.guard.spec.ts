import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { CARRIER_ERROR_CODES } from '@app/common';
import { CarrierApiKeyGuard } from './carrier-api-key.guard';

function makeContext(headers: Record<string, unknown>, ip?: string) {
  const request: {
    headers: Record<string, unknown>;
    carrier?: unknown;
    ip?: string;
  } = { headers, ip };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

const makeGuard = (send: jest.Mock) =>
  new CarrierApiKeyGuard({ send } as unknown as ClientProxy);

const valid = {
  id: '3',
  name: 'BTS',
  is_active: true,
  ip_allowlist: null,
  courier_user_id: '55',
  courier_active: true,
};

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return {
      type: (e as Error).constructor.name,
      body: (e as { getResponse?: () => unknown }).getResponse?.(),
    };
  }
};

describe('CarrierApiKeyGuard', () => {
  it('to‘g‘ri kalit -> o‘tadi, request.carrier da courier_user_id bor', async () => {
    const send = jest.fn(() => of(valid));
    const { context, request } = makeContext({ 'x-api-key': ' elc_abc ' });

    await expect(makeGuard(send).canActivate(context)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(
      { cmd: 'integration.carrier.validate_key' },
      { api_key: 'elc_abc' },
    );
    expect(request.carrier).toEqual({
      id: '3',
      name: 'BTS',
      courier_user_id: '55',
    });
  });

  it('partner buyrug‘ini CHAQIRMAYDI (kalitlar aralashmaydi)', async () => {
    const send = jest.fn(() => of(valid));
    const { context } = makeContext({ 'x-api-key': 'elp_partner' });
    await makeGuard(send).canActivate(context);
    expect(send).not.toHaveBeenCalledWith(
      { cmd: 'integration.partner.validate_key' },
      expect.anything(),
    );
  });

  it('kalit yo‘q -> 401, RMQ ga bormaydi', async () => {
    const send = jest.fn();
    const { context } = makeContext({ authorization: 'Bearer x' });
    await expect(makeGuard(send).canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('yaroqsiz kalit (null) -> 401', async () => {
    const { context, request } = makeContext({ 'x-api-key': 'bad' });
    await expect(
      makeGuard(jest.fn(() => of(null))).canActivate(context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.carrier).toBeUndefined();
  });

  it('⭐ RMQ xatosi / identity uzilishi -> 503 + code (401 EMAS, yopiq qoladi)', async () => {
    for (const failure of [
      new Error('down'),
      { statusCode: 503, message: 'identity javob bermadi' },
    ]) {
      const { context, request } = makeContext({ 'x-api-key': 'k' });
      const res = await codeOf(
        makeGuard(jest.fn(() => throwError(() => failure))).canActivate(
          context,
        ),
      );
      expect(res?.type).toBe(ServiceUnavailableException.name);
      expect(res?.body).toMatchObject({
        statusCode: 503,
        code: CARRIER_ERROR_CODES.KEY_CHECK_UNAVAILABLE,
      });
      expect(request.carrier).toBeUndefined();
    }
  });

  it('faol emas akkaunt -> 403', async () => {
    const { context } = makeContext({ 'x-api-key': 'k' });
    await expect(
      makeGuard(jest.fn(() => of({ ...valid, is_active: false }))).canActivate(
        context,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('⭐ bog‘langan kurier bloklangan/o‘chirilgan -> 403 CARRIER_COURIER_INACTIVE', async () => {
    for (const courierActive of [false, undefined]) {
      const { context, request } = makeContext({ 'x-api-key': 'k' });
      const res = await codeOf(
        makeGuard(
          jest.fn(() => of({ ...valid, courier_active: courierActive })),
        ).canActivate(context),
      );
      expect(res?.type).toBe(ForbiddenException.name);
      expect(res?.body).toMatchObject({
        code: CARRIER_ERROR_CODES.COURIER_INACTIVE,
      });
      expect(request.carrier).toBeUndefined();
    }
  });

  it('IP tekshiruvi kurier holatidan OLDIN — ruxsatsiz IP kurier holatini bilmaydi', async () => {
    const { context } = makeContext({
      'x-api-key': 'k',
      'cf-connecting-ip': '8.8.8.8',
    });
    const res = await codeOf(
      makeGuard(
        jest.fn(() =>
          of({ ...valid, courier_active: false, ip_allowlist: ['10.0.0.5'] }),
        ),
      ).canActivate(context),
    );
    expect(res?.type).toBe(ForbiddenException.name);
    expect(JSON.stringify(res?.body)).toContain('IP ruxsat etilmagan');
    expect(JSON.stringify(res?.body)).not.toContain(
      CARRIER_ERROR_CODES.COURIER_INACTIVE,
    );
  });

  it('kurier bog‘lanmagan javob -> 403', async () => {
    const { context } = makeContext({ 'x-api-key': 'k' });
    await expect(
      makeGuard(
        jest.fn(() => of({ ...valid, courier_user_id: null })),
      ).canActivate(context),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('IP allowlist: CF-Connecting-IP ro‘yxatda -> o‘tadi, yo‘q -> 403', async () => {
    const send = jest.fn(() => of({ ...valid, ip_allowlist: ['10.0.0.5'] }));

    const ok = makeContext({
      'x-api-key': 'k',
      'cf-connecting-ip': '10.0.0.5',
    });
    await expect(makeGuard(send).canActivate(ok.context)).resolves.toBe(true);

    // X-Forwarded-For orqali `req.ip` ni soxtalashtirish yordam bermaydi.
    const spoofed = makeContext(
      { 'x-api-key': 'k', 'cf-connecting-ip': '8.8.8.8' },
      '10.0.0.5',
    );
    await expect(
      makeGuard(send).canActivate(spoofed.context),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
