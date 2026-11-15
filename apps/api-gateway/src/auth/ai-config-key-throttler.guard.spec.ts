import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { AiConfigKeyThrottlerGuard } from './ai-config-key-throttler.guard';

/** be-brief §8: /ai/config/key* — 10/daqiqa/foydalanuvchi, 30/daqiqa/IP, umumiy hisob. */
class FakeCtl {
  setKey(): void {}
  verifyKey(): void {}
}

describe('AiConfigKeyThrottlerGuard', () => {
  let storage: ThrottlerStorageService;
  beforeEach(() => {
    storage = new ThrottlerStorageService();
  });
  afterEach(() => storage.onApplicationShutdown());

  const make = async () => {
    const g = new AiConfigKeyThrottlerGuard(
      { throttlers: [{ name: 'default', ttl: 60_000, limit: 60 }] },
      storage,
      new Reflector(),
    );
    await g.onModuleInit();
    return g;
  };
  const ctx = (req: object, handler: 'setKey' | 'verifyKey' = 'setKey') =>
    ({
      getClass: () => FakeCtl,
      getHandler: () =>
        Object.getOwnPropertyDescriptor(FakeCtl.prototype, handler)
          ?.value as () => void,
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({ header: jest.fn() }),
      }),
    }) as unknown as ExecutionContext;

  it('foydalanuvchi: 10 o‘tadi, 11-si 429 — route’lar umumiy hisob', async () => {
    const g = await make();
    const req = {
      user: { sub: '7' },
      headers: { 'cf-connecting-ip': '203.0.113.1' },
    };
    for (let i = 0; i < 5; i++)
      await expect(g.canActivate(ctx(req))).resolves.toBe(true);
    for (let i = 0; i < 5; i++)
      await expect(g.canActivate(ctx(req, 'verifyKey'))).resolves.toBe(true);
    await expect(g.canActivate(ctx(req))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('IP: 30 o‘tadi (turli foydalanuvchilar), 31-si 429', async () => {
    const g = await make();
    for (let i = 0; i < 30; i++) {
      const req = {
        user: { sub: `u${i}` },
        headers: { 'cf-connecting-ip': '198.51.100.9' },
      };
      await expect(g.canActivate(ctx(req))).resolves.toBe(true);
    }
    const req = {
      user: { sub: 'u99' },
      headers: { 'cf-connecting-ip': '198.51.100.9' },
    };
    await expect(g.canActivate(ctx(req))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });
});
