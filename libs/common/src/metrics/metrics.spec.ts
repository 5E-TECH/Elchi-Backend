import { registerMetrics } from './metrics';

describe('registerMetrics', () => {
  it('exposes /metrics with the service label and a timing middleware', async () => {
    const routes: Record<string, (req: unknown, res: unknown) => void> = {};
    const middlewares: Array<
      (req: unknown, res: unknown, next: () => void) => void
    > = [];
    const httpAdapter = {
      get: jest.fn((path: string, handler: (req: unknown, res: unknown) => void) => {
        routes[path] = handler;
      }),
    };
    const app = {
      getHttpAdapter: () => httpAdapter,
      use: jest.fn((m: (req: unknown, res: unknown, next: () => void) => void) =>
        middlewares.push(m),
      ),
    } as any;

    registerMetrics(app, 'api-gateway');

    expect(httpAdapter.get).toHaveBeenCalledWith('/metrics', expect.any(Function));
    expect(app.use).toHaveBeenCalled();

    // exercise the middleware for one request so a metric is recorded
    const finishCbs: Array<() => void> = [];
    const req = { method: 'GET', url: '/orders', route: { path: '/orders' } };
    const res = {
      statusCode: 200,
      on: jest.fn((_e: string, cb: () => void) => finishCbs.push(cb)),
    };
    const next = jest.fn();
    middlewares[0](req, res, next);
    expect(next).toHaveBeenCalled();
    finishCbs.forEach((cb) => cb()); // simulate response finish

    // the /metrics endpoint renders the registry (with the default service label)
    const body: string = await new Promise((resolve) => {
      const metricsRes = {
        setHeader: jest.fn(),
        end: (b: string) => resolve(b),
      };
      routes['/metrics']({}, metricsRes);
    });
    expect(body).toContain('service="api-gateway"');
    expect(body).toContain('http_request_duration_seconds');
  });
});
