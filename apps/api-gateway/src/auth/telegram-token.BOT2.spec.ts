import 'reflect-metadata';
import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import { JwtStrategy } from './jwt.strategy';
import {
  TELEGRAM_TOKEN_ACTIVE_GRACE_MS,
  TELEGRAM_TOKEN_STATE_TTL_MS,
  TelegramTokenStateService,
} from './telegram-token-state.service';
import { TelegramScanScopeGuard } from './telegram-scan-scope.guard';
import { OrderGatewayController } from '../order-gateway.controller';
import { TelegramGatewayController } from '../telegram-gateway.controller';

/**
 * BOT-2 #2 (gateway) — `tg_scan` scope'li Mini App tokeni faqat skan
 * oqimida; har Telegram tokeni (Mini App va bot) uchun faollik / rol /
 * Telegram ulanishi ≤60 s keshda tekshiriladi.
 */
describe('BOT-2 #2b — TelegramScanScopeGuard', () => {
  const guard = new TelegramScanScopeGuard(new Reflector());
  const ctx = (
    controller: abstract new (...args: never[]) => unknown,
    handler: string,
    user: Record<string, unknown>,
  ) =>
    ({
      getType: () => 'http',
      getHandler: () =>
        (controller.prototype as Record<string, unknown>)[handler],
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;
  const scan = { sub: '25', roles: ['courier'], scope: 'tg_scan' };

  it('⭐ skan va «Tayyor» — o`tadi', () => {
    expect(
      guard.canActivate(ctx(OrderGatewayController, 'scanAssignOrder', scan)),
    ).toBe(true);
    expect(
      guard.canActivate(ctx(TelegramGatewayController, 'scanDone', scan)),
    ).toBe(true);
  });

  it('⭐ GET /orders va boshqa route — 403', () => {
    for (const handler of ['findAll', 'findById']) {
      if (
        typeof (OrderGatewayController.prototype as any)[handler] !== 'function'
      ) {
        continue;
      }
      expect(() =>
        guard.canActivate(ctx(OrderGatewayController, handler, scan)),
      ).toThrow(ForbiddenException);
    }
    expect(() =>
      guard.canActivate(ctx(TelegramGatewayController, 'unlinkMe', scan)),
    ).toThrow(ForbiddenException);
  });

  it('scope`siz token (kabinet / bot aktori) — tegilmaydi', () => {
    expect(
      guard.canActivate(
        ctx(OrderGatewayController, 'findAll', { sub: '1', roles: ['admin'] }),
      ),
    ).toBe(true);
  });
});

describe('BOT-2 #2c — Telegram token holati (JwtStrategy)', () => {
  const config = { get: () => 'secret' } as never;
  const payload = {
    sub: '25',
    username: 'u',
    roles: ['courier'],
    auth: 'telegram',
    tg_id: '5550007',
  };

  function build(reply: () => unknown) {
    const identity = { send: jest.fn(() => reply()) };
    const tokens = new TelegramTokenStateService(identity as never);
    let now = 1_000_000;
    tokens.now = () => now;
    const strategy = new JwtStrategy(config, undefined, tokens);
    return {
      identity,
      strategy,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('faol → o`tadi; identity`ga to`g`ri payload', async () => {
    const h = build(() => of({ active: true }));
    await expect(h.strategy.validate(payload)).resolves.toEqual(
      expect.objectContaining({ sub: '25' }),
    );
    expect(h.identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.auth.telegram_token_state' },
      { user_id: '25', telegram_id: '5550007', role: 'courier' },
    );
  });

  it('⭐ nofaol qilingan / uzilgan → 60 s ichida 401', async () => {
    let active = true;
    const h = build(() => of({ active }));
    await h.strategy.validate(payload);
    active = false;
    // kesh ichida — hali o'tadi, so'ralmaydi
    await h.strategy.validate(payload);
    expect(h.identity.send).toHaveBeenCalledTimes(1);
    h.advance(TELEGRAM_TOKEN_STATE_TTL_MS + 1);
    await expect(h.strategy.validate(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('identity javob bermadi (hech tasdiqlanmagan) → 503 fail closed', async () => {
    const h = build(() => throwError(() => new Error('down')));
    await expect(h.strategy.validate(payload)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('⭐ deploy`dan oldingi Telegram tokeni (tg_id yo`q) — 401, identity so`ralmaydi', async () => {
    const h = build(() => of({ active: true }));
    const old: Record<string, unknown> = { ...payload };
    delete old.tg_id;
    await expect(h.strategy.validate(old)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(h.identity.send).not.toHaveBeenCalled();
  });

  it('⭐ grace TTL dan oshmaydi: identity o`chiq, faol tasdiq 60 s dan eski → 503', async () => {
    let up = true;
    const h = build(() =>
      up ? of({ active: true }) : throwError(() => new Error('down')),
    );
    await h.strategy.validate(payload);
    up = false;
    h.advance(TELEGRAM_TOKEN_STATE_TTL_MS + 1);
    // Kesh eskirdi, oxirgi «faol» tasdiq grace'dan (60 s) eski → 503.
    expect(TELEGRAM_TOKEN_ACTIVE_GRACE_MS).toBe(TELEGRAM_TOKEN_STATE_TTL_MS);
    await expect(h.strategy.validate(payload)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('kabinet tokeni (auth`siz) — Telegram tekshiruvi yo`q', async () => {
    const h = build(() => of({ active: false }));
    await expect(
      h.strategy.validate({ sub: '1', username: 'a', roles: ['admin'] }),
    ).resolves.toBeDefined();
    expect(h.identity.send).not.toHaveBeenCalled();
  });
});
