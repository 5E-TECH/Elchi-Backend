import { registerLiveness } from './liveness';

describe('registerLiveness', () => {
  it('registers GET /health that responds 200 with the service name', () => {
    const routes: Record<string, (req: unknown, res: unknown) => void> = {};
    const httpAdapter = {
      get: jest.fn((path: string, handler: (req: unknown, res: unknown) => void) => {
        routes[path] = handler;
      }),
    };
    const app = { getHttpAdapter: () => httpAdapter } as any;

    registerLiveness(app, 'order-service');

    expect(httpAdapter.get).toHaveBeenCalledWith('/health', expect.any(Function));

    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    routes['/health']({}, { status });

    expect(status).toHaveBeenCalledWith(200);
    expect(json.mock.calls[0][0]).toMatchObject({
      status: 'ok',
      service: 'order-service',
    });
  });
});
