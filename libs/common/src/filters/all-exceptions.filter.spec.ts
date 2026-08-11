import { BadRequestException, HttpStatus } from '@nestjs/common';
import { TimeoutError } from 'rxjs';
import { AllExceptionsFilter } from './all-exceptions.filter';

jest.mock('../sentry/sentry.helper', () => ({
  captureException: jest.fn(),
}));

function makeHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const host: any = {
    switchToHttp: () => ({
      getResponse: () => response,
    }),
  };
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps an rxjs downstream TimeoutError to 504 Gateway Timeout', () => {
    const { host, status, json } = makeHost();

    filter.catch(new TimeoutError(), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.GATEWAY_TIMEOUT);
    const body = json.mock.calls[0][0];
    expect(body.statusCode).toBe(504);
    expect(body.message).toMatch(/timeout/i);
  });

  it('preserves an HttpException status (does not mislabel as 504)', () => {
    const { host, status, json } = makeHost();

    filter.catch(new BadRequestException('bad input'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json.mock.calls[0][0].message).toBe('bad input');
  });

  it('falls back to 500 for an unknown error', () => {
    const { host, status, json } = makeHost();

    filter.catch(new Error('kaboom'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json.mock.calls[0][0].statusCode).toBe(500);
  });
});
