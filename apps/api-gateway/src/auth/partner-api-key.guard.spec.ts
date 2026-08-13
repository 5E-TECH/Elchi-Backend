import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { PartnerApiKeyGuard } from './partner-api-key.guard';

function makeContext(headers: Record<string, unknown>) {
  const request: { headers: Record<string, unknown>; partner?: unknown } = {
    headers,
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('PartnerApiKeyGuard', () => {
  const makeGuard = (sendImpl: jest.Mock) => {
    const client = { send: sendImpl } as unknown as ClientProxy;
    return new PartnerApiKeyGuard(client);
  };

  it('TC1: to‘g‘ri key (faol) -> o‘tadi va request.partner to‘ldiriladi', async () => {
    const send = jest.fn(() =>
      of({ id: '7', name: 'Acme Market', is_active: true }),
    );
    const guard = makeGuard(send);
    const { context, request } = makeContext({ 'x-api-key': 'valid-key-123' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(
      { cmd: 'integration.partner.validate_key' },
      { api_key: 'valid-key-123' },
    );
    // req.partner faqat {id,name} — is_active guardда qoladi
    expect(request.partner).toEqual({ id: '7', name: 'Acme Market' });
  });

  it('TC3 (C1.3): kalit to‘g‘ri lekin hamkor faol emas -> 403', async () => {
    const send = jest.fn(() => of({ id: '7', name: 'Off', is_active: false }));
    const guard = makeGuard(send);
    const { context, request } = makeContext({
      'x-api-key': 'valid-but-inactive',
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(request.partner).toBeUndefined();
  });

  it('TC2: noto‘g‘ri key (null qaytadi) -> 401', async () => {
    const send = jest.fn(() => of(null));
    const guard = makeGuard(send);
    const { context, request } = makeContext({ 'x-api-key': 'wrong-key' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.partner).toBeUndefined();
  });

  it('TC4: JWT emas — Authorization emas, X-Api-Key ishlatiladi; key yo‘q -> 401', async () => {
    const send = jest.fn(() => of({ id: '7', name: 'Acme' }));
    const guard = makeGuard(send);
    // Faqat Bearer token bor, X-Api-Key yo‘q — guard JWT'ga qaramaydi.
    const { context } = makeContext({ authorization: 'Bearer jwt.token.here' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // Kalit yo‘qligi sababli integration-service'ga umuman murojaat qilinmaydi.
    expect(send).not.toHaveBeenCalled();
  });

  it('integration-service xatosi/timeout -> 401 (kirishga ruxsat yo‘q)', async () => {
    const send = jest.fn(() => throwError(() => new Error('rmq down')));
    const guard = makeGuard(send);
    const { context } = makeContext({ 'x-api-key': 'any' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
