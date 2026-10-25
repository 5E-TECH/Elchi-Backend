import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ClientErrorGatewayController,
  ClientErrorReportDto,
} from './client-error-gateway.controller';
import { IS_PUBLIC_KEY } from './auth/public.decorator';

/**
 * QKCeGZ3N (4-band) — frontend xato chegarasi hisoboti: faqat kirgan foydalanuvchi, tuzilgan `client_error` jurnal
 * qatori, bazaga yozilmaydi; noto'g'ri yoki ortiqcha maydon — 400 (ValidationPipe whitelist + forbidNonWhitelisted).
 */
describe('ClientErrorGatewayController (QKCeGZ3N)', () => {
  const valid = {
    code: 'ERR-7F3A',
    message: 'r.forEach is not a function',
    path: '/orders?status=waiting',
    stack:
      'TypeError: r.forEach is not a function\n    at Hx (index-Bq3x.js:1:2345)',
    component_stack: '\n    at Orders',
    release: '2026-10-25',
    scope: 'page',
  };

  afterEach(() => jest.restoreAllMocks());

  it('⭐ logs one structured client_error line with the user and the report', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const controller = new ClientErrorGatewayController();

    const result = controller.report(
      {
        user: { sub: 42, roles: ['manager'] },
        headers: { 'user-agent': 'Mozilla/5.0 (Android)' },
      },
      valid as ClientErrorReportDto,
    );

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
      type: 'client_error',
      code: 'ERR-7F3A',
      message: 'r.forEach is not a function',
      path: '/orders?status=waiting',
      scope: 'page',
      release: '2026-10-25',
      user_id: '42',
      roles: ['manager'],
      user_agent: 'Mozilla/5.0 (Android)',
      stack: valid.stack,
      component_stack: valid.component_stack,
    });
  });

  it('route requires authentication (not @Public) and has its own 10/min throttle', () => {
    const handler = Object.getOwnPropertyDescriptor(
      ClientErrorGatewayController.prototype,
      'report',
    )?.value;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, ClientErrorGatewayController),
    ).toBeUndefined();
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(10);
  });

  it('valid report passes validation', async () => {
    expect(
      await validate(plainToInstance(ClientErrorReportDto, valid)),
    ).toEqual([]);
  });

  it.each([
    ['bad code', { ...valid, code: 'DROP TABLE' }],
    ['message too long', { ...valid, message: 'x'.repeat(501) }],
    ['path too long', { ...valid, path: '/'.repeat(301) }],
    ['stack too long', { ...valid, stack: 's'.repeat(4001) }],
    ['unknown scope', { ...valid, scope: 'everything' }],
    ['missing path', { code: valid.code, message: valid.message }],
  ])('%s → rejected', async (_name, body) => {
    expect(
      (await validate(plainToInstance(ClientErrorReportDto, body))).length,
    ).toBeGreaterThan(0);
  });
});
