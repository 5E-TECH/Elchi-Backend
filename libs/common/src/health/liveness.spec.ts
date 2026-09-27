import { INestApplication, Logger } from '@nestjs/common';
import { registerLiveness } from './liveness';

type Handler = (req: unknown, res: unknown) => void;

/** Soxta httpAdapter: ro'yxatdan o'tgan route'larni ushlab, qo'lda chaqiradi. */
const makeApp = () => {
  const routes: Record<string, Handler> = {};
  const httpAdapter = {
    get: jest.fn((path: string, handler: Handler) => {
      routes[path] = handler;
    }),
  };
  const app = {
    getHttpAdapter: () => httpAdapter,
  } as unknown as INestApplication;

  const hit = (path = '/health') => {
    const json = jest.fn<void, [Record<string, unknown>]>();
    const status = jest.fn().mockReturnValue({ json });
    routes[path]({}, { status });
    return { status, body: json.mock.calls[0][0] };
  };

  return { app, httpAdapter, hit };
};

describe('registerLiveness', () => {
  afterEach(() => jest.restoreAllMocks());

  it('registers GET /health that responds 200 with the service name', () => {
    const { app, httpAdapter, hit } = makeApp();

    registerLiveness(app, 'order-service');

    expect(httpAdapter.get).toHaveBeenCalledWith(
      '/health',
      expect.any(Function),
    );

    const { status, body } = hit();
    expect(status).toHaveBeenCalledWith(200);
    expect(body).toMatchObject({
      status: 'ok',
      service: 'order-service',
    });
  });

  it("extra'siz javob faqat status/service/timestamp dan iborat (orqaga moslik)", () => {
    const { app, hit } = makeApp();

    registerLiveness(app, 'order-service');

    const { body } = hit();
    expect(Object.keys(body).sort()).toEqual([
      'service',
      'status',
      'timestamp',
    ]);
    expect(typeof body.timestamp).toBe('string');
  });

  it("extra() maydonlari /health JSON'iga qo'shiladi va har so'rovda qayta o'qiladi", () => {
    const { app, hit } = makeApp();
    let enabled = false;

    registerLiveness(app, 'ai-service', () => ({
      ai: enabled ? 'enabled' : 'disabled',
    }));

    const first = hit();
    expect(first.status).toHaveBeenCalledWith(200);
    expect(first.body).toMatchObject({
      status: 'ok',
      service: 'ai-service',
      ai: 'disabled',
    });

    enabled = true;
    expect(hit().body.ai).toBe('enabled');
  });

  it("throw qiladigan extra e'tiborsiz qoldiriladi: baribir 200, WARN faqat bir marta", () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { app, hit } = makeApp();

    registerLiveness(app, 'ai-service', () => {
      throw new Error('boom');
    });

    const first = hit();
    expect(first.status).toHaveBeenCalledWith(200);
    expect(first.body).toMatchObject({ status: 'ok', service: 'ai-service' });
    expect(first.body).not.toHaveProperty('ai');

    const second = hit();
    expect(second.status).toHaveBeenCalledWith(200);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("extra status/service/timestamp ni almashtira olmaydi; obyekt bo'lmagan qiymat e'tiborsiz", () => {
    const { app, hit } = makeApp();

    registerLiveness(app, 'ai-service', () => ({
      status: 'down',
      service: 'hijack',
      ai: 'enabled',
    }));
    expect(hit().body).toMatchObject({
      status: 'ok',
      service: 'ai-service',
      ai: 'enabled',
    });

    const other = makeApp();
    registerLiveness(
      other.app,
      'ai-service',
      () => null as unknown as Record<string, unknown>,
    );
    const { status, body } = other.hit();
    expect(status).toHaveBeenCalledWith(200);
    expect(Object.keys(body).sort()).toEqual([
      'service',
      'status',
      'timestamp',
    ]);
  });
});
